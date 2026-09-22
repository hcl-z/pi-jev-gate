# Reference Index

External reference material kept in this repo. Read the relevant entry here before searching the web or fetching upstream docs again.

## Jev / TypeSafe AI

| File | Covers | Sources | Researched |
| --- | --- | --- | --- |
| [`jev-typesafe-ai.md`](jev-typesafe-ai.md) | How to use Jev: the three primitives (`noul`/`choice`/`score`) and their criteria and answer shapes, the `POST /v1/systemone` wire format, `jev-1.13.0` limits and pricing, alias-pinning, Python `typesafe-sdk` and JS `@typesafe-ai/sdk` usage plus env vars/timeouts/retries, the Vercel AI Gateway + AI SDK `experimental_evaluate` path (which renames `noul` to `boolean`), Cloudflare Workers AI, Pydantic AI `TypeSafeModel` thresholds, confidence banding, the documented `jev-1.13` failure modes, and the preview→v1 breaking changes | [docs.typesafe.ai](https://docs.typesafe.ai/llms.txt) (Introduction, API, Models, Primitives, Confidence, jaggedness, SDKs, migration), [launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [Vercel changelog](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway), [AI SDK Evaluation](https://ai-sdk.dev/docs/ai-sdk-core/evaluation), [Cloudflare](https://developers.cloudflare.com/ai/models/typesafe/jev/), [Pydantic AI](https://pydantic.dev/docs/ai/models/typesafe/) | 2026-09-22 |

Notes:

- `docs.typesafe.ai` serves Markdown for any page by appending `.md` to its path, and `llms.txt` is the full page index. Prefer that over scraping rendered HTML.
- Version-specific facts (limits, thresholds, failure modes) are pinned to `jev-1.13.0`. The `jev-latest` alias moves on release, so re-verify before trusting tuned numbers.
- Anything written against `POST /preview/evaluation` is stale; the v1 rename changed nearly every field name.

## pi extension development

| File | Covers | Source | Fetched |
| --- | --- | --- | --- |
| [`pi-extensions.md`](pi-extensions.md) | Full pi extension API: `ExtensionAPI`, extension locations and discovery, the complete lifecycle event list (`project_trust`, `session_*`, `before_agent_start`, `turn_start`/`turn_end`, `tool_call`/`tool_result`, `context`, `agent_before_settle`), `ExtensionContext`/`ExtensionCommandContext`, custom tools, custom TUI via `ctx.ui.custom()`, commands/shortcuts/flags, state management, error handling, mode behavior, examples table | [earendil-works/pi @ main](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) (`packages/coding-agent/docs/extensions.md`) | 2026-09-22 |

Notes on `pi-extensions.md`:

- It is the `main`-branch version, which is **ahead of the locally installed pi 0.85.1**. `main` documents `context_with_system`, `agent_before_settle`, actionable `turn_end` (returning `entries`/`continue`), `forceSystemPrompt`, and section-diffed system-prompt patching; the installed copy does not. When a documented API is missing at runtime, check the installed doc set before assuming a bug.
- The locally installed doc set (same topic plus `tui.md`, `skills.md`, `packages.md`, `sdk.md`, `themes.md`, `rpc.md`, and others) lives at
  `/Users/clhong/.vite-plus/js_runtime/node/24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/`,
  with runnable extensions under `../examples/extensions/`. Relative links inside `pi-extensions.md` (e.g. `../examples/extensions/`, `packages.md`) resolve against that directory, not this repo.
- Refresh with:
  ```bash
  curl -fsSL -o docs/reference/pi-extensions.md \
    https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md
  ```
