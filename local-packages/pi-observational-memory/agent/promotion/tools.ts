import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { atomicWrite } from "../../src/memory/paths.js";
import { preparePromotionWrite, sourceReferences, validatePromotionInput } from "../../src/memory/promotion.js";
import { managedPath, projectConceptPath } from "../../src/memory/project.js";
import { relative } from "node:path";
import { registerConsolidatorTools } from "../consolidator/tools.js";
import { registerRepositoryTools } from "./repository-tools.js";

const ReviewSchema = Type.Object({ summary: Type.String(), conflicts: Type.Array(Type.String()) });
export function registerPromotionTools(pi: ExtensionAPI, opts: { cwd: string; stage: string; inputPath: string; reportPath: string; evidencePath?: string }): void {
	const input = validatePromotionInput(JSON.parse(readFileSync(managedPath(opts.cwd, relative(opts.cwd, opts.inputPath)), "utf8")));
	const refs = sourceReferences(opts.cwd, input);
	const now = () => new Date(input.snapshotAt);
	registerRepositoryTools(pi, opts);
	registerConsolidatorTools(pi, opts.stage, now, {
		checkPath: projectConceptPath,
		prepareWrite: (content, current) => preparePromotionWrite(content, current, refs, input.snapshotAt),
	});
	pi.registerTool({
		name: "review", label: "Report proposed curation and conflicts",
		description: "Finish the project-memory proposal with a summary and explicit conflicts array. Nonempty conflicts block apply. Does not publish anything.",
		parameters: ReviewSchema,
		async execute(_id: string, params: Static<typeof ReviewSchema>) {
			if (!params.summary.trim() || params.conflicts.some((item) => !item.trim())) throw new Error("review summary/conflicts must be nonempty strings");
			atomicWrite(managedPath(opts.cwd, relative(opts.cwd, opts.reportPath)), `${JSON.stringify(params, null, 2)}\n`);
			return { content: [{ type: "text" as const, text: "Staged curation report saved. This worker has not published project memory; the orchestrator controls any manual/automatic publication." }], details: undefined };
		},
	});
}
