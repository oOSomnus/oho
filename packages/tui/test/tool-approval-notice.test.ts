import { describe, expect, it } from "bun:test";
import { ChatTranscriptBuilder } from "../src/chat/chat-transcript-builder";
import type { CustomMessage } from "../src/chat/messages";
import { ensureThemeSync, theme } from "../src/theme";
import type { TUI } from "../src/tui";

ensureThemeSync();

type Decision = "allow" | "deny";

function approvalMessage(decision: Decision, actor?: string): CustomMessage<unknown> {
	const verb = decision === "allow" ? "approved" : "denied";
	const suffix = actor ? ` (${actor})` : "";
	return {
		role: "custom",
		customType: "tool-approval-notice",
		content: `Automode ${verb} tool call${suffix}: bash\nArguments: { command: "echo ok" }`,
		display: true,
		details: { toolCallId: `call-${decision}`, tier: "write", decision, ...(actor ? { actor } : {}) },
		timestamp: 0,
	};
}

function render(component: { render(width: number): readonly string[] }): string {
	return component.render(80).join("\n");
}

function rebuildNotice(message: CustomMessage<unknown>, id: string): { output: string; dispose: () => void } {
	const builder = new ChatTranscriptBuilder({
		ui: { requestRender() {}, requestComponentRender() {} } as unknown as TUI,
		cwd: "/workspace/project",
		requestRender() {},
	});
	builder.rebuild([
		{
			type: "custom_message",
			id,
			parentId: null,
			timestamp: new Date(0).toISOString(),
			customType: message.customType,
			content: message.content,
			details: message.details,
			display: message.display,
			attribution: "agent",
		},
	]);
	const component = builder.container.children[0];
	if (!component) throw new Error("Expected rebuilt approval notice");
	return { output: render(component), dispose: () => builder.dispose() };
}

describe("rebuilt Automode approval notices", () => {
	it("shows distinct decision labels and semantic colors", () => {
		const rendered = new Map<Decision, string>();
		for (const decision of ["allow", "deny"] as const) {
			const { output, dispose } = rebuildNotice(approvalMessage(decision), `entry-${decision}`);

			const label = decision === "allow" ? "Approved" : "Denied";
			const color = decision === "allow" ? "success" : "error";
			const icon = decision === "allow" ? theme.status.success : theme.status.error;
			const colorCode = theme.fg(color, "x").match(/^\u001b\[[0-9;]*m/)?.[0];
			if (!colorCode) throw new Error(`Expected ${color} theme color`);
			const plainText = Bun.stripANSI(output);
			expect(plainText).toContain(`${icon} ${label}`);
			expect(plainText).toContain("tool call: bash");
			expect(output).toContain(colorCode);
			rendered.set(decision, output);
			dispose();
		}
		expect(rendered.get("allow")).not.toBe(rendered.get("deny"));
	});

	it("names the resolving actor so a model approval is distinguishable from a human one", () => {
		for (const [actor, expected] of [
			["judge", "Approved · judge"],
			["fast-gate", "Approved · fast-gate"],
		] as const) {
			const { output, dispose } = rebuildNotice(approvalMessage("allow", actor), `entry-${actor}`);
			expect(Bun.stripANSI(output)).toContain(expected);
			dispose();
		}
		// A legacy notice without actor details keeps the bare label.
		const { output, dispose } = rebuildNotice(approvalMessage("allow"), "entry-legacy");
		const plainText = Bun.stripANSI(output);
		expect(plainText).toContain("Approved");
		expect(plainText).not.toContain("·");
		dispose();
	});
});
