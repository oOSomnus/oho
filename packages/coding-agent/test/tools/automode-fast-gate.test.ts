import { describe, expect, it } from "bun:test";
import type {
	ChoiceAnswer,
	Judge,
	JudgeOptions,
	JudgmentRequest,
	JudgmentResult,
	NoulAnswer,
	Questions,
	ScoreAnswer,
} from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import { LayaLane } from "../../src/judgment/laya-lane";
import { FastGate, type FastGateDependencies, type FastGateFireInput } from "../../src/tools/automode/fast-gate";
import type { TrajectoryCall } from "../../src/tools/automode/types";

interface Axes {
	risk?: number;
	authorization?: "high" | "medium" | "low" | "unknown";
	predictiveDanger?: number;
	confidence?: number;
}

function answersFor(axes: Axes): Record<string, unknown> {
	const riskScore = axes.risk ?? 0.2;
	const confidence = axes.confidence ?? 0.9;
	const riskProbabilities: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0 };
	riskProbabilities[String(Math.min(3, Math.max(0, Math.round(riskScore))))] = 1;
	const authorization = axes.authorization ?? "high";

	const risk: ScoreAnswer = {
		type: "score",
		score: riskScore,
		probabilities: riskProbabilities,
		confidence,
	};
	const authProbabilities: Record<string, number> = { high: 0, medium: 0, low: 0, unknown: 0 };
	authProbabilities[authorization] = 1;
	const auth: ChoiceAnswer = {
		type: "choice",
		choice: authorization,
		probabilities: authProbabilities,
		confidence,
	};
	const predictive: NoulAnswer = { type: "noul", noul: axes.predictiveDanger ?? 0.1 };
	return { risk, authorization: auth, predictive_danger: predictive };
}

