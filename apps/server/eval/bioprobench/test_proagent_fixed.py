"""Regression tests of the patched upstream source; no live model calls."""
import contextlib
import io
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest


SOURCE = os.environ.get('BIOPROAGENT_FIXED_SOURCE')


class FakeModel:
    def __init__(self, mode='revise'):
        self.mode, self.prompts = mode, []

    def invoke(self, prompt):
        from langchain_core.messages import AIMessage
        prompt = str(prompt)
        self.prompts.append(prompt)
        assert 'SECRET_GOLD' not in prompt
        assert 'ORIGINAL_QUESTION' in prompt
        assert 'FROZEN_EVIDENCE' in prompt
        if prompt.startswith('Generate the answer'):
            content = 'FIRST_ANSWER'
        elif prompt.startswith('You are a scientific protocol reviewer.'):
            if self.mode == 'error':
                raise RuntimeError('provider unavailable')
            if self.mode == 'empty':
                content = ''
            elif self.mode == 'pass' or ('REVISED_ANSWER' in prompt and self.mode == 'revise'):
                content = 'done'
            else:
                content = 'NOT PASS: correct the specific ordering error.'
        elif prompt.startswith('Revise the benchmark answer'):
            content = 'FIRST_ANSWER' if self.mode == 'unchanged' else 'REVISED_ANSWER' + str(len(self.prompts))
        else:
            raise AssertionError('Unexpected planner/intent call: ' + prompt[:80])
        return AIMessage(content=content)


