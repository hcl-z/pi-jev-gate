/**
 * Test doubles for pi's extension API and context, plus for the injected deps.
 *
 * These implement only the surface the extension actually touches. They are
 * deliberately structural rather than typed against pi's full interfaces: the
 * real interfaces carry dozens of members the extension never uses, and
 * stubbing all of them would obscure which parts matter.
 */

import type {
	Deps,
	FileSystemReader,
	HttpResponse,
	HttpTransport,
} from "../src/types.ts";

export interface NotifyRecord {
	message: string;
	type: string;
}

export interface SelectRecord {
	title: string;
	options: string[];
}

/** Scripted UI: records what was asked, answers from a queue. */
export class FakeUI {
	notifications: NotifyRecord[] = [];
	selects: SelectRecord[] = [];
	statuses = new Map<string, string | undefined>();
	/** Answers returned by successive `select` calls. `undefined` means Escape. */
	selectAnswers: (string | undefined)[] = [];

	notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		this.notifications.push({ message, type });
	}

	async select(title: string, options: string[]): Promise<string | undefined> {
		this.selects.push({ title, options });
		if (this.selectAnswers.length === 0) {
			throw new Error(
				`FakeUI.select called with no scripted answer left: ${title}`,
			);
		}
		return this.selectAnswers.shift();
	}

	async confirm(): Promise<boolean> {
		throw new Error("FakeUI.confirm should not be used by this extension");
	}

	setStatus(key: string, text: string | undefined): void {
		this.statuses.set(key, text);
	}

	/** Every notification message joined, for substring assertions. */
	notifiedText(): string {
		return this.notifications.map((n) => n.message).join("\n");
	}
}

export interface FakeContextOptions {
	cwd?: string;
	hasUI?: boolean;
	mode?: string;
	signal?: AbortSignal;
}

/** Minimal stand-in for pi's ExtensionContext. */
export class FakeContext {
	ui = new FakeUI();
	cwd: string;
	hasUI: boolean;
	mode: string;
	signal: AbortSignal | undefined;

	constructor(options: FakeContextOptions = {}) {
		this.cwd = options.cwd ?? "/project";
		this.hasUI = options.hasUI ?? true;
		this.mode = options.mode ?? "tui";
		this.signal = options.signal;
	}
}

export type ToolCallHandler = (
	event: unknown,
	ctx: unknown,
) => Promise<{ block?: boolean; reason?: string } | void>;

export interface RegisteredCommandStub {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

/** Minimal stand-in for pi's ExtensionAPI: captures registrations. */
export class FakeExtensionAPI {
	handlers = new Map<string, ToolCallHandler[]>();
	commands = new Map<string, RegisteredCommandStub>();

	on(event: string, handler: ToolCallHandler): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerCommand(name: string, options: RegisteredCommandStub): void {
		this.commands.set(name, options);
	}

	/** Invoke the registered `tool_call` handlers in order, first result wins. */
	async fireToolCall(
		event: unknown,
		ctx: unknown,
	): Promise<{ block?: boolean; reason?: string } | undefined> {
		const handlers = this.handlers.get("tool_call") ?? [];
		for (const handler of handlers) {
			const result = await handler(event, ctx);
			if (result) return result;
		}
		return undefined;
	}
}

/** In-memory filesystem keyed by absolute path. */
export class FakeFileSystem implements FileSystemReader {
	files = new Map<string, string>();
	mtimes = new Map<string, number>();

	write(path: string, content: string, mtimeMs = 1): void {
		this.files.set(path, content);
		this.mtimes.set(path, mtimeMs);
	}

	remove(path: string): void {
		this.files.delete(path);
		this.mtimes.delete(path);
	}

	listDir(dir: string): string[] | undefined {
		const prefix = dir.endsWith("/") ? dir : `${dir}/`;
		const names = new Set<string>();
		let dirExists = false;
		for (const path of this.files.keys()) {
			if (!path.startsWith(prefix)) continue;
			const rest = path.slice(prefix.length);
			if (rest.length === 0) continue;
			dirExists = true;
			const slash = rest.indexOf("/");
			names.add(slash === -1 ? rest : rest.slice(0, slash));
		}
		return dirExists ? [...names] : undefined;
	}

	mtimeMs(path: string): number | undefined {
		return this.mtimes.get(path);
	}

	readFile(path: string): string | undefined {
		return this.files.get(path);
	}
}

export interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
	signal: AbortSignal | undefined;
}

export interface FakeHttpOptions {
	/** Probability returned for every question. */
	probability?: number;
	/** Per-question probabilities by position in the request. */
	byIndex?: number[];
	/**
	 * Per-question probabilities matched against a substring of the question id.
	 *
	 * Prefer this over `byIndex` whenever the question set can change between
	 * calls: positional scoring silently reassigns probabilities when a question
	 * drops out.
	 */
	byName?: Record<string, number>;
	/** Per-question probabilities, keyed by exact question id. */
	probabilities?: Record<string, number>;
	status?: number;
	/** Raw body text, bypassing the generated answer shape. */
	rawBody?: string;
	/** Thrown instead of responding, to simulate a transport failure. */
	error?: Error;
}

