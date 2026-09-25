/**
 * Shared text bounding for review state. Lives beside the automode types so the
 * fast gate and the blocking judge present fields the same way.
 */
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { truncateForPrompt } from "../approval";

/** Redact, sanitize, and hard-cap one state field. Empty input renders `(none)`. */
export function boundedText(value: string | undefined, maxChars: number, obfuscate?: (text: string) => string): string {
	if (!value) return "(none)";
	const redacted = obfuscate ? obfuscate(value) : value;
	const sanitized = sanitizeText(replaceTabs(redacted)).replace(/\r/g, "").trim();
	if (!sanitized) return "(none)";
	return truncateToWidth(truncateForPrompt(sanitized, maxChars), maxChars);
}

/** Render one recent tool call as a single trajectory line. */
export function formatTrajectoryLine(call: {
	toolName: string;
	args?: { command?: string; path?: string };
	intent?: string;
}): string {
	const parts = [call.toolName];
	const target = call.args?.command ?? call.args?.path;
	if (target) parts.push(`\`${target}\``);
	if (call.intent) parts.push(`(${call.intent})`);
	return parts.join(" ");
}
