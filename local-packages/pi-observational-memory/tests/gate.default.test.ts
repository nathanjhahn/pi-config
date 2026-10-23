import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import observationalMemory from "../src/index.js";

/** Exercise the public session gate, not an exported test-only implementation helper. */
describe("local startup gate", () => {
	let cwd: string;
	beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "om-gate-")); });
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it.each([
		{ saved: undefined, command: "on" },
		{ saved: false, command: "off" },
		{ saved: true, command: "on" },
	])("defaults ON and preserves an explicit saved choice: $saved", async ({ saved, command }) => {
		const handlers = new Map<string, Function>();
		const commands = new Map<string, any>();
		const appendEntry = vi.fn();
		const branch = saved === undefined ? [] : [{ type: "custom", customType: "om.enabled", data: { enabled: saved } }];
		const ctx = {
			cwd, mode: "json", hasUI: false,
			sessionManager: {
				getSessionId: () => "gate-session",
				getBranch: () => branch,
				getEntries: () => branch,
			},
		};
		observationalMemory({
			on: (name: string, handler: Function) => handlers.set(name, handler),
			registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
			appendEntry,
		} as any);
		handlers.get("session_start")?.({}, ctx);
		// Requesting the already-effective choice is a no-op; the opposite choice would append.
		await commands.get("om").handler(command, ctx);
		expect(appendEntry).not.toHaveBeenCalled();
		await commands.get("om").handler(command === "on" ? "off" : "on", ctx);
		expect(appendEntry).toHaveBeenCalledWith("om.enabled", { enabled: command !== "on" });
		handlers.get("session_shutdown")?.({}, ctx);
	});
});
