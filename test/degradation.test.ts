/**
 * Ticket 06: the degradation matrix.
 *
 * Every abnormal condition lets the call through with a warning. The guard is a
 * constraint advisor, not a security control: its unavailability must never be
 * the reason a developer cannot edit a file. A guard that breaks the agent when
 * the network hiccups gets uninstalled on day one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createGuard } from "../src/guard.ts";
import {
	FakeContext,
	FakeExtensionAPI,
	FakeFileSystem,
	FakeHttp,
	makeDeps,
	writeCall,
	type FakeHttpOptions,
} from "./helpers.ts";

const RULES = "## A rule\nSome rule body.\n";

function harness(
	httpOptions: FakeHttpOptions,
	signal?: AbortSignal,
	timeoutMs?: number,
) {
	const fs = new FakeFileSystem();
	fs.write("/project/constraints.md", RULES);
	const http = new FakeHttp(httpOptions);
	const fake = makeDeps({
		fs,
		http,
		settings: JSON.stringify({ jevGate: { apiKey: "k" } }),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
	});
	const pi = new FakeExtensionAPI();
	createGuard(pi as never, fake.deps);
	const ctx = new FakeContext(signal ? { signal } : {});
	// Any dialog shown would be a bug: degradation must not ask the user.
	ctx.ui.selectAnswers = [];
	return { pi, ctx, http };
}

function fire(h: ReturnType<typeof harness>, name = "a.ts") {
	return h.pi.fireToolCall(writeCall(`/project/src/${name}`, "x"), h.ctx);
}

test("a transport failure lets the call through with a warning", async () => {
	const h = harness({ error: new Error("ECONNREFUSED") });

	const result = await fire(h);

	assert.equal(result, undefined);
	assert.match(h.ctx.ui.notifiedText(), /skipped/i);
	assert.equal(h.ctx.ui.notifications[0]?.type, "warning");
});

test("a transport failure is retried once before giving up", async () => {
	const h = harness({ error: new Error("ECONNRESET") });

	await fire(h);

	assert.equal(h.http.requests.length, 2, "one retry, not more");
});

test("a retried request that succeeds is judged normally", async () => {
	const h = harness({ probability: 0.1 });
	h.http.queue = [{ error: new Error("flaky") }, { probability: 0.95 }];
	h.ctx.ui.selectAnswers = [undefined];

	const result = await fire(h);

	assert.equal(result?.block, true, "the retry's verdict must be honoured");
	assert.equal(h.http.requests.length, 2);
});

const STATUSES: { status: number; label: string; retried: boolean }[] = [
	{ status: 401, label: "rejected key", retried: false },
	{ status: 422, label: "invalid request", retried: false },
	{ status: 429, label: "rate limited", retried: true },
	{ status: 529, label: "overloaded", retried: true },
	{ status: 500, label: "server error", retried: true },
	{ status: 503, label: "unavailable", retried: true },
	{ status: 418, label: "unexpected status", retried: false },
];

for (const { status, label, retried } of STATUSES) {
	test(`HTTP ${status} (${label}) lets the call through with a warning`, async () => {
		const h = harness({ status });

		const result = await fire(h);

		assert.equal(result, undefined);
		assert.match(h.ctx.ui.notifiedText(), /skipped/i);
	});

	test(`HTTP ${status} is ${retried ? "retried" : "not retried"}`, async () => {
		const h = harness({ status });

		await fire(h);

		assert.equal(
			h.http.requests.length,
			retried ? 2 : 1,
			retried
				? "transient failures deserve one retry"
				: "a client error will not fix itself on retry",
		);
	});
}

test("a malformed response body lets the call through with a warning", async () => {
	const h = harness({ rawBody: "this is not json" });

	const result = await fire(h);

	assert.equal(result, undefined);
	assert.match(h.ctx.ui.notifiedText(), /skipped/i);
});

test("a malformed response is not retried", async () => {
	const h = harness({ rawBody: "not json" });

	await fire(h);

	assert.equal(
		h.http.requests.length,
		1,
		"a malformed body will not become well-formed on retry",
	);
});

test("a response missing an answer lets the call through", async () => {
	const h = harness({
		rawBody: JSON.stringify({ model: "jev-1.13.0", answers: {} }),
	});

	const result = await fire(h);

	assert.equal(result, undefined);
	assert.match(h.ctx.ui.notifiedText(), /skipped/i);
});

test("a non-numeric probability lets the call through", async () => {
	const h = harness({
		rawBody: JSON.stringify({
			answers: { "constraints.md#A rule": { type: "noul", noul: "high" } },
		}),
	});

	const result = await fire(h);

	assert.equal(result, undefined);
	assert.match(h.ctx.ui.notifiedText(), /skipped/i);
});

test("a response with no answers object at all lets the call through", async () => {
	const h = harness({ rawBody: JSON.stringify({ model: "jev-1.13.0" }) });

	const result = await fire(h);

	assert.equal(result, undefined);
});

test("degradation never asks the user anything", async () => {
	const h = harness({ error: new Error("down") });

	await fire(h);

	assert.equal(
		h.ctx.ui.selects.length,
		0,
		"there is no decision to make: the call proceeds",
	);
});

test("a request that times out lets the call through with a warning", async () => {
	const h = harness({ hang: true }, undefined, 10);

	const result = await fire(h);

	assert.equal(result, undefined);
	assert.match(h.ctx.ui.notifiedText(), /timed out/i);
});

test("a timeout is retried once", async () => {
	const h = harness({ hang: true }, undefined, 10);

	await fire(h);

	assert.equal(
		h.http.requests.length,
		2,
		"a timeout is transient, so it deserves one retry",
	);
});

test("a slow first attempt that then succeeds is judged normally", async () => {
	const h = harness({ probability: 0.1 }, undefined, 20);
	h.http.queue = [{ hang: true }, { probability: 0.95 }];
	h.ctx.ui.selectAnswers = [undefined];

	const result = await fire(h);

	assert.equal(result?.block, true);
});

test("the user's Escape wins over a pending timeout", async () => {
	const controller = new AbortController();
	const h = harness({ hang: true }, controller.signal, 5000);
	setTimeout(() => controller.abort(), 5);

	const result = await fire(h);

	assert.equal(result, undefined);
	assert.equal(
		h.ctx.ui.notifications.length,
		0,
		"a user-initiated cancel is silent, unlike a timeout",
	);
	assert.equal(h.http.requests.length, 1, "and it is not retried");
});

test("an aborted signal ends the check without blocking", async () => {
	const controller = new AbortController();
	controller.abort();
	const h = harness({ error: new Error("aborted") }, controller.signal);

	const result = await fire(h);

	assert.equal(result, undefined);
});

test("cancellation is silent: Escape is the user's own doing", async () => {
	const controller = new AbortController();
	controller.abort();
	const h = harness({ error: new Error("aborted") }, controller.signal);

	await fire(h);

	assert.equal(
		h.ctx.ui.notifications.length,
		0,
		"the user knows they cancelled; warning them is noise",
	);
});

test("the caller's signal is passed to the transport so Escape can cancel", async () => {
	const controller = new AbortController();
	const h = harness({ probability: 0.1 }, controller.signal);

	await fire(h);

	assert.notEqual(
		h.http.only().signal,
		undefined,
		"without a signal an in-flight judgment could not be cancelled",
	);
});

test("an abort is not retried", async () => {
	const controller = new AbortController();
	controller.abort();
	const h = harness({ error: new Error("aborted") }, controller.signal);

	await fire(h);

	assert.equal(h.http.requests.length, 1);
});

test("degradation recurs per call rather than being warned once", async () => {
	const h = harness({ error: new Error("down") });

	await fire(h, "first.ts");
	await fire(h, "second.ts");

	assert.equal(
		h.ctx.ui.notifications.length,
		2,
		"each unenforced call must be visible, not just the first",
	);
});

test("recovery after a failure judges normally again", async () => {
	const h = harness({ probability: 0.1 });
	h.http.queue = [
		{ error: new Error("down") },
		{ error: new Error("down") },
		{ probability: 0.95 },
	];
	h.ctx.ui.selectAnswers = [undefined];

	const first = await fire(h, "first.ts");
	assert.equal(first, undefined);

	const second = await fire(h, "second.ts");
	assert.equal(second?.block, true);
});
