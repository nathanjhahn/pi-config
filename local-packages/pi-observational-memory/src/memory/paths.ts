/**
 * Per-session native OKF v0.2 substrate under <project>/.memory/<sessionId>/:
 *   index.md           — generated root index with bundle-relative links
 *   <topic>.md         — typed YAML concept + current-state prose
 *   journey.md         — Session History concept (body injected at compaction)
 *   .runs/<id>.json    — transient worker IPC, never a concept
 *   .proposals/<id>/   — pending project curation, outside session concept enumeration
 * Durable files track the session, not the branch; /tree does not roll them back.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseFrontMatter, SESSION_HISTORY_TYPE, type ConceptFrontMatter } from "./format.js";
export { parseFrontMatter } from "./format.js";

export const INDEX_FILENAME = "index.md";
export const JOURNEY_FILENAME = "journey.md";

export function memoryBaseDir(cwd: string): string {
	return join(cwd, ".memory");
}

/** Immutable session-header ID, preserved across /name, /resume and /tree. */
export function sessionMemoryRoot(cwd: string, sessionId: string): string {
	return join(memoryBaseDir(cwd), sessionId);
}

export function indexPath(root: string): string {
	return join(root, INDEX_FILENAME);
}

export function journeyPath(root: string): string {
	return join(root, JOURNEY_FILENAME);
}

/** Read only the trimmed Session History body, never its metadata. Invalid/missing = absent. */
export function readJourney(root: string): string | undefined {
	try {
		const { front, body } = parseFrontMatter(readFileSync(journeyPath(root), "utf-8"));
		if (front.type !== SESSION_HISTORY_TYPE) return undefined;
		return body.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Atomic write (temp + rename). Creates parent dirs as needed. */
export function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, path);
}

/** Resolve a path inside the session sandbox, or undefined if it escapes. */
export function resolveWithinMemory(root: string, requestedPath: string): string | undefined {
	const base = resolve(root);
	const abs = resolve(base, requestedPath);
	const rel = relative(base, abs);
	if (rel === "" || rel === ".") return abs;
	if (rel.startsWith("..") || resolve(base, rel) !== abs) return undefined;
	// Do not follow existing child symlinks out of the sandbox (including broken links).
	let parent = base;
	for (const part of rel.split(sep)) {
		parent = join(parent, part);
		try {
			if (lstatSync(parent).isSymbolicLink()) return undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
			throw error;
		}
	}
	return abs;
}

export type TopicFrontMatter = ConceptFrontMatter;
export type Topic = ConceptFrontMatter & {
	/** Derived from the filename, never persisted as metadata. */
	id: string;
	/** Project-relative path for Pi's context memory map. */
	path: string;
	/** Bundle-relative path for OKF index links. */
	filename: string;
};

function readConcept(root: string, filename: string): Topic {
	const { front } = parseFrontMatter(readFileSync(join(root, filename), "utf-8"));
	return {
		...front,
		id: basename(filename).replace(/\.md$/i, ""),
		path: relative(resolve(root, "..", ".."), join(root, filename)),
		filename,
	};
}

/** Flat topic enumeration for Pi gauges/maps; journey and generated indexes are not topics. */
export function listTopics(root: string): Topic[] {
	if (!existsSync(root)) return [];
	const topics: Topic[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || !entry.isFile() || !entry.name.toLowerCase().endsWith(".md") || /^(index|journey|log)\.md$/i.test(entry.name)) continue;
		try {
			topics.push(readConcept(root, entry.name));
		} catch {
			// Old/invalid files are left untouched; the post-run bundle validator reports them.
		}
	}
	return topics.sort((a, b) => a.filename.localeCompare(b.filename, "en"));
}

/** Recursively enumerate concepts, not hidden runtime artifacts or the generated root index. */
function conceptFiles(root: string, subdir = ""): string[] {
	if (!existsSync(join(root, subdir))) return [];
	const files: string[] = [];
	for (const entry of readdirSync(join(root, subdir), { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue; // .runs IPC and atomic-write temporaries are not OKF concepts
		const filename = join(subdir, entry.name);
		if (entry.isDirectory()) files.push(...conceptFiles(root, filename));
		else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && filename !== INDEX_FILENAME) files.push(filename);
	}
	return files.sort();
}

/** Unknown types/fields and unresolved links are intentionally valid. No files are changed. */
export function validateMemoryBundle(root: string): void {
	for (const filename of conceptFiles(root)) {
		try {
			if (/^(index|log)\.md$/i.test(basename(filename))) throw new Error("reserved concept filename");
			const concept = readConcept(root, filename);
			if (/^journey\.md$/i.test(basename(filename))) {
				if (basename(filename) !== JOURNEY_FILENAME) throw new Error("use canonical lowercase journey.md");
				if (concept.type !== SESSION_HISTORY_TYPE) throw new Error(`journey.md must have type: ${SESSION_HISTORY_TYPE}`);
			}
		} catch (error) {
			throw new Error(`${filename}: ${(error as Error).message}`);
		}
	}
}

/** Bundle-relative concepts for the generated index, including journey.md after it is written. */
export function listIndexConcepts(root: string): Topic[] {
	const concepts: Topic[] = [];
	for (const filename of conceptFiles(root)) {
		try {
			if (/^(index|log)\.md$/i.test(basename(filename))) continue;
			concepts.push(readConcept(root, filename));
		} catch {
			// A preview can still orient the consolidator before it repairs an invalid concept.
		}
	}
	return concepts;
}
