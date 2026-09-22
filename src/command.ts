/**
 * The `/jev-guard` command.
 *
 * Its primary purpose is observability of parsing. A mismatch between the rules
 * a user thinks they wrote and the constraints the parser produced is the single
 * most likely failure of this feature, and without this command it is invisible.
 */

import type { Constraint, GuardConfig } from "./types.ts";

export const COMMAND_NAME = "jev-guard";

export const COMMAND_DESCRIPTION =
	"Show parsed project constraints and jev-guard status";

export interface CommandState {
	constraints: Constraint[];
	files: string[];
	config: GuardConfig;
	ignoredIds: Set<string>;
	enabled: boolean;
}

export interface CommandActions {
	clearIgnored(): void;
	setEnabled(enabled: boolean): void;
}

/**
 * Handles `/jev-guard [clear|on|off]`.
 *
 * Returns the lines to display, so the report is assertable without a terminal.
 */
export function runCommand(
	args: string,
	state: CommandState,
	actions: CommandActions,
): string[] {
	const argument = args.trim().toLowerCase();

	switch (argument) {
		case "clear":
			actions.clearIgnored();
			return ["jev-guard: the session ignore list is now empty."];
		case "off":
			actions.setEnabled(false);
			return [
				"jev-guard: disabled for this session. Re-enable with /jev-guard on.",
			];
		case "on":
			actions.setEnabled(true);
			return ["jev-guard: enabled."];
		case "":
			return report(state);
		default:
			return [
				`jev-guard: unknown argument "${argument}".`,
				"Usage: /jev-guard [clear|on|off]",
			];
	}
}

function report(state: CommandState): string[] {
	const lines: string[] = [];

	lines.push(
		state.enabled
			? "jev-guard: active"
			: "jev-guard: disabled for this session (/jev-guard on to re-enable)",
	);
	lines.push("");

	lines.push("Configuration");
	// Redacted, so a shared screenshot is not a credential leak.
	lines.push(`  api key    ${redact(state.config.apiKey)}`);
	lines.push(`  threshold  ${state.config.threshold}`);
	lines.push(`  model      ${state.config.model}`);
	lines.push(`  log        ${state.config.log ? "on" : "off"}`);
	lines.push("");

	if (state.constraints.length === 0) {
		lines.push("Constraints: none found.");
		lines.push(
			"  Add constraints.md to the project root or docs/, using ## headings",
		);
		lines.push("  or a top-level bullet list, one rule each.");
		return lines;
	}

	lines.push(
		`Constraints: ${state.constraints.length} parsed from ${state.files.join(", ")}`,
	);
	for (const constraint of state.constraints) {
		const ignoredMark = state.ignoredIds.has(constraint.id)
			? "  [ignored this session]"
			: "";
		lines.push(`  • ${constraint.name}${ignoredMark}`);
		lines.push(`      from ${constraint.sourceFile}`);
		// The body is what actually reaches the model, so show where the split
		// landed rather than only the name.
		lines.push(`      ${summarise(constraint.text)}`);
	}

	const ignoredCount = state.constraints.filter((c) =>
		state.ignoredIds.has(c.id),
	).length;
	lines.push("");
	lines.push(
		ignoredCount === 0
			? "Ignored this session: none"
			: `Ignored this session: ${ignoredCount} (/jev-guard clear to restore)`,
	);

	return lines;
}

/** One line of the body, so a long rule does not flood the report. */
function summarise(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= 100) return collapsed;
	return `${collapsed.slice(0, 97)}...`;
}

function redact(apiKey: string | undefined): string {
	if (apiKey === undefined) {
		return "not set (TYPESAFE_API_KEY or jevGuard.apiKey)";
	}
	if (apiKey.length <= 4) return "set (****)";
	return `set (****${apiKey.slice(-4)})`;
}
