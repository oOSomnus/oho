/**
 * Tier-1 of the two-tier approval path: a non-blocking trajectory classifier.
 *
 * It answers one question — "can this run without waking the slow reviewer?" —
 * and its vocabulary is deliberately one-sided. A `pass` is a suggestion to
 * skip the blocking judge; anything else escalates. There is no path from this
 * module to a denial, because denial is the judge's and the user's call.
 */
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import type { ChoiceQuestion, Judge, JudgmentRequest, Model, NoulQuestion, ScoreQuestion } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { ChainJudge, resolveJudge, type JudgeDeps } from "../../judgment";
import { LayaLane, LayaLaneDroppedError } from "../../judgment/laya-lane";
import fastGatePrompt from "../../prompts/system/tool-approval-fastgate.md" with { type: "text" };
import type { TrajectoryCall } from "./types";
import { buildFastGateState, FAST_GATE_STATE_TOKEN_BUDGET, type FastGateStateInput } from "./trajectory";
import { formatTrajectoryLine } from "./text";
import { AutomodeScoreLedger } from "./score-cache";
import {
	AUTHORIZATION_LEVELS,
	RISK_LEVELS,
	type AuthorizationLevel,
	type FastGateClassification,
	type FastGateHandoffReason,
	type FastGateVerdict,
	type RiskLevel,
	type RiskScore,
} from "./types";

/** Answers keyed to the three axes of the classification. */
const FAST_GATE_QUESTIONS = {
	risk: {
		type: "score",
		instructions: `${fastGatePrompt}\n\nHow much damage could this single operation do, judged with the trajectory around it?`,
		criteria: [
			"routine inspection or task-scoped local edits, no effect outside the workspace",
			"local changes that are broad or hard to undo: many files, build state, tool configuration",
			"destructive local changes, or any external side effect such as pushing, publishing, deploying, messaging",
			"irreversible or wide-reaching harm: data loss beyond the task, secret exposure, compromised credentials or infrastructure",
		],
	} satisfies ScoreQuestion,
	authorization: {
		type: "choice",
		instructions: `${fastGatePrompt}\n\nHow well does latest_user_request authorize this specific operation?`,
		criteria: {
			high: "the user asked for this operation, or clearly for the work that directly entails it",
			medium: "it follows from the user's request, but the target or scope was left to the agent",
			low: "the user asked for something else, set constraints this conflicts with, or has not asked for this work",
			unknown: "there is no usable user request, or it says nothing about this operation",
		},
	} satisfies ChoiceQuestion<AuthorizationLevel>,
	predictive_danger: {
		type: "noul",
		instructions: `${fastGatePrompt}\n\nWill the next two tool calls in this trajectory include a high or critical impact action?`,
		criteria: {
			true: "the trajectory is heading toward a high or critical impact action",
			false: "the trajectory stays within its current impact level",
		},
	} satisfies NoulQuestion,
} as const;

export interface FastGateOptions {
	/** P(risk >= high) above which the gate refuses to pass. */
	riskThreshold?: number;
	/** Classification confidence below which the distribution is not trusted. */
	confidenceFloor?: number;
	/** P(true) on the predictive question above which the gate escalates. */
	predictiveDangerThreshold?: number;
	/** Fires between the newest score and the call being reviewed. */
	maxLag?: number;
	/** Wall clock for one fire, including queue wait. */
	fireTimeoutMs?: number;
	/** Token budget for the classification state; see `FAST_GATE_STATE_TOKEN_BUDGET`. */
	stateBudgetTokens?: number;
	/** Classifications kept for the weak-authorization window. */
	windowSize?: number;
	/** Weak samples inside the window that force escalation. */
	weakAuthorizationLimit?: number;
}

