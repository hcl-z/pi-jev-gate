# PRD: Jev constraint guard

Status: `ready-for-agent`

## Problem Statement

I keep project rules in a Markdown file — don't put business logic in the transport layer, don't add dependencies to the core package, don't touch the generated directory. The agent has read my `AGENTS.md`, which points at that file, and it still drifts: three turns into a task it writes a file that plainly breaks one of those rules. I only find out later, at review time, after the change has been built on top of.

I don't want the agent to be *told* about my constraints. I want the write to be stopped at the moment it happens, with the specific rule it broke quoted back, so the agent fixes it on the spot instead of me catching it an hour later.

Doing this with an LLM is not attractive: a second chat model in front of every file write costs seconds and cents per call, and returns prose I have to parse. Most tool calls are fine, so the check has to be nearly free or I will turn it off.

## Solution

A pi extension that hooks every file-mutating tool call, asks TypeSafe AI's Jev model whether the change violates any constraint in the project's `constraints.md`, and — when it thinks one is violated — interrupts with a dialog offering three ways forward: send it back for rework, let this one through, or stop asking about that rule for the rest of the session.

Jev fits where an LLM does not. It returns typed probabilities instead of text, evaluates every constraint in one parallel request, runs in 70–500ms, and costs $0.042 per million input tokens with free output. Each constraint becomes one independent yes/no question, so the answer says *which* rule was broken, not just that something was — and that specific rule's text is what gets handed back to the agent to correct against.

The extension is advisory, not a security boundary. Every failure mode — no API key, network down, rate limited, no TUI to ask in — lets the call through with a warning. A guard that breaks the agent when the network hiccups gets uninstalled on day one.

## User Stories

### Setup and configuration

1. As a developer, I want to install the guard with `pi install npm:pi-jev-guard`, so that I don't have to copy files into my pi extensions directory by hand.
2. As a developer, I want to put my TypeSafe API key in my global pi settings, so that it lives outside every project repository and cannot be committed by accident.
3. As a developer, I want `TYPESAFE_API_KEY` in the environment to take precedence over the configured key, so that CI and one-off experiments can override it without editing a file.
4. As a developer, I want the guard to work with no configuration beyond an API key, so that I can try it before deciding what to tune.
5. As a developer, I want a malformed or partially-filled config block to fall back to defaults rather than crash pi, so that a typo in my settings file never costs me a session.
6. As a developer, I want my guard config to survive pi writing other settings, so that using `/model` Ctrl+S doesn't silently drop my configuration.
7. As a developer, I want to raise or lower the violation threshold, so that I can match it to how strictly my constraints happen to be worded.
8. As a developer, I want to pin which Jev version answers, so that a new upstream release does not silently change what my tuned threshold means.
9. As a developer, I want the pinned version to be overridable rather than hardcoded, so that I can move to a newer Jev without waiting for a new release of this extension.

### Constraint discovery

10. As a developer, I want my constraints read from `constraints.md` in the project root, so that the rules sit where a human contributor will find them.
11. As a developer, I want `docs/constraints.md` read as well, so that the file my `AGENTS.md` already points at is the one that takes effect.
12. As a developer, I want the filename matched case-insensitively, so that `CONSTRAINTS.md` works as well as `constraints.md`.
13. As a developer, I want both locations read and merged when both exist, so that a rule I wrote in one file is never silently ignored because another file also exists.
14. As a developer, I want each constraint to remember which file it came from, so that I know where to go to edit it.
15. As a developer, I want my constraints file re-read when I change it, so that I can tighten a rule and see the effect on the next tool call without restarting pi.
16. As a developer with no constraints file, I want the guard to stay completely silent and never call the API, so that installing it globally costs nothing in projects that don't use it.

### Constraint parsing

