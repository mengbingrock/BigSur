"""Summarize reproducible ProAgent comparisons without exposing benchmark text."""
import argparse
from collections import Counter
import json
from pathlib import Path
import statistics

from compareReports import compare_report


def audit(report):
    rows = report['cases']
    stages = Counter()
    stops = Counter()
    revision_outcomes = Counter()
    for row in rows:
        a = row.get('agentAudit', {})
        stages.update(a.get('phaseCallCounts', {}))
        stops[a.get('stopReason') or ('provider_refusal' if row.get('error') == 'provider biology safeguard refusal' else 'unreported')] += 1
        if a.get('phaseCallCounts', {}).get('revision', 0) and not row.get('error') and 'firstDraftScore' in a:
            delta = row['score'] - a['firstDraftScore']
            revision_outcomes['improved' if delta > 0 else 'worsened' if delta < 0 else 'unchanged'] += 1
    first_to_final = {}
    for task in sorted({r['task'] for r in rows}):
        kept = [r for r in rows if r['task'] == task and not r.get('error')
                and 'firstDraftScore' in r.get('agentAudit', {})]
        if kept:
            first_to_final[task] = {
                'evaluated': len(kept),
                'firstDraftScore': statistics.mean(r['agentAudit']['firstDraftScore'] for r in kept),
                'finalScore': statistics.mean(r['score'] for r in kept),
                'pairedDelta': statistics.mean(r['score'] - r['agentAudit']['firstDraftScore'] for r in kept),
            }
    return {
        'cases': len(rows), 'modelCalls': sum(a.get('agentAudit', {}).get('modelCalls', 1) for a in rows),
        'providerRefusals': sum(a.get('error') == 'provider biology safeguard refusal' for a in rows),
        'otherErrors': sum(bool(a.get('error')) and a['error'] != 'provider biology safeguard refusal' for a in rows),
        'casesWithArgumentErrors': sum(a.get('agentAudit', {}).get('toolArgumentFailures', 0) > 0 for a in rows),
        'argumentErrorEvents': sum(a.get('agentAudit', {}).get('toolArgumentFailures', 0) for a in rows),
        'oscillationStops': sum(a.get('agentAudit', {}).get('stoppedByOscillation', False) for a in rows),
        'casesWithReviewCalls': sum(a.get('agentAudit', {}).get('phaseCallCounts', {}).get('reflection', 0) > 0 for a in rows),
        'casesWithRevisionCalls': sum(a.get('agentAudit', {}).get('phaseCallCounts', {}).get('revision', 0) > 0 for a in rows),
        'phaseCalls': dict(stages), 'stopReasons': dict(stops),
        'revisionOutcomesNonErrors': dict(revision_outcomes),
        'firstToFinalNonErrors': first_to_final,
        'medianModelMs': statistics.median(a['modelMs'] for a in rows),
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--report', required=True)
    p.add_argument('--original', required=True)
    p.add_argument('--rag', required=True)
    p.add_argument('--out', required=True)
    args = p.parse_args()
    current, original, rag = [json.loads(Path(f).read_text()) for f in (args.report, args.original, args.rag)]
    # Validate same model/corpus/selection and complete unique case sets first.
    comparisons = {name: compare_report(current, filename)
                   for name, filename in [('original', args.original), ('rag', args.rag)]}
    def keyed(report):
        return {(c['task'], c['id']): c for c in report['cases'] if c['variant'] == report['primaryVariant']}
    arms = {name: keyed(report) for name, report in [('patched', current), ('original', original), ('rag', rag)]}
    common = {}
    for task in current['selection']:
        ids = [s['id'] for s in current['selection'][task]['selected']]
        kept = [i for i in ids if all(arm[task, i].get('error') != 'provider biology safeguard refusal' for arm in arms.values())]
        common[task] = {'evaluated': len(kept), 'excludedAnyArmRefusal': len(ids)-len(kept),
                        'scores': {name: statistics.mean(arm[task, i]['score'] for i in kept) if kept else None for name, arm in arms.items()},
                        'includedIds': kept}
    output = {'policy': 'Pairwise comparisons exclude refusals in either arm; common-three-arm scores exclude refusals in any arm. Other failures remain zero.',
              'audit': {name: audit(report) for name, report in [('patched', current), ('original', original), ('rag', rag)]},
              'pairwise': comparisons, 'commonThreeArm': common}
    Path(args.out).write_text(json.dumps(output, indent=2) + '\n')
    print(json.dumps({'audit': output['audit'], 'commonThreeArm': {t: {k: v for k, v in r.items() if k != 'includedIds'} for t, r in common.items()}}, indent=2))


if __name__ == '__main__':
    main()
