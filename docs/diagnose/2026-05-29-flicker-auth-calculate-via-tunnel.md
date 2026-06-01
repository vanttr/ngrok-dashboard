# Diagnose: Flickering Refresh, Auth Errors, and Broken Calculate via Tunnel

Date: 2026-05-29
Status: Fixed 2026-05-29 (three rounds)
Files changed: `server.js`, `index.html`, `tests/header-rewriting.test.js`, `tests/e2e-visual.js`, `tests/e2e-calculate.js`, `tests/e2e-dashboard-check.js`

---

## Symptoms

Three related problems reported when using apps through the ngrok tunnel:

1. **Dashboard flicker** — The dashboard page visibly flickers every 10 seconds when auto-refreshing server status.
2. **Auth login failure** — Clicking a login button on an app served through the tunnel results in an error or a broken redirect to `localhost`.
3. **Calculate buttons dead** — HTMX calculate buttons (hub FinanceTracker, vanforms) do nothing when clicked through the tunnel, but work on standalone servers.

---

## Root Causes

### Bug 1: Dashboard flickering

`renderServers()` in `index.html` called `container.innerHTML = ''` on every 10-second poll, destroying the entire DOM subtree and recreating it from scratch. This caused:

- Visible white-flash flicker as cards were destroyed and rebuilt
- Lost CSS animation states (`fadeSlideUp` replays on every refresh)
- Lost hover states and user interaction context

### Bug 2: Auth login errors

When a backend app (e.g., vanforms) redirects after login, it sends a response like:

```
HTTP/1.1 302 Found
Location: http://localhost:8086/dashboard
Set-Cookie: session=abc123; Domain=localhost; Path=/
```

The proxy forwarded both headers unchanged. The browser then:

- Navigated directly to `http://localhost:8086/dashboard` — unreachable from a different machine
- Received a `Domain=localhost` cookie that the browser rejected because it didn't match the ngrok domain

### Bug 3: Calculate buttons not working

Two sub-causes:

**3a. No forwarding headers.** The proxy set `Host: localhost:8086` but didn't send `X-Forwarded-Proto` or `X-Forwarded-Host`. Backend apps (FastAPI, PowerShell HttpListener) use these headers to construct absolute URLs and validate request origins. Without them, the apps couldn't determine the correct public origin.

**3b. CORS preflight interception.** The server had a blanket `OPTIONS` handler that consumed ALL preflight requests:

```javascript
if (req.method === 'OPTIONS') {
  // responded with CORS headers and ended the request
}
```

When HTMX sends a `POST /forms/finance/homeloan/calculate`, the browser may send a preflight `OPTIONS` request first. The proxy intercepted it and responded with generic CORS headers instead of forwarding it to the backend app, which needed to handle its own CORS.

---

## Changes Made

### `index.html` — Flicker-free DOM updates

Replaced the naive `innerHTML = ''` + full rebuild with an incremental diff-update pattern:

**Before:**
```javascript
function renderServers(servers, target) {
  const container = document.getElementById('server-list');
  container.innerHTML = '';  // destroys everything
  for (const s of servers) {
    // rebuilds every card from scratch
    container.appendChild(card);
  }
}
```

**After:**
```javascript
let cardMap = {};  // { port: { el, state } }

function statesEqual(a, b) {
  // compares name, health, status, ports, isActive, ngrokUrl
}

function renderServers(servers, target) {
  // 1. Compute desired state for each server
  // 2. Remove cards that no longer exist
  // 3. Skip cards that haven't changed (statesEqual check)
  // 4. Create/update only cards that differ
  // 5. Maintain correct order with insertBefore
}
```

Key benefit: unchanged cards are never touched — no DOM destruction, no animation restart, no flicker.

### `server.js` — Proxy header rewriting

#### Location header rewriting

Added `rewriteOrigin()` function that rewrites `Location` headers in 30x redirect responses:

```javascript
function rewriteOrigin(value, targetHost, targetPort, publicOrigin) {
  // "http://localhost:8086/dashboard" → "https://abc123.ngrok-free.app/dashboard"
  // handles both http and https, with and without port
}
```

Applied in the proxy response handler:
```javascript
if (lk === 'location') {
  filteredHeaders[k] = rewriteOrigin(v, targetHost, targetPort, publicOrigin);
  continue;
}
```

#### Set-Cookie header rewriting

Added `rewriteCookie()` function that fixes cookies for tunnel compatibility:

