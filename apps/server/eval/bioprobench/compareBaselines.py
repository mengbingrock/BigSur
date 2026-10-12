"""Compare one stored evaluation with named baselines and a common-case table."""
import argparse
import json
from pathlib import Path
import statistics

from compareReports import compare_report


def compare(current_file, baselines):
    current = json.loads(Path(current_file).read_text())
    reports = {'current': current}
    pairs = {}
    for name, filename in baselines.items():
        if name == 'current':
            raise ValueError('current is reserved for the evaluated report')
        pairs[name] = compare_report(current, filename)
        reports[name] = json.loads(Path(filename).read_text())
    arms = {name: {(r['task'], r['id']): r for r in report['cases']
                   if r['variant'] == report['primaryVariant']} for name, report in reports.items()}
    common = {}
    for task, group in current['selection'].items():
        ids = [s['id'] for s in group['selected']]
        kept = [i for i in ids if all(arm[task, i].get('error') != 'provider biology safeguard refusal'
                                      for arm in arms.values())]
        common[task] = {'evaluated': len(kept), 'excludedAnyArmRefusal': len(ids)-len(kept),
                        'scores': {name: statistics.mean(arm[task, i]['score'] for i in kept) if kept else None
                                   for name, arm in arms.items()}, 'includedIds': kept}
    return {'variants': {name: report['primaryVariant'] for name, report in reports.items()},
            'policy': 'Paired comparisons exclude refusals in either arm; common-case table excludes refusals in any arm. Other failures score zero.',
            'pairwise': pairs, 'commonCases': common}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--report', required=True)
    p.add_argument('--baseline', action='append', required=True, metavar='NAME=PATH')
    p.add_argument('--out', required=True)
    a = p.parse_args()
    entries = [s.split('=', 1) for s in a.baseline]
    if any(len(e) != 2 for e in entries) or len({e[0] for e in entries}) != len(entries):
        p.error('Use unique NAME=PATH baselines')
    result = compare(a.report, dict(entries))
    Path(a.out).write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps({t: {k: v for k, v in row.items() if k != 'includedIds'} for t, row in result['commonCases'].items()}, indent=2))


if __name__ == '__main__':
    main()
