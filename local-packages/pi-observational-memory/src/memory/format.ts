/** Native OKF v0.2 concept parsing and deterministic OM write metadata. */
import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument, stringify } from "yaml";

export const MEMORY_TOPIC_TYPE = "Memory Topic";
export const SESSION_HISTORY_TYPE = "Session History";
export const GENERATED_BY = "pi-observational-memory/0.1.0";

/** Unknown OKF fields/types are deliberately retained, not interpreted. */
export type ConceptFrontMatter = Record<string, unknown> & {
	type: string;
	title?: string;
	description?: string;
};

export type Concept = { front: ConceptFrontMatter; body: string };

/** YAML 1.2 core schema keeps even unquoted ISO timestamps as strings; no custom tags. */
export function parseYamlFrontMatter(content: string): { front: Record<string, unknown>; body: string } {
	const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	if (!match) throw new Error("concept requires a complete YAML front-matter block");
	const doc = parseDocument(match[1], { version: "1.2", schema: "core", uniqueKeys: true, strict: true });
	if (doc.errors.length > 0) throw new Error(`invalid YAML: ${doc.errors[0].message}`);
	if (doc.warnings.length > 0) throw new Error(`unsupported YAML: ${doc.warnings[0].message}`);
	if (!isMap(doc.contents)) throw new Error("front-matter must be a YAML mapping");
	const front = doc.toJS({ maxAliasCount: 100 }) as Record<string, unknown>;
	return { front, body: content.slice(match[0].length) };
}

export function parseFrontMatter(content: string): Concept {
	const { front, body } = parseYamlFrontMatter(content);
	if (typeof front.type !== "string" || !front.type.trim()) {
		throw new Error("front-matter requires a nonempty string type");
	}
	return { front: front as ConceptFrontMatter, body };
}

export function validateAuthoredConcept(content: string, isJourney = false): Concept {
	const concept = parseFrontMatter(content);
	for (const key of ["title", "description"] as const) {
		if (typeof concept.front[key] !== "string" || !concept.front[key]?.trim()) {
			throw new Error(`OM-authored concepts require a nonempty string ${key}`);
		}
	}
	if (isJourney && concept.front.type !== SESSION_HISTORY_TYPE) {
		throw new Error(`journey.md must have type: ${SESSION_HISTORY_TYPE}`);
	}
	return concept;
}

function meaningful(concept: Concept): Concept {
	const front = { ...concept.front };
	const generated = front.generated;
	if (generated && typeof generated === "object" && !Array.isArray(generated)) {
		const { by: _by, at: _at, ...unknown } = generated as Record<string, unknown>;
		if (Object.keys(unknown).length) front.generated = unknown;
		else delete front.generated;
	} else {
		delete front.generated;
	}
	return { front, body: concept.body };
}

/** Validate the WHOLE resulting file before commit. No-op writes keep the original bytes/time. */
export function prepareConceptWrite(
	content: string,
	current: string | undefined,
	isJourney = false,
	now: () => Date = () => new Date(),
): string {
	const concept = validateAuthoredConcept(content, isJourney);
	// These are retired OM fields, not OKF metadata. IDs are always derived from filenames.
	delete concept.front.id;
	delete concept.front.summary;
	delete concept.front.updated;
	if (current !== undefined) {
		try {
			const previous = validateAuthoredConcept(current, isJourney);
			if (isDeepStrictEqual(meaningful(previous), meaningful(concept))) return current;
		} catch {
			// An explicitly supplied valid replacement may repair an invalid file; no migration.
		}
	}
	const existing = concept.front.generated;
	const generated = existing && typeof existing === "object" && !Array.isArray(existing)
		? existing as Record<string, unknown> : {};
	concept.front.generated = { ...generated, by: GENERATED_BY, at: now().toISOString() };
	return `---\n${stringify(concept.front, { schema: "core" })}---\n${concept.body}`;
}
