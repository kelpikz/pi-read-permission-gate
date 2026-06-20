import type { PermissionMode } from "./allowed-tool-calls.ts";

export const permissionModeStorageKey = "read-permission-gate-mode";

export const modeLabels: Record<PermissionMode, string> = {
	default: "Default",
	write: "Write",
	yolo: "YOLO",
};

export const modeDescriptions: Record<PermissionMode, string> = {
	default: "read-only operations only",
	write: "file writes allowed; unsafe bash/CLIs blocked",
	yolo: "all tool calls allowed",
};

export const modeThemeColors: Record<
	PermissionMode,
	"accent" | "warning" | "error"
> = {
	default: "accent",
	write: "warning",
	yolo: "error",
};

type StoredPermissionModeEntry = {
	type: string;
	customType?: string;
	data?: unknown;
};

/**
 * Returns the next or previous permission mode, wrapping around at either end.
 */
export function getCycledPermissionMode(
	currentMode: PermissionMode,
	permissionModes: readonly PermissionMode[],
	direction: 1 | -1,
) {
	const currentIndex = permissionModes.indexOf(currentMode);
	const nextIndex =
		(currentIndex + direction + permissionModes.length) %
		permissionModes.length;
	return permissionModes[nextIndex];
}

/**
 * Restores the last persisted permission mode from session entries.
 */
export function restorePermissionModeFromEntries(
	entries: readonly StoredPermissionModeEntry[],
	isPermissionMode: (value: string) => value is PermissionMode,
	fallbackMode: PermissionMode,
) {
	let restoredMode = fallbackMode;

	for (const entry of entries) {
		if (
			entry.type !== "custom" ||
			entry.customType !== permissionModeStorageKey
		) {
			continue;
		}

		const mode = (entry.data as { mode?: unknown } | undefined)?.mode;
		if (typeof mode === "string" && isPermissionMode(mode)) {
			restoredMode = mode;
		}
	}

	return restoredMode;
}
