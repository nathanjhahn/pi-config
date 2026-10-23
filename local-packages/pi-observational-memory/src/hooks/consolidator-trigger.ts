/**
 * Phase B consolidator clock. When the active observation pool crosses
 * `consolidateAtPoolTokens`, promote the oldest observations (above `poolTargetTokens`) into
 * durable `.memory/` concepts via a subprocess consolidator, validate syntax/regenerate the
 * index, then tombstone the handed batch intersected with observations still active.
 *
 * Runs in the BACKGROUND, mirroring the observer trigger (turn_end / agent_start), strictly
 * one at a time (design risk 4). Compaction does not wait for it (R5).
 *
 * Tombstone safety (design risk 4): the orchestrator tombstones the batch it handed the
 * consolidator, intersected with what is STILL active at exit — never an observation an
 * observer committed during the run (those are not in the handed batch). The consolidator does
 * not report back: it must consolidate everything it was given (filing or discarding junk is a
 * valid outcome), so after a clean exit and syntax validation we trust it and drop the batch.
 * Malformed bundles retain observations. A flaked-out partial run is recoverable from the worker's global session
 * recording (the standing safety net for lossy rewrites) and is the critic tier's job to catch.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	OM_OBSERVATIONS_DROPPED,
	foldLedger,
	lastSourceEntryId,
	observationToLine,
	poolTokens,
	selectPromotionOverflow,
	sortObservations,
	type Entry,
	type Observation,
} from "../ledger/index.js";
import { nowTimestamp } from "../ledger/serialize.js";
import { renderIndexFile } from "../memory/index-render.js";
import { atomicWrite, indexPath, listIndexConcepts, readJourney, validateMemoryBundle } from "../memory/paths.js";
import type { Runtime } from "../runtime.js";
import { buildWorkerArgv, buildWorkerEnv, spawnWorker } from "../spawn/launch.js";
import { recordWorkerCost } from "./observer-trigger.js";
import { captureMemoryScope } from "../memory/work-scope.js";
import { runAutomaticPromotion, type PromotionResult } from "./promotion-trigger.js";

type TriggerCtx = {
	cwd?: string;
	hasUI: boolean;
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	sessionManager: { getSessionId?: () => string; getBranch: () => Entry[]; getEntries: () => Entry[] };
	getContextUsage?: () => { tokens: number | null } | undefined;
};

let runCounter = 0;

function nextRunId(): string {
	runCounter += 1;
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	return `cons-${stamp}-${process.pid}-${runCounter}`;
}

/**
 * Build the consolidator's `-p` prompt: current time + current index + current journey + the
 * overflow lines. The journey body is included so the consolidator updates it in place
 * (append a segment for this batch; compress the old tail only if over `journeyTargetTokens`).
 */
export function buildConsolidatorPrompt(memoryRoot: string, promote: Observation[], journeyTargetTokens: number): string {
	const indexText = renderIndexFile(listIndexConcepts(memoryRoot));
	const journeyText = readJourney(memoryRoot);
	const journeyWords = Math.round((journeyTargetTokens * 3) / 4);
	const obsLines = sortObservations(promote).map(observationToLine).join("\n");
	return (
		`Current local time: ${nowTimestamp()}\n\n` +
		"You are folding the observations below into the durable topic files under .memory/. " +
		"Use this local time only for dated journey body headings. The tools, not you, stamp generated.by and generated.at (ISO UTC) on meaningful concept writes.\n\n" +
		"===== CURRENT MEMORY INDEX (generated; do not edit index.md) =====\n" +
		`${indexText}\n` +
		"===== END MEMORY INDEX =====\n\n" +
		"===== CURRENT JOURNEY BODY (journey.md — Session History; metadata omitted here) =====\n" +
		`${journeyText ?? "(empty — no journey yet; start one)"}\n` +
		"===== END JOURNEY =====\n\n" +
		"===== OBSERVATIONS TO CONSOLIDATE (each line is `<timestamp-id>  <content>`) =====\n" +
		`${obsLines}\n` +
		"===== END OBSERVATIONS =====\n\n" +
		"Fold every observation above into topic files (create/merge/rewrite as needed). Then update " +
		`journey.md as a FULL concept with type: Session History, title and description (read the existing file to preserve its metadata). Keep the body under ~${journeyTargetTokens} tokens (~${journeyWords} words), ` +
		"purely descriptive, no advice or next steps. Finish with a one-sentence confirmation."
	);
}

/** Automatic uses both thresholds. Manual bypasses the trigger threshold; all also bypasses target selection. */
export function evaluateConsolidatorTrigger(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: TriggerCtx,
	mode: "automatic" | "overflow" | "all" = "automatic",
	checkpoint = false,
	checkpointEndpoint?: string,
): Promise<ConsolidationResult> | undefined {
	if (!runtime.enabled || runtime.config.passive || runtime.saveTask && !checkpoint) return;
	if (runtime.consolidatorInFlight || runtime.promotionController) return;

	const branch = ctx.sessionManager.getBranch();
	const active = foldLedger(branch).activeObservations;
	if (mode === "automatic" && poolTokens(active) < runtime.config.consolidateAtPoolTokens) return;

	const promote = mode === "all"
		? sortObservations(active)
		: selectPromotionOverflow(active, runtime.config.poolTargetTokens).promote;
	if (promote.length === 0) return;

	runtime.consolidatorInFlight = true;
	if (ctx.hasUI) {
		ctx.ui?.notify(`om: consolidator started (${promote.length} obs, ~${poolTokens(promote).toLocaleString()} tok)`, "info");
	}
	// Deliberately NOT tracked in observerTasks: compaction waits only for in-flight observers,
	// never the consolidator (design R5). The consolidatorInFlight flag enforces one-at-a-time.
	const task = dispatchConsolidator(pi, runtime, ctx, promote, checkpointEndpoint);
	runtime.consolidatorTask = task;
	void task.finally(() => { if (runtime.consolidatorTask === task) runtime.consolidatorTask = undefined; });
	return task;
}

