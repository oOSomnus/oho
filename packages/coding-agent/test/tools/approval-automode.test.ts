import { afterEach, describe, expect, it, vi } from "bun:test";
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
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ChainJudge } from "../../src/judgment";
import { layaJudgeClient } from "../../src/judgment/laya-client";
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import type { ModelRegistry } from "../../src/config/model-registry";
import {
	formatApprovalActorSuffix,
	ToolApprovalAutomodeReviewer,
	type ToolApprovalAutomodeDependencies,
	type ToolApprovalReviewChoice,
	type ToolApprovalReviewRequest,
} from "../../src/tools/approval-automode";
import { tokenUsage } from "@oh-my-pi/pi-ai/judgment";

const LAYA = getBundledModel("laya", "typed-decisions");
if (!LAYA) throw new Error("Expected bundled Laya judge model");

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

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
		settings?: Settings;
		registry?: ModelRegistry;
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

	const dependencies = {
		settings: overrides.settings ?? Settings.isolated(),
		registry: overrides.registry ?? ({} as ModelRegistry),
		getModel: () => undefined,
		getCwd: () => overrides.cwd ?? "/workspace/project",
		getConversationContext: () => ({
			latestUserText: overrides.latestUserText ?? "Please update the project safely.",
			recentMessages: overrides.recentMessages,
		}),
		obfuscateText: overrides.obfuscateText,
		createJudge: () => judge,
	} as ToolApprovalAutomodeDependencies;

	return {
		states,
		questions,
		reviewer: new ToolApprovalAutomodeReviewer(dependencies),
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
			actor: "judge",
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
				actor: "judge",
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
			actor: "judge",
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

	it("does not charge a cold Laya load against the review deadline", async () => {
		const load = Promise.withResolvers<void>();
		const stage = Promise.withResolvers<"load" | "judge">();
		const timeoutControllers: AbortController[] = [];
		vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
			const controller = new AbortController();
			timeoutControllers.push(controller);
			return controller.signal;
		});
		const settings = Settings.isolated({
			modelRoles: { judge: "laya/typed-decisions" },
			"retry.fallbackChains": { judge: [] },
		});
		const registry = { getAvailable: () => [LAYA] } as unknown as ModelRegistry;
		const judge = new ChainJudge({ settings, registry });
		vi.spyOn(layaJudgeClient, "waitUntilReady").mockImplementation(() => {
			stage.resolve("load");
			return load.promise;
		});
		vi.spyOn(layaJudgeClient, "judge").mockImplementation(async (_request, options) => {
			stage.resolve("judge");
			await load.promise;
			if (options?.signal?.aborted) throw options.signal.reason;
			return {
				answers: {
					decision: {
						type: "choice",
						choice: "allow",
						probabilities: { allow: 1, deny: 0 },
						confidence: 1,
					},
				},
				usage: { input_tokens: 1 },
			};
		});
		const fixture = makeFixture("allow", 1, 1, {
			settings,
			registry,
			judge,
		});

		const result = fixture.reviewer.review(request("exec"));
		await stage.promise;
		for (const controller of timeoutControllers) {
			controller.abort(new DOMException("review deadline expired", "TimeoutError"));
		}
		load.resolve();

		await expect(result).resolves.toMatchObject({ decision: "allow", model: "typed-decisions" });
	});
});

describe("formatApprovalActorSuffix", () => {
	it("returns empty when no actor was recorded", () => {
		expect(formatApprovalActorSuffix(undefined)).toBe("");
		expect(formatApprovalActorSuffix({})).toBe("");
		expect(formatApprovalActorSuffix({ handoff: "risk-threshold" })).toBe("");
	});

	it("names the actor alone when no classification is attached", () => {
		expect(formatApprovalActorSuffix({ actor: "judge" })).toBe(" (judge)");
		expect(formatApprovalActorSuffix({ actor: "fast-gate" })).toBe(" (fast gate)");
		expect(formatApprovalActorSuffix({ actor: "user" })).toBe(" (user)");
	});

	it("appends the dual-axis summary when classification is attached", () => {
		expect(
			formatApprovalActorSuffix({
				actor: "fast-gate",
				classification: { risk: "low", authorization: "high" },
			}),
		).toBe(" (fast gate: risk=low auth=high)");
	});

	it("drops the scores but keeps the actor when score display is off", () => {
		const meta = {
			actor: "fast-gate" as const,
			classification: { risk: "critical" as const, authorization: "unknown" as const },
		};

		expect(formatApprovalActorSuffix(meta, { showScores: false })).toBe(" (fast gate)");
		// Explicitly on, and omitted, both default to showing them.
		expect(formatApprovalActorSuffix(meta, { showScores: true })).toBe(" (fast gate: risk=critical auth=unknown)");
		expect(formatApprovalActorSuffix(meta)).toBe(" (fast gate: risk=critical auth=unknown)");
	});
});
