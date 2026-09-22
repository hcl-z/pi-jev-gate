/**
 * Ticket 03: constraint parsing completeness.
 *
 * Parsing is asserted through the outgoing question set, per the agreed seam:
 * the questions sent to Jev *are* the parse result, and checking them also
 * verifies the constraint text actually reached the model.
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

/** Sends one write call and returns the instructions of each question sent. */
async function parseVia(document: string): Promise<string[]> {
	const fs = new FakeFileSystem();
	fs.write("/project/constraints.md", document);
	const http = new FakeHttp({ probability: 0.1 });
	const fake = makeDeps({
		fs,
		http,
		settings: JSON.stringify({ jevGuard: { apiKey: "k" } }),
	});
	const pi = new FakeExtensionAPI();
	createGuard(pi as never, fake.deps);
	await pi.fireToolCall(writeCall("/project/src/a.ts", "x"), new FakeContext());
	return http.requests.length === 0 ? [] : http.instructions();
}

test("each ## heading becomes one constraint", async () => {
	const questions = await parseVia(`## First rule
First body.

## Second rule
Second body.

## Third rule
Third body.
`);

	assert.equal(questions.length, 3);
	assert.match(questions[0] ?? "", /First rule[\s\S]*First body/);
	assert.match(questions[1] ?? "", /Second rule[\s\S]*Second body/);
	assert.match(questions[2] ?? "", /Third rule[\s\S]*Third body/);
});

test("### is a boundary on equal terms with ##", async () => {
	const questions = await parseVia(`### Nested one
Body one.

### Nested two
Body two.
`);

	assert.equal(questions.length, 2);
});

test("## and ### mix as sibling boundaries", async () => {
	const questions = await parseVia(`## Top rule
Top body.

### Sub rule
Sub body.
`);

	assert.equal(questions.length, 2);
	assert.match(questions[0] ?? "", /Top body/);
	assert.doesNotMatch(
		questions[0] ?? "",
		/Sub body/,
		"a ### must end the preceding ## section",
	);
});

test("bullets under a heading belong to that heading's constraint", async () => {
	const questions = await parseVia(`## No writes to generated code
- This includes every subdirectory.
- Regenerate instead of editing.
`);

	assert.equal(
		questions.length,
		1,
		"a rule and its clarifications must be judged together, not as rival rules",
	);
	assert.match(questions[0] ?? "", /includes every subdirectory/);
	assert.match(questions[0] ?? "", /Regenerate instead of editing/);
});

test("a flat bullet list with no headings splits per top-level bullet", async () => {
	const questions = await parseVia(`- No business logic in transport.
- No new dependencies in core.
- No writes to generated code.
`);

	assert.equal(questions.length, 3);
	assert.match(questions[0] ?? "", /No business logic in transport/);
	assert.match(questions[2] ?? "", /No writes to generated code/);
});

test("nested bullets extend their parent bullet's constraint", async () => {
	const questions = await parseVia(`- No writes to generated code.
  - Including subdirectories.
- No new dependencies in core.
`);

	assert.equal(questions.length, 2);
	assert.match(questions[0] ?? "", /Including subdirectories/);
});

test("asterisk and plus bullets are recognised", async () => {
	const questions = await parseVia(`* First rule.
+ Second rule.
`);

	assert.equal(questions.length, 2);
});

test("a heading with no body still sends the heading as the rule", async () => {
	const questions = await parseVia("## No new dependencies in core\n");

	assert.equal(questions.length, 1);
	assert.match(
		questions[0] ?? "",
		/No new dependencies in core/,
		"the heading is often the whole rule",
	);
});

test("prose before the first heading is not a constraint", async () => {
	const questions = await parseVia(`These are our project rules. Follow them.

## Real rule
Real body.
`);

	assert.equal(questions.length, 1);
	assert.match(questions[0] ?? "", /Real body/);
});

test("prose with no headings and no bullets yields nothing", async () => {
	const questions = await parseVia(
		"This project values clean code and good tests.\n",
	);

	assert.equal(questions.length, 0, "no constraints means no request");
});

test("an empty file yields nothing", async () => {
	const questions = await parseVia("");

	assert.equal(questions.length, 0);
});

test("a whitespace-only file yields nothing", async () => {
	const questions = await parseVia("\n\n   \n\t\n");

	assert.equal(questions.length, 0);
});

test("headings inside fenced code are not boundaries", async () => {
	const questions = await parseVia(`## Real rule
Do not write shell comments like this:

\`\`\`bash
## not a heading
echo hi
\`\`\`

Still the same rule.
`);

	assert.equal(questions.length, 1);
	assert.match(questions[0] ?? "", /Still the same rule/);
});

test("bullets inside fenced code are not boundaries", async () => {
	const questions = await parseVia(`- Real rule about yaml.

  \`\`\`yaml
  - not a bullet constraint
  - also not one
  \`\`\`
`);

	assert.equal(questions.length, 1);
});

test("an oversized constraint is truncated", async () => {
	const questions = await parseVia(`## Huge rule
${"padding text ".repeat(2000)}
`);

	assert.equal(questions.length, 1);
	const text = questions[0] ?? "";
	assert.ok(text.length < 20_000, "an oversized rule must be capped");
	assert.match(text, /truncated/i);
});

test("a top-level heading (#) does not split constraints", async () => {
	const questions = await parseVia(`# Project constraints

## Real rule
Real body.
`);

	assert.equal(
		questions.length,
		1,
		"a document title must not become a constraint",
	);
});
