# Usage Limit Cards — Design Spec

**Date:** 2026-06-22
**Status:** Approved
**Source:** Port usage limit card feature from llm-dashboard into ngrok-dashboard

## Problem

The ngrok-dashboard currently has no visibility into LLM provider usage/limits. Developers using Claude Code, Codex, OpenRouter, DeepSeek, and OpenCode Go have no at-a-glance way to see how much of their rate limit they've consumed. The llm-dashboard already solves this with provider cards and limit bars — we want that same capability in the ngrok-dashboard.

## Solution Summary

Port the full provider usage tracking backend (provider services, SQLite cache, refresh jobs, API endpoints) and frontend (compact provider cards with limit bars) from the llm-dashboard into the ngrok-dashboard, adapted to vanilla HTML/CSS/JS architecture. Cards render in a responsive grid row at the top of the dashboard, visually distinguished from server cards with a subtle blue-green tint.

## Success Criteria

1. Five provider cards (Claude Code, Codex, OpenRouter, DeepSeek, OpenCode Go) render in a responsive grid above the server grid
2. Each card shows provider name, status pill, 5-hour limit bar, and 7-day/weekly limit bar — compacted vs the llm-dashboard version
3. Cards have a distinct color tint differentiating them from server cards
4. Cards update every 60s without DOM flicker (cardMap diffing pattern)
5. Backend fetches real provider data where credentials are available; graceful fallback where not
6. On narrow screens, cards stack vertically (no squish/cutoff)
7. Danger tint (red) activates when usage exceeds 80%
8. No new npm dependencies beyond what ngrok-dashboard already has

## Architecture

### Backend (`server.js` + new module files)

New modules under `server/`:
```
server/
  providers/
    claude-code.js       — reads .claude/.credentials.json, hits Anthropic OAuth usage API
    codex.js             — spawns codex app-server, JSON-RPC rate limit read
    openrouter.js        — hits OpenRouter key/credits API
    deepseek.js          — hits DeepSeek balance API
    opencode-go.js       — attempts OpenCode Go API; falls back to static limits
    exchange-rates.js    — fetches USD→AUD rate (cached in provider_cache)
    provider-result.js   — normalizeWindow(), createProviderResult() factory
    registry.js          — provider list (5 visible + 1 internal for exchange_rates)
  jobs/
    refresh-providers.js — refresh service: fetchAll, listProviderRows, getProviderStatus
```

SQLite schema extension (added to existing DB):
```sql
CREATE TABLE IF NOT EXISTS provider_cache (
  provider_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
```

New API endpoints (added to `server.js` HTTP router):
- `GET /api/providers` — returns array of 5 provider rows with limit data
- `POST /api/providers/refresh` — triggers refresh-all, returns updated rows

Config file: `usage.json`
```json
{
  "pollIntervalMinutes": 5,
  "openrouterApiKey": "",
  "deepseekApiKey": "",
  "opencodeGoApiKey": ""
}
```

Refresh interval: `setInterval` (not node-cron), matching existing project patterns.

### Frontend (`index.html`)

New HTML section:
```html
<section id="provider-grid" class="provider-grid"></section>
```
Placed between hero-card and the `#opencode-card` config card.

Vanilla JS rendering (`renderProviders()` function):
- Fetches `GET /api/providers` every 60s
- Builds cards with `document.createElement` + `innerHTML` templates
- Flicker-free updates via `providerCardMap` + state diffing (mirrors `renderServers()` pattern)
- Each card renders: header (provider name + status pill), 5h limit row, weekly limit row

## Card Design

| Element | llm-dashboard (original) | ngrok-dashboard (compact) |
|---------|--------------------------|---------------------------|
| Card min-width | ~17rem | ~13rem |
| Card padding | 1.25rem | 0.9rem |
| Limit row padding | 0.8rem 0.9rem | 0.55rem 0.65rem |
| Limit bar height | 0.72rem | 0.5rem |
| Font: labels | 0.95rem | 0.84rem (--text-xs) |
| Font: subtext | 0.95rem | 0.84rem |
| Row gap | 1rem | 0.65rem |
| Card body content | 2× bars + balance + refreshed + footer | 2× bars only |
| Status pill height | 2rem | 1.6rem |
| Per-provider tint | Individual warm/cool gradients | Uniform blue-teal tint on all cards |

**Card HTML structure (per provider):**
```
<div class="provider-card">
  <div class="provider-card__header">
    <span class="provider-name">Claude Code</span>
    <span class="status-pill status-pill--fresh">fresh</span>
  </div>
  <div class="provider-card__body">
    <div class="limit-row">
      <div class="limit-row__header">
        <span>5h limit</span>
        <span>42% used • resets in 2h 15m</span>
      </div>
      <div class="limit-row__subtext">Reset at 6/22/2026, 2:00:00 PM</div>
      <div class="limit-bar">
        <div class="limit-bar__fill" style="width:42%"></div>
      </div>
    </div>
    <div class="limit-row">
      <div class="limit-row__header">
        <span>Weekly</span>
        <span>18% used • resets in 4d 8h</span>
      </div>
      <div class="limit-row__subtext">Reset at 6/26/2026, 12:00:00 AM</div>
      <div class="limit-bar">
        <div class="limit-bar__fill" style="width:18%"></div>
      </div>
    </div>
  </div>
</div>
```

