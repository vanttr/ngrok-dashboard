# OpenCode Go Workspace Switchboard — Specification

**Status:** Specified
**Date:** 2026-06-23
**ADR:** docs/adr/0007-workspace-switchboard-config-swap.md

## Problem

The dashboard only monitors one OpenCode Go workspace subscription. The user has two ("default" and "coding") and needs to:
1. **Monitor** usage for both workspaces (Go limits + Zen balance)
2. **Switch** which workspace the OpenCode CLI uses for inference by activating its API key

## Solution Overview

Two independent systems on the dashboard:

- **Monitoring (always-on):** Per-workspace provider cards — Go usage and Zen balance for each workspace. Scraped via Firefox cookies.
- **Activation (on-demand):** An "Activate" button on each Go card writes the workspace's API key into the OpenCode CLI config (`opencode.json`). The CLI picks it up on next invocation.

No proxy. No runtime dependency between dashboard and CLI.

## Architecture

```
usage.json                         providers (dynamic)              dashboard cards
───────────                        ────────────────────             ───────────────
workspaces: {                      opencode_go_default              Go (Default)  [ACTIVE]
  default: {id, label, apiKey}     opencode_go_coding               Go (Coding)   [ACTIVATE]
  coding:  {id, label, apiKey}     opencode_zen_default             Zen (Default)
}                                  opencode_zen_coding              Zen (Coding)
activeWorkspace: "default"
                                          │
                                    [ACTIVATE] click
                                          │
                                    POST /api/opencode/activate
                                          │
                                    writes apiKey to:
                                    ~/.config/opencode/opencode.json
                                    provider.opencode-go.options.apiKey
```

## Requirements

### R1: Workspace Configuration

Workspace definitions live in `usage.json` under `opencodeGoWorkspaces`. Each entry has:
- `id` — workspace ID for Firefox-cookie scraping
- `label` — display name on dashboard cards
- `apiKey` — API key written to `opencode.json` on activation

The `opencodeGoActiveWorkspace` field tracks which workspace is currently active.

**Backward compatibility:** If `opencodeGoWorkspaces` is absent, the dashboard behaves as before — single `opencode_go` and `opencode_zen` providers using the hardcoded default workspace ID.

### R2: Per-Workspace Provider Cards

The provider registry dynamically generates one Go provider and one Zen provider per configured workspace. Display names include the workspace label (e.g., "Go (Default)", "Zen (Coding)").

The existing `opencode_go` and `opencode_zen` providers are replaced by their per-workspace counterparts when workspace config is present.

Each Go card shows: 5h limit, weekly limit, monthly limit (progress bars + countdowns).
Each Zen card shows: balance in USD.

### R3: Workspace Activation

`POST /api/opencode/workspaces/activate` with body `{ workspace: "<key>" }`:
1. Validates the workspace key exists in config
2. Reads `~/.config/opencode/opencode.json`
3. Updates `provider.opencode-go.options.apiKey` to the new workspace's key
4. Writes `opencode.json` back to disk
5. Updates `opencodeGoActiveWorkspace` in `usage.json`
6. Writes `usage.json` back to disk
7. Returns `{ ok: true, activeWorkspace: "<key>" }`

Error cases:
- Invalid workspace key → `400 { ok: false, error: "Unknown workspace" }`
- `opencode.json` not found → `500 { ok: false, error: "Cannot read opencode config" }`

### R4: Dashboard UI

Each Go card has a status indicator:
- **Active workspace:** Shows "ACTIVE" badge (styled, non-clickable)
- **Inactive workspace:** Shows "ACTIVATE" button (clickable)

Clicking "ACTIVATE" calls the activation endpoint, then refreshes the provider cards to update badge states.

Zen cards have no activation button — they are display-only.

### R5: Scraper Parameterization

`scrapeGoUsage(workspaceId)` and `scrapeZenBalance(workspaceId)` accept an optional workspace ID. Falls back to `DEFAULT_WORKSPACE_ID` if not provided. The existing `getContext()` Firefox context cache (1-hour reuse) is unchanged.

## Non-Requirements

- No proxy/forwarding of API requests
- No auto-failover between workspaces
- No UI for adding/removing workspaces (configuration in `usage.json` only)
- No scraping of per-workspace model catalogs

## Success Criteria

- [ ] Both workspace Go cards show usage data (scraped via Firefox cookies)
- [ ] Both workspace Zen cards show balance data
- [ ] "Activate" button on Default card shows as active (if default is `activeWorkspace`)
- [ ] Clicking "Activate" on Coding card writes coding API key to `opencode.json`
- [ ] `opencodeGoActiveWorkspace` updates in `usage.json` after activation
- [ ] CLI can use the newly activated key for model inference
- [ ] Server starts without errors with workspace config present
- [ ] Server starts without errors with no workspace config (backward compat)
- [ ] Existing providers (Claude Code, Codex, OpenRouter, DeepSeek) unaffected

## Testing Strategy

### What we're testing

| Component | Test type | Scenario |
|-----------|-----------|----------|
| `registry.js` | Unit | Generates N Go + N Zen providers from workspace config |
| `registry.js` | Unit | Falls back to single Go + single Zen when no config |
| `opencode-scraper.js` | Unit-ish | `scrapeGoUsage(id)` uses provided ID, `scrapeGoUsage()` uses default |
| API endpoint | Integration | `POST /activate` with valid workspace → 200, `opencode.json` updated |
| API endpoint | Integration | `POST /activate` with invalid workspace → 400 |
| API endpoint | Integration | `POST /activate` when `opencode.json` missing → 500 |
| Frontend | E2E | Both workspace cards render with activate buttons |
| Frontend | E2E | Active workspace shows "ACTIVE", inactive shows "ACTIVATE" |
| Backward compat | Integration | Server starts and providers work without workspace config |

### What we're NOT testing

- Actual Firefox cookie scraping (requires Firefox running with valid session — tested manually)
- CLI inference with activated key (CLI behavior, not dashboard)
- Concurrent activation requests (single-user dashboard)
- Performance under load (not a multi-user system)
