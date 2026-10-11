"""Produce a shareable report without copying corpus text or reference answers."""
import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import random
import re
import sqlite3
import statistics
import sys

p = argparse.ArgumentParser()
p.add_argument('--out', required=True)
p.add_argument('--report', required=True)
p.add_argument('--source', required=True)
a = p.parse_args()
root = Path(a.out)
manifest = json.loads((root / 'manifest.json').read_text())
summary = json.loads((root / 'summary.json').read_text())
rows = [json.loads(f.read_text()) for f in (root / 'responses').glob('*.json')]

sys.path.insert(0, str(Path(a.source) / 'skills/evaluate-protocol-outputs/scripts'))
from normalize import normalize_record, canonical_task
from ordering import validate_pair

def correct(row):
    try:
        normalized = normalize_record({**row['sample'], 'generated_response': row['generated_response']}, canonical_task(row['task']), 'bioprobench', 'auto', {'id': 'id'})
        if row['task'] == 'ORD':
            validate_pair(normalized['prediction'], normalized['reference'])
        return normalized['prediction'] == normalized['reference']
    except Exception:
        return False

def scorable(row):
    try:
        normalized = normalize_record({**row['sample'], 'generated_response': row['generated_response']}, canonical_task(row['task']), 'bioprobench', 'auto', {'id': 'id'})
        if row['task'] == 'ORD':
            validate_pair(normalized['prediction'], normalized['reference'])
        return True
    except Exception:
        return False

by = {(r['task'], r['variant'], r['sample']['id']): r for r in rows}
comparisons = {}
for task in manifest['selection']:
    comparisons[task] = {}
    ids = [r['id'] for r in manifest['selection'][task]['selected']]
    for baseline in ('flat', 'legacy'):
        pairs = [(int(correct(by[(task, 'hierarchy', i)])), int(correct(by[(task, baseline, i)]))) for i in ids]
        changes = [x-y for x,y in pairs]
        wins, losses = changes.count(1), changes.count(-1)
        rng = random.Random(20261010)
        boot = sorted(sum(rng.choices(changes, k=len(changes)))/len(changes) for _ in range(10000))
        discordant = wins + losses
        probability = min(1, 2 * sum(math.comb(discordant, k) for k in range(min(wins, losses)+1)) / 2**discordant) if discordant else 1
        comparisons[task][baseline] = {'pairedDelta': statistics.mean(changes), 'wins': wins, 'losses': losses, 'ties': len(changes)-discordant, 'bootstrap95CI': [boot[250], boot[9749]], 'exactMcNemarP': probability}

common = {}
for task in manifest['selection']:
    ids = [r['id'] for r in manifest['selection'][task]['selected']]
    valid = [i for i in ids if all(scorable(by[(task, v, i)]) for v in ('flat', 'legacy', 'hierarchy'))]
    common[task] = {'scored': len(valid), 'excluded': len(ids)-len(valid), 'accuracy': {v: sum(correct(by[(task, v, i)]) for i in valid) / len(valid) if valid else None for v in ('flat', 'legacy', 'hierarchy')}}

performance = {}
for variant in ('flat', 'legacy', 'hierarchy'):
    selected = [r for r in rows if r['variant'] == variant]
    performance[variant] = {'indexBytes': (root / f'{variant}.sqlite').stat().st_size, 'medianRetrievalMs': statistics.median(r['retrievalMs'] for r in selected), 'medianModelMs': statistics.median(r['elapsedMs'] for r in selected), 'meanContextChars': statistics.mean(r['contextChars'] for r in selected), 'meanPassages': statistics.mean(len(r['passages']) for r in selected)}

# ORD supplies protocol titles, so corpus availability can be audited without
# consulting its gold step order. PQA has no source labels: do not invent recall.
db = sqlite3.connect(root / 'hierarchy.sqlite')
norm = lambda s: re.sub(r'[^\w]+', '', s.casefold())
titles = {norm(r[0]) for r in db.execute('SELECT DISTINCT title FROM chunks')}
coverage = {}
for r in rows:
    if r['task'] != 'ORD':
        continue
    match = re.search(r"titled '(.*)' in the correct order", r['sample']['question'])
    target = norm(match.group(1)) if match else None
    entry = coverage.setdefault(r['sample']['id'], {'titleParsed': bool(target), 'sourceAvailable': target in titles if target else None, 'retrievedTarget': {}})
    entry['retrievedTarget'][r['variant']] = any(norm(p['title']) == target for p in r['passages']) if target else None

report = {**manifest, **summary, 'allQuestionAccuracy': {task: {variant: sum(correct(r) for r in rows if r['task'] == task and r['variant'] == variant) / len(manifest['selection'][task]['selected']) for variant in ('flat', 'legacy', 'hierarchy')} for task in manifest['selection']}, 'commonScorable': common, 'comparisons': comparisons, 'performance': performance, 'orderingCorpusCoverage': coverage,
          'cases': [{'id': r['sample']['id'], 'task': r['task'], 'type': r['sample']['type'], 'variant': r['variant'], 'correct': correct(r), 'retrievalMs': r['retrievalMs'], 'modelMs': r['elapsedMs'], 'contextChars': r['contextChars'], 'error': r.get('error'), 'promptSha256': r['promptSha256'], 'responseSha256': hashlib.sha256(r['generated_response'].encode()).hexdigest(), 'sourceRefs': [{'protocolId': s['protocol_id'], 'path': s['path'], 'grain': s['grain']} for s in r['passages']]} for r in rows]}
Path(a.report).write_text(json.dumps(report, indent=2))
print(json.dumps({'metrics': summary['metrics'], 'comparisons': comparisons, 'performance': performance, 'orderingCoverage': {'parsed': sum(v['titleParsed'] for v in coverage.values()), 'available': sum(v['sourceAvailable'] is True for v in coverage.values()), 'retrieved': {variant: sum(v['retrievedTarget'][variant] is True for v in coverage.values()) for variant in ('flat','legacy','hierarchy')}}}, indent=2))
