import { describe, expect, it } from "bun:test";
import {
	type ChoiceAnswer,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type Questions,
	type TextBackend,
	type TextPrompt,
	TextJudge,
} from "@oh-my-pi/pi-ai";
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
	questions: unknown[];
};

function makeFixture(
	choice: ToolApprovalReviewChoice,
	probability: number,
	confidence: number,
	overrides: {
		latestUserText?: string;
		recentMessages?: string;
		cwd?: string;
		obfuscateText?: (text: string) => string;
		judge?: Judge;
	} = {},
): ReviewFixture {
	const states: unknown[] = [];
	const questions: unknown[] = [];
	const judge: Judge =
		overrides.judge ??
		({
			label: "test/judge",
			async judge<Q extends Questions>(
				request: JudgmentRequest<Q>,
				_options?: JudgeOptions,
			): Promise<JudgmentResult<Q>> {
				states.push(request.state);
				questions.push(request.questions);
				const answer: ChoiceAnswer<ToolApprovalReviewChoice> = {
					type: "choice",
					choice,
					probabilities: {
						allow: choice === "allow" ? probability : 1 - probability,
						deny: choice === "deny" ? probability : 1 - probability,
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
		questions,
		reviewer: new ToolApprovalAutomodeReviewer({
			settings: Settings.isolated(),
			registry: {} as ModelRegistry,
			getModel: () => undefined,
			getCwd: () => overrides.cwd ?? "/workspace/project",
			getConversationContext: () => ({
				latestUserText: overrides.latestUserText ?? "Please update the project safely.",
				recentMessages: overrides.recentMessages,
			}),
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
	it("asks only for allow or deny and directly applies low-score allow", async () => {
		const fixture = makeFixture("allow", 0.01, 0);

		expect(await fixture.reviewer.review(request("exec"))).toEqual({
			decision: "allow",
			model: "test/judge",
		});
		const questions = fixture.questions[0] as { decision: { criteria: Record<string, unknown> } };
		expect(Object.keys(questions.decision.criteria)).toEqual(["allow", "deny"]);
	});
	it("uses recent conversation context with a text-backed binary reviewer", async () => {
		for (const decision of ["allow", "deny"] as const) {
			let observedPrompt: TextPrompt | undefined;
			const backend: TextBackend = {
				api: "fake-chat",
				provider: "test",
				model: "approval-review",
				async complete(prompt) {
					observedPrompt = prompt;
					return { text: decision };
				},
			};
			const fixture = makeFixture("deny", 0.01, 0, {
				latestUserText: "Please update the file we discussed.",
				recentMessages:
					"user: Keep the generated file unchanged.\nassistant: I will only edit the requested source file.",
				judge: new TextJudge(backend),
			});

			expect(await fixture.reviewer.review(request())).toEqual({
				decision,
				model: "approval-review",
			});
			expect(observedPrompt?.system).toContain("allow");
			expect(observedPrompt?.system).toContain("deny");
			expect(observedPrompt?.user).toContain("<latest_user_request>");
			expect(observedPrompt?.user).toContain("Please update the file we discussed.");
			expect(observedPrompt?.user).toContain("<recent_conversation>");
			expect(observedPrompt?.user).toContain("Keep the generated file unchanged.");
			expect(observedPrompt?.user).toContain("I will only edit the requested source file.");
		}
	});

	it("directly applies low-score deny", async () => {
		const fixture = makeFixture("deny", 0.01, 0);

		expect(await fixture.reviewer.review(request())).toEqual({
			decision: "deny",
			model: "test/judge",
		});
	});

	it("bounds and obfuscates every state field before it reaches the judge", async () => {
		const fixture = makeFixture("deny", 0.5, 0.5, {
			latestUserText: `secret-token ${"x".repeat(5000)}`,
			recentMessages: `secret-token ${"x".repeat(8000)}`,
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
		expect(state.recent_conversation).toContain("[REDACTED]");
		expect(state.recent_conversation).not.toContain("secret-token");
		expect(state.recent_conversation.length).toBeLessThanOrEqual(6_000);
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
