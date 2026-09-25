import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import type { ChoiceQuestion, Judge, Model } from "@oh-my-pi/pi-ai";
import { replaceTabs, shortenPath, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
	ChainJudge,
	journalJudgmentUsage,
	resolveJudge,
	type JudgeDeps,
	type JudgeKind,
	type JudgmentUsageLedger,
} from "../judgment";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import toolApprovalAutomodePrompt from "../prompts/system/tool-approval-automode.md" with { type: "text" };
import { Semaphore } from "../task/parallel";
import { truncateForPrompt } from "./approval";
import { layaJudgeClient } from "../judgment/laya-client";

export type ToolApprovalReviewChoice = "allow" | "deny";

export interface ToolApprovalReviewRequest {
	toolCallId: string;
	toolName: string;
	tier: ToolTier;
	operation: string;
}

export interface ToolApprovalReview {
	decision: ToolApprovalReviewChoice | "unavailable";
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
	getConversationContext: () => {
		latestUserText: string | undefined;
		recentMessages: string | undefined;
	};
	obfuscateText?: (text: string) => string;
	createJudge?: (deps: JudgeDeps) => Judge;
}

// The queue is bounded at 30s; Laya startup is excluded from the active review budget.
const REVIEW_TIMEOUT_MS = 30_000;
const REVIEW_CONCURRENCY = 2;
const STATE_TEXT_LIMIT = 4_000;
const OPERATION_TEXT_LIMIT = 2_000;
const RECENT_CONVERSATION_TEXT_LIMIT = 6_000;
const REASON_TEXT_LIMIT = 320;

const AUTOMODE_QUESTION: ChoiceQuestion<ToolApprovalReviewChoice> = {
	type: "choice",
	instructions: toolApprovalAutomodePrompt,
	criteria: {
		allow: null,
		deny: null,
	},
};

const AUTOMODE_QUESTIONS = { decision: AUTOMODE_QUESTION };

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

function reviewTimeoutError(): Error {
	const error = new Error("review timed out");
	error.name = "TimeoutError";
	return error;
}
function stateFor(
	request: ToolApprovalReviewRequest,
	latestUserText: string | undefined,
	recentMessages: string | undefined,
	cwd: string,
	obfuscate?: (text: string) => string,
): Record<string, string> {
	const redact = (text: string): string => (obfuscate ? obfuscate(text) : text);
	return {
		latest_user_request: boundedText(latestUserText, STATE_TEXT_LIMIT, obfuscate),
		recent_conversation: boundedText(recentMessages, RECENT_CONVERSATION_TEXT_LIMIT, obfuscate),
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
		const reviewStartedAt = performance.now();
		let deadlineStartedAt = reviewStartedAt;
		const queueTimeoutSignal = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
		const queueSignal = signal ? AbortSignal.any([signal, queueTimeoutSignal]) : queueTimeoutSignal;
		let deadlineStarted = false;
		let excludedLayaStartupMs = 0;
		let deadlineExceeded = false;
		let acquired = false;
		try {
			try {
				await this.#semaphore.acquire(queueSignal);
				acquired = true;
			} catch (error) {
				if (signal?.aborted) throw abortError(signal);
				if (queueTimeoutSignal.aborted) deadlineExceeded = true;
				throw error;
			}

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
			const conversationContext = this.#dependencies.getConversationContext();
			const judgmentRequest = {
				state: stateFor(
					request,
					conversationContext.latestUserText,
					conversationContext.recentMessages,
					this.#dependencies.getCwd(),
					obfuscate,
				),
				questions: AUTOMODE_QUESTIONS,
			};
			const reviewCandidate = async (candidate: Judge, kind?: JudgeKind) => {
				if (kind === "laya") {
					const startupStartedAt = performance.now();
					const deadlineWasStarted = deadlineStarted;
					try {
						await layaJudgeClient.waitUntilReady(signal);
					} finally {
						if (deadlineWasStarted) {
							excludedLayaStartupMs += performance.now() - startupStartedAt;
						} else {
							deadlineStartedAt = performance.now();
							deadlineStarted = true;
						}
					}
				}

				if (signal?.aborted) throw abortError(signal);
				deadlineStarted = true;
				const remainingMs = REVIEW_TIMEOUT_MS - (performance.now() - deadlineStartedAt - excludedLayaStartupMs);
				if (remainingMs <= 0) {
					deadlineExceeded = true;
					throw reviewTimeoutError();
				}

				const timeoutSignal = AbortSignal.timeout(remainingMs);
				const candidateSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
				try {
					const result = await candidate.judge(judgmentRequest, { signal: candidateSignal });
					if (signal?.aborted) throw abortError(signal);
					if (timeoutSignal.aborted) {
						deadlineExceeded = true;
						throw timeoutSignal.reason;
					}
					return result;
				} catch (error) {
					if (timeoutSignal.aborted && !signal?.aborted) deadlineExceeded = true;
					throw error;
				}
			};
			const result =
				judge instanceof ChainJudge
					? await judge.withCandidate(reviewCandidate, { signal })
					: await reviewCandidate(judge);
			const answer = result.answers.decision;
			if (answer.type !== "choice") {
				return { decision: "unavailable", model: result.model, reason: "invalid judgment answer type" };
			}
			if (typeof answer.choice !== "string" || !Object.hasOwn(AUTOMODE_QUESTION.criteria, answer.choice)) {
				return { decision: "unavailable", model: result.model, reason: "invalid judgment choice" };
			}
			return {
				decision: answer.choice,
				model: result.model,
			};
		} catch (error) {
			if (signal?.aborted) throw abortError(signal);
			if (deadlineExceeded) return { decision: "unavailable", reason: "review timed out" };
			return { decision: "unavailable", reason: boundedReason(error) };
		} finally {
			if (acquired) this.#semaphore.release();
		}
	}
}

export function formatToolApprovalReviewUnavailable(review: ToolApprovalReview): string | undefined {
	if (review.decision !== "unavailable") return undefined;
	const reason = review.reason ? boundedReason(review.reason) : undefined;
	return `Automode review unavailable${reason ? `: ${reason}` : "."}`;
}
