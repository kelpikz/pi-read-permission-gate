const allowedTools = new Set(["read"]);
const allowedWriteModeTools = new Set(["read", "write", "edit"]);
const allowedBashCommands = new Set([
	"cat",
	"cd",
	"echo",
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

/**
 * Commands and tools the user approved "for this session" via the permission
 * dialog. Kept in memory so approvals reset whenever pi restarts.
 */
/**
 * Commands and tools the user approved "for this session" via the permission
 * dialog. Bash approvals are stored as full command-line prefixes (e.g.
 * "npm run dev") so only extensions of them run without prompting. Kept in
 * memory so approvals reset whenever pi restarts.
 */
export interface SessionAllowances {
	allowedTools: Set<string>;
	allowedBashCommandPrefixes: Set<string>;
}

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
 * Decides whether a tool call can run under the active mode, taking session
 * approvals into account.
 */
export function canRunToolCallInMode(
	mode: PermissionMode,
	toolName: string,
	input: Record<string, unknown>,
	sessionAllowances?: SessionAllowances,
): ToolCallDecision {
	if (mode === "yolo") return { allowed: true };

	if (isApprovedForSession(toolName, input, sessionAllowances)) {
		return { allowed: true };
	}

	if (toolName === "multi_tool_use.parallel") {
		return canRunMultiToolCallInMode(mode, input, sessionAllowances);
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
	sessionAllowances?: SessionAllowances,
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
			sessionAllowances,
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
 * Extracts every segment of a bash command verbatim, e.g. "npm test && ls" ->
 * ["npm test", "ls"]. Returns undefined when the command is empty or contains
 * malformed or unsupported syntax, so callers never derive allowances from
 * commands they cannot fully parse.
 */
export function extractBashCommandSegments(
	commandInput: string,
): string[] | undefined {
	const command = commandInput.trim();
	if (!command) return undefined;

	const commandWithoutDevNullRedirects = stripDevNullRedirects(command);
	if (/`|\$\(|[<>]/.test(commandWithoutDevNullRedirects)) return undefined;

	return splitBashCommandIntoSegments(commandWithoutDevNullRedirects);
}

/**
 * Returns true when a single bash segment either starts with a built-in safe
 * command or extends a command line approved earlier this session, e.g.
 * "npm run dev -- --watch" extends the approval "npm run dev", while
 * "npm run test" does not.
 */
function isSegmentCoveredByApproval(
	segment: string,
	sessionAllowances: SessionAllowances,
) {
	const baseCommand = segment.split(/\s+/)[0];
	if (allowedBashCommands.has(baseCommand)) return true;

	for (const prefix of sessionAllowances.allowedBashCommandPrefixes) {
		if (segment === prefix || segment.startsWith(`${prefix} `)) return true;
	}
	return false;
}

/**
 * Returns true when the tool call matches an earlier "allow for this session"
 * approval. Bash calls qualify only when every segment is whitelisted or
 * extends an approved prefix; other tools qualify by name.
 */
function isApprovedForSession(
	toolName: string,
	input: Record<string, unknown>,
	sessionAllowances?: SessionAllowances,
) {
	if (!sessionAllowances) return false;

	if (toolName === "bash") {
		const segments = extractBashCommandSegments(String(input.command ?? ""));
		return (
			segments?.every((segment) =>
				isSegmentCoveredByApproval(segment, sessionAllowances),
			) ?? false
		);
	}

	return sessionAllowances.allowedTools.has(toolName);
}

/**
 * Records a "allow for this session" approval for the given tool call. For
 * bash commands every segment's command line is remembered as a prefix; for
 * other tools the tool name itself. Returns what was recorded so callers can
 * confirm to the user what will be skipped next time.
 */
export function addSessionAllowance(
	sessionAllowances: SessionAllowances,
	toolName: string,
	input: Record<string, unknown>,
): string[] {
	if (toolName === "bash") {
		const segments =
			extractBashCommandSegments(String(input.command ?? "")) ?? [];
		for (const segment of segments) {
			sessionAllowances.allowedBashCommandPrefixes.add(segment);
		}
		return segments;
	}

	sessionAllowances.allowedTools.add(toolName);
	return [toolName];
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
	// Redirections into /dev/null are stripped first since they only discard output.
	const commandWithoutDevNullRedirects = stripDevNullRedirects(command);
	if (/`|\$\(|[<>]/.test(commandWithoutDevNullRedirects)) {
		return false;
	}

	const segments = splitBashCommandIntoSegments(commandWithoutDevNullRedirects);
	if (!segments) return false;

	return segments.every((segment) => {
		const commandName = segment.trim().split(/\s+/)[0];
		return allowedBashCommands.has(commandName);
	});
}

/**
 * Matches redirections whose target is exactly /dev/null, e.g. "2>/dev/null",
 * "> /dev/null", ">>/dev/null", or "&>/dev/null". The lookahead ensures the
 * target path ends at the redirect so paths like "/dev/null/copy.md" are rejected,
 * while a directly following operator ("2>/dev/null;ls") is still accepted.
 */
const devNullRedirectPattern = /(^|\s)\d*&?>>?\s*\/dev\/null(?=\s|$|[;&|])/g;

/**
 * Removes redirections into /dev/null from a command, returning the rest of the
 * command unchanged so it can be validated like any other read-only command.
 */
function stripDevNullRedirects(command: string): string {
	return command.replace(devNullRedirectPattern, "$1");
}

/**
 * Splits a bash command on supported operators while preserving quoted pipes.
 * Returns undefined when the command contains malformed or unsupported syntax.
 */
function splitBashCommandIntoSegments(command: string): string[] | undefined {
	const segments: string[] = [];
	let segmentStart = 0;
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];

		if (escaped) {
			escaped = false;
			continue;
		}

		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}

		if (quote) {
			if (character === quote) quote = undefined;
			continue;
		}

		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}

		if (character !== "|" && character !== "&" && character !== ";") continue;

		const nextCharacter = command[index + 1];
		const isDoubleOperator = nextCharacter === character && character !== ";";
		if (character === "&" && !isDoubleOperator) return undefined;

		const segment = command.slice(segmentStart, index).trim();
		if (!segment) return undefined;
		segments.push(segment);

		if (isDoubleOperator) index += 1;
		segmentStart = index + 1;
	}

	if (quote || escaped) return undefined;

	const finalSegment = command.slice(segmentStart).trim();
	if (!finalSegment) return undefined;
	segments.push(finalSegment);

	return segments;
}
