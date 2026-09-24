import { describe, expect, it, vi } from "bun:test";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { BUILTIN_MODE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-modes";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const APPROVAL_MODE_OPTIONS = SETTINGS_SCHEMA["tools.approvalMode"].ui.options;
const APPROVAL_MODE_USAGE = "Usage: /permissions [always-ask|write|automode|yolo]";

function tuiRuntime(settings: Settings, selection?: string) {
	const showHookSelector = vi.fn(async () => selection);
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const setText = vi.fn();
	return {
		showHookSelector,
		showStatus,
		showWarning,
		setText,
		runtime: {
			ctx: {
				settings,
				showHookSelector,
				showStatus,
				showWarning,
				editor: { setText } as unknown as InteractiveModeContext["editor"],
			} as unknown as InteractiveModeContext,
		},
	};
}

function acpRuntime(settings: Settings) {
	const output = vi.fn();
	return {
		output,
		runtime: { settings, output } as unknown as SlashCommandRuntime,
	};
}

describe("/permissions slash command", () => {
	it("advertises schema-defined approval modes as argument completions", () => {
		const command = BUILTIN_MODE_SLASH_COMMANDS.find(candidate => candidate.name === "permissions");

		expect(command?.allowArgs).toBe(true);
		expect(command?.subcommands).toEqual(
			APPROVAL_MODE_OPTIONS.map(({ value, description }) => ({ name: value, description })),
		);
	});

	it("persists a direct TUI selection and supersedes a launch-time override", async () => {
		const settings = Settings.isolated();
		settings.set("tools.approvalMode", "write");
		settings.override("tools.approvalMode", "always-ask");
		const h = tuiRuntime(settings);

		await executeBuiltinSlashCommand("/permissions Automode", h.runtime);

		expect(settings.get("tools.approvalMode")).toBe("automode");
		expect(h.showStatus).toHaveBeenCalledWith("Approval mode set to automode.");
		expect(h.setText).toHaveBeenCalledWith("");
		settings.clearOverride("tools.approvalMode");
		expect(settings.get("tools.approvalMode")).toBe("automode");
	});

	it("shows every schema option and applies the selected mode", async () => {
		const settings = Settings.isolated();
		const selected = APPROVAL_MODE_OPTIONS.find(option => option.value === "automode")!;
		const h = tuiRuntime(settings, selected.label);

		await executeBuiltinSlashCommand("/permissions", h.runtime);

		expect(h.showHookSelector).toHaveBeenCalledWith(
			"Select tool approval mode",
			APPROVAL_MODE_OPTIONS.map(({ label, description }) => ({ label, description })),
		);
		expect(settings.get("tools.approvalMode")).toBe("automode");
		expect(h.showStatus).toHaveBeenCalledWith("Approval mode set to automode.");
		expect(h.setText).toHaveBeenCalledWith("");
	});

	it("leaves settings unchanged when the selector is cancelled", async () => {
		const settings = Settings.isolated();
		const before = settings.get("tools.approvalMode");
		const h = tuiRuntime(settings);

		await executeBuiltinSlashCommand("/permissions", h.runtime);

		expect(settings.get("tools.approvalMode")).toBe(before);
		expect(h.showStatus).not.toHaveBeenCalled();
		expect(h.setText).toHaveBeenCalledWith("");
	});

	it("rejects unknown and multi-token TUI arguments without changing settings", async () => {
		for (const command of ["/permissions auto", "/permissions write yolo"]) {
			const settings = Settings.isolated();
			const before = settings.get("tools.approvalMode");
			const h = tuiRuntime(settings);

			await executeBuiltinSlashCommand(command, h.runtime);

			expect(h.showWarning).toHaveBeenCalledWith(APPROVAL_MODE_USAGE);
			expect(settings.get("tools.approvalMode")).toBe(before);
			expect(h.showStatus).not.toHaveBeenCalled();
			expect(h.setText).toHaveBeenCalledWith("");
		}
	});

	it("applies a direct ACP mode argument", async () => {
		const settings = Settings.isolated();
		const h = acpRuntime(settings);

		await executeAcpBuiltinSlashCommand("/permissions yolo", h.runtime);

		expect(settings.get("tools.approvalMode")).toBe("yolo");
		expect(h.output).toHaveBeenCalledWith("Approval mode set to yolo.");
	});

	it("reports the effective mode and usage for a bare ACP invocation", async () => {
		const settings = Settings.isolated();
		settings.override("tools.approvalMode", "write");
		const h = acpRuntime(settings);

		await executeAcpBuiltinSlashCommand("/permissions", h.runtime);

		expect(h.output).toHaveBeenCalledWith(`Current approval mode: write.\n${APPROVAL_MODE_USAGE}`);
		expect(settings.get("tools.approvalMode")).toBe("write");
	});
});
