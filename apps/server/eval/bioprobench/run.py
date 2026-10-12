"""Run isolated, resumable BioProBench predictions through an authenticated CLI.
The model sees only official question fields and retrieved corpus passages.
"""
import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time
from evidence import render_prompt

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--workers', type=int, default=4)
parser.add_argument('--model', default='haiku')
parser.add_argument('--live', action='store_true')
args = parser.parse_args()
if not args.live:
    parser.error('--live is required to call the model')
root = Path(args.out).resolve()
responses = root / 'responses'
responses.mkdir(exist_ok=True)
spec = importlib.util.spec_from_file_location('official_prompts', Path(args.source) / 'Scripts/prompt_format.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
jobs = json.loads((root / 'jobs.json').read_text())
# Interleave variants and questions by a fixed order; independent fresh sessions.
jobs.sort(key=lambda job: hashlib.sha256(f"run-v1:{job['sample']['id']}:{job['variant']}".encode()).hexdigest())

def run(job):
    file = responses / f"{job['variant']}-{job['sample']['id']}.json"
    prompt = module.generate_user_prompt(job['sample'], job['task'])
    prompt, context_measurements = render_prompt(prompt, job)
    prompt_hash = hashlib.sha256(prompt.encode()).hexdigest()
    if file.exists():
        saved = json.loads(file.read_text())
        if saved['model'] != args.model or saved['promptSha256'] != prompt_hash:
            raise ValueError(f'Stale checkpoint: {file}; use a new output directory')
        # Keep refusals/failures in the evaluation; resuming must not retry
        # until a favorable answer appears.
        return {**saved, '_reused': True}
    started = time.monotonic()
    result = {**job, **context_measurements, 'model': args.model, 'promptSha256': hashlib.sha256(prompt.encode()).hexdigest()}
    if job['variant'] in ('paper-context', 'paper-hybrid-nebius', 'plain-no-rag'):
        result['contextChars'] = context_measurements['serializedContextChars']
    try:
        child = subprocess.run([os.environ.get('CLAUDE_BIN', 'claude'), '-p', '--system-prompt', 'Answer the benchmark question using the provided evidence when applicable. Follow the requested answer format. Do not use external tools.', '--model', args.model, '--tools', '', '--output-format', 'json', '--no-session-persistence'], input=prompt, capture_output=True, text=True, timeout=180, cwd='/private/tmp')
        try:
            output = json.loads(child.stdout)
        except ValueError:
            raise RuntimeError((child.stderr or child.stdout or str(child.returncode))[-1500:])
        result['modelUsage'] = output.get('modelUsage', {})
        if child.returncode or output.get('is_error'):
            raise RuntimeError(output.get('result', 'CLI error'))
        result['generated_response'] = output.get('result', '').strip()
    except Exception as exc:
        result['error'] = str(exc)
        result['generated_response'] = ''
    result['elapsedMs'] = round((time.monotonic() - started) * 1000)
    temp = file.with_suffix('.tmp')
    temp.write_text(json.dumps(result, ensure_ascii=False))
    temp.replace(file)
    print(json.dumps({'id': job['sample']['id'], 'variant': job['variant'], 'elapsedMs': result['elapsedMs'], 'error': result.get('error')}), flush=True)
    return result

with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
    results = list(pool.map(run, jobs))
for variant in sorted({job['variant'] for job in jobs}):
    for task in sorted({job['task'] for job in jobs}):
        selected = [r for r in results if r['variant'] == variant and r['task'] == task]
        # Preserve official fields for the official evaluator; transport errors
        # become failed parses and are also reported separately.
        rows = [{**r['sample'], 'generated_response': r['generated_response']} for r in selected]
        file = root / f'{variant}-{task}.json'
        file.write_text(json.dumps(rows, ensure_ascii=False))
        subprocess.run(['python3', str(Path(args.source) / 'skills/evaluate-protocol-outputs/scripts/evaluate.py'), '--task', task, '--input', str(file), '--output', str(root / f'{variant}-{task}-metrics.json'), '--errors', str(root / f'{variant}-{task}-errors.jsonl')], check=True)
summary = {'model': args.model, 'cliVersion': subprocess.run([os.environ.get('CLAUDE_BIN', 'claude'), '--version'], capture_output=True, text=True).stdout.strip(), 'totalPredictions': len(results), 'newCalls': sum(not r.get('_reused') for r in results), 'reusedPredictions': sum(bool(r.get('_reused')) for r in results), 'callFailures': sum(bool(r.get('error')) for r in results), 'metrics': {}}
for variant in sorted({job['variant'] for job in jobs}):
    summary['metrics'][variant] = {task: json.loads((root / f'{variant}-{task}-metrics.json').read_text()) for task in sorted({job['task'] for job in jobs})}
(root / 'summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary))
