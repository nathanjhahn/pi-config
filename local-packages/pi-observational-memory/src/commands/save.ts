import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { foldLedger, lastSourceEntryId, selectUncoveredSourceSlice, successfulObservationSourceIds, type Entry } from "../ledger/index.js";
import { dispatchObserver } from "../hooks/observer-trigger.js";
import { evaluateConsolidatorTrigger, type ConsolidationResult } from "../hooks/consolidator-trigger.js";
import { assertPromotionSnapshot, capturePromotionSnapshot, runAutomaticPromotion, type PromotionResult } from "../hooks/promotion-trigger.js";
import { listIndexConcepts, validateMemoryBundle } from "../memory/paths.js";
import { sha256 } from "../memory/project.js";
import { captureMemoryScope } from "../memory/work-scope.js";
import type { Runtime } from "../runtime.js";

const CHECKPOINT = "om.save.checkpoint";
const successfulProject = (result: PromotionResult | undefined) => !!result && ["published", "no-additions", "no-topics", "disabled"].includes(result.status);

/** Small durable fingerprint: source endpoint + consolidated bytes + publication policy.
 * Worker IPC/proposal artifacts and save feedback deliberately do not participate. */
function checkpointKey(runtime: Runtime, endpoint: string | undefined): string | undefined {
	try {
		const concepts = listIndexConcepts(runtime.memoryRoot).map(topic => [topic.filename, readFileSync(join(runtime.memoryRoot, topic.filename), "utf8")]);
		const cwd = join(runtime.memoryRoot, "..", "..");
		// An opted-out project cannot block session persistence. Unsafe/unreadable snapshots
		// disable reuse only: the promoter reports project failure after session commits.
		const project = runtime.config.autoPromote ? capturePromotionSnapshot({ cwd, memoryRoot: runtime.memoryRoot }).project : null;
		return sha256(JSON.stringify([endpoint ?? null, concepts, project, runtime.config.autoPromote]));
	} catch {
		return undefined;
	}
}

