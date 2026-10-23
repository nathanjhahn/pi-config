# Fresh-machine acceptance checklist

A complete pass means the setup works on a **new computer**, not just that the files copied or the tests passed. Use disposable projects/files and dedicated test services. Network/model checks may incur charges; do not run them automatically against personal state.

## Recorded checks — 2026-10-23

Environment: macOS, Python 3.15.0, Node 26.3.0. This is the preparation computer, **not a second clean machine**. Minimum-version/other-OS compatibility has not been exercised.

| Check | Result | Scope |
|---|---|---|
| Python unittest suite | **36 passed** | Isolated fixtures; dry-run, exact allowlist, idempotence, preflight conflicts, symlink protection, dependency command construction/failure propagation, publication guard |
| Real source restore | **Passed, 143 files** | Fresh temporary target, dry-run with no writes, apply, compare/check copied files, repeat apply |
| Real local npm dependency installs | **Passed with security warning** | Locked bash-guard, browser and memory dependencies installed in temporary target; script execution disabled, memory dev deps omitted |
| npm audit details | **Known findings retained** | `shell-quote@1.8.3`: critical `quote()` and high `parse()` advisories; explicitly retained at owner's request. Browser/memory runtime installs reported zero findings at this check. See [security notes](security.md#known-dependency-advisories). |
| Publication heuristic | **Passed** | Current tracked + non-ignored candidate files only; no history audit, no comprehensive DLP claim |
| `git diff --check` | **Passed** | Whitespace check for tracked changes |
| Pi runtime loading / UI / providers | **Not run** | Would require a separate isolated runtime/service acceptance pass |
| Browser downloads / navigation / PDFs | **Not run** | No browser download, application login or Python environment creation used for this verification |
| Managed Pi package reconciliation | **Not run** | Pinned installed versions were inspected, but not freshly fetched/loaded as a complete set |
| tmux subagent round trip / memory workers / remote / MCP / workbench | **Not run** | No live project state, pairing or token-spending tests used |

The temporary restore directory was removed after verification. The live `~/.pi` installation was not changed. A passing restore is **not yet a full fresh-machine acceptance pass**.

## 1. Offline repository checks

```sh
python3 -m unittest discover -s tests -v
python3 scripts/check_public.py
git diff --check
```

To manually preview/apply without touching the normal installation, choose a new **physical path with no symlink ancestors** (on macOS, `/tmp` is a symlink; resolve your temporary path first):

```sh
TARGET="$(python3 -c 'import pathlib,tempfile; print(pathlib.Path(tempfile.mkdtemp(prefix="pi-config-check-")).resolve() / "agent")')"
python3 scripts/setup.py --target "$TARGET"
python3 scripts/setup.py --target "$TARGET" --apply --dependencies
python3 scripts/setup.py --target "$TARGET" --apply
```

The last command should keep identical files, not rewrite them. Inspect the target and remove only the temporary directory you created when done. An installer target alone is **not** full runtime isolation: integrations can use home directories, OS keyrings, browsers or background brokers outside the agent directory. Use a disposable OS account/container/VM before running the entire stack if testing must not touch personal runtime state.

## 2. Fresh-machine installation

- [ ] Follow the README starting with prerequisites, not an already-populated agent directory.
- [ ] Verify `node --version`, `npm --version`, `python3 --version`, `tmux -V`, `pi --version` and that `pi` is on PATH inside tmux.
- [ ] Preview then apply; record file conflicts rather than bypassing them.
- [ ] Install local dependencies and reconcile all pinned managed packages. Record npm audit warnings; do not weaken checks or auto-fix the snapshot silently.
- [ ] Download both browser engines, prepare the PDF environment, and install optional extraction/transcript tools.
- [ ] Authenticate a supported provider and save a working startup model. Confirm no proxy is needed for the baseline.
- [ ] Start Pi in a disposable fixture project, review the trust prompt, and inspect startup diagnostics for extension/import errors or duplicate tools. Restart after package changes.

## 3. Core workflow checks

Some of these require model calls.

- [ ] Header: NH monogram is present and fits a narrow terminal without render errors.
- [ ] Question dialog: ask Pi to call `ask_user_question` with choices; select an option, then test an Other/free-form answer and cancellation.
- [ ] Shell guard: use harmless representative commands; confirm the approval UI and choose Abort. **Do not test by executing destructive commands.**
- [ ] Snippets: toggle a snippet with `/snippets`, verify it affects only the intended next message, then resets.
- [ ] Browser: use `/browser on` and a disposable local HTTP fixture page. Navigate, inspect a known DOM value, capture console/network, fill/click and take a screenshot. Use `/browser off` and confirm teardown. Use a temporary `PI_BROWSER_PROFILE`, not normal application cookies.
- [ ] Skills: check discovery of the four global skills. Run session-analysis scripts only on fixture session data, PDF scripts on a generated one-page PDF, and transcript fetching on a deliberately selected public video. Test failures for missing tools/no captions without private inputs.
- [ ] Web search/fetch: request a benign public topic/page using supported authenticated models. Verify browser/extraction setup and model selection. Record any legacy-host import failure explicitly.
- [ ] Subagents: from tmux, ask scout to inspect a tiny fixture project. Confirm a child pane starts, it uses an authenticated model, and the completion result arrives automatically without polling. Exercise researcher web tools and worker file edits in separate fixture scopes. Check cancellation and shutdown cleanup.

## 4. Optional integrations

- [ ] Memory: confirm public startup is passive. Configure authenticated observer/consolidator models, then intentionally enable in a disposable project. Exercise `/om:status` and `/om:save`; verify costs and session files. With `autoPromote: false`, verify project publication waits for explicit proposal review/apply. Never use historical personal memory as test input.
- [ ] MCP: with the adapter as the only MCP implementation, install one approved test server, authenticate and call a harmless read-only tool. Restart and check reconnection.
- [ ] Remote mesh: use two fixture Pi sessions to confirm discovery/message delivery. Pair a new device only if intended; verify identity/authentication rather than copying old pairing state.
- [ ] Workbench: run `doctor`, open the sidebar in a disposable tmux workspace, switch sessions and verify required keybindings.
- [ ] Optional proxy: configure the example with a real locally provisioned service and verify its chosen model. Baseline success must not depend on this step.

Record OS/architecture, versions, commands, expected/actual outcomes, skipped checks and any fixes. Do not mark unchecked items complete merely because the source looks correct.