17. As a developer, I want each `##` or `###` section of my constraints file treated as one constraint, so that the structure I already use for readability is the structure the guard enforces.
18. As a developer, I want bullets under a heading to belong to that heading's constraint, so that a rule's clarifications and exceptions are judged together with the rule rather than as contradictory separate rules.
19. As a developer with a flat bulleted list and no headings, I want each top-level bullet treated as one constraint, so that the guard works with the simpler format too.
20. As a developer, I want the heading text used as the constraint's display name, so that the dialog and logs identify rules by names I recognise.
21. As a developer, I want to see how my file was split into constraints, so that I can fix my formatting when the split doesn't match what I intended.
22. As a developer whose constraints file contains no recognisable constraints, I want the guard to do nothing rather than send an empty or nonsensical request, so that a prose-only file doesn't produce garbage judgments.

### Interception

23. As a developer, I want every `write` call checked, so that new files and full rewrites are covered.
24. As a developer, I want every `edit` call checked, so that in-place modifications are covered.
25. As a developer, I want file deletions checked, so that the destructive case I care most about is covered — even though pi has no delete tool and deletions can only reach the filesystem through a shell command.
26. As a developer, I want directory creation and file moves checked, so that structural changes are covered by the same mechanism.
27. As a developer, I want shell commands that only read — test runs, `git status`, builds — to skip the check entirely, so that the guard adds no latency or cost to the majority of shell calls.
28. As a developer on Windows, I want `powershell` commands checked on the same terms as `bash`, so that the guard is not a no-op on my machine.
29. As a developer, I want the shell pre-filter to err towards sending a command for judgment when it is ambiguous, so that the final decision about whether something is a mutation is made by the model and not by a regular expression.

### Judgment

30. As a developer, I want all my constraints evaluated in a single request, so that checking twenty rules costs about the same wall-clock time as checking one.
31. As a developer, I want each constraint judged independently of the others, so that one rule's answer cannot contaminate another's.
32. As a developer, I want only the path, the operation and the change itself sent for judgment, so that the model isn't distracted by irrelevant context that would degrade its accuracy.
33. As a developer editing a file, I want the before/after text of each edit sent, so that the model judges the actual change rather than guessing from the filename.
34. As a developer, I want oversized changes truncated with the truncation marked explicitly, so that a huge file neither blows the model's context budget nor silently misrepresents itself as complete.
35. As a developer, I want a violation reported when a constraint's probability crosses my threshold, so that borderline cases don't interrupt me constantly.
36. As a developer whose change breaks several rules at once, I want all of them reported together, so that I fix everything in one pass instead of being interrupted once per rule.
37. As a developer, I want pressing Escape during a check to cancel the in-flight request, so that the guard never leaves me waiting on a network call I no longer care about.

### The dialog

38. As a developer, I want to be shown which constraint was violated, so that I can judge whether the model is right.
39. As a developer, I want to be shown which file that constraint came from, so that I can go edit the rule if it's the rule that's wrong.
40. As a developer, I want to be shown the actual probability, so that I can accumulate a feel for where my threshold should sit.
41. As a developer, I want to send the change back for rework, so that the agent corrects it instead of me doing so by hand.
42. As a developer, I want the violated constraint's own text handed back to the agent, so that it knows what to change rather than merely that something was rejected.
43. As a developer, I want to let a single change through, so that a one-off justified exception doesn't require me to edit my constraints file.
44. As a developer, I want to silence one constraint for the rest of the session, so that a rule that keeps misfiring on my current task doesn't make me reject the same dialog ten times.
45. As a developer, I want that silencing to be session-scoped and never written to disk, so that I can't accidentally weaken my project's rules permanently.
46. As a developer, I want Escape to mean rework, so that dismissing the dialog is the safe action rather than the permissive one.
47. As a developer, I want the dialog to wait indefinitely, so that a countdown never lets a change through while I'm reading the diff.

### Degradation

48. As a developer with no API key configured, I want my tool calls to proceed with a one-time hint about configuring one, so that installing the extension before setting it up doesn't block my work.
49. As a developer whose network is down, I want my tool calls to proceed with a warning, so that a connectivity problem never becomes a work stoppage.
50. As a developer who is rate limited or hitting an overloaded service, I want my tool calls to proceed with a warning, so that TypeSafe's capacity is not a dependency of my ability to edit files.
51. As a developer in print or JSON mode, where there is no dialog to show, I want tool calls to proceed without an API call being made, so that non-interactive runs are neither blocked nor billed.
52. As a developer, I want every degraded pass-through to be visible, so that I never mistake "the guard found nothing" for "the guard didn't run".

