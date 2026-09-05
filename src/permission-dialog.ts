import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	PermissionMode,
	PermissionToolCall,
} from "./allowed-tool-calls.ts";
import { extractBashCommandSegments } from "./allowed-tool-calls.ts";
import { modeLabels } from "./permission-mode.ts";

/**
 * What the user decided when asked about an operation outside the current mode.
 */
export type PermissionOutcome =
	| { outcome: "allow" }
	| { outcome: "allow-session" }
	| { outcome: "deny"; reason: string };

/**
 * Describes a tool call in a way that is useful to the user and model.
 */
export function describeToolCall(
	toolName: string,
	input: Record<string, unknown>,
) {
	if (toolName === "bash") {
		const command = String(input.command ?? "");
		const commandSegments = extractBashCommandSegments(command);
		if (commandSegments && commandSegments.length > 1) {
			return `bash commands:\n${commandSegments
				.map((segment) => `- ${segment}`)
				.join("\n")}`;
		}

		return `bash command: ${command}`;
	}

	if (toolName === "write" || toolName === "edit") {
		return `${toolName} path: ${String(input.path ?? "")}`;
	}

	return `tool: ${toolName}`;
}

/** Formats several tool calls as a readable list for the permission prompt. */
export function describeToolCalls(toolCalls: readonly PermissionToolCall[]) {
	return toolCalls
		.map(
			(toolCall) => `- ${describeToolCall(toolCall.toolName, toolCall.input)}`,
		)
		.join("\n");
}

/**
 * Asks the user whether an operation outside the current mode should run,
 * including whether similar operations should be trusted for this session.
 */
export async function askPermissionForModeOverride(
	activeMode: PermissionMode,
	toolName: string,
	input: Record<string, unknown>,
	decisionReason: string,
	ctx: ExtensionContext,
	permissionRequiredToolCalls: readonly PermissionToolCall[] = [
		{ toolName, input },
	],
): Promise<PermissionOutcome> {
	if (!ctx.hasUI) {
		return {
			outcome: "deny",
			reason: `Blocked ${toolName} because no UI is available for permission confirmation.`,
		};
	}

	const toolCallsToDescribe =
		permissionRequiredToolCalls.length > 0
			? permissionRequiredToolCalls
			: [{ toolName, input }];
	const toolDescription =
		toolCallsToDescribe.length === 1
			? describeToolCall(
					toolCallsToDescribe[0].toolName,
					toolCallsToDescribe[0].input,
				)
			: describeToolCalls(toolCallsToDescribe);

	const choice = await ctx.ui.select(
		`${modeLabels[activeMode]} mode permission required\n\n${decisionReason}\n\nPi wants to run (the "Allow for this session" option will allow these calls for the rest of this session):\n\n${toolDescription}\n\nAllow this?`,
		["Allow", "Allow for this session", "Deny", "Deny with reason"],
	);

	if (choice === "Allow") return { outcome: "allow" };

	if (choice === "Allow for this session") return { outcome: "allow-session" };

	if (choice === "Deny with reason") {
		const denialReason = await ctx.ui.editor("Reason for denial");
		const trimmedReason = denialReason?.trim();

		return {
			outcome: "deny",
			reason: trimmedReason
				? `Blocked ${toolName} by user. Reason:\n${trimmedReason}`
				: `Blocked ${toolName} by user without a reason.`,
		};
	}

	return {
		outcome: "deny",
		reason: `Blocked ${toolName} by user.`,
	};
}
