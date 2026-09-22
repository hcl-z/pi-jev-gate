/**
 * Deciding which tool calls to judge, and describing the change for the model.
 *
 * `write` and `edit` are always judged. Shell calls pass a local pre-filter
 * first: most shell calls only read, and sending every one of them would add
 * latency and cost to the common case until the user turns the guard off.
 *
 * pi has no delete tool and no mkdir tool, so deletions, moves and directory
 * creation can only reach the filesystem through a shell command. Covering only
 * `write` and `edit` would miss the destructive case entirely.
 */

import type { ChangeDescription } from "./types.ts";

/**
 * Change content budget. Jev's state shares a 32k-token window with the longest
 * question, and its published failure modes name large states as an accuracy
 * problem, so the change is capped well below the hard limit.
 */
const MAX_CHANGE_CHARS = 8000;

const TRUNCATION_NOTE = "\n[... change truncated, content above is incomplete]";

/**
 * Commands that suggest the filesystem is being modified.
 *
 * Deliberately over-inclusive: this is a cost optimisation, not a decision.
 * Anything plausibly mutating goes to the model, which decides whether it
 * violates a constraint. A regex must never have the final say.
 */
const MUTATING_COMMAND =
	/(^|[\s;&|(`])(rm|rmdir|unlink|mv|cp|mkdir|touch|truncate|tee|dd|install|ln|chmod|chown|shred|rsync|patch)([\s;&|)]|$)/;

/** In-place stream editing, which rewrites files without a mutating verb. */
const IN_PLACE_EDIT = /\b(sed|perl|ruby|gawk|awk)\b[^|;&]*\s-(-in-place|i\b|i')/;

/** Output redirection, excluding the `2>&1`-style descriptor duplications. */
const REDIRECTION = /(^|[^0-9>&])>>?(?!&)/;

/** Package managers and build tools that write into the working tree. */
const WRITES_TREE =
	/(^|[\s;&|(`])(npm|pnpm|yarn|bun|pip|pip3|poetry|uv|cargo|go|git)\s+(install|add|remove|rm|uninstall|init|clean|checkout|restore|reset|revert|apply|stash|mv)\b/;

/** PowerShell cmdlets that mutate the filesystem. */
const MUTATING_POWERSHELL =
	/\b(Remove-Item|New-Item|Move-Item|Copy-Item|Set-Content|Add-Content|Clear-Content|Rename-Item|Out-File|New-ItemProperty|Set-ItemProperty)\b/i;

export interface ToolCallLike {
	toolName: string;
	input: Record<string, unknown>;
}

/**
 * Returns a description of the change to judge, or undefined when the call
 * needs no judgment.
 */
export function describeChange(
	event: ToolCallLike,
): ChangeDescription | undefined {
	switch (event.toolName) {
		case "write":
			return describeWrite(event.input);
		case "edit":
			return describeEdit(event.input);
		case "bash":
			return describeShell(event.input, "bash");
		case "powershell":
			return describeShell(event.input, "powershell");
		default:
			return undefined;
	}
}

function describeWrite(
	input: Record<string, unknown>,
): ChangeDescription | undefined {
	const path = asString(input.path);
	if (path === undefined) return undefined;
	const content = asString(input.content) ?? "";
	const { text, truncated } = cap(content);
	return {
		operation: "create or overwrite a file",
		path,
		change: text,
		truncated,
	};
}

function describeEdit(
	input: Record<string, unknown>,
): ChangeDescription | undefined {
	const path = asString(input.path);
	if (path === undefined) return undefined;

	const edits = Array.isArray(input.edits) ? input.edits : [];
	// The edit pairs are already a diff, so the target file never needs reading.
	const rendered = edits
		.map((entry, index) => {
			if (typeof entry !== "object" || entry === null) return "";
			const pair = entry as Record<string, unknown>;
			const oldText = asString(pair.oldText) ?? "";
			const newText = asString(pair.newText) ?? "";
			return [
				`--- edit ${index + 1}: replaced text ---`,
				oldText,
				`--- edit ${index + 1}: replacement ---`,
				newText,
			].join("\n");
		})
		.filter((part) => part.length > 0)
		.join("\n\n");

	const { text, truncated } = cap(rendered);
	return { operation: "edit an existing file", path, change: text, truncated };
}

function describeShell(
	input: Record<string, unknown>,
	kind: "bash" | "powershell",
): ChangeDescription | undefined {
	const command = asString(input.command);
	if (command === undefined) return undefined;
	if (!mayMutateFilesystem(command, kind)) return undefined;

	const { text, truncated } = cap(command);
	return {
		operation: `run a ${kind} command that may change files`,
		change: text,
		truncated,
	};
}

export function mayMutateFilesystem(
	command: string,
	kind: "bash" | "powershell" = "bash",
): boolean {
	if (MUTATING_COMMAND.test(command)) return true;
	if (IN_PLACE_EDIT.test(command)) return true;
	if (REDIRECTION.test(command)) return true;
	if (WRITES_TREE.test(command)) return true;
	if (kind === "powershell" && MUTATING_POWERSHELL.test(command)) return true;
	return false;
}

function cap(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_CHANGE_CHARS) return { text, truncated: false };
	return {
		text: `${text.slice(0, MAX_CHANGE_CHARS)}${TRUNCATION_NOTE}`,
		truncated: true,
	};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
