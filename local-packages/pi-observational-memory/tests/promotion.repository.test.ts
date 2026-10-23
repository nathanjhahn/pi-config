import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { registerPromotionTools } from "../agent/promotion/tools.js";
import { applyPromotion, preparePromotion, preparePromotionWrite, readPromotionReview, sourceReferences, type PromotionResult } from "../src/memory/promotion.js";
import { atomicWrite } from "../src/memory/paths.js";
import { parseFrontMatter } from "../src/memory/format.js";
import { hashSnapshot, PROJECT_INDEX_DESCRIPTION, sha256, snapshotBundle } from "../src/memory/project.js";
import { spawnWorker } from "../src/spawn/launch.js";

vi.mock("../src/spawn/launch.js", async (original) => ({ ...await original<typeof import("../src/spawn/launch.js")>(), spawnWorker: vi.fn() }));
const concept = (body: string, extra = "") => `---\ntype: Memory Topic\ntitle: Lessons\ndescription: Supported static implementation facts\n${extra}---\n${body}\n`;

describe("promotion attested static repository evidence (mock workers only)", () => {
	let cwd: string, project: string, tools: Map<string, any>;
	let action: (opts: Parameters<typeof spawnWorker>[0]) => Promise<void>;
	const call = (name: string, args: object) => tools.get(name).execute("id", args);
	const repoWrite = (name: string, content: string) => atomicWrite(join(cwd, name), content);
	const prepare = () => preparePromotion({ cwd, sessionId: "session-a", model: { provider: "test", id: "no-network" }, mode: "automatic" });
	const apply = (p: PromotionResult, write?: (path: string, content: string) => void) => applyPromotion({ cwd, sessionId: "session-a", id: p.id, write, publication: "automatic" });
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "om-repo-evidence-")); project = join(cwd, ".memory/project"); tools = new Map();
		repoWrite(".memory/session-a/lessons.md", concept("Historical snapshot says 7 lessons; intentional design is tracked separately."));
		repoWrite("src/lessons.ts", "// static implementation\nexport const lessons = 12;\n// no runtime/test evidence\n");
		action = async () => {
			await call("write", { path: "lessons.md", content: concept("Static implementation declares 12 lessons; not a runtime/test result.") });
			expect((await call("repo_read", { path: "src/lessons.ts", offset: 2, limit: 1 })).isError).toBeUndefined();
		};
		vi.mocked(spawnWorker).mockReset();
		vi.mocked(spawnWorker).mockImplementation(async (opts) => {
			registerPromotionTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, {
				cwd, stage: opts.cwd, inputPath: opts.env.OM_PROMOTION_INPUT!, reportPath: opts.env.OM_PROMOTION_REPORT!,
				evidencePath: join(dirname(opts.env.OM_PROMOTION_INPUT!), "repo-evidence.json"),
			});
			await action(opts);
			await call("review", { summary: "Supported supersession: static declaration is 12, not the historical 7. No execution or human verification.", conflicts: [] });
			return { code: 0, signal: null, stderr: "" };
		});
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));
	it("adds exact parent-attested refs after a write-before-inspection, includes readable evidence and truthful scope, and applies", async () => {
		const beforeRepo = readFileSync(join(cwd, "src/lessons.ts"));
		const proposal = await prepare();
		const artifact = readFileSync(join(proposal.proposalDir, "repo-evidence.json"));
		const evidence = JSON.parse(artifact.toString());
		const manifest = JSON.parse(readFileSync(join(proposal.proposalDir, "manifest.json"), "utf8"));
		expect(manifest.evidenceHash).toBe(sha256(artifact));
		const candidate = parseFrontMatter(readFileSync(join(proposal.proposalDir, "staged/lessons.md"), "utf8")).front;
		expect(candidate.sources).toContainEqual({ resource: pathToFileURL(join(cwd, "src/lessons.ts")).href, om_content_sha256: sha256(beforeRepo),
			om_inspection_method: "static repository inspection", om_inspected_at: evidence.records[0].inspectedAt, om_inspected_lines: "2-2", om_inspection_tool: "repo_read" });
		expect(candidate.om_source_scope).toContain("scoped STATIC repository inspection where cited");
		expect(candidate.om_source_scope).toContain("not verification");
		expect(candidate.verified).toBeUndefined(); expect(candidate.human_reviewed).toBeUndefined();
		const review = readPromotionReview(cwd, "session-a", proposal.id);
		expect(review).toContain("lines 2-2"); expect(review).toContain("export const lessons = 12;"); expect(review).toContain("not whole-concept");
		expect(review).not.toContain("Approval means content review");
		apply(proposal);
		expect(readFileSync(join(cwd, "src/lessons.ts"))).toEqual(beforeRepo);
		expect(parseFrontMatter(readFileSync(join(project, "lessons.md"), "utf8")).front.sources).toEqual(candidate.sources);
	});
	it("has only staged tools, review and three read-only repo tools; never exposes shell/network/tests or IPC reads", async () => {
		action = async () => {
			expect([...tools.keys()].sort()).toEqual(["edit", "grep", "ls", "read", "repo_ls", "repo_read", "repo_search", "review", "write"].sort());
			expect((await call("read", { path: "../repo-evidence.json" })).isError).toBe(true);
			expect((await call("write", { path: "../repo-evidence.json", content: "forged" })).isError).toBe(true);
			expect((await call("repo_read", { path: ".memory/session-a/lessons.md" })).isError).toBe(true);
			const overlong = await call("repo_read", { path: "a".repeat(100_000) });
			expect(overlong.isError).toBe(true); expect(Buffer.byteLength(overlong.content[0].text)).toBeLessThanOrEqual(512);
			expect((await call("repo_read", { path: "src/lessons.ts" })).isError).toBeUndefined();
			await call("write", { path: "lessons.md", content: concept("Curated static fact") });
		};
		await prepare();
	});
	it("does not fabricate refs from directory listings or no-match searches", async () => {
		action = async () => {
			await call("repo_ls", { path: "src" }); await call("repo_search", { path: "src", query: "absent-literal" });
			await call("write", { path: "lessons.md", content: concept("Historical session only") });
		};
		const proposal = await prepare();
		const sources = parseFrontMatter(readFileSync(join(proposal.proposalDir, "staged/lessons.md"), "utf8")).front.sources as any[];
		expect(sources).toHaveLength(1); expect(sources[0].resource).toContain("/.memory/session-a/");
		expect(readPromotionReview(cwd, "session-a", proposal.id)).toContain("No repository content inspected");
		apply(proposal);
	});
	it("attests actual search match ranges, including multiple ranges of the same file, without dropping exact refs", async () => {
		repoWrite("src/lessons.ts", "const lessons = 12;\n// unrelated\nexport { lessons };\n");
		action = async () => { await call("repo_search", { path: "src", query: "lessons" }); await call("write", { path: "lessons.md", content: concept("Static declaration/export") }); };
		const proposal = await prepare(); apply(proposal);
		const sources = parseFrontMatter(readFileSync(join(project, "lessons.md"), "utf8")).front.sources as any[];
		expect(sources.filter((s) => s.om_inspection_tool === "repo_search").map((s) => s.om_inspected_lines)).toEqual(["1-1", "3-3"]);
	});
	it("rejects forged model repo refs at tools and raw stage bypass at the parent", async () => {
		const forged = { resource: pathToFileURL(join(cwd, "src/lessons.ts")).href, om_content_sha256: sha256(readFileSync(join(cwd, "src/lessons.ts"))), om_inspected_lines: "1-99" };
		action = async (opts) => {
			const content = concept("Forged citation", `sources: ${JSON.stringify([forged])}\n`);
			expect((await call("write", { path: "lessons.md", content })).isError).toBe(true);
			atomicWrite(join(opts.cwd, "lessons.md"), content);
		};
		await expect(prepare()).rejects.toThrow("source is not an allowed"); expect(existsSync(project)).toBe(false);
	});
	it("rejects fabricated inspection IPC content before sealing", async () => {
		action = async (opts) => {
			await call("repo_read", { path: "src/lessons.ts", limit: 1 });
			const path = join(dirname(opts.env.OM_PROMOTION_INPUT!), "repo-evidence.json"), evidence = JSON.parse(readFileSync(path, "utf8"));
			evidence.records[0].content = "not what was returned"; atomicWrite(path, JSON.stringify(evidence));
		};
		await expect(prepare()).rejects.toThrow("stale repository evidence");
	});
	it("seals the evidence artifact and rejects later tampering", async () => {
		const proposal = await prepare(); const path = join(proposal.proposalDir, "repo-evidence.json");
		const evidence = JSON.parse(readFileSync(path, "utf8")); evidence.records[0].inspectedAt = "2000-01-01T00:00:00.000Z"; atomicWrite(path, JSON.stringify(evidence));
		expect(() => apply(proposal)).toThrow("evidence artifact changed"); expect(existsSync(project)).toBe(false);
	});
	it("apply recomputation requires exact attested repo refs, not merely session refs", async () => {
		const proposal = await prepare();
		const input = JSON.parse(readFileSync(join(proposal.proposalDir, "input.json"), "utf8"));
		const sessionOnly = preparePromotionWrite(concept("Static implementation declares 12 lessons; not a runtime/test result."), undefined, sourceReferences(cwd, input), input.snapshotAt);
		atomicWrite(join(proposal.proposalDir, "staged/lessons.md"), sessionOnly);
		const path = join(proposal.proposalDir, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"));
		manifest.candidate["lessons.md"] = sha256(sessionOnly); atomicWrite(path, JSON.stringify(manifest));
		expect(() => apply(proposal)).toThrow("unauthorized provenance/metadata"); expect(existsSync(project)).toBe(false);
	});
	it("legacy session-only pending artifacts without evidence still apply with their original index description", async () => {
		action = async () => { await call("write", { path: "lessons.md", content: concept("Session-only settled decision") }); };
		const proposal = await prepare();
		const legacy = "Curated project knowledge from consolidated session snapshots, not verification of current code.";
		const manifestPath = join(proposal.proposalDir, "manifest.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		delete manifest.evidenceHash; rmSync(join(proposal.proposalDir, "repo-evidence.json"));
		for (const name of ["staged/index.md", "changes.diff", "review.md"]) {
			const path = join(proposal.proposalDir, name), content = readFileSync(path, "utf8").replaceAll(PROJECT_INDEX_DESCRIPTION, legacy);
			atomicWrite(path, content);
			if (name.startsWith("staged/")) manifest.candidate["index.md"] = sha256(content);
			if (name === "changes.diff") manifest.diffHash = sha256(content);
			if (name === "review.md") manifest.reviewHash = sha256(content);
		}
		atomicWrite(manifestPath, JSON.stringify(manifest));
		expect(apply(proposal)).toContain("lessons.md");
	});
	it("rejects evidence changed before preparation finishes", async () => {
		action = async () => { await call("repo_read", { path: "src/lessons.ts" }); await call("write", { path: "lessons.md", content: concept("Old inspected claim") }); repoWrite("src/lessons.ts", "changed after read\n"); };
		await expect(prepare()).rejects.toThrow("stale repository evidence"); expect(existsSync(project)).toBe(false);
	});
	it.each(["changed", "deleted", "symlink", "ignored"])("rejects %s evidence before publication without authoritative writes", async (change) => {
		const proposal = await prepare();
		if (change === "changed") repoWrite("src/lessons.ts", "different");
		if (change === "deleted") rmSync(join(cwd, "src/lessons.ts"));
		if (change === "symlink") { const original = readFileSync(join(cwd, "src/lessons.ts"), "utf8"); rmSync(join(cwd, "src/lessons.ts")); repoWrite("src/other.ts", original); symlinkSync(join(cwd, "src/other.ts"), join(cwd, "src/lessons.ts")); }
		if (change === "ignored") repoWrite("src/.gitignore", "lessons.ts\n");
		expect(() => apply(proposal)).toThrow("stale repository evidence"); expect(existsSync(project)).toBe(false);
	});
	it.each(["lessons.md", "index.md"])("rolls back if repo evidence changes during publication after writing %s", async (after) => {
		const original = await prepare(); apply(original);
		const before = hashSnapshot(snapshotBundle(cwd, project));
		action = async () => { await call("repo_read", { path: "src/lessons.ts" }); await call("write", { path: "lessons.md", content: concept("Updated qualified static fact") }); };
		const proposal = await prepare();
		expect(() => apply(proposal, (path, content) => { atomicWrite(path, content); if (basename(path) === after) repoWrite("src/lessons.ts", "changed during publication"); })).toThrow("stale repository evidence");
		expect(hashSnapshot(snapshotBundle(cwd, project))).toEqual(before);
		expect(existsSync(join(cwd, ".memory/.project-publish.lock"))).toBe(false);
	});
	it("keeps exact old repo source ranges/unknown metadata and adds newly inspected ranges even for the same file hash", async () => {
		const original = await prepare(); apply(original);
		const originalParsed = parseFrontMatter(readFileSync(join(project, "lessons.md"), "utf8"));
		(originalParsed.front.sources as any[])[1].extension = { keep: ["historical source metadata"] };
		originalParsed.front.unknown_old = { inherited: true };
		atomicWrite(join(project, "lessons.md"), `---\n${stringify(originalParsed.front)}---\n${originalParsed.body}`);
		const old = originalParsed.front.sources as any[];
		action = async () => { await call("repo_read", { path: "src/lessons.ts", offset: 1, limit: 1 }); await call("write", { path: "lessons.md", content: concept("Context and static declaration; preserves historical outcomes", "custom: {retain: true}\n") }); };
		const next = await prepare(); apply(next);
		const front = parseFrontMatter(readFileSync(join(project, "lessons.md"), "utf8")).front;
		for (const ref of old) expect(front.sources).toContainEqual(ref);
		expect((front.sources as any[]).filter((r) => r.om_inspection_method).map((r) => r.om_inspected_lines)).toEqual(["2-2", "1-1"]);
		expect(front.custom).toEqual({ retain: true }); expect(front.unknown_old).toEqual({ inherited: true });
		expect((front.sources as any[])[1].extension).toEqual({ keep: ["historical source metadata"] });
	});
	it("inspection without actual concept changes remains an automatic no-op", async () => {
		action = async () => { await call("repo_read", { path: "src/lessons.ts" }); };
		const proposal = await prepare(); expect(proposal.changedFiles).toEqual([]); expect(apply(proposal)).toEqual([]); expect(existsSync(project)).toBe(false);
	});
});
