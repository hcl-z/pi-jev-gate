# pi-jev-gate

Check file changes against your project's written constraints, at the moment they happen.

Your agent has read your `AGENTS.md`. It still drifts — three turns into a task it writes a file that plainly breaks one of your rules, and you find out at review time, after other work has been built on top.

This pi extension hooks every file-mutating tool call, asks [TypeSafe AI's Jev](https://typesafe.ai) whether the change violates any rule in your `constraints.md`, and interrupts when it thinks one is broken:

```
This change appears to violate a project constraint:

  • No business logic in transport  [constraints.md, 0.91]

What would you like to do?
› Send back for rework
  Allow this change
  Ignore this constraint for the session
```

Choosing rework hands the rule's own text back to the agent, which then corrects itself.

Jev fits where a second LLM would not: it returns typed probabilities instead of prose, evaluates every rule in one parallel request, answers in 70–500ms, and costs $0.042 per million input tokens with free output. Each rule becomes one independent question, so the answer says *which* rule was broken — and that rule's text is what the agent gets back.

## Install

```bash
pi install npm:pi-jev-gate
```

Then add your TypeSafe API key to `~/.pi/agent/settings.json`:

```json
{
  "jevGate": {
    "apiKey": "your-key"
  }
}
```

`TYPESAFE_API_KEY` in the environment takes precedence, which is usually what you want in CI.

## Write your constraints

Create `constraints.md` in your project root, or `docs/constraints.md` — both are read, and both are merged if you have both. The filename is matched case-insensitively.

Each `##` or `###` heading is one rule:

```markdown
## No business logic in transport

Transport modules must not contain business rules. Parsing, validation and
calculation belong in the domain layer.

## No writes to generated code

Never edit anything under `src/generated/`, including subdirectories.
Regenerate instead.
```

Bullets under a heading belong to that heading's rule. That matters: a rule and its exceptions must be judged together, or they contradict each other.

A flat list with no headings works too — each top-level bullet is one rule:

```markdown
- No business logic in transport modules.
- No new dependencies in the core package.
- No writes to generated code.
```

Run `/jev-gate` to see how your file was actually split. **Do this once before you trust the guard** — a rule you think is one constraint being split into three is the most likely thing to go wrong, and it is otherwise invisible.

### Write rules the way you would write a contract

Jev reads instructions literally. It answers the question you wrote, not the one you meant. `Don't put logic in the wrong place` will not work; `Transport modules must not contain parsing, validation or calculation` will. If you look at a wrong answer and find yourself explaining what you really meant, that explanation is the missing half of the rule.

## What gets checked

| Tool | When |
| --- | --- |
| `write` | Always |
| `edit` | Always |
| `bash` | When the command looks like it changes files |
| `powershell` | Same |

pi has no delete tool and no mkdir tool, so deletions, moves and directory creation only reach the filesystem through a shell command. Those are checked. Read-only commands — `npm test`, `git status`, `ls` — are not sent at all, so they cost nothing.

Only the operation, the path and the change itself are sent. The target file's existing contents and your project structure are deliberately left out: Jev loses accuracy when the input carries detail the question does not need.

## Configuration

All fields are optional. Global settings only, in `~/.pi/agent/settings.json`:

```json
{
  "jevGate": {
    "apiKey": "your-key",
    "threshold": 0.6,
    "model": "jev-1.13.0",
    "log": false
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKey` | — | TypeSafe API key. `TYPESAFE_API_KEY` wins if set |
| `threshold` | `0.6` | Probability above which a rule counts as violated |
| `model` | `jev-1.13.0` | Which Jev version answers |
| `log` | `false` | Append every decision to a log file |

A malformed config block falls back to these defaults rather than failing — a typo should never cost you a session.

### About the threshold

`0.6` is reasoned, not measured. It sits above the coin-flip line because rule text is prose and Jev reads it literally, so loosely-worded rules produce noise near `0.5` — and a guard that cries wolf gets switched off.

The right number for your project depends on how your rules are written. The dialog always shows the actual probability, so after a dozen decisions you will know whether to move it. Turn on `log` to do this properly: it records every probability alongside the button you pressed, which is the labelled data you need.

### Why the model version is pinned

`jev-latest` is an alias that moves when TypeSafe ships a release. If you tune `threshold` against a moving alias, your guard's behaviour will change one morning for no visible reason. This extension pins a version by default for that reason; override `model` when you want to move, and re-check your threshold when you do.

## The three choices

| Choice | What happens |
| --- | --- |
| Send back for rework | The call is blocked; the agent receives the rule's text and corrects itself |
| Allow this change | The call proceeds. Nothing is remembered |
| Ignore this constraint for the session | The call proceeds, and that rule stops being checked until pi restarts |

When several rules fire at once, the third option becomes *Ignore one of these constraints…* and asks which one — silencing a rule you did not name would quietly widen the hole you meant to poke.

Escape means rework — dismissing the dialog is the safe action, not the permissive one. There is no timeout: a gate that lets things through while you read a diff is not a gate.

The ignore list is in memory only and is never written to disk, so it cannot quietly weaken your project's rules beyond the current session. `/jev-gate clear` restores everything.

## `/jev-gate`

```
/jev-gate          show parsed constraints, config and the ignore list
/jev-gate clear    stop ignoring everything
/jev-gate off      disable for this session
/jev-gate on       re-enable
```

## When it does not run

**Everything that goes wrong lets your change through**, with a warning telling you the check was skipped:

- no API key configured
- network failure, timeout, rate limiting, service overload
- a response that cannot be read

A project with no `constraints.md` is different: the guard stays completely silent and never calls the API, so installing it globally costs nothing in projects that don't use it.

This is deliberate. The guard is a constraint advisor, not a security boundary — anything that can run a shell command can bypass it trivially. Its value is catching honest drift early, and a guard that breaks your agent when the network hiccups is a guard you uninstall on day one.

It also does not run in `pi -p` or JSON mode. There is no dialog to ask in, so the outcome would be predetermined, and paying for a judgment nobody can act on would be waste.

Escape cancels an in-flight check.

## The log

With `log: true`, every check appends one JSON line to `~/.pi/agent/jev-gate.jsonl`:

```json
{"timestamp":"...","tool":"write","path":"src/transport.ts","operation":"create or overwrite a file","change":"...","constraints":[...],"probabilities":{"constraints.md#No business logic in transport":0.91},"violations":["constraints.md#No business logic in transport"],"threshold":0.6,"model":"jev-1.13.0","verdict":"blocked","userChoice":"rework","elapsedMs":180,"inputTokens":312,"outputTokens":24}
```

One record per line, so you can aggregate:

```bash
# Which probabilities did I actually allow through?
jq -r 'select(.userChoice=="allow-once") | .probabilities | to_entries[] | .value' \
  ~/.pi/agent/jev-gate.jsonl | sort -n
```

Skipped checks are logged too, as `verdict: "degraded"`, so a gap in enforcement is visible afterwards.

**The log records your file changes verbatim.** It lives in pi's agent directory, outside any project, so it cannot be committed by accident — but it is a plaintext record of what you wrote, so treat it accordingly. Your API key never appears in it.

A log write failure warns once and is then ignored. Logging never affects whether a change is allowed.

## Limits worth knowing

Jev is good at semantic judgment and bad at some things you might reach for:

- **Arithmetic and counting.** Not a calculator. Rules about "no more than N of X" will not work reliably.
- **Dates.** Read as text, not as ordered values.
- **Indirection.** A rule about a property of a property costs accuracy. Name the thing directly.
- **Adversarial content.** Diffs are treated as data, not as hostile input. A crafted change can in principle influence the judgment — another reason this is not a security boundary.

TypeSafe publishes [the full list](https://docs.typesafe.ai/model-jaggedness/jev-1.13). Typed output guarantees the interface, not the truth: validate the guard against your own rules before relying on it.

## Development

```bash
npm test        # node --test, no framework
npm run typecheck
```

Node 22+. No runtime dependencies. TypeScript runs directly under pi with no build step.

## License

MIT
