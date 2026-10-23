"""Publication guard tests with synthetic fixtures; no real credentials."""
from contextlib import redirect_stdout, redirect_stderr
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts import check_public


class PublicationTests(unittest.TestCase):
    def check(self, name, contents, *, symlink=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if symlink:
                path.symlink_to(root / 'not-present')
            else:
                path.write_text(contents)
            result = subprocess.CompletedProcess([], 0, (name + '\0').encode())
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(check_public, 'ROOT', root), patch.object(
                check_public.subprocess, 'run', return_value=result
            ), redirect_stdout(stdout), redirect_stderr(stderr):
                status = check_public.main()
            return status, stdout.getvalue() + stderr.getvalue()

    def test_clean_file_passes(self):
        status, output = self.check('config/agent/settings.json', '{"theme":"dark"}')
        self.assertEqual(status, 0)
        self.assertIn('history not scanned', output)

    def test_sensitive_paths_are_rejected_even_when_tracked(self):
        for name in ['auth.json', '.memory/private.md', '.env.local', 'keys/private.key']:
            with self.subTest(name=name):
                status, output = self.check(name, 'fixture')
                self.assertEqual(status, 1)
                self.assertIn('private/generated filename', output)

    def test_synthetic_token_is_not_echoed(self):
        token = 'ghp_' + 'a' * 40
        status, output = self.check('example.txt', token)
        self.assertEqual(status, 1)
        self.assertIn('GitHub token', output)
        self.assertNotIn(token, output)

    def test_personal_path_is_flagged(self):
        status, output = self.check('example.txt', '/Users/' + 'nathanhahn/private')
        self.assertEqual(status, 1)
        self.assertIn('personal absolute path', output)

    def test_symlink_is_rejected_without_reading(self):
        status, output = self.check('example.txt', '', symlink=True)
        self.assertEqual(status, 1)
        self.assertIn('symlink requires manual review', output)


if __name__ == '__main__':
    unittest.main()
