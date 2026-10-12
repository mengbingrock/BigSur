import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from evidence import render_prompt
from prepareNoRag import prepare


class NoRagTests(unittest.TestCase):
    def test_retrieved_passages_are_rejected(self):
        with self.assertRaises(ValueError):
            render_prompt('question', {'variant': 'plain-no-rag', 'passages': [{'text': 'forbidden'}]})

    def test_preparation_and_actual_cli_input_are_question_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base, out = root/'base', root/'out'
            base.mkdir()
            sample = {'id': 'fixture', 'question': 'VISIBLE_QUESTION', 'answer': 'SECRET_GOLD'}
            manifest = {'primaryVariant': 'rag', 'selection': {'PQA': {'selected': [{'id': 'fixture'}]}},
                        'upstreamRevision': 'fixture', 'sourceAudit': {}, 'checksums': {},
                        'selectionSha256': 'fixture', 'model': 'fake'}
            (base/'manifest.json').write_text(json.dumps(manifest))
            (base/'jobs.json').write_text(json.dumps([{'task':'PQA', 'variant':'rag', 'sample':sample,
                'passages':[{'text':'SECRET_EVIDENCE'}], 'queryEmbeddingInputSha256':'old'}]))
            (base/'source-aliases.json').write_text('[]')
            self.assertEqual(prepare(base, out), 1)
            job = json.loads((out/'jobs.json').read_text())[0]
            self.assertEqual(job['sample'], sample)
            self.assertEqual(job['passages'], [])
            self.assertNotIn('queryEmbeddingInputSha256', job)
            with self.assertRaises(ValueError):
                prepare(base, out)
            (root/'Scripts').mkdir()
            (root/'Scripts/prompt_format.py').write_text('def generate_user_prompt(sample, task): return sample["question"]\n')
            evaluator = root/'skills/evaluate-protocol-outputs/scripts/evaluate.py'
            evaluator.parent.mkdir(parents=True)
            evaluator.write_text('import sys\nfrom pathlib import Path\nPath(sys.argv[sys.argv.index("--output")+1]).write_text("{}")\n')
            cli = root/'fake-cli'
            cli.write_text('#!'+sys.executable+'\nimport json,sys\nfrom pathlib import Path\n'
                'if "--version" in sys.argv: print("test")\nelse:\n'
                ' p=sys.stdin.read(); assert p=="VISIBLE_QUESTION"\n'
                ' assert sys.argv[sys.argv.index("--tools")+1]==""\n'
                ' assert "--no-session-persistence" in sys.argv\n'
                ' Path('+repr(str(root/'captured'))+').write_text(p)\n'
                ' print(json.dumps({"result":"A","modelUsage":{}}))\n')
            cli.chmod(0o755)
            command = [sys.executable,str(Path(__file__).with_name('run.py')), '--source',str(root),
                       '--out',str(out),'--live','--model','fake']
            subprocess.run(command,env={**os.environ,'CLAUDE_BIN':str(cli)},check=True,capture_output=True)
            response=json.loads((out/'responses/plain-no-rag-fixture.json').read_text())
            self.assertEqual(response['contextChars'], 0)
            self.assertEqual(response['serializedContextChars'], 0)
            self.assertEqual((root/'captured').read_text(), 'VISIBLE_QUESTION')
            (root/'captured').unlink()
            subprocess.run(command,env={**os.environ,'CLAUDE_BIN':str(cli)},check=True,capture_output=True)
            self.assertFalse((root/'captured').exists())
            self.assertEqual(json.loads((out/'summary.json').read_text())['newCalls'], 0)


if __name__ == '__main__':
    unittest.main()
