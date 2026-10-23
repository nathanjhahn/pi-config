/**
 * The consolidator's tool belt. `--no-builtin-tools` is set on the worker, so this extension
 * registers its own read/write/edit/ls/grep — all path-scoped to `.memory/` (design risk 6).
 * There is no result file: the file edits ARE the output, and the run ends by natural exit
 * of `pi -p` once the model emits its closing confirmation. The orchestrator then tombstones
 * the whole provided batch (it already knows exactly what it handed over).
 *
 * Scoping: every path argument is resolved against OM_MEMORY_DIR and rejected if it escapes
 * that directory, so a wayward model cannot read or clobber the user's project.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { atomicWrite, resolveWithinMemory } from "../../src/memory/paths.js";
import { prepareConceptWrite } from "../../src/memory/format.js";

type ToolText = { content: { type: "text"; text: string }[]; details: unknown; isError?: boolean };

function ok(text: string, details: unknown = {}): ToolText {
	return { content: [{ type: "text" as const, text }], details };
}

function fail(text: string): ToolText {
	return { content: [{ type: "text" as const, text: `Error: ${text}` }], details: { error: true }, isError: true };
}

/** Resolve a requested path against the sandbox root, or return undefined if it escapes. */
function scoped(root: string, requested: string): string | undefined {
	return resolveWithinMemory(root, requested);
}

const ReadSchema = Type.Object({
	path: Type.String({ description: "Path relative to the session memory root, e.g. 'auth.md'." }),
});
const WriteSchema = Type.Object({
	path: Type.String({ description: "Path inside .memory/ to (over)write, e.g. 'auth.md'." }),
	content: Type.String({ description: "Full file content, including YAML front-matter." }),
});
const EditSchema = Type.Object({
	path: Type.String({ description: "Path inside .memory/ to edit." }),
	oldText: Type.String({ description: "Exact text to replace (must occur exactly once)." }),
	newText: Type.String({ description: "Replacement text." }),
});
const LsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Subdirectory inside .memory/. Defaults to .memory/ root." })),
});
const GrepSchema = Type.Object({
	pattern: Type.String({ description: "JavaScript regular expression to search for." }),
	path: Type.Optional(Type.String({ description: "Restrict to this file/subdir inside .memory/." })),
});

type ReadInput = Static<typeof ReadSchema>;
type WriteInput = Static<typeof WriteSchema>;
type EditInput = Static<typeof EditSchema>;
type LsInput = Static<typeof LsSchema>;
type GrepInput = Static<typeof GrepSchema>;

function listFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue; // skip .runs and hidden runtime files
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFilesRecursive(full));
		else if (entry.isFile()) out.push(full); // never follow child symlinks
	}
	return out;
}

/** Names are reserved at every directory depth, case-insensitively. IPC is not model-authored. */
function mutationError(root: string, abs: string): string | undefined {
	const name = basename(abs).toLowerCase();
	if (name === "index.md") return "index.md is generated automatically; do not write or edit it";
	if (name === "log.md") return "log.md is reserved; use journey.md for Session History";
	if (name === "journey.md" && basename(abs) !== "journey.md") return "use canonical lowercase journey.md";
	if (!name.endsWith(".md")) return "write/edit only accept Markdown concepts (.md)";
	if (relative(root, abs).split(/[\\/]/).some((part) => part.startsWith("."))) return "internal runtime paths are not concepts";
	return undefined;
}