export type ConsolidationResult = { status: "success" | "failed" | "cancelled"; observations: number; promotion?: PromotionResult; error?: string };

async function dispatchConsolidator(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: TriggerCtx,
	promote: Observation[],
	checkpointEndpoint?: string,
): Promise<ConsolidationResult> {
	// Snapshot selected IDs before the worker awaits; later ledger additions cannot join this batch.
	const selectedTimestamps = promote.map((observation) => observation.timestamp);
	const scope = captureMemoryScope(runtime, ctx);
	const model = { ...runtime.config.models.consolidator };
	const runId = nextRunId();
	const controller = new AbortController();
	runtime.consolidatorController = controller;
	runtime.status.workerStart("consolidator", runId);
	const owned = () => runtime.consolidatorController === controller;
	const active = () => owned() && !controller.signal.aborted && scope.active();
	let consolidated = false;
	const result: ConsolidationResult = { status: "cancelled", observations: 0 };

	try {
		const prompt = buildConsolidatorPrompt(scope.memoryRoot, promote, runtime.config.journeyTargetTokens);
		const argv = buildWorkerArgv({
			model,
			sessionName: `om-consolidator-${runId}`,
			kickoffPrompt: prompt,
		});
		const env = buildWorkerEnv("consolidator", { memoryRoot: scope.memoryRoot, runId });
		const exit = await spawnWorker({ argv, cwd: scope.memoryRoot, env, signal: controller.signal });
		// Origin paths are immutable. Do not append cost/tombstones into a switched session.
		if (scope.isCurrentSession()) recordWorkerCost(pi, runtime, ctx, "consolidator", runId, scope.memoryRoot);
		if (!active()) return result;
		if (exit.code !== 0) {
			throw new Error(`consolidator exited with code ${exit.code}${exit.stderr ? `: ${exit.stderr.trim().slice(0, 200)}` : ""}`);
		}

		// Validate concept syntax recursively before dropping observations. .runs IPC is excluded.
		// Unknown OKF types/fields and broken links are accepted; no semantic verification.
		validateMemoryBundle(scope.memoryRoot);
		// Generate after all worker writes, including journey.md, have completed.
		atomicWrite(indexPath(scope.memoryRoot), renderIndexFile(listIndexConcepts(scope.memoryRoot)));

		// Trust the consolidator: on clean exit it has folded (or discarded) everything we handed it.
		// Re-fold against the CURRENT branch so we never tombstone something already dropped or an
		// observation an observer committed during this run (those are not in the handed batch).
		const branch = ctx.sessionManager.getBranch();
		const stillActive = new Set(foldLedger(branch).activeObservations.map((o) => o.timestamp));
		const toDrop = selectedTimestamps.filter((timestamp) => stillActive.has(timestamp));

		if (toDrop.length > 0) {
			const coversUpToId = checkpointEndpoint ?? lastSourceEntryId(branch);
			if (!coversUpToId) throw new Error("cannot commit consolidation without a source coverage entry");
			pi.appendEntry(OM_OBSERVATIONS_DROPPED, { observationTimestamps: toDrop, coversUpToId });
		}
		consolidated = true;
		result.status = "success";
		result.observations = toDrop.length;
		if (!active()) return result;

		runtime.status.workerDone(runId, toDrop.length);
		runtime.refreshFooterGauges(ctx.sessionManager.getBranch(), ctx.getContextUsage?.()?.tokens ?? null);
		if (ctx.hasUI && ctx.ui) {
			runtime.queueToast(`om: consolidator promoted ${toDrop.length} obs`, "info", ctx.ui.notify.bind(ctx.ui));
		}
	} catch (error) {
		if (!active()) return result;
		const message = error instanceof Error ? error.message : String(error);
		result.status = "failed";
		result.error = message;
		runtime.lastWorkerError = message;
		runtime.status.workerError(runId);
		if (ctx.hasUI) ctx.ui?.notify(`om: consolidator failed: ${message}`, "error");
	} finally {
		if (owned()) {
			try {
				// Retain consolidation lifecycle ownership through the follow-on pass: no manual
				// promoter/new consolidation can steal the slot and silently lose this success.
				if (consolidated && active()) result.promotion = await runAutomaticPromotion(pi, runtime, ctx, scope, active);
			} catch (error) {
				// Unexpected orchestration/UI exceptions still cannot undo/fail a committed batch.
				if (active()) {
					runtime.lastWorkerError = `automatic project promotion skipped: ${(error as Error).message}`;
					result.promotion = { status: "failed", error: (error as Error).message };
				}
			} finally {
				if (owned()) {
					runtime.consolidatorController = undefined;
					runtime.consolidatorInFlight = false;
				}
			}
		}
	}
	return result;
}

export function registerConsolidatorTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const handler = (_event: unknown, ctx: TriggerCtx) => { evaluateConsolidatorTrigger(pi, runtime, ctx); };
	pi.on("turn_end", handler as never);
	pi.on("agent_start", handler as never);
}
