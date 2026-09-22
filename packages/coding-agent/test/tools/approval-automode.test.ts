import { describe, expect, it } from "bun:test";
import type { ChoiceAnswer, Judge, JudgeOptions, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import type { ModelRegistry } from "../../src/config/model-registry";
import {
	ToolApprovalAutomodeReviewer,
	type ToolApprovalReviewChoice,
	type ToolApprovalReviewRequest,
} from "../../src/tools/approval-automode";
import { tokenUsage } from "@oh-my-pi/pi-ai/judgment";

type ReviewFixture = {
	reviewer: ToolApprovalAutomodeReviewer;
	states: unknown[];
};

function makeFixture(
	choice: ToolApprovalReviewChoice,
	probability: number,
	confidence: number,
	overrides: {
		latestUserText?: string;
		cwd?: string;
		obfuscateText?: (text: string) => string;
		judge?: Judge;
	} = {},
): ReviewFixture {
	const states: unknown[] = [];
	const judge: Judge =
		overrides.judge ??
		({
			label: "test/judge",
			async judge<Q extends Questions>(
				request: JudgmentRequest<Q>,
				_options?: JudgeOptions,
			): Promise<JudgmentResult<Q>> {
				states.push(request.state);
				const answer: ChoiceAnswer<ToolApprovalReviewChoice> = {
					type: "choice",
					choice,
					probabilities: {
						allow: choice === "allow" ? probability : 1 - probability,
						deny: choice === "deny" ? probability : 1 - probability,
						ask_human: choice === "ask_human" ? probability : 1 - probability,
					},
					confidence,
				};
				return {
					api: "test",
					provider: "test",
					model: "test/judge",
					answers: { decision: answer },
					usage: tokenUsage(1, 1),
				} as JudgmentResult<Q>;
			},
		} satisfies Judge);

	return {
		states,
		reviewer: new ToolApprovalAutomodeReviewer({
			settings: Settings.isolated(),
			registry: {} as ModelRegistry,
			getModel: () => undefined,
			getCwd: () => overrides.cwd ?? "/workspace/project",
			getLatestUserText: () => overrides.latestUserText ?? "Please update the project safely.",
			obfuscateText: overrides.obfuscateText,
			createJudge: () => judge,
		}),
	};
}

const request = (tier: ToolTier = "write"): ToolApprovalReviewRequest => ({
	toolCallId: "call-1",
	toolName: "write",
	tier,
	operation: "Allow tool: write\nArguments: { path: '/workspace/project/out.txt' }",
});

describe("ToolApprovalAutomodeReviewer", () => {
	it("allows write only when probability and confidence clear the write threshold", async () => {
		const fixture = makeFixture("allow", 0.91, 0.91);

		expect(await fixture.reviewer.review(request())).toMatchObject({
			decision: "allow",
			probability: 0.91,
			confidence: 0.91,
		});
	});

	it("uses the stricter exec threshold and falls back when it is not met", async () => {
		const fixture = makeFixture("allow", 0.96, 0.99);

		expect(await fixture.reviewer.review(request("exec"))).toMatchObject({
			decision: "ask_human",
			recommendation: "allow",
		});
	});

	it("accepts a high-confidence deny but never auto-allows an ambiguous answer", async () => {
		const denied = makeFixture("deny", 0.95, 0.95);
		const ambiguous = makeFixture("ask_human", 0.99, 0.99);

		expect(await denied.reviewer.review(request())).toMatchObject({ decision: "deny" });
		expect(await ambiguous.reviewer.review(request())).toMatchObject({
			decision: "ask_human",
			recommendation: "ask_human",
		});
	});

	it("bounds and obfuscates every state field before it reaches the judge", async () => {
		const fixture = makeFixture("ask_human", 0.5, 0.5, {
			latestUserText: `secret-token ${"x".repeat(5000)}`,
			cwd: "/workspace/project/secret-token",
			obfuscateText: text => text.replaceAll("secret-token", "[REDACTED]"),
		});

		await fixture.reviewer.review({
			...request(),
			operation: `secret-token ${"operation ".repeat(500)}`,
		});

		const state = fixture.states[0] as Record<string, string>;
		expect(state.latest_user_request).toContain("[REDACTED]");
		expect(state.working_directory).toContain("[REDACTED]");
		expect(state.operation).toContain("[REDACTED]");
		expect(state.latest_user_request).not.toContain("secret-token");
		expect(state.operation.length).toBeLessThanOrEqual(2_000);
	});

	it("returns unavailable when the judge fails", async () => {
		const judge: Judge = {
			label: "test/failing",
			async judge() {
				throw new Error("judge unavailable");
			},
		};
		const fixture = makeFixture("allow", 1, 1, { judge });

		expect(await fixture.reviewer.review(request())).toMatchObject({
			decision: "unavailable",
			reason: "judge unavailable",
		});
	});

	it("propagates caller cancellation instead of converting it into an approval", async () => {
		const fixture = makeFixture("allow", 1, 1);
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));

		await expect(fixture.reviewer.review(request(), controller.signal)).rejects.toThrow("cancelled");
	});
});