/** Register scoped tools. Validation and stamping are shared by write and edit. */
export function registerConsolidatorTools(
	pi: ExtensionAPI,
	memoryRoot: string,
	now: () => Date = () => new Date(),
	policy: {
		checkPath?: (path: string) => void;
		prepareWrite?: (content: string, current: string | undefined) => string;
	} = {},
): void {
	const root = resolve(memoryRoot);
	function commit(abs: string, content: string, current?: string): void {
		policy.checkPath?.(relative(root, abs));
		const result = policy.prepareWrite ? policy.prepareWrite(content, current)
			: prepareConceptWrite(content, current, basename(abs).toLowerCase() === "journey.md", now);
		if (result !== current) atomicWrite(abs, result);
	}

	pi.registerTool({
		name: "read",
		label: "Read memory file",
		description: "Read a topic file under .memory/.",
		parameters: ReadSchema,
		async execute(_id: string, params: ReadInput): Promise<ToolText> {
			const abs = scoped(root, params.path);
			if (!abs) return fail("path escapes .memory/");
			if (!existsSync(abs)) return fail(`no such file: ${params.path}`);
			return ok(readFileSync(abs, "utf-8"));
		},
	});

	pi.registerTool({
		name: "write",
		label: "Write memory file",
		description: "Create/overwrite a complete OKF concept (YAML type, title, description + Markdown). Atomic; generated metadata is stamped automatically. Never write index.md or log.md.",
		parameters: WriteSchema,
		async execute(_id: string, params: WriteInput): Promise<ToolText> {
			const abs = scoped(root, params.path);
			if (!abs) return fail("path escapes .memory/");
			const error = mutationError(root, abs);
			if (error) return fail(error);
			return withFileMutationQueue(abs, async () => {
				try {
					commit(abs, params.content, existsSync(abs) ? readFileSync(abs, "utf-8") : undefined);
					return ok(`Wrote ${params.path} (${params.content.length} input characters).`);
				} catch (error) {
					return fail((error as Error).message);
				}
			});
		},
	});

	pi.registerTool({
		name: "edit",
		label: "Edit memory file",
		description: "Replace an exact substring in a topic file under .memory/ (atomic).",
		parameters: EditSchema,
		async execute(_id: string, params: EditInput): Promise<ToolText> {
			const abs = scoped(root, params.path);
			if (!abs) return fail("path escapes .memory/");
			const error = mutationError(root, abs);
			if (error) return fail(error);
			if (!params.oldText) return fail("oldText must not be empty");
			return withFileMutationQueue(abs, async () => {
				try {
					if (!existsSync(abs)) return fail(`no such file: ${params.path}`);
					const current = readFileSync(abs, "utf-8");
					const occurrences = current.split(params.oldText).length - 1;
					if (occurrences === 0) return fail("oldText not found");
					if (occurrences > 1) return fail(`oldText is ambiguous (${occurrences} matches); add more context`);
					commit(abs, current.replace(params.oldText, () => params.newText), current);
					return ok(`Edited ${params.path}.`);
				} catch (error) {
					return fail((error as Error).message);
				}
			});
		},
	});

	pi.registerTool({
		name: "ls",
		label: "List memory files",
		description: "List files under .memory/.",
		parameters: LsSchema,
		async execute(_id: string, params: LsInput): Promise<ToolText> {
			const abs = scoped(root, params.path ?? ".");
			if (!abs) return fail("path escapes .memory/");
			if (!existsSync(abs)) return ok("(.memory/ is empty)");
			const entries = readdirSync(abs).filter((n) => !n.startsWith("."));
			return ok(entries.length > 0 ? entries.sort().join("\n") : "(empty)");
		},
	});

	pi.registerTool({
		name: "grep",
		label: "Search memory files",
		description: "Search topic files under .memory/ with a regular expression.",
		parameters: GrepSchema,
		async execute(_id: string, params: GrepInput): Promise<ToolText> {
			let re: RegExp;
			try {
				re = new RegExp(params.pattern);
			} catch (e) {
				return fail(`invalid regex: ${(e as Error).message}`);
			}
			const base = scoped(root, params.path ?? ".");
			if (!base) return fail("path escapes .memory/");
			if (!existsSync(base)) return ok("(no matches)");
			const files = statSync(base).isDirectory() ? listFilesRecursive(base) : [base];
			const hits: string[] = [];
			for (const file of files) {
				const lines = readFileSync(file, "utf-8").split("\n");
				const relPath = relative(root, file);
				lines.forEach((line, i) => {
					if (re.test(line)) hits.push(`${relPath}:${i + 1}: ${line.trim()}`);
				});
				if (hits.length >= 200) break;
			}
			return ok(hits.length > 0 ? hits.join("\n") : "(no matches)");
		},
	});
}