```javascript
function rewriteCookie(cookieStr, publicOrigin, isSecure) {
  // 1. Strip Domain=localhost and Domain=localhost:PORT
  //    (browser defaults to the request domain = ngrok URL)
  // 2. Upgrade SameSite=Lax/Strict → SameSite=None
  // 3. Add Secure flag when tunnel is HTTPS (required for SameSite=None)
}
```

Applied in the proxy response handler:
```javascript
if (lk === 'set-cookie') {
  const cookies = Array.isArray(v) ? v : [v];
  filteredHeaders[k] = cookies.map(c => rewriteCookie(c, publicOrigin, origProto === 'https'));
  continue;
}
```

#### X-Forwarded headers

Added standard proxy forwarding headers so backend apps can determine the original protocol and host:

```javascript
const origProto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
const origHost  = req.headers['x-forwarded-host'] || req.headers.host || `${SWITCHER_HOST}:${SWITCHER_PORT}`;
const origIp    = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';

filteredReqHeaders['x-forwarded-for']  = origIp;
filteredReqHeaders['x-forwarded-proto'] = origProto;
filteredReqHeaders['x-forwarded-host']  = origHost;
```

#### Scoped CORS preflight

Changed from blanket `OPTIONS` handler to scoped API-only:

**Before (intercepted ALL OPTIONS including proxy targets):**
```javascript
if (req.method === 'OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.writeHead(204);
  res.end();
  return;
}
```

**After (only switcher API routes):**
```javascript
const isSwitcherApiRoute = pathname === '/api/servers' ||
  pathname === '/api/target' ||
  pathname === '/api/health';

if (req.method === 'OPTIONS' && isSwitcherApiRoute) {
  // same CORS headers, but only for API routes
}
```

