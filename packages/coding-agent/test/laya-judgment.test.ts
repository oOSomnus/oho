import { describe, expect, test } from "bun:test";
import type { JudgmentRequest, Questions, ScoreQuestion } from "@oh-my-pi/pi-ai";
import { JudgmentParseError } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { LayaJudge, type LayaJudgmentClient } from "@oh-my-pi/pi-coding-agent/judgment/laya";

const MODEL = getBundledModel("laya", "typed-decisions");
if (!MODEL) throw new Error("Expected bundled Laya model");

const QUESTION = {
	type: "choice" as const,
	instructions: "Choose the risk level.",
	criteria: { safe: "read-only", risky: "changes state" },
};
const SCORE_QUESTION = {
	type: "score" as const,
	instructions: "Rate the risk.",
	criteria: ["safe", "review", "risky"],
} satisfies ScoreQuestion;

class FakeClient implements LayaJudgmentClient {
	result: unknown;
	calls = 0;

	constructor(result: unknown) {
		this.result = result;
	}

	async judge<Q extends Questions>(_request: JudgmentRequest<Q>): Promise<unknown> {
		this.calls++;
		return this.result;
	}
}

function judgeWith(client: LayaJudgmentClient): LayaJudge {
	return new LayaJudge(MODEL, client);
}

describe("LayaJudge", () => {
	test("maps a complete typed choice and normalizes token usage", async () => {
		const client = new FakeClient({
			answers: {
				risk: { type: "choice", choice: "safe", probabilities: { safe: 0.8, risky: 0.2 }, confidence: 0.75 },
			},
			usage: { input_tokens: 12, output_tokens: 2 },
		});

		const result = await judgeWith(client).judge({ state: "inspect files", questions: { risk: QUESTION } });

		expect(result).toMatchObject({
			api: "laya-local",
			provider: "laya",
			model: "typed-decisions",
			answers: { risk: { type: "choice", choice: "safe", confidence: 0.75 } },
			usage: { input: 12, output: 0, totalTokens: 12 },
		});
	});

	test("rejects an answer with an unknown option or probability key", async () => {
		const client = new FakeClient({
			answers: {
				risk: { type: "choice", choice: "unknown", probabilities: { safe: 0.8, unknown: 0.2 }, confidence: 0.75 },
			},
		});

		await expect(
			judgeWith(client).judge({ state: "inspect files", questions: { risk: QUESTION } }),
		).rejects.toBeInstanceOf(JudgmentParseError);
	});

	test("rejects an answer set that omits a requested question", async () => {
		const client = new FakeClient({
			answers: {
				risk: { type: "choice", choice: "safe", probabilities: { safe: 0.8, risky: 0.2 }, confidence: 0.75 },
			},
		});

		await expect(
			judgeWith(client).judge({ state: "inspect files", questions: { risk: QUESTION, second: QUESTION } }),
		).rejects.toThrow("answers must contain exactly risk, second");
	});

	test("rejects probabilities that do not sum to one", async () => {
		const client = new FakeClient({
			answers: {
				risk: { type: "choice", choice: "safe", probabilities: { safe: 0.8, risky: 0.8 }, confidence: 0.75 },
				second: { type: "choice", choice: "safe", probabilities: { safe: 0.8, risky: 0.2 }, confidence: 0.75 },
			},
		});

		await expect(
			judgeWith(client).judge({ state: "inspect files", questions: { risk: QUESTION, second: QUESTION } }),
		).rejects.toThrow("choice probabilities must sum to 1");
	});

	test.each([
		["missing usage", undefined],
		["missing canonical input token count", {}],
		["negative input token count", { input_tokens: -1 }],
		["fractional input token count", { input_tokens: 1.5 }],
		["legacy input token alias", { prompt_tokens: 12 }],
	] as const)("rejects %s", async (_label, usage) => {
		const client = new FakeClient({
			answers: {
				risk: { type: "choice", choice: "safe", probabilities: { safe: 0.8, risky: 0.2 }, confidence: 0.75 },
			},
			...(usage === undefined ? {} : { usage }),
		});

		await expect(judgeWith(client).judge({ state: "inspect files", questions: { risk: QUESTION } })).rejects.toThrow(
			"usage",
		);
	});

	test("accepts a valid score probability distribution", async () => {
		const client = new FakeClient({
			answers: {
				risk: { type: "score", score: 1, probabilities: { "0": 0.2, "1": 0.5, "2": 0.3 }, confidence: 0.8 },
			},
			usage: { input_tokens: 4 },
		});

		const result = await judgeWith(client).judge({ state: "inspect files", questions: { risk: SCORE_QUESTION } });

		expect(result.answers.risk).toMatchObject({ type: "score", score: 1, confidence: 0.8 });
	});

	test("rejects score probabilities that do not sum to one", async () => {
		const client = new FakeClient({
			answers: {
				risk: { type: "score", score: 1, probabilities: { "0": 0.2, "1": 0.2, "2": 0.2 }, confidence: 0.8 },
			},
			usage: { input_tokens: 4 },
		});

		await expect(
			judgeWith(client).judge({ state: "inspect files", questions: { risk: SCORE_QUESTION } }),
		).rejects.toThrow("score probabilities must sum to 1");
	});
});
