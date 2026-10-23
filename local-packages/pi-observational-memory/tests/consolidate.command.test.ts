import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerConsolidateCommand } from "../src/commands/consolidate.js";
import { evaluateConsolidatorTrigger } from "../src/hooks/consolidator-trigger.js";
import { OM_OBSERVATIONS_DROPPED } from "../src/ledger/index.js";
import { atomicWrite } from "../src/memory/paths.js";
import { Runtime } from "../src/runtime.js";
import { spawnWorker, type WorkerExit } from "../src/spawn/launch.js";
import { observation, observationsDroppedEntry, observationsRecordedEntry, rawMessage, type TestEntry, type TestObservation } from "./fixtures/session.js";

vi.mock("../src/spawn/launch.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/spawn/launch.js")>(),
	spawnWorker: vi.fn(),
}));

const first = observation("2026-10-21T10:00:00", { content: "First fact", tokenCount: 10 });
const second = observation("2026-10-21T11:00:00", { content: "Second fact", tokenCount: 10 });
const third = observation("2026-10-21T12:00:00", { content: "Third fact", tokenCount: 10 });
const later = observation("2026-10-21T13:00:00", { content: "Later fact", tokenCount: 10 });

describe("/om:consolidate [all]", () => {
	let cwd: string;
	let runtime: Runtime;
	let branch: TestEntry[];
	let handler: (args: string, ctx: any) => Promise<void>;
	let ctx: any;
	let pi: any;
	let finishWorker: (exit: WorkerExit) => void;
	let completed: Promise<void>;

	function setObservations(observations: TestObservation[]): void {
		branch = [rawMessage("source", "Conversation"), observationsRecordedEntry("recorded", {
			coversUpToId: "source", observations,
		})];
	}
	function selectedLines(): string {
		const argv = vi.mocked(spawnWorker).mock.calls[0][0].argv;
		const prompt = argv[argv.indexOf("-p") + 1];
		return prompt.split("===== OBSERVATIONS TO CONSOLIDATE (each line is `<timestamp-id>  <content>`) =====\n")[1]
			.split("\n===== END OBSERVATIONS =====")[0];
	}
	async function complete(code = 0): Promise<void> {
		finishWorker({ code, signal: null, stderr: code ? "failed" : "" });
		await completed;
	}

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "om-manual-cons-"));
		runtime = new Runtime();
		runtime.enabled = true;
		runtime.configLoaded = true;
		runtime.memoryRoot = join(cwd, ".memory", "manual-session");
		// Freezing catches even temporary threshold mutations, not just restoration after a call.
		runtime.config = Object.freeze({ ...runtime.config, passive: false, poolTargetTokens: 10, consolidateAtPoolTokens: 1000 });
		setObservations([first, second, third]);
		ctx = { cwd, hasUI: true, ui: { notify: vi.fn() }, sessionManager: {
			getBranch: () => branch, getEntries: () => branch,
		} };
		pi = { appendEntry: vi.fn(), registerCommand: vi.fn((_name, definition) => { handler = definition.handler; }) };
		registerConsolidateCommand(pi, runtime);
		vi.mocked(spawnWorker).mockReset();
		vi.mocked(spawnWorker).mockImplementation(() => new Promise((resolve) => { finishWorker = resolve; }));
		completed = new Promise<void>((resolve) => {
			vi.spyOn(runtime.status, "workerDone").mockImplementation(() => resolve());
			vi.spyOn(runtime.status, "workerError").mockImplementation(() => resolve());
		});
	});
	afterEach(() => {
		runtime.abortAllWorkers();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("all promotes a single observation below target/trigger and never mutates configured values", async () => {
		runtime.config = Object.freeze({ ...runtime.config, poolTargetTokens: 100 });
		setObservations([first]);
		const config = runtime.config;
		const configuredValues = structuredClone(config);
		await handler(" all ", ctx);
		expect(spawnWorker).toHaveBeenCalledTimes(1);
		expect(selectedLines()).toBe(`${first.timestamp}  ${first.content}`);
		expect(pi.appendEntry).not.toHaveBeenCalled(); // nothing drops before worker completion
		expect(runtime.config).toBe(config);
		expect(runtime.config).toEqual(configuredValues);
		await complete();
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_DROPPED, {
			observationTimestamps: [first.timestamp], coversUpToId: "source",
		});
		expect(runtime.config).toBe(config);
		expect(runtime.config).toEqual(configuredValues);
	});

	it("all snapshots every active ID, excludes previously dropped IDs, and only drops selected IDs still active", async () => {
		setObservations([third, later, first, second]);
		branch.push(observationsDroppedEntry("old-drop", { observationTimestamps: [later.timestamp], coversUpToId: "source" }));
		await handler("all", ctx);
		expect(selectedLines().split("\n")).toEqual([first, second, third].map((o) => `${o.timestamp}  ${o.content}`));
		// A later worker's observation must never join this run's selection, and a selected ID
		// dropped elsewhere while this worker runs must not be dropped twice.
		const incoming = observation("2026-10-21T14:00:00", { content: "Arrived while running" });
		branch.push(rawMessage("new-source", "More conversation"), observationsRecordedEntry("incoming", {
			coversUpToId: "new-source", observations: [incoming],
		}), observationsDroppedEntry("concurrent-drop", { observationTimestamps: [second.timestamp], coversUpToId: "new-source" }));
		expect(pi.appendEntry).not.toHaveBeenCalled();
		await complete();
		expect(pi.appendEntry).toHaveBeenCalledExactlyOnceWith(OM_OBSERVATIONS_DROPPED, {
			observationTimestamps: [first.timestamp, third.timestamp], coversUpToId: "new-source",
		});
	});

	it("no args keeps oldest-overflow selection while ignoring only the trigger threshold", async () => {
		const config = runtime.config;
		const configuredValues = structuredClone(config);
		await handler("", ctx);
		expect(spawnWorker).toHaveBeenCalledTimes(1);
		expect(selectedLines().split("\n")).toEqual([first, second].map((o) => `${o.timestamp}  ${o.content}`));
		expect(runtime.config).toBe(config);
		expect(runtime.config).toEqual(configuredValues);
		await complete();
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_DROPPED, {
			observationTimestamps: [first.timestamp, second.timestamp], coversUpToId: "source",
		});
		expect(runtime.config).toEqual(configuredValues);
	});

	it("no args remains a no-op when there is no overflow", async () => {
		setObservations([first]);
		await handler("", ctx);
		expect(spawnWorker).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("nothing to consolidate"), "info");
	});

	it.each(["", "all"])("empty pool is a no-op for %j", async (args) => {
		setObservations([]);
		await handler(args, ctx);
		expect(spawnWorker).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("nothing to consolidate"), "info");
		expect(runtime.config.poolTargetTokens).toBe(10);
		expect(runtime.config.consolidateAtPoolTokens).toBe(1000);
	});

	it.each(["unknown", "all extra", "ALL", "--all"])("rejects %j with helpful usage and no side effects", async (args) => {
		const ensureConfig = vi.spyOn(runtime, "ensureConfig");
		await handler(args, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /om:consolidate [all]"), "error");
		expect(ensureConfig).not.toHaveBeenCalled();
		expect(spawnWorker).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it.each(["", "all"])("preserves off, passive and in-flight guards for %j", async (args) => {
		runtime.enabled = false;
		await handler(args, ctx);
		runtime.enabled = true;
		runtime.consolidatorInFlight = true;
		await handler(args, ctx);
		runtime.consolidatorInFlight = false;
		runtime.config = Object.freeze({ ...runtime.config, passive: true });
		await handler(args, ctx);
		expect(spawnWorker).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("automatic evaluation still observes configured thresholds", () => {
		evaluateConsolidatorTrigger(pi, runtime, ctx);
		expect(spawnWorker).not.toHaveBeenCalled();
		expect(runtime.config.poolTargetTokens).toBe(10);
		expect(runtime.config.consolidateAtPoolTokens).toBe(1000);
	});

	it("all retains selected observations after an invalid bundle despite successful worker exit", async () => {
		await handler("all", ctx);
		atomicWrite(join(runtime.memoryRoot, "bad.md"), "not a valid concept");
		await complete();
		expect(runtime.lastWorkerError).toContain("bad.md");
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("all retains selected observations after worker failure", async () => {
		await handler("all", ctx);
		await complete(1);
		expect(runtime.lastWorkerError).toContain("exited with code 1");
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});
});
