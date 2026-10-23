/** Bounded static repository inspection. No execution, network, or repository mutation. */
import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ignore from "ignore";
import { sha256 } from "./project.js";

export const REPO_LIMITS = Object.freeze({ calls: 30, fileBytes: 128 * 1024, readBytes: 4 * 1024 * 1024,
	outputBytes: 512 * 1024, callOutputBytes: 32 * 1024, entries: 4000, depth: 8, matches: 50, lines: 400 });
export type RepoInspection = { path: string; sha256: string; inspectedAt: string;
	method: "static repository inspection"; tool: "repo_read" | "repo_search"; startLine: number; endLine: number; content: string };
export type RepositoryEvidence = { version: 1; records: RepoInspection[] };
type Budget = { calls: number; readBytes: number; outputBytes: number; entries: number };
const blocked = new Set([".memory", ".git", ".pi", "node_modules", "vendor", "build", "dist", "target", "coverage", "generated", "__generated__", "dependencies", "deps", "third_party", "third-party", "external", "out", "venv", "site-packages", "bower_components", "__pycache__"]);
const privateName = (name: string) => name.startsWith(".") && name !== ".github"
	|| /(^|[-_.])(secrets?|credentials?|passwords?|tokens?)([-_.]|$)/i.test(name)
	|| /(^|[._-])env([._-]|$)/i.test(name)
	|| /^(id_(rsa|dsa|ecdsa|ed25519)|private[-_]key|ssh_host_.*_key)/i.test(name)
	|| /\.(pem|key|p12|pfx|jks|keystore|der)$/i.test(name);
const binaryName = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|bz2|xz|7z|exe|dll|so|dylib|wasm|sqlite|db|woff2?|ttf|mp[34]|mov|lock|map)$/i;
const generatedName = /((^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|go\.sum)$|\.min\.[cm]?js$|[.-]generated[.-])/i;
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
function fail(message: string): never { throw new Error(`repository inspection: ${message}; this is not proof of absence`); }
function normalized(path: string, allowRoot = false): string {
	if (typeof path !== "string" || !path || path.length > 1024 || path.split("/").length > 64 || path.includes("\\") || /[\x00-\x1f\x7f:]/.test(path) || path.startsWith("/") || /^[A-Za-z]:/.test(path)) fail("invalid relative path");
	if (allowRoot && path === ".") return "";
	if (path.split("/").some((part) => !part || part === "." || part === "..")) fail("invalid relative path");
	return path;
}
function integer(value: number, max: number, name: string): number {
	if (!Number.isInteger(value) || value < 1 || value > max) fail(`invalid ${name} (1..${max})`);
	return value;
}
function linesOf(value: string): string[] { return value.split("\n"); }

