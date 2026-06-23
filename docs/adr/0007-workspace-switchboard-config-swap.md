# ADR 0007: Config-Swap for Workspace Switching (Not Proxy)

**Status:** Accepted
**Date:** 2026-06-23

## Context

The ngrok-dashboard monitors OpenCode Go/Zen usage by scraping workspace pages via Firefox cookies. A user may have multiple OpenCode Go workspace subscriptions (e.g., "default" and "coding"), each with its own API key. The user needs a way to switch which workspace's API key the OpenCode CLI uses for model inference requests.

Two approaches were considered:
1. **Proxy approach** (switchboard-go style): Run a local proxy inside the dashboard. The CLI points its `baseURL` to `localhost`. The proxy forwards requests to `opencode.ai/zen/go/v1` using the active workspace's API key.
2. **Config-swap approach**: When the user activates a workspace, the dashboard writes that workspace's `apiKey` directly into `~/.config/opencode/opencode.json`. The CLI reads the config on each invocation.

## Decision

**Use the config-swap approach.**

The dashboard writes `provider.opencode-go.options.apiKey` in `opencode.json` whenever the user activates a workspace. No proxy route is added to the dashboard server.

## Alternatives Considered

### Proxy Approach

**What:** Dashboard hosts a `/v1/*` route that proxies requests to `opencode.ai/zen/go/v1` with the active workspace key.
**Why:** Instant switching, no CLI restart needed, enables auto-failover across keys.
**Why not:**
- Creates a hard runtime dependency — CLI breaks if dashboard is down
- Requires startup/shutdown hooks to swap `baseURL` in `opencode.json`
- Crash recovery is fragile (config left pointing to dead localhost)
- Overengineered for manual workspace switching (switchboard-go's proxy shines for auto-failover on key exhaustion, not manual switching)
- The dashboard's existing HTTP server serves HTML and JSON APIs — adding a streaming proxy route increases complexity and failure surface

### Config-Swap Approach (Chosen)

**What:** Dashboard writes the active workspace's API key to `opencode.json` on activation.
**Why:**
- Zero runtime dependency — CLI works independently whether dashboard is running or not
- Simple implementation: read JSON, change one field, write JSON
- Failure mode is safe: if dashboard crashes, CLI still uses last written key
- The opencode CLI reads `opencode.json` on each invocation — no restart needed
**Cost:** Switching requires a CLI invocation boundary (not instant), but this is acceptable for manual workspace switching.

## Consequences

- **Positive:** Dashboard and CLI remain loosely coupled. Each works independently.
- **Positive:** Implementation is minimal — one API endpoint that edits a JSON file.
- **Negative:** If the opencode CLI ever caches the config in-process, switching latency increases. Mitigated by the fact that CLI invocations are short-lived processes.
- **Negative:** The dashboard must have write access to `~/.config/opencode/opencode.json`, which means it must run under the same user account as the CLI.
