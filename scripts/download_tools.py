"""Verified ZIP downloads for local tools; standard library only."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import time
import urllib.request
import zipfile

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def extract_zip(archive, destination):
    """Reject absolute paths, traversal, Windows drive/ADS paths, and symlinks."""
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            path = PurePosixPath(info.filename.replace('\\', '/'))
            if (path.is_absolute() or '..' in path.parts or ':' in info.filename
                    or stat.S_IFMT(info.external_attr >> 16) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError(f'Unsafe archive member: {info.filename}')
        z.extractall(destination)
        if os.name != 'nt':
            for info in z.infolist():
                mode = (info.external_attr >> 16) & 0o777
                if info.create_system == 3 and mode:
                    (destination / info.filename).chmod(mode)


def install(name, spec, tools):
    archives = tools / 'archives'
    archives.mkdir(parents=True, exist_ok=True)
    archive = archives / spec['archive']
    if not archive.exists():
        partial = archive.with_suffix(archive.suffix + '.part')
        print(f'Downloading {name} {spec["version"]}', flush=True)
        try:
            req = urllib.request.Request(spec['url'], headers={'User-Agent': 'vscode-mentor-bootstrap/1'})
            with urllib.request.urlopen(req, timeout=90) as response, partial.open('wb') as output:
                shutil.copyfileobj(response, output)
            if digest(partial) != spec['sha256']:
                raise ValueError(f'{name}: SHA256 mismatch; downloaded archive rejected')
            partial.replace(archive)
        finally:
            partial.unlink(missing_ok=True)
    if digest(archive) != spec['sha256']:
        raise ValueError(f'{archive}: SHA256 mismatch; remove this corrupt archive and retry')
    destination = tools / name
    stamp = destination / '.mentor-tool.json'
    if stamp.exists() and json.loads(stamp.read_text()) == spec and (destination / spec['executable']).is_file():
        print(f'Ready: {destination / spec["executable"]}', flush=True)
        return destination / spec['executable']
    if destination.exists():
        raise ValueError(f'{destination} already exists with a different/incomplete install; move it aside first')
    with tempfile.TemporaryDirectory(prefix=f'.{name}-', dir=tools) as temp:
        staging = Path(temp) / 'payload'
        staging.mkdir()
        extract_zip(archive, staging)
        payload = staging / spec.get('strip_prefix', '')
        if not (payload / spec['executable']).is_file():
            raise ValueError(f'{name}: executable missing from archive')
        (payload / '.mentor-tool.json').write_text(json.dumps(spec, indent=2) + '\n')
        # Windows antivirus can briefly hold freshly extracted DLLs open.
        for attempt in range(6):
            try:
                payload.rename(destination)
                break
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(0.25 * (attempt + 1))
    print(f'Ready: {destination / spec["executable"]}', flush=True)
    return destination / spec['executable']
