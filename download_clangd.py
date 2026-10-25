"""Download the pinned native clangd archive using the stdlib tool installer."""
import json
from pathlib import Path
import sys

TOOL = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOL / 'scripts'))
from download_tools import install  # noqa: E402
from host_tools import host_key  # noqa: E402


def spec_for_host(system=None, machine=None):
    lock = json.loads((TOOL / 'clangd.lock.json').read_text(encoding='utf-8'))
    host = host_key(system, machine)
    artifact = lock['platforms'].get(host)
    if not artifact:
        raise ValueError(f'No pinned clangd archive for {host}. Install native clangd and '
                         'pass --clangd-path to editor.py setup.')
    return lock['artifacts'][artifact]


def download():
    return install('clangd', spec_for_host(), TOOL / '.local')

if __name__ == '__main__':
    try:
        download()
    except (OSError, ValueError) as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
