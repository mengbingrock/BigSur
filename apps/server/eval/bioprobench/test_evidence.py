import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from evidence import append_evidence


class EvidenceTests(unittest.TestCase):
    def test_unchanged_serialization_and_unicode_measurements(self):
        passages = [dict(title='Title', path='', heading='', text='🧪' * 5000, protocol_id='source:1') for _ in range(3)]
        prompt, sizes = append_evidence('question', passages)
        context = prompt.split('\n')[-1]
        self.assertGreater(sizes['serializedContextChars'], 15000)
        self.assertEqual(sizes['serializedContextChars'], len(context))
        self.assertEqual(sizes['serializedContextBytes'], len(context.encode()))
        self.assertEqual(json.loads(context), [{k: p[k] for k in ('title', 'path', 'heading', 'text')} for p in passages])

    def test_runner_sends_complete_context_to_cli_and_measures_it(self):
        # Offline fake CLI: capture stdin, never contact a model/provider.
        import os
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'Scripts').mkdir()
            (root / 'Scripts/prompt_format.py').write_text('def generate_user_prompt(sample, task): return "Question"\n')
            evaluator = root / 'skills/evaluate-protocol-outputs/scripts/evaluate.py'
            evaluator.parent.mkdir(parents=True)
            evaluator.write_text('import sys\nfrom pathlib import Path\nPath(sys.argv[sys.argv.index("--output")+1]).write_text("{}")\n')
            cli = root / 'fake-cli'
            cli.write_text('#!' + sys.executable + '\nimport json,sys\nfrom pathlib import Path\nif "--version" in sys.argv: print("offline-test")\nelse:\n Path(' + repr(str(root / 'captured')) + ').write_text(sys.stdin.read())\n print(json.dumps({"result":"A", "modelUsage":{}}))\n')
            cli.chmod(0o755)
            passages = [dict(title='Inert fixture', path='', heading='', text=str(i) + 'x' * 5000) for i in range(3)]
            job = dict(task='GEN', variant='paper-context', sample={'id': 'fixture'}, passages=passages, retrievalMs=1)
            (root / 'jobs.json').write_text(json.dumps([job]))
            subprocess.run([sys.executable, str(Path(__file__).with_name('run.py')), '--source', tmp, '--out', tmp, '--live', '--model', 'fake'], env={**os.environ, 'CLAUDE_BIN': str(cli)}, check=True, capture_output=True)
            expected, sizes = append_evidence('Question', passages)
            self.assertEqual((root / 'captured').read_text(), expected)
            response = json.loads((root / 'responses/paper-context-fixture.json').read_text())
            self.assertEqual(response['contextChars'], sizes['serializedContextChars'])
            self.assertGreater(response['contextChars'], 15000)


if __name__ == '__main__':
    unittest.main()
