import type { TextContent } from "@oh-my-pi/pi-ai";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { FramedMessageComponent } from "../chrome/message-frame";
import { MessageNoticeComponent } from "../chrome/message-notice";
import { Text } from "../components/text";
import { replaceTabs, shortenPath } from "../render/render-utils";
import { type Component } from "../tui";
import { theme, type Theme } from "../theme";
import { type CustomMessage, LIVE_DELEGATION_MESSAGE_TYPE } from "./messages";
import type { MessageRenderOptions, MessageRenderer } from "./extension-types";
/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends FramedMessageComponent<CustomMessage<unknown>> {
	constructor(message: CustomMessage<unknown>, customRenderer?: MessageRenderer) {
		const isLiveDelegation = message.customType === LIVE_DELEGATION_MESSAGE_TYPE;
		const details = message.details;
		const decision =
			message.customType === "tool-approval-notice" &&
			typeof details === "object" &&
			details !== null &&
			"decision" in details &&
			(details.decision === "allow" || details.decision === "deny")
				? details.decision
				: undefined;
		const renderer: MessageRenderer | undefined =
			customRenderer || decision !== undefined
				? (
						renderMessage: CustomMessage<unknown>,
						options: MessageRenderOptions,
						currentTheme: Theme,
					): Component | undefined => {
						if (customRenderer) {
							try {
								const extensionComponent = customRenderer(renderMessage, options, currentTheme);
								if (extensionComponent) return extensionComponent;
							} catch {
								// A broken extension renderer must not hide a built-in decision notice.
							}
						}
						if (decision === undefined) return undefined;
						const content =
							typeof renderMessage.content === "string"
								? renderMessage.content
								: renderMessage.content
										.filter((item): item is TextContent => item.type === "text")
										.map(item => item.text)
										.join("\n");
						const body = sanitizeText(replaceTabs(shortenPath(content)));
						return new MessageNoticeComponent({
							severity: decision === "allow" ? "success" : "error",
							presentation: () => ({
								icon: decision === "allow" ? currentTheme.status.success : currentTheme.status.error,
								header: decision === "allow" ? "Approved" : "Denied",
								body: new Text(body, 0, 0),
							}),
						});
					}
				: undefined;
		super({
			message,
			// The transcript dispatch routes both `custom` and legacy `hookMessage` roles here:
			// tag hooks with the hook glyph, other injected messages with a neutral package.
			icon: () => (String(message.role) === "hookMessage" ? theme.icon.extensionHook : theme.icon.package),
			hideHeader: isLiveDelegation,
			borderColor: isLiveDelegation ? "borderAccent" : undefined,
			customRenderer: renderer,
		});
	}
}
