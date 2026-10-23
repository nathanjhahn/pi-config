import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import observationalMemory from "../src/index.js";
import { Runtime } from "../src/runtime.js";
import { registerPromotionTools } from "../agent/promotion/tools.js";
import { foldLedger } from "../src/ledger/index.js";
import { atomicWrite } from "../src/memory/paths.js";
import { spawnWorker, type WorkerExit } from "../src/spawn/launch.js";
import { writeObserverResult, writeWorkerCost } from "../src/spawn/runs.js";
import { observation, observationsRecordedEntry, rawMessage, type TestEntry } from "./fixtures/session.js";

vi.mock("../src/spawn/launch.js", async (original) => ({
	...await original<typeof import("../src/spawn/launch.js")>(), spawnWorker: vi.fn(),
}));

const success: WorkerExit = { code: 0, signal: null, stderr: "" };
const topic = (body: string) => `---\ntype: Memory Topic\ntitle: Checkpoint architecture\ndescription: Durable checkpoint knowledge\n---\n${body}\n`;
type Launch = Parameters<typeof spawnWorker>[0];
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

/** Black-box acceptance tests use only the installed extension registration entry point. */
describe("/om:save public checkpoint acceptance", () => {
	let cwd: string, sessionId: string, branch: TestEntry[], runtime: Runtime;
	let commands: Map<string, any>, handlers: Map<string, Function[]>;
	let pi: any, ctx: any, roles: string[], sourcePrompts: string[];
	let allowActivePoolDuringPromotion: boolean;
	let observer: (opts: Launch) => Promise<WorkerExit>;
	let consolidator: (opts: Launch) => Promise<WorkerExit>;
	let promoter: (opts: Launch, tools: Map<string, any>) => Promise<WorkerExit>;
	const root = () => join(cwd, ".memory", sessionId);
	const messages = () => [
		...ctx.ui.notify.mock.calls.map(([text]: string[]) => text),
		...pi.sendMessage.mock.calls.map(([message]: any[]) => message.content),
	].join("\n");
	async function emit(event: string) {
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	}
	function configure(extra: object = {}) {
		atomicWrite(join(cwd, ".pi/settings.json"), JSON.stringify({ "observational-memory": {
			passive: false, autoPromote: true, chunkTokens: 10000,
			consolidateAtPoolTokens: 100000, compactAtContextTokens: 1000000, ...extra,
		} }));
	}
	async function mount() {
		commands = new Map(); handlers = new Map();
		observationalMemory(pi);
		await emit("session_start");
		runtime = vi.mocked(Runtime.prototype.abortAllWorkers).mock.contexts.at(-1)! as Runtime;
	}
	async function save() {
		expect(commands.has("om:save")).toBe(true);
		await commands.get("om:save").handler("", ctx);
	}
	beforeEach(async () => {
		cwd = mkdtempSync(join(tmpdir(), "om-save-acceptance-")); sessionId = "save-session";
		branch = [rawMessage("source-1", "Finished the implementation; keep the durable architecture decision.")];
		roles = []; sourcePrompts = []; allowActivePoolDuringPromotion = false;
		configure();
		ctx = { cwd, mode: "json", hasUI: true, ui: { notify: vi.fn() },
			isIdle: () => true, hasPendingMessages: () => false,
			sessionManager: { getSessionId: () => sessionId, getBranch: () => branch, getEntries: () => branch,
				getLeafId: () => branch.at(-1)?.id ?? null },
		};
		pi = {
			on: (event: string, handler: Function) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
			registerCommand: (name: string, definition: any) => commands.set(name, definition),
			appendEntry: vi.fn((customType: string, data: unknown) => {
				branch.push({ id: `ledger-${branch.length}`, type: "custom", customType, data,
					parentId: branch.at(-1)?.id ?? null, timestamp: "2026-10-22T15:00:00Z" });
			}),
			sendMessage: vi.fn((message: any) => {
				branch.push({ ...message, id: `status-${branch.length}`, type: "custom_message",
					parentId: branch.at(-1)?.id ?? null, timestamp: "2026-10-22T15:00:00Z" });
			}),
		};
		observer = async (opts) => {
			writeObserverResult(opts.env.OM_RESULT_PATH!, { observations: [{
				timestamp: "2026-10-22 15:00", content: "The implementation now uses the settled architecture.",
			}] });
			return success;
		};
		consolidator = async (opts) => {
			atomicWrite(join(opts.cwd, "architecture.md"), topic("The session settled the architecture."));
			return success;
		};
		promoter = async (_opts, tools) => {
			await tools.get("write").execute("write", { path: "architecture.md", content: topic("Reusable project architecture.") });
			await tools.get("review").execute("review", { summary: "Promote reusable architecture", conflicts: [] });
			return success;
		};
		vi.mocked(spawnWorker).mockReset();
		vi.mocked(spawnWorker).mockImplementation(async (opts) => {
			const role = opts.env.OM_WORKER!; roles.push(role);
			writeWorkerCost(opts.env.OM_COST_PATH!, { costUsd: 0.01 });
			if (role === "observer") { sourcePrompts.push(opts.argv.at(-1)!); return observer(opts); }
			if (role === "consolidator") {
				expect(foldLedger(branch).activeObservations.length).toBeGreaterThan(0);
				return consolidator(opts);
			}
			expect(role).toBe("promotion");
			if (!allowActivePoolDuringPromotion) expect(foldLedger(branch).activeObservations).toHaveLength(0);
			const tools = new Map<string, any>();
			registerPromotionTools({ registerTool: (definition: any) => tools.set(definition.name, definition) } as any, {
				cwd, stage: opts.env.OM_MEMORY_DIR!, inputPath: opts.env.OM_PROMOTION_INPUT!, reportPath: opts.env.OM_PROMOTION_REPORT!,
			});
			return promoter(opts, tools);
		});
		vi.spyOn(Runtime.prototype, "abortAllWorkers");
		await mount();
	});
	afterEach(async () => {
		await emit("session_shutdown");
		vi.restoreAllMocks(); rmSync(cwd, { recursive: true, force: true });
	});

	it("observes a below-threshold tail, commits session topics, publishes, and does not compact", async () => {
		const compact = vi.fn(); ctx.compact = compact;
		await save();
		expect(roles).toEqual(["observer", "consolidator", "promotion"]);
		expect(readFileSync(join(root(), "architecture.md"), "utf8")).toContain("session settled");
		expect(readFileSync(join(cwd, ".memory/project/architecture.md"), "utf8")).toContain("Reusable project");
		expect(foldLedger(branch).activeObservations).toHaveLength(0);
		expect(runtime.observersInFlight.size).toBe(0);
		expect(runtime.consolidatorInFlight).toBe(false);
		expect(compact).not.toHaveBeenCalled();
		expect(messages()).toMatch(/source-1/);
	});

	it("does not return while the promoter is still running", async () => {
		const entered = deferred<void>(), release = deferred<void>();
		const normal = promoter;
		promoter = async (opts, tools) => { entered.resolve(); await release.promise; return normal(opts, tools); };
		let returned = false;
		const pending = save().then(() => { returned = true; });
		await entered.promise;
		expect(returned).toBe(false);
		expect(existsSync(join(cwd, ".memory/project/architecture.md"))).toBe(false);
		release.resolve(); await pending;
		expect(returned).toBe(true);
		expect(existsSync(join(cwd, ".memory/project/architecture.md"))).toBe(true);
	});

	it("captures a fixed endpoint and leaves later conversation for the next save", async () => {
		const entered = deferred<void>(), release = deferred<void>();
		const normal = observer;
		observer = async (opts) => { entered.resolve(); await release.promise; return normal(opts); };
		const pending = save(); await entered.promise;
		branch.push(rawMessage("source-2", "NEW-LATER-DECISION after checkpoint began"));
		await emit("agent_start");
		expect(roles).toEqual(["observer"]);
		release.resolve(); await pending;
		expect(sourcePrompts.join("\n")).not.toContain("NEW-LATER-DECISION");
		await save();
		expect(sourcePrompts.at(-1)).toContain("NEW-LATER-DECISION");
	});

	it("waits for an existing consolidation chain before observing and draining the checkpoint tail", async () => {
		configure({ poolTargetTokens: 1, consolidateAtPoolTokens: 1 });
		branch.push(observationsRecordedEntry("earlier-observer", { coversUpToId: "source-1",
			observations: [observation("2026-10-22T14:00:00"), observation("2026-10-22T14:01:00")] }));
		allowActivePoolDuringPromotion = true; // Background overflow intentionally retains the newest observation.
		await mount();
		const entered = deferred<void>(), release = deferred<void>();
		const normal = consolidator;
		let first = true;
		consolidator = async (opts) => {
			if (first) { first = false; entered.resolve(); await release.promise; }
			return normal(opts);
		};
		await emit("agent_start"); await entered.promise;
		branch.push(rawMessage("source-2", "TRAILING-CHECKPOINT-CONTENT not in the earlier observation"));
		const pending = save();
		expect(roles).toEqual(["consolidator"]);
		release.resolve(); await pending;
		expect(roles).toEqual(["consolidator", "promotion", "observer", "consolidator", "promotion"]);
		expect(sourcePrompts.at(-1)).toContain("TRAILING-CHECKPOINT-CONTENT");
		expect(foldLedger(branch).activeObservations).toHaveLength(0);
	});

	it("does not re-run any model for a repeated completed save with no new source", async () => {
		await save(); const calls = roles.length;
		await save(); expect(roles).toHaveLength(calls);
	});

	it("does not reuse a project-success checkpoint after the published project bundle is removed", async () => {
		await save();
		rmSync(join(cwd, ".memory/project"), { recursive: true, force: true });
		await save();
		expect(roles).toEqual(["observer", "consolidator", "promotion", "promotion"]);
		expect(existsSync(join(cwd, ".memory/project/architecture.md"))).toBe(true);
	});

	it("does not certify a no-additions review of project memory that disappeared during the model call", async () => {
		atomicWrite(join(cwd, ".memory/project/index.md"), '---\nokf_version: "0.2"\n---\n');
		atomicWrite(join(cwd, ".memory/project/architecture.md"), topic("Existing project architecture."));
		const entered = deferred<void>(), release = deferred<void>();
		const normal = promoter;
		promoter = async (_opts, tools) => {
			entered.resolve(); await release.promise;
			await tools.get("review").execute("review", { summary: "No additions to the supplied project snapshot", conflicts: [] });
			return success;
		};
		const pending = save(); await entered.promise;
		rmSync(join(cwd, ".memory/project"), { recursive: true, force: true });
		release.resolve(); await pending;
		expect(existsSync(join(cwd, ".memory/project"))).toBe(false);
		expect(branch.some((entry) => entry.customType === "om.save.checkpoint")).toBe(false);
		promoter = normal; await save();
		expect(roles).toEqual(["observer", "consolidator", "promotion", "promotion"]);
		expect(existsSync(join(cwd, ".memory/project/architecture.md"))).toBe(true);
	});

	it("does not checkpoint changed project bytes using a prior chain that finished while observers were pending", async () => {
		configure({ chunkTokens: 10 });
		branch.push(observationsRecordedEntry("earlier-observer", { coversUpToId: "source-1",
			observations: [observation("2026-10-22T14:00:00"), observation("2026-10-22T14:01:00")] }));
		branch.push(rawMessage("source-2", "Pending empty observer ".repeat(20)));
		await mount();
		const observerEntered = deferred<void>(), releaseObserver = deferred<void>();
		const promoterEntered = deferred<void>(), releasePromoter = deferred<void>();
		const normalPromoter = promoter;
		observer = async (opts) => {
			observerEntered.resolve(); await releaseObserver.promise;
			writeObserverResult(opts.env.OM_RESULT_PATH!, { observations: [] }); return success;
		};
		promoter = async (opts, tools) => {
			await normalPromoter(opts, tools); promoterEntered.resolve(); await releasePromoter.promise; return success;
		};
		await emit("agent_start"); await observerEntered.promise;
		await commands.get("om:consolidate").handler("all", ctx);
		await promoterEntered.promise;
		const priorChain = runtime.consolidatorTask!;
		const pending = save();
		releasePromoter.resolve(); await priorChain;
		expect(existsSync(join(cwd, ".memory/project/architecture.md"))).toBe(true);
		rmSync(join(cwd, ".memory/project"), { recursive: true, force: true });
		releaseObserver.resolve(); await pending;
		expect(branch.some((entry) => entry.customType === "om.save.checkpoint")).toBe(false);
		expect(roles).toEqual(["observer", "consolidator", "promotion"]);
		promoter = normalPromoter; await save();
		expect(roles).toEqual(["observer", "consolidator", "promotion", "promotion"]);
	});

	it("binds publication success to the actual candidate, not replacement bytes observed after notification", async () => {
		let removed = false;
		ctx.ui.notify.mockImplementation((message: string) => {
			if (!removed && message.includes("automatically published project knowledge")) {
				removed = true;
				rmSync(join(cwd, ".memory/project"), { recursive: true, force: true });
			}
		});
		await save();
		expect(removed).toBe(true);
		expect(existsSync(join(cwd, ".memory/project"))).toBe(false);
		expect(branch.some((entry) => entry.customType === "om.save.checkpoint")).toBe(false);
		ctx.ui.notify.mockImplementation(() => {});
		await save();
		expect(roles).toEqual(["observer", "consolidator", "promotion", "promotion"]);
		expect(existsSync(join(cwd, ".memory/project/architecture.md"))).toBe(true);
	});

	it("does not reuse a checkpoint while project publication requires lock recovery", async () => {
		await save(); const checkpoints = branch.filter((entry) => entry.customType === "om.save.checkpoint").length;
		atomicWrite(join(cwd, ".memory/.project-publish.lock"), "Unresolved publication fixture");
		ctx.ui.notify.mockClear();
		await save();
		expect(roles).toEqual(["observer", "consolidator", "promotion"]);
		expect(messages()).toMatch(/lock|recovery|unavailable|incomplete/i);
		expect(messages()).not.toContain("Already checkpointed");
		expect(branch.filter((entry) => entry.customType === "om.save.checkpoint")).toHaveLength(checkpoints);
	});

	it("persists valid zero-observation coverage across reload without inventing observations", async () => {
		observer = async (opts) => { writeObserverResult(opts.env.OM_RESULT_PATH!, { observations: [] }); return success; };
		await save();
		expect(roles).toEqual(["observer"]);
		expect(foldLedger(branch).observations).toHaveLength(0);
		await emit("session_shutdown"); await mount(); await save();
		expect(roles).toEqual(["observer"]);
	});

	it("rejects a malformed observer array instead of treating it as successful empty coverage", async () => {
		observer = async (opts) => { atomicWrite(opts.env.OM_RESULT_PATH!, JSON.stringify({ observations: [{ garbage: true }] })); return success; };
		await save();
		expect(roles).toEqual(["observer"]);
		expect(existsSync(join(cwd, ".memory/project"))).toBe(false);
		expect(messages()).toMatch(/failed|incomplete|invalid|malformed/i);
		observer = async (opts) => { writeObserverResult(opts.env.OM_RESULT_PATH!, { observations: [] }); return success; };
		await save(); expect(roles).toEqual(["observer", "observer"]);
	});

	it("repairs an earlier parallel observer failure instead of trusting a later success watermark", async () => {
		configure({ chunkTokens: 10, observerConcurrency: 2 });
		branch = [rawMessage("chunk-a", `EARLY-FAILED ${"a".repeat(120)}`),
			rawMessage("chunk-b", `LATER-SUCCESS ${"b".repeat(120)}`)];
		await mount();
		const laterEntered = deferred<void>(), releaseLater = deferred<void>();
		let firstAttempts = 0;
		observer = async (opts) => {
			if (opts.argv.at(-1)!.includes("EARLY-FAILED") && firstAttempts++ === 0) {
				return { code: 1, signal: null, stderr: "first parallel chunk failed" };
			}
			if (opts.argv.at(-1)!.includes("LATER-SUCCESS")) {
				laterEntered.resolve(); await releaseLater.promise;
			}
			writeObserverResult(opts.env.OM_RESULT_PATH!, { observations: [] });
			return success;
		};
		await emit("agent_start"); await laterEntered.promise;
		const pending = save(); releaseLater.resolve(); await pending;
		// A save may explicitly stop on a failed existing worker; a second invocation
		// must still be able to repair that hole, never claiming the later marker covers it.
		if (firstAttempts < 2) await save();
		expect(firstAttempts).toBe(2);
		expect(sourcePrompts.filter((prompt) => prompt.includes("EARLY-FAILED"))).toHaveLength(2);
		const calls = roles.length;
		await save(); expect(roles).toHaveLength(calls);
	});

	it("reports project conflicts but retains successfully consolidated session memory", async () => {
		promoter = async (_opts, tools) => {
			await tools.get("review").execute("review", { summary: "Unresolved architecture conflict", conflicts: ["Two incompatible architecture requirements"] });
			return success;
		};
		await save();
		expect(existsSync(join(root(), "architecture.md"))).toBe(true);
		expect(foldLedger(branch).activeObservations).toHaveLength(0);
		expect(existsSync(join(cwd, ".memory/project"))).toBe(false);
		expect(messages()).toMatch(/conflict/i);
	});

	it("retries project curation from existing topics after a conflict without repeating consolidation", async () => {
		const normal = promoter;
		promoter = async (_opts, tools) => {
			await tools.get("review").execute("review", { summary: "Unresolved", conflicts: ["Architecture ambiguity"] });
			return success;
		};
		await save();
		expect(roles).toEqual(["observer", "consolidator", "promotion"]);
		promoter = normal;
		await save();
		expect(roles).toEqual(["observer", "consolidator", "promotion", "promotion"]);
		expect(existsSync(join(cwd, ".memory/project/architecture.md"))).toBe(true);
		await save(); expect(roles).toHaveLength(4);
	});

	it("honors automatic-promotion opt-out without skipping session persistence", async () => {
		configure({ autoPromote: false }); await mount(); await save();
		expect(roles).toEqual(["observer", "consolidator"]);
		expect(foldLedger(branch).activeObservations).toHaveLength(0);
		expect(messages()).toMatch(/autoPromote|disabled|opt.out|skipped/i);
	});

	it.each([false, true])("keeps session saving independent of an unsafe project bundle (autoPromote=%s)", async (autoPromote) => {
		configure({ autoPromote }); await mount();
		atomicWrite(join(cwd, ".memory/project/index.md"), '---\nokf_version: "0.2"\n---\n');
		atomicWrite(join(cwd, "outside.md"), "An unrelated fixture; must not be followed.");
		symlinkSync(join(cwd, "outside.md"), join(cwd, ".memory/project/unsafe.md"));
		await save();
		expect(roles).toEqual(["observer", "consolidator"]);
		expect(existsSync(join(root(), "architecture.md"))).toBe(true);
		expect(foldLedger(branch).activeObservations).toHaveLength(0);
		if (autoPromote) expect(messages()).toMatch(/project: failed|project.*unsafe|project.*symlink/i);
		else {
			expect(messages()).toMatch(/autoPromote:false|disabled|opt.out/i);
			await save(); expect(roles).toEqual(["observer", "consolidator"]);
		}
	});

	it("does not chase its own non-UI status messages on subsequent saves", async () => {
		ctx.hasUI = false;
		await save(); const calls = roles.length;
		expect(pi.sendMessage).toHaveBeenCalled();
		await save(); expect(roles).toHaveLength(calls);
	});

	it("does not commit a late zero-exit observer into a different session", async () => {
		const entered = deferred<void>(), release = deferred<void>();
		const normal = observer;
		observer = async (opts) => { entered.resolve(); await release.promise; return normal(opts); };
		const pending = save(); await entered.promise;
		sessionId = "different-session"; branch = [];
		await emit("session_start");
		release.resolve(); await pending;
		expect(foldLedger(branch).observations).toHaveLength(0);
		expect(branch.filter((entry) => entry.customType === "om.cost")).toHaveLength(0);
		expect(roles).toEqual(["observer"]);
		expect(existsSync(join(cwd, ".memory/project"))).toBe(false);
	});
});
