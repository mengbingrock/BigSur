import unittest
from coverage import audit


class CoverageTest(unittest.TestCase):
    def test_subsection_and_ambiguous_titles_are_not_counted_as_absent(self):
        aliases = [
            {'protocolId': 'p1', 'title': 'Full protocol', 'nodeId': None, 'path': ''},
            {'protocolId': 'p1', 'title': 'Prepare reference', 'nodeId': 'section:1.2', 'path': '1.2'},
            {'protocolId': 'p2', 'title': 'Prepare reference', 'nodeId': 'section:5', 'path': '5'},
        ]
        questions = [{'id': str(i), 'question': f"Please sort the following steps titled '{t}' in the correct order."}
                     for i, t in enumerate(['FULL protocol', 'Prepare reference', 'Unknown title'])]
        result = audit(questions, aliases)
        self.assertEqual((result['matched'], result['rootMatches'], result['sectionOnlyMatches'], result['unresolved']), (2, 1, 1, 1))
        self.assertTrue(result['cases']['1']['ambiguous'])
        self.assertEqual(result['cases']['1']['protocolIds'], ['p1', 'p2'])
        self.assertIsNone(result['cases']['2']['sourceAvailable'])


if __name__ == '__main__':
    unittest.main()
