/**
 * The Jev client.
 *
 * A direct `fetch` rather than the published SDK: the request is a single JSON
 * POST, a dependency-free extension avoids a version coupling, and the SDK's
 * retry defaults are too patient for a gate a human is waiting behind.
 *
 * Every failure returns a `degraded` result rather than throwing. The guard is
 * a constraint advisor, not a security control, so its unavailability must never
 * be the reason a developer cannot edit a file.
 */

import type {
	ChangeDescription,
	Constraint,
	EvaluationResult,
	HttpTransport,
} from "./types.ts";

export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Short, because a human is waiting behind this call. */
const TIMEOUT_MS = 8000;

/** One retry: enough for a transient blip, not enough to feel like a hang. */
const MAX_ATTEMPTS = 2;

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

export interface EvaluateArgs {
	constraints: Constraint[];
	change: ChangeDescription;
	apiKey: string;
	model: string;
	signal: AbortSignal | undefined;
}

export async function evaluate(
	http: HttpTransport,
	args: EvaluateArgs,
): Promise<EvaluationResult> {
	const body = buildRequestBody(args);

	let lastReason = "unknown failure";
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		const attemptResult = await attemptEvaluate(http, args, body);
		if (attemptResult.kind === "ok") return attemptResult.result;
		lastReason = attemptResult.reason;
		if (!attemptResult.retryable) break;
	}

	return { outcome: "degraded", reason: lastReason };
}

type AttemptOutcome =
	| { kind: "ok"; result: EvaluationResult }
	| { kind: "failed"; reason: string; retryable: boolean };

async function attemptEvaluate(
	http: HttpTransport,
	args: EvaluateArgs,
	body: string,
): Promise<AttemptOutcome> {
	// The caller's signal must still cancel us, so the timeout is combined with
	// it rather than replacing it: Escape has to abort an in-flight judgment.
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
	const signal = combineSignals(args.signal, timeout.signal);

	try {
		const response = await http(ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${args.apiKey}`,
				"Content-Type": "application/json",
			},
			body,
			...(signal ? { signal } : {}),
		});

		if (!response.ok) {
			return {
				kind: "failed",
				reason: describeStatus(response.status),
				retryable: RETRYABLE_STATUS.has(response.status),
			};
		}

		const text = await response.text();
		const parsed = parseResponse(text, args.constraints);
		if (!parsed) {
			return {
				kind: "failed",
				// A malformed body will not become well-formed on retry.
				reason: "the model returned a response that could not be read",
				retryable: false,
			};
		}
		return { kind: "ok", result: parsed };
	} catch (error) {
		if (args.signal?.aborted) {
			return { kind: "failed", reason: "cancelled", retryable: false };
		}
		if (timeout.signal.aborted) {
			return { kind: "failed", reason: "the request timed out", retryable: true };
		}
		return {
			kind: "failed",
			reason: `could not reach the model (${messageOf(error)})`,
			retryable: true,
		};
	} finally {
		clearTimeout(timer);
	}
}

export function buildRequestBody(args: EvaluateArgs): string {
	const questions: Record<string, unknown> = {};
	for (const constraint of args.constraints) {
		questions[constraint.id] = {
			type: "noul",
			instructions: buildInstructions(constraint),
			criteria: {
				true: "The change violates the rule.",
				false: "The change does not violate the rule.",
			},
		};
	}

	return JSON.stringify({
		model: args.model,
		state: buildState(args.change),
		questions,
	});
}

/**
 * Jev reads instructions literally, so the rule is quoted verbatim and the
 * question names the exact thing to decide. The full constraint body must be
 * here: the model cannot see the question id, and a name alone is rarely the
 * whole rule.
 */
function buildInstructions(constraint: Constraint): string {
	return [
		"A developer's project has this rule:",
		"",
		constraint.text,
		"",
		"Does the change described in the state violate that rule?",
	].join("\n");
}

/**
 * Only the operation, path and change. The target file's existing contents and
 * the project structure are deliberately excluded: Jev's published failure modes
 * name large states full of irrelevant detail as an accuracy problem, and the
 * change itself is what the rule is about.
 */
function buildState(change: ChangeDescription): Record<string, string> {
	const state: Record<string, string> = { operation: change.operation };
	if (change.path !== undefined) state.path = change.path;
	state.change = change.change;
	return state;
}

function parseResponse(
	text: string,
	constraints: Constraint[],
): EvaluationResult | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;

	const answers = parsed.answers;
	if (!isRecord(answers)) return undefined;

	const verdicts = [];
	for (const constraint of constraints) {
		const answer = answers[constraint.id];
		if (!isRecord(answer)) return undefined;
		const probability = answer.noul;
		if (typeof probability !== "number" || !Number.isFinite(probability)) {
			return undefined;
		}
		verdicts.push({ constraint, probability });
	}

	const usage = isRecord(parsed.usage) ? parsed.usage : {};
	return {
		outcome: "evaluated",
		verdicts,
		inputTokens: asNumber(usage.input_tokens),
		outputTokens: asNumber(usage.output_tokens),
		model: typeof parsed.model === "string" ? parsed.model : "unknown",
	};
}

function describeStatus(status: number): string {
	switch (status) {
		case 401:
			return "the API key was rejected (HTTP 401)";
		case 422:
			return "the model rejected the request as invalid (HTTP 422)";
		case 429:
			return "rate limited (HTTP 429)";
		case 529:
			return "the model service is overloaded (HTTP 529)";
		default:
			return `the model service returned HTTP ${status}`;
	}
}

function combineSignals(
	caller: AbortSignal | undefined,
	timeout: AbortSignal,
): AbortSignal {
	if (!caller) return timeout;
	// AbortSignal.any is available on Node 20+; the extension requires 22+.
	return AbortSignal.any([caller, timeout]);
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
