/**
 * Pure types for the two-tier automode approval pipeline.
 *
 * Tier-1 (`fast-gate`) is a non-blocking Laya classification over the recent
 * tool trajectory; it may allow or escalate but never denies. Tier-2 is the
 * existing blocking judge, and the human prompt remains the final fallback.
 *
 * The dual-axis shape mirrors codex's `GuardianAssessment` (`risk_level` x
 * `user_authorization`); `FastGateHandoffReason` mirrors its
 * `GuardianReviewReason` so the escalation cause stays distinguishable.
 */
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import type { ToolExecutionStartData } from "../../session/exit-diagnostics";

/** codex `GuardianAssessment.risk_level`. */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * codex `GuardianAssessment.user_authorization`.
 * `unknown` is "authorization never established", not an ordered low tier.
 */
export type AuthorizationLevel = "high" | "medium" | "low" | "unknown";

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export const AUTHORIZATION_LEVELS = ["high", "medium", "low", "unknown"] as const;

/**
 * One recent tool call, as projected from `tool_execution_start`.
 * Aliased rather than restated so the trajectory stays a pure view of the
 * markers already persisted in the session.
 */
export type TrajectoryCall = ToolExecutionStartData;

/**
 * Tier-1 review state, keyed for the judgment wire format.
 * Fields are untrusted evidence; see `tool-approval-fastgate.md`.
 */
export interface FastGateState {
	latest_user_request: string;
	operation: string;
	current_intent: string;
	recent_tool_calls: string;
	recent_conversation: string;
	working_directory: string;
	tool_name: string;
	tier: ToolTier;
}

export interface RiskScore {
	level: RiskLevel;
	/** Probability-weighted level index from a `score` answer; may land between levels. */
	expected: number;
	/** P(risk >= high) = p(high) + p(critical). */
	tailHigh: number;
	/** Level index as a string key, matching `ScoreAnswer.probabilities`. */
	probabilities: Record<string, number>;
	confidence: number;
}

export interface AuthorizationScore {
	level: AuthorizationLevel;
	probabilities: Record<AuthorizationLevel, number>;
	confidence: number;
}

/** One fast-gate sample (the classification half of codex `CachedScore`). */
export interface FastGateClassification {
	toolCallId: string;
	/** Monotonic sequence assigned at fire time; orders publications. */
	seq: number;
	risk: RiskScore;
	authorization: AuthorizationScore;
	/** P(true) that the next two steps will include a high/critical action. */
	predictiveDanger: number;
	model: string;
	scoredAt: number;
	/** True when the trajectory state was trimmed to fit the model budget. */
	truncated: boolean;
}

/**
 * A published sample plus its coverage facts (codex `CachedScore`).
 * Oversized inputs never reach a sample: they land in `ScoreCoverage` instead.
 */
export interface CachedScore {
	classification: FastGateClassification;
	/** `latestToolCallSeq - latestScoredSeq`. */
	lag: number;
	/** A fire failed or timed out and no newer success has covered it. */
	hasUnscoredFailure: boolean;
}

/** Coverage accounting (codex `ScoreState`). */
export interface ScoreCoverage {
	latestToolCallSeq: number;
	latestScoredSeq: number;
	latestFailedSeq: number;
	/** Fires whose input exceeded the model budget and were never classified. */
	oversizedToolCalls: number;
}

/** Why the fast gate handed off (codex `GuardianReviewReason`). */
export type FastGateHandoffReason =
	| "pass"
	| "missing-score"
	| "scoring-failure"
	| "timeout"
	| "fresh-required"
	| "oversized"
	| "stale"
	| "low-confidence"
	| "risk-threshold"
	| "authorization-weak"
	| "predictive-danger"
	| "disabled"
	| "unavailable";

/** Who resolved the approval (codex `ApprovalDecisionActor`). */
export type ApprovalActor = "fast-gate" | "judge" | "user" | "policy";

export interface FastGateVerdict {
	/** `pass` allows immediately; `escalate` routes to the blocking judge. */
	kind: "pass" | "escalate";
	handoff: FastGateHandoffReason;
	classification?: FastGateClassification;
}

/** Dual-axis summary carried on a review result for the audit notice. */
export interface ApprovalClassificationSummary {
	risk: RiskLevel;
	authorization: AuthorizationLevel;
}

/**
 * Audit projection of a review result, threaded from the reviewer seam to the
 * transcript-only `tool-approval-notice` row. All fields optional so the legacy
 * single-tier reviewer stays a valid contributor.
 */
export interface ApprovalReviewMeta {
	actor?: ApprovalActor;
	handoff?: FastGateHandoffReason;
	classification?: ApprovalClassificationSummary;
}
