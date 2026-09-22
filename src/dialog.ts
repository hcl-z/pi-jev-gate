/**
 * The violation dialog and its outcomes.
 *
 * Three ways forward, because two is not enough in practice: without a way to
 * silence a misfiring rule, a user facing the same false positive repeatedly
 * will disable the guard entirely.
 */

import type { Constraint, ConstraintVerdict } from "./types.ts";

export const REWORK = "Send back for rework";
export const ALLOW_ONCE = "Allow this change";
export const IGNORE_SESSION = "Ignore this constraint for the session";
export const IGNORE_SESSION_PICK = "Ignore one of these constraints…";

/** Order matters: rework is first so it reads as the default. */
export function dialogOptions(violationCount: number): string[] {
	return [
		REWORK,
		ALLOW_ONCE,
		// The label must not promise to silence one rule while silencing several.
		violationCount === 1 ? IGNORE_SESSION : IGNORE_SESSION_PICK,
	];
}

export type DialogOutcome =
	| { choice: "rework" }
	| { choice: "allow-once" }
	/** Exactly the constraints the user named. */
	| { choice: "ignore-session"; constraints: Constraint[] };

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
): Promise<DialogOutcome> {
	const answer = await ui.select(
		buildTitle(violations),
		dialogOptions(violations.length),
	);

	if (answer === ALLOW_ONCE) return { choice: "allow-once" };

	if (answer === IGNORE_SESSION) {
		const only = violations[0];
		// Only offered when there is exactly one violation.
		return only
			? { choice: "ignore-session", constraints: [only.constraint] }
			: { choice: "rework" };
	}

	if (answer === IGNORE_SESSION_PICK) {
		return pickConstraintToIgnore(ui, violations);
	}

	return { choice: "rework" };
}

/**
 * With several rules fired at once, silencing all of them on one keypress would
 * disable rules the user never named. Make them name one.
 */
async function pickConstraintToIgnore(
	ui: DialogUI,
	violations: ConstraintVerdict[],
): Promise<DialogOutcome> {
	const labels = violations.map((violation) => violation.constraint.name);
	const answer = await ui.select(
		"Which constraint should stop being checked this session?",
		labels,
	);

	// Escape out of the sub-selection falls back to the safe action.
	if (answer === undefined) return { choice: "rework" };

	const index = labels.indexOf(answer);
	const chosen = violations[index]?.constraint;
	if (!chosen) return { choice: "rework" };

	return { choice: "ignore-session", constraints: [chosen] };
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
