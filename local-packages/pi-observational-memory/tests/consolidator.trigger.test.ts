import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateConsolidatorTrigger } from "../src/hooks/consolidator-trigger.js";
import { OM_OBSERVATIONS_DROPPED } from "../src/ledger/index.js";
import { atomicWrite, indexPath } from "../src/memory/paths.js";
import { Runtime } from "../src/runtime.js";
import { spawnWorker } from "../src/spawn/launch.js";
import { observation, observationsRecordedEntry, rawMessage } from "./fixtures/session.js";

vi.mock("../src/spawn/launch.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/spawn/launch.js")>(),
	spawnWorker: vi.fn(),
}));

const history = "---\ntype: Session History\ntitle: Session journey\ndescription: Descriptive history\ngenerated: {by: pi-observational-memory, at: 2026-10-21T15:00:00.000Z}\n---\n## Earlier\nWork began.";

describe("consolidation completion format gate", () => {
	let cwd: string;
	let runtime: Runtime;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "om-cons-trigger-"));
		runtime = new Runtime();
		runtime.enabled = true;
		runtime.memoryRoot = join(cwd, ".memory", "sess-1");
		runtime.config = { ...runtime.config, consolidateAtPoolTokens: 1, poolTargetTokens: 10 };
		vi.mocked(spawnWorker).mockReset();
	});
	afterEach(() => {
		runtime.abortAllWorkers();
		rmSync(cwd, { recursive: true, force: true });
	});

	async function consolidate() {
		const branch = [rawMessage("source", "original conversation"), observationsRecordedEntry("obs", {
			coversUpToId: "source",
			observations: [observation("2026-10-21T10:00:00"), observation("2026-10-21T11:00:00")],
		})];
		const appendEntry = vi.fn();
		const completed = new Promise<void>((done) => {
			vi.spyOn(runtime.status, "workerDone").mockImplementation(() => done());
			vi.spyOn(runtime.status, "workerError").mockImplementation(() => done());
		});
		evaluateConsolidatorTrigger({ appendEntry } as any, runtime, {
			hasUI: false, sessionManager: { getBranch: () => branch, getEntries: () => branch },
		});
		await completed;
		return appendEntry;
	}

	it("generates index after journey write, excludes IPC, then drops only the promoted batch", async () => {
		vi.mocked(spawnWorker).mockImplementation(async () => {
			atomicWrite(join(runtime.memoryRoot, "journey.md"), history);
			atomicWrite(join(runtime.memoryRoot, ".runs", "internal.md"), "not a concept");
			atomicWrite(join(runtime.memoryRoot, ".runs", "cost.json"), "{}");
			return { code: 0, signal: null, stderr: "" };
		});
		const append = await consolidate();
		expect(runtime.lastWorkerError).toBeUndefined();
		expect(readFileSync(indexPath(runtime.memoryRoot), "utf-8")).toContain("[Session journey](journey.md) — Descriptive history");
		expect(append).toHaveBeenCalledWith(OM_OBSERVATIONS_DROPPED, {
			coversUpToId: "source", observationTimestamps: ["2026-10-21T10:00:00"],
		});
		expect(runtime.consolidatorInFlight).toBe(false);
	});

	it("retains observations on invalid old Markdown and leaves existing memory untouched", async () => {
		atomicWrite(join(runtime.memoryRoot, "existing.md"), "legacy content left untouched");
		vi.mocked(spawnWorker).mockResolvedValue({ code: 0, signal: null, stderr: "" });
		const append = await consolidate();
		expect(runtime.lastWorkerError).toContain("existing.md");
		expect(append).not.toHaveBeenCalled();
		expect(existsSync(indexPath(runtime.memoryRoot))).toBe(false);
		expect(readFileSync(join(runtime.memoryRoot, "existing.md"), "utf-8")).toBe("legacy content left untouched");
	});

	it("retains observations when the subprocess fails", async () => {
		vi.mocked(spawnWorker).mockResolvedValue({ code: 1, signal: null, stderr: "worker failed" });
		const append = await consolidate();
		expect(runtime.lastWorkerError).toContain("consolidator exited with code 1");
		expect(append).not.toHaveBeenCalled();
	});
});
