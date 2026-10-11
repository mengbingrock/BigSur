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
p.add_argument('--base', help='Original corpus index directory for follow-up evaluations')
a = p.parse_args()
root = Path(a.out)
manifest = json.loads((root / 'manifest.json').read_text())
summary = json.loads((root / 'summary.json').read_text())
summary['callFailures'] = summary.pop('transportErrors', summary.get('callFailures', 0))
rows = [json.loads(f.read_text()) for f in (root / 'responses').glob('*.json')]

sys.path.insert(0, str(Path(a.source) / 'skills/evaluate-protocol-outputs/scripts'))
from normalize import normalize_record, canonical_task
from ordering import validate_pair
from generation import as_text, token_overlap
variants = sorted(summary['metrics'])
primary = 'expanded' if 'expanded' in variants else 'hierarchy'
index_root = Path(a.base) if a.base else root

def score(row):
    if row.get('error'):
        return 0.0
    if row['task'] != 'GEN':
        return float(correct(row))
    try:
        normalized = normalize_record({**row['sample'], 'generated_response': row['generated_response']}, canonical_task(row['task']), 'bioprobench', 'auto', {'id': 'id'})
        return token_overlap(as_text(normalized['reference']), as_text(normalized['prediction']))[2]
    except Exception:
        return 0.0

def correct(row):
    try:
        normalized = normalize_record({**row['sample'], 'generated_response': row['generated_response']}, canonical_task(row['task']), 'bioprobench', 'auto', {'id': 'id'})
        if row['task'] == 'ORD':
            validate_pair(normalized['prediction'], normalized['reference'])
        return normalized['prediction'] == normalized['reference']
    except Exception:
        return False

def scorable(row):
    if row.get('error'):
        return False
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
    for baseline in [v for v in variants if v != primary]:
        pairs = [(score(by[(task, primary, i)]), score(by[(task, baseline, i)])) for i in ids]
        changes = [x-y for x,y in pairs]
        wins, losses = sum(x > 0 for x in changes), sum(x < 0 for x in changes)
        rng = random.Random(20261010)
        boot = sorted(sum(rng.choices(changes, k=len(changes)))/len(changes) for _ in range(10000))
        discordant = wins + losses
        probability = min(1, 2 * sum(math.comb(discordant, k) for k in range(min(wins, losses)+1)) / 2**discordant) if discordant else 1
        comparisons[task][baseline] = {'pairedDelta': statistics.mean(changes), 'wins': wins, 'losses': losses, 'ties': len(changes)-discordant, 'bootstrap95CI': [boot[250], boot[9749]], 'exactMcNemarP': probability if task != 'GEN' else None, 'metric': 'token_f1' if task == 'GEN' else 'all-selected accuracy', 'primary': primary}

common = {}
for task in manifest['selection']:
    ids = [r['id'] for r in manifest['selection'][task]['selected']]
    valid = [i for i in ids if all(scorable(by[(task, v, i)]) for v in variants)]
    common[task] = {'scored': len(valid), 'excluded': len(ids)-len(valid), 'metric': 'token_f1' if task == 'GEN' else 'accuracy', 'scores': {v: sum(score(by[(task, v, i)]) for i in valid) / len(valid) if valid else None for v in variants}}

performance = {}
for variant in variants:
    selected = [r for r in rows if r['variant'] == variant]
    performance[variant] = {'indexBytes': (index_root / f'{variant if variant != "expanded" else "hierarchy"}.sqlite').stat().st_size, 'medianRetrievalMs': statistics.median(r['retrievalMs'] for r in selected), 'medianModelMs': statistics.median(r['elapsedMs'] for r in selected), 'meanContextChars': statistics.mean(r['contextChars'] for r in selected), 'meanPassages': statistics.mean(len(r['passages']) for r in selected)}

# Match both protocol and subsection titles. Record source identity separately
# from retrieval success; unresolved exact titles are not proven missing sources.
from coverage import catalog, match_source
alias_file = index_root / 'source-aliases.json'
if alias_file.exists():
    aliases = json.loads(alias_file.read_text())
    coverage_method = 'Exact normalized root or section title; unresolved availability is unknown'
else:
    db = sqlite3.connect(index_root / 'hierarchy.sqlite')
    aliases = [{'protocolId': pid, 'title': title, 'nodeId': None, 'path': ''} for pid, title in db.execute('SELECT DISTINCT protocol_id,title FROM chunks')]
    coverage_method = 'Legacy index: root titles only; section coverage not audited'
titles = catalog(aliases)
coverage = {}
for r in rows:
    if r['task'] != 'ORD':
        continue
    entry = coverage.setdefault(r['sample']['id'], {**match_source(r['sample'], titles), 'retrievedTarget': {}})
    entry['retrievedTarget'][r['variant']] = any(p['protocol_id'] in entry['protocolIds'] for p in r['passages']) if entry['protocolIds'] else None

failure_breakdown = {v: {task: {'providerBiologyRefusals': sum('[bio]' in str(r.get('error', '')) for r in rows if r['variant'] == v and r['task'] == task), 'otherCallFailures': sum(bool(r.get('error')) and '[bio]' not in str(r['error']) for r in rows if r['variant'] == v and r['task'] == task)} for task in manifest['selection']} for v in variants}
report = {**manifest, **summary, 'failureBreakdown': failure_breakdown, 'allQuestionScores': {task: {variant: sum(score(r) for r in rows if r['task'] == task and r['variant'] == variant) / len(manifest['selection'][task]['selected']) for variant in variants} for task in manifest['selection']}, 'commonScorable': common, 'comparisons': comparisons, 'performance': performance, 'orderingCoverageMethod': coverage_method, 'orderingCorpusCoverage': coverage,
          'cases': [{'id': r['sample']['id'], 'task': r['task'], 'type': r['sample']['type'], 'variant': r['variant'], 'correct': correct(r) if r['task'] != 'GEN' else None, 'score': score(r), 'retrievalMs': r['retrievalMs'], 'modelMs': r['elapsedMs'], 'contextChars': r['contextChars'], 'error': ('provider biology safeguard refusal' if '[bio]' in str(r.get('error', '')) else ('model call failed; see local checkpoint' if r.get('error') else None)), 'promptSha256': r['promptSha256'], 'resolvedProtocolId': r.get('resolvedProtocolId'), 'modelUsage': r.get('modelUsage', {}), 'responseSha256': hashlib.sha256(r['generated_response'].encode()).hexdigest(), 'sourceRefs': [{'protocolId': s['protocol_id'], 'path': s['path'], 'grain': s['grain']} for s in r['passages']]} for r in rows]}
# Keep metadata readable and each audit case on one line for reviewable diffs.
metadata = json.dumps({k: v for k, v in report.items() if k != 'cases'}, indent=2)
case_lines = ',\n'.join('    ' + json.dumps(c, separators=(',', ':')) for c in report['cases'])
Path(a.report).write_text(metadata[:-2] + ',\n  \"cases\": [\n' + case_lines + '\n  ]\n}\n')
print(json.dumps({'allQuestionScores': report['allQuestionScores'], 'metrics': summary['metrics'], 'comparisons': comparisons, 'performance': performance, 'orderingCoverage': {'parsed': sum(v['titleParsed'] for v in coverage.values()), 'available': sum(v['sourceAvailable'] is True for v in coverage.values()), 'retrieved': {variant: sum(v['retrievedTarget'][variant] is True for v in coverage.values()) for variant in variants}}}, indent=2))
