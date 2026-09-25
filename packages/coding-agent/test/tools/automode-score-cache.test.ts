import { describe, expect, it } from "bun:test";
import { AutomodeScoreLedger } from "../../src/tools/automode/score-cache";
import type { AuthorizationLevel, FastGateClassification, RiskLevel } from "../../src/tools/automode/types";

function classification(
	seq: number,
	options: { risk?: RiskLevel; authorization?: AuthorizationLevel; truncated?: boolean } = {},
): FastGateClassification {
	const risk = options.risk ?? "low";
	const authorization = options.authorization ?? "high";
	return {
		toolCallId: `call-${seq}`,
		seq,
		risk: {
			level: risk,
			expected: risk === "low" ? 0.2 : 2.4,
			tailHigh: risk === "low" ? 0.05 : 0.8,
			probabilities: { "0": 0.8, "1": 0.2 },
			confidence: 0.9,
		},
		authorization: {
			level: authorization,
			probabilities: { high: 0.9, medium: 0.1, low: 0, unknown: 0 },
			confidence: 0.9,
		},
		predictiveDanger: 0.1,
		model: "laya",
		scoredAt: 1_000 + seq,
		truncated: options.truncated ?? false,
	};
}

describe("AutomodeScoreLedger", () => {
	it("publishes the first sample as the cached score", () => {
		const ledger = new AutomodeScoreLedger();
		const cached = ledger.publish(classification(1));

		expect(cached.classification.seq).toBe(1);
		expect(cached.hasUnscoredFailure).toBe(false);
		expect(ledger.latest()?.classification.seq).toBe(1);
	});

	it("keeps the newest sample when answers arrive out of order", () => {
		const ledger = new AutomodeScoreLedger();
		ledger.publish(classification(2));
		const late = ledger.publish(classification(1));

		expect(late.classification.seq).toBe(2);
		expect(ledger.latest()?.classification.seq).toBe(2);
		expect(ledger.coverage().latestScoredSeq).toBe(2);
	});

	it("reports lag against the most recent fire", () => {
		const ledger = new AutomodeScoreLedger();
		ledger.nextSeq();
		ledger.nextSeq();
		ledger.publish(classification(1));
		const seq3 = ledger.nextSeq();

		expect(seq3).toBe(3);
		expect(ledger.latest()?.lag).toBe(2);
	});

	it("marks an unscored failure until a newer sample covers it", () => {
		const ledger = new AutomodeScoreLedger();
		ledger.nextSeq();
		ledger.recordFailure(1, "scoring-failure");

		expect(ledger.latest()).toBeUndefined();

		ledger.publish(classification(2));
		expect(ledger.latest()?.hasUnscoredFailure).toBe(false);

		ledger.recordFailure(3, "timeout");
		expect(ledger.latest()?.hasUnscoredFailure).toBe(true);
	});

	it("never lets a failure replace a newer sample", () => {
		const ledger = new AutomodeScoreLedger();
		ledger.publish(classification(5));
		ledger.recordFailure(3, "scoring-failure");

		const cached = ledger.latest();
		expect(cached?.classification.seq).toBe(5);
		expect(cached?.hasUnscoredFailure).toBe(false);
		expect(ledger.coverage().latestFailedSeq).toBe(3);
		expect(ledger.coverage().latestScoredSeq).toBe(5);
	});

	it("counts oversized inputs and flags them as unscored", () => {
		const ledger = new AutomodeScoreLedger();
		ledger.recordOversized(1);
		ledger.recordOversized(1);
		ledger.recordOversized(2);

		expect(ledger.coverage().oversizedToolCalls).toBe(2);
		expect(ledger.coverage().latestFailedSeq).toBe(2);
	});

	it("keeps the trim flag on the sample for the audit row", () => {
		const ledger = new AutomodeScoreLedger();
		const cached = ledger.publish(classification(1, { truncated: true }));

		expect(cached.classification.truncated).toBe(true);
	});

	it("flags a window that has drifted into weak authorization", () => {
		const ledger = new AutomodeScoreLedger({ windowSize: 4, weakAuthorizationLimit: 2 });

		ledger.publish(classification(1, { authorization: "high" }));
		expect(ledger.weakAuthorizationWindow()).toBe(false);

		ledger.publish(classification(2, { authorization: "low" }));
		expect(ledger.weakAuthorizationWindow()).toBe(false);

		ledger.publish(classification(3, { authorization: "unknown" }));
		expect(ledger.weakAuthorizationWindow()).toBe(true);
	});

	it("slides weak samples out of the window as new ones arrive", () => {
		const ledger = new AutomodeScoreLedger({ windowSize: 2, weakAuthorizationLimit: 2 });

		ledger.publish(classification(1, { authorization: "low" }));
		ledger.publish(classification(2, { authorization: "unknown" }));
		expect(ledger.weakAuthorizationWindow()).toBe(true);

		ledger.publish(classification(3, { authorization: "high" }));
		expect(ledger.weakAuthorizationWindow()).toBe(false);
	});

	it("reads no samples as no weak window", () => {
		expect(new AutomodeScoreLedger().weakAuthorizationWindow()).toBe(false);
	});
});
