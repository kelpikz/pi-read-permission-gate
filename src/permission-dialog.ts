import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "./allowed-tool-calls.ts";
import { modeLabels } from "./permission-mode.ts";

export type PermissionDecision =
	| { allowed: true }
	| { allowed: false; reason: string };

/**
 * Describes a tool call in a way that is useful to the user and model.
 */
export function describeToolCall(
	toolName: string,
	input: Record<string, unknown>,
) {
	if (toolName === "bash") {
		return `bash command: ${String(input.command ?? "")}`;
	}

	if (toolName === "write" || toolName === "edit") {
		return `${toolName} path: ${String(input.path ?? "")}`;
	}

	return `tool: ${toolName}`;
}

/**
 * Asks the user whether an operation outside the current mode should run.
 */
export async function askPermissionForModeOverride(
	activeMode: PermissionMode,
	toolName: string,
	input: Record<string, unknown>,
	decisionReason: string,
	ctx: ExtensionContext,
): Promise<PermissionDecision> {
	if (!ctx.hasUI) {
		return {
			allowed: false,
			reason: `Blocked ${toolName} because no UI is available for permission confirmation.`,
		};
	}

	const choice = await ctx.ui.select(
		`${modeLabels[activeMode]} mode permission required\n\n${decisionReason}\n\nPi wants to run:\n\n${describeToolCall(toolName, input)}\n\nAllow this?`,
		["Allow", "Deny", "Deny with reason"],
	);

	if (choice === "Allow") return { allowed: true };

	if (choice === "Deny with reason") {
		const denialReason = await ctx.ui.editor("Reason for denial");
		const trimmedReason = denialReason?.trim();

		return {
			allowed: false,
			reason: trimmedReason
				? `Blocked ${toolName} by user. Reason:\n${trimmedReason}`
				: `Blocked ${toolName} by user without a reason.`,
		};
	}

	return {
		allowed: false,
		reason: `Blocked ${toolName} by user.`,
	};
}
