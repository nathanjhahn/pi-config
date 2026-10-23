# Public sharing boundary

## Included

Reviewed source files, instructions, role definitions, skills/scripts, dependency manifests/lockfiles, portable settings, optional placeholder configuration, tests and documentation.

## Never copy wholesale

- `auth.json`, API keys, secret-manager output, `.env*`, private keys/certificates.
- Live `models.json`, credential commands, custom provider headers, private endpoint URLs and model catalog caches.
- MCP server configs, OAuth stores, import caches and server-specific environment variables.
- `~/.pi/remote/` identities, peers, pairing tokens, relay config; keyring credentials.
- `~/.pi/workbench/` registries, session metadata, project paths.
- Pi session transcripts, exported conversations, `.memory/`, worker IPC, proposals, research notes and logs.
- Browser `.profile/` directories, cookies, localStorage or downloaded artifacts.
- Installed Pi binaries, `node_modules`, npm caches, browser binaries, Python virtual environments and generated build outputs.

The ignore file protects common locations, including the pre-existing untracked `.memory/` and `research/` directories. They were not read or incorporated into this setup. **Ignore rules do not untrack files or remove historical commits.**

## Before staging/publishing

```sh
python3 scripts/check_public.py
git status --short
git diff --check
git diff --stat
```

Review new files as well as the tracked diff, then stage explicit reviewed paths. Inspect `git diff --cached` before committing. The check script includes tracked and untracked non-ignored files, flags common secret/state filenames and a few token/private-key patterns, and reports paths/reasons without printing matched contents.

This is a **heuristic guard**, not comprehensive secret detection, content approval, or a Git-history scan. It does not identify every credential format, private URL, personal detail, binary payload or false negative. GitHub secret scanning or an independent dedicated scanner is recommended before public publication. Previously public history/forks cannot be made private by editing the current tree. Rotate any exposed credential rather than relying on deletion.

## Known dependency advisories

The real isolated dependency install on **2026-10-23** reported vulnerabilities in the inherited bash-guard dependency **`shell-quote@1.8.3`**:

- **Critical:** [`GHSA-w7jw-789q-3m8p`](https://github.com/advisories/GHSA-w7jw-789q-3m8p), `quote()` does not escape newlines in object `.op` values; affected range `>=1.1.0 <=1.8.3`.
- **High:** [`GHSA-395f-4hp3-45gv`](https://github.com/advisories/GHSA-395f-4hp3-45gv), quadratic-complexity denial of service in `parse()`; affected range `<=1.8.4`.

The extension imports **`parse()`**, so the parser advisory is directly relevant; this is not a claim that the `quote()` exploit path is exercised. At the owner's explicit request, the source/lockfile remains an **exact snapshot**, without an automatic dependency fix or change to the live installation. Do not treat this guard as a security boundary. Before deploying into an environment where this risk is unacceptable, review and test a patched dependency in a separate change or omit the guard intentionally. Do not run a blanket `npm audit fix` across this collection.

The browser and memory runtime dependency installs reported zero vulnerabilities at that check. Managed Pi packages and the host were **not** audited by this install; no whole-setup clean-bill-of-health is implied.

## Runtime trust

Pi extensions run with the user's OS permissions. Skills can instruct the agent to run programs. The shell guard and role tool lists are helpful controls, not sandboxes. Review source and package trust before installation. `npm ci` can replace generated `node_modules` content, although this installer disables lifecycle scripts.

The browser extension retains future logins locally and can expose sensitive page/network state to the model. Use disposable profiles and fixture services for tests. Memory sends selected conversation material to configured providers and writes durable local project knowledge. Remote relay operators can observe routed plaintext. Configure these features deliberately; this repository does not grant permission to use personal application state or paid APIs for tests.
