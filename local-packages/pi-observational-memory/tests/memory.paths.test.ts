import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderIndexFile, renderMemoryMap } from "../src/memory/index-render.js";
import {
	atomicWrite, indexPath, journeyPath, listIndexConcepts, listTopics, parseFrontMatter,
	readJourney, resolveWithinMemory, validateMemoryBundle,
} from "../src/memory/paths.js";

let cwd: string;
let root: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "om-mem-"));
	root = join(cwd, ".memory", "sess-1");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function writeFile(filename: string, content: string): void {
	const path = join(root, filename);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf-8");
}
const topic = (title: string, description: string, body = "body") =>
	`---\ntype: Memory Topic\ntitle: ${title}\ndescription: ${description}\ngenerated:\n  by: pi-observational-memory\n  at: 2026-10-21T15:00:00.000Z\n---\n${body}`;
const journey = (body: string) => topic("Session journey", "Descriptive history", body).replace("Memory Topic", "Session History");

describe("resolveWithinMemory", () => {
	it("resolves paths inside the session memory root", () => {
		expect(resolveWithinMemory(root, "auth.md")).toBe(join(root, "auth.md"));
		expect(resolveWithinMemory(root, ".memory/auth.md")).toBe(join(root, ".memory", "auth.md"));
	});
	it("rejects paths outside the sandbox", () => {
		expect(resolveWithinMemory(root, "../secret.txt")).toBeUndefined();
		expect(resolveWithinMemory(root, "../../etc/passwd")).toBeUndefined();
	});
});

describe("native front-matter", () => {
	it("parses real YAML, preserving nested unknown fields and timestamp strings", () => {
		const { front, body } = parseFrontMatter(`---
type: Memory Topic
title: 'Auth: tokens'
description: >-
  JWT and
  sessions
generated: {by: other, at: 2026-10-21T15:00:00Z}
custom:
  items: [a, b]
  enabled: true
  date: 2026-10-21
---
Body\n`);
		expect(front).toEqual({
			type: "Memory Topic", title: "Auth: tokens", description: "JWT and sessions",
			generated: { by: "other", at: "2026-10-21T15:00:00Z" },
			custom: { items: ["a", "b"], enabled: true, date: "2026-10-21" },
		});
		expect(body).toBe("Body\n");
	});
	it("supports CRLF and unknown types without checking links", () => {
		const parsed = parseFrontMatter("---\r\ntype: Future Concept\r\nunknown: 42\r\n---\r\n[missing](absent.md)");
		expect(parsed.front).toEqual({ type: "Future Concept", unknown: 42 });
		expect(parsed.body).toBe("[missing](absent.md)");
	});
	it.each([
		"no front matter", "---\ntype: Memory Topic", "---\n[]\n---\nx",
		"---\n- type: Memory Topic\n---\nx", "---\ntype: [broken\n---\nx",
		"---\ntitle: Missing type\n---\nx", "---\ntype: 12\n---\nx", "---\ntype: ''\n---\nx",
		"---\ntype: Memory Topic\ntype: Duplicate\n---\nx", "---\ntype: !!js/function 'x'\n---\nx",
	])("rejects invalid concept %s", (content) => expect(() => parseFrontMatter(content)).toThrow());
});