Also added `Access-Control-Allow-Origin: *` to individual API response handlers (previously set globally via the common header, now per-route since dashboard and proxy don't need it).

### `tests/header-rewriting.test.js` — Unit tests

32 tests covering:

- `rewriteOrigin`: 8 tests (localhost with port, without port, https, query strings, null input, non-localhost passthrough, relative URLs)
- `rewriteCookie`: 12 tests (Domain stripping, SameSite upgrade, Secure flag addition, http vs https tunnels, HttpOnly/Path preservation, duplicate Secure prevention, null handling)
- `escapeRegex`: 2 tests (special chars, normal strings)
- `rewriteHtmlBody`: 10 tests (hx-post, form action, anchor href, JS string literals, different port not rewritten, non-localhost not rewritten, multiple occurrences, null/empty, bare localhost)

All 32 pass.

---

## Architectural Notes for Future Sessions

### How the proxy works

```
Browser → ngrok (https) → server.js :9595 → localhost:PORT (backend app)
```

The proxy sits at `localhost:9595`. When a target is active, all non-API, non-dashboard requests are forwarded to the target backend server. Key transformation summary:

| Direction | Header | Transform |
|-----------|--------|-----------|
| Request → | `Host` | Set to `localhost:PORT` (backend expects this) |
| Request → | `X-Forwarded-Proto` | Added (original protocol from ngrok) |
| Request → | `X-Forwarded-Host` | Added (original host from browser) |
| Request → | `X-Forwarded-For` | Added (original client IP) |
| Response ← | `Location` | Rewritten: `localhost:PORT` → public origin |
| Response ← | `Set-Cookie` | `Domain=localhost` stripped; `SameSite` upgraded for HTTPS |
| Response ← | `ngrok-skip-browser-warning` | Injected if missing |

### How the dashboard refresh works

The dashboard tracks card state in a `cardMap` object keyed by port number. On each 10-second poll:

1. `fetchState()` fetches `/api/servers`
2. `renderServers()` computes desired state map
3. Cards that no longer exist → removed from DOM
4. Cards that haven't changed (`statesEqual`) → untouched in DOM
5. Cards that changed → rebuilt and inserted in correct position
6. New cards → created and inserted

This eliminates the `innerHTML = ''` full-rebuild flicker.

### ERR_NGROK_3303: "URL 'state' parameter is invalid"

This error occurs at the **ngrok edge** level, NOT in our proxy. It happens when the browser has a stale `nonce` cookie from a previous OAuth session that doesn't match the current `state` parameter in the OAuth callback.

**Common causes:**
1. Restarted `node server.js` (kills ngrok process, new tunnel URL, old cookie stale)
2. Page refresh during the Google OAuth flow
3. Multiple browser tabs hitting the ngrok URL simultaneously

**Fix:** Clear browser cookies for `*.ngrok-free.app` and revisit the URL. Or use an incognito/private window.

**Our proxy code is NOT involved** — ngrok validates the OAuth state before any traffic reaches port 9595.

### Bug 4 (Regression): Dashboard not refreshing after activating a tunnel

The flicker-free `renderServers()` introduced Bug 1 had a subtle DOM insertion bug. When a card's state changed (e.g., clicking "Tunnel" to activate a server), the function removed the old DOM element but left the `insertBefore` reference pointing to the now-detached node. This caused `container.insertBefore(card, insertBefore)` to throw a `NotFoundError`, silently killing the entire `renderServers` function.

**Symptom:** Clicking "Tunnel" or "Stop" appeared to do nothing — the card didn't update, no "active" badge appeared, the button text didn't change.

**Root cause:** The `insertBefore` variable tracked the DOM position for inserting cards in order. When a card was rebuilt (state changed), the old element was removed with `.remove()`. If `insertBefore` happened to reference that same element (which is the common case — cards are processed in order), it became a detached DOM node. `container.insertBefore(card, detachedNode)` throws `NotFoundError`.

**Fix:** Before removing the old element, advance `insertBefore` past it:

```javascript
if (cardMap[displayPort]) {
  if (cardMap[displayPort].el === insertBefore) {
    insertBefore = cardMap[displayPort].el.nextSibling;
  }
  cardMap[displayPort].el.remove();
  delete cardMap[displayPort];
}
```

Also added a safety net: `if (insertBefore && container.contains(insertBefore))` before calling `insertBefore`, falling back to `appendChild` if the reference is invalid.

### Potential issues to watch

- **Backend apps that validate Origin header** may reject requests because the Origin will be the ngrok domain, not localhost. If this happens, the proxy may need to rewrite the Origin header too.
- **WebSocket connections** are not handled by this proxy — only HTTP. If an app needs WebSocket support through the tunnel, the proxy would need `upgrade` handling.
- **Large file uploads** have no body size limit yet (noted in todo.md).

---

## Re-diagnosis: 2026-05-29 (Round 2) — Still not fixed after initial changes

Unit tests passed (22/22) but live testing still showed failures. Code analysis revealed three additional bugs.

### Additional Bug 1: Zombie cards in DOM (flicker fix was incomplete)

**Root cause:** `renderServers()` in `index.html` created new card elements when state changed but never removed the OLD element from the DOM. The old `cardMap[displayPort].el` was overwritten in `cardMap` but remained in the grid as a zombie. After clicking "Tunnel" to activate a server, both the old inactive card AND the new active card appeared in the grid.

**Fix:** Added `cardMap[displayPort].el.remove()` before creating the replacement card.

**Also fixed:** `renderHeader` always called `status.innerHTML = '...'` rebuilding the inner span on every 10-second poll even when nothing changed. Changed to only set fields when the value actually differs.

### Additional Bug 2: Auth and calculate — proxy only rewrites headers, not HTML bodies

**Root cause (misdiagnosed originally):** The original fix addressed `Location` and `Set-Cookie` headers (HTTP-level redirects and cookies). But if backend apps (Hub/Vanforms) serve HTML containing hardcoded `http://localhost:PORT` URLs in HTMX attributes (`hx-post`, `hx-get`), form `action` attributes, or `<a href>` values, the browser receives those URLs unchanged and makes requests **directly to localhost** — bypassing the proxy entirely. When the requests bypass the proxy:

1. Session cookies for `abc123.ngrok-free.app` are NOT sent (different domain) → auth fails → calculate fails.
2. If the user is on a different machine, localhost is unreachable entirely.

The X-Forwarded headers fix was supposed to let backends construct correct URLs. But this only works if the backend explicitly uses `X-Forwarded-Host` (e.g., FastAPI with `ProxyHeadersMiddleware`). Backends that don't have this are still generating localhost URLs.

**Fix:** Three-part change to `server.js`:

1. **Force uncompressed responses:** Added `accept-encoding: identity` to all upstream requests so HTML responses arrive as plain text and can be rewritten without decompression.

2. **Buffer and rewrite HTML bodies:** For `content-type: text/html` responses, buffer the full body, run `rewriteHtmlBody()`, update `content-length`, and send the modified body.

3. **`rewriteHtmlBody()` function:** Replaces all occurrences of `http(s)://localhost:PORT` with the public origin anywhere in the HTML text — covering HTMX attributes, form actions, anchor hrefs, and inline JavaScript.

```javascript
function rewriteHtmlBody(html, targetHost, targetPort, publicOrigin) {
  const withPort = new RegExp(`https?://${escapeRegex(targetHost)}:${targetPort}`, 'gi');
  let rewritten = html.replace(withPort, publicOrigin);
  const bareHost = new RegExp(`https?://${escapeRegex(targetHost)}(?=/|"|'|\\s|>)`, 'gi');
  rewritten = rewritten.replace(bareHost, publicOrigin);
  return rewritten;
}
```

**Tests added:** 10 tests for `rewriteHtmlBody` covering all major contexts.

### Final header/proxy transformation table

| Direction | Header / Content | Transform |
|-----------|-----------------|-----------|
| Request → | `Host` | Set to `localhost:PORT` |
| Request → | `X-Forwarded-Proto` | Added (original protocol from ngrok) |
| Request → | `X-Forwarded-Host` | Added (original host from browser) |
| Request → | `X-Forwarded-For` | Added (original client IP) |
| Request → | `Accept-Encoding` | Forced to `identity` (prevents compression) |
| Response ← | `Location` | Rewritten: `localhost:PORT` → public origin |
| Response ← | `Set-Cookie` | `Domain=localhost` stripped; `SameSite` upgraded for HTTPS |
| Response ← | HTML body | `http://localhost:PORT` → public origin (all occurrences) |
| Response ← | `Content-Length` | Recalculated after HTML body rewriting |
| Response ← | `ngrok-skip-browser-warning` | Injected if missing |

