#!/usr/bin/env python3
"""Heuristic publication guard for tracked + non-ignored files; never prints secrets.

Not a DLP system or a history audit. Run from any cwd inside a source checkout.
"""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
FORBIDDEN_PARTS = {
    '.memory', '.pi', '.profile', 'node_modules', '.venv', '__pycache__',
    'sessions', 'research',
}
FORBIDDEN_NAMES = {
    'auth.json', 'cliproxy-api-key', 'models-store.json', 'mcp.json',
    '.mcp.json', 'mcp-adapter.json', 'peers.json', 'models.json',
}
PATTERNS = [
    ('private key', re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----')),
    ('GitHub token', re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b')),
    ('provider token', re.compile(rb'\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b')),
    ('AWS access key', re.compile(rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b')),
    ('personal absolute path', re.compile(rb'(?:/Users/|/home/)' + rb'nathanhahn/')),
]


def main():
    result = subprocess.run(
        ['git', '-C', str(ROOT), 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        check=True, stdout=subprocess.PIPE,
    )
    failures = []
    count = 0
    for name in sorted(set(result.stdout.decode().split('\0')) - {''}):
        relative = Path(name)
        path = ROOT / relative
        if (set(relative.parts) & FORBIDDEN_PARTS or relative.name in FORBIDDEN_NAMES
                or relative.name == '.env' or relative.name.startswith('.env.')
                or relative.suffix in {'.key', '.pem', '.pyc'}):
            failures.append((name, 'private/generated filename'))
        if path.is_symlink():
            failures.append((name, 'symlink requires manual review'))
            continue
        if not path.is_file():  # Deleted tracked files are not publication candidates.
            continue
        count += 1
        data = path.read_bytes()
        for reason, pattern in PATTERNS:
            if pattern.search(data):
                failures.append((name, reason))
    for name, reason in failures:
        print(f'FAIL {name}: {reason}', file=sys.stderr)
    if failures:
        print('Review these paths before staging or publishing.', file=sys.stderr)
        return 1
    print(f'PASS: {count} publication candidates checked (heuristic; history not scanned).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
