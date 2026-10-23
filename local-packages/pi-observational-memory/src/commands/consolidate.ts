import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { foldLedger, poolTokens, selectPromotionOverflow, type Entry } from "../ledger/index.js";
import type { Runtime } from "../runtime.js";
import { evaluateConsolidatorTrigger } from "../hooks/consolidator-trigger.js";

/**
 * Force consolidation without changing configured thresholds. No args preserves oldest
 * overflow selection; `all` selects every active observation, including a pool below target.
 * Both modes retain the enabled/passive/concurrency guards.
 */
export function registerConsolidateCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:consolidate", {
		description: "Consolidate overflow now, or use 'all' for every active observation (respects passive mode)",
		handler: async (args: string, ctx: any) => {
			const arg = (args ?? "").trim();
			if (arg !== "" && arg !== "all") {
				if (ctx.hasUI) ctx.ui.notify("Usage: /om:consolidate [all] — no args promotes overflow above target; all promotes every active observation.", "error");
				return;
			}
			if (!runtime.enabled) {
				if (ctx.hasUI) ctx.ui.notify("om is off (use /om on to enable)", "info");
				return;
			}
			if (runtime.saveTask || runtime.consolidatorInFlight || runtime.promotionController) {
				if (ctx.hasUI) ctx.ui.notify("om: consolidation/promotion already in progress; retry after it finishes", "warning");
				return;
			}
			runtime.ensureConfig(ctx.cwd);
			const branch = ctx.sessionManager.getBranch() as Entry[];
			const active = foldLedger(branch).activeObservations;
			const promote = arg === "all" ? active : selectPromotionOverflow(active, runtime.config.poolTargetTokens).promote;
			if (promote.length === 0) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						arg === "all" ? "om: nothing to consolidate (no active observations)"
							: `om: nothing to consolidate (pool ${poolTokens(active).toLocaleString()} tok <= target ${runtime.config.poolTargetTokens.toLocaleString()} tok)`,
						"info",
					);
				}
				return;
			}
			// Explicit manual mode bypasses the trigger threshold, never passive/concurrency guards.
			evaluateConsolidatorTrigger(pi, runtime, ctx, arg === "all" ? "all" : "overflow");
		},
	});
}