---

## Re-diagnosis: 2026-05-29 (Round 3) — POST requests 502 after Round 2 fixes

Round 2 fixes unblocked GET-based navigation through the proxy. But POST requests (Calculate button) still returned `502 {"error":"Cannot reach Hub on port 8099","detail":"socket hang up"}`. Hub responded correctly to direct curl POSTs.

### Root cause: Node.js v16+ autoDestroy destroys `req` immediately after `end`

Two interacting behaviours combined to kill every proxied POST:

**Behaviour A — Node.js stream autoDestroy:** In Node.js v16+, readable streams (including `http.IncomingMessage`) have `autoDestroy: true` by default. When the request body stream emits `end`, Node.js immediately destroys the stream and emits `close` — before the upstream backend has had time to respond.

**Behaviour B — `req.on('close')` guard:** The proxy had a cleanup handler:
```javascript
req.on('close', () => {
  if (!res.headersSent && !proxyReq.destroyed) {
    proxyReq.destroy();  // ← fires before Hub responds
  }
});
```
This was intended to abort the upstream request when a client *abandons* the connection mid-flight. But because of Behaviour A, it fires on EVERY POST request, right after the body is fully received — while Hub is still computing the response and `res.headersSent` is still false.

**Confirmed via debug logging:**
```
[DEBUG] req data chunk: 53 bytes
[DEBUG] req end — calling proxyReq.end()
[DEBUG] req close fired — headersSent: false proxyReq.destroyed: false
[DEBUG] destroying proxyReq due to req.close    ← destroys before Hub responds
[DEBUG] socket closed, hadError: false
Proxy error to :8099: socket hang up
```

### Fix

Track whether the request body has finished sending. Only destroy `proxyReq` in the close handler if the request body was NOT fully sent (i.e., the client genuinely abandoned the request):

```javascript
let reqEnded = false;
// ...
req.on('end', () => {
  reqEnded = true;
  proxyReq.end();
});

req.on('close', () => {
  // Only abort if client disconnected before finishing the request body.
  // Do NOT abort if close fires due to Node.js autoDestroy after 'end'.
  if (!reqEnded && !res.headersSent && !proxyReq.destroyed) {
    proxyReq.destroy();
  }
});
```

Also added `agent: false` to `http.request` to prevent connection pool reuse issues with backend servers (e.g. PowerShell HttpListener) that close connections after each response.

### Verified

Playwright e2e test `tests/e2e-calculate.js`:
- POST sent: 1
- Response: 200 (10709 bytes)
- Results displayed: PASS (loan summary, repayments, loan cost all populated)
- Screenshot: `test-results/screenshots/calc-04-after-calculate.png`

---

## Playwright Test Setup

### Why the real ngrok URL cannot be used for automated tests

