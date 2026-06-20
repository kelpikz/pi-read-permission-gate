const allowedTools = new Set(["read"]);
const allowedWriteModeTools = new Set(["read", "write", "edit"]);
const allowedBashCommands = new Set([
	"cat",
	"cd",
	"find",
	"grep",
	"head",
	"ls",
	"pwd",
	"rg",
	"sort",
	"tail",
	"true",
	"uniq",
	"wc",
]);

export const permissionModes = ["default", "write", "yolo"] as const;
export type PermissionMode = (typeof permissionModes)[number];

export type ToolCallDecision =
	| { allowed: true }
	| { allowed: false; reason: string };

/**
 * Returns true when the provided value is a supported permission mode.
 */
export function isPermissionMode(value: string): value is PermissionMode {
	return permissionModes.includes(value as PermissionMode);
}

/**
 * Decides whether a tool call can run under the active permission mode.
 */
export function canRunToolCallInMode(
	mode: PermissionMode,
	toolName: string,
	input: Record<string, unknown>,
): ToolCallDecision {
	if (mode === "yolo") return { allowed: true };

	if (toolName === "multi_tool_use.parallel") {
		return canRunMultiToolCallInMode(mode, input);
	}

	if (mode === "write") {
		if (toolName === "bash") {
			return isAllowedBashCommand(String(input.command ?? ""))
				? { allowed: true }
				: {
						allowed: false,
						reason:
							"Blocked bash command because write mode only allows conservative read-only shell commands. Use YOLO mode to run CLIs or dangerous commands.",
					};
		}

		return allowedWriteModeTools.has(toolName)
			? { allowed: true }
			: {
					allowed: false,
					reason: `Blocked tool call "${toolName}" because write mode only allows Pi file tools and conservative read-only bash commands.`,
				};
	}

	return isAllowedToolCall(toolName, input)
		? { allowed: true }
		: {
				allowed: false,
				reason: `Blocked tool call "${toolName}" because default mode only allows read-only operations. Switch to write or YOLO mode if needed.`,
			};
}

/**
 * Checks every child call in a multi-tool batch against the active mode.
 */
function canRunMultiToolCallInMode(
	mode: PermissionMode,
	input: Record<string, unknown>,
): ToolCallDecision {
	const toolUses = input.tool_uses;
	if (!Array.isArray(toolUses)) {
		return {
			allowed: false,
			reason: "Blocked malformed multi-tool call.",
		};
	}

	for (const toolUse of toolUses) {
		const child = toolUse as {
			recipient_name?: unknown;
			parameters?: Record<string, unknown>;
		};
		const childToolName = normalizeToolName(String(child.recipient_name ?? ""));
		const decision = canRunToolCallInMode(
			mode,
			childToolName,
			child.parameters ?? {},
		);
		if (!decision.allowed) return decision;
	}

	return { allowed: true };
}

/**
 * Converts developer tool wrapper names into the tool names seen by this gate.
 */
function normalizeToolName(toolName: string) {
	return toolName.startsWith("functions.")
		? toolName.slice("functions.".length)
		: toolName;
}

/**
 * Returns true when a tool call is safe enough to run without asking the user.
 */
export function isAllowedToolCall(
	toolName: string,
	input: Record<string, unknown>,
) {
	if (allowedTools.has(toolName)) return true;

	if (toolName !== "bash") return false;

	return isAllowedBashCommand(String(input.command ?? ""));
}

/**
 * Checks whether a bash command only uses conservative read-only commands.
 */
function isAllowedBashCommand(commandInput: string) {
	const command = commandInput.trim();
	if (!command) return false;

	// Allow common read-only shell commands and directory changes without prompting.
	// Keep this conservative: write redirection, pipes to unknown commands, command
	// substitution, and shell control characters still require permission.
	if (/`|\$\(|[;<>]/.test(command) || /(^|\s)(>>?|2>|&>)/.test(command)) {
		return false;
	}

	const segments = command.split(/\s*(?:&&|\|\||\|)\s*/).filter(Boolean);
	return segments.every((segment) => {
		const commandName = segment.trim().split(/\s+/)[0];
		return allowedBashCommands.has(commandName);
	});
}
