/**
 * The violation dialog and its outcomes.
 *
 * Three ways forward, because two is not enough in practice: without a way to
 * silence a misfiring rule, a user facing the same false positive repeatedly
 * will disable the guard entirely.
 */

import type { ConstraintVerdict } from "./types.ts";

export const REWORK = "Send back for rework";
export const ALLOW_ONCE = "Allow this change";
export const IGNORE_SESSION = "Ignore this constraint for the session";

/** Order matters: rework is first so it reads as the default. */
export const DIALOG_OPTIONS = [REWORK, ALLOW_ONCE, IGNORE_SESSION];

export type DialogChoice = "rework" | "allow-once" | "ignore-session";

export interface DialogUI {
	select(title: string, options: string[]): Promise<string | undefined>;
}

/**
 * Asks what to do about the given violations.
 *
 * Escape (an undefined answer) maps to rework: dismissing the dialog must be
 * the safe action, not the permissive one.
 */
export async function askAboutViolations(
	ui: DialogUI,
	violations: ConstraintVerdict[],
): Promise<DialogChoice> {
	const answer = await ui.select(buildTitle(violations), DIALOG_OPTIONS);
	switch (answer) {
		case ALLOW_ONCE:
			return "allow-once";
		case IGNORE_SESSION:
			return "ignore-session";
		default:
			return "rework";
	}
}

/**
 * The probability is shown deliberately: it is the only way a user accumulates a
 * feel for where their own threshold should sit.
 */
function buildTitle(violations: ConstraintVerdict[]): string {
	const heading =
		violations.length === 1
			? "This change appears to violate a project constraint:"
			: `This change appears to violate ${violations.length} project constraints:`;

	const lines = violations.map((violation) => {
		const { constraint, probability } = violation;
		return `  • ${constraint.name}  [${constraint.sourceFile}, ${probability.toFixed(2)}]`;
	});

	return [heading, "", ...lines, "", "What would you like to do?"].join("\n");
}
