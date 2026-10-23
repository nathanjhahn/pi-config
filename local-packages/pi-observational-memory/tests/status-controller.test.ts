import { describe, expect, it, vi } from "vitest";

import { StatusController, type StatusUI } from "../src/ui/status-controller.js";

function fakeUI() {
	const status = new Map<string, string | undefined>();
	const ui: StatusUI = {
		setStatus: (key, text) => status.set(key, text),
		setWidget: () => {},
		// Strip color so assertions read the raw glyphs.
		theme: { fg: (_color, text) => text },
	};
	return { ui, footer: () => status.get("om") };
}

describe("StatusController footer gauges", () => {
	it("shows a bare footer until gauges are set", () => {
		const { ui, footer } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		expect(footer()).toBe("om");
	});

	it("clearing cancelled workers stops the spinner without discarding gauges or cost", () => {
		vi.useFakeTimers();
		try {
			const { ui, footer } = fakeUI();
			ui.setWidget = vi.fn();
			const sc = new StatusController();
			sc.attach(ui);
			sc.setGauges({ nextValue: 1, nextMax: 10, poolValue: 2, poolMax: 10, ctxValue: 3, ctxMax: 10 });
			sc.setCost(0.75, 1);
			const before = footer();
			sc.workerStart("observer", "pending");
			sc.workerDone("pending", 0);
			sc.workerStart("consolidator", "also-pending");
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			sc.clearWorkers();
			expect(ui.setWidget).toHaveBeenLastCalledWith("om-workers", undefined);
			expect(vi.getTimerCount()).toBe(0);
			expect(footer()).toBe(before);
			expect(footer()).toContain("$0.750");
			sc.detach();
		} finally { vi.useRealTimers(); }
	});

	it("clearing gauges returns to the bare footer", () => {
		const { ui, footer } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		sc.setGauges({ nextValue: 1500, nextMax: 3000, poolValue: 5000, poolMax: 10_000, ctxValue: 10_000, ctxMax: 80_000 });
		sc.setGauges(undefined);
		expect(footer()).toBe("om");
	});
});
