import { describe, expect, it } from "bun:test";
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import {
	buildFastGateState,
	FAST_GATE_STATE_TOKEN_BUDGET,
	type FastGateStateInput,
	type TokenCounter,
	TRAJECTORY_CALLS_LIMIT,
} from "../../src/tools/automode/trajectory";
import type { TrajectoryCall } from "../../src/tools/automode/types";

const TIER: ToolTier = "exec";

/**
 * Character-based stand-in for the native tokenizer. Trajectory tests care
 * about the trim order, not about token arithmetic.
 */
function charCounter(): TokenCounter {
	return {
		checkTokenBudget(text, budget) {
			const length = Array.isArray(text) ? text.join("").length : text.length;
			return { fits: length <= budget, tokens: length };
		},
	};
}

function call(index: number, overrides: Partial<TrajectoryCall> = {}): TrajectoryCall {
	return {
		toolCallId: `call-${index}`,
		toolName: "bash",
		args: { command: `echo ${index}` },
		startedAt: `2026-09-25T00:00:${String(index).padStart(2, "0")}.000Z`,
		...overrides,
	};
}

function input(overrides: Partial<FastGateStateInput> = {}): FastGateStateInput {
	return {
		toolName: "bash",
		tier: TIER,
		operation: "rm -rf ./build",
		intent: "clear the build output before rebuilding",
		recentCalls: [call(1), call(2)],
		latestUserText: "please rebuild the project",
		recentMessages: "user: rebuild\nassistant: on it",
		cwd: "/home/oosomnus/workspace/oho",
		...overrides,
	};
}

describe("buildFastGateState", () => {
	it("renders every field and reports no truncation when the state fits", () => {
		const built = buildFastGateState(input(), { counter: charCounter() });

		expect(built.truncated).toBe(false);
		expect(built.state.tool_name).toBe("bash");
		expect(built.state.tier).toBe("exec");
		expect(built.state.operation).toBe("rm -rf ./build");
		expect(built.state.current_intent).toBe("clear the build output before rebuilding");
		expect(built.state.latest_user_request).toBe("please rebuild the project");
		expect(built.state.working_directory).toBe("/home/oosomnus/workspace/oho");
		expect(built.state.recent_tool_calls).toBe("bash `echo 1`\nbash `echo 2`");
	});

	it("keeps the current call out of the trajectory and carries its intent separately", () => {
		const built = buildFastGateState(input({ recentCalls: [call(1)], intent: "wipe the tree" }), {
			counter: charCounter(),
		});

		expect(built.state.current_intent).toBe("wipe the tree");
		expect(built.state.recent_tool_calls).toBe("bash `echo 1`");
	});

	it("renders `(none)` rather than an empty field", () => {
		const built = buildFastGateState(
			input({
				recentCalls: [],
				intent: undefined,
				latestUserText: undefined,
				recentMessages: undefined,
				operation: "",
			}),
			{ counter: charCounter() },
		);

		expect(built.state.recent_tool_calls).toBe("(none)");
		expect(built.state.current_intent).toBe("(none)");
		expect(built.state.latest_user_request).toBe("(none)");
		expect(built.state.recent_conversation).toBe("(none)");
		expect(built.state.operation).toBe("(none)");
	});

	it("caps the trajectory at TRAJECTORY_CALLS_LIMIT and keeps the most recent calls", () => {
		const calls = Array.from({ length: TRAJECTORY_CALLS_LIMIT + 5 }, (_, index) => call(index));
		const built = buildFastGateState(input({ recentCalls: calls }), { counter: charCounter() });

		const lines = built.state.recent_tool_calls.split("\n");
		expect(lines).toHaveLength(TRAJECTORY_CALLS_LIMIT);
		expect(lines.at(0)).toContain("echo 5");
		expect(lines.at(-1)).toContain(`echo ${TRAJECTORY_CALLS_LIMIT + 4}`);
	});

	it("drops the conversation recap before anything else when the budget is tight", () => {
		const built = buildFastGateState(input({ recentMessages: "x".repeat(400) }), {
			counter: charCounter(),
			budgetTokens: 400,
		});

		expect(built.truncated).toBe(true);
		expect(built.state.recent_conversation).toBe("(none)");
		expect(built.state.latest_user_request).toBe("please rebuild the project");
		expect(built.state.operation).toBe("rm -rf ./build");
	});

	it("drops the user request next, before touching the trajectory", () => {
		const built = buildFastGateState(input({ latestUserText: "y".repeat(300), recentMessages: "x".repeat(300) }), {
			counter: charCounter(),
			budgetTokens: 380,
		});

		expect(built.state.recent_conversation).toBe("(none)");
		expect(built.state.latest_user_request).toBe("(none)");
		expect(built.state.recent_tool_calls).toBe("bash `echo 1`\nbash `echo 2`");
		expect(built.state.operation).toBe("rm -rf ./build");
	});

	it("drops the oldest trajectory call before the current intent", () => {
		const calls = [call(1), call(2), call(3)];
		const built = buildFastGateState(input({ recentCalls: calls }), {
			counter: charCounter(),
			budgetTokens: 145,
		});

		expect(built.state.current_intent).toBe("clear the build output before rebuilding");
		expect(built.state.recent_tool_calls).not.toContain("echo 1");
		expect(built.state.recent_tool_calls).toContain("echo 3");
	});

	it("still reports truncation when nothing fits, so the gate escalates", () => {
		const built = buildFastGateState(input({ operation: "z".repeat(500) }), {
			counter: charCounter(),
			budgetTokens: 1,
		});

		expect(built.truncated).toBe(true);
		expect(built.state.recent_conversation).toBe("(none)");
		expect(built.state.latest_user_request).toBe("(none)");
		expect(built.state.recent_tool_calls).toBe("(none)");
		expect(built.state.current_intent).toBe("(none)");
		expect(built.state.operation).toBe("(none)");
		expect(built.state.tool_name).toBe("bash");
	});

	it("defaults to the Laya-fitting budget", () => {
		expect(FAST_GATE_STATE_TOKEN_BUDGET).toBeLessThan(1024);

		const built = buildFastGateState(input(), { counter: charCounter() });
		expect(built.truncated).toBe(false);
	});

	it("passes untrusted text through the obfuscator", () => {
		const built = buildFastGateState(
			input({
				latestUserText: "read /home/oosomnus/secret",
				operation: "cat /home/oosomnus/secret",
				obfuscate: text => text.replaceAll("/home/oosomnus", "/home/xxx"),
			}),
			{ counter: charCounter() },
		);

		expect(built.state.latest_user_request).toBe("read /home/xxx/secret");
		expect(built.state.operation).toBe("cat /home/xxx/secret");
	});
});
