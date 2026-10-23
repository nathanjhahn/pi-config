# Optional integrations and machine-local setup

These steps happen **after** the baseline install. Commands here use the default `~/.pi/agent`; substitute your target if different. Never commit filled-in credential or server configuration.

## Compatible proxy routing

Pi works without my separate CLIProxy service. `config/models.example.json` illustrates an OpenAI-compatible proxy with an environment-sourced API key. The loopback URL/port is an example, not an assertion about an installed server.

1. Install/configure your proxy separately; this repo does not provision that service, its upstream logins, model aliases, or network access.
2. Copy the example to `~/.pi/agent/models.json` **only if that file does not already exist**. Otherwise merge the provider manually.
3. Replace the URL, API type and model ID with values actually supported by your server.
4. Supply `CLIPROXY_API_KEY` from a private shell environment or secret manager. Do not put the literal key in Git.
5. Open `/model`, select the configured model, and save with Ctrl+S. Set agent `model: provider/id` frontmatter only if you want a role to use a specific model.

The live configuration had proxy-specific model lists and a command that obtained a key from a local file. Those are deliberately not reproduced. The public example uses Pi's documented `${NAME}` interpolation instead of executing a credential command.

## Observational memory

**This can send conversation chunks to model providers, spend tokens, spawn Pi workers, and write durable project files.** It is not merely a local text cache.

The vendored source has an enabled-by-default session gate. Its source defaults also include model choices and automatic project publication. The public `config/agent/settings.json` overrides that with `passive: true` and `autoPromote: false`; do not remove those overrides accidentally.

To use it, merge the following into your **installed** settings, replacing both model selections with authenticated models available on that machine:

```json
{
  "observational-memory": {
    "passive": false,
    "autoPromote": false,
    "models": {
      "observer": { "provider": "your-provider", "id": "your-model", "thinking": "low" },
      "consolidator": { "provider": "your-provider", "id": "your-model", "thinking": "medium" }
    }
  }
}
```

Restart or `/reload`, then inspect `/om:status`. `/om on` alone does **not** override passive mode. `PI_OM_PASSIVE=1` forces passive mode regardless of settings.

- `/om on` / `/om off`: persisted session gate.
- `/om:save`: explicit checkpoint; may observe, consolidate, and write durable session memory.
- `/om:promote`: create a project-memory proposal; review its artifacts before `/om:promote apply <id>`.
- `autoPromote: true`: opt into automatic conflict-free project-memory publication after consolidation/checkpointing. This writes local `.memory/project/`, **not GitHub**, and is not human verification.

Add `.memory/` to each project's ignore rules before using memory there. No historical concepts, pending proposals, or conversations are included in this configuration repository. Read the [vendored memory README](../local-packages/pi-observational-memory/README.md) for lifecycle, cost, publication-lock and provenance semantics. Its source defaults are not the public bootstrap defaults.

## Web search and fetch

The managed packages are pinned in settings. Their READMEs are available under `~/.pi/agent/npm/node_modules/pi-web-search/` and `pi-web-fetch/` after reconciliation.

`pi-web-search` supports particular provider/model integrations; an arbitrary compatible coding endpoint may not support search. If needed create **machine-local** `~/.pi/agent/web-search.json`:

```json
{ "provider": "your-supported-provider", "model": "your-search-capable-model" }
```

Authenticate that provider separately. There is no automatic fallback from an unsupported current model. No filled-in search configuration is shipped.

Web-fetch optional distillation uses model calls, and large raw pages can also trigger summarization. Its browser and extraction downloads are described in the main README. The pinned package still uses legacy Pi imports; compatibility with the selected host must be checked at startup, not assumed from the package version alone.

## MCP adapter

This setup uses `pi-mcp-adapter@6.0.0`. It deliberately sets `extensions: ["-builtin:mcp"]` so the adapter and built-in implementation do not both own MCP.

After restarting Pi, use the adapter's `mcp` tool to install an endpoint you trust and complete its authentication flow. Server commands, URLs, access headers, OAuth state and executable dependencies must be set up on each computer. None are backed up here. Consult the installed adapter README for its configuration format; do not assume Pi's built-in MCP CLI/configuration is interchangeable with the adapter.

To use built-in MCP instead, remove the adapter package declaration **and** remove `-builtin:mcp`, then configure built-in MCP per the documentation for your Pi version. Review settings after adapter installs/updates because the adapter can modify the built-in MCP toggle.

## Remote agent network

Run `/remote-pi` for its setup wizard. For a local test, use two Pi terminals in a fixture directory and follow the package's local mesh instructions. The package deploys its own `agent-network` skill; we do not independently copy that generated skill into the global skill directory.

For cross-device/mobile access, configure your own relay and pair the new machine again. Do not copy `~/.pi/remote/`, identity/keyring material, `peers.json`, private relay URLs or pairing state into this repo. A relay can see routed plaintext and metadata; this is **not** a claim of end-to-end encryption. Review the installed package's security documentation before enabling remote access.

## Workbench

`pi-workbench` adds a tmux session sidebar. After package reconciliation, check:

```sh
command -v pi-workbench
```

If not on PATH, the managed installation's CLI can be invoked directly:

```sh
~/.pi/agent/npm/node_modules/.bin/pi-workbench doctor
~/.pi/agent/npm/node_modules/.bin/pi-workbench
```

Optionally add `~/.pi/agent/npm/node_modules/.bin` to your shell PATH manually. This repo does not rewrite shell startup files or tmux settings. Inspect the installed workbench README for extended-key terminal configuration if shortcuts fail. Workbench registry/session state is not restored.
