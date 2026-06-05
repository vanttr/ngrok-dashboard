# Diagnosis Session: Claude & Codex Scheduler Auth + Text Wrapping Fix

**Date:** 2026-06-05
**Session ID:** scheduler-claude-codex-auth-wrap
**Bug Severity:** high (scheduler stopped firing, Codex always failed, text unreadable)
**Files Changed:** 4 files
**Root Cause Layer:** 2-3 layers deep (auth mismatch + process spawn + CSS)

---

## 1. Bug Description

**Reported symptoms:**

1. **Claude Code scheduler prompts failing** — "Your credit balance is too low to access the Anthropic API." User is on a subscription plan, not API pay-as-you-go.
2. **Codex CLI scheduler prompts always failing** — "You exceeded your current quota." User insists quota is not exceeded.
3. **Response text not wrapping** — single-line overflow with ellipsis truncation, unreadable.
4. **Scheduler stopped firing after ~14 cycles** — dashboard showed last fire "6 hours ago" despite server still running.

**Impact assessment:**
The scheduler (health-check pings to Claude and Codex every 30 min) was effectively broken. Claude failed on auth, Codex failed on auth, and when Claude started working via CLI fallback the scheduler timer died after a few hours.

**Reproduction:**
1. Start server: `node server.js`
2. Observe scheduler logs — Claude: "credit balance too low", Codex: "quota exceeded"
3. Wait 14 fire cycles (~7 hours) — scheduler stops firing entirely
4. Open dashboard — response text is single-line truncated with ellipsis

---

## 2. Investigation Summary

### Issue A: Claude Auth — API Key vs Subscription

**Root cause:** The server reads `primaryApiKey` from `~/.claude/config.json` and sends it as `x-api-key` to `api.anthropic.com`. This API key has no prepaid credits — the user is on a Claude Pro subscription (browser-based), which is a separate billing system from the API.

**Auth systems are separate:**
| Auth Method | Uses | Billing |
|---|---|---|
| API key (`x-api-key`) | `api.anthropic.com/v1/messages` | Prepaid credits |
| OAuth token (`Authorization: Bearer`) | Same API endpoint | Subscription-billed |
| `claude` CLI | Subprocess | Browser OAuth from `claude login` |

**Fix:** Three-layer credential resolution:
1. Try `primaryApiKey` → API key auth
2. Try fallback keys (`oauthToken`, `accessToken`, `token`) → auto-detect Bearer vs API key
3. If API call fails → spawn `claude` CLI as subprocess (uses OAuth subscription)

### Issue B: Codex Auth — ChatGPT Session Token ≠ API Key

**Root cause:** The server reads `tokens.access_token` from `~/.codex/auth.json` and sends it as `Authorization: Bearer` to `api.openai.com/v1/chat/completions`. But this token is a **ChatGPT web-session JWT** (Google OAuth login), NOT an OpenAI API key. The ChatGPT Plus subscription does NOT include API credits.

**Token source:** `~/.codex/auth.json` — OAuth JWT from `codex login` (Google → ChatGPT)
**Target endpoint:** `api.openai.com` — requires API key with credits
**Result:** OpenAI returns 429 "You exceeded your current quota" because the ChatGPT session has no API billing.

**Fix:** Skip the OpenAI API entirely for Codex. Call `codex.js` directly via `node.exe` subprocess, which authenticates through the ChatGPT OAuth session.

### Issue C: Text Wrapping

**Root cause:** CSS class `.scheduler-target-snippet` had:
```css
white-space: nowrap;
overflow: hidden;
text-overflow: ellipsis;
```
Plus server-side `.slice(0, 80)` truncation and `max_tokens: 100`.

**Fix:**
- CSS: `white-space: pre-wrap; word-break: break-word;` with scrollable max-height
- Server: `max_tokens: 500`, removed `.slice(0, 80)` truncation

### Issue D: Scheduler Stopped After 14 Cycles

