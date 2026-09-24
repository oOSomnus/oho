import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "../src/status-line/segments";
import { renderSegment } from "../src/status-line/segments";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

function judgeContext(judgeStatus: SegmentContext["judgeStatus"]): SegmentContext {
	return { judgeStatus } as SegmentContext;
}

describe("status line judge segment", () => {
	it("stays hidden while the judge worker is idle", () => {
		const rendered = renderSegment("judge", judgeContext(undefined));

		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("uses compact labels with state-specific semantic colors", () => {
		const states = [
			{ status: "loading", symbol: "status.pending", label: "Judge", color: "muted" },
			{ status: "ready", symbol: "status.success", label: "Judge", color: "success" },
			{ status: "failed", symbol: "status.warning", label: "Judge retry", color: "warning" },
		] as const;

		for (const { status, symbol, label, color } of states) {
			const rendered = renderSegment("judge", judgeContext(status));

			expect(rendered.visible).toBe(true);
			expect(rendered.content).toBe(`${theme.styledSymbol(symbol, color)} ${theme.fg(color, label)}`);
			expect(Bun.stripANSI(rendered.content)).toContain(label);
		}
	});
});
