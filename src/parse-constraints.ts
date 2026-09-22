/**
 * Splitting a constraints document into individual constraints.
 *
 * Bullets under a heading belong to that heading's constraint rather than
 * becoming constraints of their own: Jev's documented weakness on contradictory
 * instructions means a rule and its exception must be judged together, or they
 * fight each other.
 */

import type { Constraint } from "./types.ts";
import { capWithMarker } from "./util.ts";

/** Long constraints are truncated so one rule cannot crowd out the rest. */
const MAX_CONSTRAINT_CHARS = 4000;

const HEADING = /^(#{2,3})\s+(.+?)\s*$/;
const TOP_LEVEL_BULLET = /^[-*+]\s+(.+)$/;

export function parseConstraints(
	text: string,
	sourceFile: string,
): Constraint[] {
	const lines = stripFences(text.split(/\r?\n/));
	const bySection = parseHeadingSections(lines, sourceFile);
	if (bySection.length > 0) return bySection;
	return parseTopLevelBullets(lines, sourceFile);
}

/**
 * Fenced code blocks are neutralised before parsing so that a `## comment` or a
 * `- item` inside an example cannot be mistaken for a constraint boundary.
 */
function stripFences(lines: string[]): string[] {
	const result: string[] = [];
	let inFence = false;
	for (const line of lines) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			result.push(line);
			continue;
		}
		result.push(inFence ? `\u0000${line}` : line);
	}
	return result;
}

function unmask(line: string): string {
	return line.startsWith("\u0000") ? line.slice(1) : line;
}

function parseHeadingSections(
	lines: string[],
	sourceFile: string,
): Constraint[] {
	const constraints: Constraint[] = [];
	const names = new NameCounter();
	let current: { name: string; body: string[] } | undefined;

	const push = () => {
		if (!current) return;
		const body = current.body.join("\n").trim();
		// The name alone is often the whole rule ("## No new dependencies in
		// core"), so it must reach the model even when the section has no body.
		const text = body.length > 0 ? `${current.name}\n${body}` : current.name;
		constraints.push({
			id: names.idFor(sourceFile, current.name),
			name: current.name,
			text: truncate(text),
			sourceFile,
		});
		current = undefined;
	};

	for (const line of lines) {
		// `###` is a boundary on equal terms with `##`: people nest rules and
		// still mean one rule per heading.
		const heading = line.startsWith("\u0000") ? null : HEADING.exec(line);
		if (heading) {
			push();
			current = { name: heading[2] ?? "", body: [] };
			continue;
		}
		if (current) current.body.push(unmask(line));
	}
	push();

	return constraints;
}

function parseTopLevelBullets(
	lines: string[],
	sourceFile: string,
): Constraint[] {
	const constraints: Constraint[] = [];
	let current: string[] | undefined;


	const names = new NameCounter();

	const push = () => {
		if (!current) return;
		const text = truncate(current.join("\n").trim());
		if (text.length > 0) {
			const name = deriveName(text);
			constraints.push({
				id: names.idFor(sourceFile, name),
				name,
				text,
				sourceFile,
			});
		}
		current = undefined;
	};

	for (const raw of lines) {
		const masked = raw.startsWith("\u0000");
		const line = unmask(raw);
		const bullet = masked ? null : TOP_LEVEL_BULLET.exec(line);
		if (bullet) {
			push();
			current = [bullet[1] ?? ""];
			continue;
		}
		// Indented continuations and nested bullets extend the current rule.
		if (current && (line.trim().length === 0 || /^\s+/.test(line))) {
			current.push(line);
			continue;
		}
		if (current) push();
	}
	push();

	return constraints;
}

/** Bullet constraints have no heading to name them, so use their own opening. */
function deriveName(text: string): string {
	const firstLine = text.split("\n")[0]?.trim() ?? "";
	if (firstLine.length <= 60) return firstLine;
	return `${firstLine.slice(0, 57)}...`;
}

function truncate(text: string): string {
	return capWithMarker(text, MAX_CONSTRAINT_CHARS, "\n[constraint truncated]")
		.text;
}

/**
 * Constraint identity is `sourceFile#name`, not a position.
 *
 * A positional id would collide when two files are merged, and would shift
 * whenever a rule is reordered — silently moving a session-ignore entry onto a
 * different rule. Deriving it from the name keeps it stable across body edits
 * and reorderings. Repeated names within a file get an occurrence suffix.
 */
class NameCounter {
	private seen = new Map<string, number>();

	idFor(sourceFile: string, name: string): string {
		const base = `${sourceFile}#${name}`;
		const count = this.seen.get(base) ?? 0;
		this.seen.set(base, count + 1);
		return count === 0 ? base : `${base}~${count}`;
	}
}
