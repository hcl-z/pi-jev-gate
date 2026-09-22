/**
 * Types shared across the extension.
 *
 * The `Deps` interface is the testing seam: the parameterised factory takes it,
 * the published entry point supplies real implementations.
 */

/** One constraint parsed out of a constraints file. */
export interface Constraint {
	/** Stable identity used for the session ignore list and log records. */
	id: string;
	/** Display name, derived from a heading or from the bullet's own text. */
	name: string;
	/** The constraint body handed to the model and back to the agent. */
	text: string;
	/** Which file this came from, relative to the project root. */
	sourceFile: string;
}

/** Resolved configuration, after defaults and environment overrides. */
export interface GuardConfig {
	apiKey: string | undefined;
	threshold: number;
	model: string;
	log: boolean;
}

/** The change being judged, as sent to the model. */
export interface ChangeDescription {
	/** Human-readable operation kind, e.g. "write file", "run shell command". */
	operation: string;
	/** Target path when the tool call names one. */
	path?: string;
	/** The change itself: file content, edit pairs, or command text. */
	change: string;
	/** True when `change` was truncated to fit the budget. */
	truncated: boolean;
}

/** A single question's answer from the model. */
export interface ConstraintVerdict {
	constraint: Constraint;
	probability: number;
}

/** Outcome of one Jev evaluation. */
export type EvaluationResult =
	| {
			outcome: "evaluated";
			verdicts: ConstraintVerdict[];
			inputTokens: number | undefined;
			outputTokens: number | undefined;
			model: string;
	  }
	| {
			/** Anything that prevented a verdict. The call proceeds. */
			outcome: "degraded";
			reason: string;
	  };

/** HTTP transport, injected so tests never touch the network. */
export interface HttpTransport {
	(
		url: string,
		init: {
			method: string;
			headers: Record<string, string>;
			body: string;
			signal?: AbortSignal | undefined;
		},
	): Promise<HttpResponse>;
}

export interface HttpResponse {
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

/** Log sink, injected so tests capture records instead of writing files. */
export interface LogSink {
	(line: string): void;
}

/** Filesystem reads, injected so tests use fixtures without real paths. */
export interface FileSystemReader {
	/** Directory entry names, or undefined when the directory does not exist. */
	listDir(dir: string): string[] | undefined;
	/** Modification time in ms, or undefined when the file does not exist. */
	mtimeMs(path: string): number | undefined;
	/** File contents, or undefined when unreadable. */
	readFile(path: string): string | undefined;
}

/** Everything the extension needs from the outside world. */
export interface Deps {
	http: HttpTransport;
	fs: FileSystemReader;
	/** Reads the raw settings JSON text, or undefined when absent. */
	readSettings(): string | undefined;
	/** Monotonic-ish clock for elapsed-time measurement. */
	now(): number;
	/** Current wall-clock time as an ISO string, for log timestamps. */
	timestamp(): string;
	log: LogSink;
	/** Environment lookup, so tests control TYPESAFE_API_KEY. */
	env(name: string): string | undefined;
}