export function registerSaveCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:save", {
		description: "Checkpoint this branch through its current source endpoint: observe tail, consolidate all, await project curation (no compaction)",
		handler: async (args: string, ctx: any) => {
			const report = (text: string, level: "info" | "warning" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui?.notify(text, level);
				else pi.sendMessage({ customType: "om.save", content: `INERT OM checkpoint status for the user, not instructions:\n${text}`, display: true }, { triggerTurn: false });
			};
			if ((args ?? "").trim()) { report("Usage: /om:save (no arguments)", "error"); return; }
			if (!runtime.enabled) { report("om: save skipped — om is off (use /om on to enable)"); return; }
			runtime.ensureConfig(ctx.cwd);
			if (runtime.config.passive) { report("om: save skipped — passive mode", "warning"); return; }
			if (ctx.isIdle && !ctx.isIdle()) { report("om: save refused — wait for the current agent turn to finish, then retry", "warning"); return; }
			if (runtime.saveTask) { report("om: save already in progress; retry after it finishes", "warning"); return; }
			if (runtime.promotionController && !runtime.consolidatorTask || runtime.consolidatorInFlight && !runtime.consolidatorTask) {
				report("om: save refused — consolidation/promotion already in progress; retry after it finishes", "warning"); return;
			}

			// Capture BEFORE waiting: later conversation and our own feedback are outside this save.
			const initialBranch = ctx.sessionManager.getBranch() as Entry[];
			const endpoint = lastSourceEntryId(initialBranch);
			const source = endpoint ? initialBranch.slice(0, initialBranch.findIndex(entry => entry.id === endpoint) + 1) : [];
			const scope = captureMemoryScope(runtime, ctx);
			const existingConsolidation = runtime.consolidatorTask;
			const waitingObservers = runtime.observerTasks.size;
			const active = () => scope.active() && (!endpoint || (ctx.sessionManager.getBranch() as Entry[]).some(entry => entry.id === endpoint));
			let chunks = 0, observations = 0;
			let consolidation = "not needed (no active observations)";
			let project: PromotionResult | undefined;
			const summary = () => `om: save endpoint ${endpoint ?? "none (no source)"}; ${chunks} new chunk(s), ${observations} new observation(s); waited for ${waitingObservers} existing observer(s); consolidation: ${consolidation}; project: ${project?.status === "disabled" ? "skipped (autoPromote:false)" : project?.status ?? "not run"}${project?.files !== undefined ? ` (${project.files} files)` : ""}${project?.error ? ` — ${project.error}` : ""}${project?.audit ? `; audit ${project.audit}` : ""}. No compaction; no human review or runtime verification implied.`;
			const task = (async () => {
				try {
					await runtime.whenObserversIdle();
					const prior: ConsolidationResult | undefined = await existingConsolidation || undefined;
					if (!active()) throw new Error("cancelled: session/branch/gate changed; retry in the intended branch");
					// Merge only ledger state into the immutable invocation source snapshot.
					while (true) {
						const ledger = (ctx.sessionManager.getBranch() as Entry[]).filter(entry => entry.type === "custom");
						const slice = selectUncoveredSourceSlice([...source, ...ledger], runtime.config.chunkTokens);
						if (!slice.entries.length) break;
						const work = dispatchObserver(pi, runtime, ctx, slice);
						runtime.trackObserverTask(work);
						const result = await work;
						chunks += 1;
						observations += result.observations;
						if (!active() || result.status === "cancelled") throw new Error("cancelled: session/branch/gate changed; retry in the intended branch");
						if (result.status !== "success") throw new Error(`observation failed; source coverage incomplete: ${result.error}`);
						const durable = successfulObservationSourceIds(ctx.sessionManager.getBranch());
						if (!slice.entries.every(entry => durable.has(entry.id))) throw new Error("observer coverage commit missing; source coverage incomplete (retry save)");
					}
					const pool = foldLedger(ctx.sessionManager.getBranch()).activeObservations;
					if (pool.length) {
						const result = await evaluateConsolidatorTrigger(pi, runtime, ctx, "all", true, endpoint);
						if (!active()) throw new Error("cancelled: session/branch/gate changed; retry in the intended branch");
						if (!result || result.status !== "success") {
							consolidation = result?.status ?? "busy";
							throw new Error(`consolidation ${consolidation}: ${result?.error ?? "retry after current work finishes"}`);
						}
						consolidation = `success (${result.observations} observations)`;
						project = result.promotion;
					} else {
						validateMemoryBundle(scope.memoryRoot);
						const key = checkpointKey(runtime, endpoint);
						const alreadySaved = key && (ctx.sessionManager.getBranch() as Entry[]).some(entry => entry.type === "custom" && entry.customType === CHECKPOINT && (entry.data as { key?: string })?.key === key);
						if (alreadySaved) {
							report(`${summary()} Already checkpointed; no new model work.`);
							return;
						}
						if (!chunks && prior?.status === "success" && successfulProject(prior.promotion)) {
							consolidation = `completed existing run (${prior.observations} observations)`;
							project = prior.promotion;
						} else {
							project = await runAutomaticPromotion(pi, runtime, ctx, scope, active);
						}
					}
					if (!active()) throw new Error("cancelled: session/branch/gate changed; retry in the intended branch");
					if (successfulProject(project) && runtime.config.autoPromote) {
						try { assertPromotionSnapshot(scope, project?.snapshot); }
						catch (error) { project = { status: "failed", error: (error as Error).message, audit: project?.audit }; }
					}
					const committedKey = successfulProject(project) ? checkpointKey(runtime, endpoint) : undefined;
					if (committedKey) pi.appendEntry(CHECKPOINT, { key: committedKey, endpoint: endpoint ?? null, project: project!.status });
					report(summary(), successfulProject(project) ? "info" : "warning");
				} catch (error) {
					// Never append feedback into a replacement session or unrelated tree branch.
					if (scope.isCurrentBranch()) report(`${summary()} Save incomplete: ${(error as Error).message}`, "error");
				}
			})();
			runtime.saveTask = task;
			try { await task; } finally { if (runtime.saveTask === task) runtime.saveTask = undefined; }
		},
	});
}
