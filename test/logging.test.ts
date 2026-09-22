/**
 * Ticket 07: the decision log.
 *
 * Off by default. When on, it must record enough to calibrate a threshold from
 * real decisions — including which button the user pressed, which is the only
 * labelled data they have. Writing must never influence the verdict.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createGuard } from "../src/guard.ts";
import { ALLOW_ONCE, IGNORE_SESSION, REWORK } from "../src/dialog.ts";
import {
	bashCall,
	FakeContext,
	FakeExtensionAPI,
	FakeFileSystem,
	FakeHttp,
	makeDeps,
	writeCall,
	type FakeHttpOptions,
} from "./helpers.ts";

const RULES = `## No business logic in transport
Transport modules must not contain business rules.

## No new dependencies in core
The core package must stay dependency-free.
`;

interface HarnessOptions {
	log?: boolean;
	http?: FakeHttpOptions;
	answers?: (string | undefined)[];
	apiKey?: string | undefined;
}

function harness(options: HarnessOptions = {}) {
	const fs = new FakeFileSystem();
	fs.write("/project/constraints.md", RULES);
	const http = new FakeHttp(options.http ?? { probability: 0.1 });
	const guardBlock: Record<string, unknown> = { threshold: 0.6 };
	if (options.log !== undefined) guardBlock.log = options.log;
	if (options.apiKey !== undefined) guardBlock.apiKey = options.apiKey;
	const fake = makeDeps({
		fs,
		http,
		settings: JSON.stringify({ jevGuard: guardBlock }),
	});
	const pi = new FakeExtensionAPI();
	createGuard(pi as never, fake.deps);
	const ctx = new FakeContext();
	ctx.ui.selectAnswers = options.answers ?? [];
	return { ...fake, pi, ctx, http };
}

function fire(h: ReturnType<typeof harness>, name = "a.ts") {
	return h.pi.fireToolCall(writeCall(`/project/src/${name}`, "x"), h.ctx);
}

test("logging is off by default: nothing is written", async () => {
	const h = harness({ apiKey: "k" });

	await fire(h);

	assert.equal(h.logLines.length, 0);
});

test("an explicit log:false writes nothing", async () => {
	const h = harness({ apiKey: "k", log: false });

	await fire(h);

	assert.equal(h.logLines.length, 0);
});

test("one parseable line is written per check", async () => {
	const h = harness({ apiKey: "k", log: true });

	await fire(h, "first.ts");
	await fire(h, "second.ts");

	assert.equal(h.logLines.length, 2);
	for (const line of h.logLines) {
		assert.doesNotMatch(line, /\n/, "one record per line, for aggregation");
		JSON.parse(line);
	}
});

test("an allowed check records the full decision trail", async () => {
	const h = harness({ apiKey: "k", log: true, http: { probability: 0.12 } });

	await fire(h);

	const record = h.logRecords()[0] ?? {};
	assert.equal(record.verdict, "allowed");
	assert.equal(record.tool, "write");
	assert.match(String(record.path), /src\/a\.ts/);
	assert.equal(typeof record.operation, "string");
	assert.equal(record.threshold, 0.6);
	assert.equal(typeof record.timestamp, "string");
	assert.equal(typeof record.elapsedMs, "number");
	assert.equal(record.inputTokens, 100);
	assert.equal(record.outputTokens, 10);
});

test("the state that was sent is recorded", async () => {
	const h = harness({ apiKey: "k", log: true });

	await h.pi.fireToolCall(
		writeCall("/project/src/a.ts", "const secret = 1;"),
		h.ctx,
	);

	const record = h.logRecords()[0] ?? {};
	assert.match(
		String(record.change),
		/const secret = 1;/,
		"the change is recorded so a disputed judgment can be diagnosed",
	);
});

test("every returned probability is recorded", async () => {
	const h = harness({
		apiKey: "k",
		log: true,
		http: { byName: { transport: 0.91, dependencies: 0.07 } },
		answers: [REWORK],
	});

	await fire(h);

	const probabilities = (h.logRecords()[0]?.probabilities ?? {}) as Record<
		string,
		number
	>;
	assert.equal(Object.keys(probabilities).length, 2);
	assert.deepEqual(Object.values(probabilities).sort(), [0.07, 0.91]);
});

test("the parsed constraints are recorded with their source files", async () => {
	const h = harness({ apiKey: "k", log: true });

	await fire(h);

	const constraints = (h.logRecords()[0]?.constraints ?? []) as {
		name: string;
		sourceFile: string;
	}[];
	assert.equal(constraints.length, 2);
	assert.equal(constraints[0]?.sourceFile, "constraints.md");
	assert.match(String(constraints[0]?.name), /No business logic in transport/);
});

test("rework records the block and the user's choice", async () => {
	const h = harness({
		apiKey: "k",
		log: true,
		http: { probability: 0.95 },
		answers: [REWORK],
	});

	await fire(h);

	const record = h.logRecords()[0] ?? {};
	assert.equal(record.verdict, "blocked");
	assert.equal(
		record.userChoice,
		"rework",
		"the user's own choice is the labelled data for calibration",
	);
	assert.equal((record.violations as string[]).length, 2);
});

test("allow-once is distinguishable from a clean pass", async () => {
	const h = harness({
		apiKey: "k",
		log: true,
		http: { probability: 0.95 },
		answers: [ALLOW_ONCE],
	});

	await fire(h);

	const record = h.logRecords()[0] ?? {};
	assert.equal(record.verdict, "allowed-once");
	assert.equal(record.userChoice, "allow-once");
});

test("session-ignore is recorded as its own verdict", async () => {
	const h = harness({
		apiKey: "k",
		log: true,
		http: { probability: 0.95 },
		answers: [IGNORE_SESSION],
	});

	await fire(h);

	const record = h.logRecords()[0] ?? {};
	assert.equal(record.verdict, "ignored");
	assert.equal(record.userChoice, "ignore-session");
});

test("Escape is recorded as rework", async () => {
	const h = harness({
		apiKey: "k",
		log: true,
		http: { probability: 0.95 },
		answers: [undefined],
	});

	await fire(h);

	assert.equal(h.logRecords()[0]?.userChoice, "rework");
});

test("a degraded check is logged with its reason", async () => {
	const h = harness({
		apiKey: "k",
		log: true,
		http: { error: new Error("ECONNREFUSED") },
	});

	await fire(h);

	const record = h.logRecords()[0] ?? {};
	assert.equal(
		record.verdict,
		"degraded",
		"a gap in enforcement must be visible after the fact",
	);
	assert.match(String(record.degradedReason), /reach the model/);
});

test("a missing key is logged as degraded", async () => {
	const h = harness({ log: true });

	await fire(h);

	assert.equal(h.logRecords()[0]?.verdict, "degraded");
	assert.match(String(h.logRecords()[0]?.degradedReason), /api key/i);
});

test("an HTTP failure is logged as degraded", async () => {
	const h = harness({ apiKey: "k", log: true, http: { status: 429 } });

	await fire(h);

	assert.equal(h.logRecords()[0]?.verdict, "degraded");
	assert.match(String(h.logRecords()[0]?.degradedReason), /429/);
});

test("the API key never appears in the log", async () => {
	const h = harness({
		apiKey: "super-secret-key-value",
		log: true,
		http: { probability: 0.95 },
		answers: [REWORK],
	});

	await fire(h);

	const all = h.logLines.join("\n");
	assert.doesNotMatch(all, /super-secret-key-value/);
	assert.doesNotMatch(all, /Bearer/);
});

test("the versioned model that answered is recorded", async () => {
	const h = harness({ apiKey: "k", log: true });

	await fire(h);

	assert.equal(h.logRecords()[0]?.model, "jev-1.13.0");
});

test("a shell check is logged without a path", async () => {
	const h = harness({ apiKey: "k", log: true });

	await h.pi.fireToolCall(bashCall("rm -rf src/generated"), h.ctx);

	const record = h.logRecords()[0] ?? {};
	assert.equal(record.tool, "bash");
	assert.equal(record.path, undefined);
	assert.match(String(record.change), /rm -rf/);
});

test("truncation is flagged in the record", async () => {
	const h = harness({ apiKey: "k", log: true });

	await h.pi.fireToolCall(
		writeCall("/project/big.ts", "x".repeat(100_000)),
		h.ctx,
	);

	assert.equal(h.logRecords()[0]?.changeTruncated, true);
});

test("a failing sink does not change the verdict", async () => {
	const h = harness({
		apiKey: "k",
		log: true,
		http: { probability: 0.95 },
		answers: [REWORK],
	});
	h.failLogs();

	const result = await fire(h);

	assert.equal(
		result?.block,
		true,
		"a full disk must never decide whether a change is allowed",
	);
});

test("a failing sink warns once, not on every call", async () => {
	const h = harness({ apiKey: "k", log: true });
	h.failLogs();

	await fire(h, "first.ts");
	await fire(h, "second.ts");
	await fire(h, "third.ts");

	const warnings = h.ctx.ui.notifications.filter((n) =>
		/decision log/i.test(n.message),
	);
	assert.equal(warnings.length, 1);
});

test("a failing sink does not prevent an allowed call from proceeding", async () => {
	const h = harness({ apiKey: "k", log: true });
	h.failLogs();

	const result = await fire(h);

	assert.equal(result, undefined);
});

test("skipped calls are not logged at all", async () => {
	const h = harness({ apiKey: "k", log: true });

	await h.pi.fireToolCall(bashCall("npm test"), h.ctx);

	assert.equal(
		h.logLines.length,
		0,
		"a read-only command was never checked, so there is nothing to record",
	);
});