### Logging

53. As a developer tuning my threshold, I want every check appended to a log file, so that I can look at which probabilities corresponded to decisions I agreed with.
54. As a developer, I want that log to be one machine-readable record per line, so that I can aggregate hundreds of checks instead of reading them one at a time.
55. As a developer, I want the log to include exactly what was sent and exactly what came back, so that I can diagnose a judgment I disagree with.
56. As a developer, I want the log to record which button I pressed, so that my own decisions are the labelled data I calibrate the threshold against.
57. As a developer, I want degraded pass-throughs logged too, so that a gap in enforcement is visible after the fact.
58. As a developer, I want the log kept outside my project directory, so that change content captured in it cannot be committed to the repository.
59. As a developer, I want my API key to never appear in the log, so that sharing a log for debugging is not a credential leak.
60. As a developer, I want logging off unless I turn it on, so that the guard does not accumulate a record of my file contents by default.
61. As a developer, I want a log write failure to warn once and then be ignored, so that a full disk or a permissions problem never changes whether a tool call is allowed.

### Inspection

62. As a developer, I want a command that shows the constraints the guard parsed, so that I can confirm my file was understood before trusting the guard.
63. As a developer, I want that command to show my effective configuration with the key redacted, so that I can confirm the threshold and model in effect without exposing the secret.
64. As a developer, I want that command to list which constraints I've silenced this session, so that I remember what I turned off.
65. As a developer, I want to clear that silenced list, so that I can re-enable a rule after finishing the task that conflicted with it.
66. As a developer, I want to disable the guard for the rest of the session, so that a focused piece of work can proceed without interruption while the guard remains installed.

## Implementation Decisions

### Interception point

The extension subscribes to pi's `tool_call` event. It fires after `tool_execution_start` and before the tool runs, is `async` (so it can await both a network call and a user dialog), and its return value controls blocking via `{ block: true, reason }`. The `reason` string is surfaced to the model as the tool result, which is exactly the "send it back for rework" semantics required — no separate mechanism is needed to tell the agent what went wrong.

`terminate: true` is deliberately not used. The agent receiving a reason and correcting itself is the desired loop; terminating the run would cut that loop off. A user who wants a hard stop presses Escape.

### Tools covered

pi 0.85.1's built-in tool set is `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`. **There is no delete tool and no mkdir tool.** Deletions, moves and directory creation can only reach the filesystem through `bash` or `powershell`. Covering only `write` and `edit` would therefore miss the deletion case entirely.

- `write` and `edit` are always sent for judgment. Their arguments are typed and carry both path and content; `edit`'s `oldText`/`newText` pairs are already a diff, so nothing needs to be read from disk.
- `bash` and `powershell` pass through a local pre-filter that looks for evidence of filesystem mutation — the usual mutating commands, in-place stream editing, and output redirection. Only matches are sent for judgment.

The pre-filter is intentionally over-inclusive: it is a cost optimisation, not a decision. Anything plausibly mutating goes to the model; the model decides whether it violates a constraint. This is always on and not configurable.

### Constraint file discovery and parsing

Two candidate locations, the project root and `docs/`, each matched case-insensitively against `constraints.md` by listing the directory rather than probing fixed spellings. Both files are read when both exist and their constraints are concatenated, each tagged with its source file. Merging rather than precedence is a deliberate choice: a rule that was written but silently ignored is the worst failure mode this feature can have.

Files are `stat`ed before each check and re-read when modification time changes. The cost of a `stat` is negligible against a network round trip, and requiring a restart to pick up an edited rule would be a constant irritation.

Parsing produces a list of `{ name, text, sourceFile }`. If the document contains `##` or `###` headings, each heading and its body — including any bullets beneath it — is one constraint, named by its heading. Otherwise each top-level bullet is one constraint, named by a truncation of its own text. Grouping bullets under their heading rather than splitting them out is driven by Jev's documented weakness on contradictory instructions: a rule and its exception must be judged together or they fight each other.

