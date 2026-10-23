# Inventory and provenance

Snapshot prepared **2026-10-23**, from installed configuration and current source, not from past session transcripts. Capturing source is not proof that every workflow works on a fresh machine.

## Original configuration

This repository originated from [amosblomqvist/pi-config](https://github.com/amosblomqvist/pi-config). The pre-customization checkout's latest commit was `f82da56` (`6 month config refresh: add new extensions/skills and retire old ones to deprecated/`). Original Git history, authorship, examples and deprecated resources remain. Do not infer that I authored the entire collection or that every historical example is active.

Active extensions/skills were compared with the installed copies. The skills and prompt snippets matched; installed extension differences captured here include:

- `custom-header.ts`: NH monogram, current host imports, width truncation.
- `ask-user-question.ts`, `bash-guard/index.ts`: current `@earendil-works` host imports and `typebox` where used.
- `browser/index.ts`: installed user-agent/`navigator.webdriver` adaptations. These are browser-environment tweaks, not a guarantee of access to any site or permission to bypass a site's policies.

The global instruction file is stored under `config/agent/AGENTS.md` rather than repo root so it is explicitly deployed as personal instructions. The three role definitions preserve installed instructions and thinking levels but omit private model selections.

## Host and managed packages

| Component | Snapshot version/source | Reproduction notes |
|---|---|---|
| Pi | `@earendil-works/pi-coding-agent@1.4.0` | Node 22.19+; npm example pins only the top-level host version |
| Web search | `pi-web-search@1.7.0` | [ttttmr/pi-web-search](https://github.com/ttttmr/pi-web-search); separate model support/authentication |
| Web fetch | `pi-web-fetch@1.1.0` | [georgebashi/pi-web-fetch](https://github.com/georgebashi/pi-web-fetch); Puppeteer + Python extraction runner |
| Remote network | `remote-pi@0.7.0` | [jacobaraujo7/remote_pi](https://github.com/jacobaraujo7/remote_pi); fresh pairing, native keyring dependencies |
| Workbench | `pi-workbench@0.2.0` | [dmallory42/pi-workbench](https://github.com/dmallory42/pi-workbench); tmux + CLI PATH |
| MCP adapter | `pi-mcp-adapter@6.0.0` | [nicobailon/pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter); per-server setup/authentication |

These versions were read from installed package manifests and then pinned in the public settings. No existing `~/.pi/agent/npm` installation, npm cache or node_modules tree is copied. The top-level version pins do **not** lock Pi-managed transitive dependencies; this is reproducible configuration and preserved local source, not a hermetic runtime image. Native binaries/browser downloads also vary by OS/architecture.

Some pinned packages retain legacy `@mariozechner` imports/peers, notably web-fetch and workbench. The installed host's compatibility mapping may matter. Fresh-host startup and live acceptance remain separate checks; do not silently upgrade or rewrite third-party packages merely to hide a compatibility failure.

## Vendored subagent package

- Upstream: [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents).
- Base: `c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7`, package version `3.7.2`.
- Installed changes: `pi-extension/subagents/index.ts`, `subagent-done.ts`, `tools/safe-bash.ts` use the current host/typebox imports. `getToolExtensionPath` also resolves managed `pi-web-search`/`pi-web-fetch` backing extensions so restricted research agents can use them.
- Runtime source, bundled agents, tests, manifest, original development lockfile and MIT `LICENSE` are retained. Nested Git metadata and local-only installation notes are not copied.
- **No runtime npm install is required.** The manifest/lockfile still describe upstream's legacy development environment. The bootstrap deliberately skips dependency installation here; upstream development tests need their own compatible harness/dependencies.
- User-level definitions in `config/agent/agents/` override bundled model-specific agents. Role tool allowlists are not OS-level isolation; agents can share a working tree.

## Vendored memory package

- Original upstream: [amosblomqvist/pi-observational-memory](https://github.com/amosblomqvist/pi-observational-memory).
- Local maintained source checkout: `pi-observational-memory`, commit `7fcf839062cab354914d997b3f90fbd6f8c67fd9` at capture. Its `src/` tree matched the installed copy by recursive comparison. This records a local source identity, not a promise that the commit is published upstream.
- Manifest name `observational-memory`, version `0.1.0`. The directory name used in settings remains `pi-observational-memory`.
- Preserved local implementation includes enabled-by-default session gating, durable OKF v0.2 session/project concepts, checkpointing, project curation/publication controls, bounded static repository inspection, and lifecycle/cost handling. See its source and README for the complete contract.
- Runtime dependencies `ignore` and `yaml` are installed from its retained lockfile, omitting development dependencies and leaving host peers to Pi.
- Source, worker extensions, fixtures/tests, manifest/lockfile, TypeScript/Vitest configuration and MIT `LICENSE` are retained. Generated dependencies, planning notes, memory data, sessions and proposals are excluded.

**Public bootstrap override:** passive memory, manual-only publication, no preselected worker models. This is an intentional safety/portability difference from the live setup, not an exact clone of live behavior.

## Updating

1. Review upstream/local changes and record the new source version or commit here.
2. Preserve local patches intentionally, rather than replacing vendored code with an unpatched upstream release.
3. Update lockfiles only in a dedicated development environment; do not install legacy host dependencies into the live agent directory.
4. Test the deployment scripts and a fresh staged installation, then run the live checklist for affected workflows.
5. Inspect the public-sharing boundary before staging files. Keep each component's existing attribution/license; no blanket license is asserted for the entire inherited collection.
