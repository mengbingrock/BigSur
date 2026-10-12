"""Deterministic proportional task sampling, excluding prior evaluated IDs."""
from collections import defaultdict
import hashlib
import json
from pathlib import Path

TASKS = ('PQA', 'ORD', 'ERR', 'GEN')
SEED = 'nebius-paper-fresh-v1'


def stratified(task, rows, count, excluded):
    if type(count) is not int or count < 1:
        raise ValueError('Question count must be a positive integer')
    if len({r['id'] for r in rows}) != len(rows):
        raise ValueError(f'Duplicate task IDs: {task}')
    eligible = [r for r in rows if r['id'] not in excluded]
    if len(eligible) < count:
        raise ValueError(f'Insufficient unseen questions for {task}: {len(eligible)} < {count}')
    groups = defaultdict(list)
    for row in eligible:
        key = str(row.get('type', 'default'))
        if task == 'ERR':
            if type(row.get('is_correct')) is not bool:
                raise ValueError('ERR correctness strata require boolean is_correct')
            key += ':' + str(row['is_correct']).lower()
        groups[key].append(row)
    # Largest-remainder allocation gives exactly count without replacement.
    quotas = {key: count * len(items) // len(eligible) for key, items in groups.items()}
    order = sorted(groups, key=lambda key: (-(count * len(groups[key]) % len(eligible)), key))
    for key in order[:count - sum(quotas.values())]:
        quotas[key] += 1
    rank = lambda row: hashlib.sha256(f'{SEED}:{task}:{row["id"]}'.encode()).hexdigest()
    selected = [row for key in sorted(groups) for row in sorted(groups[key], key=rank)[:quotas[key]]]
    return selected, {key: {'eligible': len(groups[key]), 'selected': quotas[key]} for key in sorted(groups)}


def fresh_jobs(source, original, count, exclude_reports):
    if not exclude_reports:
        raise ValueError('Fresh selection requires --exclude-report with prior evaluation reports')
    source = Path(source)
    all_rows, hashes = {}, {}
    for task in TASKS:
        name = f'{task}_test.json'
        data = (source / 'Data' / name).read_bytes()
        hashes[name] = hashlib.sha256(data).hexdigest()
        if hashes[name] != original['checksums'][name]:
            raise ValueError(f'Task checksum changed: {task}')
        all_rows[task] = json.loads(data)
    excluded = {task: set() for task in TASKS}

    def add_previous(report):
        if not report.get('selection'):
            raise ValueError('Exclusion report has no selection')
        for task, group in report['selection'].items():
            if task not in TASKS:
                raise ValueError(f'Unknown exclusion task: {task}')
            name = f'{task}_test.json'
            if report.get('checksums', {}).get(name) != hashes[name]:
                raise ValueError(f'Exclusion report task checksum differs: {task}')
            ids = [r['id'] for r in group['selected']]
            if len(ids) != len(set(ids)) or not set(ids) <= {r['id'] for r in all_rows[task]}:
                raise ValueError(f'Invalid exclusion IDs: {task}')
            excluded[task].update(ids)

    add_previous(original)
    audits = []
    for path in sorted({Path(p).resolve() for p in exclude_reports}):
        data = path.read_bytes()
        report = json.loads(data)
        add_previous(report)
        audits.append({'file': path.name, 'sha256': hashlib.sha256(data).hexdigest()})
    jobs, selection = [], {}
    for task in TASKS:
        rows = all_rows[task]
        selected, strata = stratified(task, rows, count, excluded[task])
        selection[task] = {
            'available': len(rows), 'excludedPriorQuestions': len(excluded[task]),
            'eligible': len(rows) - len(excluded[task]), 'strata': strata,
            'selected': [{'id': row['id'], 'type': row['type'],
                          **({'is_correct': row['is_correct']} if task == 'ERR' else {})} for row in selected]}
        jobs.extend({'task': task, 'sample': row} for row in selected)
    return jobs, selection, {
        'seed': SEED, 'perTask': count, 'exclusionReports': audits,
        'excludesBaseSelection': True,
        'allocation': 'Proportional largest remainder by subtype; ERR also balances is_correct strata',
        'withinStratum': 'SHA-256(seed:task:id), ascending; no answer or model-performance filtering'}
