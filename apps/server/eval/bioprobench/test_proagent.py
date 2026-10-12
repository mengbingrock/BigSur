"""Offline integration checks against the real, pinned upstream control loop."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class UpstreamTests(unittest.TestCase):
    def run_fixture(self, refuse=False, patched=False):
        source_variable = 'BIOPROAGENT_FIXED_SOURCE' if patched else 'BIOPROAGENT_SOURCE'
        upstream = os.environ.get(source_variable)
        if not upstream:
            self.skipTest(f'Set {source_variable} to the selected source checkout')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'Scripts').mkdir()
            (root / 'Scripts/prompt_format.py').write_text(
                'def generate_user_prompt(sample, task): return sample["input"]\n')
            sample = {'id': 'fixture', 'input': 'Order the inert fixture steps.',
                      'output': 'HIDDEN_REFERENCE_NEVER_SEND', 'type': 'easy'}
            variant = 'patched-proagent' if patched else 'upstream-proagent'
            job = {'task': 'GEN', 'variant': variant, 'sample': sample,
                   'passages': [{'title': 'fixture', 'path': '', 'heading': '', 'text': 'FROZEN_EVIDENCE'}],
                   'retrievalMs': 1}
            (root / 'jobs.json').write_text(json.dumps([job]))
            cli = root / 'fake-cli'
            cli.write_text('''#!''' + sys.executable + '''
import json, os, sys
p = sys.stdin.read()
if 'Type of intent' in p:
    answer = '[TASK]'
elif 'Output Format Requirements' in p:
    if 'Current State: DESIGN_DRAFT' in p:
        answer = json.dumps([
          {'tool_name':'retrieve_knowledge','args':{'query':'fixture','keywords':'fixture'}},
          {'tool_name':'generate_scientific_draft','args':{'query':'fixture','exp_info':'$exp_info','knowledge':'$step_0'}}])
    elif 'Current State: RECTIFY_DRAFT' in p:
        answer = json.dumps([
          {'tool_name':'modify_protocol','args':{'protocol':'$draft','request':'$ks_verification'}},
          {'tool_name':'reflect_on_protocol','args':{'query':'fixture','protocol_text':'$step_0'}}])
    elif 'ks_verification, {' in p and "'status': 'pass'" in p:
        answer = json.dumps([{'tool_name':'ask_user_confirmation','args':{'question':'Continue to code?'}}])
    else:
        answer = json.dumps([{'tool_name':'reflect_on_protocol','args':{'query':'fixture','protocol_text':'$draft'}}])
elif 'scientific protocol reviewer' in p:
    if os.environ.get('FIXTURE_REFUSE'):
        print(json.dumps({'result':'[bio] fixture refusal','is_error':True})); sys.exit(1)
    answer = 'done' if 'REVISED_FIXTURE' in p else 'Revision needed: reorder the fixture sequence.'
elif 'Revise the protocol text' in p or 'Revise the benchmark answer' in p:
    answer = 'REVISED_FIXTURE' + 'x' * 6000
else:
    assert 'FROZEN_EVIDENCE' in p
    answer = 'FIRST_FIXTURE'
assert 'HIDDEN_REFERENCE_NEVER_SEND' not in p
print(json.dumps({'result':answer,'modelUsage':{'fake':{'inputTokens':10,'outputTokens':5}}}))
''')
            cli.chmod(0o755)
            env = {**os.environ, 'CLAUDE_BIN': str(cli)}
            if refuse:
                env['FIXTURE_REFUSE'] = '1'
            subprocess.run([sys.executable, str(Path(__file__).with_name('runProAgent.py')),
                            '--agent-source', upstream, '--source', tmp, '--base', tmp,
                            '--out', tmp, '--model', 'fake', '--job', '0', '--live'] + (['--patched'] if patched else []),
                           cwd=tmp, env=env, capture_output=True, check=True)
            result = json.loads((root / f'responses/{variant}-fixture.json').read_text())
            trace = json.loads((root / 'traces/fixture/trace.json').read_text())
            return result, trace

    def test_native_planning_reflection_revision_and_full_artifact(self):
        result, trace = self.run_fixture()
        self.assertNotIn('error', result)
        self.assertIn('RECTIFY_DRAFT', trace['states'])
        self.assertEqual(result['agentAudit']['toolCounts']['modify_protocol'], 1)
        self.assertEqual(result['agentAudit']['verificationStatus'], 'pass')
        self.assertEqual(result['agentAudit']['retrievalCalls'], 1)
        self.assertGreater(len(result['generated_response']), 6000)
        self.assertNotIn('generate_machine_code', result['agentAudit']['toolCounts'])

    def test_reflector_provider_failure_cannot_become_pass(self):
        result, trace = self.run_fixture(refuse=True)
        self.assertIn('[bio]', result['error'])
        self.assertEqual(result['generated_response'], '')
        self.assertIsNone(trace['verification'])
        self.assertNotIn('RECTIFY_DRAFT', trace['states'])

    def test_patched_runner_full_artifact_without_gold_or_planner_calls(self):
        result, trace = self.run_fixture(patched=True)
        self.assertNotIn('error', result)
        self.assertEqual(trace['calls'], 4)
        self.assertEqual(trace['stopReason'], 'draft_verified')
        self.assertEqual(result['agentAudit']['retrievalCalls'], 1)
        self.assertEqual(result['agentAudit']['toolCounts']['modify_protocol'], 1)
        self.assertGreater(len(result['generated_response']), 6000)

    def test_patched_runner_stops_at_refusal_without_retry(self):
        result, trace = self.run_fixture(refuse=True, patched=True)
        self.assertIn('[bio]', result['error'])
        self.assertEqual(result['generated_response'], '')
        self.assertIsNone(trace['verification'])
        self.assertEqual(trace['calls'], 2)


if __name__ == '__main__':
    unittest.main()
