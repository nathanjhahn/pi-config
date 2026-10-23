"""Restore the actual reviewed tree, not just installer-shaped fixtures."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest

from scripts import setup


class RepositoryTests(unittest.TestCase):
    def test_actual_source_restores_exact_bytes_without_private_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary).resolve() / 'agent'
            with redirect_stdout(io.StringIO()):
                setup.install(target=target)
                self.assertFalse(target.exists())
                plan = setup.install(target=target, apply=True)
                setup.install(target=target, apply=True)
            self.assertGreater(len(plan.files), 100)
            for source, destination in plan.files:
                self.assertEqual(source.read_bytes(), destination.read_bytes())
            self.assertFalse((target / 'extensions/web-search').exists())
            self.assertFalse((target / 'extensions/web-fetch').exists())
            self.assertFalse((target / 'extensions/browser/.profile').exists())
            self.assertFalse((target / 'auth.json').exists())
            self.assertFalse((target / 'models.json').exists())
            self.assertFalse((target / '.memory').exists())

    def test_portable_settings_and_local_entrypoints(self):
        settings = json.loads((setup.SOURCE / 'config/agent/settings.json').read_text())
        self.assertEqual(settings['defaultProjectTrust'], 'ask')
        self.assertTrue(settings['observational-memory']['passive'])
        self.assertFalse(settings['observational-memory']['autoPromote'])
        for key in ['defaultProvider', 'defaultModel', 'enabledModels', 'deviceId']:
            self.assertNotIn(key, settings)
        for source in settings['packages']:
            if source.startswith('local-packages/'):
                root = setup.SOURCE / source
                manifest = json.loads((root / 'package.json').read_text())
                for entrypoint in manifest['pi']['extensions']:
                    self.assertTrue((root / entrypoint).is_file(), entrypoint)
            else:
                self.assertRegex(source, r'^npm:.+@\d+\.\d+\.\d+$')
        for role in ['scout', 'researcher', 'worker']:
            content = (setup.SOURCE / f'config/agent/agents/{role}.md').read_text()
            frontmatter = content.split('---', 2)[1]
            self.assertNotIn('model:', frontmatter)


if __name__ == '__main__':
    unittest.main()
