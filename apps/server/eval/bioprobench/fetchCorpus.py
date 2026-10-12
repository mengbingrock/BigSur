"""Download the pinned raw-source manifest, verify before replacing any file."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import urllib.request


def fetch(manifest, out):
    out.mkdir(parents=True, exist_ok=True)
    for source in manifest['sources']:
        name = source['file']
        if Path(name).name != name or not source['url'].startswith('https://'):
            raise ValueError(f'Invalid source: {name}')
        target = out / name
        digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
        if target.exists() and digest(target) == source['sha256']:
            print(f'Verified {name}', flush=True)
            continue
        temp = None
        try:
            with tempfile.NamedTemporaryFile(dir=out, delete=False) as stream:
                temp = Path(stream.name)
                with urllib.request.urlopen(source['url'], timeout=120) as response:
                    while chunk := response.read(1024 * 1024):
                        stream.write(chunk)
            if digest(temp) != source['sha256']:
                raise ValueError(f'Checksum mismatch: {name}')
            rows = json.loads(temp.read_text())
            if not isinstance(rows, list) or len(rows) != source['expectedRawRecords']:
                raise ValueError(f'Record count mismatch: {name}')
            temp.replace(target)
            print(f'Downloaded and verified {name}: {len(rows)} records', flush=True)
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=Path(__file__).with_name('sources.json'))
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    fetch(json.loads(args.manifest.read_text()), args.out)
