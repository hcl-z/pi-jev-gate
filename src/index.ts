/**
 * Published entry point.
 *
 * A thin wrapper that supplies real implementations to the parameterised
 * factory in `guard.ts`. Tests drive that factory directly with doubles, so this
 * file stays small enough to need no tests of its own.
 */

import { readFileSync, readdirSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

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
 * pi's agent directory. Resolved from its own exported helper when available so
 * that rebranded distributions land in the right place, falling back to the
 * conventional path when the import is unavailable.
 */
function resolveAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}
