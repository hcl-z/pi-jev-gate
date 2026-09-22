/**
 * The decision log.
 *
 * One JSON record per line, because the log's primary purpose is threshold
 * calibration: the user needs to aggregate across many checks and correlate
 * probabilities against their own recorded choices. Line-delimited JSON is what
 * `jq` and friends expect; prose would not survive two hundred checks.
 *
 * Change content is written unredacted. The log lives in pi's agent directory,
 * outside any project, so it cannot be committed. The API key never appears.
 */

import type {
	ChangeDescription,
	Constraint,
	ConstraintVerdict,
	GuardConfig,
	LogSink,
} from "./types.ts";
import { messageOf } from "./util.ts";

export type LogVerdict =
	| "allowed"
	| "blocked"
	| "allowed-once"
	| "ignored"
	| "degraded";

export interface LogRecord {
	timestamp: string;
	tool: string;
	path?: string;
	operation: string;
	change: string;
	changeTruncated: boolean;
	constraints: { id: string; name: string; sourceFile: string }[];
	probabilities?: Record<string, number>;
	violations?: string[];
	/** Constraints the user chose to silence, when they silenced any. */
	ignoredIds?: string[];
	threshold: number;
	model: string;
	verdict: LogVerdict;
	/** Present only when the verdict is `degraded`. */
	degradedReason?: string;
	/** Which dialog option the user chose, when they were asked. */
	userChoice?: string;
	elapsedMs: number;
	inputTokens?: number;
	outputTokens?: number;
}

export interface LogInput {
	tool: string;
	change: ChangeDescription;
	constraints: Constraint[];
	verdicts?: ConstraintVerdict[];
	violations?: ConstraintVerdict[];
	ignoredIds?: string[];
	config: GuardConfig;
	verdict: LogVerdict;
	degradedReason?: string;
	userChoice?: string;
	elapsedMs: number;
	inputTokens?: number;
	outputTokens?: number;
	/** The versioned model that answered, when one did. */
	answeredBy?: string;
}

/**
 * Writes one record, swallowing sink failures.
 *
 * A full disk or a permissions problem must never change whether a tool call is
 * allowed, so the caller is told only whether to warn — once.
 */
export class DecisionLog {
	private readonly sink: LogSink;
	private readonly timestamp: () => string;
	private warned = false;

	constructor(sink: LogSink, timestamp: () => string) {
		this.sink = sink;
		this.timestamp = timestamp;
	}

	/** Returns a warning message the first time writing fails, else undefined. */
	write(input: LogInput): string | undefined {
		let line: string;
		try {
			line = JSON.stringify(this.buildRecord(input));
		} catch (error) {
			return this.warnOnce(messageOf(error));
		}

		try {
			this.sink(line);
			return undefined;
		} catch (error) {
			return this.warnOnce(messageOf(error));
		}
	}

	private warnOnce(reason: string): string | undefined {
		if (this.warned) return undefined;
		this.warned = true;
		return `jev-guard: could not write the decision log (${reason}); logging is now off for this session`;
	}

	private buildRecord(input: LogInput): LogRecord {
		const record: LogRecord = {
			timestamp: this.timestamp(),
			tool: input.tool,
			operation: input.change.operation,
			change: input.change.change,
			changeTruncated: input.change.truncated,
			constraints: input.constraints.map((constraint) => ({
				id: constraint.id,
				name: constraint.name,
				sourceFile: constraint.sourceFile,
			})),
			threshold: input.config.threshold,
			// The versioned model that actually answered, falling back to the
			// requested name when nothing answered (a degraded check).
			model: input.answeredBy ?? input.config.model,
			verdict: input.verdict,
			elapsedMs: input.elapsedMs,
		};

		if (input.change.path !== undefined) record.path = input.change.path;

		if (input.verdicts) {
			const probabilities: Record<string, number> = {};
			for (const verdict of input.verdicts) {
				probabilities[verdict.constraint.id] = verdict.probability;
			}
			record.probabilities = probabilities;
		}

		if (input.violations) {
			record.violations = input.violations.map((v) => v.constraint.id);
		}
		if (input.ignoredIds) record.ignoredIds = input.ignoredIds;

		if (input.degradedReason !== undefined) {
			record.degradedReason = input.degradedReason;
		}
		if (input.userChoice !== undefined) record.userChoice = input.userChoice;
		if (input.inputTokens !== undefined) record.inputTokens = input.inputTokens;
		if (input.outputTokens !== undefined) {
			record.outputTokens = input.outputTokens;
		}

		return record;
	}
}
