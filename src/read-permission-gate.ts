import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	canRunToolCallInMode,
	isPermissionMode,
	type PermissionMode,
	permissionModes,
} from "./allowed-tool-calls.ts";
import { installModeFooter } from "./footer.ts";
import { askPermissionForModeOverride } from "./permission-dialog.ts";
import {
	getCycledPermissionMode,
	modeDescriptions,
	modeLabels,
	permissionModeStorageKey,
	restorePermissionModeFromEntries,
} from "./permission-mode.ts";

/**
 * Read Permission Gate
 *
 * Enforces the active permission mode, asks for user approval before mode
 * overrides, and renders the active mode in the TUI footer.
 */
export default function (pi: ExtensionAPI) {
	let activeMode: PermissionMode = "default";

	/**
	 * Renders the current mode in the custom footer when UI is available.
	 */
	function renderModeStatus(ctx: ExtensionContext) {
		installModeFooter(ctx, () => activeMode);
	}

	/**
	 * Changes the active mode and persists the change in the current session.
	 */
	function setMode(mode: PermissionMode, ctx: ExtensionContext) {
		activeMode = mode;
		pi.appendEntry(permissionModeStorageKey, { mode });
		renderModeStatus(ctx);
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
		renderModeStatus(ctx);
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
		const decision = canRunToolCallInMode(activeMode, event.toolName, input);

		if (decision.allowed) return undefined;

		const permission = await askPermissionForModeOverride(
			activeMode,
			event.toolName,
			input,
			decision.reason,
			ctx,
		);
		if (permission.allowed) return undefined;

		return { block: true, reason: permission.reason };
	});
}
