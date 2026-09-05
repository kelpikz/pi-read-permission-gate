import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	addSessionAllowances,
	canRunToolCallInMode,
	getPermissionRequiredToolCalls,
	isPermissionMode,
	type PermissionMode,
	type PermissionToolCall,
	permissionModes,
	type SessionAllowances,
} from "./allowed-tool-calls.ts";
import { askPermissionForModeOverride } from "./permission-dialog.ts";
import {
	getCycledPermissionMode,
	modeDescriptions,
	modeLabels,
	modeThemeColors,
	permissionModeStorageKey,
	restorePermissionModeFromEntries,
} from "./permission-mode.ts";

type AssistantToolCall = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
};

/** Returns true when a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Identifies tool-call content blocks in a persisted assistant message. */
function isAssistantToolCall(value: unknown): value is AssistantToolCall {
	if (!isRecord(value)) return false;

	return (
		value.type === "toolCall" &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		isRecord(value.arguments)
	);
}

/**
 * Returns the current and later calls from the assistant message being
 * preflighted, or just the current call when the message is unavailable.
 */
function getPendingAssistantToolCalls(
	ctx: ExtensionContext,
	currentToolCallId: string,
	currentToolCall: PermissionToolCall,
): PermissionToolCall[] {
	const branch = ctx.sessionManager.getBranch();

	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}

		const assistantToolCalls =
			entry.message.content.filter(isAssistantToolCall);
		const currentIndex = assistantToolCalls.findIndex(
			(toolCall) => toolCall.id === currentToolCallId,
		);
		if (currentIndex < 0) continue;

		return assistantToolCalls
			.slice(currentIndex)
			.map((toolCall) =>
				toolCall.id === currentToolCallId
					? currentToolCall
					: { toolName: toolCall.name, input: toolCall.arguments },
			);
	}

	return [currentToolCall];
}

/**
 * Collects only the calls that need approval from the current parallel batch.
 * Read-only siblings stay out of the prompt, while nested wrappers are
 * flattened by getPermissionRequiredToolCalls().
 */
function getPermissionCallsForPrompt(
	activeMode: PermissionMode,
	currentToolCallId: string,
	currentToolCall: PermissionToolCall,
	sessionAllowances: SessionAllowances,
	ctx: ExtensionContext,
): PermissionToolCall[] {
	const pendingToolCalls = getPendingAssistantToolCalls(
		ctx,
		currentToolCallId,
		currentToolCall,
	);
	const permissionRequiredToolCalls = pendingToolCalls.flatMap((toolCall) =>
		getPermissionRequiredToolCalls(
			activeMode,
			toolCall.toolName,
			toolCall.input,
			sessionAllowances,
		),
	);

	return permissionRequiredToolCalls.length > 0
		? permissionRequiredToolCalls
		: [currentToolCall];
}

/**
 * Read Permission Gate
 *
 * Enforces the active permission mode, asks for user approval before mode
 * overrides, and publishes the active mode as a Pi UI status.
 */
