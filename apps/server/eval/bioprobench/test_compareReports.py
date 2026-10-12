import copy
import json
from pathlib import Path
import tempfile
import unittest
from compareReports import compare_report, paired_nonrefusals


class ComparisonTests(unittest.TestCase):
    def test_union_of_refusals_excluded_but_other_failures_retained(self):
        refusal = 'provider biology safeguard refusal'
        def row(id_, score, error=None):
            return dict(id=id_, score=score, error=error)
        pairs = [(row('a', 1), row('a', 0)),
                 (row('b', 0, refusal), row('b', 1)),
                 (row('c', 1), row('c', 0, refusal)),
                 (row('d', 0, 'other'), row('d', 1))]
        result = paired_nonrefusals(pairs)
        self.assertEqual(result['includedIds'], ['a', 'd'])
        self.assertEqual(result['excludedEitherArmRefusal'], 2)
        self.assertEqual(result['pairedDelta'], 0)
        self.assertEqual((result['wins'], result['losses']), (1, 1))
        self.assertIsNone(paired_nonrefusals([])['pairedDelta'])

    def test_matches_ids_not_row_order_and_rejects_noncomparable_reports(self):
        common = dict(sourceAudit=[{'sha256': 'same'}], checksums={'PQA': 'same'}, model='same',
                      selection={'PQA': {'selected': [{'id': 'a'}, {'id': 'b'}]}})
        current = dict(common, variants=['paper-context'], cases=[
            dict(task='PQA', variant='paper-context', id='a', score=1),
            dict(task='PQA', variant='paper-context', id='b', score=0)])
        old = dict(common, variants=['flat'], cases=[
            dict(task='PQA', variant='flat', id='b', score=0),
            dict(task='PQA', variant='flat', id='a', score=0)])
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'report.json'
            file.write_text(json.dumps(old))
            result = compare_report(current, file)['tasks']['PQA']['flat']
            self.assertEqual((result['pairedDelta'], result['wins'], result['losses']), (0.5, 1, 0))
            hybrid = copy.deepcopy(current)
            hybrid['primaryVariant'] = 'paper-hybrid-nebius'
            hybrid['variants'] = ['paper-hybrid-nebius']
            for case in hybrid['cases']:
                case['variant'] = 'paper-hybrid-nebius'
            result = compare_report(hybrid, file)['tasks']['PQA']['flat']
            self.assertEqual((result['primaryScore'], result['baselineScore']), (0.5, 0))
            for field in common:
                changed = copy.deepcopy(current)
                changed[field] = None
                with self.assertRaisesRegex(ValueError, field):
                    compare_report(changed, file)
            changed = copy.deepcopy(current)
            changed['cases'].pop()
            with self.assertRaisesRegex(ValueError, 'Missing'):
                compare_report(changed, file)


if __name__ == '__main__':
    unittest.main()
