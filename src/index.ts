/**
 * Published entry point.
 *
 * A thin wrapper that supplies real implementations to the parameterised
 * factory in `guard.ts`. Tests drive that factory directly with doubles, so this
 * file stays small enough to need no tests of its own.
 */

import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { createGuard } from "./guard.ts";
import type { Deps } from "./types.ts";

/** Log file name inside pi's agent directory. */
const LOG_FILE = "jev-guard.jsonl";

export default function jevGuard(pi: unknown): void {
	createGuard(pi as never, realDeps());
}

function realDeps(): Deps {
	const agentDir = resolveAgentDir();
	const logPath = join(agentDir, LOG_FILE);

	return {
		http: async (url, init) => {
			const response = await fetch(url, {
				method: init.method,
				headers: init.headers,
				body: init.body,
				signal: init.signal ?? null,
			});
			return {
				ok: response.ok,
				status: response.status,
				text: () => response.text(),
			};
		},

		fs: {
			listDir: (dir) => {
				try {
					return readdirSync(dir);
				} catch {
					return undefined;
				}
			},
			mtimeMs: (path) => {
				try {
					return statSync(path).mtimeMs;
				} catch {
					return undefined;
				}
			},
			readFile: (path) => {
				try {
					return readFileSync(path, "utf8");
				} catch {
					return undefined;
				}
			},
		},

		readSettings: () => {
			try {
				return readFileSync(join(agentDir, "settings.json"), "utf8");
			} catch {
				return undefined;
			}
		},

		now: () => Date.now(),
		timestamp: () => new Date().toISOString(),

		log: (line) => {
			mkdirSync(dirname(logPath), { recursive: true });
			appendFileSync(logPath, `${line}\n`, "utf8");
		},

		env: (name) => process.env[name],
	};
}

/**
 * pi's agent directory.
 *
 * Resolved through pi's own exported helper so a rebranded distribution, or one
 * configured with a different agent directory, lands in the right place. The
 * conventional path is only a fallback for a pi too old to export it.
 */
function resolveAgentDir(): string {
	try {
		const dir = getAgentDir();
		if (typeof dir === "string" && dir.length > 0) return dir;
	} catch {
		// Fall through to the conventional location.
	}
	return join(homedir(), ".pi", "agent");
}
