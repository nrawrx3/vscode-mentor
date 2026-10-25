"""Isolated Mentor editor. Python 3.11+ standard library; Node/npm and VS Code installed separately."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys

TOOL = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOL / 'scripts'))
from host_tools import executable, run  # noqa: E402
from download_clangd import download, spec_for_host  # noqa: E402

STATE = TOOL / '.local'
SETTINGS = STATE / 'user-data/User/settings.json'
CLANGD_EXTENSION = 'llvm-vs-code-extensions.vscode-clangd@0.1.33'
EXPECTED_EXTENSIONS = {'llvm-vs-code-extensions.vscode-clangd', 'nrawrx3.vscode-mentor'}


def workspace_path(value):
    workspace = Path(value).expanduser().resolve()
    if not workspace.is_dir():
        raise ValueError(f'Workspace must be an existing directory: {workspace}')
    return workspace


def profile_for_workspace(workspace):
    identity = os.path.normcase(str(workspace.resolve()))
    key = hashlib.sha256(identity.encode('utf-8')).hexdigest()[:16]
    return STATE / 'workspaces' / key / 'user-data'


def read_runtime():
    path = STATE / 'runtime.json'
    if not path.is_file():
        raise FileNotFoundError('Run editor.py setup first.')
    return json.loads(path.read_text(encoding='utf-8'))


def windows_code_cli(shim):
    # Resolve the installed shim's static paths, including VS Code's versioned resource directory.
    # Never execute a batch file or interpolate user arguments into shell command text.
    paths = [shim.parent / value.replace('\\', '/')
             for value in re.findall(r'"%~dp0([^"\r\n]+)"', shim.read_text(encoding='utf-8-sig'))
             if '%' not in value]
    executables = [p.resolve() for p in paths if p.suffix.lower() == '.exe' and p.is_file()]
    scripts = [p.resolve() for p in paths if p.name == 'cli.js' and p.is_file()]
    if len(executables) != 1 or len(scripts) != 1:
        raise ValueError(f'Cannot resolve VS Code CLI paths from {shim}. Pass --code-path to its code command.')
    return [executables[0], scripts[0]]


def reject_portable(path, env):
    if env.get('VSCODE_PORTABLE'):
        raise ValueError('VSCODE_PORTABLE overrides isolation. Unset it for this launcher.')
    directories = {path.parent / 'data'}
    if path.parent.name == 'bin':
        directories.add(path.parent.parent / 'data')
    for parent in path.parents:
        if parent.suffix == '.app':
            directories.update(parent.parent / name for name in ('code-portable-data', 'code-insiders-portable-data'))
    if any(directory.exists() for directory in directories):
        raise ValueError('VS Code portable data overrides isolation. Use an installation without portable data.')


def code_command(name=None, *, system=None):
    system = system or platform.system()
    if name and Path(name).suffix == '.app':
        name = str(Path(name).expanduser() / 'Contents/Resources/app/bin/code')
    try:
        path = executable(name or 'code')
    except FileNotFoundError:
        if name or system != 'Darwin':
            raise
        candidates = [base / 'Visual Studio Code.app/Contents/Resources/app/bin/code'
                      for base in (Path('/Applications'), Path.home() / 'Applications')]
        path = next((p for p in candidates if p.is_file()), None)
        if path is None:
            raise FileNotFoundError('Install VS Code or pass --code-path to its .app or code command.') from None
    env = os.environ.copy()
    reject_portable(path, env)
    env.pop('VSCODE_DEV', None)
    env.pop('VSCODE_IPC_HOOK_CLI', None)
    env.pop('ELECTRON_RUN_AS_NODE', None)
    if system == 'Windows':
        if path.suffix.lower() == '.cmd':
            command = windows_code_cli(path)
        elif path.suffix.lower() == '.exe':
            shim = path.parent / 'bin/code.cmd'
            command = windows_code_cli(shim) if shim.is_file() else [path, path.parent / 'resources/app/out/cli.js']
            if command[0] != path or not command[1].is_file():
                raise ValueError('Cannot locate this VS Code executable\'s CLI. Pass --code-path to code.cmd.')
        else:
            raise ValueError('Pass --code-path to code.cmd or Code.exe on Windows.')
        reject_portable(command[0], env)
        env['ELECTRON_RUN_AS_NODE'] = '1'
        return command, env
    return [path], env


def npm_command():
    npm = executable('npm.cmd' if os.name == 'nt' else 'npm')
    if os.name != 'nt':
        return [npm]
    cli = npm.parent / 'node_modules/npm/bin/npm-cli.js'
    if not cli.is_file():
        raise ValueError(f'Cannot locate npm-cli.js beside {npm}; install Node.js with npm.')
    node = npm.parent / 'node.exe'
    return [node if node.is_file() else executable('node'), cli]


def codex_binary(node_platform, node_arch, *, tool=TOOL):
    targets = {
        ('win32', 'x64'): 'x86_64-pc-windows-msvc', ('win32', 'arm64'): 'aarch64-pc-windows-msvc',
        ('linux', 'x64'): 'x86_64-unknown-linux-musl', ('linux', 'arm64'): 'aarch64-unknown-linux-musl',
        ('darwin', 'x64'): 'x86_64-apple-darwin', ('darwin', 'arm64'): 'aarch64-apple-darwin',
    }
    target = targets.get((node_platform, node_arch))
    if not target:
        raise ValueError(f'Codex runtime unsupported on {node_platform}/{node_arch}.')
    package = f'codex-{node_platform}-{node_arch}'
    filename = 'codex.exe' if node_platform == 'win32' else 'codex'
    for base in (tool / 'node_modules/@openai', tool / 'node_modules/@openai/codex/node_modules/@openai'):
        candidate = base / package / 'vendor' / target / 'bin' / filename
        if candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError('Pinned Codex runtime missing. Run editor.py setup with npm optional dependencies enabled.')


def resolve_codex(override=None):
    if override:
        path = executable(override)
        if path.suffix.lower() in ('.cmd', '.bat', '.ps1'):
            raise ValueError('--codex-path must point to the native executable, not a Windows shell shim.')
        return path
    # npm selects its native package using Node's architecture, which can differ under Rosetta.
    result = run([executable('node'), '-p', 'JSON.stringify([process.platform,process.arch])'], cwd=TOOL, capture=True)
    return codex_binary(*json.loads(result.stdout))


def initialize_codex(directory, source_home):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != 'nt':
        directory.chmod(0o700)
    config = directory / 'config.toml'
    if not config.exists():
        config.write_text('cli_auth_credentials_store = "file"\nweb_search = "disabled"\n'
                          '[features]\nmulti_agent = false\napps = false\n[analytics]\nenabled = false\n', encoding='utf-8')
    source, target = source_home / 'auth.json', directory / 'auth.json'
    if target.exists():
        return True
    if source.is_file():
        try:
            os.link(source, target)
            return True
        except OSError:
            pass
    return False


def read_settings():
    if not SETTINGS.is_file():
        raise FileNotFoundError('Run editor.py setup first.')
    return json.loads(SETTINGS.read_text(encoding='utf-8-sig'))


def write_settings(codex, clangd, build_dir, workspace):
    settings = read_settings() if SETTINGS.exists() else {
        'workbench.startupEditor': 'none', 'workbench.activityBar.location': 'hidden',
        'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.editor.showTabs': 'single',
        'workbench.tips.enabled': False, 'window.commandCenter': False, 'editor.minimap.enabled': False,
        'editor.inlineSuggest.enabled': True, 'editor.inlineSuggest.showToolbar': 'never',
        'editor.stickyScroll.enabled': False, 'editor.fontSize': 15, 'breadcrumbs.enabled': False,
        'extensions.ignoreRecommendations': True, 'extensions.autoUpdate': False,
        'extensions.autoCheckUpdates': False, 'telemetry.telemetryLevel': 'off', 'chat.disableAIFeatures': True,
        'clangd.checkUpdates': False, 'clangd.fallbackFlags': ['-std=c++20'], 'mentor.minimalLayout': True,
    }
    settings.update({'clangd.path': str(clangd), 'mentor.codexPath': str(codex),
                     'mentor.codexHome': str(STATE / 'codex')})
    if build_dir is not None or 'clangd.arguments' not in settings:
        build = (workspace / (build_dir or 'build')).resolve()
        settings['clangd.arguments'] = ['--background-index', f'--compile-commands-dir={build}']
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps(settings, indent=2) + '\n', encoding='utf-8')


def main():
    global SETTINGS
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', default='open', choices=['setup', 'open', 'check', 'test', 'login'])
    parser.add_argument('--code-path')
    parser.add_argument('--codex-path')
    parser.add_argument('--clangd-path')
    parser.add_argument('--build-dir')
    parser.add_argument('--workspace', default=os.getcwd(), help='Project folder; defaults to the current directory')
    parser.add_argument('--no-launch', action='store_true')
    args = parser.parse_args()
    if args.action == 'login':
        runtime = read_runtime()
        codex = resolve_codex(args.codex_path or runtime['codexPath'])
        run([codex, 'login'], cwd=TOOL, env={**os.environ, 'CODEX_HOME': str(STATE / 'codex')})
        return
    workspace = workspace_path(args.workspace)
    user_data = profile_for_workspace(workspace)
    SETTINGS = user_data / 'User/settings.json'
    code, code_env = code_command(args.code_path)
    isolation = ['--user-data-dir', user_data, '--extensions-dir', STATE / 'extensions', '--sync', 'off']

    def vscode(arguments, *, capture=False):
        return run([*code, *arguments], cwd=TOOL, env=code_env, capture=capture)

    def check_extensions():
        result = vscode([*isolation, '--list-extensions', '--show-versions'], capture=True)
        installed = {line.strip().split('@')[0].lower() for line in result.stdout.splitlines()
                     if re.fullmatch(r'[\w-]+\.[\w.-]+(?:@[^\s]+)?', line.strip())}
        if installed != EXPECTED_EXTENSIONS:
            raise ValueError(f'Expected only clangd and Mentor in isolated extensions; found {sorted(installed)}')
        print(result.stdout.strip())

    if args.action == 'setup':
        # Check availability before installing anything; ARM Linux needs an explicit native clangd.
        clangd = executable(args.clangd_path) if args.clangd_path else None
        if clangd is None:
            spec_for_host()
        STATE.mkdir(exist_ok=True)
        run([*npm_command(), 'ci', '--no-audit', '--no-fund'], cwd=TOOL)
        codex = resolve_codex(args.codex_path)
        clangd = clangd or download()
        source_home = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex').expanduser()
        if not initialize_codex(STATE / 'codex', source_home):
            print('No reusable file login. Run: python3 editor.py login')
        (STATE / 'runtime.json').write_text(json.dumps({'codexPath': str(codex), 'clangdPath': str(clangd)}) + '\n', encoding='utf-8')
        write_settings(codex, clangd, args.build_dir, workspace)
        run([*npm_command(), 'run', 'package'], cwd=TOOL)
        vscode([*isolation, '--install-extension', CLANGD_EXTENSION, '--force'])
        vscode([*isolation, '--install-extension', STATE / 'vscode-mentor.vsix', '--force'])
        check_extensions()
    elif args.action == 'check':
        settings = read_settings()
        check_extensions()
        for key in ('clangd.path', 'mentor.codexPath'):
            run([settings[key], '--version'], cwd=TOOL)
        databases = [Path(value.split('=', 1)[1]) / 'compile_commands.json'
                     for value in settings.get('clangd.arguments', []) if value.startswith('--compile-commands-dir=')]
        if not databases or not any(p.is_file() and json.loads(p.read_text(encoding='utf-8')) for p in databases):
            print('No populated compilation database. C++ navigation uses fallback flags; see docs/portability.md.')
        print(f'VS Code state: {user_data}\nExtensions: {STATE / "extensions"}')
    elif args.action == 'test':
        STATE.mkdir(exist_ok=True)
        run([*npm_command(), 'test'], cwd=TOOL)
        result_file = STATE / 'editor-test-result.json'
        result_file.unlink(missing_ok=True)
        test_workspace = STATE / 'test-workspace'
        (test_workspace / 'src').mkdir(parents=True, exist_ok=True)
        (test_workspace / 'src/app.cpp').write_text('int answer();\n', encoding='utf-8')
        vscode(['--user-data-dir', STATE / 'test-user-data', '--extensions-dir', STATE / 'test-extensions',
                '--sync', 'off', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
                '--extensionDevelopmentPath', TOOL, '--extensionTestsPath', TOOL / 'dist/test/editor.js', '--wait', test_workspace])
        if not result_file.is_file():
            raise RuntimeError('VS Code did not report an extension-host test result.')
        result = json.loads(result_file.read_text(encoding='utf-8'))
        if not result.get('passed'):
            raise RuntimeError(f'Extension-host tests failed: {result.get("message")}')
        print('Mentor extension-host tests passed.')
    if args.action == 'open' or (args.action == 'setup' and not args.no_launch):
        runtime = read_runtime()
        write_settings(runtime['codexPath'], runtime['clangdPath'], args.build_dir, workspace)
        vscode([*isolation, '--new-window', '--skip-welcome', '--skip-release-notes', workspace])


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
