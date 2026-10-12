"""Nebius-only, resumable document/query embedding cache. No credential logging."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import math
import time
import urllib.error
import urllib.request

import numpy as np

MODEL = 'Qwen/Qwen3-Embedding-8B'
ENDPOINT = 'https://api.tokenfactory.nebius.com/v1/embeddings'
DIMENSIONS = 4096
QUERY_INSTRUCTION = 'Given a web search query, retrieve relevant passages that answer the query'
CONFIG = {'provider': 'Nebius Token Factory', 'endpoint': ENDPOINT, 'model': MODEL,
          'dimensions': DIMENSIONS, 'encoding_format': 'float', 'normalization': 'L2 float32',
          'documentInstruction': None, 'queryInstruction': QUERY_INSTRUCTION, 'version': 1}


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def query_input(text):
    return f'Instruct: {QUERY_INSTRUCTION}\nQuery:{text}'


def load_key(filename=None):
    value = Path(filename).read_text().strip() if filename else os.environ.get('NEBIUS_API_KEY', '').strip()
    if not value:
        raise ValueError('Set NEBIUS_API_KEY or supply --api-key-file pointing to a local file outside Git')
    if not value.isascii() or any(c.isspace() or ord(c) < 33 or ord(c) == 127 for c in value):
        raise ValueError('API key file must contain only the key on a single line')
    return value


def normalized(vectors, dimensions=DIMENSIONS):
    array = np.asarray(vectors, dtype=np.float32)
    if array.ndim != 2 or array.shape[1] != dimensions or not np.isfinite(array).all():
        raise ValueError('Invalid embedding dimensions or non-finite values')
    norms = np.linalg.norm(array.astype(np.float64), axis=1, keepdims=True)
    if np.any(norms == 0):
        raise ValueError('Zero embedding vector')
    return np.ascontiguousarray(array / norms, dtype=np.float32)


def validate_response(data, count, dimensions=DIMENSIONS):
    if data.get('model') != MODEL:
        raise ValueError('Nebius returned a different embedding model')
    rows = data.get('data', [])
    if len(rows) != count or any(type(r.get('index')) is not int for r in rows) or sorted(r['index'] for r in rows) != list(range(count)):
        raise ValueError('Missing, duplicate or invalid embedding response indexes')
    vectors = normalized([r['embedding'] for r in sorted(rows, key=lambda r: r['index'])], dimensions)
    usage = data.get('usage', {})
    if type(usage.get('prompt_tokens')) is not int or usage['prompt_tokens'] < 0:
        raise ValueError('Missing or invalid embedding token usage')
    return vectors, usage['prompt_tokens']


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class NebiusClient:
    def __init__(self, key, opener=None, sleep=time.sleep):
        self._key = key
        self._open = opener or urllib.request.build_opener(NoRedirect()).open
        self._sleep = sleep

    def embed(self, texts):
        if not texts or any(not isinstance(t, str) or not t.strip() for t in texts):
            raise ValueError('Embedding inputs must be nonempty strings')
        payload = json.dumps({'model': MODEL, 'input': texts, 'dimensions': DIMENSIONS,
                              'encoding_format': 'float'}, ensure_ascii=False).encode()
        request = urllib.request.Request(ENDPOINT, data=payload, headers={
            'Authorization': f'Bearer {self._key}', 'Content-Type': 'application/json'})
        for attempt in range(5):
            delay = min(2 ** attempt, 30)
            try:
                with self._open(request, timeout=120) as response:
                    data = json.load(response)
                return validate_response(data, len(texts))
            except urllib.error.HTTPError as exc:
                status = exc.code
                try:
                    retry_after = float((exc.headers or {}).get('Retry-After', '0'))
                    if math.isfinite(retry_after):
                        delay = max(delay, min(60, retry_after))
                except (TypeError, ValueError):
                    pass
                exc.close()
                if status not in (408, 429, 500, 502, 503, 504) or attempt == 4:
                    raise RuntimeError(f'Nebius embedding HTTP {status}; checkpoint retained') from None
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                if attempt == 4:
                    raise RuntimeError('Nebius embedding network failure; checkpoint retained') from None
            self._sleep(delay)
        raise RuntimeError('Embedding retry budget exhausted')


class EmbeddingCache:
    """Single-writer SQLite checkpoint, scoped to exact provider/model settings.

    Cache keys hash the actual embedding input (including query instruction).
    Provider usage and vectors are committed together after validating the whole
    response. A crash after an API success but before commit can rebill one batch.
    """
    def __init__(self, filename, config=CONFIG):
        self.db = sqlite3.connect(filename)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('CREATE TABLE IF NOT EXISTS metadata(config TEXT NOT NULL);'
                             'CREATE TABLE IF NOT EXISTS vectors(hash TEXT PRIMARY KEY, vector BLOB NOT NULL);'
                             'CREATE TABLE IF NOT EXISTS usage(tokens INTEGER NOT NULL, inputs INTEGER NOT NULL);')
        stored = self.db.execute('SELECT config FROM metadata').fetchone()
        self.config = json.dumps(config, sort_keys=True)
        self.dimensions = config['dimensions']
        if stored and stored[0] != self.config:
            self.db.close()
            raise ValueError('Embedding cache settings differ; use a new output directory')
        if not stored:
            with self.db:
                self.db.execute('INSERT INTO metadata VALUES(?)', (self.config,))

    def get(self, text):
        row = self.db.execute('SELECT vector FROM vectors WHERE hash=?', (digest(text),)).fetchone()
        if row is None:
            return None
        vector = np.frombuffer(row[0], dtype='<f4')
        if vector.shape != (self.dimensions,) or not np.isfinite(vector).all() or not np.isclose(np.linalg.norm(vector), 1, atol=1e-5):
            raise ValueError('Invalid cached embedding; cache may be corrupt')
        return vector

    def put(self, texts, vectors, tokens):
        vectors = normalized(vectors, self.dimensions)
        if len(texts) != len(vectors):
            raise ValueError('Embedding batch length mismatch')
        with self.db:
            for text, vector in zip(texts, vectors):
                self.db.execute('INSERT OR IGNORE INTO vectors VALUES(?,?)', (digest(text), vector.astype('<f4').tobytes()))
            self.db.execute('INSERT INTO usage VALUES(?,?)', (tokens, len(texts)))

    def stats(self):
        tokens, inputs, calls = self.db.execute('SELECT coalesce(sum(tokens),0),coalesce(sum(inputs),0),count(*) FROM usage').fetchone()
        return {'cachedInputs': self.db.execute('SELECT count(*) FROM vectors').fetchone()[0],
                'successfulResponseTokens': tokens, 'successfulResponseInputs': inputs, 'successfulResponses': calls,
                'estimatedEmbeddingUSDAtPublishedRate': tokens / 1_000_000 * 0.01,
                'costNote': 'Estimate at $0.01/M, not an invoice. Failed/retried or uncommitted responses may incur additional charges.'}

    def close(self):
        self.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        self.db.close()