@unittest.skipUnless(SOURCE, 'Set BIOPROAGENT_FIXED_SOURCE to the reviewed patched checkout')
class FixedSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, SOURCE)
        backend = types.ModuleType('src.core.llms')
        for name in ('fast_llm', 'general_llm', 'quality_llm', 'long_context_llm'):
            setattr(backend, name, FakeModel())
        backend.mem = types.SimpleNamespace(search=lambda *a, **k: {'results': []}, add=lambda *a, **k: None)
        sys.modules['src.core.llms'] = backend
        from src.capabilities.retrieval import knowledge_sources
        knowledge_sources.default_retriever = types.SimpleNamespace(invoke=lambda q: 'FROZEN_EVIDENCE')
        knowledge_sources.search_pubmed = lambda *a, **k: ''
        knowledge_sources.Protocol_search = lambda *a, **k: ''
        knowledge_sources.Web_search = lambda *a, **k: ''
        from main_evaluate import ProAgent
        from src.tools import tool_definitions
        from src.capabilities.verification import engine
        from src.core.planner_transfer_matrix import AgentState, PlannerContext, ExecutionRecord
        cls.ProAgent, cls.tools, cls.engine = ProAgent, tool_definitions, engine
        cls.AgentState, cls.Context, cls.Record = AgentState, PlannerContext, ExecutionRecord

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.old_cwd = Path.cwd()
        os.chdir(self.directory.name)
        self.silence = contextlib.redirect_stdout(io.StringIO())
        self.silence.__enter__()

    def tearDown(self):
        self.silence.__exit__(None, None, None)
        os.chdir(self.old_cwd)
        self.directory.cleanup()

    def agent(self, task='ORD', mode='revise'):
        model = FakeModel(mode)
        self.tools.quality_llm = self.engine.quality_llm = model
        agent = self.ProAgent(eval_mode=True, llm=model, planner_config={'benchmark_task': task})
        state = agent._create_session()
        return agent, state, model

    def test_all_tasks_use_actual_review_and_revision_tools(self):
        for task in ('PQA', 'ORD', 'ERR', 'GEN'):
            with self.subTest(task=task):
                agent, state, model = self.agent(task)
                result = agent.process_query('ORIGINAL_QUESTION', state)
                self.assertTrue(result.startswith('REVISED_ANSWER'))
                self.assertEqual(len(model.prompts), 4)
                self.assertEqual(state.mem_work['stop_reason'], 'draft_verified')
                self.assertEqual(state.state_history, ['DESIGN_DRAFT', 'RECTIFY_DRAFT'])
                self.assertTrue(all(r.status == 'success' for r in state.mem_episodic))
                self.assertEqual([r.tool for r in state.mem_episodic], [
                    'retrieve_knowledge', 'generate_scientific_draft', 'reflect_on_protocol',
                    'modify_protocol', 'reflect_on_protocol'])
                self.assertTrue(all('TaskType: '+task in p for p in model.prompts))

    def test_pass_needs_two_calls_and_no_revision(self):
        agent, state, model = self.agent(mode='pass')
        agent.process_query('ORIGINAL_QUESTION', state)
        self.assertEqual(len(model.prompts), 2)
        self.assertEqual(state.mem_work['stop_reason'], 'draft_verified')

    def test_unchanged_revision_stops_after_review(self):
        agent, state, model = self.agent(mode='unchanged')
        agent.process_query('ORIGINAL_QUESTION', state)
        self.assertEqual(len(model.prompts), 4)
        self.assertEqual(state.mem_work['stop_reason'], 'revision_unchanged')
        self.assertEqual(state.mem_work['ks_verification']['status'], 'fail')

    def test_two_revision_budget_is_six_calls(self):
        agent, state, model = self.agent(mode='always_fail')
        agent.process_query('ORIGINAL_QUESTION', state)
        self.assertEqual(len(model.prompts), 6)
        self.assertEqual(state.mem_work['stop_reason'], 'revision_budget_exhausted')
        self.assertEqual(state.mem_work['revision_count'], 2)

    def test_provider_and_empty_review_fail_closed_without_retry(self):
        for mode in ('error', 'empty'):
            agent, state, model = self.agent(mode=mode)
            with self.assertRaises(RuntimeError):
                agent.process_query('ORIGINAL_QUESTION', state)
            self.assertNotIn('ks_verification', state.mem_work)
            self.assertEqual(len(model.prompts), 2)
            self.assertEqual(state.mem_work['stop_reason'], 'tool_failure')

    def test_live_schema_exposed_and_missing_arguments_bound(self):
        agent, state, model = self.agent()
        self.assertIn('"required": ["query", "keywords", "session_id"]', agent.tools_description)
        state.mem_work['user_query'] = state.mem_work['exp_info'] = 'ORIGINAL_QUESTION'
        outputs = {}
        for i, name in enumerate(('retrieve_knowledge', 'generate_scientific_draft', 'reflect_on_protocol', 'modify_protocol')):
            record = agent._execute_step(i, {'tool_name': name, 'args': {}}, state, outputs)
            self.assertEqual(record.status, 'success', record.summary)
        blocked = agent._execute_step(4, {'tool_name': 'modify_protocol', 'args': {'protocol': '$missing'}}, state, {})
        self.assertEqual(blocked.status, 'blocked')

    def test_old_pass_invalidated_on_new_draft(self):
        agent, state, model = self.agent()
        agent._update_mem_work('generate_scientific_draft', 'old', state)
        agent._update_mem_work('reflect_on_protocol', {'status': 'pass'}, state)
        state.mem_episodic.append(self.Record('reflect_on_protocol', 'success', 'pass', {'status': 'pass'}))
        agent._update_mem_work('modify_protocol', 'new', state)
        ctx = self.Context('fixture', 'question', mem_work=state.mem_work, mem_episodic=state.mem_episodic)
        self.assertEqual(agent.planner._infer_state(ctx), self.AgentState.VERIFY_DRAFT)

    def test_changing_drafts_do_not_trigger_oscillation(self):
        agent, state, model = self.agent()
        for i in range(8):
            state.mem_work['draft'] = 'draft'+str(i)
            self.assertFalse(agent._detect_oscillation(state, self.AgentState.RECTIFY_DRAFT))
        self.assertFalse(agent._detect_oscillation(state, self.AgentState.RECTIFY_DRAFT))
        self.assertTrue(agent._detect_oscillation(state, self.AgentState.RECTIFY_DRAFT))

    def test_non_exact_pass_is_criticism(self):
        agent, state, model = self.agent(mode='always_fail')
        result = self.tools.reflect_on_protocol.invoke({'query': 'ORIGINAL_QUESTION', 'protocol_text': 'draft', 'task_type': 'ORD', 'knowledge': 'FROZEN_EVIDENCE'})
        self.assertEqual(result['status'], 'fail')


if __name__ == '__main__':
    unittest.main()
