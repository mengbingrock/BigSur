import copy
import json
from pathlib import Path
import tempfile
import unittest
from compareReports import compare_report


class ComparisonTests(unittest.TestCase):
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