**Root cause:** `execFileSync` in `callClaudeCLI()` blocks the entire Node.js event loop. On Windows, the `claude` CLI spawns subprocesses, and `execFileSync` with timeout doesn't reliably kill grandchild processes. This starves the `setInterval` timer queue, causing the scheduler to silently stop.

**Fix:** Replaced `execFileSync` with async `spawn` (non-blocking). Added heartbeat logging every 30 min to prove the timer is alive.

### Issue E: Codex Spawn Timing Out (Secondary)

After fixing the auth path, Codex CLI calls still timed out. Investigation revealed:

1. **`execFile` with `shell: true`** for `.cmd` wrappers caused EINVAL on Windows
2. **Direct `node codex.js` call** worked from terminal (18s) but timed out from server spawn (>60s)
3. **Root cause:** `execFile` buffers all stdout. Codex with `--json` outputs massive JSONL. Buffer saturation or maxBuffer kill caused the hang.
4. **Fix:** Switched to `spawn` with `stdio: ['ignore', 'ignore', 'pipe']` — discard stdout entirely since output goes to `-o <file>`.

---

## 3. Blast Radius

**Call chain depths:**
- Claude: `server.js` → HTTPS API → `claude` CLI spawn (2-3 layers)
- Codex: `server.js` → `node codex.js` spawn (2 layers)

**Interfaces touched:**
| Interface | Consumers | Impact |
|---|---|---|
| `callClaude()` in server.js | Scheduler, HTTP API | Auth header type switching |
| `callClaudeCLI()` in server.js | Scheduler fallback | Spawn method change (sync→async) |
| `callCodexCLI()` in server.js | Scheduler primary | Complete rewrite (API→CLI, spawn method) |
| `.scheduler-target-snippet` CSS | Dashboard frontend | Text wrapping |
| `servers.json` config | Server startup | New `fallbackKeys` field |
| `/api/scheduler` GET | Dashboard frontend | Larger responsePreview (was 80→500 chars) |
| `/api/scheduler/fire` POST | Manual testing | New endpoint |

---

## 4. Root Cause Summary

| Issue | Root Cause | Layer |
|---|---|---|
| Claude auth fails | API key has no credits; subscription ≠ API billing | Auth system mismatch (layer 2) |
| Codex auth fails | ChatGPT web-session JWT sent to OpenAI API; no API billing | Auth system mismatch (layer 2) |
| Text not wrapping | CSS `nowrap` + `overflow:hidden` + server truncation | CSS + server (layer 1-2) |
| Scheduler stops | `execFileSync` blocks event loop, starves timer queue | Process spawn (layer 2) |
| Codex spawn timeout | `execFile` stdout buffering with large JSONL output | Process spawn (layer 3) |

---

## 5. Fix Applied

### server.js changes:

**Credential auto-detection** (`detectCredentialType`):
- `sk-ant-api...` → `api-key` → `x-api-key` header
- `sk-ant-oat...` → `bearer` → `Authorization: Bearer` header
- `eyJ...` (JWT) → `bearer`

**Credential fallback:** Tries `primaryApiKey`, then `oauthToken`, `accessToken`, `token` from config file.

**Claude CLI fallback:** `spawn(claudePath, ['-p', prompt, '--print', '--output-format', 'text'])` — async, non-blocking.

**Codex CLI primary:** `spawn(process.execPath, [codexScript, 'exec', prompt, '--json', '-o', tmpFile, '--ephemeral', ...])` — direct `node codex.js` call, stdout discarded.

**CLI path resolution** (`resolveCliPath`): Checks `~/.local/bin/` (for `.exe`) then `%APPDATA%/npm/` (for `.cmd`/`.ps1`). Shell auto-detection via `needsShell()`.

**Response size:** `max_tokens: 500`, no truncation, 30s timeout for API calls.

