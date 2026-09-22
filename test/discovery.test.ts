/**
 * Ticket 02: constraint file discovery.
 *
 * Both locations are read and merged rather than one winning, because a rule
 * that was written but silently ignored is the worst failure this feature can
 * have. Parsing is asserted through the outgoing question set.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createGuard } from "../src/guard.ts";
import { REWORK } from "../src/dialog.ts";
import {
	FakeContext,
	FakeExtensionAPI,
	FakeFileSystem,
	FakeHttp,
	makeDeps,
	writeCall,
} from "./helpers.ts";

const ROOT_RULE = "## Root rule\nRoot rule body.\n";
const DOCS_RULE = "## Docs rule\nDocs rule body.\n";

function harness(files: Record<string, string>, mtimes: Record<string, number> = {}) {
	const fs = new FakeFileSystem();
	for (const [path, content] of Object.entries(files)) {
		fs.write(path, content, mtimes[path] ?? 1);
	}
	const http = new FakeHttp({ probability: 0.1 });
	const fake = makeDeps({
		fs,
		http,
		settings: JSON.stringify({ jevGuard: { apiKey: "k" } }),
	});
	const pi = new FakeExtensionAPI();
	createGuard(pi as never, fake.deps);
	const ctx = new FakeContext();
	// Discovery tests care about which rules were asked, not the dialog.
	ctx.ui.selectAnswers = Array(8).fill(REWORK);
	return { ...fake, pi, ctx, http, fs };
}

async function fire(h: ReturnType<typeof harness>, name = "a.ts") {
	return h.pi.fireToolCall(writeCall(`/project/src/${name}`, "x"), h.ctx);
}

test("constraints are read from the project root", async () => {
	const h = harness({ "/project/constraints.md": ROOT_RULE });

	await fire(h);

	assert.deepEqual(h.http.instructions().length, 1);
	assert.match(h.http.instructions()[0] ?? "", /Root rule body/);
});

test("constraints are read from docs/", async () => {
	const h = harness({ "/project/docs/constraints.md": DOCS_RULE });

	await fire(h);

	assert.equal(h.http.instructions().length, 1);
	assert.match(h.http.instructions()[0] ?? "", /Docs rule body/);
});

test("both locations are merged when both exist", async () => {
	const h = harness({
		"/project/constraints.md": ROOT_RULE,
		"/project/docs/constraints.md": DOCS_RULE,
	});

	await fire(h);

	const instructions = h.http.instructions().join("\n");
	assert.equal(h.http.instructions().length, 2, "neither file may be dropped");
	assert.match(instructions, /Root rule body/);
	assert.match(instructions, /Docs rule body/);
});

test("each constraint records the file it came from", async () => {
	const h = harness({
		"/project/constraints.md": ROOT_RULE,
		"/project/docs/constraints.md": DOCS_RULE,
	});
	h.http.options = { byIndex: [0.9, 0.9] };

	const result = await fire(h);

	assert.match(result?.reason ?? "", /constraints\.md/);
	assert.match(result?.reason ?? "", /docs\/constraints\.md/);
});

test("an uppercase filename is matched", async () => {
	const h = harness({ "/project/CONSTRAINTS.md": ROOT_RULE });

	await fire(h);

	assert.equal(h.http.instructions().length, 1);
});

test("a mixed-case filename is matched", async () => {
	const h = harness({ "/project/docs/Constraints.MD": DOCS_RULE });

	await fire(h);

	assert.equal(h.http.instructions().length, 1);
});

test("no constraints file anywhere: no request is made", async () => {
	const h = harness({ "/project/README.md": "not constraints" });

	const result = await fire(h);

	assert.equal(result, undefined);
	assert.equal(h.http.requests.length, 0);
});

test("editing the file mid-session takes effect on the next call", async () => {
	const h = harness({ "/project/constraints.md": ROOT_RULE });

	await fire(h, "first.ts");
	assert.match(h.http.instructions(0)[0] ?? "", /Root rule body/);

	h.fs.write(
		"/project/constraints.md",
		"## Replaced rule\nCompletely different body.\n",
		2,
	);

	await fire(h, "second.ts");
	const second = h.http.instructions(1);
	assert.equal(second.length, 1);
	assert.match(second[0] ?? "", /Completely different body/);
	assert.doesNotMatch(second[0] ?? "", /Root rule body/);
});

test("an unchanged file is not re-parsed but still yields its constraints", async () => {
	const h = harness({ "/project/constraints.md": ROOT_RULE });

	await fire(h, "first.ts");
	await fire(h, "second.ts");

	assert.equal(h.http.requests.length, 2);
	assert.equal(h.http.instructions(1).length, 1);
});

test("adding a constraints file mid-session starts the guard", async () => {
	const h = harness({ "/project/README.md": "x" });

	await fire(h, "first.ts");
	assert.equal(h.http.requests.length, 0);

	h.fs.write("/project/constraints.md", ROOT_RULE, 5);

	await fire(h, "second.ts");
	assert.equal(h.http.requests.length, 1);
});

test("removing the constraints file mid-session silences the guard", async () => {
	const h = harness({ "/project/constraints.md": ROOT_RULE });

	await fire(h, "first.ts");
	assert.equal(h.http.requests.length, 1);

	h.fs.remove("/project/constraints.md");

	const result = await fire(h, "second.ts");
	assert.equal(result, undefined);
	assert.equal(h.http.requests.length, 1, "no further request after removal");
});

test("constraint ids stay stable when a rule body is edited", async () => {
	const h = harness({ "/project/constraints.md": ROOT_RULE });

	await fire(h, "first.ts");
	const before = h.http.questionIds(0);

	h.fs.write("/project/constraints.md", "## Root rule\nRewritten body.\n", 2);

	await fire(h, "second.ts");
	const after = h.http.questionIds(1);

	assert.deepEqual(
		after,
		before,
		"identity must survive body edits so a session ignore does not slide onto another rule",
	);
});

test("constraint ids do not collide across the two files", async () => {
	const h = harness({
		"/project/constraints.md": "## Same name\nRoot body.\n",
		"/project/docs/constraints.md": "## Same name\nDocs body.\n",
	});

	await fire(h);

	const ids = h.http.questionIds();
	assert.equal(ids.length, 2);
	assert.equal(new Set(ids).size, 2, "identically named rules must stay distinct");
});