The ngrok tunnel requires Google OAuth login (`--oauth=google` flag). Every visit to the public ngrok URL goes through an OAuth consent screen. Automating OAuth is fragile and environment-specific. Instead, all Playwright tests target `http://localhost:9595` directly — the proxy itself — which applies all the same header rewriting and body rewriting as the tunnel, but without the OAuth gate.

This is the correct level to test: if `localhost:9595` works correctly, then `https://abc123.ngrok-free.app` will too, since ngrok is just a TCP tunnel that terminates at port 9595.

### How to set a proxy target from a test

The proxy exposes `POST /api/target` to select which backend server to route to:

```javascript
await fetch('http://localhost:9595/api/target', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ port: 8099 })   // Hub
});
```

Always clear the target after the test:
```javascript
await fetch('http://localhost:9595/api/target', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ port: null })   // clear
});
```

### Discovering the Hub navigation path

Hub is an HTMX single-page app — it does not use URL routing. Navigating to sub-pages requires clicking elements that trigger `hx-get` requests. The navigation chain was discovered by tracing curl responses:

```
GET /                          → Hub root (serves main shell + tab bar)
  hx-get="/api/tab/hub"        → loads Hub tab content
    hx-get="/api/hub/index"    → Hub index (shows app grid)
      hx-get="...app=ft"       → launches FinanceTracker
        hx-get="...homeloan/init" → Property Loan form
          hx-post="...homeloan/calculate" on <form id="ft-hl-form">
```

Key insight from the curl trace: `hx-post` is on the `<form>` element, not the button. HTMX listens for the form `submit` event. Clicking the `<form>` element directly does NOT trigger submit — you must click the `<button type="submit">` inside it.

### Playwright locators for HTMX navigation

Because Hub uses HTMX attributes for navigation, use attribute selectors rather than text:

```javascript
// Navigate to FinanceTracker
await page.locator('[hx-get*="app=ft"]').first().click();

// Navigate to Property Loan
await page.locator('[hx-get*="homeloan/init"]').first().click();

// Submit the calculate form — must click the button, not the form
const submitBtn = page.locator('#ft-hl-form button[type="submit"]').first();
await submitBtn.scrollIntoViewIfNeeded();
await submitBtn.click();
```

### Test files

**`tests/e2e-visual.js`** — Two-part visual verification:
- Part 1: Zombie card check. Opens the dashboard, activates the Hub tunnel, waits for the 10s poll, and counts Hub cards. Expected: exactly 1 Hub card at each stage.
- Part 2: Hub FinanceTracker navigation via proxy. Opens Hub through `localhost:9595`, navigates to Property Loan, fills the form, clicks Calculate, and reads the results. Checks for network errors.
- Run with: `node tests/e2e-visual.js` (requires dashboard running, Hub running, Hub tunnel NOT yet active)

**`tests/e2e-calculate.js`** — Targeted calculate button test:
- Sets Hub as the proxy target via API, navigates to Property Loan through the proxy, loads the first saved scenario from the dropdown (avoids manual fill / wrong values), clicks `#ft-hl-form button[type="submit"]`, and checks for a POST to `/api/ft/homeloan/calculate` and a non-placeholder response in `#ft-hl-results`.
- Intercepts `request` and `response` events to confirm the POST was sent and the response status.
- Run with: `node tests/e2e-calculate.js` (requires `server.js` running, Hub running on port 8099)

**`tests/e2e-dashboard-check.js`** — Dashboard stability check:
- Opens `/dash`, reads card count, waits through two 11-second poll cycles, and compares card counts. Detects both card accumulation (zombie cards) and card loss.
- Run with: `node tests/e2e-dashboard-check.js` (requires `server.js` running)

### Lessons learned during test development

| Problem | Root cause | Fix |
|---------|-----------|-----|
| Clicking form element sends no POST | `hx-post` on `<form>` — HTMX uses `submit` event, clicking the form element doesn't fire it | Click `button[type="submit"]` inside the form |
| `htmx.ajax()` in `page.evaluate()` fails | `page.evaluate()` runs in a utility context without access to the page's `htmx` global | Use `page.locator('[hx-get*="..."]').click()` instead |
| Wrong form values (deposit 500000 instead of 18.5%) | Auto-fill heuristic filled all number inputs with 500000 | Load saved scenarios from the dropdown instead |
| Navigate directly to HTMX endpoint gives raw HTML | Hub is an SPA — navigating directly loads a fragment, not the full shell | Navigate to `/` first, then drive clicks through the HTMX element chain |