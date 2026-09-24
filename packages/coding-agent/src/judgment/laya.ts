import { isRecord } from "@oh-my-pi/pi-utils";
import type {
	Answer,
	ChoiceQuestion,
	Judge,
	JudgeOptions,
	JudgmentRequest,
	JudgmentResult,
	Model,
	NoulQuestion,
	Question,
	Questions,
	ScoreQuestion,
} from "@oh-my-pi/pi-ai";
import { JudgmentParseError, tokenUsage } from "@oh-my-pi/pi-ai";

export interface LayaJudgmentClient {
	judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<unknown>;
}

function outputText(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function parseFailure(questionId: string, value: unknown, detail: string): JudgmentParseError {
	return new JudgmentParseError(questionId, outputText(value), detail);
}

function requireRecord(questionId: string, value: unknown, detail: string): Record<string, unknown> {
	if (!isRecord(value)) throw parseFailure(questionId, value, detail);
	return value;
}

function requireFiniteNumber(questionId: string, value: unknown, detail: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw parseFailure(questionId, value, detail);
	return value;
}

function requireProbability(questionId: string, value: unknown, detail: string): number {
	const number = requireFiniteNumber(questionId, value, detail);
	if (number < 0 || number > 1) throw parseFailure(questionId, value, `${detail} must be between 0 and 1`);
	return number;
}

function requireExactKeys(
	questionId: string,
	value: Record<string, unknown>,
	expected: readonly string[],
	detail: string,
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
		throw parseFailure(questionId, value, `${detail} must contain exactly ${wanted.join(", ")}`);
	}
}

function validateChoice(questionId: string, question: ChoiceQuestion, value: unknown): Answer {
	const answer = requireRecord(questionId, value, "choice answer must be an object");
	if (answer.type !== "choice") throw parseFailure(questionId, value, "answer type does not match question");
	if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) {
		throw parseFailure(questionId, value, "choice must name one of the requested criteria");
	}
	const probabilities = requireRecord(questionId, answer.probabilities, "choice probabilities must be an object");
	const criteria = Object.keys(question.criteria);
	requireExactKeys(questionId, probabilities, criteria, "choice probabilities");
	let total = 0;
	for (const criterion of criteria) {
		const probability = requireProbability(questionId, probabilities[criterion], `probability for ${criterion}`);
		total += probability;
	}
	if (Math.abs(total - 1) > 0.0001) throw parseFailure(questionId, value, "choice probabilities must sum to 1");
	const confidence = requireProbability(questionId, answer.confidence, "confidence");
	return {
		type: "choice",
		choice: answer.choice,
		probabilities: probabilities as Record<string, number>,
		confidence,
	};
}

function validateNoul(questionId: string, question: NoulQuestion, value: unknown): Answer {
	const answer = requireRecord(questionId, value, "noul answer must be an object");
	if (answer.type !== question.type) throw parseFailure(questionId, value, "answer type does not match question");
	return { type: "noul", noul: requireProbability(questionId, answer.noul, "noul probability") };
}

function validateScore(questionId: string, question: ScoreQuestion, value: unknown): Answer {
	const answer = requireRecord(questionId, value, "score answer must be an object");
	if (answer.type !== question.type) throw parseFailure(questionId, value, "answer type does not match question");
	const probabilities = requireRecord(questionId, answer.probabilities, "score probabilities must be an object");
	const levels = question.criteria.map((_, index) => String(index));
	requireExactKeys(questionId, probabilities, levels, "score probabilities");
	let total = 0;
	for (const level of levels) {
		total += requireProbability(questionId, probabilities[level], `probability for level ${level}`);
	}
	if (Math.abs(total - 1) > 0.0001) throw parseFailure(questionId, value, "score probabilities must sum to 1");
	const score = requireFiniteNumber(questionId, answer.score, "score");
	if (score < 0 || score > question.criteria.length - 1) {
		throw parseFailure(questionId, value, "score must be within the requested levels");
	}
	return {
		type: "score",
		score,
		probabilities: probabilities as Record<string, number>,
		confidence: requireProbability(questionId, answer.confidence, "confidence"),
	};
}

function validateAnswer(questionId: string, question: Question, value: unknown): Answer {
	switch (question.type) {
		case "choice":
			return validateChoice(questionId, question, value);
		case "noul":
			return validateNoul(questionId, question, value);
		case "score":
			return validateScore(questionId, question, value);
	}
}

function parseUsage(value: unknown) {
	if (!isRecord(value) || !Object.hasOwn(value, "input_tokens")) {
		throw new Error("laya: usage.input_tokens is required");
	}
	if (Object.hasOwn(value, "prompt_tokens") || Object.hasOwn(value, "input")) {
		throw new Error("laya: usage.input_tokens is the only supported input token field");
	}
	const inputTokens = value.input_tokens;
	if (typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens < 0) {
		throw new Error("laya: invalid usage.input_tokens token count");
	}
	return tokenUsage(inputTokens, 0);
}

function parseAnswers<Q extends Questions>(request: JudgmentRequest<Q>, raw: unknown): JudgmentResult<Q>["answers"] {
	const envelope = requireRecord("<envelope>", raw, "Laya result must be an object");
	const answers = requireRecord("<envelope>", envelope.answers, "Laya result must contain answers");
	const questionIds = Object.keys(request.questions);
	requireExactKeys("<envelope>", answers, questionIds, "answers");
	const parsed: Record<string, Answer> = {};
	for (const questionId of questionIds)
		parsed[questionId] = validateAnswer(questionId, request.questions[questionId], answers[questionId]);
	return parsed as JudgmentResult<Q>["answers"];
}

export class LayaJudge implements Judge {
	readonly label: string;
	readonly #model: Model;
	readonly #client: LayaJudgmentClient;

	constructor(model: Model, client: LayaJudgmentClient) {
		this.#model = model;
		this.#client = client;
		this.label = `${model.provider}/${model.id}`;
	}

	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options: JudgeOptions = {},
	): Promise<JudgmentResult<Q>> {
		options.signal?.throwIfAborted();
		const raw = await this.#client.judge(request, options);
		return {
			api: this.#model.api,
			provider: this.#model.provider,
			model: this.#model.id,
			answers: parseAnswers(request, raw),
			usage: parseUsage(isRecord(raw) ? raw.usage : undefined),
		};
	}
}
