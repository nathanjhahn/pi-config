/** Capture origin identity once; live contexts may switch sessions while workers await. */
import { basename, resolve } from "node:path";
import type { Runtime } from "../runtime.js";
import { sessionMemoryRoot } from "./paths.js";

export type MemoryWorkContext = {
	cwd?: string;
	sessionManager: { getSessionId?: () => string; getBranch?: () => { id: string }[] };
};
export function captureMemoryScope(runtime: Runtime, ctx: MemoryWorkContext) {
	const originalRoot = runtime.memoryRoot;
	const cwd = resolve(ctx.cwd ?? resolve(originalRoot, "..", ".."));
	const sessionId = ctx.sessionManager.getSessionId?.() ?? basename(originalRoot);
	const memoryRoot = originalRoot || sessionMemoryRoot(cwd, sessionId);
	const generation = runtime.memoryWorkGeneration;
	const branchAnchor = ctx.sessionManager.getBranch?.().at(-1)?.id;
	const isCurrentSession = () => runtime.memoryRoot === originalRoot
		&& (!ctx.cwd || resolve(ctx.cwd) === cwd)
		&& (!ctx.sessionManager.getSessionId || ctx.sessionManager.getSessionId() === sessionId);
	const isCurrentBranch = () => isCurrentSession()
		&& (!branchAnchor || !!ctx.sessionManager.getBranch?.().some(entry => entry.id === branchAnchor));
	const active = () => isCurrentBranch() && generation === runtime.memoryWorkGeneration
		&& runtime.enabled && !runtime.config.passive;
	return { cwd, sessionId, memoryRoot, generation, isCurrentSession, isCurrentBranch, active };
}
export type MemoryScope = ReturnType<typeof captureMemoryScope>;
