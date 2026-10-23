import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSaveCommand } from "../src/commands/save.js";
import { registerConsolidateCommand } from "../src/commands/consolidate.js";
import { registerPromoteCommand } from "../src/commands/promote.js";
import { dispatchObserver, evaluateObserverTriggers } from "../src/hooks/observer-trigger.js";
import { evaluateConsolidatorTrigger, registerConsolidatorTrigger } from "../src/hooks/consolidator-trigger.js";
import { OM_OBSERVATIONS_RECORDED, OM_OBSERVATION_COVERAGE, foldLedger, latestCoverageMarkerId, selectSourceSlice, successfulObservationSourceIds, type Entry } from "../src/ledger/index.js";
import { renderIndexFile } from "../src/memory/index-render.js";
import { atomicWrite } from "../src/memory/paths.js";
import { capturePromotionSnapshot } from "../src/hooks/promotion-trigger.js";
import { captureMemoryScope } from "../src/memory/work-scope.js";
import { registerPromotionTools } from "../agent/promotion/tools.js";
import { Runtime } from "../src/runtime.js";
import { spawnWorker, type WorkerExit } from "../src/spawn/launch.js";
import { writeObserverResult, writeWorkerCost } from "../src/spawn/runs.js";
import { observation, observationsRecordedEntry, rawMessage } from "./fixtures/session.js";

vi.mock("../src/spawn/launch.js", async (original) => ({ ...await original<typeof import("../src/spawn/launch.js")>(), spawnWorker: vi.fn() }));
const success: WorkerExit = { code: 0, signal: null, stderr: "" };
const topic = "---\ntype: Memory Topic\ntitle: Decisions\ndescription: Durable decisions\n---\nDecision body\n";
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
type Launch = Parameters<typeof spawnWorker>[0];

