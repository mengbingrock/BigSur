"""Compare stored draws only after checking corpus/model/sample equivalence."""
import hashlib
import json
from pathlib import Path
import statistics


def compare_report(current, filename):
    data = Path(filename).read_bytes()
    baseline = json.loads(data)
    for field in ('sourceAudit', 'checksums', 'model', 'selection'):
        if current[field] != baseline[field]:
            raise ValueError(f'Baseline {field} differs; cannot compare retrieval variants')
    def keyed(report):
        result = {(r['task'], r['variant'], r['id']): r for r in report['cases']}
        if len(result) != len(report['cases']):
            raise ValueError('Duplicate evaluation cases')
        expected = {(t, v, s['id']) for t, group in report['selection'].items()
                    for v in report['variants'] for s in group['selected']}
        if result.keys() != expected:
            raise ValueError('Missing or unexpected evaluation cases')
        return result
    new, old = keyed(current), keyed(baseline)
    primary = current.get('primaryVariant', 'paper-context')
    tasks = {}
    for task, group in current['selection'].items():
        tasks[task] = {}
        for variant in baseline['variants']:
            pairs = [(new[task, primary, s['id']], old[task, variant, s['id']]) for s in group['selected']]
            deltas = [a['score'] - b['score'] for a, b in pairs]
            tasks[task][variant] = {
                'total': len(pairs), 'primaryVariant': primary,
                ('paperContextScore' if primary == 'paper-context' else 'primaryScore'): statistics.mean(a['score'] for a, _ in pairs),
                'baselineScore': statistics.mean(b['score'] for _, b in pairs),
                'pairedDelta': statistics.mean(deltas),
                'wins': sum(d > 0 for d in deltas), 'losses': sum(d < 0 for d in deltas), 'ties': sum(d == 0 for d in deltas),
                'metric': 'token_f1' if task == 'GEN' else 'all-selected accuracy',
            }
    return {'baselineReportSha256': hashlib.sha256(data).hexdigest(),
            'scope': 'Single draws on previously analyzed development samples; baseline predictions stored, not rerun. Call failures score zero. No causal or fresh-holdout claim.',
            'tasks': tasks}