**Manual fire endpoint:** `POST /api/scheduler/fire` with `force: true` bypassing minute-offset guards.

### index.html changes:

```css
.scheduler-target-snippet {
  white-space: pre-wrap;      /* was: nowrap */
  word-break: break-word;     /* was: absent */
  max-height: 8em;            /* was: absent */
  overflow-y: auto;           /* was: hidden */
  /* removed: text-overflow: ellipsis */
}
```

### servers.json changes:

Claude target now has `fallbackKeys: ["oauthToken", "accessToken", "token"]`.

### tests/scheduler.test.js changes:

Updated extractResponseText test — expects full response (no 80-char truncation).

---

## 6. Fix Audit

**Root cause depth check:** Fix at correct layers — auth routing (API vs CLI), process spawn (sync→async, buffering→pipe), CSS wrapping.

**Affected interface coverage:**
- Claude: API → CLI fallback tested via manual fire, confirmed working
- Codex: CLI primary tested via manual fire, confirmed working
- Dashboard: text wrapping verified via Playwright screenshot + reviewer subagent
- Scheduler heartbeat: confirmed via console logging

**Regression suite:**
- 48 tests pass (16 scheduler + 32 header rewriting)
- `node -c server.js` clean
- Browser verification PASS (reviewer subagent reviewed screenshot)

**Caller contract impact:** `/api/scheduler` response now includes larger `responsePreview`. No schema changes otherwise.

---

## 7. Lessons Learned

1. **Subscription ≠ API credits.** Claude Pro and ChatGPT Plus are web-interface subscriptions that DON'T include API access. Always use the CLI subprocess for subscription-based accounts.

2. **`execFileSync` is dangerous in servers.** It blocks the event loop and can silently kill timers. Always use async `spawn` or `execFile` with callbacks.

3. **On Windows, `.cmd` wrappers need `shell: true` or bypass entirely.** For npm global CLI tools, calling the underlying `.js` file directly with `node` is more reliable than going through the `.cmd` wrapper.

4. **Don't capture stdout you don't need.** Codex `--json` outputs massive JSONL. Capturing it via `execFile` causes buffering issues. Use `spawn` with `stdio: ['ignore', 'ignore', 'pipe']` and output to `-o <file>` instead.

5. **Early returns skip cleanup code.** The `return;` after CLI fallback success skipped `target.lastRun` assignment, causing "never" in the dashboard.

6. **Add manual fire endpoints for testing.** The minute-offset guard made it impossible to test the scheduler without waiting up to 30 minutes. The `POST /api/scheduler/fire` endpoint with `force: true` bypasses guards.

---

## 8. Code Changes

**Files modified:**
- `server.js` — credential auto-detection, CLI spawn rewrite, response size, manual fire endpoint
- `index.html` — CSS text wrapping fix
- `servers.json` — added `fallbackKeys` to Claude target
- `tests/scheduler.test.js` — updated for no-truncation behavior

**Related issues/PRs:**
- Spec: N/A (bug fix session)
- Plan: N/A (bug fix session)

---

## 9. Scheduler Auth Reference

**Claude credential setup:**
- File: `~/.claude/config.json`
- Keys tried: `primaryApiKey` → `oauthToken` → `accessToken` → `token`
- Auth type auto-detected from token prefix
- CLI fallback: `claude` CLI must be installed and authenticated via `claude login`

**Codex credential setup:**
- File: `~/.codex/auth.json`
- Key: `tokens.access_token` (Google OAuth JWT)
- IMPORTANT: This token does NOT work with `api.openai.com`. Codex uses CLI subprocess only.
- CLI: `codex` npm package must be installed globally (`npm i -g @openai/codex`) and authenticated via `codex login`

**Testing the scheduler:**
```bash
# Manual fire (bypasses minute-offset guards)
curl -X POST http://localhost:9595/api/scheduler/fire

# Check results
curl http://localhost:9595/api/scheduler
```
