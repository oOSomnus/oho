import { describe, expect, it } from "bun:test";
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import type {
	ToolApprovalReview,
	ToolApprovalReviewRequest,
	ToolApprovalReviewer,
} from "../../src/tools/approval-automode";
import { summarizeClassification, TwoTierToolApprovalReviewer } from "../../src/tools/automode/two-tier-reviewer";
import type {
	FastGateClassification,
	FastGateHandoffReason,
	FastGateVerdict,
	RiskLevel,
	AuthorizationLevel,
} from "../../src/tools/automode/types";

const request: ToolApprovalReviewRequest = {
	toolCallId: "call-1",
	toolName: "bash",
	tier: "exec" as ToolTier,
	operation: "Allow tool: bash\nrm -rf ./build",
};

function classification(risk: RiskLevel = "low", authorization: AuthorizationLevel = "high"): FastGateClassification {
	return {
		toolCallId: "call-1",
		seq: 1,
		risk: {
			level: risk,
			expected: 0.2,
			tailHigh: 0.02,
			probabilities: { "0": 0.9, "1": 0.1, "2": 0, "3": 0 },
			confidence: 0.9,
		},
		authorization: {
			level: authorization,
			probabilities: { high: 0.9, medium: 0.1, low: 0, unknown: 0 },
			confidence: 0.9,
		},
		predictiveDanger: 0.05,
		model: "laya",
		scoredAt: 1_000,
		truncated: false,
	};
}

function passVerdict(): FastGateVerdict {
	return { kind: "pass", handoff: "pass", classification: classification() };
}

function escalateVerdict(handoff: FastGateHandoffReason = "risk-threshold"): FastGateVerdict {
	return { kind: "escalate", handoff, classification: classification("high", "low") };
}

function recordingInner(result: ToolApprovalReview) {
	const calls: ToolApprovalReviewRequest[] = [];
	const inner: ToolApprovalReviewer = {
		async review(call) {
			calls.push(call);
			return result;
		},
	};
	return { inner, calls };
}

describe("TwoTierToolApprovalReviewer", () => {
	it("lets a passing gate through without waking the blocking judge", async () => {
		const { inner, calls } = recordingInner({ decision: "deny", actor: "judge" });
		const reviewer = new TwoTierToolApprovalReviewer({ inner, fastGate: { evaluate: () => passVerdict() } });

		const review = await reviewer.review(request);

		expect(review.decision).toBe("allow");
		expect(review.actor).toBe("fast-gate");
		expect(review.handoff).toBe("pass");
		expect(review.classification).toEqual({ risk: "low", authorization: "high" });
		expect(calls).toHaveLength(0);
	});

	it("escalates to the blocking judge and records why", async () => {
		const { inner, calls } = recordingInner({ decision: "deny", actor: "judge" });
		const handoffs: FastGateHandoffReason[] = [];
		const reviewer = new TwoTierToolApprovalReviewer({
			inner,
			fastGate: { evaluate: () => escalateVerdict("predictive-danger") },
			onHandoff: handoff => handoffs.push(handoff),
		});

		const review = await reviewer.review(request);

		expect(calls).toHaveLength(1);
		expect(review.decision).toBe("deny");
		expect(review.actor).toBe("judge");
		expect(review.handoff).toBe("predictive-danger");
		expect(review.classification).toEqual({ risk: "high", authorization: "low" });
		expect(handoffs).toEqual(["predictive-danger"]);
	});

	it("keeps the blocking reviewer's own classification when it has one", async () => {
		const { inner } = recordingInner({
			decision: "allow",
			actor: "judge",
			classification: { risk: "medium", authorization: "high" },
		});
		const reviewer = new TwoTierToolApprovalReviewer({
			inner,
			fastGate: { evaluate: () => escalateVerdict("missing-score") },
		});

		const review = await reviewer.review(request);

		expect(review.classification).toEqual({ risk: "medium", authorization: "high" });
		expect(review.handoff).toBe("missing-score");
	});

	it("never upgrades an unavailable blocking review to an allow", async () => {
		const { inner } = recordingInner({ decision: "unavailable", reason: "review timed out" });
		const reviewer = new TwoTierToolApprovalReviewer({
			inner,
			fastGate: { evaluate: () => escalateVerdict("stale") },
		});

		const review = await reviewer.review(request);

		expect(review.decision).toBe("unavailable");
		expect(review.actor).toBe("judge");
	});

	it("leaves the decision to the judge when the gate is disabled", async () => {
		const { inner, calls } = recordingInner({ decision: "allow", actor: "judge" });
		let evaluations = 0;
		const reviewer = new TwoTierToolApprovalReviewer({
			inner,
			fastGate: {
				evaluate: () => {
					evaluations += 1;
					return passVerdict();
				},
			},
			isEnabled: () => false,
		});

		const review = await reviewer.review(request);

		expect(evaluations).toBe(0);
		expect(calls).toHaveLength(1);
		expect(review.decision).toBe("allow");
		expect(review.actor).toBe("judge");
	});

	it("consults the gate when the toggle is on", async () => {
		const { inner, calls } = recordingInner({ decision: "allow", actor: "judge" });
		let evaluations = 0;
		const reviewer = new TwoTierToolApprovalReviewer({
			inner,
			fastGate: {
				evaluate: () => {
					evaluations += 1;
					return passVerdict();
				},
			},
			isEnabled: () => true,
		});

		await reviewer.review(request);

		expect(evaluations).toBe(1);
		expect(calls).toHaveLength(0);
	});

	it("only ever answers allow — a denial is not in its vocabulary", async () => {
		for (const verdict of [passVerdict(), escalateVerdict("risk-threshold"), escalateVerdict("unavailable")]) {
			const { inner } = recordingInner({ decision: "unavailable", reason: "judge offline" });
			const reviewer = new TwoTierToolApprovalReviewer({ inner, fastGate: { evaluate: () => verdict } });

			const review = await reviewer.review(request);
			expect(["allow", "deny", "unavailable"]).toContain(review.decision);
			// A gate pass is an allow; a gate escalation is whatever the judge
			// decided. In neither case does the gate itself deny.
			if (verdict.kind === "pass") expect(review.decision).toBe("allow");
		}
	});

	it("forwards the abort signal to the blocking judge", async () => {
		const seen: (AbortSignal | undefined)[] = [];
		const inner: ToolApprovalReviewer = {
			async review(_call, signal) {
				seen.push(signal);
				return { decision: "allow", actor: "judge" };
			},
		};
		const reviewer = new TwoTierToolApprovalReviewer({ inner, fastGate: { evaluate: () => escalateVerdict() } });
		const controller = new AbortController();

		await reviewer.review(request, controller.signal);

		expect(seen).toEqual([controller.signal]);
	});
});

describe("summarizeClassification", () => {
	it("reduces a sample to the two axes the notice renders", () => {
		expect(summarizeClassification(classification("critical", "unknown"))).toEqual({
			risk: "critical",
			authorization: "unknown",
		});
	});

	it("returns nothing when there was no sample", () => {
		expect(summarizeClassification(undefined)).toBeUndefined();
	});
});
