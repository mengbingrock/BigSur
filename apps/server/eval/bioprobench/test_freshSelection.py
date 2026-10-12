import json
from pathlib import Path
import tempfile
import unittest
from freshSelection import fresh_jobs, stratified
from buildNebiusIndex import file_hash


class FreshSelectionTests(unittest.TestCase):
    def test_exact_proportions_exclusions_and_order_invariance(self):
        rows = [{'id': f'id-{i}', 'type': 'a' if i < 70 else 'b', 'answer': 'hidden'} for i in range(100)]
        excluded = {'id-0', 'id-99'}
        selected, strata = stratified('PQA', rows, 50, excluded)
        ids = [r['id'] for r in selected]
        self.assertEqual(len(set(ids)), 50)
        self.assertFalse(set(ids) & excluded)
        self.assertEqual([strata[k]['selected'] for k in ('a', 'b')], [35, 15])
        changed = [{**r, 'answer': 'different'} for r in reversed(rows)]
        self.assertEqual(ids, [r['id'] for r in stratified('PQA', changed, 50, excluded)[0]])
        with self.assertRaisesRegex(ValueError, 'Insufficient'):
            stratified('PQA', rows, 99, excluded)
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            stratified('PQA', rows + [rows[0]], 50, excluded)
        with self.assertRaisesRegex(ValueError, 'positive'):
            stratified('PQA', rows, 0, excluded)

    def test_error_status_strata_and_small_group_rounding(self):
        rows = [{'id': str(i), 'type': str(i % 3), 'is_correct': bool(i % 2)} for i in range(120)]
        selected, strata = stratified('ERR', rows, 50, set())
        self.assertEqual(len(selected), 50)
        self.assertEqual(len(strata), 6)
        self.assertEqual(sorted(s['selected'] for s in strata.values()), [8, 8, 8, 8, 9, 9])
        self.assertEqual(sum(r['is_correct'] for r in selected), 25)

    def test_source_checksums_prior_reports_and_deterministic_fresh_jobs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'Data').mkdir()
            original = {'checksums': {}, 'selection': {}}
            previous = {'checksums': {}, 'selection': {}}
            for task in ('PQA', 'ORD', 'ERR', 'GEN'):
                rows = [{'id': f'{task}-{i}', 'type': 'fixture', 'is_correct': bool(i % 2)} for i in range(80)]
                path = root / 'Data' / f'{task}_test.json'
                path.write_text(json.dumps(rows))
                original['checksums'][path.name] = previous['checksums'][path.name] = file_hash(path)
                original['selection'][task] = {'selected': [{'id': f'{task}-0'}]}
                previous['selection'][task] = {'selected': [{'id': f'{task}-{i}'} for i in range(1, 10)]}
            report = root / 'prior.json'; report.write_text(json.dumps(previous))
            jobs, selection, audit = fresh_jobs(root, original, 50, [report])
            self.assertEqual(len(jobs), 200)
            for task in selection:
                self.assertEqual(selection[task]['excludedPriorQuestions'], 10)
                self.assertEqual(selection[task]['eligible'], 70)
                self.assertEqual(len(selection[task]['selected']), 50)
                self.assertFalse({s['id'] for s in selection[task]['selected']} & {f'{task}-{i}' for i in range(10)})
            self.assertEqual(audit['exclusionReports'][0]['sha256'], file_hash(report))
            self.assertEqual((jobs, selection, audit), fresh_jobs(root, original, 50, [report]))
            with self.assertRaisesRegex(ValueError, 'exclude-report'):
                fresh_jobs(root, original, 50, [])
            previous['checksums']['PQA_test.json'] = 'changed'
            report.write_text(json.dumps(previous))
            with self.assertRaisesRegex(ValueError, 'checksum differs'):
                fresh_jobs(root, original, 50, [report])
            (root / 'Data' / 'PQA_test.json').write_text('[]')
            with self.assertRaisesRegex(ValueError, 'checksum changed'):
                fresh_jobs(root, original, 50, [report])


if __name__ == '__main__':
    unittest.main()
