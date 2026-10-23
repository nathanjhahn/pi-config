import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPromotionTools } from "../agent/promotion/tools.js";
import { applyPromotion, preparePromotion, preparePromotionWrite, readPromotionReview, type PromotionResult } from "../src/memory/promotion.js";
import { atomicWrite, listTopics, validateMemoryBundle } from "../src/memory/paths.js";
import { parseFrontMatter, parseYamlFrontMatter } from "../src/memory/format.js";
import { renderIndexFile } from "../src/memory/index-render.js";
import { hashSnapshot, managedPath, projectConceptPath, projectMemoryRoot, publicationLockPath, renderProjectDiscovery, sha256, snapshotBundle } from "../src/memory/project.js";
import { spawnWorker } from "../src/spawn/launch.js";
import { writeWorkerCost } from "../src/spawn/runs.js";

vi.mock("../src/spawn/launch.js", async (original) => ({ ...await original<typeof import("../src/spawn/launch.js")>(), spawnWorker: vi.fn() }));
const proposalTime = "2026-10-22T01:00:00.000Z";
const sourceTime = "2026-10-20T12:00:00.000Z";
const model = { provider: "test", id: "no-network" };
const concept = (body: string, extra = "") => `---\ntype: Memory Topic\ntitle: Architecture\ndescription: Durable design notes\ngenerated: {by: original, at: ${sourceTime}}\n${extra}---\n${body}\n`;

