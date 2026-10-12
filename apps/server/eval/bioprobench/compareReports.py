"""Compare stored draws only after checking corpus/model/sample equivalence."""
import hashlib
import json
from pathlib import Path
import statistics
import math
import random


def paired_nonrefusals(pairs):
    """Same-case comparison; exclude a case if either arm has a provider refusal."""
    kept = [(a, b) for a, b in pairs if all(
        r.get('error') != 'provider biology safeguard refusal' for r in (a, b))]
    deltas = [a['score'] - b['score'] for a, b in kept]
    wins, losses = sum(d > 0 for d in deltas), sum(d < 0 for d in deltas)
    rng = random.Random(20261012)
    boot = sorted(statistics.mean(rng.choices(deltas, k=len(deltas))) for _ in range(10000)) if deltas else []
    n = wins + losses
    return {'evaluated': len(kept), 'excludedEitherArmRefusal': len(pairs) - len(kept),
            'primaryScore': statistics.mean(a['score'] for a, _ in kept) if kept else None,
            'baselineScore': statistics.mean(b['score'] for _, b in kept) if kept else None,
            'pairedDelta': statistics.mean(deltas) if deltas else None,
            'wins': wins, 'losses': losses, 'ties': len(kept) - wins - losses,
            'bootstrap95CI': [boot[250], boot[9749]] if boot else None,
            'exactMcNemarP': min(1, 2 * sum(math.comb(n, k) for k in range(min(wins, losses) + 1)) / 2**n) if n else 1,
            'includedIds': [a['id'] for a, _ in kept],
            'policy': 'Exclude provider refusals in either arm; other failures remain zero; conditioning on responses can introduce selection bias.'}


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
            if current.get('primaryScores'):
                matched = paired_nonrefusals(pairs)
                if task == 'GEN':
                    matched['exactMcNemarP'] = None
                tasks[task][variant]['pairedNonRefusals'] = matched
    return {'baselineReportSha256': hashlib.sha256(data).hexdigest(),
            'scope': 'Single draws on previously analyzed development samples; baseline predictions stored, not rerun. Call failures score zero. No causal or fresh-holdout claim.',
            'tasks': tasks}
