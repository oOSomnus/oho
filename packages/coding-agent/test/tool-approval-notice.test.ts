import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Container } from "@oh-my-pi/pi-tui";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "../src/modes/types";
import { UiHelpers } from "../src/modes/utils/ui-helpers";
import type { CustomMessage } from "../src/session/messages";

ensureThemeSync();

type Decision = "allow" | "deny";

function approvalMessage(decision: Decision): CustomMessage<unknown> {
	const verb = decision === "allow" ? "approved" : "denied";
	return {
		role: "custom",
		customType: "tool-approval-notice",
		content: `Automode ${verb} tool call: bash\nArguments: { command: "echo ok" }`,
		display: true,
		details: { toolCallId: `call-${decision}`, tier: "write", decision },
		timestamp: 0,
	};
}

describe("live Automode approval notices", () => {
	it("renders both decisions with distinct labels and semantic colors", () => {
		for (const decision of ["allow", "deny"] as const) {
			const message = approvalMessage(decision);
			const chatContainer = new Container();
			const helpers = new UiHelpers({
				chatContainer,
				toolOutputExpanded: false,
				viewSession: { extensionRunner: undefined },
			} as unknown as InteractiveModeContext);
			helpers.addMessageToChat(message as AgentMessage);
			const component = chatContainer.children[0];
			if (!component) throw new Error("Expected live approval notice");

			const label = decision === "allow" ? "Approved" : "Denied";
			const color = decision === "allow" ? "success" : "error";
			const icon = decision === "allow" ? theme.status.success : theme.status.error;
			const colorCode = theme.fg(color, "x").match(/^\u001b\[[0-9;]*m/)?.[0];
			if (!colorCode) throw new Error(`Expected ${color} theme color`);
			const output = component.render(80).join("\n");
			const plainText = Bun.stripANSI(output);
			expect(plainText).toContain(`${icon} ${label}`);
			expect(plainText).toContain("tool call: bash");
			expect(output).toContain(colorCode);

			chatContainer.dispose();
		}
	});
});
