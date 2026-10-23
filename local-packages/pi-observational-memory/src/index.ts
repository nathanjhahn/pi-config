/**
 * Observational memory — ORCHESTRATOR (master-side, in-process).
 *
 * The conductor: owns the clocks/triggers, spawns subprocess workers, commits their output to
 * the ledger (observations) or files (long-term, Phase B), renders compaction, and drives the
 * TUI. Event-driven only — no daemon.
 *
 * Enabled by default for new sessions in this local installation. Explicit session gate
 * choices survive resume. When the gate is off, every handler returns at its first line
 * and the extension is completely invisible.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactCommand } from "./commands/compact.js";
import { registerConsolidateCommand } from "./commands/consolidate.js";
import { registerPromoteCommand } from "./commands/promote.js";
import { registerSaveCommand } from "./commands/save.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidatorTrigger } from "./hooks/consolidator-trigger.js";
import { registerObserverTrigger } from "./hooks/observer-trigger.js";
import { OM_ENABLED, type Entry } from "./ledger/index.js";
import { ensureSessionMemory } from "./memory/session.js";
import { renderProjectDiscovery } from "./memory/project.js";
import { Runtime } from "./runtime.js";

function readGateFromLedger(branch: Entry[]): boolean {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === OM_ENABLED) {
			return (entry.data as { enabled?: boolean } | undefined)?.enabled ?? false;
		}
	}
	return true;
}

export default function observationalMemory(pi: ExtensionAPI): void {
	const runtime = new Runtime();

	function attachIfEnabled(ctx: any): void {
		if (runtime.enabled && ctx.mode === "tui" && ctx.hasUI && ctx.ui) {
			runtime.status.attach(ctx.ui);
		} else {
			runtime.status.detach();
		}
	}

	pi.on("session_start", (_event: unknown, ctx: any) => {
		// A reused extension runtime must not let old session continuations publish or commit.
		runtime.status.detach();
		runtime.abortAllWorkers();
		runtime.memoryRoot = "";
		runtime.configLoaded = false;
		runtime.ensureConfig(ctx.cwd);
		runtime.dispatchedCoversUpToId = undefined;
		const branch = ctx.sessionManager.getBranch() as Entry[];
		runtime.enabled = readGateFromLedger(branch);
		if (runtime.enabled) runtime.memoryRoot = ensureSessionMemory(ctx);
		attachIfEnabled(ctx);
		runtime.refreshFooterGauges(branch, ctx.getContextUsage?.()?.tokens ?? null);
		runtime.refreshCost(ctx.sessionManager.getEntries() as Entry[]);
	});

	// Structured, summary-only discovery on the first run and subsequent runs; no corpus or
	// new ledger/source message. Pi can emit a small section delta when project memory changes.
	pi.on("before_agent_start", (event, ctx) => {
		const discovery = runtime.enabled && !runtime.config.passive ? renderProjectDiscovery(ctx.cwd) : undefined;
		if (discovery) event.systemPromptOptions.sections.om_project_memory = discovery;
		else delete event.systemPromptOptions.sections.om_project_memory;
	});

	// Tree navigation changes branch identity even when the session ID is unchanged.
	pi.on("session_before_tree", () => {
		runtime.abortAllWorkers();
		runtime.dispatchedCoversUpToId = undefined;
	});

	pi.on("session_shutdown", () => {
		runtime.status.detach();
		runtime.abortAllWorkers();
	});

	pi.registerCommand("om", {
		description: "Toggle observational memory for this session (/om on, /om off)",
		handler: async (args: string, ctx: any) => {
			const arg = (args ?? "").trim().toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !runtime.enabled;
			if (next === runtime.enabled) {
				if (ctx.hasUI) ctx.ui.notify(`om already ${next ? "on" : "off"}`, "info");
				return;
			}
			runtime.enabled = next;
			pi.appendEntry(OM_ENABLED, { enabled: next });
			if (next) {
				runtime.memoryRoot = ensureSessionMemory(ctx);
				attachIfEnabled(ctx);
				runtime.refreshFooterGauges(ctx.sessionManager.getBranch() as Entry[], ctx.getContextUsage?.()?.tokens ?? null);
				runtime.refreshCost(ctx.sessionManager.getEntries() as Entry[]);
			} else {
				runtime.abortAllWorkers();
				runtime.status.detach();
			}
			if (ctx.hasUI) ctx.ui.notify(`om ${next ? "enabled" : "disabled"}`, "info");
		},
	});

	// Triggers + hook self-gate on runtime.enabled / passive at their first line.
	registerObserverTrigger(pi, runtime);
	registerConsolidatorTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerSaveCommand(pi, runtime);
	registerStatusCommand(pi, runtime);
	registerCompactCommand(pi, runtime);
	registerConsolidateCommand(pi, runtime);
	registerPromoteCommand(pi, runtime);
}
