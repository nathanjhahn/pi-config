#!/usr/bin/env python3
"""Copy the public Pi configuration without overwriting existing content.

The default is a read-only preview. Use --apply to install, and optionally
--dependencies to run locked, script-free npm installs in copied packages.
Pi itself resolves the npm sources declared in settings.json on a later launch.
"""

import argparse
from dataclasses import dataclass
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys


SOURCE = Path(__file__).absolute().parent.parent
EXTENSIONS = (
    "custom-header.ts",
    "ask-user-question.ts",
    "bash-guard",
    "browser",
    "prompt-snippets",
)
SKILLS = ("analyze-sessions", "pdf-reader", "web-debug", "youtube-transcript")
LOCAL_PACKAGES = ("pi-interactive-subagents", "pi-observational-memory")
DEPENDENCY_ROOTS = (
    "extensions/bash-guard",
    "extensions/browser",
    "local-packages/pi-observational-memory",
)
IGNORED_NAMES = frozenset({
    ".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache",
    ".mypy_cache", ".ruff_cache", ".cache", ".DS_Store", ".coverage",
    "dist", "build", ".profile", ".memory", ".pi", "sessions", "auth.json",
    ".env", "cliproxy-api-key", "models-store.json", "mcp.json", ".mcp.json",
    "mcp-adapter.json", "peers.json",
})


class SetupError(Exception):
    """An unsafe or incomplete installation was requested."""


@dataclass
class Plan:
    target: Path
    files: list
    directories: set
    dependencies: list


def _absolute(path):
    return Path(os.path.abspath(os.path.expanduser(os.fspath(path))))


def _check_ancestors(path):
    """Reject symlinks (including dangling links) and non-directory parents."""
    for ancestor in reversed((path, *path.parents)):
        if ancestor.is_symlink():
            raise SetupError(f"Symlink is not allowed: {ancestor}")
        if ancestor != path and ancestor.exists() and not ancestor.is_dir():
            raise SetupError(f"Parent is not a directory: {ancestor}")


def _ignored(path):
    return (path.name in IGNORED_NAMES or path.name.startswith(".env.")
            or path.name.endswith((".pyc", ".pyo", ".egg-info", ".key", ".pem", ".log")))


def make_plan(source, target):
    """Collect only explicitly supported sources; never create target paths."""
    source, target = _absolute(source), _absolute(target)
    _check_ancestors(source)
    _check_ancestors(target)
    if not source.is_dir():
        raise SetupError(f"Source directory does not exist: {source}")
    files, directories = [], {target}

    def collect(src, dst):
        _check_ancestors(src)
        if src.is_dir():
            directories.add(dst)
            for child in sorted(src.iterdir()):
                if not _ignored(child):
                    collect(child, dst / child.name)
        elif src.is_file() and stat.S_ISREG(src.stat().st_mode):
            files.append((src, dst))
            directories.update(parent for parent in dst.parents if parent == target or target in parent.parents)
        else:
            raise SetupError(f"Required source is missing or not a regular file/directory: {src}")

    collect(source / "config/agent/AGENTS.md", target / "AGENTS.md")
    collect(source / "config/agent/settings.json", target / "settings.json")
    agents = source / "config/agent/agents"
    _check_ancestors(agents)
    if not agents.is_dir():
        raise SetupError(f"Required source directory is missing: {agents}")
    directories.add(target / "agents")
    for agent in sorted(agents.glob("*.md")):
        if not agent.is_file():
            raise SetupError(f"Agent must be a regular file: {agent}")
        collect(agent, target / "agents" / agent.name)
    for folder, names in (("extensions", EXTENSIONS), ("skills", SKILLS), ("local-packages", LOCAL_PACKAGES)):
        for name in names:
            collect(source / folder / name, target / folder / name)

    # Include ancestors of empty directories too.
    for directory in tuple(directories):
        directories.update(parent for parent in directory.parents if parent == target or target in parent.parents)
    copied = {dst for _, dst in files}
    dependencies = []
    # pi-interactive-subagents is deliberately absent: its lockfile describes
    # a legacy development environment, not runtime dependencies. Pi loads its
    # checked-in extension source without npm ci.
    for relative in DEPENDENCY_ROOTS:
        directory = target / relative
        if directory / "package-lock.json" in copied:
            if directory / "package.json" not in copied:
                raise SetupError(f"Lockfile has no package.json: {directory}")
            dependencies.append(directory)
    return Plan(target, files, directories, dependencies)


