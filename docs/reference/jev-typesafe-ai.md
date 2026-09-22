# Jev (TypeSafe AI) — how to use it

Research notes on TypeSafe AI's Jev model: what it is, the wire API, the SDKs, the gateways that resell it, and the failure modes to code around. Primary sources are TypeSafe's own docs (`docs.typesafe.ai`, which serves Markdown by appending `.md` to any page path) plus first-party provider docs. Fetched 2026-09-22; version-specific facts are pinned to `jev-1.13.0`.

## What it is

Jev is TypeSafe AI's first **System One model**, announced 2026-09-16 ([launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev), `datePublished 2026-09-16`). It is **not a chat or code-generation model** and cannot be swapped in as the LLM behind a coding agent ([Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents.md)). You send it one `state` plus a map of typed `questions`; it returns one typed answer per question, with probabilities. It does not generate text ([Introduction](https://docs.typesafe.ai/introduction.md)).

Mechanically it is "a frontier-intelligence function call: unstructured state in, typed probabilistic decisions out" (launch blog). Answers are constrained to the options you supplied, so schema violations are structurally impossible rather than merely unlikely — TypeSafe's own hallucination chart plots it as 0% on the grounds that "schema matching is guaranteed" (launch blog, *Hallucination and Type-safety*). Every question in a request is evaluated in parallel and **in isolation**: adding questions barely changes latency and cannot contaminate the other answers ([Introduction](https://docs.typesafe.ai/introduction.md)).

Trained with Reinforcement Learning for Calibrated Decisions (RLCD) rather than RLHF/RLVR; the claimed headline is 193.6x faster and 444.6x cheaper than LLMs on TypeSafe's own workflow evals, with end-to-end latency of 70–500ms (launch blog; [typesafe.ai](https://typesafe.ai/)). Treat those as vendor numbers measured on vendor-built workflows — the blog's own *Nuance* sections concede the workflows were authored by TypeSafe's model-capabilities team and that the reference answers are the average of GPT-6 Astra and Fable 5.1.

### Access status