describe("topic enumeration and journey", () => {
	it("derives IDs and keeps Pi project-relative paths; excludes journey/index/log", () => {
		writeFile("index.md", renderIndexFile([]));
		writeFile("journey.md", journey("## Earlier\nStarted the work."));
		writeFile("log.md", "not a concept");
		writeFile("zebra.md", topic("Zebra", "z"));
		writeFile("auth.md", topic("Auth", "a"));
		writeFile("nested/deploy.md", topic("Deploy", "d"));
		writeFile("invalid.md", "legacy body");
		const topics = listTopics(root);
		expect(topics.map((t) => t.filename)).toEqual(["auth.md", "zebra.md"]);
		expect(topics[0]).toMatchObject({ id: "auth", title: "Auth", description: "a", path: join(".memory", "sess-1", "auth.md") });
		expect(listIndexConcepts(root).map((t) => t.filename)).toEqual(["auth.md", "journey.md", "nested/deploy.md", "zebra.md"]);
	});
	it("returns no topics/journey when the session root is absent", () => {
		expect(listTopics(root)).toEqual([]);
		expect(readJourney(root)).toBeUndefined();
		expect(indexPath(root)).toBe(join(root, "index.md"));
		expect(journeyPath(root)).toBe(join(root, "journey.md"));
	});
	it("returns only the trimmed Session History body", () => {
		writeFile("journey.md", journey("\n## Earlier\nStarted the work.\n\n"));
		expect(readJourney(root)).toBe("## Earlier\nStarted the work.");
		writeFile("journey.md", journey("  \n\n"));
		expect(readJourney(root)).toBeUndefined();
		writeFile("journey.md", topic("Not history", "d"));
		expect(readJourney(root)).toBeUndefined();
		writeFile("journey.md", "old body-only journey");
		expect(readJourney(root)).toBeUndefined();
	});
});

describe("OKF index vs Pi memory map", () => {
	it("renders a v0.2 empty index", () => {
		expect(renderIndexFile([])).toContain('okf_version: "0.2"');
		expect(renderMemoryMap([])).toBeUndefined();
	});
	it("uses relative Markdown links/descriptions in index and project paths in context", () => {
		writeFile("auth.md", topic("Auth", "JWT and sessions"));
		writeFile("journey.md", journey("## Earlier\nHistory"));
		const index = renderIndexFile(listIndexConcepts(root));
		expect(index).toContain("[Auth](auth.md) — JWT and sessions");
		expect(index).toContain("[Session journey](journey.md)");
		expect(index).not.toContain(".memory/");
		const map = renderMemoryMap(listTopics(root));
		expect(map).toContain("`.memory/sess-1/auth.md` — JWT and sessions");
		expect(map).not.toContain("journey.md");
		expect(map).not.toContain("updated");
	});
	it("escapes titles and URLs in portable Markdown links", () => {
		const index = renderIndexFile([{ type: "Other", id: "x", title: "A [title]", description: "a\nb", path: "unused", filename: "nested/a (b).md" }]);
		expect(index).toContain("[A \\[title\\]](nested/a%20%28b%29.md) — a b");
	});
});

describe("recursive bundle validation", () => {
	it("excludes internal runtime artifacts, JSON and generated index; accepts extensions/broken links", () => {
		writeFile("index.md", renderIndexFile([]));
		writeFile(".runs/a.cost.json", "{}");
		writeFile(".runs/a.md", "not a concept");
		writeFile(".hidden/internal.md", "not a concept");
		writeFile(".private.md", topic("Internal", "Not a concept"));
		expect(listTopics(root)).toEqual([]);
		writeFile("auth.md.tmp-123", "incomplete");
		writeFile("nested/foreign.md", "---\ntype: Future Type\nx: [a, b]\n---\n[broken](missing.md)");
		expect(() => validateMemoryBundle(root)).not.toThrow();
	});
	it("reports malformed nested concepts without changing them", () => {
		writeFile("nested/bad.md", "not a concept");
		expect(() => validateMemoryBundle(root)).toThrow("nested/bad.md");
		expect(readFileSync(join(root, "nested/bad.md"), "utf-8")).toBe("not a concept");
	});
	it.each(["log.md", "nested/LOG.md", "nested/index.md"])("rejects reserved concept %s", (filename) => {
		writeFile(filename, topic("Reserved", "x"));
		expect(() => validateMemoryBundle(root)).toThrow("reserved");
	});
});

describe("atomicWrite", () => {
	it("writes content, creating parent dirs", () => {
		const path = join(cwd, ".memory", "deep", "file.md");
		atomicWrite(path, "hello");
		expect(readFileSync(path, "utf-8")).toBe("hello");
	});
});
