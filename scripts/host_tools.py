"""Small standard-library helpers for repository launchers."""
import os
from pathlib import Path
import platform
import shutil
import subprocess


def host_key(system=None, machine=None):
    system = (system or platform.system()).lower()
    machine = (machine or platform.machine()).lower()
    arch = {'amd64': 'x64', 'x86_64': 'x64', 'x64': 'x64',
            'aarch64': 'arm64', 'arm64': 'arm64'}.get(machine)
    if system not in ('windows', 'linux', 'darwin') or not arch:
        raise ValueError(f'Unsupported host: {system}/{machine}')
    return f'{system}-{arch}'


def executable(name):
    candidate = Path(name).expanduser()
    found = candidate if candidate.is_file() else shutil.which(str(name))
    if not found:
        raise FileNotFoundError(f'Cannot find {name!s}; install it or pass its executable path.')
    return Path(found).resolve()


def run(command, *, cwd, env=None, capture=False):
    argv = [str(arg) for arg in command]
    if os.name == 'nt' and Path(argv[0]).suffix.lower() in ('.cmd', '.bat', '.ps1'):
        raise ValueError(f'Use a native executable, not a Windows shell shim: {argv[0]}')
    return subprocess.run(argv, cwd=cwd, env=env, check=True, text=True,
                          encoding='utf-8', errors='replace', capture_output=capture)
