"""Build two real FAISS IndexFlatL2 indexes from the verified paper-context KBs.
Default is a read-only inventory; --live enables paid API calls. Resume with the
same arguments. Never publish an index until every source chunk has a vector.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sqlite3

import faiss
import numpy as np
from nebiusEmbeddings import CONFIG, DIMENSIONS, EmbeddingCache, NebiusClient, digest, load_key


def file_hash(filename):
    h = hashlib.sha256()
    with open(filename, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def write_json(filename, value):
    filename = Path(filename)
    temporary = filename.with_suffix(filename.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False))
    temporary.replace(filename)


@contextmanager
def writer_lock(root):
    root.mkdir(parents=True, exist_ok=True)
    with (root / '.build-lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another embedding/index process owns this directory') from None
        yield


def source_rows(base, profile):
    with sqlite3.connect((base / f'paper-{profile}.sqlite').resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        return [dict(r) for r in db.execute('SELECT rowid,protocol_id,title,path,grain,heading,text,startChar,endChar FROM chunks ORDER BY rowid')]


def source_spec(base):
    manifest = json.loads((base / 'manifest.json').read_text())
    if manifest.get('contextPolicyVersion') != 'paper-context-v1' or manifest.get('variants') != ['paper-context']:
        raise ValueError('Expected verified paper-context-v1 indexes')
    files = {f'paper-{p}.sqlite': file_hash(base / f'paper-{p}.sqlite') for p in ('small', 'large')}
    for profile in ('small', 'large'):
        with sqlite3.connect((base / f'paper-{profile}.sqlite').resolve().as_uri() + '?mode=ro', uri=True) as db:
            count, protocols = db.execute('SELECT count(*),count(DISTINCT protocol_id) FROM chunks').fetchone()
        if count != manifest['counts'][profile] or protocols != manifest['protocols']:
            raise ValueError(f'Paper index counts differ from manifest: {profile}')
    return manifest, {'paperManifestSha256': file_hash(base / 'manifest.json'), 'sourceIndexSha256': files,
                      'embedding': CONFIG, 'indexType': 'IndexFlatL2',
                      'dependencies': {name: importlib.metadata.version(name) for name in ('faiss-cpu', 'numpy', 'rank-bm25')}}


def ensure_vectors(texts, cache, client, batch_size=16, workers=4, progress=None):
    """Bound concurrent requests and commit successes even if another batch fails."""
    if batch_size < 1 or workers < 1:
        raise ValueError('Batch size and workers must be positive')
    def batches():
        seen, batch = set(), []
        for text in texts:
            key = digest(text)
            if key in seen:
                continue
            seen.add(key)
            if cache.get(text) is not None:
                continue
            if client is None:
                raise ValueError('Embedding cache incomplete; supply Nebius credentials and run with --live')
            batch.append(text)
            if len(batch) == batch_size:
                yield batch
                batch = []
        if batch:
            yield batch
    iterator = iter(batches())
    error, exhausted = None, False
    with ThreadPoolExecutor(max_workers=workers) as pool:
        pending = {}
        while pending or not exhausted:
            while not error and not exhausted and len(pending) < workers:
                try:
                    batch = next(iterator)
                except StopIteration:
                    exhausted = True
                    break
                except Exception as exc:
                    error, exhausted = exc, True
                    break
                pending[pool.submit(client.embed, batch)] = batch
            if not pending:
                break
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                batch = pending.pop(future)
                try:
                    vectors, tokens = future.result()
                    cache.put(batch, vectors, tokens)
                    if progress:
                        progress(cache.stats())
                except Exception as exc:
                    error, exhausted = error or exc, True
        if error:
            raise error


def build_profile(base, root, profile, cache, client, batch_size=16, workers=4):
    rows = source_rows(base, profile)
    ensure_vectors((r['text'] for r in rows), cache, client, batch_size, workers,
                   lambda stats: print(json.dumps({'profile': profile, **stats}), flush=True))
    index = faiss.IndexFlatL2(DIMENSIONS)
    # Reconstitute from committed vectors on resume; never append duplicate IDs.
    for start in range(0, len(rows), 256):
        vectors = [cache.get(r['text']) for r in rows[start:start + 256]]
        if any(v is None for v in vectors):
            raise ValueError('Incomplete embedding cache; refusing to publish index')
        index.add(np.vstack(vectors))
    target = root / f'paper-{profile}.faiss'
    faiss.write_index(index, str(target) + '.tmp')
    Path(str(target) + '.tmp').replace(target)
    # Mapping contains source addresses only. Text stays in the existing KB.
    mapping = [{'rowid': r['rowid'], 'protocolId': r['protocol_id'], 'startChar': r['startChar'],
                'endChar': r['endChar'], 'textSha256': digest(r['text'])} for r in rows]
    write_json(root / f'paper-{profile}-mapping.json', mapping)
    return {'vectors': index.ntotal, 'dimensions': index.d,
            'indexSha256': file_hash(target), 'mappingSha256': file_hash(root / f'paper-{profile}-mapping.json')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True, help='Existing paper-context index directory')
    parser.add_argument('--out', required=True)
    parser.add_argument('--api-key-file')
    parser.add_argument('--batch-size', type=int, default=16)
    parser.add_argument('--workers', type=int, default=4)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--live', action='store_true')
    mode.add_argument('--offline', action='store_true', help='Rebuild exclusively from existing cached vectors')
    args = parser.parse_args()
    if args.batch_size < 1 or args.workers < 1:
        parser.error('Batch size and workers must be positive')
    base, root = Path(args.base).resolve(), Path(args.out).resolve()
    if base == root:
        parser.error('Use a separate output directory')
    original, spec = source_spec(base)
    if not args.live and not args.offline:
        print(json.dumps({'mode': 'dry-run', 'protocols': original['protocols'], 'chunks': original['counts'],
                          'embedding': CONFIG, 'sourceIndexSha256': spec['sourceIndexSha256'],
                          'next': 'Configure NEBIUS_API_KEY or --api-key-file, then repeat with --live'}, indent=2))
        return
    client = NebiusClient(load_key(args.api_key_file)) if args.live else None
    with writer_lock(root):
        marker = root / 'embedding-manifest.json'
        if marker.exists():
            state = json.loads(marker.read_text())
            if state['spec'] != spec:
                raise ValueError('Source/model/dependency settings changed; use a new output directory')
            if state['status'] == 'ready':
                for p, info in state['profiles'].items():
                    if file_hash(root / f'paper-{p}.faiss') != info['indexSha256'] or file_hash(root / f'paper-{p}-mapping.json') != info['mappingSha256']:
                        raise ValueError('Completed index corrupted; restore it or use a new directory')
                print(json.dumps({'ready': True, 'alreadyBuilt': True, 'usage': state['usage']}))
                return
        else:
            if set(p.name for p in root.iterdir()) != {'.build-lock'}:
                raise ValueError('Output directory contains unrelated artifacts')
            state = {'status': 'building', 'spec': spec, 'profiles': {}, 'startedAt': datetime.now(timezone.utc).isoformat()}
            write_json(marker, state)
        cache = EmbeddingCache(root / 'embeddings.sqlite')
        try:
            for profile in ('small', 'large'):
                state['profiles'][profile] = build_profile(base, root, profile, cache, client, args.batch_size, args.workers)
                state['usage'] = cache.stats()
                write_json(marker, state)
            # Catch a source changed while requests were in flight.
            if source_spec(base)[1] != spec:
                raise ValueError('Source changed during build; index will not be marked ready')
            state.update(status='ready', completedAt=datetime.now(timezone.utc).isoformat(), usage=cache.stats())
            write_json(marker, state)
        finally:
            cache.close()
        print(json.dumps({'ready': True, 'profiles': state['profiles'], 'usage': state['usage']}))


if __name__ == '__main__':
    main()
