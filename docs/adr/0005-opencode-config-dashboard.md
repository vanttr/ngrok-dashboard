# ADR 0005: OpenCode Config Dashboard — Dynamic Model Discovery & Config Patching

**Date:** 2026-06-20
**Status:** Accepted

## Context

The ngrok-dashboard needs a subpage to manage subagent provider/model assignments
in the user's opencode config (`~/.config/opencode/opencode.json`). This requires:
1. Dynamic discovery of available AI models and providers
2. Reading and writing the opencode config file
3. A UI that lists subagents, lets users browse models, and persists favorites

## Options Considered

### Option A: Spawn `opencode serve` + proxy HTTP API

Codenomad's approach: spawn a long-running `opencode serve` process, query its
internal HTTP API (`/api/model`, `/api/provider`) with Basic Auth, proxy results.

**Pros:** Same method as codenomad (consistency), structured JSON responses.

**Cons:** Must manage subprocess lifecycle (startup, port discovery, cleanup),
slower (~2-3s round-trip), port conflicts possible, zombie process risk.
Unnecessary complexity for a read-only model listing.

### Option B: Read opencode config files directly

Parse `opencode.json` and `auth.json` to enumerate configured providers and
their registered models.

**Pros:** No subprocess, instant, trivial implementation.

**Cons:** Misses runtime-discovered models (plugin-loaded providers, models.dev
catalog). Stale — only shows what was manually configured. Doesn't show model
capabilities, costs, or limits.

### Option C: `opencode models --verbose` CLI command (CHOSEN)

Spawn `opencode models --verbose 2>$null` on demand. Output is NDJSON
(alternating model ID line + JSON metadata block). Providers derived from
model metadata.

**Pros:** Simple invocation (~500ms), full model metadata (capabilities, cost,
limits), no lifecycle management, no port conflicts, CLI already installed.
Clean stdout parsing with log noise on stderr.

**Cons:** One gap — `opencode providers list` has no JSON output flag. Workaround:
derive provider list from model metadata, enrich with opencode.json provider
config for display names/baseURLs.

## Decision

**CLI approach (Option C).** Model discovery via `opencode models --verbose`.
Providers derived from model metadata's `providerID` field. Provider display
names and base URLs enriched from the user's `opencode.json` provider config.

## Sub-decisions

### Favorites: Global vs per-subagent

**Chosen: Global.** A single favorites list of `provider/model` combos.
Simpler mental model, less UI complexity. Users typically have 3-5 favorite
models they reuse across subagents.

### Config writing: Patch vs rewrite

**Chosen: Patch.** On save, read the current `opencode.json`, modify only
`agent.<name>.model` for subagent entries, write back. All other config
(non-agent keys, agent descriptions, prompts, modes) preserved untouched.
Other fields the user may have added manually are not lost.

### Testing: Integrated vs isolated

**Chosen: Isolated first, then integrate.** Backend routes and subpage HTML
tested independently (with `NO_NGROK=1`) before adding the dashboard card to
index.html. Enables parallel testing without disrupting the running dashboard.

### UI: Subpage vs inline

**Chosen: Subpage.** OpenCode config gets its own HTML page (`opencode-config.html`)
rather than being crammed into `index.html`. Matches the `login.html` precedent,
keeps concerns separate, and avoids bloating the dashboard JS.

## Consequences

- **Positive:** Model list always current (CLI reads live config). Full metadata
  available for display. No subprocess lifecycle management. Config writes are
  surgical (only `agent.<name>.model` touched).
- **Negative:** ~500ms latency on page load (CLI startup). User must manually
  restart opencode after saving. No real-time model validation (if a model is
  removed from a provider after saving, opencode will fail to start until the
  config is fixed).
- **Risk:** If opencode CLI is not installed or not on PATH, model discovery
  fails gracefully with an error message. Config read/write still works.
