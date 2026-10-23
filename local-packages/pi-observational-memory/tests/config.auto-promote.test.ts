import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWrite } from "../src/memory/paths.js";
import { DEFAULTS, loadConfig } from "../src/config.js";
const fake = vi.hoisted(() => ({ globalDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...await original<typeof import("@earendil-works/pi-coding-agent")>(), getAgentDir: () => fake.globalDir,
}));
describe("autoPromote config", () => {
	let dir: string, cwd: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "om-auto-config-")); cwd = join(dir, "project"); fake.globalDir = join(dir, "global"); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	it("defaults on without changing existing automatic pool thresholds or model selection", () => {
		const config = loadConfig(cwd, {});
		expect(DEFAULTS.autoPromote).toBe(true); expect(config.autoPromote).toBe(true);
		expect(config.poolTargetTokens).toBe(DEFAULTS.poolTargetTokens);
		expect(config.consolidateAtPoolTokens).toBe(DEFAULTS.consolidateAtPoolTokens);
		expect(config.models).toEqual(DEFAULTS.models);
	});
	it("supports boolean global opt-out and project override; invalid nonbooleans do not enable it", () => {
		atomicWrite(join(fake.globalDir, "settings.json"), JSON.stringify({ "observational-memory": { autoPromote: false } }));
		expect(loadConfig(cwd, {}).autoPromote).toBe(false);
		atomicWrite(join(cwd, ".pi/settings.json"), JSON.stringify({ "observational-memory": { autoPromote: "true" } }));
		expect(loadConfig(cwd, {}).autoPromote).toBe(false);
		atomicWrite(join(cwd, ".pi/settings.json"), JSON.stringify({ "observational-memory": { autoPromote: true } }));
		expect(loadConfig(cwd, {}).autoPromote).toBe(true);
	});
});