def _identical(left, right):
    if left.stat().st_size != right.stat().st_size:
        return False
    with left.open("rb") as a, right.open("rb") as b:
        while True:
            chunk = a.read(65536)
            if chunk != b.read(65536):
                return False
            if not chunk:
                return True


def preflight(plan, dependencies=False):
    """Check the entire destination before any mkdir, copy, or subprocess."""
    errors = []
    for directory in sorted(plan.directories):
        try:
            _check_ancestors(directory)
            if directory.exists() and not directory.is_dir():
                raise SetupError(f"Directory conflicts with existing content: {directory}")
        except SetupError as error:
            errors.append(str(error))
    for src, dst in plan.files:
        try:
            _check_ancestors(dst)
            if dst.exists() and (not dst.is_file() or not _identical(src, dst)):
                raise SetupError(f"File conflicts with existing content: {dst}")
        except SetupError as error:
            errors.append(str(error))
    if dependencies:
        for directory in plan.dependencies:
            try:
                _check_ancestors(directory / "node_modules")
            except SetupError as error:
                errors.append(str(error))
    if errors:
        raise SetupError("Preflight failed; nothing was changed:\n" + "\n".join(dict.fromkeys(errors)))


def _dependency_command(directory):
    command = ["npm", "ci", "--ignore-scripts", "--legacy-peer-deps"]
    if directory.name == "pi-observational-memory":
        # The host Pi provides its own development libraries; do not duplicate them.
        command.append("--omit=dev")
    return command


def install(source=SOURCE, target=Path.home() / ".pi/agent", *, apply=False, dependencies=False):
    """Preview or apply an install. Source can be replaced with an isolated fixture."""
    plan = make_plan(source, target)
    preflight(plan, dependencies)
    mode = "APPLY" if apply else "DRY RUN (no changes)"
    print(f"{mode}: {len(plan.files)} files -> {plan.target}")
    for src, dst in plan.files:
        print(f"  {'keep' if dst.exists() else 'copy'} {dst.relative_to(plan.target)}")
    if dependencies:
        print("  skip pi-interactive-subagents dependencies: legacy dev-only lockfile; source loads directly")
        for directory in plan.dependencies:
            print(f"  {' '.join(_dependency_command(directory))} (in {directory})")
    if not apply:
        return plan

    for directory in sorted(plan.directories, key=lambda path: (len(path.parts), str(path))):
        _check_ancestors(directory)
        directory.mkdir(parents=True, exist_ok=True)
    for src, dst in plan.files:
        _check_ancestors(src)
        _check_ancestors(dst)
        if dst.exists():
            if not dst.is_file() or not _identical(src, dst):
                raise SetupError(f"Destination changed after preflight: {dst}")
            continue
        # Exclusive creation prevents a concurrent installer from overwriting a file.
        with src.open("rb") as incoming, dst.open("xb") as outgoing:
            shutil.copyfileobj(incoming, outgoing)
            os.fchmod(outgoing.fileno(), stat.S_IMODE(os.fstat(incoming.fileno()).st_mode))
    if dependencies:
        for directory in plan.dependencies:
            _check_ancestors(directory / "node_modules")
            subprocess.run(
                _dependency_command(directory),
                cwd=directory, check=True,
            )
    return plan


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", type=Path, default=Path.home() / ".pi/agent", help="destination (default: ~/.pi/agent)")
    parser.add_argument("--apply", action="store_true", help="copy files; without this flag, only preview")
    parser.add_argument("--dependencies", action="store_true", help="also run npm ci with scripts disabled in copied locked packages (only with --apply)")
    args = parser.parse_args(argv)
    try:
        install(SOURCE, args.target, apply=args.apply, dependencies=args.dependencies)
    except (SetupError, OSError, subprocess.CalledProcessError) as error:
        print(f"setup: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
