"""Freeze a no-retrieval baseline using exactly the existing benchmark questions."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil

VARIANT = 'plain-no-rag'


def prepare(base, out):
    base, out = Path(base), Path(out)
    if out.exists() and any(out.iterdir()):
        raise ValueError('Preparation requires an empty directory; use run.py to resume')
    original = json.loads((base / 'manifest.json').read_text())
    raw = json.loads((base / 'jobs.json').read_text())
    raw = [j for j in raw if j['variant'] == original['primaryVariant']]
    identities = [(j['task'], j['sample']['id']) for j in raw]
    expected = {(t, s['id']) for t, group in original['selection'].items() for s in group['selected']}
    if len(identities) != len(set(identities)) or set(identities) != expected:
        raise ValueError('Source jobs must contain each selected case exactly once')
    jobs = [{'task': j['task'], 'sample': j['sample'], 'variant': VARIANT,
             'passages': [], 'contextProfile': 'none', 'retrievalMs': 0,
             'retrievalTimingScope': 'No retrieval performed'} for j in raw]
    manifest = {k: original[k] for k in ('upstreamRevision', 'sourceAudit', 'checksums',
                                        'selection', 'selectionSha256', 'model')}
    manifest.update(date=datetime.now(timezone.utc).isoformat(),
                    variants=[VARIANT], primaryVariant=VARIANT, indexFiles={VARIANT: []},
                    retrieval='None: official question prompt only',
                    scope='Single model call without retrieval, agent planning, reflection, or revision. Frozen development questions.',
                    contextPolicyVersion='plain-no-rag-v1',
                    questionContext='Keep context supplied by the official task itself; add no retrieved evidence or empty evidence header.',
                    sourceAuditScope='Inherited reference-corpus audit for paired comparison only; corpus and indexes are not used for inference.',
                    baselineManifestSha256=hashlib.sha256((base / 'manifest.json').read_bytes()).hexdigest(),
                    runnerSha256=hashlib.sha256(Path(__file__).with_name('run.py').read_bytes()).hexdigest(),
                    promptRendererSha256=hashlib.sha256(Path(__file__).with_name('evidence.py').read_bytes()).hexdigest(),
                    failurePolicy='Checkpoint provider failures without retries; paired reports exclude refusals in either arm, other failures remain zero.')
    out.mkdir(parents=True, exist_ok=True)
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    (out / 'jobs.json').write_text(json.dumps(jobs, ensure_ascii=False, indent=2))
    # Source identity metadata is used only by post-hoc coverage reporting.
    shutil.copyfile(base / 'source-aliases.json', out / 'source-aliases.json')
    return len(jobs)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base', required=True)
    p.add_argument('--out', required=True)
    a = p.parse_args()
    print(json.dumps({'prepared': prepare(a.base, a.out), 'variant': VARIANT}))


if __name__ == '__main__':
    main()
