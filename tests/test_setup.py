"""Isolated installer tests; never read or write the user's Pi directory."""

from contextlib import redirect_stderr, redirect_stdout
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts import setup


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        # macOS /var can itself be a symlink; use the physical fixture root.
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / "source"
        self.target = self.root / "fresh" / "agent"
        self.source.mkdir()
        self.expected = {}
        self.add_source("config/agent/AGENTS.md", "public instructions\n", "AGENTS.md")
        self.add_source("config/agent/settings.json", '{"packages": []}\n', "settings.json")
        self.add_source("config/agent/agents/scout.md", "scout\n", "agents/scout.md")
        self.add_source("config/agent/agents/worker.md", "worker\n", "agents/worker.md")
        for name in setup.EXTENSIONS:
            if name.endswith(".ts"):
                self.add_source(f"extensions/{name}", f"// {name}\n")
            else:
                self.add_source(f"extensions/{name}/index.ts", f"// {name}\n")
        self.add_source("extensions/prompt-snippets/snippets/example.md", "snippet\n")
        for name in setup.SKILLS:
            self.add_source(f"skills/{name}/SKILL.md", f"# {name}\n")
        self.add_source("skills/pdf-reader/scripts/read.py", "print('fixture')\n")
        for name in setup.LOCAL_PACKAGES:
            self.add_source(f"local-packages/{name}/src/index.ts", f"// {name}\n")
        for folder, name in (
            ("extensions", "bash-guard"),
            ("extensions", "browser"),
            ("local-packages", "pi-interactive-subagents"),
            ("local-packages", "pi-observational-memory"),
        ):
            self.add_source(f"{folder}/{name}/package.json", '{"private": true}\n')
            self.add_source(f"{folder}/{name}/package-lock.json", '{"lockfileVersion": 3}\n')
        self.output = io.StringIO()

    def add_source(self, relative, content, destination=None):
        path = self.source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        self.expected[destination or relative] = content.encode()
        return path

    def add_excluded(self, relative, content="do not copy\n"):
        path = self.source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def run_install(self, **options):
        with redirect_stdout(self.output):
            return setup.install(self.source, self.target, **options)

    def installed_files(self):
        return {
            str(path.relative_to(self.target)): path.read_bytes()
            for path in self.target.rglob("*") if path.is_file()
        }

    def test_default_dry_run_creates_nothing(self):
        with patch.object(setup.subprocess, "run") as run:
            self.run_install()
        self.assertFalse(self.target.parent.exists())
        self.assertIn("DRY RUN", self.output.getvalue())
        run.assert_not_called()

    def test_apply_installs_exact_allowlisted_files(self):
        with patch.object(setup.subprocess, "run") as run:
            self.run_install(apply=True)
        self.assertEqual(self.installed_files(), self.expected)
        run.assert_not_called()

    def test_idempotent_keeps_existing_files_and_modes(self):
        self.run_install(apply=True)
        installed = self.target / "AGENTS.md"
        installed.chmod(0o600)
        before = {str(path): path.stat().st_mtime_ns for path in self.target.rglob("*")}
        self.run_install(apply=True)
        after = {str(path): path.stat().st_mtime_ns for path in self.target.rglob("*")}
        self.assertEqual(before, after)
        self.assertEqual(installed.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.installed_files(), self.expected)

    def test_existing_unrelated_files_are_preserved(self):
        self.target.mkdir(parents=True)
        unrelated = self.target / "auth.json"
        unrelated.write_text("private existing credentials")
        self.run_install(apply=True)
        self.assertEqual(unrelated.read_text(), "private existing credentials")
        self.assertEqual(len(self.installed_files()), len(self.expected) + 1)

    def test_preflight_all_file_conflicts_prevents_partial_install(self):
        self.target.mkdir(parents=True)
        (self.target / "settings.json").write_text("existing settings")
        (self.target / "AGENTS.md").write_text("existing instructions")
        with self.assertRaises(setup.SetupError) as error:
            self.run_install(apply=True)
        self.assertIn("settings.json", str(error.exception))
        self.assertIn("AGENTS.md", str(error.exception))
        self.assertEqual(set(self.installed_files()), {"AGENTS.md", "settings.json"})
        self.assertEqual((self.target / "settings.json").read_text(), "existing settings")
        self.assertFalse((self.target / "extensions").exists())

    def test_conflict_is_also_reported_in_dry_run(self):
        self.target.mkdir(parents=True)
        (self.target / "AGENTS.md").write_text("different")
        with self.assertRaises(setup.SetupError):
            self.run_install()
        self.assertEqual(set(self.installed_files()), {"AGENTS.md"})

    def test_directory_conflicts_prevent_all_writes(self):
        for conflict in ("extensions", "skills/pdf-reader", "settings.json"):
            with self.subTest(conflict=conflict):
                target = self.root / conflict.replace("/", "-") / "agent"
                conflicting = target / conflict
                conflicting.parent.mkdir(parents=True, exist_ok=True)
                if conflict == "settings.json":
                    conflicting.mkdir()
                else:
                    conflicting.write_text("existing file")
                before = set(target.rglob("*"))
                with self.assertRaises(setup.SetupError), redirect_stdout(self.output):
                    setup.install(self.source, target, apply=True)
                self.assertEqual(before, set(target.rglob("*")))

    def test_target_parent_file_is_rejected(self):
        self.target.parent.parent.mkdir(exist_ok=True)
        self.target.parent.write_text("not a directory")
        with self.assertRaises(setup.SetupError):
            self.run_install(apply=True)
        self.assertEqual(self.target.parent.read_text(), "not a directory")

    def test_unrelated_private_legacy_and_optional_sources_are_excluded(self):
        for relative in (
            ".memory/private.md", ".pi/private.md", "research/private.md",
            "sessions/session.jsonl", "auth.json", "README.md",
            "assets/thumbnail.png", "deprecated/extensions/old.ts",
            "extensions/web-search/index.ts", "extensions/web-fetch/package-lock.json",
            "extensions/interactive-subagents/README.md", "extensions/observational-memory/README.md",
            "extensions/unlisted/index.ts", "skills/unlisted/SKILL.md",
            "local-packages/unlisted/package.json", "config/agent/models.example.json",
            "config/agent/models.json", "config/agent/auth.json",
            "config/agent/agents/private.txt", "config/agent/agents/nested/hidden.md",
        ):
            self.add_excluded(relative)
        self.run_install(apply=True)
        self.assertEqual(self.installed_files(), self.expected)

    def test_generated_files_are_excluded_recursively(self):
        for relative in (
            "extensions/browser/node_modules/private/index.js",
            "extensions/browser/.git/config", "extensions/browser/dist/index.js",
            "local-packages/pi-observational-memory/build/bundle.js",
            "local-packages/pi-observational-memory/.cache/private",
            "skills/pdf-reader/.venv/bin/python", "skills/pdf-reader/venv/bin/python",
            "skills/pdf-reader/scripts/__pycache__/read.cpython.pyc",
            "skills/pdf-reader/scripts/read.pyc", "skills/pdf-reader/scripts/read.pyo",
            "skills/pdf-reader/.pytest_cache/private", "skills/pdf-reader/.mypy_cache/private",
            "skills/pdf-reader/.ruff_cache/private", "skills/pdf-reader/.DS_Store",
            "skills/pdf-reader/package.egg-info/metadata",
            "extensions/browser/.profile/Cookies", "extensions/browser/.env.local",
            "extensions/browser/auth.json", "extensions/browser/mcp.json",
            "extensions/browser/private.key", "extensions/browser/browser.log",
            "local-packages/pi-observational-memory/.memory/private.md",
        ):
            self.add_excluded(relative)
        self.run_install(apply=True)
        self.assertEqual(self.installed_files(), self.expected)

    def test_target_symlink_and_dangling_symlink_are_rejected(self):
        for dangling in (False, True):
            with self.subTest(dangling=dangling):
                target = self.root / f"target-{dangling}"
                outside = self.root / f"outside-{dangling}"
                if not dangling:
                    outside.mkdir()
                target.symlink_to(outside, target_is_directory=True)
                with self.assertRaises(setup.SetupError), redirect_stdout(self.output):
                    setup.install(self.source, target, apply=True)
                self.assertEqual(list(outside.iterdir()) if outside.exists() else [], [])

    def test_symlink_in_target_ancestor_is_rejected(self):
        outside = self.root / "outside"
        outside.mkdir()
        link = self.root / "link"
        link.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(setup.SetupError), redirect_stdout(self.output):
            setup.install(self.source, link / "nested/agent", apply=True)
        self.assertEqual(list(outside.iterdir()), [])

    def test_symlink_inside_target_is_rejected_even_for_identical_file(self):
        self.target.mkdir(parents=True)
        (self.target / "AGENTS.md").symlink_to(self.source / "config/agent/AGENTS.md")
        with self.assertRaises(setup.SetupError):
            self.run_install(apply=True)
        self.assertFalse((self.target / "settings.json").exists())

    def test_symlink_in_nested_target_directory_is_rejected(self):
        outside = self.root / "outside"
        outside.mkdir()
        self.target.mkdir(parents=True)
        (self.target / "extensions").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(setup.SetupError):
            self.run_install(apply=True)
        self.assertFalse((self.target / "AGENTS.md").exists())
        self.assertEqual(list(outside.iterdir()), [])

    def test_source_symlink_is_rejected(self):
        outside = self.root / "private"
        outside.write_text("secret")
        (self.source / "extensions/browser/private").symlink_to(outside)
        with self.assertRaises(setup.SetupError):
            self.run_install(apply=True)
        self.assertFalse(self.target.parent.exists())

    def test_source_directory_symlink_is_rejected(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.source / "extensions/browser/linked-dir").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(setup.SetupError):
            self.run_install(apply=True)
        self.assertFalse(self.target.parent.exists())

    def test_ignored_generated_symlink_is_never_traversed(self):
        outside = self.root / "private"
        outside.mkdir()
        (outside / "secret").write_text("secret")
        (self.source / "extensions/browser/node_modules").symlink_to(outside, target_is_directory=True)
        self.run_install(apply=True)
        self.assertEqual(self.installed_files(), self.expected)

    def test_source_root_symlink_is_rejected(self):
        link = self.root / "linked-source"
        link.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(setup.SetupError), redirect_stdout(self.output):
            setup.install(link, self.target, apply=True)
        self.assertFalse(self.target.parent.exists())

    def test_missing_required_source_prevents_writes(self):
        (self.source / "config/agent/settings.json").unlink()
        with self.assertRaises(setup.SetupError):
            self.run_install(apply=True)
        self.assertFalse(self.target.parent.exists())

    def test_source_file_permissions_are_preserved(self):
        script = self.source / "skills/pdf-reader/scripts/read.py"
        script.chmod(0o755)
        self.run_install(apply=True)
        self.assertEqual((self.target / "skills/pdf-reader/scripts/read.py").stat().st_mode & 0o777, 0o755)

    def test_dependencies_dry_run_never_runs_npm_or_writes(self):
        with patch.object(setup.subprocess, "run") as run:
            self.run_install(dependencies=True)
        run.assert_not_called()
        self.assertFalse(self.target.parent.exists())
        self.assertIn("npm ci --ignore-scripts --legacy-peer-deps", self.output.getvalue())
        self.assertIn("--omit=dev", self.output.getvalue())
        self.assertIn("skip pi-interactive-subagents", self.output.getvalue())

    def test_dependencies_only_run_locked_runtime_packages(self):
        # A lockfile outside the explicit runtime package list is not permission
        # to install dependencies (in particular, never install subagents dev deps).
        self.add_source("extensions/prompt-snippets/package.json", '{"private": true}\n')
        self.add_source("extensions/prompt-snippets/package-lock.json", '{}\n')
        # Even locked skill packages are not npm installation roots.
        self.add_source("skills/web-debug/package.json", '{}\n')
        self.add_source("skills/web-debug/package-lock.json", '{}\n')
        with patch.object(setup.subprocess, "run") as run:
            self.run_install(apply=True, dependencies=True)
        calls = run.call_args_list
        self.assertEqual(len(calls), 3)
        self.assertEqual(
            [call.kwargs["cwd"].relative_to(self.target).as_posix() for call in calls],
            ["extensions/bash-guard", "extensions/browser", "local-packages/pi-observational-memory"],
        )
        for call in calls:
            directory = call.kwargs["cwd"]
            expected = ["npm", "ci", "--ignore-scripts", "--legacy-peer-deps"]
            if directory.name == "pi-observational-memory":
                expected.append("--omit=dev")
            self.assertEqual(call.args, (expected,))
            self.assertTrue(call.kwargs["check"])
            self.assertTrue((directory / "package-lock.json").is_file())
        self.assertEqual(self.installed_files(), self.expected)

    def test_runtime_package_without_lockfile_is_not_installed(self):
        (self.source / "extensions/browser/package-lock.json").unlink()
        del self.expected["extensions/browser/package-lock.json"]
        with patch.object(setup.subprocess, "run") as run:
            self.run_install(apply=True, dependencies=True)
        self.assertEqual(
            [call.kwargs["cwd"].relative_to(self.target).as_posix() for call in run.call_args_list],
            ["extensions/bash-guard", "local-packages/pi-observational-memory"],
        )
        self.assertEqual(self.installed_files(), self.expected)

    def test_lockfile_without_manifest_prevents_writes(self):
        (self.source / "extensions/browser/package.json").unlink()
        with self.assertRaises(setup.SetupError):
            self.run_install(apply=True, dependencies=True)
        self.assertFalse(self.target.parent.exists())

    def test_dependency_failure_is_not_ignored(self):
        with patch.object(setup.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "npm")) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                self.run_install(apply=True, dependencies=True)
        self.assertEqual(run.call_count, 1)

    def test_dependency_conflict_prevents_copies_and_subprocesses(self):
        directory = self.target / "extensions/browser"
        directory.mkdir(parents=True)
        outside = self.root / "outside"
        outside.mkdir()
        (directory / "node_modules").symlink_to(outside, target_is_directory=True)
        with patch.object(setup.subprocess, "run") as run:
            with self.assertRaises(setup.SetupError):
                self.run_install(apply=True, dependencies=True)
        run.assert_not_called()
        self.assertFalse((self.target / "AGENTS.md").exists())

    def test_cli_defaults_to_dry_run_and_accepts_explicit_target(self):
        with patch.object(setup, "SOURCE", self.source), redirect_stdout(self.output):
            result = setup.main(["--target", str(self.target)])
        self.assertEqual(result, 0)
        self.assertFalse(self.target.parent.exists())

    def test_cli_apply_and_conflict_exit_status(self):
        with patch.object(setup, "SOURCE", self.source), redirect_stdout(self.output):
            self.assertEqual(setup.main(["--target", str(self.target), "--apply"]), 0)
        self.assertEqual(self.installed_files(), self.expected)
        (self.target / "settings.json").write_text("custom")
        error = io.StringIO()
        with patch.object(setup, "SOURCE", self.source), redirect_stdout(self.output), redirect_stderr(error):
            self.assertEqual(setup.main(["--target", str(self.target), "--apply"]), 1)
        self.assertIn("Preflight failed", error.getvalue())
        self.assertEqual((self.target / "settings.json").read_text(), "custom")

    def test_source_root_is_relative_to_script_not_working_directory(self):
        self.assertEqual(setup.SOURCE, Path(setup.__file__).absolute().parent.parent)
        previous = Path.cwd()
        try:
            os.chdir(self.root)
            self.run_install(apply=True)
        finally:
            os.chdir(previous)
        self.assertEqual(self.installed_files(), self.expected)


if __name__ == "__main__":
    unittest.main()
