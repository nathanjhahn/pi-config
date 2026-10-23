import { dirname, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { atomicWrite } from "../../src/memory/paths.js";
import { managedPath } from "../../src/memory/project.js";
import { RepositoryInspector } from "../../src/memory/repository.js";

export function registerRepositoryTools(pi: ExtensionAPI, opts: { cwd: string; inputPath: string; evidencePath?: string }): void {
	const path = join(dirname(opts.inputPath), "repo-evidence.json");
	if (opts.evidencePath && resolve(opts.evidencePath) !== resolve(path)) throw new Error("repository evidencePath must be repo-evidence.json beside input.json");
	const evidencePath = () => managedPath(opts.cwd, relative(opts.cwd, path));
	const inspector = new RepositoryInspector(opts.cwd, (evidence) => atomicWrite(evidencePath(), `${JSON.stringify(evidence, null, 2)}\n`));
	atomicWrite(evidencePath(), `${JSON.stringify(inspector.evidence)}\n`);
	const definitions = [
		{ name: "repo_ls", description: "Nonrecursive filtered repository listing. Read-only; path defaults to '.'. Does not provide factual source evidence.",
			parameters: Type.Object({ path: Type.Optional(Type.String()) }), run: (params: any) => inspector.ls(params) },
		{ name: "repo_read", description: "Read targeted static repository text, not staged memory. 1-based offset; limit defaults to 200 lines (maximum 400). Only displayed ranges are attested; full-file hashes do not verify unseen claims. Private/ignored/generated/binary paths are blocked.",
			parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }), run: (params: any) => inspector.read(params) },
		{ name: "repo_search", description: "Bounded LITERAL repository search under explicit path (file/directory). No regex or execution. maxMatches defaults to 20 (maximum 50). No matches/truncation is not proof of absence. Search only as needed to resolve static implementation claims.",
			parameters: Type.Object({ path: Type.String(), query: Type.String(), maxMatches: Type.Optional(Type.Number()) }), run: (params: any) => inspector.search(params) },
	];
	for (const def of definitions) pi.registerTool({ name: def.name, label: def.name, description: def.description, parameters: def.parameters,
		async execute(_id: string, params: any) {
			try { return { content: [{ type: "text" as const, text: def.run(params) }], details: undefined }; }
			catch (error) { return { content: [{ type: "text" as const, text: inspector.errorText(error) }], isError: true, details: undefined }; }
		},
	});
}
