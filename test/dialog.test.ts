/**
 * Ticket 05: the three-option dialog.
 *
 * The user must be able to see which rule fired, where it lives and how sure the
 * model was, then choose: send it back, let this one through, or stop asking
 * about that rule this session. Escape means rework, because dismissing the
 * dialog should be the safe action rather than the permissive one.
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
} from "./helpers.ts";

const RULES = `## No business logic in transport
Transport modules must not contain business rules.

## No new dependencies in core
The core package must stay dependency-free.
`;

interface HarnessOptions {
	hasUI?: boolean;
	answers?: (string | undefined)[];
	byIndex?: number[];
	byName?: Record<string, number>;
	probability?: number;
}

function harness(options: HarnessOptions = {}) {
	const fs = new FakeFileSystem();
	fs.write("/project/constraints.md", RULES);
	const http = new FakeHttp(
		options.byName
			? { byName: options.byName }
			: options.byIndex
				? { byIndex: options.byIndex }
				: { probability: options.probability ?? 0.95 },
	);
	const fake = makeDeps({
		fs,
		http,
		settings: JSON.stringify({ jevGuard: { apiKey: "k" } }),
	});
	const pi = new FakeExtensionAPI();
	createGuard(pi as never, fake.deps);
	const ctx = new FakeContext({ hasUI: options.hasUI ?? true });
	ctx.ui.selectAnswers = options.answers ?? [];
	return { pi, ctx, http };
}

function fire(h: ReturnType<typeof harness>, name = "a.ts") {
	return h.pi.fireToolCall(writeCall(`/project/src/${name}`, "x"), h.ctx);
}

/** The label the extension uses for each outcome, discovered from the dialog. */
async function labels(): Promise<string[]> {
	const h = harness({ answers: [undefined] });
	await fire(h);
	return h.ctx.ui.selects[0]?.options ?? [];
}

test("a violation asks the user rather than blocking outright", async () => {
	const h = harness({ answers: [undefined] });

	await fire(h);

	assert.equal(h.ctx.ui.selects.length, 1);
});

test("the dialog offers exactly three options", async () => {
	assert.equal((await labels()).length, 3);
});

test("the dialog names the violated constraint", async () => {
	const h = harness({ byIndex: [0.95, 0.01], answers: [undefined] });

	await fire(h);

	assert.match(
		h.ctx.ui.selects[0]?.title ?? "",
		/No business logic in transport/,
	);
});

test("the dialog shows the source file", async () => {
	const h = harness({ byIndex: [0.95, 0.01], answers: [undefined] });

	await fire(h);

	assert.match(h.ctx.ui.selects[0]?.title ?? "", /constraints\.md/);
});

test("the dialog shows the actual probability", async () => {
	const h = harness({ byIndex: [0.87, 0.01], answers: [undefined] });

	await fire(h);

	assert.match(
		h.ctx.ui.selects[0]?.title ?? "",
		/0\.87/,
		"the probability is how the user learns where to set their threshold",
	);
});

test("choosing rework blocks with the constraint text", async () => {
	const all = await labels();
	const rework = all[0];
	const h = harness({ byIndex: [0.95, 0.01], answers: [rework] });

	const result = await fire(h);

	assert.equal(result?.block, true);
	assert.match(
		result?.reason ?? "",
		/Transport modules must not contain business rules/,
	);
});

test("Escape blocks, exactly as rework does", async () => {
	const h = harness({ byIndex: [0.95, 0.01], answers: [undefined] });

	const result = await fire(h);

	assert.equal(result?.block, true, "dismissing must be the safe action");
});

test("choosing allow-once proceeds", async () => {
	const all = await labels();
	const h = harness({ byIndex: [0.95, 0.01], answers: [all[1]] });

	const result = await fire(h);

	assert.equal(result, undefined);
});