export interface FastGateDependencies {
	settings: Settings;
	registry: ModelRegistry;
	getModel: () => Model | undefined;
	getCwd: () => string;
	getConversationContext: () => {
		latestUserText: string | undefined;
		recentMessages: string | undefined;
	};
	getRecentCalls: () => TrajectoryCall[];
	obfuscateText?: (text: string) => string;
	createJudge?: (deps: JudgeDeps) => Judge;
	createLane?: () => LayaLane;
}

export interface FastGateFireInput {
	toolCallId: string;
	toolName: string;
	tier: ToolTier;
	args?: { command?: string; path?: string };
	intent?: string;
}

const DEFAULTS = {
	riskThreshold: 0.25,
	confidenceFloor: 0.55,
	predictiveDangerThreshold: 0.45,
	maxLag: 2,
	fireTimeoutMs: 4_000,
	stateBudgetTokens: FAST_GATE_STATE_TOKEN_BUDGET,
	windowSize: 8,
	weakAuthorizationLimit: 3,
} as const;

/** Authorization levels that cannot carry a pass on their own. */
const PASSABLE_AUTHORIZATION: ReadonlySet<AuthorizationLevel> = new Set(["high", "medium"]);

interface FireRecord {
	seq: number;
	startedAt: number;
	/** How the fire settled; drives the handoff reason when nothing was cached. */
	outcome?: "scored" | "oversized" | "dropped" | "failed";
}

export class FastGate {
	readonly ledger: AutomodeScoreLedger;
	readonly #dependencies: FastGateDependencies;
	readonly #lane: LayaLane;
	readonly #options: Required<FastGateOptions>;
	readonly #fires = new Map<string, FireRecord>();
	readonly #inflight = new Set<Promise<void>>();
	#scoringFailures = 0;

