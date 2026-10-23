/** Separate deterministic projections: portable OKF index vs Pi's project-relative context map. */
import type { Topic } from "./paths.js";

function descriptionOf(topic: Topic): string {
	const description = typeof topic.description === "string" ? topic.description.trim() : "";
	return description || "(no description)";
}

function titleOf(topic: Topic): string {
	const title = typeof topic.title === "string" ? topic.title.trim() : "";
	return title || topic.filename;
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ");
}

/** Root index.md: links are relative to the bundle, not the project or session directory. */
export function renderIndexFile(concepts: Topic[]): string {
	const parts = ['---', 'okf_version: "0.2"', '---', '# Memory index', ''];
	if (concepts.length === 0) parts.push("_No concepts yet._");
	else {
		parts.push("Durable memory concepts. Read a file for its full contents.", "");
		for (const concept of concepts) {
			const title = singleLine(titleOf(concept)).replace(/[\\[\]]/g, "\\$&");
			const href = concept.filename.split("/").map((part) => encodeURIComponent(part).replace(/[()]/g, (c) => c === "(" ? "%28" : "%29")).join("/");
			parts.push(`- [${title}](${href}) — ${singleLine(descriptionOf(concept))}`);
		}
	}
	return `${parts.join("\n")}\n`;
}

/** Pi context only: keep project-relative paths so ordinary read/grep can find the topics. */
export function renderMemoryMap(topics: Topic[]): string | undefined {
	if (topics.length === 0) return undefined;
	const lines = [
		"## Memory map",
		"Durable long-term notes live in `.memory/`. Read a file when a topic below looks relevant; these descriptions are intentionally terse.",
	];
	for (const topic of topics) lines.push(`- \`${topic.path}\` — ${singleLine(descriptionOf(topic))}`);
	return lines.join("\n");
}
