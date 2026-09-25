/**
 * Trajectory-level review state for the Tier-1 fast gate.
 *
 * The classifier sees the recent tool-call sequence plus the current intent
 * rather than one call in isolation, so drift across a turn shows up as a
 * rising score instead of a series of individually-benign verdicts. Everything
 * here is pure: given the same inputs it renders the same state, which is what
 * makes the calibration tests meaningful.
 */
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import { boundedText, formatTrajectoryLine } from "./text";
import type { FastGateState, TrajectoryCall } from "./types";

/**
 * Laya's context window is 1024 tokens and `laya-server.py` does not truncate
 * on the way in, so the state has to fit before it is ever sent. The three
 * question rubrics ride along in the same input and cost a few hundred tokens
 * of that window, which is what this budget leaves out.
 */
export const FAST_GATE_STATE_TOKEN_BUDGET = 560;

/** Most recent calls rendered into the trajectory; older ones are noise. */
export const TRAJECTORY_CALLS_LIMIT = 12;

const CURRENT_INTENT_TEXT_LIMIT = 1_200;
const TRAJECTORY_LINE_TEXT_LIMIT = 400;

/**
 * Structural view of `Tokenizer.checkTokenBudget`, so the trim loop is testable
 * without the native encoder.
 */
export interface TokenCounter {
	checkTokenBudget(text: string | string[], budget: number): { fits: boolean; tokens: number };
}

export interface FastGateStateInput {
	toolName: string;
	tier: ToolTier;
	operation: string;
	intent?: string;
	recentCalls: readonly TrajectoryCall[];
	latestUserText: string | undefined;
	recentMessages: string | undefined;
	cwd: string;
	obfuscate?: (text: string) => string;
}

export interface BuiltFastGateState {
	state: FastGateState;
	/** True when any trim stage fired; the sample is reduced but may still be usable. */
	truncated: boolean;
	/**
	 * False when trimming ate fields the classifier cannot work without — the
	 * operation being approved, or the trajectory it is being judged against.
	 * Such a state is never sent; the caller escalates as `oversized`.
	 */
	classifiable: boolean;
}

/** Fields whose loss makes the state useless to the classifier. */
const LOAD_BEARING_FIELDS = ["operation", "recent_tool_calls"] as const;

export interface BuildFastGateStateOptions {
	budgetTokens?: number;
	counter?: TokenCounter;
}

const defaultCounter = new Tokenizer();

function stateText(state: FastGateState): string {
	return [
		state.latest_user_request,
		state.operation,
		state.current_intent,
		state.recent_tool_calls,
		state.recent_conversation,
		state.working_directory,
		state.tool_name,
		state.tier,
	].join("\n");
}

/**
 * A trim stage returns true when it changed the draft. Stages run in order and
 * stop as soon as the state fits, so a state that only barely overflows keeps
 * everything but the least load-bearing field.
 */
type TrimStage = (draft: Draft) => boolean;

interface Draft {
	state: FastGateState;
	truncated: boolean;
	droppedFields: string[];
}

const TRIM_STAGES: readonly TrimStage[] = [
	// Conversation recap is the largest field and the easiest to reconstruct.
	draft => clearField(draft, "recent_conversation"),
	// The request text matters, but the trajectory already encodes what the
	// turn has been doing.
	draft => clearField(draft, "latest_user_request"),
	// Oldest call first: recency is what the classifier keys on.
	draft => dropOldestCall(draft),
	draft => clearField(draft, "current_intent"),
	draft => clearField(draft, "operation"),
];

function clearField(
	draft: Draft,
	key: "recent_conversation" | "latest_user_request" | "current_intent" | "operation",
): boolean {
	if (draft.state[key] === "(none)") return false;
	draft.state[key] = "(none)";
	draft.truncated = true;
	draft.droppedFields.push(key);
	return true;
}

function dropOldestCall(draft: Draft): boolean {
	const lines = draft.state.recent_tool_calls;
	if (lines === "(none)") return false;
	const remaining = lines.split("\n").slice(1);
	draft.state.recent_tool_calls = remaining.join("\n");
	draft.truncated = true;
	// Only the last line going counts as losing the trajectory; shedding a
	// stale prefix is what the drop order is for.
	if (remaining.length === 0) {
		draft.state.recent_tool_calls = "(none)";
		draft.droppedFields.push("recent_tool_calls");
	}
	return true;
}

/**
 * Build the Tier-1 state, trimming in the documented drop order until the
 * whole thing fits `budgetTokens`. A state that could not fit even after every
 * stage still reports `truncated`, which the gate treats as `oversized` and
 * escalates — the trim never silently buys a pass.
 */
export function buildFastGateState(
	input: FastGateStateInput,
	options: BuildFastGateStateOptions = {},
): BuiltFastGateState {
	const budget = options.budgetTokens ?? FAST_GATE_STATE_TOKEN_BUDGET;
	const counter = options.counter ?? defaultCounter;
	const obfuscate = input.obfuscate;

	const calls = input.recentCalls.slice(-TRAJECTORY_CALLS_LIMIT);
	const recentToolCalls =
		calls.length === 0
			? "(none)"
			: calls.map(call => boundedText(formatTrajectoryLine(call), TRAJECTORY_LINE_TEXT_LIMIT, obfuscate)).join("\n");

	const draft: Draft = {
		state: {
			latest_user_request: boundedText(input.latestUserText, 4_000, obfuscate),
			operation: boundedText(input.operation, 2_000, obfuscate),
			current_intent: boundedText(input.intent, CURRENT_INTENT_TEXT_LIMIT, obfuscate),
			recent_tool_calls: recentToolCalls,
			recent_conversation: boundedText(input.recentMessages, 6_000, obfuscate),
			working_directory: boundedText(input.cwd, 512, obfuscate),
			tool_name: input.toolName,
			tier: input.tier,
		},
		truncated: false,
		droppedFields: [],
	};

	if (counter.checkTokenBudget(stateText(draft.state), budget).fits) {
		return { state: draft.state, truncated: false, classifiable: true };
	}

	// Re-walk the stages from the top after each change: the earlier stages are
	// the cheaper loss, so they get every chance before a later one fires.
	while (!counter.checkTokenBudget(stateText(draft.state), budget).fits) {
		const changed = TRIM_STAGES.some(stage => stage(draft));
		if (!changed) break;
	}

	const classifiable = !LOAD_BEARING_FIELDS.some(field => draft.droppedFields.includes(field));
	return { state: draft.state, truncated: draft.truncated, classifiable };
}