/** Records outgoing requests and replies with a synthesised Jev response. */
export class FakeHttp {
	requests: CapturedRequest[] = [];
	options: FakeHttpOptions;
	/** Successive per-call option overrides, consumed in order. */
	queue: FakeHttpOptions[] = [];

	constructor(options: FakeHttpOptions = {}) {
		this.options = options;
	}

	get transport(): HttpTransport {
		return async (url, init) => {
			const body = JSON.parse(init.body) as Record<string, unknown>;
			this.requests.push({
				url,
				headers: init.headers,
				body,
				signal: init.signal,
			});

			const options = this.queue.shift() ?? this.options;
			if (options.error) throw options.error;

			const status = options.status ?? 200;
			if (options.rawBody !== undefined) {
				return makeResponse(status, options.rawBody);
			}
			if (status !== 200) {
				return makeResponse(status, JSON.stringify({ error: "failure" }));
			}

			const questions = (body.questions ?? {}) as Record<string, unknown>;
			const answers: Record<string, unknown> = {};
			for (const [index, id] of Object.keys(questions).entries()) {
				answers[id] = {
					type: "noul",
					noul: scoreFor(options, id, index),
				};
			}
			return makeResponse(
				status,
				JSON.stringify({
					model: body.model,
					answers,
					usage: { input_tokens: 100, output_tokens: 10 },
				}),
			);
		};
	}

	/** The single request sent, asserting exactly one was. */
	only(): CapturedRequest {
		if (this.requests.length !== 1) {
			throw new Error(`expected exactly 1 request, got ${this.requests.length}`);
		}
		const request = this.requests[0];
		if (!request) throw new Error("unreachable");
		return request;
	}

	/** Question ids of the request at `index`, in insertion order. */
	questionIds(index = 0): string[] {
		const request = this.requests[index];
		if (!request) throw new Error(`no request at index ${index}`);
		return Object.keys(
			(request.body.questions ?? {}) as Record<string, unknown>,
		);
	}

	/** Instructions text of every question in the request at `index`. */
	instructions(index = 0): string[] {
		const request = this.requests[index];
		if (!request) throw new Error(`no request at index ${index}`);
		const questions = (request.body.questions ?? {}) as Record<
			string,
			{ instructions?: string }
		>;
		return Object.values(questions).map((q) => q.instructions ?? "");
	}
}

function makeResponse(status: number, body: string): HttpResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => body,
	};
}

function scoreFor(
	options: FakeHttpOptions,
	id: string,
	index: number,
): number {
	const exact = options.probabilities?.[id];
	if (exact !== undefined) return exact;

	if (options.byName) {
		for (const [needle, probability] of Object.entries(options.byName)) {
			if (id.includes(needle)) return probability;
		}
	}

	return options.byIndex?.[index] ?? options.probability ?? 0;
}

export interface FakeDepsOptions {
	fs?: FakeFileSystem;
	http?: FakeHttp;
	settings?: string | undefined;
	env?: Record<string, string>;
}

export interface FakeDeps {
	deps: Deps;
	fs: FakeFileSystem;
	http: FakeHttp;
	logLines: string[];
	/** Parsed log records, one per written line. */
	logRecords(): Record<string, unknown>[];
	/** Fails subsequent log writes, to test sink failure handling. */
	failLogs(): void;
}

export function makeDeps(options: FakeDepsOptions = {}): FakeDeps {
	const fs = options.fs ?? new FakeFileSystem();
	const http = options.http ?? new FakeHttp();
	const logLines: string[] = [];
	const env = options.env ?? {};
	let logShouldFail = false;
	let clock = 1000;

	const deps: Deps = {
		http: http.transport,
		fs,
		readSettings: () => options.settings,
		now: () => (clock += 5),
		timestamp: () => "2026-09-22T00:00:00.000Z",
		log: (line) => {
			if (logShouldFail) throw new Error("disk full");
			logLines.push(line);
		},
		env: (name) => env[name],
	};

	return {
		deps,
		fs,
		http,
		logLines,
		logRecords: () =>
			logLines.map((line) => JSON.parse(line) as Record<string, unknown>),
		failLogs: () => {
			logShouldFail = true;
		},
	};
}

/** A `write` tool_call event. */
export function writeCall(path: string, content: string): unknown {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName: "write",
		input: { path, content },
	};
}

/** An `edit` tool_call event. */
export function editCall(
	path: string,
	edits: { oldText: string; newText: string }[],
): unknown {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName: "edit",
		input: { path, edits },
	};
}

/** A `bash` tool_call event. */
export function bashCall(command: string): unknown {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName: "bash",
		input: { command },
	};
}

/** A `powershell` tool_call event. */
export function powershellCall(command: string): unknown {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName: "powershell",
		input: { command },
	};
}

/** A tool_call event for a tool the guard must ignore. */
export function readCall(path: string): unknown {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName: "read",
		input: { path },
	};
}
