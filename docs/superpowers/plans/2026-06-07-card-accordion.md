# Card Accordion with Server Details — Implementation Plan

**Status:** in progress
**Spec:** [2026-06-07-card-accordion-design.md](../specs/2026-06-07-card-accordion-design.md)
**Related ADRs:** 0003 (Config + Port-Scan Discovery)

**Goal:** Add expandable accordion to each dashboard card showing runtime stack and uptime, with config-vs-process mismatch detection.
**Scope:** `servers.json`, `server.js` (backend detection + API), `index.html` (accordion UI)
**Non-goals:** Real-time metrics, historical tracking, config editing from UI
**Prerequisites:** (none)
**Produces:** 3 modified files, enriched API response, collapsible card panels

## Definition of Done

- Accordion expands/collapses on click, shows stack (with mismatch detection), uptime, and start time.
- Stack validated against OS process detection; mismatch flag shown in amber when config differs from process.
- Uptime uses OS process start time, falls back to proxy-tracked healthy-since.
- Accordion state survives 10s auto-refresh without flicker.
- All existing tests (32 header-rewriting + 14 scheduler) still pass.
- Down servers show config stack (or "Unknown") with uptime "—".

## Assumptions, Gaps, And Limitations

| Type | Statement | Impact | Action |
|---|---|---|---|
| Assumption | All servers run on Windows | `netstat`/`tasklist`/`Get-Process` are Windows-only | Document in ADR 0003 if cross-platform needed later |
| Assumption | Process PID visible on listening port | Some sandboxed processes may not expose | Graceful fallback to config-only |
| Gap | No e2e test for accordion in Playwright | Accordion interaction not covered by existing e2e | Manual browser verification accepted |

## Risk Register

| Risk | Why it matters | Mitigation | Verification hook |
|---|---|---|---|
| `netstat`/`tasklist` performance impact | Spawning shells every 10s for 9 servers | Runs within existing async health-check cycle, non-blocking | Check server.js event loop not blocked |
| Card flicker on accordion state loss | DOM rebuilt loses expanded state | `expandedPorts` Set preserves state across `renderServers()` diffs | Visual check during browser verification |
| Keyword matching false positives | Config "Notebook" contains "Node" → maps to node.exe incorrectly | Word-boundary filtering: match only whole keywords | Test against real server configs |

## Task 1: Add `stack` field to servers.json

**Files:**
- Modify: `servers.json`

**Steps:**
- [ ] Add `"stack"` field to each of the 9 server entries with correct runtime description (e.g., `"Bun + Hono"`, `"Node.js + Vite"`, `"Python/uvicorn"`, `"PowerShell"`)
- [ ] Validate JSON is well-formed: `node -c servers.json` (accepted; JSON parse validates)

**Tests / checks:**
- `node -e "JSON.parse(require('fs').readFileSync('servers.json','utf8'))"` (parses clean)

## Task 2: Backend — process detection, stack matching, uptime tracking (server.js)

**Files:**
- Modify: `server.js`

**Steps:**
- [ ] Add `detectProcess(port)` async function: runs `netstat -ano | findstr :PORT` → extracts PID → `tasklist /fi "PID eq X" /fo csv` → returns `{ exe, runtime, pid }` or `null`
- [ ] Add runtime keyword map: Bun→bun.exe, Node/Express/Vite/etc→node.exe, Python/uvicorn/etc→python.exe, PowerShell/pwsh→pwsh.exe
- [ ] Add `getStackDisplay(server, processInfo)` function implementing the keyword-match logic from spec §7
- [ ] Add `firstSeenHealthy` map keyed by port; set on `down→ok` transition, clear on `ok→down`
- [ ] Add `getUptime(port, processInfo)` function: tries `Get-Process -Id PID | Select-Object StartTime`, falls back to `firstSeenHealthy[port]`
- [ ] Call `detectProcess()` in `discoverServer()` after successful health check; attach results to server status object
- [ ] Call `getStackDisplay()` and `getUptime()` in the `/api/servers` response builder; add `stack` and `uptime` objects to each server's JSON

**Tests / checks:**
- `node --test tests/header-rewriting.test.js` (32 tests — must all pass)
- `node --test tests/scheduler.test.js` (14 tests — must all pass)
- `node -e "require('./server.js')"` (loads without syntax errors)

## Task 3: Frontend — accordion UI (index.html)

**Files:**
- Modify: `index.html`

**Steps:**
- [ ] Add CSS for accordion panel: collapsed `grid-template-rows: 0fr`, expanded `1fr`, `transition: grid-template-rows 0.2s`, inner panel padding, detail rows (`.accordion-row`), mismatch note (amber, small font, `.stack-mismatch` class)
- [ ] Add CSS for toggle button: styled `<span>` below card actions, `▼`/`▲` arrow via `.expanded` class on card
- [ ] Add `expandedPorts` Set in JS to track which cards are expanded across refreshes
- [ ] In `renderServers()`, after card action buttons: append toggle span + collapsible panel div
- [ ] Panel content: stack row (with optional mismatch note), uptime row (formatted as "Xh Ym" or "—" if down), started row (formatted local time or omitted if down)
- [ ] Click handler on toggle: add/remove port from `expandedPorts`, toggle `.expanded` class on card's panel element
- [ ] After card diff in `renderServers()`: re-expand any card whose port is in `expandedPorts`
- [ ] Format uptime seconds → human-readable: `<1m` / `Xm` / `Xh Ym` / `Xd Xh`
- [ ] Format start time → locale string: `toLocaleTimeString()` or `toLocaleString()` if different day

**Tests / checks:**
- `node -e "const fs=require('fs'); eval(fs.readFileSync('index.html','utf8').match(/<script>[^]*<\/script>/)[0].replace('</script>','').replace('<script>',''))"` confirms JS syntax valid (approximate)
- Visual browser verification: expand accordion on each card, verify stack matching, check uptime increments, kill a server and refresh

## Task 4: Verification — tests and browser check

**Files:**
- No new files; verify existing suites

**Steps:**
- [ ] Run `node --test tests/header-rewriting.test.js` — all 32 pass
- [ ] Run `node --test tests/scheduler.test.js` — all 14 pass
- [ ] Start dashboard: `node server.js`
- [ ] Open `http://localhost:9595` — grid loads, no console errors
- [ ] Expand accordion on each card — stack shown, uptime counting
- [ ] Check mismatch: edit `servers.json` to set one stack to wrong value, restart, verify "config mismatch" in amber
- [ ] Check down server: stop one server, refresh, verify accordion shows stack + "—" uptime
- [ ] Check refresh survival: expand 3 cards, wait 10s, verify all stay expanded

## Evidence Required Before Completion

- Code paths changed match scope (3 files only).
- `node --test` suites pass with zero failures.
- Browser screenshots show expanded accordion on multiple cards.
- No console errors in browser devtools.

## Completion Checklist

- [ ] All tasks complete
- [ ] Definition of Done met
- [ ] `docs/ai/work-state.md` updated
- [ ] `docs/ai/todo.md` updated
