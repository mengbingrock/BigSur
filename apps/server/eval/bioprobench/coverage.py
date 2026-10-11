"""Source availability proxy from visible ORD titles, never gold step order.
An unmatched title means unresolved coverage, not proof of an absent source.
"""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import re
import unicodedata


def normalize(title):
    value = unicodedata.normalize('NFKC', title).lower()
    return ' '.join(''.join(c if unicodedata.category(c)[0] in 'LN' else ' ' for c in value).split())


def catalog(aliases):
    result = defaultdict(list)
    for alias in aliases:
        result[normalize(alias['title'])].append(alias)
    return result


def match_source(sample, titles):
    parsed = re.search(r"titled '(.*)' in the correct order", sample['question'])
    target = normalize(parsed.group(1)) if parsed else None
    matches = titles.get(target, []) if target else []
    ids = sorted({m['protocolId'] for m in matches})
    root = any(m['nodeId'] is None for m in matches)
    return {'titleParsed': bool(target), 'status': 'matched-title' if matches else 'unresolved',
            'sourceAvailable': True if matches else None,
            'matchKind': ('root' if root else 'section') if matches else None,
            'ambiguous': len(ids) > 1, 'protocolIds': ids,
            'matches': [{'protocolId': m['protocolId'], 'nodeId': m['nodeId'], 'path': m['path']} for m in matches]}


def audit(samples, aliases):
    titles = catalog(aliases)
    cases = {s['id']: match_source(s, titles) for s in samples}
    return {'method': 'Exact normalized root OR section title from the visible question; ambiguous matches retained; unresolved does not prove source absence. No reference answers used.',
            'total': len(cases), 'matched': sum(c['status'] == 'matched-title' for c in cases.values()),
            'rootMatches': sum(c['matchKind'] == 'root' for c in cases.values()),
            'sectionOnlyMatches': sum(c['matchKind'] == 'section' for c in cases.values()),
            'unresolved': sum(c['status'] == 'unresolved' for c in cases.values()),
            'ambiguous': sum(c['ambiguous'] for c in cases.values()), 'cases': cases}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--index', type=Path, required=True)
    p.add_argument('--questions', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--selection', type=Path)
    a = p.parse_args()
    samples = json.loads(a.questions.read_text())
    if a.selection:
        ids = {s['id'] for s in json.loads(a.selection.read_text())['selection']['ORD']['selected']}
        samples = [s for s in samples if s['id'] in ids]
        if len(samples) != len(ids):
            raise ValueError('Missing or duplicate frozen sample IDs')
    result = audit(samples, json.loads((a.index / 'source-aliases.json').read_text()))
    a.out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'cases'}, indent=2))