At launch Jev was **early access behind a waitlist** (launch blog, *What's next*; [InfoWorld](https://www.infoworld.com/article/4223468/typesafe-ais-new-models-work-with-machines-not-humans.html): "Jev is currently maintaining a waitlist"). I could not confirm from a primary source whether that gate has since been lifted — a `source_check` on "generally available" returned only low-trust secondary pages. If you do not have a TypeSafe key, the Vercel AI Gateway and Cloudflare Workers AI paths below are separate front doors worth trying.

## The three primitives

All three can be mixed in one request ([Primitives](https://docs.typesafe.ai/primitives.md)).

| Type | `criteria` shape | Answer fields |
| --- | --- | --- |
| `noul` | optional `{ true?, false? }` descriptions | `noul` — P(yes), 0 to 1. **No `confidence`** |
| `choice` | required map `option → description` (`null` = undescribed); **max 255 options** | `choice`, `probabilities` (map, sums to 1), `confidence` |
| `score` | required ordered array of level descriptions; **≥2, max 10** | `score` (probability-weighted, can land between levels), `legend`, `probabilities` (keyed by level index as string), `confidence` |

Source: [API reference](https://docs.typesafe.ai/api.md), [Primitives](https://docs.typesafe.ai/primitives.md), and the JS SDK's [`types.ts`](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts).

A Noul has no separate confidence because its distribution has only two outcomes — the single value describes it completely ([Noul](https://docs.typesafe.ai/primitives/noul.md)). Near 0.5 means "yes and no are equally likely", **not** "medium intensity"; if you want intensity, use a Score with defined levels ([Primitives](https://docs.typesafe.ai/primitives.md)).

Question **IDs are never sent to the model** — put the full question in `instructions` even when the key looks self-explanatory ([Primitives](https://docs.typesafe.ai/primitives.md)).

`state`, `instructions`, and every `criteria` description accept a string, a JSON object, or a JSON array. Point a question at part of a structured state with a backticked path such as `` `ticket.messages[0].text` `` ([State](https://docs.typesafe.ai/concepts/state.md), [Primitives](https://docs.typesafe.ai/primitives.md)).

## HTTP API

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "model": "jev-latest",
  "questions": {
    "is_urgent": {
      "type": "noul",
      "instructions": "Does this convey urgency?",
      "criteria": { "true": "Explicitly time-sensitive", "false": "No urgency expressed" }
    },
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "billing": "Payments, invoicing, refunds",
        "technical": "Bugs, outages, integrations",
        "sales": "Pricing, upgrades, new accounts"
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer?",
      "criteria": ["Calm", "Frustrated", "Very angry"]
    }
  }
}
```

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "is_urgent": { "type": "noul", "noul": 0.95 },
    "department": {
      "type": "choice",
      "choice": "billing",
      "probabilities": { "billing": 0.88, "technical": 0.12, "sales": 0.0 },
      "confidence": 0.81
    },
    "frustration": {
      "type": "score",
      "score": 1.05,
      "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      "probabilities": { "0": 0.0, "1": 0.95, "2": 0.05 },
      "confidence": 0.92
    }
  },
  "usage": { "input_tokens": 296, "output_tokens": 20 }
}
```

Source: [API reference](https://docs.typesafe.ai/api.md), [Quick start](https://docs.typesafe.ai/introduction/quickstart.md).

Errors: `401` bad key, `422` validation failure (body names the offending field), `429` rate limited, `529` overloaded. Retry 429/529 with exponential backoff ([API reference](https://docs.typesafe.ai/api.md)).

`GET /v1/models` lists the names your account may send. It currently returns only the aliases; versioned IDs are accepted whether or not they are listed ([Models](https://docs.typesafe.ai/models.md)).

## Model names and limits (`jev-1.13.0`)

| | |
| --- | --- |
| Aliases | `jev-latest` → `jev-1.13.0`; `jev-preview` → `jev-1.13.0` (no preview build right now) |
| Price | $0.042 / Mtok input ($42 / Btok). **Output tokens free** |
| Rate limits | 250,000 tokens/sec and 1,200 requests/min |
| Context | 64k tokens per request total; 32k for `state` + the single longest question |
| Input | Text only — string, JSON object, or array of text values. No image/audio/video |

Source: [Models](https://docs.typesafe.ai/models.md). TypeSafe warns these rate limits "can change without notice" while they scale.

The response's `model` field reports the versioned ID that actually answered. Aliases move when a release ships, so **pin `jev-1.13.0` once you have tuned thresholds against it** and move deliberately ([Models](https://docs.typesafe.ai/models.md)).

There is no fine-tuning or LoRA — the same weights serve every account. You adapt it through `state`, `instructions`/`criteria`, and decomposition in code ([Models](https://docs.typesafe.ai/models.md)). English is the primary training language; CJK is accepted but less accurate.

## SDKs

Both SDKs read `TYPESAFE_API_KEY` from the environment and default to `jev-latest`, and both retry automatically.

### Python — `typesafe-sdk` (0.7.1, requires Python ≥3.10)

```bash
pip install typesafe-sdk   # or: uv add typesafe-sdk
```

```python
from typesafe_sdk import Choice, Noul, Score, TypeSafeClient

with TypeSafeClient() as client:
    response = client.system_one(
        state={"document": "I was charged twice. Please fix this ASAP."},
        questions={
            "billing": Noul(instructions="Is this ticket about billing?"),
            "tone": Choice(
                instructions="What is the customer's tone?",
                criteria={"calm": None, "frustrated": None, "angry": None},
            ),
            "urgency": Score(
                instructions="How urgent is this ticket?",
                criteria=["can wait", "this week", "today"],
            ),
        },
    )

print(response.nouls["billing"].noul)
print(response.choices["tone"].choice)
print(response.scores["urgency"].score)
```

`AsyncTypeSafeClient` mirrors it with `await client.system_one(...)` and `async with`. Answers are reachable either by type view (`response.nouls[...]`) or generically (`response.answers[...]`). Source: [Python SDK](https://docs.typesafe.ai/sdk/python.md), [Quick start](https://docs.typesafe.ai/introduction/quickstart.md). Version from PyPI, 2026-09-22.

### JavaScript / TypeScript — `@typesafe-ai/sdk` (0.6.0, requires Node ≥20)

```bash
npm install @typesafe-ai/sdk
```

```ts
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();
const response = await client.systemOne({
  state: { document: "I was charged twice. Please fix this ASAP." },
  questions: {
    category: choice("What is this ticket about?", {
      billing: null,
      technical: null,
      other: null,
    }),
  },
});

console.log(response.answers.category.choice); // "billing" | "technical" | "other"
```

Answer types are **inferred from the questions** — a Choice's `choice` narrows to a union of your option keys, and a fixed-length Score tuple narrows its level indices ([`types.ts`](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts)). Ships ESM, CJS, and declarations ([JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md)). Version from the npm registry, 2026-09-22.

### Client configuration (both SDKs)

| Env var | Purpose | Default |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | API key | required |
| `TYPESAFE_BASE_URL` | API root | `https://api.typesafe.ai` |
| `TYPESAFE_DEFAULT_MODEL` | default model | `jev-latest` |
| `TYPESAFE_LOG_LEVEL` | log verbosity | `warn` |

Timeout is **per attempt** with no total retry budget: 10s (`DEFAULT_TIMEOUT = 10.0` in Python, `timeout: 10000` in JS). Default retry policy: `maxRetries: 2`, 500ms initial backoff doubling to 5s, 0.25 jitter, retrying 408/429/500–599 plus connection and timeout errors, honoring `Retry-After` up to 60s. Sources: [Python constants](https://docs.typesafe.ai/sdk/python/api/constants.md), [`TypeSafeClientConfig`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig.md) and `RetryPolicy` in `types.ts`.

`logLevel: "debug"` logs headers and bodies — credential headers are redacted but **bodies are not**. In browsers the client refuses to run unless you pass `dangerouslyAllowBrowser`, which exposes your key to page users; keep the key server-side.

## Third-party front doors

Each reseller reshapes the API, sometimes renaming the primitives. Do not assume the TypeSafe wire format carries over.

### Vercel AI Gateway + AI SDK

Model ID `typesafe-ai/jev`, called through AI SDK 7's experimental `evaluate` API (needs `ai` ≥ 7.0.105) ([Vercel changelog](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway), [AI SDK Evaluation docs](https://ai-sdk.dev/docs/ai-sdk-core/evaluation)):

```ts
import { experimental_evaluate as evaluate } from 'ai';

const result = await evaluate({
  model: 'typesafe-ai/jev',
  state: 'The support agent issued a full refund to the customer.',
  questions: {
    refunded: { type: 'boolean', instructions: 'Was a refund issued?' },
  },
  providerOptions: { gateway: { zeroDataRetention: true } },
});
```

Differences that will bite you:

- The question type is **`boolean`, not `noul`**, and its answer field is **`probability`**, not `noul`.
- Choice/Score `probabilities` are **optional** in this abstraction — check before reading them.
- TypeSafe's confidence statistic moves to `result.providerMetadata?.typesafe?.confidence`, keyed by question ID.
- OpenAI/Anthropic/Google also expose `evaluationModel` factories, but those adapt structured LLM output: all questions share one prompt, so you lose Jev's independent-question semantics, and their boolean probabilities are prompted estimates with no calibration guarantee.
- Zero Data Retention and No Training are per-request Gateway options.

### Cloudflare Workers AI

Model `typesafe/jev` via `env.AI.run(...)`, using TypeSafe's native `noul`/`choice`/`score` vocabulary unchanged inside an `input` wrapper. Cloudflare documents the context window as **32,000 tokens** — lower than the 64k TypeSafe states for direct API use ([Cloudflare AI docs](https://developers.cloudflare.com/ai/models/typesafe/jev/)).

### Pydantic AI

`TypeSafeModel`, installed with `pip install "pydantic-ai-slim[typesafe]"`, used as `Agent('typesafe:jev-latest', output_type=...)`. Each field of the `output_type` becomes one question; field descriptions supply the instructions ([Pydantic AI docs](https://pydantic.dev/docs/ai/models/typesafe/)).

```python
from pydantic import BaseModel, Field
from pydantic_ai import Agent
from pydantic_ai.models.typesafe import TypeSafeModelSettings

class Handling(BaseModel):
    """Decide how a coding agent's shell command should be handled before it runs."""
    safe_to_run: bool = Field(description='Is this command safe to run without a human looking at it?')

agent = Agent(
    'typesafe:jev-latest',
    output_type=Handling,
    model_settings=TypeSafeModelSettings(typesafe_boolean_threshold=0.9),
)
print(agent.run_sync('pytest tests/test_agent.py').output)
```

`typesafe_boolean_threshold` (default 0.5) decides where P(yes) rounds to a `bool` — raise it where a false positive is expensive, lower it where a false negative is. `typesafe_tool_call_threshold` (default 0.6) gates function-tool selection. Confidence surfaces in `result.response.provider_details['confidence']`, and `FallbackModel` can escalate to an LLM when confidence is low.

### Agent skill

TypeSafe publishes a skill that teaches a coding agent the API and patterns:

```bash
npx skills add typesafe-ai/skills --skill typesafe-ai   # or the Claude Code plugin
```

Source: [Agent skill](https://docs.typesafe.ai/agent-skill.md); the skill itself is [`skills/typesafe-ai/SKILL.md`](https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md). Its standing instruction is that the live docs are the source of truth and that `docs.typesafe.ai/llms.txt` is the index to read first.

### Comparing against an LLM

[`typesafe-ai/system-one-adapter-python`](https://github.com/typesafe-ai/system-one-adapter-python) is a drop-in replacement for `typesafe_sdk`'s `system_one` backed by OpenAI or Anthropic instead, for cost/speed/quality comparisons. It is also what TypeSafe used to run LLMs through its own workflow evals.

## Confidence and thresholds

`confidence` (Choice and Score only) is a statistic derived from `probabilities` — concentrated distribution means high, flat means low. TypeSafe returns it for convenience but gives you the full distribution precisely so you can compute your own measure ([Confidence](https://docs.typesafe.ai/confidence.md)).

The recommended architecture is three bands, with **the boundaries set per action, not per system**: act automatically on high confidence, confirm or flag on medium, route to a human on low. A destructive operation deserves a higher bar than a read-only one. Calibrate every bar against labeled examples of your own traffic, and re-check after pinning a new model version ([Confidence](https://docs.typesafe.ai/confidence.md)).

The [LLM guardrails cookbook](https://docs.typesafe.ai/cookbooks/llm_guardrails.md) is the closest worked example of a policy layer: a battery of hazard Nouls plus one severity Score in a single request, then a pure-code `route()` that compares each hazard against a review threshold and an action threshold, lets severity upgrade a review into a block, and resolves collisions by precedence. Named policies (`strict` vs `permissive`) are just different numbers over the same assessment — which is the point: you can re-decide without re-inferring.

## Failure modes to design around (`jev-1.13`)

From TypeSafe's own [jaggedness page](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md), last reviewed 2026-09-17:

1. **Literal reading** — it answers the question you wrote, not the one you meant. Scoping words and negations are read at face value. If you find yourself explaining what you really meant, that explanation is the missing half of the instruction.
2. **Math and counting** — not a calculator; does not count reliably, and error grows with size. Iterate in code and ask one question per item instead.
3. **Dates** — read as text, not ordered quantities. Extract components as Choices over closed sets (with an explicit "not stated" option), then compare in code.
4. **Indirection** — double negatives and property-of-a-property questions cost accuracy. Name the relevant state directly.
5. **Large irrelevant state** — Jev suffers context rot; filter in code first, or use a Noul as a relevance gate.
6. **Adversarial content** — state is treated as data, not as hostile. Injected instructions and self-serving framing can move the answer. Be explicit in criteria and test edge cases.
7. **Contradictory instructions vs criteria** — a Noul whose `true` means "no" performs worse. Treat criteria as an extension of the instruction.
8. **No structural invariants** — the same question asked as a Noul and as a yes/no Choice can disagree sharply (documented example: `noul` 0.22 vs Choice `yes` 0.01), and a question plus its negation need not sum to 1 (documented: 0.72 + 0.47). Never carry a Noul-tuned threshold over to a Choice, and do not expect arithmetic identities between separate questions.
9. **No generation** — for extraction, find candidates with regex or an LLM and let Jev *select* the right one.

Also on their explicit avoid list: asking for something code can compute exactly, hiding several judgments in one question, and multi-hop "System Two" tasks.

## Design guidance worth following

- **One narrow judgment per question.** If a judgment needs extended reasoning or weighs independent factors, decompose it and combine the parts in code with weights you own — then a shifting priority is a coefficient change, not a prompt rewrite ([Introduction](https://docs.typesafe.ai/introduction.md), [Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring.md)).
- **Fan out speculatively.** Independent questions over the same state run in parallel and cost tokens but almost no extra time, so ask what you *might* need and let code consume the applicable answers ([Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out.md)).
- **Separate content from judgment.** Facts, records, and policy go in `state`; what to decide goes in `instructions`/`criteria` ([State](https://docs.typesafe.ai/concepts/state.md)).
- **A second request is only warranted** when an earlier answer determines what evidence to fetch or what options exist ([SKILL.md](https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md)).
- Typed output guarantees the *interface*, not the truth. Calibrated does not mean correct — validate in your domain.

## API history

`POST /preview/evaluation` is superseded by `POST /v1/systemone`; this was a breaking change to endpoint, request, and response. Renames: `document`→`state`, `prompts` array→`questions` map, `options`/`levels`→unified `criteria`, `responses`→`answers`, `probability`→`noul`, `chosen`→`choice`, `expectation`→`score`; Choice `probabilities` became a map, Score gained probabilities, confidence was recomputed, and the Python package changed from `typesafe-client` to `typesafe-sdk`. Auth is unchanged. Full deltas: [Migrating to the v1 API](https://docs.typesafe.ai/migrating-to-v1.md). Anything you find written against `preview/evaluation` is stale.

## Relevance to this repo

`pi-jev-guard` looks aimed at gating pi tool calls with Jev. The two most directly transferable pieces are the [LLM guardrails cookbook](https://docs.typesafe.ai/cookbooks/llm_guardrails.md) (hazard Noul battery + severity Score in one request, thresholds and precedence resolved in code) and Pydantic AI's shell-command example, which happens to model exactly that decision (`verdict: run | reject | ask`, `irreversible: bool`). Two cautions from the jaggedness page apply with force here: a tool call's arguments are **adversarial content** that Jev does not treat as hostile by default, and a guard's thresholds are asymmetric by nature — so pin `jev-1.13.0` rather than `jev-latest` before tuning any of them.
