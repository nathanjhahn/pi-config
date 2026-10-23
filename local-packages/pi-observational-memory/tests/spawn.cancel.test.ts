import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnWorker } from "../src/spawn/launch.js";
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

describe("worker cancellation escalation (no actual processes)", () => {
	let cwd: string;
	beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "om-cancel-")); vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); rmSync(cwd, { recursive: true, force: true }); });
	function child() {
		const proc = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), killed: false, kill: vi.fn((_signal: string) => { proc.killed = true; return true; }) });
		vi.mocked(spawn).mockReturnValue(proc as any);
		return proc;
	}
	it("sends SIGKILL if SIGTERM was sent but the process has not exited", async () => {
		const proc = child(), controller = new AbortController();
		const task = spawnWorker({ argv: ["never-run"], cwd, env: {}, signal: controller.signal });
		controller.abort();
		expect(proc.killed).toBe(true);
		vi.advanceTimersByTime(3000);
		expect(proc.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
		proc.emit("close", null, "SIGKILL");
		await expect(task).resolves.toMatchObject({ signal: "SIGKILL" });
	});
	it("does not send SIGKILL after the child actually exits", async () => {
		const proc = child(), controller = new AbortController();
		const task = spawnWorker({ argv: ["never-run"], cwd, env: {}, signal: controller.signal });
		controller.abort();
		proc.emit("exit", 0, null);
		vi.advanceTimersByTime(3000);
		expect(proc.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
		proc.emit("close", 0, null);
		await task;
	});
});
