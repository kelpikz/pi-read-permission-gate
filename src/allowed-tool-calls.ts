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
 * dialog. Bash approvals are stored as full command-line prefixes (e.g.
 * "npm run dev") so only extensions of them run without prompting. Kept in
 * memory so approvals reset whenever pi restarts.
 */
export interface SessionAllowances {
	allowedTools: Set<string>;
	allowedBashCommandPrefixes: Set<string>;
}

/** Represents one tool call shown in a permission dialog. */
export interface PermissionToolCall {
	toolName: string;
	input: Record<string, unknown>;
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
	const normalizedToolName = normalizeToolName(toolName);
	if (mode === "yolo") return { allowed: true };

	if (isApprovedForSession(normalizedToolName, input, sessionAllowances)) {
		return { allowed: true };
	}

	if (normalizedToolName === "multi_tool_use.parallel") {
		return canRunMultiToolCallInMode(mode, input, sessionAllowances);
	}

	if (mode === "write") {
		if (normalizedToolName === "bash") {
			return isAllowedBashCommand(String(input.command ?? ""))
				? { allowed: true }
				: {
						allowed: false,
						reason:
							"Blocked bash command because write mode only allows conservative read-only shell commands. Use YOLO mode to run CLIs or dangerous commands.",
					};
		}

		return allowedWriteModeTools.has(normalizedToolName)
			? { allowed: true }
			: {
					allowed: false,
					reason: `Blocked tool call "${normalizedToolName}" because write mode only allows Pi file tools and conservative read-only bash commands.`,
				};
	}

	return isAllowedToolCall(normalizedToolName, input)
		? { allowed: true }
		: {
				allowed: false,
				reason: `Blocked tool call "${normalizedToolName}" because default mode only allows read-only operations. Switch to write or YOLO mode if needed.`,
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
	const toolCalls = extractMultiToolCalls(input);
	if (!toolCalls) {
		return {
			allowed: false,
			reason: "Blocked malformed multi-tool call.",
		};
	}

	for (const toolCall of toolCalls) {
		const decision = canRunToolCallInMode(
			mode,
			toolCall.toolName,
			toolCall.input,
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

/** Returns true when a value can be used as a tool input object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extracts child calls from a multi-tool wrapper while normalizing their names.
 * An undefined result means the wrapper input is malformed.
 */
function extractMultiToolCalls(
	input: Record<string, unknown>,
): PermissionToolCall[] | undefined {
	if (!Array.isArray(input.tool_uses)) return undefined;

	return input.tool_uses.map((toolUse) => {
		if (!isRecord(toolUse)) {
			return { toolName: "", input: {} };
		}

		return {
			toolName: normalizeToolName(String(toolUse.recipient_name ?? "")),
			input: isRecord(toolUse.parameters) ? toolUse.parameters : {},
		};
	});
}

/**
 * Finds the blocked child calls in a tool call, omitting safe children from
 * the permission question. Nested multi-tool wrappers are flattened too.
 */
export function getPermissionRequiredToolCalls(
	mode: PermissionMode,
	toolName: string,
	input: Record<string, unknown>,
	sessionAllowances?: SessionAllowances,
): PermissionToolCall[] {
	const normalizedToolName = normalizeToolName(toolName);

	if (normalizedToolName === "multi_tool_use.parallel") {
		const childToolCalls = extractMultiToolCalls(input);
		if (!childToolCalls) {
			return [{ toolName: normalizedToolName, input }];
		}

		return childToolCalls.flatMap((childToolCall) =>
			getPermissionRequiredToolCalls(
				mode,
				childToolCall.toolName,
				childToolCall.input,
				sessionAllowances,
			),
		);
	}

	return canRunToolCallInMode(
		mode,
		normalizedToolName,
		input,
		sessionAllowances,
	).allowed
		? []
		: [{ toolName: normalizedToolName, input }];
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

	if (toolName === "multi_tool_use.parallel") return false;

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
	const normalizedToolName = normalizeToolName(toolName);

	if (normalizedToolName === "multi_tool_use.parallel") {
		const childToolCalls = extractMultiToolCalls(input);
		if (!childToolCalls) return [];

		return [
			...new Set(
				childToolCalls.flatMap((childToolCall) =>
					addSessionAllowance(
						sessionAllowances,
						childToolCall.toolName,
						childToolCall.input,
					),
				),
			),
		];
	}

	if (normalizedToolName === "bash") {
		const segments =
			extractBashCommandSegments(String(input.command ?? "")) ?? [];
		for (const segment of segments) {
			sessionAllowances.allowedBashCommandPrefixes.add(segment);
		}
		return segments;
	}

	sessionAllowances.allowedTools.add(normalizedToolName);
	return [normalizedToolName];
}

/** Records several permission-approved calls and returns unique allowance names. */
export function addSessionAllowances(
	sessionAllowances: SessionAllowances,
	toolCalls: readonly PermissionToolCall[],
): string[] {
	return [
		...new Set(
			toolCalls.flatMap((toolCall) =>
				addSessionAllowance(
					sessionAllowances,
					toolCall.toolName,
					toolCall.input,
				),
			),
		),
	];
}

/**
 * Returns true when a tool call is safe enough to run without asking the user.
 */
export function isAllowedToolCall(
	toolName: string,
	input: Record<string, unknown>,
) {
	const normalizedToolName = normalizeToolName(toolName);
	if (allowedTools.has(normalizedToolName)) return true;

	if (normalizedToolName !== "bash") return false;

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

		if (
			character !== "|" &&
			character !== "&" &&
			character !== ";" &&
			character !== "\n"
		)
			continue;

		const nextCharacter = command[index + 1];
		const isDoubleOperator =
			nextCharacter === character && character !== ";" && character !== "\n";
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
