import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerConsolidatorTools } from "../agent/consolidator/tools.js";
import { CONSOLIDATOR_SYSTEM } from "../agent/consolidator/prompt.js";
import { GENERATED_BY, parseFrontMatter } from "../src/memory/format.js";
import { buildConsolidatorPrompt } from "../src/hooks/consolidator-trigger.js";
import { buildWorkerEnv } from "../src/spawn/launch.js";

const concept = (body: string, fields = "") => `---\ntype: Memory Topic\ntitle: Auth\ndescription: JWT tokens\n${fields}---\n${body}`;

describe("buildWorkerEnv(consolidator)", () => {
	it("sets role, run id, and session memory sandbox", () => {
		const env = buildWorkerEnv("consolidator", { memoryRoot: "/proj/.memory/sess-1", runId: "c1" });
		expect(env.OM_WORKER).toBe("consolidator");
		expect(env.OM_RUN_ID).toBe("c1");
		expect(env.OM_MEMORY_DIR).toBe("/proj/.memory/sess-1");
	});
});

describe("consolidator tools: validated atomic concept mutations", () => {
	let cwd: string;
	let root: string;
	let tools: Map<string, any>;
	let time: string;
	const execute = (name: string, params: object) => tools.get(name).execute("id", params);
	const stored = (path = "auth.md") => readFileSync(join(root, path), "utf-8");

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "om-cons-tools-"));
		root = join(cwd, ".memory", "sess-1");
		tools = new Map();
		time = "2026-10-21T15:00:00.000Z";
		registerConsolidatorTools({ registerTool: (def: any) => tools.set(def.name, def) } as any, root, () => new Date(time));
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("registers the scoped tool belt (no terminal report tool)", () => {
		expect([...tools.keys()].sort()).toEqual(["edit", "grep", "ls", "read", "write"].sort());
	});
	it("writes valid native concepts and stamps known producer/ISO UTC time", async () => {
		const res = await execute("write", { path: "auth.md", content: concept("body", "id: legacy\nsummary: retired\nupdated: yesterday\n") });
		expect(res.content[0].text).toContain("Wrote auth.md");
		const { front } = parseFrontMatter(stored());
		expect(front.generated).toEqual({ by: GENERATED_BY, at: time });
		expect(front.id).toBeUndefined();
		expect(front.summary).toBeUndefined();
		expect(front.updated).toBeUndefined();
		const read = await execute("read", { path: "auth.md" });
		expect(read.content[0].text).toContain("body");
		expect(readdirSync(root)).toEqual(["auth.md"]); // no temporary files left
	});
	it.each(["index.md", "INDEX.md", "nested/index.md", "nested/INDEX.MD", "log.md", "nested/LOG.md"])("reserves %s for both write and edit", async (path) => {
		for (const name of ["write", "edit"]) {
			const res = await execute(name, { path, content: concept("x"), oldText: "x", newText: "y" });
			expect(res.isError).toBe(true);
			expect(res.content[0].text).toMatch(/generated automatically|reserved/);
		}
		expect(existsSync(join(root, path))).toBe(false);
	});
	it.each([".runs/x.json", ".runs/x.md", "x.txt", "nested/.private/x.md"])("does not write internal or non-Markdown artifacts: %s", async (path) => {
		expect((await execute("write", { path, content: concept("x") })).isError).toBe(true);
		expect(existsSync(join(root, path))).toBe(false);
	});
	it("rejects paths that escape .memory/", async () => {
		const res = await execute("write", { path: "../escape.md", content: concept("x") });
		expect(res.content[0].text).toContain("escapes .memory/");
	});
	it.each([
		"body only", "---\n[]\n---\nx", "---\ntype: [oops\n---\nx",
		"---\ntitle: x\ndescription: d\n---\nx", "---\ntype: 1\ntitle: x\ndescription: d\n---\nx",
		"---\ntype: ''\ntitle: x\ndescription: d\n---\nx",
		"---\ntype: X\ndescription: d\n---\nx", "---\ntype: X\ntitle: x\n---\nx",
		"---\ntype: X\ntitle: '  '\ndescription: d\n---\nx",
		"---\ntype: X\ntitle: x\ndescription: [not, string]\n---\nx",
	])("rejects invalid whole write without clobbering existing content: %s", async (content) => {
		await execute("write", { path: "auth.md", content: concept("original") });
		const before = stored();
		const res = await execute("write", { path: "auth.md", content });
		expect(res.isError).toBe(true);
		expect(stored()).toBe(before);
		expect(readdirSync(root)).toEqual(["auth.md"]);
	});
	it("validates the whole resulting edit before committing", async () => {
		await execute("write", { path: "auth.md", content: concept("body") });
		const before = stored();
		for (const [oldText, newText] of [["type: Memory Topic", "type: [oops"], ["title: Auth", "title: ''"], ["description: JWT tokens", "description: []"]]) {
			expect((await execute("edit", { path: "auth.md", oldText, newText })).isError).toBe(true);
			expect(stored()).toBe(before);
		}
	});
	it("edits exact unique text, keeps unknown metadata, and replaces $ sequences literally", async () => {
		await execute("write", { path: "auth.md", content: concept("alpha beta alpha", "custom: {nested: [x, y], day: 2026-10-21}\ngenerated: {by: untrusted, at: yesterday, extra: kept}\n") });
		expect((await execute("edit", { path: "auth.md", oldText: "alpha", newText: "X" })).content[0].text).toContain("ambiguous");
		expect((await execute("edit", { path: "auth.md", oldText: "", newText: "X" })).isError).toBe(true);
		expect((await execute("edit", { path: "auth.md", oldText: "missing", newText: "X" })).isError).toBe(true);
		time = "2026-10-21T16:00:00.000Z";
		expect((await execute("edit", { path: "auth.md", oldText: "beta", newText: "$& $' $$" })).content[0].text).toContain("Edited");
		const { front, body } = parseFrontMatter(stored());
		expect(body).toBe("alpha $& $' $$ alpha");
		expect(front.custom).toEqual({ nested: ["x", "y"], day: "2026-10-21" });
		expect(front.generated).toEqual({ by: GENERATED_BY, at: time, extra: "kept" });
	});
	it("does not refresh generated metadata or bytes on semantic no-ops", async () => {
		await execute("write", { path: "auth.md", content: concept("body") });
		const before = stored();
		time = "2026-10-22T16:00:00.000Z";
		await execute("write", { path: "auth.md", content: concept("body", "generated: {by: spoof, at: fake}\n") });
		expect(stored()).toBe(before);
		await execute("edit", { path: "auth.md", oldText: "body", newText: "body" });
		expect(stored()).toBe(before);
		await execute("edit", { path: "auth.md", oldText: "description: JWT tokens", newText: "description: New description" });
		expect(parseFrontMatter(stored()).front.generated).toEqual({ by: GENERATED_BY, at: time });
	});
	it("accepts unknown types, metadata and broken links", async () => {
		const res = await execute("write", { path: "future.md", content: concept("[missing](missing.md)", "x: [1, 2]\n").replace("Memory Topic", "Future Concept") });
		expect(res.isError).toBeUndefined();
		expect(parseFrontMatter(stored("future.md")).front.x).toEqual([1, 2]);
	});
	it("does not allow capitalized journey variants that compaction would miss", async () => {
		for (const name of ["write", "edit"]) {
			expect((await execute(name, { path: "nested/JOURNEY.MD", content: concept("x"), oldText: "x", newText: "y" })).content[0].text).toContain("canonical lowercase");
		}
	});
	it("rejects symlink escapes and does not search symlinked directories", async () => {
		await execute("write", { path: "auth.md", content: concept("inside") });
		symlinkSync(cwd, join(root, "link"), "dir");
		expect((await execute("write", { path: "link/escape.md", content: concept("outside") })).isError).toBe(true);
		expect(existsSync(join(cwd, "escape.md"))).toBe(false);
		expect((await execute("read", { path: "link/escape.md" })).isError).toBe(true);
		expect((await execute("grep", { pattern: "inside" })).content[0].text).not.toContain("link/");
	});
	it("requires full Session History concepts for journey.md, including nested journey paths", async () => {
		for (const path of ["journey.md", "nested/journey.md"]) {
			expect((await execute("write", { path, content: "## History\nbody only" })).isError).toBe(true);
			expect((await execute("write", { path, content: concept("wrong type") })).isError).toBe(true);
			expect((await execute("write", { path, content: concept("History").replace("Memory Topic", "Session History") })).isError).toBeUndefined();
		}
	});
	it("ls and grep operate within the session memory root", async () => {
		await execute("write", { path: "auth.md", content: concept("uses JWT tokens") });
		await execute("write", { path: "deploy.md", content: concept("uses fly.io") });
		const ls = await execute("ls", {});
		expect(ls.content[0].text.split("\n").sort()).toEqual(["auth.md", "deploy.md"]);
		const grep = await execute("grep", { pattern: "uses JWT" });
		expect(grep.content[0].text).toMatch(/auth\.md:\d+: uses JWT/);
	});
	it("prompts distinguish local narrative time from tool-owned UTC metadata, and request full journey", () => {
		const prompt = buildConsolidatorPrompt(root, [], 1000);
		expect(prompt).toContain("Use this local time only for dated journey body headings");
		expect(prompt).toContain("generated.at (ISO UTC)");
		expect(prompt).toContain("FULL concept with type: Session History");
		expect(CONSOLIDATOR_SYSTEM).toContain("BODY ONLY");
		expect(CONSOLIDATOR_SYSTEM).not.toContain("NO front-matter");
	});
});
