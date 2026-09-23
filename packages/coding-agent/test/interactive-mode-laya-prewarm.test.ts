import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRenderCommand } from "@oh-my-pi/pi-coding-agent/cli/render-cli";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { layaJudgeClient, type LayaJudgeLoadState } from "@oh-my-pi/pi-coding-agent/judgment/laya-client";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("InteractiveMode Laya judge prewarm", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let previousNoTitle: string | undefined;

	beforeAll(() => {
		initTheme();
		tempDir = TempDir.createSync("@pi-interactive-mode-laya-prewarm-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		previousNoTitle = Bun.env.PI_NO_TITLE;
		Bun.env.PI_NO_TITLE = "1";
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "statusLine.showHookStatus": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, () => {}, [], undefined, undefined);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	});

	afterEach(async () => {
		const pendingImmediates = Promise.withResolvers<void>();
		setImmediate(pendingImmediates.resolve);
		await pendingImmediates.promise;
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		resetSettingsForTest();
		if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
		else Bun.env.PI_NO_TITLE = previousNoTitle;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function installLayaSpies() {
		const states: ((state: LayaJudgeLoadState) => void)[] = [];
		const activeStates = new Set<(state: LayaJudgeLoadState) => void>();
		const prewarm = vi.spyOn(layaJudgeClient, "prewarm").mockImplementation(() => {});
		const subscribe = vi.spyOn(layaJudgeClient, "subscribeLoadState").mockImplementation(listener => {
			states.push(listener);
			activeStates.add(listener);
			listener("idle");
			return () => activeStates.delete(listener);
		});
		return {
			prewarm,
			subscribe,
			states,
			publish(state: LayaJudgeLoadState) {
				for (const listener of activeStates) listener(state);
			},
		};
	}

	function renderedStatus(): string {
		return Bun.stripANSI(mode.statusLine.render(120).join("\n"));
	}

	it("prewarms the primary Laya judge and renders its load states in automode", async () => {
		session.settings.set("tools.approvalMode", "automode");
		session.settings.setModelRole("judge", "laya/typed-decisions");
		const { prewarm, states } = installLayaSpies();

		await mode.init();

		expect(prewarm).toHaveBeenCalledTimes(1);
		const loadState = states[0];
		if (!loadState) throw new Error("Expected a Laya load-state subscriber");
		for (const state of ["loading", "ready", "failed"] as const) {
			loadState(state);
			const rendered = renderedStatus();
			expect(rendered).toContain(
				state === "failed" ? "Laya judge: failed; next review will retry" : `Laya judge: ${state}`,
			);
		}
	});

	it("does not prewarm or render Laya status outside automode", async () => {
		session.settings.setModelRole("judge", "laya/typed-decisions");
		const { prewarm, subscribe } = installLayaSpies();

		await mode.init();

		expect(prewarm).not.toHaveBeenCalled();
		expect(subscribe).not.toHaveBeenCalled();
		expect(renderedStatus()).not.toContain("Laya judge:");
	});

	it("does not prewarm or render a non-Laya primary judge in automode", async () => {
		session.settings.set("tools.approvalMode", "automode");
		session.settings.setModelRole("judge", "anthropic/claude-sonnet-4-5");
		const { prewarm, subscribe } = installLayaSpies();

		await mode.init();

		expect(prewarm).not.toHaveBeenCalled();
		expect(subscribe).not.toHaveBeenCalled();
		expect(renderedStatus()).not.toContain("Laya judge:");
	});

	it("rechecks approval mode and judge-role changes while the mode is active", async () => {
		session.settings.set("tools.approvalMode", "automode");
		session.settings.setModelRole("judge", "laya/typed-decisions");
		const { prewarm, states } = installLayaSpies();

		await mode.init();
		expect(prewarm).toHaveBeenCalledTimes(1);
		states[0]?.("ready");
		expect(renderedStatus()).toContain("Laya judge: ready");

		session.settings.set("tools.approvalMode", "yolo");
		expect(renderedStatus()).not.toContain("Laya judge:");
		expect(prewarm).toHaveBeenCalledTimes(1);

		session.settings.set("tools.approvalMode", "automode");
		expect(prewarm).toHaveBeenCalledTimes(2);
		states.at(-1)?.("loading");
		expect(renderedStatus()).toContain("Laya judge: loading");

		session.settings.setModelRole("judge", "anthropic/claude-sonnet-4-5");
		expect(renderedStatus()).not.toContain("Laya judge:");
		expect(prewarm).toHaveBeenCalledTimes(2);

		session.settings.setModelRole("judge", "laya/typed-decisions");
		expect(prewarm).toHaveBeenCalledTimes(3);
	});

	it("unsubscribes the Laya status listener when the mode stops", async () => {
		session.settings.set("tools.approvalMode", "automode");
		session.settings.setModelRole("judge", "laya/typed-decisions");
		const { publish } = installLayaSpies();
		const setHookStatus = vi.spyOn(mode, "setHookStatus");

		await mode.init();
		mode.stop();
		setHookStatus.mockClear();
		publish("ready");

		expect(setHookStatus).not.toHaveBeenCalled();
	});

	it("does not prewarm Laya while rendering a saved session", async () => {
		const settings = await Settings.init({ inMemory: true, cwd: tempDir.path() });
		settings.set("tools.approvalMode", "automode");
		settings.setModelRole("judge", "laya/typed-decisions");
		const sessionFile = SessionManager.createEmptySessionFile(tempDir.path());
		const { prewarm, subscribe } = installLayaSpies();

		expect(await runRenderCommand({ session: sessionFile, quiet: true })).toBe(0);
		expect(prewarm).not.toHaveBeenCalled();
		expect(subscribe).not.toHaveBeenCalled();
	});
});