function makeGate(axes: Axes, overrides: Partial<FastGateDependencies> = {}) {
	const states: unknown[] = [];
	const judge: Judge = {
		label: "test/laya",
		async judge<Q extends Questions>(
			request: JudgmentRequest<Q>,
			_options?: JudgeOptions,
		): Promise<JudgmentResult<Q>> {
			states.push(request.state);
			return {
				api: "test",
				provider: "test",
				model: "test/laya",
				answers: answersFor(axes),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as unknown as JudgmentResult<Q>;
		},
	} satisfies Judge;

	const calls: TrajectoryCall[] = [
		{ toolCallId: "prev-1", toolName: "read", args: { path: "src/index.ts" }, startedAt: "2026-09-25T00:00:00.000Z" },
	];
	const dependencies: FastGateDependencies = {
		settings: Settings.isolated(),
		registry: {} as ModelRegistry,
		getModel: () => undefined,
		getCwd: () => "/workspace/project",
		getConversationContext: () => ({
			latestUserText: "Please update the project safely.",
			recentMessages: "assistant: checking the tree",
		}),
		getRecentCalls: () => calls,
		createJudge: () => judge,
		createLane: () => new LayaLane({ timeoutMs: 2_000, queueLimit: 4 }),
		...overrides,
	};

	return { states, gate: new FastGate(dependencies), calls };
}

const fireInput = (overrides: Partial<FastGateFireInput> = {}): FastGateFireInput => ({
	toolCallId: "call-1",
	toolName: "bash",
	tier: "exec" as ToolTier,
	args: { command: "rm -rf ./build" },
	intent: "clear the build output",
	...overrides,
});

describe("FastGate.fire", () => {
	it("classifies asynchronously and publishes to the ledger", async () => {
		const { gate, states } = makeGate({});

		gate.fire(fireInput());
		expect(gate.ledger.latest()).toBeUndefined();

		await gate.drain();
		expect(states).toHaveLength(1);
		expect(gate.ledger.latest()?.classification.toolCallId).toBe("call-1");
	});

	it("fires once per tool call id", async () => {
		const { gate, states } = makeGate({});

		gate.fire(fireInput());
		gate.fire(fireInput());
		await gate.drain();

		expect(states).toHaveLength(1);
		expect(gate.ledger.coverage().latestToolCallSeq).toBe(1);
		expect(gate.hasFired("call-1")).toBe(true);
	});

	it("sends the trajectory, not just the current call", async () => {
		const { gate, states } = makeGate({});

		gate.fire(fireInput());
		await gate.drain();

		const state = states[0] as Record<string, string>;
		expect(state.recent_tool_calls).toContain("read `src/index.ts`");
		expect(state.tool_name).toBe("bash");
		expect(state.tier).toBe("exec");
		expect(state.current_intent).toBe("clear the build output");
	});

	it("records a scoring failure when the judge rejects", async () => {
		const { gate } = makeGate(
			{},
			{
				createJudge: () =>
					({
						label: "test/broken",
						async judge(): Promise<never> {
							throw new Error("worker gone");
						},
					}) as unknown as Judge,
			},
		);

		gate.fire(fireInput());
		await gate.drain();

		expect(gate.ledger.latest()).toBeUndefined();
		expect(gate.scoringFailures).toBe(1);
		expect(gate.evaluate("call-1").handoff).toBe("scoring-failure");
	});
});

describe("FastGate.evaluate", () => {
	async function evaluated(axes: Axes, options?: Parameters<FastGate["evaluate"]>[0]) {
		const { gate } = makeGate(axes);
		gate.fire(fireInput());
		await gate.drain();
		return gate.evaluate(options ?? "call-1");
	}

	it("passes a fresh low-risk, well-authorized sample", async () => {
		const verdict = await evaluated({ risk: 0.1, authorization: "high", predictiveDanger: 0.1 });

		expect(verdict.kind).toBe("pass");
		expect(verdict.handoff).toBe("pass");
		expect(verdict.classification?.risk.level).toBe("low");
		expect(verdict.classification?.authorization.level).toBe("high");
	});

	it("never returns a deny — the vocabulary is pass or escalate", async () => {
		const verdict = await evaluated({ risk: 3.4, authorization: "unknown", predictiveDanger: 0.99 });

		expect(verdict.kind).toBe("escalate");
		expect(["pass", "escalate"]).toContain(verdict.kind);
	});

	it("escalates when the call was never fired", () => {
		const { gate } = makeGate({});

		expect(gate.evaluate("never-fired").handoff).toBe("missing-score");
	});

	it("escalates once risk leaves the low band", async () => {
		const verdict = await evaluated({ risk: 2.0 });

		expect(verdict.kind).toBe("escalate");
		expect(verdict.handoff).toBe("risk-threshold");
	});

	it("escalates when the risk tail is heavy even if the level reads low", async () => {
		const { gate } = makeGate({});
		gate.fire(fireInput());
		await gate.drain();

		// 0.2 expected is "low" by rounding, but a third of the mass sits on high.
		const classification = gate.ledger.latest()?.classification;
		expect(classification?.risk.level).toBe("low");

		const tight = new FastGate(
			{
				settings: Settings.isolated(),
				registry: {} as ModelRegistry,
				getModel: () => undefined,
				getCwd: () => "/workspace/project",
				getConversationContext: () => ({ latestUserText: "hi", recentMessages: undefined }),
				getRecentCalls: () => [],
				createJudge: () =>
					({
						label: "test",
						async judge() {
							const answers = answersFor({ risk: 0.2 });
							(answers.risk as ScoreAnswer).probabilities = { "0": 0.7, "1": 0, "2": 0.3, "3": 0 };
							return {
								api: "test",
								provider: "test",
								model: "test",
								answers,
								usage: {
									input: 1,
									output: 1,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 2,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
							} as never;
						},
					}) as unknown as Judge,
				createLane: () => new LayaLane({ timeoutMs: 2_000 }),
			},
			{ riskThreshold: 0.2 },
		);
		tight.fire(fireInput());
		await tight.drain();

		expect(tight.evaluate("call-1").handoff).toBe("risk-threshold");
	});

	it("escalates on weak authorization", async () => {
		expect((await evaluated({ authorization: "low" })).handoff).toBe("authorization-weak");
		expect((await evaluated({ authorization: "unknown" })).handoff).toBe("authorization-weak");
		expect((await evaluated({ authorization: "medium" })).kind).toBe("pass");
	});

	it("escalates when the trajectory is heading somewhere worse", async () => {
		const verdict = await evaluated({ predictiveDanger: 0.8 });

		expect(verdict.handoff).toBe("predictive-danger");
	});

	it("escalates when the sample is not confident enough to trust", async () => {
		const verdict = await evaluated({ confidence: 0.2 });

		expect(verdict.handoff).toBe("low-confidence");
	});

	it("escalates when the score no longer covers the call being reviewed", async () => {
		const { gate } = makeGate({});
		gate.fire(fireInput({ toolCallId: "call-1" }));
		await gate.drain();

		// Fires still in flight: nothing has failed, but the cached sample is
		// now several calls behind the one being approved.
		for (const toolCallId of ["call-2", "call-3", "call-4", "call-5"]) {
			gate.fire(fireInput({ toolCallId }));
		}

		expect(gate.evaluate("call-5").handoff).toBe("stale");
		await gate.drain();
	});

	it("escalates without asking the classifier when the state cannot fit", async () => {
		const sent: unknown[] = [];
		const oversized = new FastGate(
			{
				settings: Settings.isolated(),
				registry: {} as ModelRegistry,
				getModel: () => undefined,
				getCwd: () => "/workspace/project",
				getConversationContext: () => ({ latestUserText: "hi", recentMessages: undefined }),
				getRecentCalls: () => [],
				createJudge: () =>
					({
						label: "test/laya",
						async judge(request: JudgmentRequest<Questions>) {
							sent.push(request.state);
							return { answers: answersFor({}) };
						},
					}) as unknown as Judge,
				createLane: () => new LayaLane({ timeoutMs: 2_000 }),
			},
			// A budget nothing can fit in: every load-bearing field gets eaten.
			{ stateBudgetTokens: 1 },
		);

		oversized.fire(fireInput());
		await oversized.drain();

		expect(sent).toHaveLength(0);
		expect(oversized.evaluate("call-1").handoff).toBe("oversized");
		expect(oversized.ledger.coverage().oversizedToolCalls).toBe(1);
	});

	it("still classifies a state that only shed its conversation recap", async () => {
		const { gate, states } = makeGate(
			{},
			{
				getConversationContext: () => ({
					latestUserText: "please rebuild",
					recentMessages: "x".repeat(5_000),
				}),
			},
		);

		gate.fire(fireInput());
		await gate.drain();

		expect(states).toHaveLength(1);
		expect(gate.evaluate("call-1").kind).toBe("pass");
		expect(gate.ledger.latest()?.classification.truncated).toBe(true);
	});

	it("escalates on an unscored failure even when an older sample is cached", async () => {
		const { gate } = makeGate({});
		gate.fire(fireInput({ toolCallId: "good" }));
		await gate.drain();
		expect(gate.evaluate("good").kind).toBe("pass");

		// A later fire that never produced a sample.
		gate.ledger.nextSeq();
		gate.ledger.recordFailure(gate.ledger.coverage().latestToolCallSeq, "timeout");

		expect(gate.evaluate("good").handoff).toBe("scoring-failure");
	});
});