test("allow-once does not carry over: the next call asks again", async () => {
	const all = await labels();
	const h = harness({
		byIndex: [0.95, 0.01],
		answers: [all[1], all[1]],
	});

	await fire(h, "first.ts");
	await fire(h, "second.ts");

	assert.equal(h.ctx.ui.selects.length, 2, "a one-off exception is one-off");
	assert.equal(h.http.questionIds(1).length, 2, "both rules still evaluated");
});

test("session-ignore proceeds and drops the rule from the next request", async () => {
	const all = await labels();
	const h = harness({
		byName: { transport: 0.95, dependencies: 0.01 },
		answers: [all[2]],
	});

	const first = await fire(h, "first.ts");
	assert.equal(first, undefined);

	const before = h.http.questionIds(0);
	assert.equal(before.length, 2);

	const second = await fire(h, "second.ts");
	assert.equal(second, undefined);

	const after = h.http.questionIds(1);
	assert.equal(after.length, 1, "the ignored rule must not be asked again");
	assert.ok(!after.includes(before[0] ?? ""), "specifically the ignored one");
	assert.equal(
		h.ctx.ui.selects.length,
		1,
		"and the user must not be asked about it again",
	);
});

test("session-ignore leaves the other rules enforced", async () => {
	const all = await labels();
	const h = harness({
		byName: { transport: 0.95, dependencies: 0.01 },
		answers: [all[2], all[0]],
	});
	// The second call trips the rule that was not ignored.
	h.http.queue = [
		{ byName: { transport: 0.95, dependencies: 0.01 } },
		{ byName: { dependencies: 0.95 } },
	];

	await fire(h, "first.ts");
	const second = await fire(h, "second.ts");

	assert.equal(second?.block, true);
	assert.match(second?.reason ?? "", /No new dependencies in core/);
	assert.doesNotMatch(second?.reason ?? "", /No business logic in transport/);
});

test("ignoring every rule silences the guard without further requests", async () => {
	const all = await labels();
	const h = harness({ answers: [all[2], all[2]] });
	// Each call trips one rule, so each is ignored in turn.
	h.http.queue = [
		{ byName: { transport: 0.95, dependencies: 0.01 } },
		{ byName: { dependencies: 0.95 } },
	];

	await fire(h, "first.ts");
	await fire(h, "second.ts");
	const third = await fire(h, "third.ts");

	assert.equal(third, undefined);
	assert.equal(
		h.http.requests.length,
		2,
		"with nothing left to ask, no request should be sent",
	);
});

test("several violations at once are presented together", async () => {
	const h = harness({ byIndex: [0.95, 0.9], answers: [undefined] });

	const result = await fire(h);

	const title = h.ctx.ui.selects[0]?.title ?? "";
	assert.match(title, /No business logic in transport/);
	assert.match(title, /No new dependencies in core/);
	assert.match(result?.reason ?? "", /Transport modules/);
	assert.match(result?.reason ?? "", /dependency-free/);
});

test("rework on a multi-violation dialog blocks on all of them", async () => {
	const all = await labels();
	const h = harness({ byIndex: [0.95, 0.9], answers: [all[0]] });

	const result = await fire(h);

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /2 project constraints/);
});

test("session-ignore on a multi-violation dialog ignores all of them", async () => {
	const all = await labels();
	const h = harness({ byIndex: [0.95, 0.9], answers: [all[2]] });

	await fire(h, "first.ts");
	const second = await fire(h, "second.ts");

	assert.equal(second, undefined);
	assert.equal(h.http.requests.length, 1, "nothing left to ask about");
});

test("no violation means no dialog", async () => {
	const h = harness({ probability: 0.1 });

	const result = await fire(h);

	assert.equal(result, undefined);
	assert.equal(h.ctx.ui.selects.length, 0);
});

test("without a UI the call proceeds and no request is made", async () => {
	const h = harness({ hasUI: false });

	const result = await fire(h);

	assert.equal(result, undefined);
	assert.equal(
		h.http.requests.length,
		0,
		"the outcome is predetermined, so paying for the judgment is waste",
	);
	assert.equal(h.ctx.ui.selects.length, 0);
});
