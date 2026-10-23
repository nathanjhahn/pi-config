import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryInspector, REPO_LIMITS, repositoryReferences, revalidateRepositoryEvidence, validateRepositoryEvidence } from "../src/memory/repository.js";
import { sha256 } from "../src/memory/project.js";

describe("bounded read-only repository inspection", () => {
	let cwd: string;
	const write = (path: string, content: string | Buffer = "needle\n") => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), content); };
	beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "om-repo-tools-")); });
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));
	it("returns exact visible lines, full-byte hashes, times, methods and actual file URIs, including UTF8 BOM/CRLF", () => {
		write("src/app.ts", "\ufefffirst\r\nsecond\r\nthird\n");
		const repo = new RepositoryInspector(cwd);
		const result = JSON.parse(repo.read({ path: "src/app.ts", offset: 2, limit: 1 }));
		expect(result).toMatchObject({ text: "second\r", startLine: 2, endLine: 2, truncated: true });
		expect(repo.evidence.records[0]).toMatchObject({ path: "src/app.ts", sha256: sha256(readFileSync(join(cwd, "src/app.ts"))), content: "second\r", method: "static repository inspection" });
		expect(repositoryReferences(cwd, repo.evidence)[0]).toMatchObject({ resource: pathToFileURL(join(cwd, "src/app.ts")).href, om_inspected_lines: "2-2", om_inspection_tool: "repo_read" });
		expect(() => revalidateRepositoryEvidence(cwd, repo.evidence)).not.toThrow();
	});
	it("literal search never interprets regex and records only returned matches; listings/no-match add no evidence", () => {
		write("src/a.ts", "a.*b\nanything\naaaab\n"); write("src/b.ts", "no match\n");
		const repo = new RepositoryInspector(cwd);
		expect(JSON.parse(repo.ls({})).entries).toEqual(["src/"]);
		expect(JSON.parse(repo.search({ path: "src", query: "[invalid(regex" })).matches).toEqual([]);
		expect(repo.evidence.records).toEqual([]);
		expect(JSON.parse(repo.search({ path: "src", query: "a.*b" })).matches).toEqual([{ path: "src/a.ts", line: 1, text: "a.*b" }]);
		expect(repo.evidence.records).toHaveLength(1);
	});
	it.each(["../outside", "/etc/passwd", "a/../file", "a//file", "a/./file", "C:/file", "a\\file", "a\0file", "a\nfile", "a:stream", "a".repeat(100_000), "", "./file"])("rejects unsafe paths %j", (path) => {
		const repo = new RepositoryInspector(cwd);
		expect(() => repo.read({ path })).toThrow("invalid relative path");
		expect(() => repo.search({ path, query: "needle" })).toThrow("invalid relative path");
	});
	it.each([".memory/session/topic.md", ".memory/project/index.md", ".git/config", ".pi/settings.json", ".private/code.ts", ".env", ".env.local", "prod.env", "credentials.json", "secrets/config.ts", "private-key.txt", "id_ed25519", "ssh_host_rsa_key", "server.pem", "node_modules/pkg/a.ts", "vendor/a.ts", "dist/a.js", "build/a.js", ".venv/a.py", "generated/a.ts", "third_party/a.ts", "src/a.generated.ts", "package-lock.json", "packages/app/package-lock.json", "packages/app/pnpm-lock.yaml", "packages/app/npm-shrinkwrap.json"])("blocks private/dependency/generated path %s", (path) => {
		write(path);
		const repo = new RepositoryInspector(cwd);
		expect(() => repo.read({ path })).toThrow(/excluded|private/);
		expect(repo.evidence.records).toEqual([]);
	});
	it("permits .github but honors root+nested ignore/negation conservatively without git", () => {
		write(".github/workflows/ci.yml", "jobs: static\n");
		write(".gitignore", "ignored/\n*.log\n!keep.log\n"); write("ignored/a.ts");
		write("src/.gitignore", "private.ts\n*.tmp\n!keep.tmp\n");
		for (const path of ["src/private.ts", "src/no.tmp", "src/keep.tmp", "src/good.ts", "no.log", "keep.log"]) write(path);
		write("ignored/.gitignore", "!a.ts\n");
		const repo = new RepositoryInspector(cwd);
		for (const path of ["ignored/a.ts", "src/private.ts", "src/no.tmp", "no.log"]) expect(() => repo.read({ path })).toThrow("gitignored");
		for (const path of ["src/keep.tmp", "src/good.ts", "keep.log", ".github/workflows/ci.yml"]) expect(() => repo.read({ path })).not.toThrow();
		const result = JSON.parse(repo.search({ path: ".", query: "needle" }));
		expect(result.matches.map((m: any) => m.path).sort()).toEqual(["keep.log", "src/good.ts", "src/keep.tmp"]);
	});
	it("refreshes ignore policy between tool calls, including previously absent policy files", () => {
		write("src/app.ts"); const repo = new RepositoryInspector(cwd);
		repo.read({ path: "src/app.ts" });
		write("src/.gitignore", "app.ts\n");
		expect(() => repo.read({ path: "src/app.ts" })).toThrow("gitignored path");
	});
	it("records no evidence when a selected range is beyond EOF or persistence fails", () => {
		write("app.ts", "one\ntwo");
		const repo = new RepositoryInspector(cwd);
		expect(JSON.parse(repo.read({ path: "app.ts", offset: 99 })).text).toBe("");
		expect(repo.evidence.records).toEqual([]);
		const failing = new RepositoryInspector(cwd, () => { throw new Error("IPC write failed"); });
		expect(() => failing.read({ path: "app.ts" })).toThrow("IPC write failed");
		expect(failing.evidence.records).toEqual([]);
	});
	it("rejects symlink files/directories, including within-root targets, and symlinked ignore policy", () => {
		write("real/a.ts"); symlinkSync(join(cwd, "real"), join(cwd, "link")); symlinkSync(join(cwd, "real/a.ts"), join(cwd, "file.ts"));
		const repo = new RepositoryInspector(cwd);
		for (const path of ["link/a.ts", "file.ts"]) expect(() => repo.read({ path })).toThrow("symlink");
		symlinkSync(join(cwd, "real/a.ts"), join(cwd, ".gitignore"));
		expect(() => repo.read({ path: "real/a.ts" })).toThrow("gitignore policy unavailable");
		expect(() => repo.ls({})).toThrow("gitignore policy unavailable");
	});
	it("rejects directories, binary, invalid UTF8, oversized content and unsafe numeric/query inputs", () => {
		write("src/good.ts"); write("nul.dat", Buffer.from([97, 0, 98])); write("utf.dat", Buffer.from([0xff, 0xfe])); write("large.ts", "x".repeat(REPO_LIMITS.fileBytes + 1)); write("image.pdf", "plain but excluded");
		const repo = new RepositoryInspector(cwd);
		for (const path of ["src", "nul.dat", "utf.dat", "large.ts", "image.pdf"]) expect(() => repo.read({ path })).toThrow();
		for (const offset of [0, -1, NaN, 1.2]) expect(() => repo.read({ path: "src/good.ts", offset })).toThrow("invalid offset");
		expect(() => repo.read({ path: "src/good.ts", limit: 401 })).toThrow("invalid limit");
		for (const query of ["", "\n", "x".repeat(257)]) expect(() => repo.search({ path: "src", query })).toThrow("query must");
	});
	it("has explicit line/match/depth truncation without attesting unreturned content", () => {
		write("a.ts", Array.from({ length: 500 }, () => "needle").join("\n"));
		write("a/b/c/d/e/f/g/h/i/j/k.ts");
		const repo = new RepositoryInspector(cwd);
		expect(JSON.parse(repo.read({ path: "a.ts", limit: 2 }))).toMatchObject({ endLine: 2, truncated: true });
		const result = JSON.parse(repo.search({ path: ".", query: "needle", maxMatches: 3 }));
		expect(result.truncated).toBe(true); expect(result.matches).toHaveLength(3);
		expect(repo.evidence.records).toHaveLength(4);
	});
	it("enforces calls, total returned bytes, total scanned bytes and large-line bounds", () => {
		write("short.ts", "tiny");
		const calls = new RepositoryInspector(cwd);
		for (let i = 0; i < REPO_LIMITS.calls; i++) calls.read({ path: "short.ts" });
		expect(() => calls.read({ path: "short.ts" })).toThrow("call budget exhausted");
		write("long.ts", "x".repeat(30_000));
		const output = new RepositoryInspector(cwd);
		let error = "";
		for (let i = 0; i < 30; i++) { try { output.read({ path: "long.ts" }); } catch (e) { error = (e as Error).message; break; } }
		expect(error).toContain("output-byte budget exhausted");
		write("single.ts", "x".repeat(40_000)); expect(() => new RepositoryInspector(cwd).read({ path: "single.ts" })).toThrow("selected line too large");
		for (let i = 0; i < 34; i++) write(`scan/${i}.ts`, "x".repeat(REPO_LIMITS.fileBytes));
		expect(() => new RepositoryInspector(cwd).search({ path: "scan", query: "absent" })).toThrow("total read-byte budget exhausted");
	});
	it("bounds and accounts error output too, without leaking native filesystem error paths", () => {
		const repo = new RepositoryInspector(cwd);
		let total = 0;
		for (let i = 0; i < 20_000; i++) {
			const error = new Error(`ENOENT path ${"sensitive".repeat(10_000)}`) as NodeJS.ErrnoException; error.code = "ENOENT";
			const message = repo.errorText(error);
			expect(Buffer.byteLength(message)).toBeLessThanOrEqual(512);
			expect(message).not.toContain("sensitive"); total += Buffer.byteLength(message);
		}
		expect(total).toBeLessThanOrEqual(REPO_LIMITS.outputBytes);
		expect(repo.errorText(new Error("another"))).toBe("");
	});
	it("bounds directory entries without collecting an unbounded readdir result", () => {
		for (let i = 0; i < REPO_LIMITS.entries + 1; i++) write(`many/${i}.ts`, "");
		const result = JSON.parse(new RepositoryInspector(cwd).ls({ path: "many" }));
		expect(result.truncated).toBe(true); expect(result.entries.length).toBeLessThanOrEqual(REPO_LIMITS.entries);
	});
	it.each(["change", "delete", "symlink", "ignored"])("revalidation rejects evidence after %s", (change) => {
		write("source.ts", "current"); const repo = new RepositoryInspector(cwd); repo.read({ path: "source.ts" });
		if (change === "change") write("source.ts", "different");
		if (change === "delete") rmSync(join(cwd, "source.ts"));
		if (change === "symlink") { rmSync(join(cwd, "source.ts")); write("other.ts", "current"); symlinkSync(join(cwd, "other.ts"), join(cwd, "source.ts")); }
		if (change === "ignored") write(".gitignore", "source.ts\n");
		expect(() => revalidateRepositoryEvidence(cwd, repo.evidence)).toThrow("stale repository evidence");
	});
	it("rejects invalid artifact shapes and forged ranges/hashes", () => {
		write("a.ts", "one\ntwo"); const repo = new RepositoryInspector(cwd); repo.read({ path: "a.ts", limit: 1 });
		for (const value of [{}, { version: 1, records: [null] }, { version: 1, records: [{ ...repo.evidence.records[0], path: "../x" }] }]) expect(() => validateRepositoryEvidence(value)).toThrow();
		const forged = structuredClone(repo.evidence); forged.records[0].content = "not returned";
		expect(() => revalidateRepositoryEvidence(cwd, forged)).toThrow("stale repository evidence");
	});
});
