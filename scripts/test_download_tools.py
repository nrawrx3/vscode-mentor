import hashlib
import os
import stat
import tempfile
import unittest
from pathlib import Path
import zipfile
from types import SimpleNamespace
from unittest.mock import patch

from download_tools import extract_zip, install


class DownloaderTests(unittest.TestCase):
    def test_rejects_symlinks_and_special_files(self):
        for mode in (stat.S_IFLNK | 0o777, stat.S_IFIFO | 0o600):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                archive = Path(temp) / 'bad.zip'
                info = zipfile.ZipInfo('link')
                info.create_system = 3
                info.external_attr = mode << 16
                with zipfile.ZipFile(archive, 'w') as z:
                    z.writestr(info, 'target')
                with self.assertRaises(ValueError):
                    extract_zip(archive, Path(temp) / 'out')

    def test_unix_executable_permissions_survive_extraction(self):
        with tempfile.TemporaryDirectory() as temp:
            archive, destination = Path(temp) / 'tool.zip', Path(temp) / 'out'
            info = zipfile.ZipInfo('bin/tool')
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o6755) << 16
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr(info, '#!/bin/sh\nexit 0\n')
            # Check the POSIX branch even on Windows, without changing pathlib's host type.
            with patch('download_tools.os', SimpleNamespace(name='posix')), patch.object(Path, 'chmod') as chmod:
                extract_zip(archive, destination)
                chmod.assert_called_once_with(0o755)
            if os.name != 'nt':
                extract_zip(archive, destination)
                self.assertTrue(os.access(destination / 'bin/tool', os.X_OK))
                self.assertEqual((destination / 'bin/tool').stat().st_mode & 0o7777, 0o755)

    def test_rejects_archive_escape(self):
        for name in ('../escape', '/absolute', 'C:/drive', 'folder\\..\\..\\escape', 'file:stream'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                archive = Path(temp) / 'bad.zip'
                with zipfile.ZipFile(archive, 'w') as z:
                    z.writestr(name, 'bad')
                with self.assertRaises(ValueError):
                    extract_zip(archive, Path(temp) / 'out')

    def test_verified_offline_install_and_corrupt_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            tools = Path(temp)
            (tools / 'archives').mkdir()
            archive = tools / 'archives/test.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('bundle/bin/tool.exe', 'fixture')
            spec = dict(version='1', archive='test.zip', executable='bin/tool.exe',
                        strip_prefix='bundle', url='https://invalid.example/test.zip',
                        sha256=hashlib.sha256(archive.read_bytes()).hexdigest())
            install('test', spec, tools)
            install('test', spec, tools)
            self.assertEqual((tools / 'test/bin/tool.exe').read_text(), 'fixture')
            archive.write_bytes(b'corrupt')
            with self.assertRaises(ValueError):
                install('test', spec, tools)


if __name__ == '__main__':
    unittest.main()
