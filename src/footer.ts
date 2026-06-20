import { relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "./allowed-tool-calls.ts";
import {
	modeLabels,
	modeThemeColors,
	permissionModeStorageKey,
} from "./permission-mode.ts";

/**
 * Formats the current working directory compactly for footer display.
 */
function formatCwdForFooter(cwd: string) {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!resolve(relativeToHome).startsWith(".."));

	return isInsideHome
		? relativeToHome === ""
			? "~"
			: `~${sep}${relativeToHome}`
		: cwd;
}

/**
 * Formats token counts for compact footer display.
 */
function formatTokens(count: number) {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Truncates plain text to fit the requested terminal width.
 */
function truncatePlainText(text: string, width: number, ellipsis = "...") {
	if (text.length <= width) return text;
	if (width <= 0) return "";
	if (width <= ellipsis.length) return ellipsis.slice(0, width);
	return `${text.slice(0, width - ellipsis.length)}${ellipsis}`;
}

/**
 * Installs a custom footer that renders the active mode on the cwd line.
 */
export function installModeFooter(
	ctx: ExtensionContext,
	getActiveMode: () => PermissionMode,
) {
	if (!ctx.hasUI) return;

	ctx.ui.setWidget(permissionModeStorageKey, undefined);
	ctx.ui.setStatus(permissionModeStorageKey, undefined);
	ctx.ui.setFooter((_tui, theme, footerData) => {
		return {
			invalidate() {},
			render(width: number) {
				let cwd = formatCwdForFooter(ctx.cwd);
				const branch = footerData.getGitBranch();
				if (branch) cwd = `${cwd} (${branch})`;

				const activeMode = getActiveMode();
				const modeText = `Mode: ${modeLabels[activeMode]}`;
				const coloredModeText = `${theme.fg("dim", "Mode: ")}${theme.fg(
					modeThemeColors[activeMode],
					modeLabels[activeMode],
				)}`;
				const cwdAvailableWidth = Math.max(0, width - modeText.length - 2);
				const visibleCwd = truncatePlainText(cwd, cwdAvailableWidth);
				const padding = " ".repeat(
					Math.max(1, width - visibleCwd.length - modeText.length),
				);
				const cwdLine = theme.fg("dim", visibleCwd) + padding + coloredModeText;

				const usage = ctx.getContextUsage();
				const usageText = usage
					? `${usage.percent === null ? "?" : usage.percent.toFixed(1)}%/${formatTokens(usage.contextWindow)}`
					: "?";
				const modelText = ctx.model?.id ?? "no-model";
				const statsPadding = " ".repeat(
					Math.max(1, width - usageText.length - modelText.length),
				);
				const statsLine = theme.fg(
					"dim",
					`${usageText}${statsPadding}${modelText}`,
				);

				const extensionStatuses = Array.from(
					footerData.getExtensionStatuses().entries(),
				)
					.filter(([key]) => key !== permissionModeStorageKey)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, text]) => text.replace(/[\r\n\t]/g, " ").trim())
					.filter(Boolean);

				return extensionStatuses.length > 0
					? [
							cwdLine,
							statsLine,
							truncatePlainText(extensionStatuses.join(" "), width),
						]
					: [cwdLine, statsLine];
			},
		};
	});
}
