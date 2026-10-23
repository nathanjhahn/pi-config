# Nathan's Pi setup

My personal [Pi](https://pi.dev) customizations, packaged so I can set up a new computer without reconstructing them from chat history.

**Goal:** clone → install prerequisites → preview/apply configuration → authenticate → verify the workflows below. This is a reviewed configuration/source backup, **not** a backup of credentials, conversations, memory, browser logins, or paired devices.

Based on [Amos Blomqvist's pi-config](https://github.com/amosblomqvist/pi-config). The original extensions, skills, deprecated examples, and Git history are retained; my active setup and local adaptations are described here. See [provenance](docs/provenance.md).

## What's customized

| Layer | What it adds | Source |
|---|---|---|
| Global instructions | Engineering workflow, safety, verification, memory-aware delegation | `config/agent/AGENTS.md` |
| Terminal UI | NH monogram header, width-aware rendering | `extensions/custom-header.ts` |
| Human decisions | Structured single-question dialogs, choices and free-form answers | `extensions/ask-user-question.ts` |
| Shell guard | Heuristic confirmations / subagent hard blocks; **not a sandbox** | `extensions/bash-guard/` |
| Browser tools | Opt-in Playwright browser, DOM/console/network inspection; persistent profile | `extensions/browser/` |
| Prompt snippets | Toggle reusable instructions for a single message with `/snippets` | `extensions/prompt-snippets/` |
| Skills | Session analysis, PDF reading, frontend debugging, YouTube transcripts | `skills/` |
| Subagents | Async tmux panes, scout/researcher/worker roles, local host/tool-resolution patches | `local-packages/pi-interactive-subagents/`, `config/agent/agents/` |
| Memory | Locally modified observational memory, durable OKF concepts, checkpointing and project curation | `local-packages/pi-observational-memory/` |
| Web tools | Pinned `pi-web-search` and `pi-web-fetch` packages | `config/agent/settings.json` |
| Mesh / workspace / MCP | Pinned `remote-pi`, `pi-workbench`, `pi-mcp-adapter` | `config/agent/settings.json` |

The installer uses an **explicit allowlist**. Historical `extensions/web-search`, `extensions/web-fetch`, stub directories, `deprecated/`, and assets are retained for reference but are **not installed**. Do not copy all of `extensions/` into Pi: that would duplicate tools now supplied by packages.

## Fresh-machine setup

> **Known dependency advisories:** the preserved bash-guard lockfile pins `shell-quote@1.8.3`. The isolated install reported a critical `quote()` issue and a high-severity `parse()` denial-of-service issue. The extension uses `parse()`. This snapshot intentionally retains the exact dependency at my request; review [security notes](docs/security.md#known-dependency-advisories) before installing. A successful restore is not a clean security audit.

### 1. Prerequisites

Primary target: **macOS or Linux with tmux**. Native Windows is not covered; use WSL for the tmux workflows.

- Node.js **22.19+**, npm, Python 3.10+, Git, and tmux.
- Optional: `gh` for GitHub workflows; `uv` for web-fetch's Python extraction; `yt-dlp` for YouTube captions.

On macOS, after installing Homebrew:

```sh
brew install node python tmux git gh uv yt-dlp
```

Install the Pi version used for this snapshot (or use the [official installer](https://pi.dev) and evaluate newer versions separately):

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.4.0
pi --version
```

### 2. Clone, preview, apply

```sh
git clone https://github.com/nathanjhahn/pi-config.git
cd pi-config
python3 scripts/setup.py                         # preview only; writes nothing
python3 scripts/setup.py --apply --dependencies  # copy + install local npm dependencies
```

The destination defaults to `~/.pi/agent`. Override with `--target /path/to/agent`.
**Existing differing files cause an error before copying.** There is no overwrite switch. For an existing installation, use a fresh target and manually merge only what you want. Identical source/config files are safe to reapply; this is a bootstrap tool, not a settings synchronizer. **Exception:** explicitly passing `--dependencies` runs `npm ci`, which replaces existing generated `node_modules` trees in the three local dependency roots. Omit that flag when you only want the non-overwriting file check/copy.

The dependency step uses lockfiles and disables lifecycle scripts. It skips npm installation in the subagent package, whose original development dependencies are not its runtime dependencies. It does not install Pi itself, managed Pi packages, browser binaries, Python environments, credentials, or shell configuration.

Reconcile the pinned managed packages explicitly (this downloads third-party code):

```sh
pi update --extensions
```

The top-level npm package versions are pinned; Pi-managed packages' **transitive** trees are not locked by this repo. See [inventory and limitations](docs/provenance.md).

### 3. Browser and PDF dependencies

Playwright's browser tool and Puppeteer's web-fetch tool use **different** browser installations:

```sh
# Browser extension: use the CLI from its locked playwright-core dependency.
(cd ~/.pi/agent/extensions/browser && node node_modules/playwright-core/cli.js install chromium)

# Web fetch: explicitly download Chrome if package installation skipped it.
(cd ~/.pi/agent/npm && npx --no-install puppeteer browsers install chrome)

# PDF skill: build a new environment; never copy a venv across machines.
python3 -m venv ~/.pi/agent/skills/pdf-reader/.venv
~/.pi/agent/skills/pdf-reader/.venv/bin/pip install -r ~/.pi/agent/skills/pdf-reader/requirements.txt
```

On Linux, browsers may also require distribution-specific system libraries. `uvx` must be on PATH for web-fetch extraction (alternatively its supported `pipx`/`pip-run` runners). The first extraction downloads trafilatura. See the installed package README if browser/extraction setup fails.

### 4. Authenticate and choose models

Start from a project directory inside tmux:

```sh
tmux new -A -s pi
cd /path/to/project
pi
```

In Pi, use `/login`, then `/model`; save a startup default with **Ctrl+S**. A saved default is important because subagents launch new Pi processes. Their public definitions omit my private proxy model selection and use Pi's normal startup model selection; they do **not** necessarily inherit a model selected only in the parent's current session. Keep each role's low/medium/high thinking setting or adapt it to your model.

Web search needs a model/provider supported by `pi-web-search`. If your normal coding model is unsupported, configure a separate authenticated search model; see [optional integrations](docs/integrations.md).

### 5. Opt into memory and external integrations

The public settings intentionally differ from my live setup:

- Project trust is **ask**, not automatic trust.
- No device ID, default/private model scope, credentials, or endpoint URLs are copied.
- Observational memory starts **passive**, with automatic project publication disabled. Configure models and consciously enable it before use: [memory setup](docs/integrations.md#observational-memory).
- MCP uses the adapter and disables Pi's built-in MCP to avoid two competing implementations. No servers or credentials are bundled.
- Remote devices must be paired again; browser logins start empty.

See [optional integrations](docs/integrations.md) for proxy routing, memory, web search, MCP, remote pairing, and workbench CLI setup.

## Acceptance test: can I use a new computer?

Run the offline repository checks first:

```sh
python3 -m unittest discover -s tests -v
python3 scripts/check_public.py
```

Then follow the [fresh-machine checklist](docs/validation.md). The offline tests verify restoration safety, **not** provider access or end-to-end Pi compatibility. The checklist separately covers extension loading, dialogs, browser navigation, skill scripts, a complete tmux subagent round trip, and optional integrations. Those live checks may make network requests and spend model tokens; run them deliberately with fixtures, not private projects.

Restart Pi after initial installation. For later resource edits use `/reload`; package changes and native dependencies may require a full restart.

## Keeping this current

Edit/review source in this repo, test in an isolated target, and only then copy or merge into the live installation. When changing an installed customization first, bring **only that reviewed source change** back here. Do not recursively copy `~/.pi` or run `git add .` without checking the publication boundary.

- [Integration setup](docs/integrations.md)
- [Fresh-machine verification and recorded results](docs/validation.md)
- [Sources, local patches, and package inventory](docs/provenance.md)
- [Public sharing boundary](docs/security.md)
