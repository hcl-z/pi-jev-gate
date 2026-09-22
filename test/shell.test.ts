/**
 * Ticket 04: shell interception, covering deletion and directory creation.
 *
 * pi has no delete tool and no mkdir tool, so these operations can only reach
 * the filesystem through a shell command. The pre-filter is a cost optimisation
 * and is deliberately over-inclusive: read-only commands must cost nothing, but
 * anything plausibly mutating goes to the model.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createGuard } from "../src/guard.ts";
import { REWORK } from "../src/dialog.ts";
import {
	bashCall,
	FakeContext,
	FakeExtensionAPI,
	FakeFileSystem,
	FakeHttp,
	makeDeps,
	powershellCall,
} from "./helpers.ts";

const RULES = "## Protect generated code\nNever delete or rewrite generated/.\n";

function harness() {
	const fs = new FakeFileSystem();
	fs.write("/project/constraints.md", RULES);
	const http = new FakeHttp({ probability: 0.1 });
	const fake = makeDeps({
		fs,
		http,
		settings: JSON.stringify({ jevGate: { apiKey: "k" } }),
	});
	const pi = new FakeExtensionAPI();
	createGuard(pi as never, fake.deps);
	const ctx = new FakeContext();
	// These tests are about which commands get judged, not the dialog.
	ctx.ui.selectAnswers = Array(4).fill(REWORK);
	return { pi, ctx, http };
}

/** True when the command was sent to the model for judgment. */
async function wasJudged(command: string): Promise<boolean> {
	const h = harness();
	await h.pi.fireToolCall(bashCall(command), h.ctx);
	return h.http.requests.length > 0;
}

async function wasJudgedByPowershell(command: string): Promise<boolean> {
	const h = harness();
	await h.pi.fireToolCall(powershellCall(command), h.ctx);
	return h.http.requests.length > 0;
}

const MUTATING = [
	"rm -rf src/generated",
	"rm file.ts",
	"rmdir old",
	"mv src/a.ts src/b.ts",
	"cp template.ts src/new.ts",
	"mkdir -p src/newdir",
	"touch src/placeholder.ts",
	"truncate -s 0 log.txt",
	"echo hello > src/a.ts",
	"cat template >> src/a.ts",
	"echo x | tee src/a.ts",
	"sed -i 's/a/b/' src/a.ts",
	"sed -i '' 's/a/b/' src/a.ts",
	"perl -i -pe 's/a/b/' src/a.ts",
	"npm install lodash",
	"pnpm add left-pad",
	"git checkout -- src/a.ts",
	"git reset --hard",
	"chmod 777 src",
	"ln -s a b",
	"dd if=/dev/zero of=file bs=1M count=1",
	"cd src && rm old.ts",
	"npm test; rm -rf dist",
];

for (const command of MUTATING) {
	test(`mutating command is judged: ${command}`, async () => {
		assert.equal(await wasJudged(command), true);
	});
}

const READ_ONLY = [
	"npm test",
	"npm run build",
	"git status",
	"git diff",
	"git log --oneline -10",
	"ls -la src",
	"cat package.json",
	"grep -rn TODO src",
	"node --version",
	"pwd",
	"which node",
	"echo hello",
	"npm test 2>&1",
	"find . -name '*.ts'",
	"wc -l src/a.ts",
	"head -20 README.md",
];

for (const command of READ_ONLY) {
	test(`read-only command is not judged: ${command}`, async () => {
		assert.equal(
			await wasJudged(command),
			false,
			"read-only commands are the common case and must cost nothing",
		);
	});
}

test("powershell mutating cmdlets are judged", async () => {
	assert.equal(await wasJudgedByPowershell("Remove-Item -Recurse src"), true);
	assert.equal(await wasJudgedByPowershell("New-Item -ItemType Directory x"), true);
	assert.equal(await wasJudgedByPowershell("Set-Content a.ts 'x'"), true);
	assert.equal(await wasJudgedByPowershell("Move-Item a.ts b.ts"), true);
});

test("powershell read-only cmdlets are not judged", async () => {
	assert.equal(await wasJudgedByPowershell("Get-ChildItem src"), false);
	assert.equal(await wasJudgedByPowershell("Get-Content package.json"), false);
});

test("powershell is not a no-op: a shared mutating verb is judged", async () => {
	assert.equal(
		await wasJudgedByPowershell("rm -rf src"),
		true,
		"powershell must get the same treatment as bash, not an empty implementation",
	);
});

test("the command text is what gets judged", async () => {
	const h = harness();

	await h.pi.fireToolCall(bashCall("rm -rf src/generated"), h.ctx);

	const state = h.http.only().body.state as Record<string, unknown>;
	assert.match(String(state.change), /rm -rf src\/generated/);
	assert.match(String(state.operation), /bash/);
});

test("a shell command has no path field in the state", async () => {
	const h = harness();

	await h.pi.fireToolCall(bashCall("rm -rf src/generated"), h.ctx);

	const state = h.http.only().body.state as Record<string, unknown>;
	assert.deepEqual(Object.keys(state).sort(), ["change", "operation"]);
});

test("a violating shell command is blocked with the rule text", async () => {
	const h = harness();
	h.http.options = { probability: 0.95 };

	const result = await h.pi.fireToolCall(
		bashCall("rm -rf src/generated"),
		h.ctx,
	);

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Never delete or rewrite generated/);
});

test("an oversized command is truncated and marked", async () => {
	const h = harness();

	await h.pi.fireToolCall(bashCall(`rm -rf ${"a/".repeat(10_000)}`), h.ctx);

	const state = h.http.only().body.state as Record<string, unknown>;
	const change = String(state.change);
	assert.ok(change.length < 20_000);
	assert.match(change, /truncated/i);
});

test("2>&1 alone does not count as redirection", async () => {
	assert.equal(
		await wasJudged("npm test 2>&1 | tail -5"),
		false,
		"descriptor duplication is not a file write",
	);
});