export class RepositoryInspector {
	readonly root: string;
	readonly evidence: RepositoryEvidence = { version: 1, records: [] };
	private budget: Budget = { calls: 0, readBytes: 0, outputBytes: 0, entries: 0 };
	private policies = new Map<string, ReturnType<typeof ignore> | undefined>();
	constructor(cwd: string, private persist: (evidence: RepositoryEvidence) => void = () => {}) {
		this.root = resolve(cwd);
		if (!lstatSync(this.root).isDirectory() || lstatSync(this.root).isSymbolicLink()) fail("root must be a regular directory, not a symlink");
	}
	private begin(): void {
		if (++this.budget.calls > REPO_LIMITS.calls) fail("call budget exhausted");
		this.policies.clear(); // fresh policy per tool call, never a stale cross-call allowlist
	}
	private checked(path: string, internalIgnore = false) {
		if (path) normalized(path);
		const root = lstatSync(this.root);
		if (!root.isDirectory() || root.isSymbolicLink()) fail("root is no longer a regular directory");
		let current = this.root;
		const parts = path ? path.split("/") : [];
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			if (!(internalIgnore && i === parts.length - 1 && part === ".gitignore") && (blocked.has(part.toLowerCase()) || privateName(part))) fail("excluded/private path");
			current = join(current, part);
			const stat = lstatSync(current);
			if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail("symlink or special file rejected");
			if (i < parts.length - 1 && !stat.isDirectory()) fail("ancestor is not a directory");
		}
		return { absolute: current, stat: lstatSync(current) };
	}
	private raw(path: string, internalIgnore = false): string {
		if (!internalIgnore && (binaryName.test(path) || generatedName.test(path))) fail("binary/generated file excluded");
		const { absolute, stat } = this.checked(path, internalIgnore);
		if (!stat.isFile() || stat.size > REPO_LIMITS.fileBytes) fail("not a regular bounded file (128 KiB maximum)");
		const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const actual = fstatSync(fd);
			if (!actual.isFile() || actual.ino !== stat.ino || actual.dev !== stat.dev) fail("file changed while opening");
			const buffer = Buffer.alloc(REPO_LIMITS.fileBytes + 1);
			let size = 0, count: number;
			do {
				count = readSync(fd, buffer, size, buffer.length - size, null); size += count;
				this.budget.readBytes += count;
				if (this.budget.readBytes > REPO_LIMITS.readBytes) fail("total read-byte budget exhausted");
				if (size > REPO_LIMITS.fileBytes) fail("file exceeds 128 KiB");
			} while (count);
			const content = buffer.subarray(0, size);
			let decoded: string;
			try { decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); } catch { fail("binary/non-UTF8 file rejected"); }
			if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(decoded)) fail("binary/control bytes rejected");
			return decoded;
		} finally { closeSync(fd); }
	}
	/** Re-read root and nested ignore files. A child cannot unignore an excluded ancestor. */
	private allowed(path: string) {
		const checked = this.checked(path);
		const parts = path.split("/");
		for (let i = 0; i < parts.length; i++) {
			const base = parts.slice(0, i).join("/");
			const ignorePath = base ? `${base}/.gitignore` : ".gitignore";
			if (!this.policies.has(ignorePath)) {
				try { this.policies.set(ignorePath, ignore().add(this.raw(ignorePath, true))); } catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") this.policies.set(ignorePath, undefined);
					else fail(`gitignore policy unavailable: ${(error as Error).message}`); // fail closed
				}
			}
			const suffix = parts.slice(i).join("/") + (checked.stat.isDirectory() ? "/" : "");
			if (this.policies.get(ignorePath)?.ignores(suffix)) fail("gitignored path");
		}
		return checked;
	}
	private output(value: unknown, records: RepoInspection[] = []): string {
		const result = JSON.stringify(value);
		if (bytes(result) > REPO_LIMITS.callOutputBytes || this.budget.outputBytes + bytes(result) > REPO_LIMITS.outputBytes - 512) fail("output-byte budget exhausted");
		this.budget.outputBytes += bytes(result);
		const priorLength = this.evidence.records.length;
		this.evidence.records.push(...records);
		try { if (records.length) this.persist(this.evidence); }
		catch (error) { this.evidence.records.splice(priorLength); throw error; }
		return result;
	}
	/** Every returned error shares the byte budget. Native errors must not echo arbitrary paths. */
	errorText(error: unknown): string {
		const code = (error as NodeJS.ErrnoException)?.code;
		let message = typeof code === "string"
			? `repository inspection: filesystem path rejected (${code.replace(/[^A-Z0-9_]/g, "").slice(0, 24)}); not proof of absence`
			: error instanceof Error && error.message.startsWith("repository inspection:") ? error.message
			: "repository inspection failed; not proof of absence";
		const remaining = Math.max(0, Math.min(512, REPO_LIMITS.outputBytes - this.budget.outputBytes));
		message = message.slice(0, 512);
		while (bytes(message) > remaining) message = message.slice(0, -1);
		this.budget.outputBytes += bytes(message);
		return message;
	}
	private inspection(path: string, full: string, start: number, end: number, tool: RepoInspection["tool"]): RepoInspection {
		return { path, sha256: sha256(full), inspectedAt: new Date().toISOString(), method: "static repository inspection", tool,
			startLine: start, endLine: end, content: linesOf(full).slice(start - 1, end).join("\n") };
	}
	read(params: { path: string; offset?: number; limit?: number }): string {
		this.begin();
		const path = normalized(params.path), start = integer(params.offset ?? 1, Number.MAX_SAFE_INTEGER, "offset"), limit = integer(params.limit ?? 200, REPO_LIMITS.lines, "limit");
		this.allowed(path);
		const full = this.raw(path), lines = linesOf(full);
		if (start > lines.length) return this.output({ path, text: "", truncated: false, notice: "offset beyond end; no content evidence recorded" });
		let end = Math.min(lines.length, start + limit - 1);
		while (end >= start && bytes(JSON.stringify(lines.slice(start - 1, end).join("\n"))) > REPO_LIMITS.callOutputBytes - 2048) end--;
		if (end < start) fail("selected line too large for bounded output");
		const evidence = this.inspection(path, full, start, end, "repo_read");
		return this.output({ path, startLine: start, endLine: end, text: evidence.content, truncated: start > 1 || end < lines.length,
			notice: "Only the displayed lines were inspected. Full-file hash does not attest unseen claims." }, [evidence]);
	}
	private entries(path: string): { names: string[]; truncated: boolean } {
		const directory = opendirSync(this.checked(path).absolute);
		const names: string[] = [];
		let truncated = false;
		try {
			for (;;) {
				if (this.budget.entries >= REPO_LIMITS.entries) { truncated = true; break; }
				const entry = directory.readSync(); if (!entry) break;
				this.budget.entries++;
				const child = path ? `${path}/${entry.name}` : entry.name;
				try { const checked = this.allowed(child); if (!binaryName.test(child) && !generatedName.test(child)) names.push(entry.name + (checked.stat.isDirectory() ? "/" : "")); }
				catch (error) { if (/budget exhausted|gitignore policy unavailable/.test((error as Error).message)) throw error; /* excluded entries are not disclosed */ }
			}
		} finally { directory.closeSync(); }
		return { names: names.sort(), truncated };
	}
	ls(params: { path?: string }): string {
		this.begin(); const path = normalized(params.path ?? ".", true);
		if (path) this.allowed(path);
		const result = this.entries(path);
		const names: string[] = [];
		let size = 2;
		for (const name of result.names) {
			const cost = bytes(JSON.stringify(name)) + 1;
			if (size + cost > REPO_LIMITS.callOutputBytes - 1024) { result.truncated = true; break; }
			names.push(name); size += cost;
		}
		return this.output({ path: path || ".", entries: names, truncated: result.truncated, notice: "Filtered bounded listing; not evidence of facts or absence." });
	}
	search(params: { path: string; query: string; maxMatches?: number }): string {
		this.begin(); const path = normalized(params.path, true);
		if (typeof params.query !== "string" || !params.query || params.query.length > 256 || /[\r\n\0]/.test(params.query)) fail("query must be a single-line literal (1..256 characters)");
		const max = integer(params.maxMatches ?? 20, REPO_LIMITS.matches, "maxMatches");
		const records: RepoInspection[] = [];
		let truncated = false;
		const visit = (name: string, depth: number): void => {
			if (records.length >= max || depth > REPO_LIMITS.depth) { truncated = true; return; }
			const checked = name ? this.allowed(name) : this.checked("");
			if (checked.stat.isDirectory()) {
				const entries = this.entries(name); truncated ||= entries.truncated;
				for (const entry of entries.names) {
					if (records.length >= max) { truncated = true; break; }
					try { visit(name ? `${name}/${entry.replace(/\/$/, "")}` : entry.replace(/\/$/, ""), depth + 1); }
					catch (error) { if (/budget exhausted|gitignore policy unavailable/.test((error as Error).message)) throw error; truncated = true; }
				}
			} else {
				const full = this.raw(name), lines = linesOf(full);
				for (let i = 0; i < lines.length; i++) if (lines[i].includes(params.query)) {
					const entry = this.inspection(name, full, i + 1, i + 1, "repo_search");
					if (records.length >= max || bytes(JSON.stringify([...records, entry])) > REPO_LIMITS.callOutputBytes - 2048) { truncated = true; break; }
					records.push(entry);
				}
			}
		};
		visit(path, 0);
		return this.output({ matches: records.map(({ content, path, startLine }) => ({ path, line: startLine, text: content })), truncated,
			notice: "Literal bounded search over allowed files only; no match/truncation is not proof of absence." }, records);
	}
	/** Parent-only revalidation: same allow policy and bounded regular-file content checks. */
	validate(records: RepoInspection[]): void {
		const captured = new Map<string, string>();
		for (const record of records) {
			const path = normalized(record.path);
			if (!captured.has(path)) { this.allowed(path); captured.set(path, this.raw(path)); }
			const full = captured.get(path)!;
			if (sha256(full) !== record.sha256 || linesOf(full).slice(record.startLine - 1, record.endLine).join("\n") !== record.content || record.endLine > linesOf(full).length) fail(`stale evidence: ${path}`);
		}
	}
}