describe("checkpoint lifecycle and observer coverage", () => {
	let cwd: string, runtime: Runtime, branch: Entry[], sessionId: string, ctx: any, pi: any;
	let commands: Map<string, any>, action: (opts: Launch) => Promise<WorkerExit>, roles: string[];
	const save = () => commands.get("om:save").handler("", ctx);
	const reports = () => ctx.ui.notify.mock.calls.map(([text]: string[]) => text).join("\n");
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "om-save-lifecycle-")); sessionId = "session-a";
		runtime = new Runtime(); runtime.enabled = true; runtime.configLoaded = true;
		runtime.memoryRoot = join(cwd, ".memory", sessionId);
		runtime.config = { ...runtime.config, autoPromote: false, chunkTokens: 10000, consolidateAtPoolTokens: 100000 };
		branch = [rawMessage("first", "Source conversation")]; roles = []; commands = new Map();
		ctx = { cwd, hasUI: true, isIdle: () => true, ui: { notify: vi.fn() }, sessionManager: {
			getSessionId: () => sessionId, getBranch: () => branch, getEntries: () => branch,
		} };
		pi = { registerCommand: (name: string, definition: any) => commands.set(name, definition), sendMessage: vi.fn(),
			appendEntry: vi.fn((customType: string, data: unknown) => branch.push({ type: "custom", id: `ledger-${branch.length}`, customType, data })),
		};
		registerSaveCommand(pi, runtime); registerConsolidateCommand(pi, runtime); registerPromoteCommand(pi, runtime);
		action = async opts => {
			if (opts.env.OM_WORKER === "observer") writeObserverResult(opts.env.OM_RESULT_PATH!, { observations: [] });
			if (opts.env.OM_WORKER === "consolidator") atomicWrite(join(opts.cwd, "decisions.md"), topic);
			if (opts.env.OM_WORKER === "promotion") {
				const tools = new Map<string, any>();
				registerPromotionTools({ registerTool: (def: any) => tools.set(def.name, def) } as any, {
					cwd, stage: opts.env.OM_MEMORY_DIR!, inputPath: opts.env.OM_PROMOTION_INPUT!, reportPath: opts.env.OM_PROMOTION_REPORT!,
				});
				await tools.get("review").execute("review", { summary: "No additions", conflicts: [] });
			}
			writeWorkerCost(opts.env.OM_COST_PATH!, { costUsd: 0.1 });
			return success;
		};
		vi.mocked(spawnWorker).mockReset();
		vi.mocked(spawnWorker).mockImplementation(opts => { roles.push(opts.env.OM_WORKER!); return action(opts); });
	});
	afterEach(() => { runtime.abortAllWorkers(); rmSync(cwd, { recursive: true, force: true }); });

	it.each(["disabled", "passive", "busy-agent", "args"])("clearly refuses %s without model work", async reason => {
		if (reason === "disabled") runtime.enabled = false;
		if (reason === "passive") runtime.config.passive = true;
		if (reason === "busy-agent") ctx.isIdle = () => false;
		await commands.get("om:save").handler(reason === "args" ? "all" : "", ctx);
		expect(roles).toEqual([]);
		expect(reports()).toMatch(/off|passive|wait|Usage/);
	});

	it("empty source and topics is a durable no-model no-op", async () => {
		branch = []; runtime.config.autoPromote = true;
		await save(); await save();
		expect(roles).toEqual([]); expect(reports()).toContain("none (no source)");
		expect(branch.filter(entry => entry.customType === "om.save.checkpoint")).toHaveLength(1);
	});

	it("uses normal multi-chunk sizing and never separates a tool result from its call", async () => {
		runtime.config.chunkTokens = 10;
		branch = [rawMessage("first", "a".repeat(150)),
			{ id: "call", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tool", name: "read", arguments: {} }] } },
			{ id: "result", type: "message", message: { role: "toolResult", toolCallId: "tool", toolName: "read", content: [{ type: "text", text: "b".repeat(150) }] } },
			rawMessage("last", "Short tail")];
		const prompts: string[] = [];
		const normal = action; action = async opts => { prompts.push(opts.argv.at(-1)!); return normal(opts); };
		await save();
		expect(roles).toEqual(["observer", "observer", "observer"]);
		expect(prompts[0]).toContain("first"); expect(prompts[0]).not.toContain('id="result"');
		expect(prompts[1]).toContain("call"); expect(prompts[1]).toContain("result");
		expect(latestCoverageMarkerId(branch, OM_OBSERVATIONS_RECORDED)).toBe("last");
		expect(branch.filter(entry => entry.customType === OM_OBSERVATION_COVERAGE)).toHaveLength(3);
	});

	it("waits existing observers rather than duplicating their range", async () => {
		const entered = deferred<void>(), release = deferred<void>(), normal = action;
		action = async opts => { entered.resolve(); await release.promise; return normal(opts); };
		const work = dispatchObserver(pi, runtime, ctx, selectSourceSlice(branch, undefined, 10000));
		runtime.trackObserverTask(work); await entered.promise;
		const pending = save(); expect(roles).toEqual(["observer"]);
		release.resolve(); await pending;
		expect(roles).toEqual(["observer"]); expect(reports()).toContain("waited for 1 existing observer");
	});

	it("an early failed parallel chunk leaves a durable hole after later success", async () => {
		runtime.config.chunkTokens = 10; runtime.config.observerConcurrency = 2;
		branch = [rawMessage("first", "EARLY".repeat(100)), rawMessage("later", "LATER".repeat(100))];
		const normal = action;
		action = async opts => opts.argv.at(-1)!.includes("EARLY") ? { code: 1, signal: null, stderr: "first failed" } : normal(opts);
		evaluateObserverTriggers(pi, runtime, ctx); await runtime.whenObserversIdle();
		expect(successfulObservationSourceIds(branch)).toEqual(new Set(["later"]));
		expect(latestCoverageMarkerId(branch, OM_OBSERVATIONS_RECORDED)).toBeUndefined();
		const laterCommits = branch.filter(entry => entry.customType === OM_OBSERVATION_COVERAGE).length;
		action = normal; await save();
		expect(roles).toEqual(["observer", "observer", "observer"]);
		expect(branch.filter(entry => entry.customType === OM_OBSERVATION_COVERAGE)).toHaveLength(laterCommits + 1);
		expect(latestCoverageMarkerId(branch, OM_OBSERVATIONS_RECORDED)).toBe("later");
	});

	it.each(["worker-exit", "missing-ipc", "malformed", "mixed"])("fails closed on observer %s, retries once on a later save", async failure => {
		action = async opts => {
			if (failure === "worker-exit") return { code: 1, signal: null, stderr: "failed" };
			if (failure !== "missing-ipc") atomicWrite(opts.env.OM_RESULT_PATH!, JSON.stringify({ observations: failure === "mixed" ? [{ timestamp: "2026-10-22 15:00", content: "ok" }, { bad: true }] : [{ bad: true }] }));
			return success;
		};
		await save(); expect(successfulObservationSourceIds(branch).size).toBe(0);
		expect(branch.some(entry => entry.customType === "om.save.checkpoint")).toBe(false);
		expect(reports()).toContain("Save incomplete");
		action = async opts => { writeObserverResult(opts.env.OM_RESULT_PATH!, { observations: [] }); return success; };
		await save(); expect(roles).toEqual(["observer", "observer"]);
	});

	it("serializes save against duplicate saves, automatic triggers and manual writers", async () => {
		const entered = deferred<void>(), release = deferred<void>(), normal = action;
		action = async opts => { entered.resolve(); await release.promise; return normal(opts); };
		const pending = save(); await entered.promise;
		await save(); await commands.get("om:consolidate").handler("all", ctx); await commands.get("om:promote").handler("", ctx);
		evaluateObserverTriggers(pi, runtime, ctx); evaluateConsolidatorTrigger(pi, runtime, ctx, "all");
		expect(roles).toEqual(["observer"]); expect(reports()).toContain("retry after it finishes");
		release.resolve(); await pending; expect(runtime.saveTask).toBeUndefined();
	});

	it("refuses an untracked manual promoter without polling", async () => {
		runtime.promotionController = new AbortController();
		await save(); expect(roles).toEqual([]); expect(reports()).toContain("retry after it finishes");
	});

	it.each(["off-on", "shutdown", "session", "shared-endpoint-tree"])("invalidates continuation after %s while preserving only same-session spend", async change => {
		branch.push({ id: "original-leaf", type: "custom", customType: "other", data: {} });
		const originalRoot = runtime.memoryRoot, entered = deferred<void>(), release = deferred<void>(), normal = action;
		action = async opts => { entered.resolve(); await release.promise; return normal(opts); };
		const pending = save(); await entered.promise;
		if (change === "off-on") { runtime.enabled = false; runtime.abortAllWorkers(); runtime.enabled = true; }
		if (change === "shutdown") runtime.abortAllWorkers();
		if (change === "session") { sessionId = "session-b"; runtime.memoryRoot = join(cwd, ".memory", sessionId); branch = []; }
		if (change === "shared-endpoint-tree") branch = [branch[0], { id: "sibling-leaf", type: "custom", customType: "other", data: {} }];
		const beforeReleaseReports = ctx.ui.notify.mock.calls.length;
		release.resolve(); await pending;
		expect(roles).toEqual(["observer"]); expect(successfulObservationSourceIds(branch).size).toBe(0);
		expect(branch.filter(entry => entry.customType === "om.cost")).toHaveLength(change === "session" ? 0 : 1);
		expect(branch.some(entry => entry.customType === "om.save.checkpoint")).toBe(false);
		expect(runtime.saveTask).toBeUndefined();
		if (change === "shared-endpoint-tree" || change === "session") expect(ctx.ui.notify.mock.calls.length).toBe(beforeReleaseReports);
		expect(existsSync(join(originalRoot, ".runs"))).toBe(true);
	});

	it("holds a cancelled manual promoter slot until its child actually settles", async () => {
		runtime.config.autoPromote = true; atomicWrite(join(runtime.memoryRoot, "decisions.md"), topic);
		const entered = deferred<void>(), release = deferred<void>(), normal = action;
		action = async opts => { entered.resolve(); await release.promise; return normal(opts); };
		const manual = commands.get("om:promote").handler("", ctx); await entered.promise;
		const controller = runtime.promotionController; runtime.abortAllWorkers();
		expect(runtime.promotionController).toBe(controller);
		await save(); expect(roles).toEqual(["promotion"]);
		release.resolve(); await manual; expect(runtime.promotionController).toBeUndefined();
	});

	it("automatic consolidator hooks stay background-only even though dispatch returns a result promise", async () => {
		branch.push(observationsRecordedEntry("record", { coversUpToId: "first", observations: [observation("2026-10-22T10:00:00"), observation("2026-10-22T11:00:00")] }));
		runtime.config.consolidateAtPoolTokens = 1; runtime.config.poolTargetTokens = 1;
		const handlers = new Map<string, any>(), release = deferred<void>(), normal = action;
		action = async opts => { await release.promise; return normal(opts); };
		registerConsolidatorTrigger({ ...pi, on: (name: string, handler: any) => handlers.set(name, handler) }, runtime);
		expect(handlers.get("agent_start")({}, ctx)).toBeUndefined();
		expect(runtime.consolidatorInFlight).toBe(true);
		expect(handlers.get("turn_end")({}, ctx)).toBeUndefined();
		expect(roles).toEqual(["consolidator"]);
		release.resolve(); await runtime.consolidatorTask;
	});

	it("distinguishes session-wide cost identity from full-leaf branch activity", () => {
		branch.push({ id: "leaf", type: "custom" });
		const scope = captureMemoryScope(runtime, ctx);
		branch = [branch[0], { id: "sibling", type: "custom" }];
		expect(scope.isCurrentSession()).toBe(true); expect(scope.isCurrentBranch()).toBe(false); expect(scope.active()).toBe(false);
	});

	it("binds published success to the sealed candidate even if notification immediately deletes live project memory", async () => {
		branch = []; runtime.config.autoPromote = true;
		atomicWrite(join(runtime.memoryRoot, "decisions.md"), topic);
		action = async opts => {
			const tools = new Map<string, any>();
			registerPromotionTools({ registerTool: (def: any) => tools.set(def.name, def) } as any, {
				cwd, stage: opts.env.OM_MEMORY_DIR!, inputPath: opts.env.OM_PROMOTION_INPUT!, reportPath: opts.env.OM_PROMOTION_REPORT!,
			});
			await tools.get("write").execute("write", { path: "decisions.md", content: topic });
			await tools.get("review").execute("review", { summary: "Publish durable decisions", conflicts: [] });
			return success;
		};
		let removed = false;
		ctx.ui.notify.mockImplementation((message: string) => {
			if (!removed && message.startsWith("om: automatically published")) {
				removed = true;
				rmSync(join(cwd, ".memory/project"), { recursive: true });
			}
		});
		await save();
		expect(removed).toBe(true); expect(roles).toEqual(["promotion"]);
		expect(existsSync(join(cwd, ".memory/project"))).toBe(false);
		expect(reports()).toContain("project: failed");
		expect(branch.some(entry => entry.customType === "om.save.checkpoint")).toBe(false);
		await save(); expect(roles).toEqual(["promotion", "promotion"]);
		expect(existsSync(join(cwd, ".memory/project/decisions.md"))).toBe(true);
		expect(branch.filter(entry => entry.customType === "om.save.checkpoint")).toHaveLength(1);
		await save(); expect(roles).toEqual(["promotion", "promotion"]);
	});

	it.each(["project", "topics"])("does not certify no-additions against %s bytes changed while the promoter runs", async changed => {
		branch.push(observationsRecordedEntry("covered", { coversUpToId: "first", observations: [observation("2026-10-22T10:00:00")] }));
		branch.push({ id: "drop", type: "custom", customType: "om.observations.dropped", data: { coversUpToId: "first", observationTimestamps: ["2026-10-22T10:00:00"] } });
		runtime.config.autoPromote = true; atomicWrite(join(runtime.memoryRoot, "decisions.md"), topic);
		atomicWrite(join(cwd, ".memory/project/index.md"), renderIndexFile([]));
		const entered = deferred<void>(), release = deferred<void>(), normal = action;
		action = async opts => { entered.resolve(); await release.promise; return normal(opts); };
		const pending = save(); await entered.promise;
		if (changed === "project") rmSync(join(cwd, ".memory/project"), { recursive: true });
		else atomicWrite(join(runtime.memoryRoot, "decisions.md"), `${topic}\nNew source decision`);
		release.resolve(); await pending;
		expect(reports()).toContain("project: failed");
		expect(branch.some(entry => entry.customType === "om.save.checkpoint")).toBe(false);
		await save(); expect(roles).toEqual(["promotion", "promotion"]);
	});

	it("does not reuse a prior consolidation's successful promoter against a project replaced during the observer wait", async () => {
		branch = []; runtime.config.autoPromote = true;
		atomicWrite(join(runtime.memoryRoot, "decisions.md"), topic);
		const prior = capturePromotionSnapshot({ cwd, memoryRoot: runtime.memoryRoot });
		runtime.consolidatorTask = Promise.resolve({ status: "success", observations: 1, promotion: { status: "no-additions", files: 0, snapshot: prior } });
		const release = deferred<void>(); runtime.trackObserverTask(release.promise);
		const pending = save();
		atomicWrite(join(cwd, ".memory/project/index.md"), renderIndexFile([]));
		release.resolve(); await pending;
		expect(roles).toEqual([]); expect(reports()).toContain("project: failed");
		expect(branch.some(entry => entry.customType === "om.save.checkpoint")).toBe(false);
	});

	it("a publication recovery lock prevents successful checkpoint reuse without extra model work", async () => {
		runtime.config.autoPromote = true;
		await save(); expect(roles).toEqual(["observer"]);
		atomicWrite(join(cwd, ".memory/.project-publish.lock"), "recovery required");
		await save(); expect(roles).toEqual(["observer"]);
		expect(reports()).toContain("project: failed"); expect(reports()).toContain("locked");
		expect(branch.filter(entry => entry.customType === "om.save.checkpoint")).toHaveLength(1);
	});

	it("a recovery lock appearing during promotion prevents checkpoint completion", async () => {
		branch = []; runtime.config.autoPromote = true;
		atomicWrite(join(runtime.memoryRoot, "decisions.md"), topic);
		const entered = deferred<void>(), release = deferred<void>(), normal = action;
		action = async opts => { entered.resolve(); await release.promise; return normal(opts); };
		const pending = save(); await entered.promise;
		atomicWrite(join(cwd, ".memory/.project-publish.lock"), "recovery required");
		release.resolve(); await pending;
		expect(reports()).toContain("project: failed"); expect(reports()).toContain("locked");
		expect(branch.some(entry => entry.customType === "om.save.checkpoint")).toBe(false);
	});

	it.each([false, true])("an unsafe project bundle never blocks session consolidation (autoPromote=%s)", async autoPromote => {
		branch.push(observationsRecordedEntry("record", { coversUpToId: "first", observations: [observation("2026-10-22T10:00:00")] }));
		runtime.config.autoPromote = autoPromote;
		mkdirSync(join(cwd, ".memory/project"), { recursive: true });
		symlinkSync(join(cwd, "missing-target"), join(cwd, ".memory/project/unsafe.md"));
		await save();
		expect(roles).toEqual(["consolidator"]);
		expect(foldLedger(branch).activeObservations).toHaveLength(0);
		expect(existsSync(join(runtime.memoryRoot, "decisions.md"))).toBe(true);
		expect(reports()).toContain("consolidation: success (1 observations)");
		expect(reports()).toContain(autoPromote ? "project: failed" : "skipped (autoPromote:false)");
		await save(); expect(roles).toEqual(["consolidator"]);
	});

	it.each(["worker-exit", "invalid-bundle"])("retains pool and never promotes a failed consolidation: %s", async failure => {
		branch.push(observationsRecordedEntry("record", { coversUpToId: "first", observations: [observation("2026-10-22T10:00:00")] }));
		runtime.config.autoPromote = true;
		action = async opts => {
			if (failure === "invalid-bundle") atomicWrite(join(opts.cwd, "invalid.md"), "invalid frontmatter");
			return failure === "worker-exit" ? { code: 1, signal: null, stderr: "consolidation failed" } : success;
		};
		await save(); expect(roles).toEqual(["consolidator"]); expect(foldLedger(branch).activeObservations).toHaveLength(1);
		expect(reports()).toContain("Save incomplete");
	});

	it("retries an existing-topic promoter after failure, then skips unchanged saves but not external project replacement", async () => {
		branch.push(observationsRecordedEntry("record", { coversUpToId: "first", observations: [observation("2026-10-22T10:00:00")] }));
		// No active observations, but consolidated topics need their first project pass.
		branch.push({ id: "drop", type: "custom", customType: "om.observations.dropped", data: { coversUpToId: "first", observationTimestamps: ["2026-10-22T10:00:00"] } });
		runtime.config.autoPromote = true; atomicWrite(join(runtime.memoryRoot, "decisions.md"), topic);
		const normal = action;
		action = async () => ({ code: 1, signal: null, stderr: "promotion failed" });
		await save(); expect(roles).toEqual(["promotion"]); expect(reports()).toContain("project: failed");
		action = normal; await save(); await save(); expect(roles).toEqual(["promotion", "promotion"]);
		atomicWrite(join(cwd, ".memory/project/external.md"), topic);
		atomicWrite(join(cwd, ".memory/project/index.md"), renderIndexFile([]));
		await save(); expect(roles).toEqual(["promotion", "promotion", "promotion"]);
		expect(readFileSync(join(cwd, ".memory/project/external.md"), "utf8")).toBe(topic);
	});
});
