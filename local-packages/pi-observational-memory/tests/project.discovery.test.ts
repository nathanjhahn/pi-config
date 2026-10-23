import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import observationalMemory from "../src/index.js";
import * as config from "../src/config.js";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { atomicWrite, listTopics } from "../src/memory/paths.js";
import { renderProjectDiscovery } from "../src/memory/project.js";
import { Runtime } from "../src/runtime.js";
import { rawMessage } from "./fixtures/session.js";

const topic = (body: string) => `---\ntype: Memory Topic\ntitle: Topic\ndescription: Session-specific description\n---\n${body}`;
describe("project-memory discovery stays distinct from session memory", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "om-discovery-"));
		vi.spyOn(config, "loadConfig").mockReturnValue({ ...config.DEFAULTS, passive: false });
	});
	afterEach(() => { vi.restoreAllMocks(); rmSync(cwd, { recursive: true, force: true }); });
	function seed() {
		atomicWrite(join(cwd, ".memory/project/index.md"), '---\nokf_version: "0.2"\n---\n# Project\n[Secret](secret.md)\nUNTRUSTED INDEX BODY INSTRUCTIONS');
		atomicWrite(join(cwd, ".memory/project/secret.md"), topic("FULL PROJECT CORPUS SECRET"));
		atomicWrite(join(cwd, ".memory/session-a/auth.md"), topic("Session details"));
	}
	it("discovers only the index location/fixed summary at startup, with no corpus/ledger message; ON and off gates stay intact", async () => {
		seed();
		const handlers = new Map<string, Function>(), commands = new Map<string, any>();
		const appendEntry = vi.fn(), sendMessage = vi.fn();
		observationalMemory({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (name: string, def: any) => commands.set(name, def), appendEntry, sendMessage } as any);
		const ctx = { cwd, mode: "json", hasUI: false, sessionManager: { getSessionId: () => "session-a", getBranch: () => [], getEntries: () => [] } };
		handlers.get("session_start")!({}, ctx);
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		handlers.get("before_agent_start")!(event, ctx);
		expect(event.systemPromptOptions.sections.om_project_memory).toContain(".memory/project/index.md");
		expect(event.systemPromptOptions.sections.om_project_memory).toContain("not human review or runtime/test/deployment verification");
		expect(event.systemPromptOptions.sections.om_project_memory).not.toMatch(/SECRET|INSTRUCTIONS|secret.md/);
		expect(appendEntry).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
		await commands.get("om").handler("off", ctx);
		handlers.get("before_agent_start")!(event, ctx);
		expect(event.systemPromptOptions.sections.om_project_memory).toBeUndefined();
		handlers.get("session_shutdown")!({}, ctx);
	});
	it("keeps the project pointer alongside the session map at compaction without adding project topics to session counts", async () => {
		seed();
		const runtime = new Runtime();
		runtime.enabled = true; runtime.configLoaded = true;
		runtime.memoryRoot = join(cwd, ".memory/session-a");
		const branch = [rawMessage("a", "Earlier"), rawMessage("b", "Tail")];
		let handler: any;
		registerCompactionHook({ on: (_name: string, fn: any) => { handler = fn; } } as any, runtime);
		const result = await handler({ preparation: { firstKeptEntryId: "b", tokensBefore: 100 }, branchEntries: branch }, { cwd, hasUI: false, sessionManager: { getBranch: () => branch } });
		expect(result.compaction.summary).toContain("## Project memory");
		expect(result.compaction.summary).toContain(".memory/project/index.md");
		expect(result.compaction.summary).toContain(".memory/session-a/auth.md");
		expect(result.compaction.summary).not.toMatch(/FULL PROJECT CORPUS SECRET|UNTRUSTED INDEX/);
		expect(listTopics(runtime.memoryRoot)).toHaveLength(1);
		runtime.abortAllWorkers();
	});
	it("reports interrupted first-publication locks even before index.md exists", () => {
		atomicWrite(join(cwd, ".memory/.project-publish.lock"), "recovery metadata");
		expect(renderProjectDiscovery(cwd)).toContain("incomplete/locked");
	});
	it("ignores missing/malformed project indexes without reading concepts", () => {
		expect(renderProjectDiscovery(cwd)).toBeUndefined();
		atomicWrite(join(cwd, ".memory/project/index.md"), "not an index");
		expect(renderProjectDiscovery(cwd)).toBeUndefined();
	});
});