describe("two-step project promotion (mock workers, temporary projects only)", () => {
	let cwd: string;
	let session: string;
	let project: string;
	let tools: Map<string, any>;
	let action: (opts: Parameters<typeof spawnWorker>[0]) => Promise<void>;
	const call = (name: string, params: object) => tools.get(name).execute("id", params);
	const write = (name: string, content: string) => atomicWrite(join(project, name), content);
	const source = (name: string, content: string) => atomicWrite(join(session, name), content);
	const prepare = () => preparePromotion({ cwd, sessionId: "session-a", model, now: () => new Date(proposalTime) });
	const apply = (p: PromotionResult, writer?: (path: string, content: string) => void) => applyPromotion({ cwd, sessionId: "session-a", id: p.id, write: writer });
	function seedProject() {
		write("nested/existing.md", concept("Existing truth", "custom: {keep: [x, y]}\nsources: [{resource: 'https://example.org/old', quote: Original, unknown: {retained: true}}]\n"));
		write("unrelated.md", concept("Unrelated existing knowledge"));
		write("index.md", renderIndexFile([]));
		mkdirSync(join(project, "empty-assets"));
	}
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "om-project-promotion-"));
		session = join(cwd, ".memory", "session-a");
		project = projectMemoryRoot(cwd);
		source("auth.md", concept("Settled architecture"));
		tools = new Map();
		action = async () => { expect((await call("write", { path: "durable.md", content: concept("Curated enduring knowledge") })).isError).toBeUndefined(); };
		vi.mocked(spawnWorker).mockReset();
		vi.mocked(spawnWorker).mockImplementation(async (opts) => {
			registerPromotionTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, {
				cwd, stage: opts.env.OM_MEMORY_DIR!, inputPath: opts.env.OM_PROMOTION_INPUT!, reportPath: opts.env.OM_PROMOTION_REPORT!,
			});
			await action(opts);
			if (!existsSync(opts.env.OM_PROMOTION_REPORT!)) await call("review", { summary: "Curated stable knowledge; omitted temporary observations.", conflicts: [] });
			writeWorkerCost(opts.env.OM_COST_PATH!, { costUsd: 0.125 });
			return { code: 0, signal: null, stderr: "" };
		});
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("only stages consolidated session Memory Topics; sources exclude journey, runtime, other sessions and project", async () => {
		seedProject();
		source("journey.md", concept("SESSION JOURNEY SECRET").replace("Memory Topic", "Session History"));
		source("alternate-history.md", concept("HISTORY SECRET").replace("Memory Topic", "Session History"));
		source("nested/topic.md", concept("Nested consolidated source"));
		source(".runs/ignore.md", "INTERNAL SECRET");
		atomicWrite(join(cwd, ".memory", "other-session", "topic.md"), concept("OTHER SESSION SECRET"));
		const before = hashSnapshot(snapshotBundle(cwd, project));
		const sourceBefore = readFileSync(join(session, "auth.md"), "utf8");
		action = async (opts) => {
			expect(opts.env.OM_WORKER).toBe("promotion");
			expect(opts.cwd).toContain("/.proposals/");
			expect(opts.cwd).toBe(opts.env.OM_MEMORY_DIR);
			expect(opts.cwd).not.toBe(project);
			const input = JSON.parse(readFileSync(opts.env.OM_PROMOTION_INPUT!, "utf8"));
			expect(input.sources.map((s: any) => s.filename)).toEqual(["auth.md", "nested/topic.md"]);
			expect(JSON.stringify(input)).not.toMatch(/SECRET|Existing truth/);
			expect((await call("read", { path: "nested/existing.md" })).content[0].text).toContain("Existing truth");
			expect(readFileSync(join(opts.cwd, "unrelated.md"), "utf8")).toContain("Unrelated existing knowledge");
			await call("write", { path: "durable.md", content: concept("Curated architecture") });
		};
		const p = await prepare();
		expect(hashSnapshot(snapshotBundle(cwd, project))).toEqual(before);
		expect(readFileSync(join(session, "auth.md"), "utf8")).toBe(sourceBefore);
		expect(() => validateMemoryBundle(session)).not.toThrow(); // hidden review.md never becomes a session concept
		expect(listTopics(session).map((t) => t.filename)).not.toContain("durable.md");
		expect(readFileSync(p.diffPath, "utf8")).toContain("+++ b/durable.md");
		expect(readPromotionReview(cwd, "session-a", p.id)).toContain("Separate approval command:");
		expect(readPromotionReview(cwd, "session-a", p.id)).toContain(`Proposal created/source files copied at: **${proposalTime}**`);
		expect(readPromotionReview(cwd, "session-a", p.id)).toContain(`source generated.at: "${sourceTime}"`);
		expect(readPromotionReview(cwd, "session-a", p.id)).toContain("NOT a conversation/event date");
		expect(p.costUsd).toBe(0.125);
	});

	it("apply separately publishes concepts atomically with index last, preserves nested/irrelevant files/resources and does not imply verification", async () => {
		seedProject();
		const existing = readFileSync(join(project, "nested/existing.md"));
		const unrelated = readFileSync(join(project, "unrelated.md"));
		atomicWrite(join(project, "resource.bin"), "\u0000unchanged bytes");
		const p = await prepare();
		expect(existsSync(join(project, "durable.md"))).toBe(false);
		const order: string[] = [];
		apply(p, (path, content) => { order.push(basename(path)); atomicWrite(path, content); });
		expect(order.at(-1)).toBe("index.md");
		expect(readFileSync(join(project, "nested/existing.md"))).toEqual(existing);
		expect(readFileSync(join(project, "unrelated.md"))).toEqual(unrelated);
		expect(readFileSync(join(project, "resource.bin"), "utf8")).toBe("\u0000unchanged bytes");
		expect(existsSync(join(project, "empty-assets"))).toBe(true);
		const index = readFileSync(join(project, "index.md"), "utf8");
		expect(parseYamlFrontMatter(index).front).toEqual({ okf_version: "0.2" });
		expect(index).toContain("(nested/existing.md)");
		expect(index).toContain("(durable.md)");
		const front = parseFrontMatter(readFileSync(join(project, "durable.md"), "utf8")).front;
		expect(front.sources).toEqual([{ resource: pathToFileURL(join(session, "auth.md")).href, om_content_sha256: sha256(readFileSync(join(session, "auth.md"))) }]);
		expect(front.om_snapshot_at).toBe(proposalTime);
		expect(front.om_source_scope).toContain("not verification");
		expect(front.verified).toBeUndefined();
		expect(existsSync(publicationLockPath(cwd))).toBe(false);
		expect(() => apply(p)).toThrow("applied");
	});

	it("rejects conflicts without publishing, even when the model changed a nonconflicting concept", async () => {
		seedProject();
		const before = hashSnapshot(snapshotBundle(cwd, project));
		action = async () => {
			await call("write", { path: "durable.md", content: concept("Unrelated safe addition") });
			await call("review", { summary: "Source and project disagree.", conflicts: ["auth.md contradicts nested/existing.md; kept project truth"] });
		};
		const p = await prepare();
		expect(p.conflicts).toHaveLength(1);
		expect(readPromotionReview(cwd, "session-a", p.id)).toContain("Apply is blocked");
		expect(() => apply(p)).toThrow("conflicts");
		expect(hashSnapshot(snapshotBundle(cwd, project))).toEqual(before);
	});

	it("preserves existing source/unknown metadata and retains new hashes for the same URI", async () => {
		const ref = { resource: pathToFileURL(join(session, "auth.md")).href, om_content_sha256: "old-hash", quote: "old snapshot", extension: { keep: true } };
		const before = concept("Old", `custom: {nested: [keep]}\nsources: ${JSON.stringify([ref])}\n`);
		const actual = { resource: ref.resource, om_content_sha256: "new-hash" };
		const result = preparePromotionWrite(concept("New"), before, [actual], proposalTime);
		const front = parseFrontMatter(result).front;
		expect(front.sources).toEqual([ref, actual]);
		expect(front.custom).toEqual({ nested: ["keep"] });
		expect(preparePromotionWrite(result, before, [actual], proposalTime)).toBe(result);
	});

	it.each(["project-edited", "index-edited", "resource-added", "empty-dir-added", "concept-deleted"])("rejects project baseline changes: %s", async (change) => {
		seedProject();
		const p = await prepare();
		if (change === "project-edited") write("unrelated.md", concept("External edit"));
		if (change === "index-edited") write("index.md", `${renderIndexFile([])}External edit`);
		if (change === "resource-added") write("new.txt", "external");
		if (change === "empty-dir-added") mkdirSync(join(project, "external-empty"));
		if (change === "concept-deleted") rmSync(join(project, "unrelated.md"));
		const externalState = hashSnapshot(snapshotBundle(cwd, project));
		expect(() => apply(p)).toThrow("project changed since proposal baseline");
		expect(hashSnapshot(snapshotBundle(cwd, project))).toEqual(externalState);
		expect(existsSync(publicationLockPath(cwd))).toBe(false);
	});

	it.each([false, true])("does not delete an external project created after an absent baseline (nonempty=%s)", async (nonempty) => {
		const p = await prepare();
		mkdirSync(project);
		if (nonempty) write("external.md", concept("External writer"));
		expect(() => apply(p)).toThrow("project changed since proposal baseline");
		expect(existsSync(project)).toBe(true);
		expect(existsSync(publicationLockPath(cwd))).toBe(false);
	});

	it.each(["staged/durable.md", "review.md", "changes.diff", "report.json", "input.json"])("rejects modified reviewed artifacts: %s", async (file) => {
		const p = await prepare();
		atomicWrite(join(p.proposalDir, file), "tampered");
		expect(() => apply(p)).toThrow(/changed|invalid/);
		expect(existsSync(project)).toBe(false);
	});

	it("rejects deletion of existing staged concepts and unauthorized source fabrication", async () => {
		seedProject();
		action = async (opts) => { rmSync(join(opts.cwd, "nested/existing.md")); };
		await expect(prepare()).rejects.toThrow("may not delete existing project file");
		action = async () => {
			const res = await call("write", { path: "evil.md", content: concept("Unsupported claim", "sources: [{resource: 'https://fabricated.example/evidence'}]\n") });
			expect(res.isError).toBe(true);
			expect(res.content[0].text).toContain("source is not an allowed");
		};
		const p = await prepare();
		expect(existsSync(join(p.proposalDir, "staged/evil.md"))).toBe(false);
		expect(existsSync(join(project, "evil.md"))).toBe(false);
	});

	it("rejects fabricated sources even if a worker bypassed scoped tools", async () => {
		action = async (opts) => atomicWrite(join(opts.cwd, "evil.md"), concept("Bad", "sources: [{resource: 'https://fabricated.example/'}]\n"));
		await expect(prepare()).rejects.toThrow("source is not an allowed");
	});

	it.each(["../outside.md", "/outside.md", "nested/../../escape.md", "index.md", "nested/INDEX.md", "journey.md", "nested/log.md", ".private.md"])("rejects escaped/reserved mutation %s", async (path) => {
		action = async () => {
			expect((await call("write", { path, content: concept("Not allowed") })).isError).toBe(true);
		};
		await prepare();
		expect(existsSync(project)).toBe(false);
	});

	it("rejects session/proposal ID traversal and project symlinks including ancestor replacements", async () => {
		await expect(preparePromotion({ cwd, sessionId: "../escape", model })).rejects.toThrow("invalid session ID");
		expect(() => applyPromotion({ cwd, sessionId: "session-a", id: "../../escape" })).toThrow("invalid proposal ID");
		const outside = join(cwd, "outside"); mkdirSync(outside);
		symlinkSync(outside, project, "dir");
		await expect(prepare()).rejects.toThrow(/symlink|unsafe/);
		rmSync(project);
		const p = await prepare();
		symlinkSync(outside, project, "dir");
		expect(() => apply(p)).toThrow(/symlink|unsafe/);
		rmSync(project);
		rmSync(join(p.proposalDir, "staged"), { recursive: true });
		symlinkSync(outside, join(p.proposalDir, "staged"), "dir");
		expect(() => apply(p)).toThrow(/symlink|unsafe/);
	});

	it("rejects project child symlinks and new worker symlinks rather than treating them as concepts", async () => {
		seedProject();
		symlinkSync(join(session, "auth.md"), join(project, "alias.md"));
		await expect(prepare()).rejects.toThrow(/symlink|unsafe/);
		rmSync(join(project, "alias.md"));
		action = async (opts) => { symlinkSync(join(session, "auth.md"), join(opts.cwd, "alias.md")); };
		await expect(prepare()).rejects.toThrow(/symlink|unsafe/);
	});

	it.each([false, true])("rolls back a publisher failure, including write-then-throw=%s", async (afterWrite) => {
		seedProject();
		const before = hashSnapshot(snapshotBundle(cwd, project));
		const p = await prepare();
		expect(() => apply(p, (path, content) => {
			if (basename(path) === "index.md") { if (afterWrite) atomicWrite(path, content); throw new Error("injected I/O failure"); }
			atomicWrite(path, content);
		})).toThrow("injected I/O failure");
		expect(hashSnapshot(snapshotBundle(cwd, project))).toEqual(before);
		expect(existsSync(publicationLockPath(cwd))).toBe(false);
	});

	it("cleans only publisher-created empty directories during rollback of a first publication", async () => {
		action = async () => { await call("write", { path: "nested/deep/durable.md", content: concept("New") }); };
		const p = await prepare();
		expect(() => apply(p, (path, content) => { if (basename(path) === "index.md") throw new Error("fail"); atomicWrite(path, content); })).toThrow("fail");
		expect(existsSync(project)).toBe(false);
		expect(existsSync(publicationLockPath(cwd))).toBe(false);
	});

	it("never rolls back over an external edit; leaves recovery lock and backup, suppressing discovery", async () => {
		seedProject();
		const p = await prepare();
		expect(() => apply(p, (path, content) => {
			if (basename(path) === "index.md") {
				atomicWrite(join(project, "durable.md"), concept("External concurrent edit"));
				throw new Error("fail after external edit");
			}
			atomicWrite(path, content);
		})).toThrow("needs recovery");
		expect(readFileSync(join(project, "durable.md"), "utf8")).toContain("External concurrent edit");
		expect(existsSync(publicationLockPath(cwd))).toBe(true);
		expect(existsSync(join(p.proposalDir, "baseline/nested/existing.md"))).toBe(true);
		expect(renderProjectDiscovery(cwd)).toContain("incomplete/locked");
	});

	it("does not overwrite a target externally changed after baseline validation but before its write", async () => {
		seedProject();
		action = async () => {
			await call("write", { path: "a.md", content: concept("New a") });
			await call("write", { path: "unrelated.md", content: concept("Proposed update") });
		};
		const p = await prepare();
		expect(() => apply(p, (path, content) => {
			atomicWrite(path, content);
			if (basename(path) === "a.md") atomicWrite(join(project, "unrelated.md"), concept("Concurrent replacement"));
		})).toThrow("target changed during publication");
		expect(readFileSync(join(project, "unrelated.md"), "utf8")).toContain("Concurrent replacement");
		expect(existsSync(join(project, "a.md"))).toBe(false);
	});

	it("reports standalone harness costs on success and worker failure without requiring a ledger", async () => {
		const onCost = vi.fn();
		const p = await preparePromotion({ cwd, sessionId: "session-a", model, onCost, now: () => new Date(proposalTime) });
		expect(onCost).toHaveBeenCalledWith(0.125, p.id);
		vi.mocked(spawnWorker).mockImplementation(async (opts) => { writeWorkerCost(opts.env.OM_COST_PATH!, { costUsd: 0.5 }); return { code: 1, signal: null, stderr: "failed" }; });
		await expect(preparePromotion({ cwd, sessionId: "session-a", model, onCost })).rejects.toThrow("worker exited");
		expect(onCost).toHaveBeenLastCalledWith(0.5, expect.stringMatching(/^proposal-/));
		expect(existsSync(project)).toBe(false);
	});

	it.each([false, true])("automatic no-op apply itself cannot create/rewrite project memory (existing=%s)", async (existing) => {
		if (existing) seedProject();
		const before = hashSnapshot(snapshotBundle(cwd, project));
		action = async () => {};
		const p = await preparePromotion({ cwd, sessionId: "session-a", model, mode: "automatic", now: () => new Date(proposalTime) });
		expect(p.changedFiles).toEqual([]);
		expect(applyPromotion({ cwd, sessionId: "session-a", id: p.id, publication: "automatic" })).toEqual([]);
		expect(hashSnapshot(snapshotBundle(cwd, project))).toEqual(before);
		expect(existsSync(project)).toBe(existing);
		expect(readPromotionReview(cwd, "session-a", p.id)).toContain("automatic publication is skipped");
	});

	it("rejects index metadata outside the OKF root exception, without launching a worker", async () => {
		write("index.md", '---\nokf_version: "0.2"\ntitle: Not a concept\n---\n# Invalid index');
		await expect(prepare()).rejects.toThrow("requires only okf_version");
		expect(spawnWorker).not.toHaveBeenCalled();
	});

	it("rejects deletion of baseline empty directories as well as files", async () => {
		seedProject();
		action = async (opts) => { rmSync(join(opts.cwd, "empty-assets"), { recursive: true }); };
		await expect(prepare()).rejects.toThrow("may not delete directory");
	});

	it("respects an existing publication lock and never removes another publisher's lock", async () => {
		const p = await prepare();
		atomicWrite(publicationLockPath(cwd), "other publisher");
		expect(() => apply(p)).toThrow("publication locked");
		expect(readFileSync(publicationLockPath(cwd), "utf8")).toBe("other publisher");
		expect(existsSync(project)).toBe(false);
	});

	it("rejects no consolidated sources rather than invoking observers/consolidation", async () => {
		rmSync(session, { recursive: true });
		source("journey.md", concept("Only history").replace("Memory Topic", "Session History"));
		await expect(prepare()).rejects.toThrow("no consolidated session Memory Topic");
		expect(spawnWorker).not.toHaveBeenCalled();
	});
});
