# OpenCode Go Workspace Switchboard — Implementation Plan

**Status:** approved
**Spec:** docs/superpowers/specs/2026-06-23-opencode-workspace-switchboard.md
**ADR:** docs/adr/0007-workspace-switchboard-config-swap.md
**Prerequisites:** (none)

**Goal:** Add per-workspace Go/Zen monitoring cards and an "Activate" button that switches the CLI's API key.

**Scope:** Config, scraper, providers, registry, API endpoint, frontend button.
**Non-goals:** Proxy, auto-failover, workspace CRUD UI.

**Produces:** Modified usage.json, opencode-scraper.js, opencode-go.js, opencode-zen.js, registry.js, server.js, index.html

## Definition of Done

- [ ] usage.json has workspace definitions with IDs, labels, API keys
- [ ] scraper functions accept workspaceId parameter
- [ ] Per-workspace Go/Zen provider cards render on dashboard
- [ ] "Activate" button writes API key to opencode.json
- [ ] "Active" badge shows on current workspace card
- [ ] Backward compatible (no config = existing behavior)
- [ ] Existing providers unaffected

## Task 1: Update usage.json with workspace config

**Files:** `usage.json`
**Classification:** quick-fix (config only)

**Steps:**
- [ ] Add `opencodeGoWorkspaces` object with default + coding entries (id, label, apiKey)
- [ ] Add `opencodeGoActiveWorkspace: "default"`
- [ ] Verify JSON is valid

**Tests:** Manual — JSON parse check

---

## Task 2: Parameterize scraper with workspaceId

**Files:** `server/providers/opencode-scraper.js`
**Classification:** standard (logic change + bug fix)

**Note:** `DEFAULT_WORKSPACE_ID`, `goUrl()`, and `zenUrl()` helpers already exist in the file. The actual work is:

**Steps:**
- [ ] Fix latent bug: `GO_URL` on line 90 and `ZEN_URL` on line 122 are undefined — replace with `goUrl()` and `zenUrl()` calls respectively
- [ ] `scrapeGoUsage(workspaceId)` — add optional `workspaceId` param, defaults to `DEFAULT_WORKSPACE_ID`, passes to `goUrl(workspaceId)`
- [ ] `scrapeZenBalance(workspaceId)` — same pattern, passes to `zenUrl(workspaceId)`
- [ ] Verify: grep confirms no remaining `GO_URL` or `ZEN_URL` references in file

**Tests:** Node.js inline test — call scraper with explicit ID, verify page.goto receives correct URL

---

## Task 3: Make Go and Zen providers workspace-aware

**Files:** `server/providers/opencode-go.js`, `server/providers/opencode-zen.js`
**Classification:** standard

**Steps:**
- [ ] `opencode-go.js`: Currently takes zero parameters. Change to `fetchOpenCodeGoProviderData({ settings } = {})`. Reads `settings.workspaceId`, passes to `scrapeGoUsage(workspaceId)`. Falls back to `scrapeGoUsage()` (uses `DEFAULT_WORKSPACE_ID`) if `workspaceId` missing.
- [ ] `opencode-zen.js`: Already accepts `{ settings }`. Read `settings.workspaceId`, pass to `scrapeZenBalance(workspaceId)`. Remove `zenBalanceUsd` config override (each workspace has real scraped balance).
- [ ] Both functions accept `{ settings }` param after changes.

**Tests:** Unit test with stubbed scraper — verify workspaceId threading

---

## Task 4: Dynamic provider registration per workspace

**Files:** `server/providers/registry.js`
**Classification:** standard (architectural change)

**Steps:**
- [ ] `createProviderRegistry(overrides, workspaces)` — new `workspaces` param (object from usage.json)
- [ ] If workspaces provided: for each workspace, register `opencode_go_{key}` and `opencode_zen_{key}` providers
- [ ] Display name: `"Go ({label})"` / `"Zen ({label})"`
- [ ] Each provider's `fetchProviderData` wraps the base Go/Zen fetcher with `settings.workspaceId` set
- [ ] If no workspaces: fall back to single `opencode_go` + `opencode_zen` (existing behavior)
- [ ] Remove the old generic `opencode_go` and `opencode_zen` entries when workspaces are present

**Tests:** Unit test — verify provider list count and display names for N workspaces

---

## Task 5: Add /api/opencode/workspaces endpoints

**Files:** `server.js`
**Classification:** standard (API + file I/O)

**Steps:**
- [ ] In `initProviderTracking()`: read workspace config from `USAGE_CONFIG`, resolve active workspace, add `settings.opencodeGoWorkspaces`, `settings.opencodeGoActiveWorkspace`, `settings.opencodeGoActiveLabel`
- [ ] Pass `workspaces` config to `createProviderRegistry()`
- [ ] Add `GET /api/opencode/workspaces` (auth-gated):
  - Returns `{ workspaces: [...], activeWorkspace: "<key>" }` from in-memory settings
