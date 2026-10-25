"""Offline portability checks; no editor, Node, graphics SDK, or third-party Python imports."""
import errno
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from host_tools import host_key, run

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import editor
from download_clangd import spec_for_host


def touch(path, text=''):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    return path


class LauncherTests(unittest.TestCase):
    def test_workspace_profiles_do_not_share_editor_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            first, second = Path(temp) / 'first project', Path(temp) / 'second project'
            first.mkdir()
            second.mkdir()
            self.assertNotEqual(editor.profile_for_workspace(first), editor.profile_for_workspace(second))
            self.assertEqual(editor.profile_for_workspace(first), editor.profile_for_workspace(first / '.'))
            for workspace in (first, second):
                settings = Path(temp) / workspace.name / 'profile/settings.json'
                with patch.object(editor, 'SETTINGS', settings):
                    editor.write_settings('codex', 'clangd', 'build', workspace)
                    self.assertEqual(editor.read_settings()['clangd.arguments'][1],
                                     f'--compile-commands-dir={(workspace / "build").resolve()}')
            with self.assertRaisesRegex(ValueError, 'existing directory'):
                editor.workspace_path(Path(temp) / 'missing')

    def test_clangd_architecture_selection(self):
        self.assertEqual(host_key('Linux', 'aarch64'), 'linux-arm64')
        self.assertEqual(spec_for_host('Darwin', 'arm64'), spec_for_host('Darwin', 'x86_64'))
        for system, machine, suffix in [('Windows', 'AMD64', 'bin/clangd.exe'),
                                         ('Linux', 'x86_64', 'bin/clangd'), ('Darwin', 'arm64', 'bin/clangd')]:
            self.assertEqual(spec_for_host(system, machine)['executable'], suffix)
        for system in ('Linux', 'Windows'):
            with self.assertRaisesRegex(ValueError, '--clangd-path'):
                spec_for_host(system, 'arm64')

    def test_codex_selects_node_platform_not_python_host(self):
        targets = [('win32', 'x64', 'x86_64-pc-windows-msvc'), ('win32', 'arm64', 'aarch64-pc-windows-msvc'),
                   ('linux', 'x64', 'x86_64-unknown-linux-musl'), ('linux', 'arm64', 'aarch64-unknown-linux-musl'),
                   ('darwin', 'x64', 'x86_64-apple-darwin'), ('darwin', 'arm64', 'aarch64-apple-darwin')]
        with tempfile.TemporaryDirectory() as temp:
            tool = Path(temp)
            for system, arch, triple in targets:
                for nested in (False, True):
                    base = tool / ('node_modules/@openai/codex/node_modules/@openai' if nested else 'node_modules/@openai')
                    path = touch(base / f'codex-{system}-{arch}/vendor/{triple}/bin' /
                                 ('codex.exe' if system == 'win32' else 'codex'))
                    self.assertEqual(editor.codex_binary(system, arch, tool=tool), path.resolve())
                    path.unlink()
            with self.assertRaises(FileNotFoundError):
                editor.codex_binary('darwin', 'arm64', tool=tool)

    def test_windows_code_cli_versioned_layout_with_spaces(self):
        with tempfile.TemporaryDirectory(prefix='mentor editor ') as temp:
            root = Path(temp)
            exe = touch(root / 'Code.exe')
            cli = touch(root / 'version123/resources/app/out/cli.js')
            shim = touch(root / 'bin/code.cmd', '"%~dp0..\\Code.exe" "%~dp0..\\version123\\resources\\app\\out\\cli.js" %*')
            self.assertEqual(editor.windows_code_cli(shim), [exe.resolve(), cli.resolve()])
            with patch.dict(os.environ, {'VSCODE_DEV': '1', 'VSCODE_IPC_HOOK_CLI': 'unrelated'}, clear=True):
                for path in (shim, exe):
                    command, env = editor.code_command(str(path), system='Windows')
                    self.assertEqual(command, [exe.resolve(), cli.resolve()])
                    self.assertEqual(env['ELECTRON_RUN_AS_NODE'], '1')
                    self.assertNotIn('VSCODE_DEV', env)
                    self.assertNotIn('VSCODE_IPC_HOOK_CLI', env)
            cli.unlink()
            with self.assertRaises(ValueError):
                editor.windows_code_cli(shim)

    def test_posix_code_and_mac_app(self):
        with tempfile.TemporaryDirectory(prefix='mentor editor ') as temp, patch.dict(os.environ, {}, clear=True):
            root = Path(temp)
            app = root / 'Visual Studio Code.app'
            cli = touch(app / 'Contents/Resources/app/bin/code')
            self.assertEqual(editor.code_command(str(app), system='Darwin')[0], [cli.resolve()])
            linux = touch(root / 'linux/bin/code')
            command, env = editor.code_command(str(linux), system='Linux')
            self.assertEqual(command, [linux.resolve()])
            self.assertNotIn('ELECTRON_RUN_AS_NODE', env)

    def test_portable_mode_cannot_override_isolation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            windows = touch(root / 'Code.exe')
            linux = touch(root / 'bin/code')
            mac = touch(root / 'Visual Studio Code.app/Contents/Resources/app/bin/code')
            for path in (windows, linux, mac):
                with self.assertRaisesRegex(ValueError, 'VSCODE_PORTABLE'):
                    editor.reject_portable(path, {'VSCODE_PORTABLE': 'elsewhere'})
            (root / 'data').mkdir()
            for path in (windows, linux):
                with self.assertRaisesRegex(ValueError, 'portable data'):
                    editor.reject_portable(path, {})
            (root / 'code-portable-data').mkdir()
            with self.assertRaisesRegex(ValueError, 'portable data'):
                editor.reject_portable(mac, {})

    def test_auth_link_preserves_existing_config_and_handles_other_filesystem(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'source'
            touch(source / 'auth.json', 'not-a-real-credential')
            home = root / 'isolated'
            config = touch(home / 'config.toml', 'preserve-me')
            with patch.object(editor.os, 'link', side_effect=OSError(errno.EXDEV, 'different devices')):
                self.assertFalse(editor.initialize_codex(home, source))
            self.assertFalse((home / 'auth.json').exists(), 'no credential copy fallback')
            self.assertEqual(config.read_text(), 'preserve-me')
            self.assertTrue(editor.initialize_codex(home, source))
            self.assertTrue(os.path.samefile(source / 'auth.json', home / 'auth.json'))
            if os.name != 'nt':
                self.assertEqual(home.stat().st_mode & 0o777, 0o700)

    def test_settings_preserve_preferences_and_refresh_machine_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            settings = touch(Path(temp) / 'settings.json', '\ufeff' + json.dumps({
                'editor.fontSize': 19, 'clangd.arguments': ['--compile-commands-dir=custom'],
                'mentor.codexPath': 'old-machine'}))
            with patch.object(editor, 'SETTINGS', settings):
                editor.write_settings(Path('new-codex'), Path('new-clangd'), None, Path(temp))
                result = editor.read_settings()
                self.assertEqual(result['editor.fontSize'], 19)
                self.assertEqual(result['clangd.arguments'], ['--compile-commands-dir=custom'])
                self.assertEqual(result['mentor.codexPath'], 'new-codex')
                editor.write_settings(Path('new-codex'), Path('new-clangd'), 'build with spaces', Path(temp))
                self.assertIn('build with spaces', editor.read_settings()['clangd.arguments'][1])

    def test_subprocess_arguments_are_not_shell_source(self):
        text = 'spaces & $(do-not-execute) `literal` "quotes" λ'
        result = run([sys.executable, '-c', 'import sys, json; print(json.dumps(sys.argv[1]))', text],
                     cwd=Path(__file__).parent, capture=True)
        self.assertEqual(json.loads(result.stdout), text)


if __name__ == '__main__':
    unittest.main()
