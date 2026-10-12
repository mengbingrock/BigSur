import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import faiss
import numpy as np
from rank_bm25 import BM25Okapi
import buildNebiusIndex as builder
from nebiusEmbeddings import CONFIG, DIMENSIONS, MODEL, EmbeddingCache, NebiusClient, normalized, query_input, validate_response
from prepareNebiusHybrid import prepare, retrieve, scale, task_query, tokens


def vector(axis=0):
    v = np.zeros(DIMENSIONS, dtype=np.float32)
    v[axis] = 1
    return v


class FakeClient:
    def __init__(self):
        self.calls = []

    def embed(self, texts):
        self.calls.append(list(texts))
        return np.vstack([vector(0 if 'alpha' in t else 1) for t in texts]), sum(len(t.split()) for t in texts)


class NebiusTests(unittest.TestCase):
    def test_reorders_response_and_checks_model_dimensions_indexes_and_finiteness(self):
        data = dict(model=MODEL, usage={'prompt_tokens': 12}, data=[
            {'index': 1, 'embedding': (vector(1) * 3).tolist()}, {'index': 0, 'embedding': vector(0).tolist()}])
        result, count = validate_response(data, 2)
        np.testing.assert_array_equal(result, np.vstack([vector(0), vector(1)]))
        self.assertEqual(count, 12)
        with self.assertRaisesRegex(ValueError, 'model'):
            validate_response({**data, 'model': 'wrong'}, 2)
        with self.assertRaisesRegex(ValueError, 'indexes'):
            validate_response({**data, 'data': [data['data'][0]] * 2}, 2)
        for bad in ([1], [float('nan')] * DIMENSIONS, [0] * DIMENSIONS):
            with self.assertRaises(ValueError):
                validate_response({**data, 'data': [{'index': 0, 'embedding': bad}]}, 1)

    def test_retries_transient_errors_but_does_not_log_auth_or_provider_body(self):
        calls, sleeps = [], []
        def open_(request, timeout):
            calls.append(request)
            if len(calls) == 1:
                raise urllib.error.HTTPError(request.full_url, 429, 'SECRET_BODY', {'Retry-After': '2'}, io.BytesIO(b'SECRET_BODY'))
            return io.BytesIO(json.dumps(dict(model=MODEL, usage={'prompt_tokens': 1}, data=[{'index': 0, 'embedding': vector().tolist()}])).encode())
        client = NebiusClient('SECRET_KEY', opener=open_, sleep=sleeps.append)
        client.embed(['reference'])
        self.assertEqual(len(calls), 2)
        self.assertEqual(sleeps, [2])
        body = json.loads(calls[0].data)
        self.assertEqual(body['model'], MODEL)
        self.assertEqual(body['dimensions'], 4096)
        self.assertEqual(calls[0].full_url, CONFIG['endpoint'])
        def denied(*args, **kwargs):
            raise urllib.error.HTTPError(CONFIG['endpoint'], 401, 'SECRET_BODY', {}, io.BytesIO(b'SECRET_BODY'))
        with self.assertRaisesRegex(RuntimeError, 'HTTP 401') as error:
            NebiusClient('SECRET_KEY', opener=denied).embed(['reference'])
        self.assertNotIn('SECRET', str(error.exception))

    def test_cache_resumes_deduplicates_and_rejects_changed_settings(self):
        with tempfile.TemporaryDirectory() as d:
            file = Path(d) / 'cache.sqlite'
            cache, client = EmbeddingCache(file), FakeClient()
            builder.ensure_vectors(['alpha', 'beta', 'alpha'], cache, client, batch_size=1, workers=2)
            self.assertEqual(len(client.calls), 2)
            before = cache.stats()
            cache.close()
            cache = EmbeddingCache(file)
            builder.ensure_vectors(['beta', 'alpha'], cache, None)
            self.assertEqual(cache.stats(), before)
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                builder.ensure_vectors(['missing'], cache, None)
            cache.close()
            with self.assertRaisesRegex(ValueError, 'settings differ'):
                EmbeddingCache(file, {**CONFIG, 'model': 'different'})

    def test_valid_batch_survives_another_batch_failure(self):
        class PartialClient(FakeClient):
            def embed(self, texts):
                if texts == ['bad']:
                    raise RuntimeError('Failed batch')
                return super().embed(texts)
        with tempfile.TemporaryDirectory() as d:
            cache = EmbeddingCache(Path(d) / 'cache.sqlite')
            with self.assertRaisesRegex(RuntimeError, 'Failed batch'):
                builder.ensure_vectors(['alpha', 'bad'], cache, PartialClient(), batch_size=1, workers=2)
            self.assertIsNotNone(cache.get('alpha'))
            self.assertIsNone(cache.get('bad'))
            cache.close()

    def test_real_faiss_candidate_gate_and_weighted_scores(self):
        # The lexical-perfect 61st source must not bypass the dense top-60 gate.
        vectors = np.vstack([vector(0) for _ in range(60)] + [vector(1)])
        index = faiss.IndexFlatL2(DIMENSIONS)
        index.add(vectors)
        rows = [{'text': 'reference alpha' if i == 0 else 'reference beta', 'id': i} for i in range(60)]
        rows.append({'text': 'alpha alpha alpha', 'id': 60})
        bm = BM25Okapi([tokens(r['text']) for r in rows])
        result = retrieve(index, bm, rows, 'alpha', vector(0), 5)
        self.assertEqual(len(result), 5)
        self.assertNotIn(60, [r['id'] for r in result])
        self.assertEqual(result[0]['id'], 0)
        for r in result:
            self.assertAlmostEqual(r['score'], .6 * r['semanticScaled'] + .4 * r['lexicalScaled'])
            self.assertAlmostEqual(r['semanticScore'], 1 - r['squaredL2'] / 2)
        np.testing.assert_array_equal(scale([2, 2]), [0, 0])
        np.testing.assert_allclose(scale([-1, 1, 3]), [0, .5, 1])

    def test_visible_query_fields_and_instruction(self):
        sample = dict(question='visible', answer='SECRET', wrong_steps=['visible'], correct_steps=['SECRET'],
                      is_correct=False, corrupted_text='visible', corrected_text='SECRET', context={'x': 'visible'},
                      instruction='visible', input='visible', output='SECRET')
        for t in ['PQA', 'ORD', 'ERR', 'GEN']:
            self.assertNotIn('SECRET', task_query(t, sample))
        self.assertEqual(task_query('ERR', sample), 'visible {"x":"visible"}')
        self.assertTrue(query_input('visible').endswith('\nQuery:visible'))

    def test_complete_build_resume_hybrid_preparation_and_corruption_guard(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); base = root / 'base'; base.mkdir()
            source = root / 'source'; (source / 'Data').mkdir(parents=True)
            out, evaluation = root / 'vectors', root / 'evaluation'
            jobs, selection, checksums = [], {}, {}
            for task in ['PQA', 'ORD', 'ERR', 'GEN']:
                sample = dict(id=task, type='fixture', question='alpha', wrong_steps=['alpha'],
                              is_correct=False, corrupted_text='alpha', corrected_text='SECRET',
                              context={}, instruction='alpha', input='reference', output='SECRET')
                filename = source / 'Data' / f'{task}_test.json'
                filename.write_text(json.dumps([sample, {**sample, 'id': task + '-fresh'}]))
                checksums[filename.name] = builder.file_hash(filename)
                selection[task] = {'selected': [{'id': task, 'type': 'fixture'}]}
                jobs.append(dict(task=task, variant='paper-context', sample=sample))
            manifest = dict(contextPolicyVersion='paper-context-v1', variants=['paper-context'],
                            protocols=6, counts={'small': 6, 'large': 6}, checksums=checksums, selection=selection,
                            sourceAudit=[], assumptions='Synthetic fixture, no live model calls', frozenSelectionSha256='old-selection')
            (base / 'manifest.json').write_text(json.dumps(manifest))
            (base / 'jobs.json').write_text(json.dumps(jobs))
            (base / 'source-aliases.json').write_text('[]')
            for profile in ['small', 'large']:
                db = sqlite3.connect(base / f'paper-{profile}.sqlite')
                db.execute('CREATE TABLE chunks(protocol_id,title,path,grain,heading,text,startChar,endChar)')
                for i in range(6):
                    text = ('alpha' if i == 0 else 'beta') + (' x' * (1000 if profile == 'small' else 2500))
                    db.execute('INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?)', (f'source:{i}', 'Fixture', '', 'section', '', text, 0, len(text)))
                db.commit(); db.close()
            client = FakeClient()
            args = ['buildNebiusIndex.py', '--base', str(base), '--out', str(out), '--live']
            with patch.dict(os.environ, {'NEBIUS_API_KEY': 'offline-fixture'}), patch('sys.argv', args), patch.object(builder, 'NebiusClient', return_value=client):
                builder.main()
                calls = len(client.calls)
                builder.main()
                self.assertEqual(len(client.calls), calls)
            state = json.loads((out / 'embedding-manifest.json').read_text())
            self.assertEqual(state['status'], 'ready')
            self.assertEqual(state['profiles']['large']['vectors'], 6)
            prepare(base, out, source, evaluation, client)
            prepared = json.loads((evaluation / 'jobs.json').read_text())
            self.assertEqual(len(prepared), 4)
            for j in prepared:
                self.assertEqual(len(j['passages']), 5 if j['task'] in ['PQA', 'ERR'] else 3)
                self.assertGreater(sum(len(p['text']) for p in j['passages']), 8000)
            fresh = root / 'fresh-evaluation'
            prepare(base, out, source, fresh, client, per_task=1, exclude_reports=[base / 'manifest.json'])
            fresh_manifest = json.loads((fresh / 'manifest.json').read_text())
            self.assertNotIn('frozenSelectionSha256', fresh_manifest)
            self.assertEqual(fresh_manifest['sampling']['perTask'], 1)
            self.assertTrue(all(j['sample']['id'].endswith('-fresh') for j in json.loads((fresh / 'jobs.json').read_text())))
            (out / 'paper-small.faiss').write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                prepare(base, out, source, root / 'bad-evaluation', client)


if __name__ == '__main__':
    unittest.main()
