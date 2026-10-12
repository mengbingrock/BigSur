"""Paper-style hybrid reconstruction: Nebius Qwen -> FAISS top 60 -> 60/40
semantic/BM25 -> task-specific top k. Score scaling/tokenization are explicit
assumptions; the public paper does not provide those implementation details.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shutil
import time

import faiss
import numpy as np
from rank_bm25 import BM25Okapi
from buildNebiusIndex import ensure_vectors, file_hash, source_rows, source_spec, write_json, writer_lock
from nebiusEmbeddings import EmbeddingCache, NebiusClient, digest, load_key, normalized, query_input

VARIANT = 'paper-hybrid-nebius'
RETRIEVAL = {'version': 1, 'denseCandidates': 60, 'semanticWeight': 0.6, 'lexicalWeight': 0.4,
             'denseIndex': 'IndexFlatL2', 'vectors': 'L2-normalized float32',
             'semanticScore': 'cosine = 1 - squaredL2 / 2',
             'scoreScaling': 'independent min-max over dense candidates; constant channel contributes zero',
             'lexicalModel': 'rank_bm25.BM25Okapi', 'k1': 1.5, 'b': 0.75, 'epsilon': 0.25,
             'lexicalStatistics': 'whole profile corpus, then score the 60 dense candidates',
             'tokenization': 'Python Unicode casefold, regex \\w+, no stemming/stopword removal',
             'ties': 'hybrid descending, squared L2 ascending, source row order ascending'}


def task_query(task, sample):
    if task == 'PQA':
        return sample['question']
    if task == 'ORD':
        return sample['question'] + ' ' + ' '.join(sample['wrong_steps'])
    if task == 'ERR':
        return (sample['corrected_text'] if sample['is_correct'] else sample['corrupted_text']) + ' ' + json.dumps(sample['context'], ensure_ascii=False, separators=(',', ':'))
    if task == 'GEN':
        return sample['instruction'] + ' ' + sample['input']
    raise ValueError('Unsupported task')


def tokens(text):
    return re.findall(r'\w+', text.casefold())


def scale(values):
    values = np.asarray(values, dtype=np.float64)
    span = np.ptp(values)
    return (values - values.min()) / span if span > 1e-12 else np.zeros_like(values)


def retrieve(index, bm25, rows, query, vector, k):
    distances, ids = index.search(normalized([vector]), min(60, index.ntotal))
    ids, distances = ids[0].tolist(), distances[0].astype(np.float64)
    semantic = 1 - distances / 2
    lexical = np.asarray(bm25.get_batch_scores(tokens(query), ids), dtype=np.float64)
    sem_scaled, lex_scaled = scale(semantic), scale(lexical)
    scores = 0.6 * sem_scaled + 0.4 * lex_scaled
    order = sorted(range(len(ids)), key=lambda i: (-scores[i], distances[i], ids[i]))[:k]
    return [{**rows[ids[i]], 'score': float(scores[i]), 'denseRank': i + 1,
             'squaredL2': float(distances[i]), 'semanticScore': float(semantic[i]),
             'bm25Score': float(lexical[i]), 'semanticScaled': float(sem_scaled[i]),
             'lexicalScaled': float(lex_scaled[i])} for i in order]


def frozen_jobs(base, source, original):
    jobs = json.loads((base / 'jobs.json').read_text())
    expected = {(task, s['id']) for task, entry in original['selection'].items() for s in entry['selected']}
    if len(jobs) != len(expected) or {(j['task'], j['sample']['id']) for j in jobs} != expected:
        raise ValueError('Frozen job selection changed or duplicated')
    for task in original['selection']:
        file = f'{task}_test.json'
        if file_hash(source / 'Data' / file) != original['checksums'][file]:
            raise ValueError('Frozen benchmark task checksum changed')
        all_rows = {r['id']: r for r in json.loads((source / 'Data' / file).read_text())}
        for j in jobs:
            if j['task'] == task and (j['sample'] != all_rows[j['sample']['id']] or j['variant'] != 'paper-context'):
                raise ValueError('Frozen benchmark sample changed')
    return jobs


def prepare(base, embeddings, source, out, client, per_task=None, exclude_reports=()):
    original, spec = source_spec(base)
    state = json.loads((embeddings / 'embedding-manifest.json').read_text())
    if state.get('status') != 'ready' or state['spec'] != spec:
        raise ValueError('Complete matching Nebius indexes are required before retrieval')
    if per_task is None:
        if exclude_reports:
            raise ValueError('--exclude-report requires --per-task')
        jobs = frozen_jobs(base, source, original)
        selection, sampling = original['selection'], None
    else:
        from freshSelection import fresh_jobs
        jobs, selection, sampling = fresh_jobs(source, original, per_task, exclude_reports)
    if out.exists() and any(out.iterdir()):
        raise ValueError('Use a new empty evaluation output directory')
    # Verify both artifacts before making any paid query-embedding requests.
    for profile in ('small', 'large'):
        info = state['profiles'][profile]
        if file_hash(embeddings / f'paper-{profile}.faiss') != info['indexSha256'] or file_hash(embeddings / f'paper-{profile}-mapping.json') != info['mappingSha256']:
            raise ValueError('FAISS index or row mapping checksum mismatch')
    queries = {j['sample']['id']: task_query(j['task'], j['sample']) for j in jobs}
    query_vectors = {}
    with writer_lock(embeddings):
        cache = EmbeddingCache(embeddings / 'embeddings.sqlite')
        try:
            before = cache.stats()
            ensure_vectors((query_input(q) for q in queries.values()), cache, client)
            for id_, q in queries.items():
                query_vectors[id_] = cache.get(query_input(q)).copy()
            after = cache.stats()
        finally:
            cache.close()
    prepared = []
    index_files = []
    for profile in ('small', 'large'):
        rows = source_rows(base, profile)
        mapping = json.loads((embeddings / f'paper-{profile}-mapping.json').read_text())
        if len(rows) != len(mapping) or any((r['rowid'], r['protocol_id'], r['startChar'], r['endChar'], digest(r['text'])) !=
                                           (m['rowid'], m['protocolId'], m['startChar'], m['endChar'], m['textSha256']) for r, m in zip(rows, mapping)):
            raise ValueError('Source rows no longer match indexed vectors')
        index_path = embeddings / f'paper-{profile}.faiss'
        index = faiss.read_index(str(index_path))
        if not isinstance(index, faiss.IndexFlatL2) or index.d != 4096 or index.ntotal != len(rows):
            raise ValueError('Unexpected FAISS index type, dimension or vector count')
        bm25 = BM25Okapi([tokens(r['text']) for r in rows], k1=1.5, b=0.75, epsilon=0.25)
        index_files.extend([str(index_path), str(base / f'paper-{profile}.sqlite')])
        for job in jobs:
            task, sample = job['task'], job['sample']
            expected_profile = 'small' if task in ('PQA', 'ERR') else 'large'
            if expected_profile != profile:
                continue
            started = time.perf_counter()
            passages = retrieve(index, bm25, rows, queries[sample['id']], query_vectors[sample['id']], 5 if profile == 'small' else 3)
            prepared.append({'task': task, 'variant': VARIANT, 'contextProfile': profile, 'sample': sample,
                             'passages': passages, 'retrievalMs': (time.perf_counter() - started) * 1000,
                             'queryEmbeddingInputSha256': digest(query_input(queries[sample['id']])),
                             'retrievalTimingScope': 'FAISS + BM25 + fusion; query embedding is cached and excluded'})
        del index, bm25, rows
        print(json.dumps({'profile': profile, 'jobs': len(prepared)}), flush=True)
    # Reverify source immutability before publishing runnable jobs.
    if source_spec(base)[1] != spec:
        raise ValueError('Source changed during retrieval')
    out.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(base / 'source-aliases.json', out / 'source-aliases.json')
    metadata = {k: v for k, v in original.items() if not sampling or k != 'frozenSelectionSha256'}
    write_json(out / 'manifest.json', {**metadata, 'date': datetime.now(timezone.utc).isoformat(),
               'selection': selection,
               **({'sampling': sampling, 'selectionSha256': digest(json.dumps(selection, sort_keys=True, separators=(',', ':'))),
                   'split': 'Fresh deterministic stratified questions excluding all supplied prior evaluation reports and the base selection'} if sampling else {}),
               'variants': [VARIANT], 'primaryVariant': VARIANT, 'indexFiles': {VARIANT: index_files},
               'embeddingBuild': state, 'queryEmbeddingUsageBefore': before, 'queryEmbeddingUsageAfter': after,
               'hybridRetrieval': RETRIEVAL, 'retrieval': 'Nebius Qwen3-Embedding-8B, FAISS IndexFlatL2 top 60, rank-bm25, 60/40 min-max score fusion, task-specific k; no character cap.',
               'assumptions': original['assumptions'] + ' Hybrid reconstruction choices: Qwen 8B variant, normalized vectors, cosine derived from L2, per-candidate-set min-max scaling, BM25Okapi with Unicode word tokenization. These details are unspecified by the paper.',
               'scope': 'Paper-style hybrid retrieval reconstruction on the available corpus; not exact original ProAgent replication. ' + ('Fresh questions, frozen before retrieval; same Opus generator.' if sampling else 'Frozen development questions; same Opus generator.'),
               'retrievalTimingScope': 'FAISS + BM25 + fusion; cached query embedding time excluded'})
    write_json(out / 'jobs.json', prepared)
    print(json.dumps({'ready': True, 'jobs': len(prepared), 'queryEmbeddingUsage': after}))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('base', 'embeddings', 'source', 'out'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--api-key-file')
    p.add_argument('--per-task', type=int, help='Select this many fresh questions per task instead of reusing the base selection')
    p.add_argument('--exclude-report', nargs='+', default=[], help='Prior evaluation reports whose selected IDs must be excluded')
    p.add_argument('--live', action='store_true', help='Allow query embedding calls; otherwise cache-only')
    args = p.parse_args()
    client = NebiusClient(load_key(args.api_key_file)) if args.live else None
    prepare(Path(args.base).resolve(), Path(args.embeddings).resolve(), Path(args.source).resolve(), Path(args.out).resolve(), client,
            args.per_task, args.exclude_report)


if __name__ == '__main__':
    main()