**Color tint:** Uniform cool blue-teal tint across all 5 cards:
- `background: linear-gradient(180deg, rgba(240,248,252,0.92), rgba(235,244,248,0.75))`
- Same `backdrop-filter` blur pattern as server cards, just tint-shifted
- Danger override (>80%): background shifts to `rgba(168,71,71,0.04)` red tint

**Responsive grid:**
```css
.provider-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  gap: 0.9rem;
  margin-bottom: 1.5rem;
}
```
Cards stack vertically on screens < ~700px.

## Provider Details

### Claude Code
- **Data source:** `~/.claude/.credentials.json` → OAuth access token → `api.anthropic.com/api/oauth/usage`
- **Windows path:** `%USERPROFILE%\.claude\.credentials.json`
- **Window normalization:** utilization 0–1 → percent (×100)

### Codex
- **Data source:** Spawn `codex app-server` → JSON-RPC `account/rateLimits/read`
- **Timeout:** 10s
- **Rate limit shape:** `rateLimits.primary` (5h) + `rateLimits.secondary` (weekly)

### OpenRouter
- **Data source:** `api.openrouter.ai/api/v1/key` with API key → `data.limit_remaining`
- **Fallback:** `api.openrouter.ai/api/v1/credits` for total_credits − total_usage
- **Currency:** USD → AUD via exchange rate cache

### DeepSeek
- **Data source:** `api.deepseek.com/user/balance` with API key → `balance_infos[currency=USD].total_balance`
- **Currency:** USD → AUD via exchange rate cache

### OpenCode Go
- **Data source:** Attempt `opencode.ai/zen/go/v1/usage` with API key (if configured)
- **Fallback:** Static limits from docs — 5h=$12, weekly=$30, monthly=$60, shown as 0% used with status `stale`
- **Future:** Can be wired to real API when available

## Data Model

**API response shape (`GET /api/providers`):**
```json
[{
  "providerId": "claude_code",
  "displayName": "Claude Code",
  "status": "fresh",
  "fiveHour": {
    "usedPercent": 42,
    "resetsAt": "2026-06-22T14:00:00Z",
    "windowDurationMins": 300
  },
  "sevenDay": {
    "usedPercent": 18,
    "resetsAt": "2026-06-26T00:00:00Z",
    "windowDurationMins": 10080
  },
  "balanceUsd": null,
  "balanceAud": null,
  "error": null,
  "fetchedAt": 1750612345678
}]
```

**Status values:** `fresh` (< 6 min), `stale` (6–30 min), `error` (error or > 30 min), `never_fetched` (no cache row)

## Testing Strategy

### Unit Tests (`tests/provider-services.test.js`)
- `normalizeWindow` with null, valid, edge input
- Status logic: fresh/stale/error/never_fetched time gating
- `formatCountdown` with various reset times
- `formatPercentage` with null/0/50/100
- Provider registry returns correct 5 providers
- Cache repo upsert + get round-trip
- `buildProviderApiRow` assembles correct shape

### Integration Tests (Node.js + Playwright)
- `GET /api/providers` returns correct shape
- `POST /api/providers/refresh` triggers refresh
- Provider grid renders in DOM (`#provider-grid`)
- Cards update without flicker (cardMap diffing)
- Status pill CSS classes toggle correctly
- Danger tint on >80% usage
- Responsive grid stacks vertically at narrow width

### E2E Tests (Playwright)
- Full page loads with provider grid above server grid
- Cards visually distinct from server cards (tint)
- Limit bars animate on data change
- No console errors on load

### What We're NOT Testing
- Live provider API calls (mocked via dependency injection)
- Pixel-perfect visual regression (Playwright checks structure, not design QA)

PLAN GATE: Every test scenario in the Integration and E2E tables above must have a corresponding plan task. Plan tasks reference specific test scenarios.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `usage.json` missing | All providers show "not configured", no crash |
| Provider API key missing | Card shows status `error`, error message |
| Provider API request fails | Previous cached data preserved, error attached to row |
| Credentials file missing (Claude) | Error: "Claude credentials file is missing OAuth tokens." |
| CLI timeout (Codex, 10s) | Error: "Codex app-server timed out." |
| API returns 0% | Bar shows empty (not missing) |
| API returns 100% | Bar full, danger tint applied |
| Reset time in past | Countdown shows "now" |
| Window data null | "N/A" text, no bar rendered |
| Frontend fetch fails | Cards preserved at last known state |
| Double-click refresh | Single request (debounced) |

## Out of Scope
- Token pricing table (separate feature from llm-dashboard)
- Live usage view / chart (footer link removed — compact design)
- Balance display (AUD/USD removed — compact design)
- Settings UI page (keys configured via `usage.json` only)
- Team/workspace features
- Auto-reload or billing management
