/**
 * Small helpers shared across modules.
 *
 * These exist because the same shapes were being written out per-module. Keep
 * this file narrow: it is a home for genuinely generic utilities, not a bag for
 * anything that resists placement.
 */

/** Narrows to a plain object, excluding arrays and null. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An error's message, for user-facing text. */
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Caps text, appending an explicit marker when it had to be cut.
 *
 * The marker matters as much as the cap: a silently truncated change would
 * misrepresent itself to the model as complete.
 */
export function capWithMarker(
	text: string,
	maxChars: number,
	marker: string,
): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: `${text.slice(0, maxChars)}${marker}`, truncated: true };
}
