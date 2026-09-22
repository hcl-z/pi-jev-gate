/**
 * The guard itself: the parameterised factory that forms the testing seam.
 *
 * Its contract with pi is one `tool_call` handler. Everything the outside world
 * provides — HTTP, filesystem, settings, clock, log sink, environment — arrives
 * through `Deps` so tests drive this exact code path with doubles.
 */

import {
	COMMAND_DESCRIPTION,
	COMMAND_NAME,
	runCommand,
} from "./command.ts";
import { resolveConfig } from "./config.ts";
import {
	DecisionLog,
	type LogInput,
	type LogVerdict,
} from "./decision-log.ts";
import { askAboutViolations } from "./dialog.ts";
import { describeChange, type ToolCallLike } from "./describe-change.ts";
import { evaluate } from "./jev-client.ts";
import { ConstraintLoader } from "./load-constraints.ts";
import type { ConstraintVerdict, Deps } from "./types.ts";

/** Minimal shape of what the guard uses from pi's extension API. */
interface PiLike {
	on(event: "tool_call", handler: ToolCallHandler): void;
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler: (args: string, ctx: GuardContext) => Promise<void>;
		},
	): void;
}

type ToolCallHandler = (
	event: ToolCallLike,
	ctx: GuardContext,
) => Promise<ToolCallResult | undefined>;

interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

/** Minimal shape of what the guard uses from pi's extension context. */
export interface GuardContext {
	cwd: string;
	hasUI: boolean;
	signal: AbortSignal | undefined;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select(title: string, options: string[]): Promise<string | undefined>;
	};
}

export function createGuard(pi: PiLike, deps: Deps): void {
	const loader = new ConstraintLoader(deps.fs);
	const log = new DecisionLog(deps.log, deps.timestamp);
	// Session-scoped and never persisted, so it cannot quietly weaken a project's
	// rules beyond the current session.
	const ignored = new Set<string>();
	let warnedMissingKey = false;
	let enabled = true;

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return undefined;

		const change = describeChange(event);
		// Not a file mutation, or a shell command that only reads: nothing to do,
		// and nothing to pay for.
		if (!change) return undefined;

		// No dialog to ask in means the outcome is predetermined: the call
		// proceeds. Skip the request rather than pay for a judgment we cannot act
		// on.
		if (!ctx.hasUI) return undefined;

		const { constraints } = loader.load(ctx.cwd);
		const active = constraints.filter((c) => !ignored.has(c.id));
		// No constraints means the guard has nothing to enforce. Stay completely
		// silent: installing it globally must cost nothing in projects that do
		// not use it.
		if (active.length === 0) return undefined;

		const config = resolveConfig(deps.readSettings(), deps.env);
		const startedAt = deps.now();

		const record = (
			verdict: LogVerdict,
			extra: Partial<
				Pick<
					LogInput,
					| "verdicts"
					| "violations"
					| "degradedReason"
					| "userChoice"
					| "ignoredIds"
					| "inputTokens"
					| "outputTokens"
					| "answeredBy"
				>
			> = {},
		) => {
			if (!config.log) return;
			const warning = log.write({
				tool: event.toolName,
				change,
				constraints: active,
				config,
				verdict,
				elapsedMs: deps.now() - startedAt,
				...extra,
			});
			// Logging never influences the verdict; it can only speak up once.
			if (warning) ctx.ui.notify(warning, "warning");
		};

		if (config.apiKey === undefined) {
			// Once, not on every call: a missing key is a setup gap, not an event.
			if (!warnedMissingKey) {
				warnedMissingKey = true;
				degraded(ctx, "no TypeSafe API key configured", true);
			}
			record("degraded", { degradedReason: "no TypeSafe API key configured" });
			return undefined;
		}

		const result = await evaluate(deps.http, {
			constraints: active,
			change,
			apiKey: config.apiKey,
			model: config.model,
			signal: ctx.signal,
			...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
		});

		if (result.outcome === "degraded") {
			// Cancellation is the user's own doing, so it needs no warning.
			if (result.reason !== "cancelled") degraded(ctx, result.reason, false);
			record("degraded", { degradedReason: result.reason });
			return undefined;
		}

		const shared = {
			verdicts: result.verdicts,
			answeredBy: result.model,
			...(result.inputTokens !== undefined
				? { inputTokens: result.inputTokens }
				: {}),
			...(result.outputTokens !== undefined
				? { outputTokens: result.outputTokens }
				: {}),
		};

		const violations = result.verdicts.filter(
			(verdict) => verdict.probability > config.threshold,
		);
		if (violations.length === 0) {
			record("allowed", shared);
			return undefined;
		}

		const outcome = await askAboutViolations(ctx.ui, violations);

		if (outcome.choice === "allow-once") {
			record("allowed-once", {
				...shared,
				violations,
				userChoice: "allow-once",
			});
			return undefined;
		}

		if (outcome.choice === "ignore-session") {
			// Only the constraints the user named, never the whole batch.
			for (const constraint of outcome.constraints) ignored.add(constraint.id);
			record("ignored", {
				...shared,
				violations,
				userChoice: "ignore-session",
				ignoredIds: outcome.constraints.map((c) => c.id),
			});
			return undefined;
		}

		record("blocked", {
			...shared,
			violations,
			userChoice: "rework",
		});
		return { block: true, reason: buildReason(violations) };
	});

	pi.registerCommand(COMMAND_NAME, {
		description: COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			const { constraints, files } = loader.load(ctx.cwd);
			const lines = runCommand(
				args,
				{
					constraints,
					files,
					config: resolveConfig(deps.readSettings(), deps.env),
					ignoredIds: ignored,
					enabled,
				},
				{
					clearIgnored: () => ignored.clear(),
					setEnabled: (value) => {
						enabled = value;
					},
				},
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

/**
 * Every abnormal condition lets the call through, but visibly: the user must
 * never mistake "the guard found nothing" for "the guard did not run".
 */
function degraded(ctx: GuardContext, reason: string, isSetup: boolean): void {
	const suffix = isSetup
		? " — set TYPESAFE_API_KEY or jevGate.apiKey in your pi settings"
		: "";
	ctx.ui.notify(
		`jev-gate: constraint check skipped (${reason})${suffix}`,
		"warning",
	);
}

/**
 * The reason becomes the tool result the model sees, so it carries each violated
 * rule's own text. Telling the agent only that it was rejected would leave it
 * guessing at what to change.
 */
function buildReason(violations: ConstraintVerdict[]): string {
	const parts = [
		violations.length === 1
			? "This change was rejected for violating a project constraint."
			: `This change was rejected for violating ${violations.length} project constraints.`,
		"",
	];

	for (const violation of violations) {
		const { constraint, probability } = violation;
		parts.push(
			`Constraint "${constraint.name}" (${constraint.sourceFile}, confidence ${probability.toFixed(2)}):`,
			constraint.text,
			"",
		);
	}

	parts.push(
		"Revise the change so it satisfies the constraints above, then try again.",
	);
	return parts.join("\n");
}