	constructor(dependencies: FastGateDependencies, options: FastGateOptions = {}) {
		this.#dependencies = dependencies;
		this.#options = { ...DEFAULTS, ...options };
		this.ledger = new AutomodeScoreLedger({
			windowSize: this.#options.windowSize,
			weakAuthorizationLimit: this.#options.weakAuthorizationLimit,
		});
		this.#lane =
			dependencies.createLane?.() ??
			new LayaLane({ timeoutMs: this.#options.fireTimeoutMs, concurrency: 1, queueLimit: 4 });
	}

	/** Sequences already fired, for the idempotent fallback path. */
	hasFired(toolCallId: string): boolean {
		return this.#fires.has(toolCallId);
	}

	/**
	 * Kick off a classification for one tool call. Returns immediately; the
	 * answer lands in the ledger whenever it lands. Calling twice for the same
	 * `toolCallId` is a no-op — the first fire owns the sample.
	 */
	fire(input: FastGateFireInput): void {
		if (this.#fires.has(input.toolCallId)) return;
		const seq = this.ledger.nextSeq();
		this.#fires.set(input.toolCallId, { seq, startedAt: performance.now() });
		const scoring = this.#score(input, seq).finally(() => this.#inflight.delete(scoring));
		this.#inflight.add(scoring);
	}

	/**
	 * Resolve once every in-flight classification has settled. Nothing in the
	 * hot path waits on this; it exists for shutdown and for tests that need to
	 * observe a publication.
	 */
	async drain(): Promise<void> {
		while (this.#inflight.size > 0) {
			await Promise.allSettled(this.#inflight);
		}
	}

	/**
	 * Decide whether the cached classification is good enough to skip the
	 * blocking judge. Every doubt escalates; only a clean, fresh, confident
	 * sample passes.
	 */
	evaluate(toolCallId: string): FastGateVerdict {
		const cached = this.ledger.latest();
		if (!cached) return this.#escalate(this.#reasonWithoutScore(toolCallId));
		if (cached.hasUnscoredFailure) return this.#escalate("scoring-failure", cached.classification);
		if (cached.lag > this.#options.maxLag) return this.#escalate("stale", cached.classification);

		const { risk, authorization, predictiveDanger } = cached.classification;
		// The weaker axis governs: a sharp risk read does not rescue a vague
		// authorization read, or the other way around.
		const confidence = Math.min(risk.confidence, authorization.confidence);
		if (confidence < this.#options.confidenceFloor) return this.#escalate("low-confidence", cached.classification);
		if (risk.level !== "low") return this.#escalate("risk-threshold", cached.classification);
		if (risk.tailHigh > this.#options.riskThreshold) return this.#escalate("risk-threshold", cached.classification);
		if (!PASSABLE_AUTHORIZATION.has(authorization.level))
			return this.#escalate("authorization-weak", cached.classification);
		if (this.ledger.weakAuthorizationWindow()) return this.#escalate("authorization-weak", cached.classification);
		if (predictiveDanger > this.#options.predictiveDangerThreshold) {
			return this.#escalate("predictive-danger", cached.classification);
		}

		return {
			kind: "pass",
			handoff: "pass",
			classification: cached.classification,
		};
	}

	/** Consecutive scoring failures; the reviewer uses this to skip the gate entirely. */
	get scoringFailures(): number {
		return this.#scoringFailures;
	}

	#escalate(handoff: FastGateHandoffReason, classification?: FastGateClassification): FastGateVerdict {
		return { kind: "escalate", handoff, classification };
	}

	/**
	 * Nothing is cached, so the reason comes from why this call's own fire
	 * settled — or from the fact that it never fired at all.
	 */
	#reasonWithoutScore(toolCallId: string): FastGateHandoffReason {
		const fire = this.#fires.get(toolCallId);
		if (!fire) return "missing-score";
		switch (fire.outcome) {
			case "oversized":
				return "oversized";
			case "dropped":
				return "unavailable";
			default:
				return fire.outcome === "scored" ? "stale" : "scoring-failure";
		}
	}

	async #score(input: FastGateFireInput, seq: number): Promise<void> {
		const fire = this.#fires.get(input.toolCallId);
		const settle = (outcome: FireRecord["outcome"]) => {
			if (fire) fire.outcome = outcome;
		};

		const built = this.#buildState(input);
		// A state that lost its operation or its trajectory is not a smaller
		// sample, it is a question the classifier cannot answer.
		if (!built.classifiable) {
			settle("oversized");
			this.ledger.recordOversized(seq);
			return;
		}

		try {
			const result = await this.#lane.submit(async signal => {
				const judge = this.#createJudge();
				if (judge instanceof ChainJudge) {
					return judge.withCandidate(candidate => candidate.judge(built.request, { signal }), { signal });
				}
				return judge.judge(built.request, { signal });
			});
			const classification = this.#toClassification(input, seq, result, built.truncated);
			if (!classification) {
				settle("failed");
				this.ledger.recordFailure(seq, "unavailable");
				this.#scoringFailures += 1;
				return;
			}
			settle("scored");
			this.ledger.publish(classification);
			this.#scoringFailures = 0;
		} catch (error) {
			this.#scoringFailures += 1;
			if (error instanceof LayaLaneDroppedError) {
				settle("dropped");
				this.ledger.recordFailure(seq, "unavailable");
			} else {
				settle("failed");
				this.ledger.recordFailure(seq, "scoring-failure");
			}
		}
	}

	#createJudge(): Judge {
		const { settings, registry } = this.#dependencies;
		return (this.#dependencies.createJudge ?? resolveJudge)({
			settings,
			registry,
			sessionModel: this.#dependencies.getModel(),
			onUsage: undefined,
		});
	}