An empty parse result disables the extension for that check with no API call.

### Question construction

One request per intercepted tool call, containing one `noul` (yes/no probability) question per constraint, keyed by a stable per-constraint identifier. Question IDs are never sent to the model, so each question's `instructions` carries the full constraint text plus the instruction to judge whether the described change violates it.

`noul` rather than `choice` or `score`: the answer needed is a probability of a boolean, `noul` returns exactly that, and Jev's documented lack of structural invariants between question types means mixing types would produce values that cannot be compared against one threshold. No severity dimension is asked for — severity is a property of the rule as its author sees it, not of the change, and adding it would introduce a second threshold with no data to calibrate it against.

The `state` sent for judgment contains only the operation kind, the target path, and the change itself (file content for `write`, the edit pairs for `edit`, the command text for shell tools). Content over a fixed size is truncated with the truncation explicitly marked in the state. Target file contents are deliberately *not* read and included: Jev's published failure modes name large states full of irrelevant detail as an accuracy problem, and the change itself is what the constraint is about.

### Verdict and threshold

A constraint is violated when its returned `noul` exceeds the configured threshold, defaulting to `0.6`. All violations above threshold are reported together.

The default is above `0.5` because constraint text is prose and Jev reads instructions literally; loosely-worded rules produce noise near the coin-flip line, and a guard that cries wolf gets disabled. The actual probability is always displayed so the user can converge on their own value — the vendor's own guidance is that published thresholds are examples to evaluate, not universal rules.

The model defaults to a pinned version rather than the moving `jev-latest` alias, because the alias advancing would silently change what a tuned threshold means. It remains configurable so a user is never blocked from a newer model by this extension's release cadence.

### Dialog

Shown only when pi reports an interactive UI is available. Presents the violated constraint's name, its source file and its probability, with three outcomes:

| Choice | Effect |
| --- | --- |
| Rework | Block the call; hand the violated constraint's text back as the reason |
| Allow once | Proceed; record nothing |
| Ignore this constraint for the session | Proceed; exclude that constraint from subsequent checks until the session ends |

Escape is equivalent to Rework. No timeout is set: an auto-dismissing gate is not a gate.

The session ignore list is in-memory only and keyed by constraint identity. It is never persisted, so it cannot quietly weaken a project's rules beyond the current session.

### Degradation

Every abnormal condition results in the tool call proceeding, accompanied by a warning: missing API key (with a one-time configuration hint), network failure, timeout, HTTP `401`/`422`/`429`/`529` or any other error status, an unparseable response, and an empty constraint list.

No interactive UI (`-p`, JSON mode) also results in proceeding, and additionally skips the API call entirely — the outcome is predetermined, so paying for the judgment would be waste.

This is a uniform policy, decided explicitly: the extension is a constraint advisor, not a security control. Its unavailability must never be the reason a developer cannot edit a file.

### HTTP client

Direct `fetch` against TypeSafe's System One endpoint with a bearer token. No SDK dependency: the request is a single JSON POST, and a dependency-free extension avoids both a version coupling and the published SDK's retry defaults, which are too patient for a gate a human is waiting behind. pi's current agent abort signal is passed to `fetch` so that Escape cancels an in-flight judgment. Short timeout with a single retry. Results are not cached — after a rework the agent produces different content, so a content-keyed cache would rarely hit and would add invalidation complexity for nothing.

### Configuration

A single `jevGuard` object in pi's global settings file, all fields optional:

```json
{
  "jevGuard": {
    "apiKey": "…",
    "threshold": 0.6,
    "model": "jev-1.13.0",
    "log": false
  }
}
```

Global rather than project-local, because the API key belongs there — a home-directory file cannot be committed by accident, whereas a project `.pi/` file can. `TYPESAFE_API_KEY` in the environment takes precedence over `apiKey`.

