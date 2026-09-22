/**
 * Locating and reading the project's constraints files.
 *
 * Two locations are searched: the project root, where a human contributor will
 * look, and `docs/`, which is where `AGENTS.md` conventionally points. Both are
 * read and merged rather than one taking precedence — a rule that was written
 * but silently ignored is the worst failure this feature can have.
 */

import { join } from "node:path";

import type { Constraint, FileSystemReader } from "./types.ts";
import { parseConstraints } from "./parse-constraints.ts";

const FILE_NAME = "constraints.md";

/** Relative directories searched, in the order their constraints are merged. */
const SEARCH_DIRS = ["", "docs"];

interface CachedFile {
	mtimeMs: number;
	constraints: Constraint[];
}

export interface ConstraintSet {
	constraints: Constraint[];
	/** Relative paths actually read, for the inspection command. */
	files: string[];
}

/**
 * Reads constraints, re-reading only files whose modification time changed.
 *
 * Rules are edited while work is in progress, so requiring a restart to pick up
 * a tightened rule would be a constant irritation. A `stat` per check is
 * negligible against a network round trip.
 */
export class ConstraintLoader {
	private cache = new Map<string, CachedFile>();
	private readonly fs: FileSystemReader;

	constructor(fs: FileSystemReader) {
		this.fs = fs;
	}

	load(cwd: string): ConstraintSet {
		const constraints: Constraint[] = [];
		const files: string[] = [];

		for (const dir of SEARCH_DIRS) {
			const found = this.findFile(cwd, dir);
			if (!found) continue;
			const parsed = this.readCached(found.absolute, found.relative);
			if (parsed.length === 0) continue;
			constraints.push(...parsed);
			files.push(found.relative);
		}

		return { constraints, files };
	}

	/**
	 * Matches the filename case-insensitively by listing the directory rather
	 * than probing fixed spellings, so `CONSTRAINTS.md` and `Constraints.md`
	 * work without enumerating variants.
	 */
	private findFile(
		cwd: string,
		dir: string,
	): { absolute: string; relative: string } | undefined {
		const searchDir = dir.length > 0 ? join(cwd, dir) : cwd;
		const entries = this.fs.listDir(searchDir);
		if (!entries) return undefined;

		const match = entries.find((name) => name.toLowerCase() === FILE_NAME);
		if (match === undefined) return undefined;

		return {
			absolute: join(searchDir, match),
			relative: dir.length > 0 ? `${dir}/${match}` : match,
		};
	}

	private readCached(absolute: string, relative: string): Constraint[] {
		const mtimeMs = this.fs.mtimeMs(absolute);
		if (mtimeMs === undefined) {
			this.cache.delete(absolute);
			return [];
		}

		const cached = this.cache.get(absolute);
		if (cached && cached.mtimeMs === mtimeMs) return cached.constraints;

		const text = this.fs.readFile(absolute);
		if (text === undefined) {
			this.cache.delete(absolute);
			return [];
		}

		const constraints = parseConstraints(text, relative);
		this.cache.set(absolute, { mtimeMs, constraints });
		return constraints;
	}
}
