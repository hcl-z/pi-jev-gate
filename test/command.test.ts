/**
 * Ticket 08: the `/jev-guard` command.
 *
 * Its first job is showing how the constraints file was split, because a split
 * that does not match the user's intent is this feature's most likely failure
 * and is otherwise invisible.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createGuard } from "../src/guard.ts";
import { IGNORE_SESSION } from "../src/dialog.ts";
import {
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
	files?: Record<string, string>;
	apiKey?: string | undefined;
	http?: FakeHttpOptions;
	log?: boolean;
}

function harness(options: HarnessOptions = {}) {
	const fs = new FakeFileSystem();
	const files = options.files ?? { "/project/constraints.md": RULES };
	for (const [path, content] of Object.entries(files)) {
		fs.write(path, content);
	}
	const http = new FakeHttp(options.http ?? { probability: 0.1 });
	const block: Record<string, unknown> = { threshold: 0.6 };
	if (options.apiKey !== undefined) block.apiKey = options.apiKey;
	if (options.log !== undefined) block.log = options.log;
	const fake = makeDeps({
		fs,
		http,
		settings: JSON.stringify({ jevGuard: block }),
	});
	const pi = new FakeExtensionAPI();
	createGuard(pi as never, fake.deps);
	return { pi, ctx: new FakeContext(), http, fs };
}

/** Runs the command and returns what it printed. */
async function run(
	h: ReturnType<typeof harness>,
	args = "",
): Promise<string> {
	const command = h.pi.commands.get("jev-guard");
	assert.ok(command, "the command must be registered");
	const before = h.ctx.ui.notifications.length;
	await command.handler(args, h.ctx);
	return h.ctx.ui.notifications
		.slice(before)
		.map((n) => n.message)
		.join("\n");
}

test("the command is registered with a description", async () => {
	const h = harness({ apiKey: "k" });

	const command = h.pi.commands.get("jev-guard");

	assert.ok(command);
	assert.match(String(command.description), /constraint/i);
});

test("the report lists every parsed constraint", async () => {
	const h = harness({ apiKey: "k" });

	const output = await run(h);

	assert.match(output, /2 parsed/);
	assert.match(output, /No business logic in transport/);
	assert.match(output, /No new dependencies in core/);
});

test("the report shows each constraint's source file", async () => {
	const h = harness({
		apiKey: "k",
		files: {
			"/project/constraints.md": "## Root rule\nRoot body.\n",
			"/project/docs/constraints.md": "## Docs rule\nDocs body.\n",
		},
	});

	const output = await run(h);

	assert.match(output, /constraints\.md/);
	assert.match(output, /docs\/constraints\.md/);
});

test("the report shows where the split landed, not just names", async () => {
	const h = harness({ apiKey: "k" });

	const output = await run(h);

	assert.match(
		output,
		/Transport modules must not contain business rules/,
		"the body is what reaches the model, so the user must see it",
	);
});

test("the report shows the effective threshold and model", async () => {
	const h = harness({ apiKey: "k" });

	const output = await run(h);

	assert.match(output, /threshold\s+0\.6/);
	assert.match(output, /jev-1\.13\.0/);
});

test("the API key is redacted", async () => {
	const h = harness({ apiKey: "super-secret-key-1234" });

	const output = await run(h);

	assert.doesNotMatch(output, /super-secret-key-1234/);
	assert.match(output, /\*\*\*\*/);
	assert.match(output, /1234/, "a suffix helps confirm which key is loaded");
});

test("a missing key is reported as not set", async () => {
	const h = harness({});

	const output = await run(h);

	assert.match(output, /not set/i);
	assert.match(output, /TYPESAFE_API_KEY/);
});

test("the log setting is reported", async () => {
	const off = harness({ apiKey: "k" });
	assert.match(await run(off), /log\s+off/);

	const on = harness({ apiKey: "k", log: true });
	assert.match(await run(on), /log\s+on/);
});

test("no constraints file is reported with guidance", async () => {
	const h = harness({ apiKey: "k", files: { "/project/README.md": "x" } });

	const output = await run(h);

	assert.match(output, /none found/i);
	assert.match(output, /constraints\.md/);
	assert.match(output, /##/, "tell the user what format to use");
});

test("the ignore list is reported as empty by default", async () => {
	const h = harness({ apiKey: "k" });

	const output = await run(h);

	assert.match(output, /Ignored this session: none/);
});

test("an ignored constraint is marked in the report", async () => {
	const h = harness({
		apiKey: "k",
		http: { byName: { transport: 0.95, dependencies: 0.01 } },
	});
	h.ctx.ui.selectAnswers = [IGNORE_SESSION];
	await h.pi.fireToolCall(writeCall("/project/src/a.ts", "x"), h.ctx);

	const output = await run(h);

	assert.match(output, /\[ignored this session\]/);
	assert.match(output, /Ignored this session: 1/);
});

test("clearing the ignore list restores the constraint to the next request", async () => {
	const h = harness({
		apiKey: "k",
		http: { byName: { transport: 0.95, dependencies: 0.01 } },
	});
	h.ctx.ui.selectAnswers = [IGNORE_SESSION, undefined];

	await h.pi.fireToolCall(writeCall("/project/src/a.ts", "x"), h.ctx);
	assert.equal(h.http.questionIds(0).length, 2);

	await h.pi.fireToolCall(writeCall("/project/src/b.ts", "x"), h.ctx);
	assert.equal(h.http.questionIds(1).length, 1, "ignored while ignored");

	const output = await run(h, "clear");
	assert.match(output, /ignore list is now empty/i);

	await h.pi.fireToolCall(writeCall("/project/src/c.ts", "x"), h.ctx);
	assert.equal(
		h.http.questionIds(2).length,
		2,
		"after clearing, the rule is enforced again",
	);
});

test("disabling stops interception", async () => {
	const h = harness({ apiKey: "k", http: { probability: 0.95 } });

	const output = await run(h, "off");
	assert.match(output, /disabled/i);

	const result = await h.pi.fireToolCall(
		writeCall("/project/src/a.ts", "x"),
		h.ctx,
	);

	assert.equal(result, undefined);
	assert.equal(h.http.requests.length, 0, "a disabled guard costs nothing");
});

test("re-enabling resumes interception", async () => {
	const h = harness({ apiKey: "k", http: { probability: 0.95 } });
	h.ctx.ui.selectAnswers = [undefined];

	await run(h, "off");
	await run(h, "on");

	const result = await h.pi.fireToolCall(
		writeCall("/project/src/a.ts", "x"),
		h.ctx,
	);

	assert.equal(result?.block, true);
});

test("the report says when the guard is disabled", async () => {
	const h = harness({ apiKey: "k" });

	await run(h, "off");
	const output = await run(h);

	assert.match(output, /disabled for this session/i);
});

test("an unknown argument explains the usage", async () => {
	const h = harness({ apiKey: "k" });

	const output = await run(h, "frobnicate");

	assert.match(output, /unknown argument/i);
	assert.match(output, /clear\|on\|off/);
});

test("the report reflects a constraints file edited since the last check", async () => {
	const h = harness({ apiKey: "k" });

	assert.match(await run(h), /No business logic in transport/);

	h.fs.write("/project/constraints.md", "## Brand new rule\nNew body.\n", 99);

	const output = await run(h);
	assert.match(output, /Brand new rule/);
	assert.doesNotMatch(output, /No business logic in transport/);
});