export default function (pi: ExtensionAPI) {
	let activeMode: PermissionMode = "default";

	// Approvals granted via "Allow for this session" in the permission dialog.
	// Kept in memory so they reset whenever pi restarts.
	const sessionAllowances = {
		allowedTools: new Set<string>(),
		allowedBashCommandPrefixes: new Set<string>(),
	};

	/**
	 * Publishes the current mode through Pi's built-in extension-status footer.
	 */
	function updateModeStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		ctx.ui.setStatus(
			permissionModeStorageKey,
			`${ctx.ui.theme.fg("dim", "Mode: ")}${ctx.ui.theme.fg(
				modeThemeColors[activeMode],
				modeLabels[activeMode],
			)}`,
		);
	}

	/**
	 * Changes the active mode and persists the change in the current session.
	 */
	function setMode(mode: PermissionMode, ctx: ExtensionContext) {
		activeMode = mode;
		pi.appendEntry(permissionModeStorageKey, { mode });
		updateModeStatus(ctx);
	}

	/**
	 * Moves to the next or previous mode, wrapping around at either end.
	 */
	function cycleMode(direction: 1 | -1, ctx: ExtensionContext) {
		const nextMode = getCycledPermissionMode(
			activeMode,
			permissionModes,
			direction,
		);

		setMode(nextMode, ctx);
		ctx.ui.notify(`Permission mode: ${modeLabels[nextMode]}`, "info");
	}

	/**
	 * Restores the most recently selected mode from the session history.
	 */
	function restoreMode(ctx: ExtensionContext) {
		activeMode = restorePermissionModeFromEntries(
			ctx.sessionManager.getEntries(),
			isPermissionMode,
			activeMode,
		);
	}

	pi.on("session_start", (_event, ctx) => {
		restoreMode(ctx);
		updateModeStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(permissionModeStorageKey, undefined);
	});

	pi.registerCommand("permission-mode", {
		description: "Switch read-permission-gate mode: default, write, or yolo",
		getArgumentCompletions: (prefix) =>
			permissionModes
				.filter((mode) => mode.startsWith(prefix.trim()))
				.map((mode) => ({
					value: mode,
					label: `${modeLabels[mode]} - ${modeDescriptions[mode]}`,
				})),
		handler: async (args, ctx) => {
			const requestedMode = args.trim().toLowerCase();
			let nextMode: PermissionMode | undefined;

			if (requestedMode) {
				if (!isPermissionMode(requestedMode)) {
					ctx.ui.notify(
						`Unknown mode "${requestedMode}". Use one of: ${permissionModes.join(", ")}`,
						"error",
					);
					return;
				}
				nextMode = requestedMode;
			} else if (ctx.hasUI) {
				const choice = await ctx.ui.select("Select permission mode", [
					"default",
					"write",
					"yolo",
				]);
				if (!choice || !isPermissionMode(choice)) return;
				nextMode = choice;
			} else {
				return;
			}

			setMode(nextMode, ctx);
			ctx.ui.notify(`Permission mode: ${modeLabels[nextMode]}`, "info");
		},
	});

	pi.registerCommand("mode", {
		description: "Alias for /permission-mode",
		getArgumentCompletions: (prefix) =>
			permissionModes
				.filter((mode) => mode.startsWith(prefix.trim()))
				.map((mode) => ({ value: mode, label: modeLabels[mode] })),
		handler: async (args, ctx) => {
			const requestedMode = args.trim().toLowerCase();
			if (!isPermissionMode(requestedMode)) {
				ctx.ui.notify(`Usage: /mode ${permissionModes.join("|")}`, "error");
				return;
			}

			setMode(requestedMode, ctx);
			ctx.ui.notify(`Permission mode: ${modeLabels[requestedMode]}`, "info");
		},
	});

	// Use Alt-based shortcuts because Ctrl+M is the same terminal control
	// character as Enter and prevents users from submitting messages.
	pi.registerShortcut("alt+m", {
		description: "Cycle to the next read-permission-gate mode",
		handler: async (ctx) => {
			cycleMode(1, ctx);
		},
	});

	pi.registerShortcut("alt+shift+m", {
		description: "Cycle to the previous read-permission-gate mode",
		handler: async (ctx) => {
			cycleMode(-1, ctx);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		const decision = canRunToolCallInMode(
			activeMode,
			event.toolName,
			input,
			sessionAllowances,
		);

		if (decision.allowed) return undefined;

		const currentToolCall = { toolName: event.toolName, input };
		const permissionRequiredToolCalls = getPermissionCallsForPrompt(
			activeMode,
			event.toolCallId,
			currentToolCall,
			sessionAllowances,
			ctx,
		);
		const permission = await askPermissionForModeOverride(
			activeMode,
			event.toolName,
			input,
			decision.reason,
			ctx,
			permissionRequiredToolCalls,
		);
		if (permission.outcome === "deny") {
			return { block: true, reason: permission.reason };
		}

		if (permission.outcome === "allow-session") {
			const approvedNames = addSessionAllowances(
				sessionAllowances,
				permissionRequiredToolCalls,
			);
			if (approvedNames.length > 0) {
				ctx.ui.notify(
					`Allowed for this session: ${approvedNames.join(", ")}`,
					"info",
				);
			}
		}

		return undefined;
	});
}
