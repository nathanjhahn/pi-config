import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_EXTENSION_PATH, buildWorkerArgv, buildWorkerEnv, modelArg } from "../src/spawn/launch.js";
import { readObserverResult, runResultPath, runsDir, writeObserverResult } from "../src/spawn/runs.js";
import { registerObserverTool } from "../agent/observer/tool.js";

describe("launch argv + env", () => {
	const model = { provider: "anthropic" as const, id: "claude-sonnet-4-6", thinking: "low" as const };

	it("builds the headless yt-edit-style flag set", () => {
		const argv = buildWorkerArgv({ model, sessionName: "om-observer-x", kickoffPrompt: "go" });
		expect(argv).toContain("--no-extensions");
		expect(argv).toContain("--no-builtin-tools");
		expect(argv).toContain("--no-skills");
		expect(argv).toContain("--no-prompt-templates");
		expect(argv).toContain("--no-context-files");
		expect(argv[argv.indexOf("--model") + 1]).toBe("anthropic/claude-sonnet-4-6");
		expect(argv[argv.indexOf("--thinking") + 1]).toBe("low");
		expect(argv[argv.indexOf("-e") + 1]).toBe(AGENT_EXTENSION_PATH);
		expect(argv[argv.indexOf("-n") + 1]).toBe("om-observer-x");
		expect(argv[argv.indexOf("-p") + 1]).toBe("go");
		expect(AGENT_EXTENSION_PATH.endsWith("/agent/index.ts")).toBe(true);
	});

	it("omits --thinking when no level is configured", () => {
		const argv = buildWorkerArgv({ model: { provider: "x", id: "y" }, sessionName: "n", kickoffPrompt: "p" });
		expect(argv).not.toContain("--thinking");
	});

	it("formats the model arg as provider/id", () => {
		expect(modelArg(model)).toBe("anthropic/claude-sonnet-4-6");
	});

	it("sets the worker IPC env vars", () => {
		const memoryRoot = "/proj/.memory/sess-1";
		const env = buildWorkerEnv("observer", { memoryRoot, runId: "r1" });
		expect(env.OM_WORKER).toBe("observer");
		expect(env.OM_RUN_ID).toBe("r1");
		// Chunk travels as the `pi -p` prompt (recorded user message), not via env/file.
		expect(env.OM_CHUNK_PATH).toBeUndefined();
		expect(env.OM_RESULT_PATH).toBe(runResultPath(memoryRoot, "r1"));
		expect(env.OM_MEMORY_DIR).toBe(memoryRoot);
	});

	it("resolves run paths under the session memory root's .runs", () => {
		expect(runsDir("/proj/.memory/sess-1")).toBe("/proj/.memory/sess-1/.runs");
	});
});

describe("observer result IPC round-trip", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "om-runs-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes and reads back valid observations", () => {
		const path = join(dir, "r.result.json");
		writeObserverResult(path, {
			observations: [
				{ timestamp: "2026-06-25 14:30", content: "ok" },
			],
		});
		const result = readObserverResult(path);
		expect(result.observations).toEqual([{ timestamp: "2026-06-25 14:30", content: "ok" }]);
	});

	it.each([
		{ observations: [{ garbage: true }] },
		{ observations: [{ timestamp: "2026-06-25 14:30", content: "ok" }, { timestamp: "2026-06-25 14:31", content: "  " }] },
	])("rejects the entire malformed array rather than certifying empty/partial coverage: %j", ({ observations }) => {
		const path = join(dir, "bad.result.json");
		writeFileSync(path, JSON.stringify({ observations }));
		expect(() => readObserverResult(path)).toThrow("invalid observation");
	});

	it("accepts explicit empty results but rejects missing IPC", () => {
		const path = join(dir, "empty.result.json");
		expect(() => readObserverResult(path)).toThrow();
		writeObserverResult(path, { observations: [] });
		expect(readObserverResult(path).observations).toEqual([]);
	});

	it("throws on a result file missing the observations array", () => {
		const path = join(dir, "bad.result.json");
		writeFileSync(path, JSON.stringify({ nope: true }));
		expect(() => readObserverResult(path)).toThrow();
	});
});

describe("registerObserverTool", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "om-tool-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("requires an explicit tool call for coverage and accumulates across calls", async () => {
		const path = join(dir, "r.result.json");
		let tool: any;
		const fakePi = { registerTool: (def: any) => (tool = def) } as any;

		registerObserverTool(fakePi, path);
		expect(() => readObserverResult(path)).toThrow();
		await tool.execute("empty", { observations: [] });
		expect(readObserverResult(path).observations).toEqual([]);

		await tool.execute("id1", { observations: [{ timestamp: "2026-06-25 14:30", content: "first" }] });
		await tool.execute("id2", {
			observations: [
				{ timestamp: "2026-06-25 14:30", content: "first" }, // duplicate
				{ timestamp: "2026-06-25 14:31", content: "second" },
			],
		});

		expect(readObserverResult(path).observations).toEqual([
			{ timestamp: "2026-06-25 14:30", content: "first" },
			{ timestamp: "2026-06-25 14:31", content: "second" },
		]);
	});
});