pi's `Settings` type does not declare a slot for extension keys, so the block is read by parsing the settings file directly. This was verified to be safe: pi's settings writer merges over the existing parsed file and its migration step does not strip unknown keys, so `jevGuard` survives pi saving unrelated settings. Reading is fully defensive — absent block, wrong types, unparseable file all fall back to defaults without surfacing an error.

Deliberately *not* configurable, to keep the surface small: the headless policy (always skip), shell scanning (always on), request timeout, constraint file paths, and a global enable flag (the session toggle plus uninstalling already cover it). Each can be added later without a breaking change, since adding a key with today's behaviour as its default is backwards compatible.

### Logging

Off by default. When `log` is true, one JSON record per line is appended to a fixed path inside pi's agent directory, resolved through pi's exported accessor rather than a hardcoded `~/.pi/agent` so that rebranded distributions land correctly.

Each record carries: timestamp, tool name, target path, the full state that was sent, the parsed constraint names, every returned probability, token usage, elapsed time, the final verdict (allowed, blocked, ignored, or degraded with its reason), and which dialog choice the user made. Degraded pass-throughs are logged, because a gap in enforcement must be visible after the fact.

Line-delimited JSON specifically because the log's primary purpose is threshold calibration — the user needs to aggregate across many checks and correlate probabilities against their own recorded choices.

Change content is written unredacted. This is acceptable because the log lives outside any project directory and so cannot be committed; the risk accepted knowingly. The API key never appears in the log in any form. A write failure warns once and is thereafter ignored; logging never influences whether a tool call proceeds.

### Inspection command

A slash command registered with pi that reports the parsed constraints with their source files and split boundaries, the effective configuration with the key redacted, and the session ignore list; and that can clear the ignore list or disable the guard for the session.

Its primary purpose is observability of parsing. A mismatch between the user's intended constraint boundaries and the parser's output is the single most likely failure of this feature, and without this command it is invisible.

### Packaging

An npm package laid out as a directory extension with a `pi.extensions` entry in its manifest, installable via pi's package mechanism. No runtime dependencies. TypeScript is loaded directly by pi, so no build step is required for the extension itself.

## Testing Decisions

### What a good test looks like here

Tests assert on **externally observable behaviour of the extension**: given a constraints file on disk, a configuration, and a tool call, either the call is blocked with a particular reason or it proceeds; a request is sent to Jev with a particular shape, or no request is sent at all; a particular record is appended to the log. Tests do not reach into parsing internals, HTTP client internals, or verdict structs.

The parser is the component most likely to be wrong, but it does not need its own seam: the set of questions in the outgoing request *is* the parse result, so parsing is asserted by inspecting what was sent. This keeps the seam count at one.

### The seam

One seam: the extension's factory function, parameterised with injectable dependencies that default to the real implementations — HTTP transport, filesystem root, clock, and log sink. pi's public extension contract takes only its API object, so the published entry point is a thin wrapper that calls the parameterised factory with real defaults. Tests drive the identical code path.

Around that seam, tests supply a test double for pi's extension API (capturing registered event handlers and commands) and for its context (a scriptable UI that records prompts and returns chosen answers, a configurable UI-availability flag, a working directory, and an abort signal). The `tool_call` handler is then invoked directly and its return value asserted.

This is the highest available seam: everything below it — config resolution, discovery, parsing, pre-filtering, request construction, thresholding, dialog flow, degradation, logging — is exercised through it.

### Coverage at that seam

