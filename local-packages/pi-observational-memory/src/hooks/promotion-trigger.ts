/** The consolidator's serialized follow-on pass. No startup/observer trigger or retry loop. */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OM_COST, type Entry } from "../ledger/index.js";
import { listIndexConcepts, sessionMemoryRoot } from "../memory/paths.js";
import { hashSnapshot, managedPath, projectMemoryRoot, sha256, snapshotBundle } from "../memory/project.js";
import { applyPromotion, preparePromotion } from "../memory/promotion.js";
import type { MemoryScope, MemoryWorkContext } from "../memory/work-scope.js";
import type { Runtime } from "../runtime.js";

type PromotionCtx = MemoryWorkContext & {
	hasUI: boolean;
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	sessionManager: MemoryWorkContext["sessionManager"] & { getEntries: () => Entry[] };
};

export type PromotionSnapshot = { source: string; project: string };
export type PromotionResult = { status: "published" | "no-additions" | "no-topics" | "disabled" | "conflicts" | "failed" | "cancelled"; files?: number; error?: string; audit?: string; snapshot?: PromotionSnapshot };

/** Bind success to the exact topics and project bytes evaluated/published, not later live state. */
export function capturePromotionSnapshot(scope: Pick<MemoryScope, "cwd" | "memoryRoot">): PromotionSnapshot {
	if (existsSync(managedPath(scope.cwd, ".memory/.project-publish.lock"))) throw new Error("project publication is locked; inspect recovery before checkpointing");
	const sources = listIndexConcepts(scope.memoryRoot).map(topic => [topic.filename, readFileSync(join(scope.memoryRoot, topic.filename), "utf8")]);
	const root = projectMemoryRoot(scope.cwd);
	return {
		source: sha256(JSON.stringify(sources)),
		project: sha256(JSON.stringify([existsSync(root), hashSnapshot(snapshotBundle(scope.cwd, root))])),
	};
}

export function assertPromotionSnapshot(scope: Pick<MemoryScope, "cwd" | "memoryRoot">, expected: PromotionSnapshot | undefined): void {
	const current = capturePromotionSnapshot(scope);
	if (!expected || current.source !== expected.source || current.project !== expected.project) throw new Error("session topics or project changed after promotion snapshot; save incomplete, retry /om:save");
}

/** Caller retains consolidation ownership until this settles, preventing lost busy follow-ons.
 * All errors are contained here: a failed promoter never retroactively fails consolidation.
 */
export async function runAutomaticPromotion(
	pi: ExtensionAPI, runtime: Runtime, ctx: PromotionCtx, scope: MemoryScope,
	consolidationOwned: () => boolean,
): Promise<PromotionResult> {
	const allowed = () => scope.active() && consolidationOwned() && runtime.config.autoPromote;
	if (!allowed()) return { status: scope.active() && consolidationOwned() ? "disabled" : "cancelled" };
	const controller = new AbortController();
	const workerKey = `auto-promotion-${randomUUID()}`;
	let started = false;
	let artifactPath = `${scope.memoryRoot}/.proposals/`;
	const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI && scope.active()) ctx.ui?.notify(message, level);
	};
	try {
		if (resolve(scope.memoryRoot) !== resolve(sessionMemoryRoot(scope.cwd, scope.sessionId))) throw new Error("source session root does not match captured project/session identity");
		const evaluated = capturePromotionSnapshot(scope);
		if (!listIndexConcepts(scope.memoryRoot).some((topic) => topic.type === "Memory Topic")) {
			notify("om: automatic project promotion: no additions (no consolidated topics)");
			return { status: "no-topics", snapshot: evaluated };
		}
		// Consolidation cannot have overlapped a manual promoter: both entry points share guards.
		if (runtime.promotionController) throw new Error("promotion ownership unexpectedly busy; no automatic publication attempted");
		runtime.promotionController = controller;
		started = true;
		runtime.status.workerStart("promotion", workerKey);
		const model = { ...runtime.config.models.consolidator };
		const proposal = await preparePromotion({ cwd: scope.cwd, sessionId: scope.sessionId, model,
			signal: controller.signal, mode: "automatic",
			onCost: (costUsd, runId) => {
				// After a switch, cost IPC remains in the originating proposal; never charge a new ledger.
				// Off/on in the SAME session still records the real spend, even if work was cancelled.
				if (scope.isCurrentSession()) {
					pi.appendEntry(OM_COST, { costUsd, role: "promotion", runId });
					runtime.refreshCost(ctx.sessionManager.getEntries());
				}
			},
		});
		artifactPath = proposal.reviewPath;
		if (!allowed() || controller.signal.aborted || runtime.promotionController !== controller) return { status: "cancelled" };
		if (proposal.conflicts.length) {
			runtime.lastWorkerError = `automatic project promotion skipped: ${proposal.conflicts.length} conflict(s); ${artifactPath}`;
			runtime.status.workerError(workerKey);
			notify(`om: ${runtime.lastWorkerError}`, "warning");
			return { status: "conflicts", error: runtime.lastWorkerError, audit: artifactPath };
		}
		if (!proposal.changedFiles.length) {
			assertPromotionSnapshot(scope, evaluated);
			runtime.status.workerDone(workerKey, 0);
			notify(`om: automatic project promotion: no additions; audit ${artifactPath}`);
			return { status: "no-additions", files: 0, audit: artifactPath, snapshot: evaluated };
		}
		// A changed source snapshot is not the input this pass evaluated. Project baseline
		// is independently rechecked under apply's publication lock.
		if (capturePromotionSnapshot(scope).source !== evaluated.source) throw new Error("session topics changed during project promotion; retry /om:save");
		// Synchronous guarded publication rechecks candidate integrity and baseline under its lock.
		const changes = applyPromotion({ cwd: scope.cwd, sessionId: scope.sessionId, id: proposal.id, publication: "automatic" });
		runtime.status.workerDone(workerKey, proposal.changedFiles.length);
		notify(`om: automatically published project knowledge (${changes.length} files; not human-reviewed or verified); audit ${artifactPath}`);
		// Bind to the sealed candidate apply validated, not live bytes after releasing its lock
		// (even notification callbacks can replace/delete the published project).
		return { status: "published", files: changes.length, audit: artifactPath, snapshot: { source: evaluated.source, project: sha256(JSON.stringify([true, proposal.candidate])) } };
	} catch (error) {
		if (!allowed() || controller.signal.aborted || started && runtime.promotionController !== controller) return { status: "cancelled" };
		runtime.lastWorkerError = `automatic project promotion skipped: ${(error as Error).message}; artifacts ${artifactPath}`;
		if (started) runtime.status.workerError(workerKey);
		notify(`om: ${runtime.lastWorkerError}`, "warning");
		return { status: "failed", error: runtime.lastWorkerError, audit: artifactPath };
	} finally {
		if (runtime.promotionController === controller) runtime.promotionController = undefined;
	}
}