	#buildState(input: FastGateFireInput): {
		request: JudgmentRequest<typeof FAST_GATE_QUESTIONS>;
		truncated: boolean;
		classifiable: boolean;
	} {
		const context = this.#dependencies.getConversationContext();
		const stateInput: FastGateStateInput = {
			toolName: input.toolName,
			tier: input.tier,
			operation: formatTrajectoryLine(input),
			intent: input.intent,
			recentCalls: this.#dependencies.getRecentCalls(),
			latestUserText: context.latestUserText,
			recentMessages: context.recentMessages,
			cwd: this.#dependencies.getCwd(),
			obfuscate: this.#dependencies.obfuscateText,
		};
		const built = buildFastGateState(stateInput, { budgetTokens: this.#options.stateBudgetTokens });
		return {
			request: { state: { ...built.state }, questions: FAST_GATE_QUESTIONS },
			truncated: built.truncated,
			classifiable: built.classifiable,
		};
	}

	#toClassification(
		input: FastGateFireInput,
		seq: number,
		result: unknown,
		truncated: boolean,
	): FastGateClassification | undefined {
		const answers = readAnswers(result);
		if (!answers) return undefined;

		const risk = readScore(answers.risk, RISK_LEVELS);
		const authorization = readChoice(answers.authorization, AUTHORIZATION_LEVELS);
		const predictive = readNoul(answers.predictive_danger);
		if (!risk || !authorization || predictive === undefined) return undefined;

		return {
			toolCallId: input.toolCallId,
			seq,
			risk,
			authorization,
			predictiveDanger: predictive,
			model: readModel(result),
			scoredAt: performance.now(),
			truncated,
		};
	}
}

function readAnswers(result: unknown): Record<string, unknown> | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	const answers = (result as { answers?: unknown }).answers;
	if (typeof answers !== "object" || answers === null) return undefined;
	return answers as Record<string, unknown>;
}

function readModel(result: unknown): string {
	if (typeof result !== "object" || result === null) return "laya";
	const model = (result as { model?: unknown }).model;
	return typeof model === "string" ? model : "laya";
}

function readScore(value: unknown, levels: readonly string[]): RiskScore | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const answer = value as { type?: unknown; score?: unknown; probabilities?: unknown; confidence?: unknown };
	if (answer.type !== "score") return undefined;
	const score = answer.score;
	const confidence = answer.confidence;
	if (typeof score !== "number" || !Number.isFinite(score)) return undefined;
	const probabilities = readProbabilities(answer.probabilities);
	if (!probabilities) return undefined;

	// Clamp the expected index onto the level ladder: the distribution is what
	// carries the signal, and a rounding artifact must not pick the level.
	const index = Math.min(levels.length - 1, Math.max(0, Math.round(score)));
	// `tailHigh` is the mass at or above "high" — the second-highest level up.
	const firstHighIndex = Math.max(0, levels.length - 2);
	let tailHigh = 0;
	for (let level = firstHighIndex; level < levels.length; level += 1) {
		tailHigh += probabilities[String(level)] ?? 0;
	}
	return {
		level: levels[index] as RiskLevel,
		expected: score,
		tailHigh,
		probabilities,
		confidence: typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0,
	};
}

function readChoice(
	value: unknown,
	levels: readonly AuthorizationLevel[],
): FastGateClassification["authorization"] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const answer = value as { type?: unknown; choice?: unknown; probabilities?: unknown; confidence?: unknown };
	if (answer.type !== "choice") return undefined;
	const choice = answer.choice;
	if (typeof choice !== "string" || !levels.includes(choice as AuthorizationLevel)) return undefined;
	const probabilities = readProbabilities(answer.probabilities);
	if (!probabilities) return undefined;
	const confidence = answer.confidence;
	return {
		level: choice as AuthorizationLevel,
		probabilities: probabilities as Record<AuthorizationLevel, number>,
		confidence: typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0,
	};
}

function readNoul(value: unknown): number | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const answer = value as { type?: unknown; noul?: unknown };
	if (answer.type !== "noul") return undefined;
	const noul = answer.noul;
	if (typeof noul !== "number" || !Number.isFinite(noul)) return undefined;
	return Math.min(1, Math.max(0, noul));
}

function readProbabilities(value: unknown): Record<string, number> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const probabilities: Record<string, number> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry !== "number" || !Number.isFinite(entry)) return undefined;
		probabilities[key] = entry;
	}
	return probabilities;
}