- **Discovery and merge**: root only, `docs/` only, both merged, uppercase filename, no file at all (no request made), file changed mid-session (re-read).
- **Parsing**, asserted via the outgoing question set: heading-delimited, bullets grouped under their heading, flat bullet list, oversized constraint truncated, unparseable document (no request made).
- **Pre-filter**: `write` and `edit` always sent; mutating shell commands sent; read-only shell commands not sent; `powershell` treated like `bash`.
- **Request shape**: one `noul` per constraint, full constraint text in the instructions, state limited to operation/path/change, oversized change truncated and marked.
- **Verdict**: above threshold blocks, below threshold proceeds, threshold boundary behaviour, multiple simultaneous violations all reported, custom threshold honoured.
- **Dialog outcomes**: rework blocks and the reason contains the constraint text; allow-once proceeds and does not affect the next call; session-ignore proceeds and the constraint is absent from the next request; Escape behaves as rework.
- **Degradation**, each asserting the call proceeds and a warning is emitted: no key, network error, timeout, each relevant HTTP status, malformed response body. No-UI mode additionally asserts that no request was made.
- **Logging**: disabled by default (nothing written); enabled writes one parseable line per check with the expected fields; the API key appears nowhere in the output; a failing log sink does not change the verdict; degraded checks are logged.
- **Cancellation**: an aborted signal ends the check without blocking.
- **Command**: reports parsed constraints; redacts the key; clearing the ignore list restores the constraint to the next request.

### Prior art

There is no existing test suite in this repository — this feature establishes it. Node's built-in test runner and assertions are used, consistent with the zero-runtime-dependency decision; no test framework is added. Tests run against temporary directories for constraint-file fixtures and never touch the developer's real pi agent directory.

The reference material in `docs/reference/` is the source of truth for both sides of the contract: `pi-extensions.md` for event, context and command semantics, and `jev-typesafe-ai.md` for the request and response shapes, limits and documented failure modes.

## Out of Scope

- **Any constraint format beyond Markdown headings and bullets.** No frontmatter, no per-rule severity, no path globs restricting which files a rule applies to. Severity in particular was considered and rejected for this version; when it arrives it belongs as an authored annotation, not a model judgment.
- **Persisting decisions.** Nothing the user chooses in the dialog is written to disk. No permanent per-constraint suppression, no remembered allowances.
- **Caching judgments.** Reworked changes differ from the change that was rejected, so a content-keyed cache would rarely hit.
- **Project-local configuration.** One global config block. Per-project thresholds are a plausible future addition but not now.
- **Non-file tool calls.** Network access, process spawning and other side effects reached through shell commands are not judged; only filesystem mutation is in scope.
- **Reading surrounding code for context.** The judgment sees the change, not the file it lands in, nor the project structure.
- **Editing constraints from within the dialog.** Changing a rule is a separate activity from approving a change.
- **Terminating the agent run.** Blocking hands control back to the model to correct itself.
- **Other System One question types.** No `choice` or `score` questions in this version.
- **Providers other than TypeSafe's direct API.** The Vercel AI Gateway and Cloudflare Workers AI both expose Jev, but with renamed fields and different limits; supporting them means an abstraction this version does not need.
- **Hardening against adversarial constraint or change content.** Jev's documentation is explicit that state is treated as data and not as hostile, so a crafted diff can in principle influence the judgment. This is an advisory guard; it is not a defence against a deliberately malicious agent.

## Further Notes

**This guard is not a security boundary, and the implementation should not drift towards treating it as one.** Every ambiguity resolves towards letting work proceed. The value proposition is catching honest drift early, not preventing deliberate circumvention — anything that can run a shell command can bypass this trivially.

**Jev reads instructions literally.** This shapes user-facing guidance more than code: a constraint written as an unambiguous condition performs far better than one that relies on inferring intent. Its published jaggedness list — literal reading, unreliable arithmetic and date comparison, accuracy loss from indirection and from large irrelevant states, no guaranteed structural invariants between question types — motivated several decisions above and should be consulted before changing question construction.

**The parsing boundary is the likeliest source of user confusion.** A rule the user thinks is one constraint being split into three, or three being merged into one, produces judgments that look arbitrary. The inspection command exists for this reason and should be mentioned prominently in the README.

**Threshold defaults are a guess.** `0.6` is reasoned, not measured. The logging feature exists so that users — and future versions of this extension — can replace it with a number derived from real decisions. Displaying the probability in the dialog serves the same end.

**Pinning the model version matters more than it appears.** TypeSafe's own documentation instructs pinning once thresholds are tuned, because an alias advancing changes answers with no change on the caller's side. A user who tunes against the moving alias will eventually see their guard's behaviour shift for no visible reason.
