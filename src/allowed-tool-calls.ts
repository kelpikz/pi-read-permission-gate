const allowedTools = new Set(["read"]);
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
