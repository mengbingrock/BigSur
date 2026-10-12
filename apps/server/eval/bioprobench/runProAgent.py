"""Run the cloned upstream BioProAgent, with model/retrieval transport adapters.

No copied or rewritten planner, reflection, revision, or state-machine code.
The upstream repository is an explicit input and remains unmodified.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import types

from evidence import append_evidence

VARIANT = 'upstream-proagent'
PIN = 'e18586ab4a2a851433bedc0e6940b77470355fd6'
SYSTEM = ('Answer the benchmark question using the provided evidence when applicable. '
          'Follow the requested answer format. Do not use external tools.')


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    temp.replace(path)


class ProviderStop(BaseException):
    """Stop a refused trial, including upstream catch-all/fallback paths."""


class EmptyMemory:
    def search(self, *args, **kwargs):
        return {'results': []}

    def add(self, *args, **kwargs):
        return None


class CLIModel:
    def __init__(self, model, directory):
        self.model, self.directory = model, directory
        self.calls = []

    def invoke(self, prompt):
        if hasattr(prompt, 'to_string'):
            prompt = prompt.to_string()
        prompt = str(prompt)
        number = len(self.calls)
        path = self.directory / f'call-{number:03d}.json'
        key = digest(SYSTEM + '\n' + self.model + '\n' + prompt)
        if path.exists():
            call = json.loads(path.read_text())
            if call['requestSha256'] != key:
                raise RuntimeError('Stale upstream call checkpoint; use a new output directory')
        else:
            started = time.monotonic()
            call = {'requestSha256': key, 'prompt': prompt, 'model': self.model}
            try:
                child = subprocess.run(
                    [os.environ.get('CLAUDE_BIN', 'claude'), '-p', '--system-prompt', SYSTEM,
                     '--model', self.model, '--tools', '', '--output-format', 'json',
                     '--no-session-persistence'], input=prompt, capture_output=True,
                    text=True, timeout=180, cwd='/private/tmp')
                output = json.loads(child.stdout)
                call['modelUsage'] = output.get('modelUsage', {})
                call['content'] = output.get('result', '').strip()
                if child.returncode or output.get('is_error'):
                    call['error'] = output.get('result', 'CLI error')
            except Exception as exc:
                call['error'] = str(exc)
                call['content'] = ''
            call['elapsedMs'] = round((time.monotonic() - started) * 1000)
            write_json(path, call)
        self.calls.append(call)
        if call.get('error'):
            # The upstream reflector converts Exception into 'done'. Never let a
            # provider failure silently pass verification or retry a refusal.
            raise ProviderStop(call['error'])
        from langchain_core.messages import AIMessage
        return AIMessage(content=call['content'])


def aggregate_usage(calls):
    result = {}
    for call in calls:
        for model, usage in call.get('modelUsage', {}).items():
            target = result.setdefault(model, {})
            for key, value in usage.items():
                if isinstance(value, (int, float)):
                    if key in ('contextWindow', 'maxOutputTokens'):
                        target[key] = max(target.get(key, 0), value)
                    else:
                        target[key] = target.get(key, 0) + value
    return result


def run_one(args, job):
    root = Path(args.out).resolve()
    directory = root / 'traces' / job['sample']['id']
    directory.mkdir(parents=True, exist_ok=True)
    # Backend injection precedes importing upstream, avoiding unused OpenAI and
    # Mem0 initialization. Every role invokes the same authenticated Opus CLI.
    llm = CLIModel(args.model, directory)
    backend = types.ModuleType('src.core.llms')
    for name in ('fast_llm', 'general_llm', 'quality_llm', 'long_context_llm'):
        setattr(backend, name, llm)
    backend.mem = EmptyMemory()
    sys.modules['src.core.llms'] = backend
    sys.path.insert(0, str(Path(args.agent_source).resolve()))

    from src.capabilities.retrieval import knowledge_sources
    evidence, sizes = append_evidence('', job['passages'])
    retrieval_calls = []

    class FrozenRetriever:
        def invoke(self, query):
            retrieval_calls.append({'querySha256': digest(query), 'evidenceSha256': digest(evidence)})
            return evidence

    knowledge_sources.default_retriever = FrozenRetriever()
    # These upstream connectors are placeholders. Only the fixed local corpus
    # is available in this controlled experiment.
    knowledge_sources.search_pubmed = lambda *a, **k: ''
    knowledge_sources.Protocol_search = lambda *a, **k: ''
    knowledge_sources.Web_search = lambda *a, **k: ''
    from main_evaluate import ProAgent
    from src.tools import tool_definitions

    # Native confirmation gate: the benchmark requests a text answer only.
    tool_definitions.ask_user_confirmation.func = lambda question: 'User_Confirmed: NO'
    # Unexpected clarification cannot invent user-provided experimental facts.
    def unavailable_input(*a, **k):
        raise RuntimeError('No interactive user answers are available in this benchmark')
    import builtins
    builtins.input = unavailable_input

    spec = importlib.util.spec_from_file_location('official_prompts', Path(args.source) / 'Scripts/prompt_format.py')
    prompts = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(prompts)
    query = prompts.generate_user_prompt(job['sample'], job['task'])
    result = {**job, **sizes, 'contextChars': sizes['serializedContextChars'],
              'model': args.model, 'promptSha256': digest(query), 'generated_response': ''}
    started = time.monotonic()
    agent = ProAgent(eval_mode=True, llm=llm,
                     planner_config={'require_confirmation_before_code': True})
    state = agent._create_session()
    state.session_id = 'benchmark-' + job['sample']['id']
    state.global_exp_context = query
    state.mem_work['exp_info'] = query
    # The full official prompt contains question fields only; references remain
    # in the scorer, never in upstream working memory or any model request.
    raw_final = ''
    try:
        raw_final = agent.process_query(query, state)
        # Upstream's UI final response truncates drafts to 2,000 characters.
        # Score the actual full final artifact, without an extra model call.
        result['generated_response'] = state.mem_work.get('draft') or raw_final
    except ProviderStop as exc:
        result['error'] = str(exc)
    except Exception as exc:
        result['error'] = str(exc)
    result['elapsedMs'] = round((time.monotonic() - started) * 1000)
    result['modelUsage'] = aggregate_usage(llm.calls)
    records = [{'tool': r.tool, 'status': r.status, 'output': r.output, 'summary': r.summary}
               for r in state.mem_episodic]
    trace = {'rawFinalResponse': raw_final, 'states': state.state_history,
             'records': records, 'retrievalCalls': retrieval_calls,
             'verification': state.mem_work.get('ks_verification'),
             'fullFinalDraft': state.mem_work.get('draft'), 'calls': len(llm.calls)}
    write_json(directory / 'trace.json', trace)
    result['agentAudit'] = {
        'upstreamRevision': PIN, 'modelCalls': len(llm.calls), 'states': state.state_history,
        'toolCounts': {t: sum(r['tool'] == t for r in records) for t in sorted({r['tool'] for r in records})},
        'toolFailures': sum(r['status'] != 'success' for r in records),
        'retrievalCalls': len(retrieval_calls), 'evidenceSha256': digest(evidence),
        'verificationStatus': (state.mem_work.get('ks_verification') or {}).get('status'),
        'draftChars': len(state.mem_work.get('draft') or ''),
        'outputSource': 'full working-memory draft' if state.mem_work.get('draft') else 'agent final response',
    }
    write_json(root / 'responses' / f'{VARIANT}-{job["sample"]["id"]}.json', result)


def prepare(args):
    root, base = Path(args.out).resolve(), Path(args.base).resolve()
    revision = subprocess.check_output(['git', '-C', args.agent_source, 'rev-parse', 'HEAD'], text=True).strip()
    if revision != PIN or subprocess.check_output(['git', '-C', args.agent_source, 'diff', 'HEAD'], text=True):
        raise ValueError('Use the pinned, unmodified upstream source')
    original = json.loads((base / 'manifest.json').read_text())
    jobs = json.loads((base / 'jobs.json').read_text())
    jobs = [{**j, 'variant': VARIANT} for j in jobs]
    if args.limit:
        jobs = [next(j for j in jobs if j['task'] == task) for task in ('PQA', 'ORD', 'ERR', 'GEN')]
    config = {'source': 'https://github.com/YuyangSunshine/bioproagent', 'revision': PIN,
              'runnerSha256': digest(Path(__file__).read_text()), 'model': args.model,
              'retrievalMode': 'Frozen per-question passages from existing Qwen/FAISS/BM25 retrieval; planner query cannot change evidence',
              'roles': 'All upstream roles use the same CLI model and system prompt as baseline',
              'stopping': 'Native confirmation gate; decline code generation; native 8-loop limit',
              'output': 'Full final draft in working memory, avoiding UI truncation',
              'memory': 'Isolated fresh session; empty long-term memory',
              'failurePolicy': 'Stop trial at any provider failure; no retry or fallback-to-pass'}
    manifest = {**original, 'model': args.model, 'variants': [VARIANT], 'primaryVariant': VARIANT,
                'indexFiles': {VARIANT: original['indexFiles'][original['primaryVariant']]},
                'agentIntegration': config, 'scope': 'Upstream BioProAgent applied to BioProBench tasks with fixed retrieved evidence.'}
    if args.limit:
        manifest['selection'] = {t: {**v, 'selected': [s for s in v['selected'] if any(j['sample']['id'] == s['id'] for j in jobs)]}
                                 for t, v in original['selection'].items()}
    if (root / 'manifest.json').exists():
        if json.loads((root / 'manifest.json').read_text()) != manifest or json.loads((root / 'jobs.json').read_text()) != jobs:
            raise ValueError('Changed run configuration; use a new output directory')
    else:
        root.mkdir(parents=True, exist_ok=True)
        write_json(root / 'manifest.json', manifest)
        write_json(root / 'jobs.json', jobs)
        shutil.copyfile(base / 'source-aliases.json', root / 'source-aliases.json')
    return root, jobs


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('agent-source', 'source', 'base', 'out'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--model', default='claude-opus-5-5')
    p.add_argument('--workers', type=int, default=4)
    p.add_argument('--limit', action='store_true', help='Integration smoke test: first selected case of each task')
    p.add_argument('--job', type=int, help=argparse.SUPPRESS)
    p.add_argument('--live', action='store_true')
    args = p.parse_args()
    if not args.live:
        p.error('--live is required')
    if args.job is not None:
        jobs = json.loads((Path(args.out) / 'jobs.json').read_text())
        run_one(args, jobs[args.job])
        return
    root, jobs = prepare(args)
    def run(index):
        job = jobs[index]
        response = root / 'responses' / f'{VARIANT}-{job["sample"]["id"]}.json'
        if response.exists():
            return json.loads(response.read_text())
        cmd = [sys.executable, str(Path(__file__).resolve()), '--agent-source', str(Path(args.agent_source).resolve()),
               '--source', str(Path(args.source).resolve()), '--base', str(Path(args.base).resolve()),
               '--out', str(root), '--model', args.model, '--job', str(index), '--live']
        directory = root / 'traces' / job['sample']['id']
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / 'upstream.log').open('w') as log:
            child = subprocess.run(cmd, cwd=directory, stdout=log, stderr=subprocess.STDOUT)
        if child.returncode or not response.exists():
            raise RuntimeError(f'Worker failed: {job["sample"]["id"]}; inspect local upstream.log')
        result = json.loads(response.read_text())
        print(json.dumps({'id': job['sample']['id'], 'task': job['task'],
                          'calls': result['agentAudit']['modelCalls'],
                          'tools': result['agentAudit']['toolCounts'],
                          'failed': bool(result.get('error'))}), flush=True)
        return result
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(run, range(len(jobs))))
    summary = {'model': args.model, 'totalPredictions': len(results),
               'callFailures': sum(bool(r.get('error')) for r in results), 'metrics': {VARIANT: {}}}
    for task in sorted({j['task'] for j in jobs}):
        path = root / f'{VARIANT}-{task}.json'
        write_json(path, [{**r['sample'], 'generated_response': r['generated_response']} for r in results if r['task'] == task])
        output = root / f'{VARIANT}-{task}-metrics.json'
        subprocess.run([sys.executable, str(Path(args.source) / 'skills/evaluate-protocol-outputs/scripts/evaluate.py'),
                        '--task', task, '--input', str(path), '--output', str(output),
                        '--errors', str(root / f'{VARIANT}-{task}-errors.jsonl')], check=True, capture_output=True)
        summary['metrics'][VARIANT][task] = json.loads(output.read_text())
    write_json(root / 'summary.json', summary)
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
