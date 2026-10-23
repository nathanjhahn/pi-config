import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateConsolidatorTrigger } from "../src/hooks/consolidator-trigger.js";
import { registerConsolidateCommand } from "../src/commands/consolidate.js";
import { registerPromoteCommand } from "../src/commands/promote.js";
import { registerPromotionTools } from "../agent/promotion/tools.js";
import { Runtime } from "../src/runtime.js";
import observationalMemory from "../src/index.js";
import { atomicWrite, indexPath } from "../src/memory/paths.js";
import { renderIndexFile } from "../src/memory/index-render.js";
import { hashSnapshot, snapshotBundle } from "../src/memory/project.js";
import { spawnWorker, type WorkerExit } from "../src/spawn/launch.js";
import { writeWorkerCost } from "../src/spawn/runs.js";
import { observation, observationsRecordedEntry, rawMessage, type TestEntry } from "./fixtures/session.js";

vi.mock("../src/spawn/launch.js", async (original) => ({ ...await original<typeof import("../src/spawn/launch.js")>(), spawnWorker: vi.fn() }));
const concept = (body: string) => `---\ntype: Memory Topic\ntitle: Architecture\ndescription: Settled architecture\n---\n${body}`;
const success: WorkerExit = { code: 0, signal: null, stderr: "" };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("successful consolidation -> serialized automatic project curation", () => {
	let cwd: string, root: string, project: string, sessionId: string;
	let runtime: Runtime, branch: TestEntry[], ctx: any, pi: any;
	let tools: Map<string, any>;
	let consolidationAction: (opts: Parameters<typeof spawnWorker>[0]) => Promise<WorkerExit>;
	let promotionAction: (opts: Parameters<typeof spawnWorker>[0]) => Promise<WorkerExit>;
	let events: string[];
	const call = (name: string, args: object) => tools.get(name).execute("id", args);
	function start(mode: "automatic" | "all" = "automatic") { evaluateConsolidatorTrigger(pi, runtime, ctx, mode); return runtime.consolidatorTask; }
	function manifests() {
		const dir = join(root, ".proposals");
		return existsSync(dir) ? readdirSync(dir).map((id) => JSON.parse(readFileSync(join(dir, id, "manifest.json"), "utf8"))) : [];
	}
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "om-auto-promote-")); sessionId = "session-a";
		root = join(cwd, ".memory", sessionId); project = join(cwd, ".memory/project");
		runtime = new Runtime(); runtime.enabled = true; runtime.configLoaded = true; runtime.memoryRoot = root;
		runtime.config = Object.freeze({ ...runtime.config, autoPromote: true, passive: false, consolidateAtPoolTokens: 1, poolTargetTokens: 10 });
		branch = [rawMessage("source", "Conversation"), observationsRecordedEntry("observations", {
			coversUpToId: "source", observations: [observation("2026-10-22T10:00:00"), observation("2026-10-22T11:00:00")],
		})];
		events = []; tools = new Map();
		ctx = { cwd, hasUI: true, ui: { notify: vi.fn() }, sessionManager: {
			getSessionId: () => sessionId, getBranch: () => branch, getEntries: () => branch,
		} };
		pi = { appendEntry: vi.fn((customType, data) => {
			if (customType === "om.observations.dropped") events.push("ledger-commit");
			branch.push({ type: "custom", id: `entry-${branch.length}`, parentId: null, timestamp: "2026-10-22T12:00:00Z", customType, data });
		}), sendMessage: vi.fn() };
		consolidationAction = async (opts) => {
			atomicWrite(join(opts.cwd, "architecture.md"), concept("Settled session knowledge"));
			return success;
		};
		promotionAction = async () => {
			await call("write", { path: "architecture.md", content: concept("Curated enduring project knowledge") });
			return success;
		};
		vi.mocked(spawnWorker).mockReset();
		vi.mocked(spawnWorker).mockImplementation(async (opts) => {
			const role = opts.env.OM_WORKER;
			events.push(`${role}-start`);
			if (role === "consolidator") {
				const result = await consolidationAction(opts);
				writeWorkerCost(opts.env.OM_COST_PATH!, { costUsd: 0.1 });
				events.push("consolidator-exit");
				return result;
			}
			expect(role).toBe("promotion");
			expect(existsSync(indexPath(root))).toBe(true);
			if (runtime.consolidatorInFlight) expect(events).toContain("ledger-commit");
			registerPromotionTools({ registerTool: (def: any) => tools.set(def.name, def) } as any, {
				cwd, stage: opts.env.OM_MEMORY_DIR!, inputPath: opts.env.OM_PROMOTION_INPUT!, reportPath: opts.env.OM_PROMOTION_REPORT!,
			});
			const result = await promotionAction(opts);
			if (!existsSync(opts.env.OM_PROMOTION_REPORT!)) await call("review", { summary: "Curated durable knowledge", conflicts: [] });
			writeWorkerCost(opts.env.OM_COST_PATH!, { costUsd: 0.2 });
			events.push("promotion-exit");
			return result;
		});
	});
	afterEach(() => { runtime.abortAllWorkers(); vi.restoreAllMocks(); rmSync(cwd, { recursive: true, force: true }); });

	it.each(["automatic", "all"] as const)("chains only after index/ledger success, publishes automatically and records honest provenance (%s)", async (mode) => {
		await start(mode);
		expect(events).toEqual(["consolidator-start", "consolidator-exit", "ledger-commit", "promotion-start", "promotion-exit"]);
		expect(readFileSync(join(project, "architecture.md"), "utf8")).toContain("Curated enduring project knowledge");
		expect(pi.appendEntry.mock.calls.filter(([type]: any[]) => type === "om.observations.dropped")).toHaveLength(1);
		expect(pi.appendEntry.mock.calls.filter(([type]: any[]) => type === "om.cost").map(([, data]: any[]) => data.role)).toEqual(["consolidator", "promotion"]);
		const [manifest] = manifests();
		expect(manifest.mode).toBe("automatic"); expect(manifest.publication.mode).toBe("automatic"); expect(manifest.state).toBe("applied");
		const review = readFileSync(join(root, ".proposals", manifest.id, "review.md"), "utf8");
		expect(review).toContain("AUTOMATIC curation: no human review or verification is implied");
		expect(review).not.toContain("Separate approval command");
		expect(readFileSync(join(project, "index.md"), "utf8")).not.toContain("reviewed session snapshots");
		expect(runtime.consolidatorInFlight).toBe(false); expect(runtime.promotionController).toBeUndefined();
	});

	it.each([false, true])("a curation no-op keeps audit artifacts but never creates/rewrites project memory (existing=%s)", async (existing) => {
		if (existing) { atomicWrite(join(project, "keep.md"), concept("Existing")); atomicWrite(join(project, "index.md"), renderIndexFile([])); }
		const before = hashSnapshot(snapshotBundle(cwd, project));
		promotionAction = async () => success;
		await start();
		expect(hashSnapshot(snapshotBundle(cwd, project))).toEqual(before);
		expect(existsSync(project)).toBe(existing);
		expect(manifests()[0].publication).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no additions"), "info");
	});

	it("conflicts retain artifacts and never publish, without failing/dropping consolidation twice", async () => {
		promotionAction = async () => {
			await call("write", { path: "architecture.md", content: concept("Proposed addition") });
			await call("review", { summary: "Found a contradiction", conflicts: ["Source conflicts with project"] });
			return success;
		};
		await start();
		expect(existsSync(project)).toBe(false); expect(manifests()[0].state).toBe("conflicts");
		expect(runtime.lastWorkerError).toContain("automatic project promotion skipped");
		expect(pi.appendEntry.mock.calls.filter(([type]: any[]) => type === "om.observations.dropped")).toHaveLength(1);
		expect(ctx.ui.notify.mock.calls.some(([message]: string[]) => message.includes("consolidator failed"))).toBe(false);
	});

	it("stale baseline skips publication without automatic rebase/model retry or retroactive consolidation failure", async () => {
		promotionAction = async () => {
			await call("write", { path: "architecture.md", content: concept("Proposed addition") });
			atomicWrite(join(project, "external.md"), concept("External concurrent addition"));
			return success;
		};
		await start();
		expect(existsSync(join(project, "architecture.md"))).toBe(false);
		expect(readFileSync(join(project, "external.md"), "utf8")).toContain("External concurrent addition");
		expect(runtime.lastWorkerError).toContain("project changed since proposal baseline");
		expect(spawnWorker).toHaveBeenCalledTimes(2);
		expect(pi.appendEntry.mock.calls.filter(([type]: any[]) => type === "om.observations.dropped")).toHaveLength(1);
	});

	it.each(["invalid-yaml", "worker-exit", "ledger-commit"])("never promotes failed consolidation: %s", async (failure) => {
		if (failure === "invalid-yaml") consolidationAction = async (opts) => { atomicWrite(join(opts.cwd, "bad.md"), "invalid"); return success; };
		if (failure === "worker-exit") consolidationAction = async () => ({ code: 1, signal: null, stderr: "worker failed" });
		if (failure === "ledger-commit") pi.appendEntry.mockImplementation((type: string) => { if (type === "om.observations.dropped") throw new Error("ledger commit failed"); });
		await start();
		expect(events).not.toContain("promotion-start"); expect(existsSync(project)).toBe(false);
	});

	it("failed promoter costs are recorded and artifacts kept, with consolidation still committed once", async () => {
		promotionAction = async () => ({ code: 1, signal: null, stderr: "promotion failed" });
		await start();
		expect(runtime.lastWorkerError).toContain("automatic project promotion skipped");
		expect(pi.appendEntry.mock.calls.filter(([type]: any[]) => type === "om.cost").map(([, data]: any[]) => [data.role, data.costUsd])).toEqual([["consolidator", 0.1], ["promotion", 0.2]]);
		expect(manifests()[0].state).toBe("preparing"); expect(existsSync(project)).toBe(false);
		expect(pi.appendEntry.mock.calls.filter(([type]: any[]) => type === "om.observations.dropped")).toHaveLength(1);
	});

	it("no source topics is a safe no-op without a promoter call", async () => {
		consolidationAction = async (opts) => { atomicWrite(join(opts.cwd, "journey.md"), concept("Past history").replace("Memory Topic", "Session History")); return success; };
		await start();
		expect(spawnWorker).toHaveBeenCalledTimes(1); expect(existsSync(join(root, ".proposals"))).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no additions (no consolidated topics)"), "info");
	});

	it("autoPromote opt-out leaves consolidation/config/thresholds intact", async () => {
		runtime.config = Object.freeze({ ...runtime.config, autoPromote: false });
		const before = structuredClone(runtime.config);
		await start();
		expect(events).not.toContain("promotion-start"); expect(runtime.config).toEqual(before);
		expect(existsSync(indexPath(root))).toBe(true); expect(existsSync(project)).toBe(false);
	});

	it("holds lifecycle ownership through promotion: no overlapping manual/automatic work, compaction never waits", async () => {
		const entered = deferred<void>(), release = deferred<void>();
		promotionAction = async () => { entered.resolve(); await release.promise; return success; };
		const task = start(); await entered.promise;
		expect(runtime.consolidatorInFlight).toBe(true); expect(runtime.promotionController).toBeDefined(); expect(runtime.observerTasks.size).toBe(0);
		let consolidate: any, promote: any;
		registerConsolidateCommand({ ...pi, registerCommand: (_name: string, def: any) => { consolidate = def.handler; } } as any, runtime);
		registerPromoteCommand({ ...pi, registerCommand: (_name: string, def: any) => { promote = def.handler; } } as any, runtime);
		start(); await consolidate("all", ctx); await promote("", ctx);
		expect(spawnWorker).toHaveBeenCalledTimes(2);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("retry after it finishes"), "warning");
		release.resolve(); await task;
		expect(runtime.consolidatorInFlight).toBe(false);
	});

	it("manual promotion already active reports consolidation busy; the next admitted consolidation still gets its follow-on", async () => {
		atomicWrite(join(root, "architecture.md"), concept("Already consolidated"));
		atomicWrite(indexPath(root), renderIndexFile([]));
		const entered = deferred<void>(), release = deferred<void>();
		let count = 0;
		promotionAction = async () => {
			if (count++ === 0) { entered.resolve(); await release.promise; }
			else await call("write", { path: "architecture.md", content: concept("Automatic curation after manual proposal") });
			return success;
		};
		let promote: any, consolidate: any;
		registerPromoteCommand({ ...pi, registerCommand: (_name: string, def: any) => { promote = def.handler; } } as any, runtime);
		registerConsolidateCommand({ ...pi, registerCommand: (_name: string, def: any) => { consolidate = def.handler; } } as any, runtime);
		const manual = promote("", ctx); await entered.promise;
		start(); await consolidate("all", ctx);
		expect(events).toEqual(["promotion-start"]);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("retry after it finishes"), "warning");
		release.resolve(); await manual;
		expect(existsSync(project)).toBe(false); // manual path still requires explicit apply
		await start();
		expect(events.filter((event) => /start$/.test(event))).toEqual(["promotion-start", "consolidator-start", "promotion-start"]);
		expect(readFileSync(join(project, "architecture.md"), "utf8")).toContain("Automatic curation after manual proposal");
	});

	it("captures the consolidator origin and does not commit costs/index/promotion into a switched session", async () => {
		const release = deferred<WorkerExit>();
		consolidationAction = async (opts) => { atomicWrite(join(opts.cwd, "architecture.md"), concept("Old source")); return release.promise; };
		const task = start();
		sessionId = "session-b"; runtime.memoryRoot = join(cwd, ".memory/session-b");
		release.resolve(success); await task;
		expect(vi.mocked(spawnWorker).mock.calls[0][0].cwd).toBe(root);
		expect(existsSync(indexPath(runtime.memoryRoot))).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled(); expect(events).not.toContain("promotion-start");
	});

	it("startup/reload only invalidates old ownership and never implicitly consolidates/promotes", () => {
		atomicWrite(join(root, "architecture.md"), concept("Existing source"));
		const handlers = new Map<string, Function>();
		const abort = vi.spyOn(Runtime.prototype, "abortAllWorkers");
		observationalMemory({ ...pi, on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: vi.fn() } as any);
		handlers.get("session_start")!({}, ctx);
		const owned = abort.mock.contexts[0] as Runtime;
		const oldPromotion = new AbortController(); owned.promotionController = oldPromotion;
		handlers.get("session_start")!({}, ctx);
		expect(oldPromotion.signal.aborted).toBe(true);
		expect(spawnWorker).not.toHaveBeenCalled();
		handlers.get("session_shutdown")!({}, ctx);
		abort.mockRestore();
	});

	it.each(["off", "shutdown", "session-change", "opt-out", "passive"])("prevents a late zero-exit promoter applying after %s", async (cancel) => {
		const entered = deferred<void>(), release = deferred<void>();
		promotionAction = async () => { await call("write", { path: "architecture.md", content: concept("Must not publish") }); entered.resolve(); await release.promise; return success; };
		const task = start(); await entered.promise;
		if (cancel === "off") { runtime.enabled = false; runtime.abortAllWorkers(); runtime.enabled = true; }
		if (cancel === "shutdown") runtime.abortAllWorkers();
		if (cancel === "opt-out") runtime.config = Object.freeze({ ...runtime.config, autoPromote: false });
		if (cancel === "passive") runtime.config = Object.freeze({ ...runtime.config, passive: true });
		if (cancel === "session-change") { sessionId = "session-b"; runtime.memoryRoot = join(cwd, ".memory/session-b"); }
		release.resolve(); await task;
		expect(existsSync(project)).toBe(false);
		if (cancel === "session-change") expect(pi.appendEntry.mock.calls.filter(([type]: any[]) => type === "om.cost")).toHaveLength(1); // originating IPC retained, never new-ledger cost
	});

	it("retains a cancelled consolidator's write slot through late zero-exit writes, then admits a fresh chain", async () => {
		const releases = [deferred<WorkerExit>(), deferred<WorkerExit>()];
		let index = 0;
		consolidationAction = async (opts) => {
			const run = index++;
			atomicWrite(join(opts.cwd, "architecture.md"), concept(`Run ${run} initial`));
			const result = await releases[run].promise;
			atomicWrite(join(opts.cwd, "architecture.md"), concept(`Run ${run} final late write`));
			return result;
		};
		const oldTask = start()!;
		const oldController = runtime.consolidatorController;
		runtime.abortAllWorkers();
		start(); // off/on cannot overlap a subprocess still in its termination grace period
		expect(spawnWorker).toHaveBeenCalledTimes(1);
		expect(runtime.consolidatorController).toBe(oldController); expect(runtime.consolidatorInFlight).toBe(true);
		releases[0].resolve(success); await oldTask;
		expect(events).not.toContain("ledger-commit"); expect(events).not.toContain("promotion-start");
		const newTask = start()!;
		expect(runtime.consolidatorController).not.toBe(oldController);
		releases[1].resolve(success); await newTask;
		expect(events.filter((event) => event === "ledger-commit")).toHaveLength(1);
		expect(events.filter((event) => event === "promotion-start")).toHaveLength(1);
		const promotion = vi.mocked(spawnWorker).mock.calls.find(([opts]) => opts.env.OM_WORKER === "promotion")![0];
		expect(readFileSync(promotion.env.OM_PROMOTION_INPUT!, "utf8")).toContain("Run 1 final late write");
		expect(readFileSync(promotion.env.OM_PROMOTION_INPUT!, "utf8")).not.toContain("Run 0");
	});

	it("old promotion finalizers cannot clear newer promotion/consolidation ownership after off/on", async () => {
		const entered = deferred<void>(), release = deferred<void>();
		promotionAction = async () => { entered.resolve(); await release.promise; return success; };
		const oldTask = start()!; await entered.promise;
		runtime.abortAllWorkers();
		const newerPromotion = new AbortController(), newerConsolidation = new AbortController();
		const newerTask = Promise.resolve();
		runtime.promotionController = newerPromotion; runtime.consolidatorController = newerConsolidation; runtime.consolidatorInFlight = true;
		runtime.consolidatorTask = newerTask;
		release.resolve(); await oldTask;
		expect(runtime.promotionController).toBe(newerPromotion); expect(runtime.consolidatorController).toBe(newerConsolidation); expect(runtime.consolidatorInFlight).toBe(true);
		expect(runtime.consolidatorTask).toBe(newerTask);
		expect(existsSync(project)).toBe(false);
		runtime.consolidatorTask = undefined; // synthetic replacement has no real subprocess/finalizer
	});
});
