import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import type { ChoiceQuestion, Judge, Model } from "@oh-my-pi/pi-ai";
import { replaceTabs, shortenPath, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { journalJudgmentUsage, resolveJudge, type JudgeDeps, type JudgmentUsageLedger } from "../judgment";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import toolApprovalAutomodePrompt from "../prompts/system/tool-approval-automode.md" with { type: "text" };
import { Semaphore } from "../task/parallel";
import { truncateForPrompt } from "./approval";

export type ToolApprovalReviewChoice = "allow" | "deny" | "ask_human";

export interface ToolApprovalReviewRequest {
	toolCallId: string;
	toolName: string;
	tier: ToolTier;
	operation: string;
}

export interface ToolApprovalReview {
	decision: ToolApprovalReviewChoice | "unavailable";
	recommendation?: ToolApprovalReviewChoice;
	probability?: number;
	confidence?: number;
	model?: string;
	reason?: string;
}

export interface ToolApprovalReviewer {
	review(request: ToolApprovalReviewRequest, signal?: AbortSignal): Promise<ToolApprovalReview>;
}

export interface ToolApprovalAutomodeDependencies {
	settings: Settings;
	registry: ModelRegistry;
	sessionManager?: Partial<JudgmentUsageLedger>;
	sessionId?: string;
	getSessionId?: () => string | undefined;
	getModel: () => Model | undefined;
	getCwd: () => string;
	getLatestUserText: () => string | undefined;
	obfuscateText?: (text: string) => string;
	createJudge?: (deps: JudgeDeps) => Judge;
}

const REVIEW_TIMEOUT_MS = 10_000;
const REVIEW_CONCURRENCY = 2;
const STATE_TEXT_LIMIT = 4_000;
const OPERATION_TEXT_LIMIT = 2_000;
const REASON_TEXT_LIMIT = 320;
const ALLOW_WRITE_THRESHOLD = 0.9;
const ALLOW_EXEC_THRESHOLD = 0.97;
const DENY_THRESHOLD = 0.95;

const AUTOMODE_QUESTION: ChoiceQuestion<ToolApprovalReviewChoice> = {
	type: "choice",
	instructions: toolApprovalAutomodePrompt,
	criteria: {
		allow: null,
		deny: null,
		ask_human: null,
	},
};

const AUTOMODE_QUESTIONS = { decision: AUTOMODE_QUESTION };

function finiteProbability(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function boundedText(value: string | undefined, maxChars: number, obfuscate?: (text: string) => string): string {
	if (!value) return "(none)";
	const redacted = obfuscate ? obfuscate(value) : value;
	const sanitized = sanitizeText(replaceTabs(redacted)).replace(/\r/g, "").trim();
	if (!sanitized) return "(none)";
	return truncateToWidth(truncateForPrompt(sanitized, maxChars), maxChars);
}

function boundedReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return truncateForPrompt(sanitizeText(replaceTabs(message)).replace(/\s+/g, " ").trim(), REASON_TEXT_LIMIT);
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Tool approval review aborted");
}

function thresholdForAllow(tier: ToolTier): number {
	return tier === "exec" ? ALLOW_EXEC_THRESHOLD : ALLOW_WRITE_THRESHOLD;
}

function decisionFor(
	choice: ToolApprovalReviewChoice,
	probability: number | undefined,
	confidence: number | undefined,
	tier: ToolTier,
): ToolApprovalReview["decision"] {
	if (choice === "ask_human") return "ask_human";
	if (probability === undefined || confidence === undefined) return "ask_human";
	const threshold = choice === "deny" ? DENY_THRESHOLD : thresholdForAllow(tier);
	return probability >= threshold && confidence >= threshold ? choice : "ask_human";
}

function stateFor(
	request: ToolApprovalReviewRequest,
	latestUserText: string | undefined,
	cwd: string,
	obfuscate?: (text: string) => string,
): Record<string, string> {
	const redact = (text: string): string => (obfuscate ? obfuscate(text) : text);
	return {
		latest_user_request: boundedText(latestUserText, STATE_TEXT_LIMIT, obfuscate),
		working_directory: boundedText(shortenPath(redact(cwd)), STATE_TEXT_LIMIT),
		tool_name: request.toolName,
		tier: request.tier,
		operation: boundedText(request.operation, OPERATION_TEXT_LIMIT, obfuscate),
	};
}

export class ToolApprovalAutomodeReviewer implements ToolApprovalReviewer {
	readonly #dependencies: ToolApprovalAutomodeDependencies;
	readonly #semaphore = new Semaphore(REVIEW_CONCURRENCY);

	constructor(dependencies: ToolApprovalAutomodeDependencies) {
		this.#dependencies = dependencies;
	}

	async review(request: ToolApprovalReviewRequest, signal?: AbortSignal): Promise<ToolApprovalReview> {
		const timeoutSignal = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
		const reviewSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		try {
			await this.#semaphore.acquire(reviewSignal);
			try {
				const { settings, registry } = this.#dependencies;
				const onUsage = journalJudgmentUsage(this.#dependencies.sessionManager, "tool-approval-automode");
				const judge = (this.#dependencies.createJudge ?? resolveJudge)({
					settings,
					registry,
					sessionModel: this.#dependencies.getModel(),
					sessionId: this.#dependencies.getSessionId?.() ?? this.#dependencies.sessionId,
					onUsage,
				});
				const obfuscate = this.#dependencies.obfuscateText;
				const result = await judge.judge(
					{
						state: stateFor(
							request,
							this.#dependencies.getLatestUserText(),
							this.#dependencies.getCwd(),
							obfuscate,
						),
						questions: AUTOMODE_QUESTIONS,
					},
					{ signal: reviewSignal },
				);
				const answer = result.answers.decision;
				if (answer.type !== "choice") {
					return { decision: "unavailable", model: result.model, reason: "invalid judgment answer type" };
				}
				if (typeof answer.choice !== "string" || !Object.hasOwn(AUTOMODE_QUESTION.criteria, answer.choice)) {
					return { decision: "unavailable", model: result.model, reason: "invalid judgment choice" };
				}
				const probability = finiteProbability(answer.probabilities[answer.choice]);
				const confidence = finiteProbability(answer.confidence);
				const decision = decisionFor(answer.choice, probability, confidence, request.tier);
				return {
					decision,
					...(decision === "ask_human" ? { recommendation: answer.choice } : {}),
					...(probability !== undefined ? { probability } : {}),
					...(confidence !== undefined ? { confidence } : {}),
					model: result.model,
				};
			} finally {
				this.#semaphore.release();
			}
		} catch (error) {
			if (signal?.aborted) throw abortError(signal);
			if (timeoutSignal.aborted) return { decision: "unavailable", reason: "review timed out" };
			return { decision: "unavailable", reason: boundedReason(error) };
		}
	}
}

export function formatToolApprovalReviewRecommendation(review: ToolApprovalReview): string | undefined {
	if (review.decision === "unavailable") {
		const reason = review.reason ? boundedReason(review.reason) : undefined;
		return `Automode review unavailable${reason ? `: ${reason}` : "."}`;
	}
	if (review.decision !== "ask_human" || review.recommendation === undefined) return undefined;
	const probability = review.probability === undefined ? "n/a" : review.probability.toFixed(2);
	const confidence = review.confidence === undefined ? "n/a" : review.confidence.toFixed(2);
	return `Automode recommendation: ${review.recommendation}; probability ${probability}; confidence ${confidence}.`;
}
