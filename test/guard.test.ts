/**
 * Ticket 01: minimal closed loop — write and edit blocked by Jev.
 *
 * Everything is driven through the parameterised factory seam. The HTTP
 * transport is always a double, so no test touches the network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createGuard } from "../src/guard.ts";
import { REWORK } from "../src/dialog.ts";
import {
	editCall,
	FakeContext,
	FakeExtensionAPI,
	FakeFileSystem,
	FakeHttp,
	makeDeps,
	readCall,
	writeCall,
} from "./helpers.ts";

const CONSTRAINTS = `## No business logic in transport
Transport modules must not contain business rules.

## No new dependencies in core
The core package must stay dependency-free.
`;

interface HarnessOptions {
	constraints?: string | undefined;
	settings?: string | undefined;
	env?: Record<string, string>;
	http?: FakeHttp;
	hasUI?: boolean;
}

function harness(options: HarnessOptions = {}) {
	const fs = new FakeFileSystem();
	const constraints =
		options.constraints === undefined ? CONSTRAINTS : options.constraints;
	if (constraints !== null) {
		fs.write("/project/constraints.md", constraints);
	}
	const settings =
		options.settings ??
		JSON.stringify({ jevGate: { apiKey: "test-key", threshold: 0.6 } });
	const fake = makeDeps({
		fs,
		...(options.http ? { http: options.http } : {}),
		settings,
		...(options.env ? { env: options.env } : {}),
	});
	const pi = new FakeExtensionAPI();
	createGuard(pi as never, fake.deps);
	const ctx = new FakeContext({ hasUI: options.hasUI ?? true });
	// These tests predate the dialog and are about the block path, so every
	// violation answers "rework". Dialog behaviour itself is covered separately.
	ctx.ui.selectAnswers = Array(8).fill(REWORK);
	return { ...fake, pi, ctx };
}

test("write above threshold is blocked with the constraint text as reason", async () => {
	const http = new FakeHttp({ byIndex: [0.95, 0.01] });
	const h = harness({ http });

	const result = await h.pi.fireToolCall(
		writeCall("/project/src/transport.ts", "function calculateTax() {}"),
		h.ctx,
	);

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /No business logic in transport/);
	assert.match(
		result?.reason ?? "",
		/Transport modules must not contain business rules/,
		"the reason must carry the constraint body so the agent knows what to change",
	);
});

test("write below threshold proceeds", async () => {
	const http = new FakeHttp({ probability: 0.1 });
	const h = harness({ http });

	const result = await h.pi.fireToolCall(
		writeCall("/project/src/a.ts", "const a = 1;"),
		h.ctx,
	);

	assert.equal(result, undefined);
});

test("probability exactly at the threshold proceeds", async () => {
	const http = new FakeHttp({ probability: 0.6 });
	const h = harness({ http });

	const result = await h.pi.fireToolCall(
		writeCall("/project/src/a.ts", "x"),
		h.ctx,
	);

	assert.equal(result, undefined, "the threshold is exclusive: > not >=");
});

test("a custom threshold is honoured", async () => {
	const http = new FakeHttp({ probability: 0.45 });
	const h = harness({
		http,
		settings: JSON.stringify({
			jevGate: { apiKey: "k", threshold: 0.4 },
		}),
	});

	const result = await h.pi.fireToolCall(
		writeCall("/project/src/a.ts", "x"),
		h.ctx,
	);

	assert.equal(result?.block, true);
});

test("edit is judged on its oldText/newText pairs", async () => {
	const http = new FakeHttp({ probability: 0.9 });
	const h = harness({ http });

	await h.pi.fireToolCall(
		editCall("/project/src/transport.ts", [
			{ oldText: "const rate = 1", newText: "const rate = computeTax()" },
		]),
		h.ctx,
	);

	const state = JSON.stringify(http.only().body.state);
	assert.match(state, /const rate = 1/);
	assert.match(state, /const rate = computeTax\(\)/);
});

test("tools that do not mutate files are never sent for judgment", async () => {
	const http = new FakeHttp({ probability: 0.99 });
	const h = harness({ http });

	const result = await h.pi.fireToolCall(readCall("/project/src/a.ts"), h.ctx);

	assert.equal(result, undefined);
	assert.equal(http.requests.length, 0);
});

test("one noul question per constraint, each carrying its own body text", async () => {
	const http = new FakeHttp({ probability: 0.1 });
	const h = harness({ http });

	await h.pi.fireToolCall(writeCall("/project/a.ts", "x"), h.ctx);

	const questions = http.only().body.questions as Record<
		string,
		{ type: string; instructions: string }
	>;
	assert.equal(Object.keys(questions).length, 2);
	for (const question of Object.values(questions)) {
		assert.equal(question.type, "noul");
	}
	const instructions = http.instructions();
	assert.ok(
		instructions.some((i) =>
			i.includes("Transport modules must not contain business rules"),
		),
		"question instructions must include the constraint body, not just its name",
	);
	assert.ok(
		instructions.some((i) => i.includes("The core package must stay dependency-free")),
	);
});

test("the request targets the System One endpoint with a bearer token", async () => {
	const http = new FakeHttp({ probability: 0.1 });
	const h = harness({ http });

	await h.pi.fireToolCall(writeCall("/project/a.ts", "x"), h.ctx);

	const request = http.only();
	assert.equal(request.url, "https://api.typesafe.ai/v1/systemone");
	assert.equal(request.headers.Authorization, "Bearer test-key");
	assert.equal(request.headers["Content-Type"], "application/json");
});

test("the pinned model version is sent by default", async () => {
	const http = new FakeHttp({ probability: 0.1 });
	const h = harness({ http });

	await h.pi.fireToolCall(writeCall("/project/a.ts", "x"), h.ctx);

	assert.equal(
		http.only().body.model,
		"jev-1.13.0",
		"must pin a version, not the moving jev-latest alias",
	);
});

test("a configured model overrides the pinned default", async () => {
	const http = new FakeHttp({ probability: 0.1 });
	const h = harness({
		http,
		settings: JSON.stringify({ jevGate: { apiKey: "k", model: "jev-2.0.0" } }),
	});

	await h.pi.fireToolCall(writeCall("/project/a.ts", "x"), h.ctx);

	assert.equal(http.only().body.model, "jev-2.0.0");
});

test("the state carries only operation, path and change", async () => {
	const http = new FakeHttp({ probability: 0.1 });
	const h = harness({ http });

	await h.pi.fireToolCall(
		writeCall("/project/src/a.ts", "const a = 1;"),
		h.ctx,
	);

	const state = http.only().body.state as Record<string, unknown>;
	assert.deepEqual(Object.keys(state).sort(), ["change", "operation", "path"]);
	assert.match(String(state.path), /src\/a\.ts/);
	assert.match(String(state.change), /const a = 1;/);
});

test("oversized content is truncated and the truncation is marked", async () => {
	const http = new FakeHttp({ probability: 0.1 });
	const h = harness({ http });

	await h.pi.fireToolCall(
		writeCall("/project/big.ts", "x".repeat(100_000)),
		h.ctx,
	);

	const state = http.only().body.state as Record<string, unknown>;
	const change = String(state.change);
	assert.ok(change.length < 100_000, "content must be truncated");
	assert.match(change, /truncated/i, "truncation must be explicit in the state");
});

test("no API key: the call proceeds with a one-time configuration hint", async () => {
	const http = new FakeHttp({ probability: 0.99 });
	const h = harness({ http, settings: JSON.stringify({}) });

	const first = await h.pi.fireToolCall(writeCall("/project/a.ts", "x"), h.ctx);
	const second = await h.pi.fireToolCall(writeCall("/project/b.ts", "x"), h.ctx);

	assert.equal(first, undefined);
	assert.equal(second, undefined);
	assert.equal(http.requests.length, 0, "no key means no request");
	const hints = h.ctx.ui.notifications.filter((n) =>
		/api key/i.test(n.message),
	);
	assert.equal(hints.length, 1, "the hint must be shown once, not every call");
});

test("TYPESAFE_API_KEY takes precedence over the configured key", async () => {
	const http = new FakeHttp({ probability: 0.1 });
	const h = harness({
		http,
		settings: JSON.stringify({ jevGate: { apiKey: "from-settings" } }),
		env: { TYPESAFE_API_KEY: "from-env" },
	});

	await h.pi.fireToolCall(writeCall("/project/a.ts", "x"), h.ctx);

	assert.equal(http.only().headers.Authorization, "Bearer from-env");
});

test("an environment key alone is enough to run with no config block", async () => {
	const http = new FakeHttp({ probability: 0.1 });
	const h = harness({
		http,
		settings: JSON.stringify({ theme: "dark" }),
		env: { TYPESAFE_API_KEY: "env-only" },
	});

	await h.pi.fireToolCall(writeCall("/project/a.ts", "x"), h.ctx);

	assert.equal(http.requests.length, 1);
});

test("a malformed settings file falls back to defaults without throwing", async () => {
	const http = new FakeHttp({ probability: 0.1 });
	const h = harness({
		http,
		settings: "{ this is not json",
		env: { TYPESAFE_API_KEY: "k" },
	});

	await h.pi.fireToolCall(writeCall("/project/a.ts", "x"), h.ctx);

	assert.equal(http.only().body.model, "jev-1.13.0");
});

test("wrongly typed config values fall back to defaults", async () => {
	const http = new FakeHttp({ probability: 0.7 });
	const h = harness({
		http,
		settings: JSON.stringify({
			jevGate: { apiKey: "k", threshold: "not a number", model: 42 },
		}),
	});

	const result = await h.pi.fireToolCall(
		writeCall("/project/a.ts", "x"),
		h.ctx,
	);

	assert.equal(http.only().body.model, "jev-1.13.0");
	assert.equal(result?.block, true, "0.7 must still be judged against 0.6");
});

test("a missing settings file falls back to defaults", async () => {
	const http = new FakeHttp({ probability: 0.1 });
	const h = harness({
		http,
		settings: undefined,
		env: { TYPESAFE_API_KEY: "k" },
	});

	await h.pi.fireToolCall(writeCall("/project/a.ts", "x"), h.ctx);

	assert.equal(http.requests.length, 1);
});

test("no constraints file: the guard is silent and makes no request", async () => {
	const http = new FakeHttp({ probability: 0.99 });
	const fs = new FakeFileSystem();
	const fake = makeDeps({
		fs,
		http,
		settings: JSON.stringify({ jevGate: { apiKey: "k" } }),
	});
	const pi = new FakeExtensionAPI();
	createGuard(pi as never, fake.deps);
	const ctx = new FakeContext();
	ctx.ui.selectAnswers = [REWORK];

	const result = await pi.fireToolCall(writeCall("/project/a.ts", "x"), ctx);

	assert.equal(result, undefined);
	assert.equal(http.requests.length, 0);
	assert.equal(ctx.ui.notifications.length, 0, "silence means no warnings");
	assert.equal(ctx.ui.selects.length, 0, "and no dialog");
});

test("blocking never asks the agent to terminate", async () => {
	const http = new FakeHttp({ probability: 0.99 });
	const h = harness({ http });

	const result = (await h.pi.fireToolCall(
		writeCall("/project/a.ts", "x"),
		h.ctx,
	)) as { terminate?: boolean };

	assert.notEqual(result.terminate, true);
});