- [ ] Add `POST /api/opencode/workspaces/activate` (auth-gated):
  - Parse JSON body, validate `workspace` key exists in config AND has a non-empty `apiKey` field
  - Read `~/.config/opencode/opencode.json`; handle parse errors (500)
  - Validate `provider.opencode-go.options.apiKey` path exists (500 if missing)
  - Update `apiKey` to new workspace's key
  - Write `opencode.json` using temp-file-then-rename pattern (matches existing `patchAgentModels` helper at ~server.js:2328)
  - Update `USAGE_CONFIG.opencodeGoActiveWorkspace`
  - Write `usage.json` using temp-file-then-rename
  - Update in-memory `settings.opencodeGoActiveWorkspace` + `settings.opencodeGoActiveLabel`
  - Return `{ ok: true, activeWorkspace: "<key>" }`

**Error cases:**
- Missing body / not JSON → 400 `{ ok: false, error: "Invalid request body" }`
- Unknown workspace → 400 `{ ok: false, error: "Unknown workspace: <key>" }`
- Workspace has no apiKey → 400 `{ ok: false, error: "Workspace has no API key" }`
- opencode.json not found → 500 `{ ok: false, error: "Cannot read opencode config" }`
- opencode.json parse error → 500 `{ ok: false, error: "Cannot parse opencode config" }`
- opencode.json missing provider path → 500 `{ ok: false, error: "Cannot find provider config in opencode.json" }`

**Tests:** Integration — curl POST with valid/invalid/missing-key workspace, verify file changes on disk

---

## Task 6: Add "Activate" button to Go cards in dashboard

**Files:** `index.html`
**Classification:** standard (frontend)

**Steps:**
- [ ] Add CSS for `.activate-btn` and `.activate-btn--active` (glassmorphism style, matches existing pill/button design)
- [ ] On page load: `fetch('/api/opencode/workspaces')` or derive active workspace from provider card data
- [ ] In `renderProviders()`: for Go cards (`providerId` starts with `opencode_go_`):
  - Parse workspace key from providerId
  - If active → render `<span class="activate-btn--active">ACTIVE</span>`
  - If inactive → render `<button class="activate-btn">ACTIVATE</button>`
- [ ] `onclick` handler for activate button:
  - `POST /api/opencode/workspaces/activate { workspace: "<key>" }`
  - On success → `fetchProviders()` to refresh card badges
  - On error → flash error state on button
- [ ] Active workspace tracking: fetch `GET /api/opencode/workspaces` (from Task 5) to determine which card shows "ACTIVE" badge

**Tests:** E2E — browser verification of button states and activation flow

---

## Dependency Graph

```
Task 1 (config)
  └─→ Task 2 (scraper) ──→ Task 3 (providers) ──→ Task 4 (registry)
                                                         │
                                                    Task 5 (API endpoint)
                                                         │
                                                    Task 6 (frontend)
```

Tasks 1-4 are sequential. Task 5 depends on Task 4. Task 6 depends on Task 5 (needs the activate endpoint).

## Risk Register

| Risk | Why | Mitigation | Verification |
|------|-----|------------|-------------|
| opencode.json write corrupts CLI config | Dashboard could break CLI | Write using temp-file-then-rename pattern (existing `patchAgentModels` helper at server.js:2328). Validate JSON before overwriting. | Manual: verify CLI still works after activation |
| Firefox cookies may not auth to both workspaces | Scraper uses single Firefox profile; different workspaces may require different auth | Verify in Firefox that both workspace pages load without re-auth. If not, scraper returns null gracefully (no crash). | Manual: verify Go/Zen cards show data for both workspaces |
| Existing hardcoded WORKSPACE_ID lingers | Could scrape wrong workspace silently | grep audit in Task 2 | Automated: grep for WORKSPACE_ID in scraper file |

## Evidence Required Before Completion

- [ ] Server starts with `node server.js` — no errors
- [ ] Both Go cards render (default + coding)
- [ ] Both Zen cards render (default + coding)
- [ ] Activate button works: click coding → opencode.json key changes
- [ ] Active badge shows correctly after activation
- [ ] Backward compat: remove workspace config, server still works
- [ ] Existing providers (Claude Code, Codex, OpenRouter, DeepSeek) unaffected

---

## Plan Review Status

| Review | Domain | Verdict | Key Findings |
|--------|--------|---------|-------------|
| Coverage | WHAT does plan cover? | [WARN] | Malformed config handling missing, apiKey validation needed, fallback wording ambiguous |
| Construction | CAN plan be built? | [WARN] | Task 2 steps describe existing helpers poorly, GET endpoint misplaced in Task 6, risk register mitigation incorrect |
| Synthesis | Conflict resolution | N/A | No conflicts — reviewers found complementary issues. All addressed in plan update. |