export function validateRepositoryEvidence(value: unknown): RepositoryEvidence {
	if (!value || typeof value !== "object" || (value as any).version !== 1 || !Array.isArray((value as any).records) || (value as any).records.length > REPO_LIMITS.calls * REPO_LIMITS.matches) fail("invalid evidence artifact");
	for (const r of (value as RepositoryEvidence).records) {
		if (!r || typeof r !== "object" || typeof r.path !== "string" || !/^[a-f0-9]{64}$/.test(r.sha256) || typeof r.inspectedAt !== "string" || !Number.isFinite(Date.parse(r.inspectedAt)) || r.method !== "static repository inspection" || !["repo_read", "repo_search"].includes(r.tool) || typeof r.content !== "string" || !Number.isInteger(r.startLine) || !Number.isInteger(r.endLine) || r.startLine < 1 || r.endLine < r.startLine || r.endLine - r.startLine >= REPO_LIMITS.lines) fail("invalid inspection record");
		normalized(r.path);
	}
	if (bytes(JSON.stringify(value)) > 2 * 1024 * 1024) fail("evidence artifact too large");
	return value as RepositoryEvidence;
}
export function repositoryReferences(cwd: string, evidence: RepositoryEvidence): Record<string, string>[] {
	validateRepositoryEvidence(evidence);
	return evidence.records.map((r) => ({ resource: pathToFileURL(join(resolve(cwd), r.path)).href, om_content_sha256: r.sha256,
		om_inspection_method: r.method, om_inspected_at: r.inspectedAt, om_inspected_lines: `${r.startLine}-${r.endLine}`, om_inspection_tool: r.tool }));
}
export function revalidateRepositoryEvidence(cwd: string, evidence: RepositoryEvidence): void {
	if (!evidence.records.length) return; // keep session-only proposals independent of repository reads
	try { new RepositoryInspector(cwd).validate(evidence.records); }
	catch (error) { throw new Error(`stale repository evidence; regenerate proposal: ${(error as Error).message}`); }
}
