import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isAllowedToolCall } from "./allowed-tool-calls.js";

/**
 * Read Permission Gate
 *
 * Allows read-only tool calls by default and asks for confirmation before
 * every other tool call. In non-interactive modes, non-read tools are blocked.
 */
export default function (pi: ExtensionAPI) {
	const decisions = new Map<
		string,
		{ allowed: true } | { allowed: false; reason: string }
	>();

	function describeToolCall(toolName: string, input: Record<string, unknown>) {
		if (toolName === "bash") {
			return `Pi wants to run this command:\n\n  ${String(input.command ?? "")}`;
		}

		if (toolName === "write") {
			return `Pi wants to write to:\n\n  ${String(input.path ?? "")}`;
		}

		if (toolName === "edit") {
			return `Pi wants to edit:\n\n  ${String(input.path ?? "")}`;
		}

		const visibleInput = Object.fromEntries(
			Object.entries(input).filter(([key]) => key !== "timeout"),
		);
		return `Pi wants to use the ${toolName} tool with:\n\n${JSON.stringify(visibleInput, null, 2)}`;
	}

	async function askPermission(
		toolName: string,
		input: Record<string, unknown>,
		ctx: ExtensionContext,
	) {
		// Some Pi execution contexts are non-interactive, such as API/SDK usage,
		// scripts, CI, or headless runs. In those cases Pi cannot pause to show
		// ctx.ui prompts, so fail closed instead of allowing unsafe tools silently.
		if (!ctx.hasUI) {
			return {
				allowed: false as const,
				reason: `Blocked non-read tool call "${toolName}" because no UI is available for confirmation.`,
			};
		}

		const message = `${describeToolCall(toolName, input)}\n\nAllow this?`;
		const choice = await ctx.ui.select(`Permission required\n\n${message}`, [
			"Allow",
			"Deny",
			"Deny with reason",
		]);

		if (choice === "Allow") {
			return { allowed: true as const };
		}

		if (choice === "Deny with reason") {
			const denialReason = await ctx.ui.editor("Reason for denial");
			const trimmedReason = denialReason?.trim();

			return {
				allowed: false as const,
				reason: trimmedReason
					? `Blocked non-read tool call "${toolName}" by user. Reason:\n${trimmedReason}`
					: `Blocked non-read tool call "${toolName}" by user without a reason.`,
			};
		}

		return {
			allowed: false as const,
			reason: `Blocked non-read tool call "${toolName}" by user.`,
		};
	}

	// Ask as soon as the assistant message is complete, before tool execution starts.
	// This keeps the user's decision time out of the built-in tool duration display.
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return undefined;

		const content = event.message.content as Array<{
			type?: string;
			id?: string;
			name?: string;
			arguments?: Record<string, unknown>;
		}>;

		for (const block of content) {
			if (block.type !== "toolCall" || !block.id || !block.name) continue;

			const input = block.arguments ?? {};
			if (isAllowedToolCall(block.name, input) || decisions.has(block.id))
				continue;
			decisions.set(block.id, await askPermission(block.name, input, ctx));
		}

		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (
			isAllowedToolCall(event.toolName, event.input as Record<string, unknown>)
		)
			return undefined;

		// In the normal interactive path, message_end already collected the decision.
		// Fallback here covers any mode/provider path that reaches tool_call first.
		const decision =
			decisions.get(event.toolCallId) ??
			(await askPermission(
				event.toolName,
				event.input as Record<string, unknown>,
				ctx,
			));
		decisions.delete(event.toolCallId);

		if (decision.allowed) return undefined;
		return { block: true, reason: decision.reason };
	});
}
