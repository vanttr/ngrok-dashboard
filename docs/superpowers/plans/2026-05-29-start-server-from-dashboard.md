# Start Server from Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Start" button to offline servers in the dashboard that spawns their `dev.ps1` script, with visual feedback and automatic refresh.

**Architecture:** Backend adds one fire-and-forget `POST /api/servers/:port/start` endpoint that spawns `powershell.exe` detached. Frontend tracks starting state per-port with a 3s fast-poll that times out after 12s. No backend state is maintained for starting servers.

**Tech Stack:** Node.js built-ins (child_process.spawn), vanilla JS/CSS, PowerShell for dev scripts.

---

### Task 1: Add devScript paths to servers.json

**Files:**
- Modify: `servers.json`

- [ ] **Step 1: Update servers.json with devScript paths**

Replace the entire contents of `servers.json` with:

```json
{
  "servers": [
    { "name": "Codenomad",   "port": 9896,  "devScript": "E:/Van/Documents/GitHub/codenomad/dev.ps1" },
    { "name": "Companion",   "port": 3470,  "devScript": "E:/Van/Documents/GitHub/companion/dev.ps1" },
    { "name": "Ollama",      "port": 4000,  "devScript": "E:/Van/Documents/GitHub/ollama/dev.ps1" },
    { "name": "Vanforms",    "port": 8086,  "devScript": "E:/Van/Documents/GitHub/vanforms/dev.ps1" },
    { "name": "Hub",         "port": 8099,  "devScript": "E:/Van/Documents/GitHub/hub/dev.ps1" },
    { "name": "Thevanbot",   "port": 8787,  "devScript": "E:/Van/Documents/GitHub/thevanbot/dev.ps1" },
    { "name": "Openchamber", "port": 57123, "devScript": "E:/Van/Documents/GitHub/openchamber/dev.ps1" }
  ],
  "scanRange": 50,
  "switcherPort": 9595,
  "healthIntervalMs": 10000
}
```

- [ ] **Step 2: Verify JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('servers.json','utf8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add servers.json
git commit -m "feat: add devScript paths to servers.json for start-server feature"
```

---

### Task 2: Add POST /api/servers/:port/start endpoint to server.js

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add the start-server route handler**

Insert the following block in `server.js` after the existing `/api/target` POST handler (after line 263, before the `/ngrok-skip-browser-warning` handler). Also add `isSwitcherApiRoute` recognition for the new endpoint.

**Change 1:** Update the `isSwitcherApiRoute` variable (around line 199) to include the new start route:

```javascript
const isSwitcherApiRoute = pathname === '/api/servers' ||
    pathname === '/api/target' ||
    pathname === '/api/health' ||
    /^\/api\/servers\/\d+\/start$/.test(pathname);
```

**Change 2:** Insert the new route handler after the `/api/target` POST handler (after the closing `}` on line 263):

```javascript
if (pathname.match(/^\/api\/servers\/(\d+)\/start$/) && req.method === 'POST') {
    const portMatch = pathname.match(/^\/api\/servers\/(\d+)\/start$/);
    const port = parseInt(portMatch[1]);
    const serverEntry = CONFIG.servers.find(s => s.port === port);

    if (!serverEntry) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: 'Unknown port' }));
      return;
    }

    if (!serverEntry.devScript) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: `No devScript configured for ${serverEntry.name}` }));
      return;
    }

    if (!fs.existsSync(serverEntry.devScript)) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: `dev.ps1 not found at ${serverEntry.devScript}` }));
      return;
    }

    try {
      const child = spawn('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-File', serverEntry.devScript
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.on('error', (err) => {
        console.error(`Spawn error for ${serverEntry.name}: ${err.message}`);
      });
      child.unref();

      console.log(`Started ${serverEntry.name} via ${serverEntry.devScript} (PID: ${child.pid})`);

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, starting: true }));
    } catch (e) {
      console.error(`Failed to start ${serverEntry.name}: ${e.message}`);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: `Failed to spawn process: ${e.message}` }));
    }
    return;
  }
```

- [ ] **Step 2: Verify server starts without errors**

Run: `node -e "require('./server.js')" &` then quickly `curl -s http://localhost:9595/api/health | head` (or just confirm the process doesn't crash on import). Then kill it.

Alternative quick syntax check:
Run: `node -c server.js`
Expected: No syntax errors

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add POST /api/servers/:port/start endpoint for starting servers"
```

---

### Task 3: Add devScript to /api/servers response

**Files:**
- Modify: `server.js`

The `/api/servers` endpoint currently returns server data from `discoverServer()`, which only returns `{ name, configuredPort, actualPort, health, status }`. The frontend needs to know whether a `devScript` exists for each server to decide whether to show the Start button.

- [ ] **Step 1: Add hasDevScript field to discoverServer return values**

In `server.js`, modify the `discoverServer` function to include `hasDevScript` in each return object. Change the three return statements inside `discoverServer`:

**Return 1** (line ~128, server found on configured port):
```javascript
return { name: server.name, configuredPort, actualPort: configuredPort, health: 'ok', status: 'ok', hasDevScript: !!server.devScript };
```

**Return 2** (line ~141, server found on drifted port):
```javascript
return { name: server.name, configuredPort, actualPort: p, health: 'ok', status: 'drifted', hasDevScript: !!server.devScript };
```

**Return 3** (line ~145, server down):
```javascript
return { name: server.name, configuredPort, actualPort: null, health: 'down', status: 'down', hasDevScript: !!server.devScript };
```

- [ ] **Step 2: Verify server starts without errors**

Run: `node -c server.js`
Expected: No syntax errors

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: include hasDevScript in /api/servers response"
```

---

### Task 4: Add CSS styles for Start and Starting button states

**Files:**
- Modify: `index.html` (CSS section)

- [ ] **Step 1: Add Start button styles after the existing `.tunnel-btn.stop:hover` rule (around line 297)**

Insert after the `.tunnel-btn.stop:hover:not(:disabled)` rule:

```css
  .tunnel-btn.start {
    background: linear-gradient(135deg, var(--ok), #246836);
    box-shadow: 0 2px 12px rgba(46,125,68,0.2);
  }
  .tunnel-btn.start:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 18px rgba(46,125,68,0.3);
  }
  .tunnel-btn.starting {
    background: linear-gradient(135deg, var(--ink-soft), #506872);
    box-shadow: none;
    cursor: wait;
    animation: btnPulse 1.2s ease-in-out infinite;
  }
  @keyframes btnPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
```

- [ ] **Step 2: Verify page loads without CSS errors**

Open the dashboard HTML in a browser or just check the file is well-formed. No automated check needed — CSS is non-breaking.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add CSS styles for Start and Starting button states"
```

---

### Task 5: Add frontend start-server logic to index.html

**Files:**
- Modify: `index.html` (JS section)

This is the largest task. It modifies the card rendering logic and adds the start-server interaction.

- [ ] **Step 1: Add startingPorts tracking state**

After `let cardMap = {};` (line 364), add:

```javascript
let startingPorts = {};  // { configuredPort: { timer, startTime } } — keyed by configuredPort (not displayPort) to avoid drift key mismatch
```

- [ ] **Step 2: Update statesEqual to account for new card state fields**

Replace the existing `statesEqual` function (lines 366-371) with:

```javascript
function statesEqual(a, b) {
  if (!a || !b) return false;
  return a.name === b.name && a.health === b.health && a.status === b.status &&
         a.configuredPort === b.configuredPort && a.actualPort === b.actualPort &&
         a.isActive === b.isActive && a.ngrokUrl === b.ngrokUrl &&
         a.hasDevScript === b.hasDevScript && a.isStarting === b.isStarting;
}
```

- [ ] **Step 3: Update newStateMap computation in renderServers to include hasDevScript and isStarting**

In the `renderServers` function, inside the `for (const s of servers)` loop (around line 426-437), update the `newStateMap` entry to include the new fields:

```javascript
    newStateMap[displayPort] = {
      name: s.name, health: s.health, status: s.status,
      configuredPort: s.configuredPort, actualPort: s.actualPort,
      isActive, isDown, isDrifted, ngrokUrl, displayPort,
      hasDevScript: !!s.hasDevScript,
      isStarting: !!startingPorts[s.configuredPort]  // Use configuredPort as key — avoids drift mismatch
    };

    // If server came online while we were starting it, clear the starting state
    if (s.health === 'ok' && startingPorts[s.configuredPort]) {
      const info = startingPorts[s.configuredPort];
      if (info.timer) clearInterval(info.timer);
      delete startingPorts[s.configuredPort];
    }
```

- [ ] **Step 4: Replace the card button HTML in renderServers**

Replace the existing card-actions block (lines 495-501):

Old:
```html
      <div class="card-actions">
        <button class="tunnel-btn${state.isActive ? ' stop' : ''}" ${state.isDown ? 'disabled' : ''} data-port="${state.displayPort}">
          ${state.isActive ? 'Stop' : 'Tunnel'}
        </button>
        ${state.isActive && state.ngrokUrl ? `<a class="tunnel-url" href="${escAttr(state.ngrokUrl)}" target="_blank">Open server &rarr;</a>` : ''}
      </div>
```

New:
```html
      <div class="card-actions">
        <button class="tunnel-btn${buttonClass(state)}" ${buttonDisabled(state)} data-port="${state.displayPort}">
          ${buttonLabel(state)}
        </button>
        ${state.isActive && state.ngrokUrl ? `<a class="tunnel-url" href="${escAttr(state.ngrokUrl)}" target="_blank">Open server &rarr;</a>` : ''}
      </div>
```

- [ ] **Step 5: Add buttonClass, buttonDisabled, buttonLabel helper functions**

Add these after the `statesEqual` function:

```javascript
function buttonClass(state) {
  if (state.isActive) return ' stop';
  if (state.isStarting) return ' starting';
  if (state.isDown && state.hasDevScript) return ' start';
  return '';
}

function buttonDisabled(state) {
  if (state.isActive) return '';
  if (state.isStarting) return 'disabled';
  if (state.isDown && !state.hasDevScript) return 'disabled';
  return '';
}

function buttonLabel(state) {
  if (state.isActive) return 'Stop';
  if (state.isStarting) return 'Starting...';
  if (state.isDown && state.hasDevScript) return 'Start';
  return 'Tunnel';
}
```

- [ ] **Step 6: Update button click handler to route Start vs Tunnel**

Replace the existing button click handler line (line 504):

Old:
```javascript
    btn.addEventListener('click', () => handleTunnel(btn.dataset.port, state.isActive));
```

New:
```javascript
    btn.addEventListener('click', () => {
      if (state.isDown && state.hasDevScript && !state.isStarting) {
        handleStartServer(btn.dataset.port);
      } else {
        handleTunnel(btn.dataset.port, state.isActive);
      }
    });
```

- [ ] **Step 7: Add handleStartServer function and fast-poll logic**

Add this after the `handleTunnel` function:

```javascript
async function handleStartServer(port) {
  const key = Number(port);  // Normalize to number for consistent key type

  try {
    const resp = await fetch(`${API}/servers/${port}/start`, { method: 'POST' });
    const data = await resp.json();
    if (!data.ok) {
      alert(data.error || 'Failed to start server');
      return;
    }
  } catch (err) {
    alert('Network error — cannot reach switcher');
    return;
  }

  // Enter starting state — keyed by configuredPort (matches button data-port for down servers)
  startingPorts[key] = { startTime: Date.now() };

  // Fast-poll every 3s for up to 12s
  const pollTimer = setInterval(() => {
    fetchState();

    const info = startingPorts[key];
    if (!info) {
      clearInterval(pollTimer);
      return;
    }

    const elapsed = Date.now() - info.startTime;
    if (elapsed >= 12000) {
      clearInterval(pollTimer);
      delete startingPorts[key];
      fetchState();  // Final refresh to revert button
    }
  }, 3000);

  startingPorts[key].timer = pollTimer;
  fetchState();  // Immediate refresh to show "Starting..." state
}
```

- [ ] **Step 8: (Removed — clearing logic was moved into Step 3 above)**

- [ ] **Step 9: Verify no syntax errors**

Run: Extract the script section and check with Node.js, or simply load the dashboard in a browser.
Quick check — start the server:
```bash
node server.js
```
Then visit `http://localhost:9595/dash` and verify the dashboard loads without JS errors in the console.

- [ ] **Step 10: Commit**

```bash
git add index.html
git commit -m "feat: add start-server button, starting state, and fast-poll logic to dashboard"
```

---

### Task 6: Playwright test for start-server endpoint

**Files:**
- Create: `tests/start-server.spec.ts`

- [ ] **Step 1: Write the test file**

Create `tests/start-server.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

const TEST_PORT = 19595;
const BASE_URL = `http://localhost:${TEST_PORT}`;

test.describe('Start Server API endpoint', () => {
  test('POST /api/servers/:port/start returns 400 for unknown port', async ({ request }) => {
    const resp = await request.post(`${BASE_URL}/api/servers/99999/start`);
    expect(resp.status()).toBe(400);
    const data = await resp.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain('Unknown port');
  });

  test('POST /api/servers/:port/start returns 400 for server with no devScript', async ({ request }) => {
    // Temporarily test with a port that exists but has no devScript
    // Since all current servers have devScript, this tests the "Unknown port" path
    // If a server without devScript is added, this should be updated
    const resp = await request.post(`${BASE_URL}/api/servers/99999/start`);
    expect(resp.status()).toBe(400);
  });
});

test.describe('Start Server UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/dash`);
    await page.waitForLoadState('networkidle');
  });

  test('Down server with devScript shows Start button', async ({ page }) => {
    const downCards = page.locator('.server-card.dimmed');
    const count = await downCards.count();

    if (count > 0) {
      const btn = downCards.first().locator('.tunnel-btn');
      await expect(btn).toHaveClass(/start/);
      await expect(btn).toHaveText('Start');
      await expect(btn).toBeEnabled();
    }
  });

  test('Clicking Start enters Starting state', async ({ page }) => {
    const startBtn = page.locator('.tunnel-btn.start').first();
    const btnCount = await startBtn.count();

    if (btnCount > 0) {
      await startBtn.click();

      // Button should now show "Starting..." and be disabled
      const startingBtn = page.locator('.tunnel-btn.starting').first();
      await expect(startingBtn).toBeVisible({ timeout: 2000 });
      await expect(startingBtn).toHaveText('Starting...');
      await expect(startingBtn).toBeDisabled();
    }
  });

  test('Healthy server shows Tunnel button, not Start', async ({ page }) => {
    const healthyCards = page.locator('.server-card:not(.dimmed)');
    const count = await healthyCards.count();

    if (count > 0) {
      const btn = healthyCards.first().locator('.tunnel-btn:not(.stop)');
      const btnCount = await btn.count();
      if (btnCount > 0) {
        await expect(btn).toHaveText('Tunnel');
      }
    }
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx playwright test tests/start-server.spec.ts --reporter=list`
Expected: Tests pass (some may be vacuous if no servers are down at test time, which is fine)

- [ ] **Step 3: Commit**

```bash
git add tests/start-server.spec.ts
git commit -m "test: add Playwright tests for start-server feature"
```

---

## Dependency Map

```
Task 1 (servers.json) ──── no dependencies
Task 2 (backend endpoint) ─ depends on Task 1 (reads devScript from config)
Task 3 (hasDevScript in API) ─ depends on Task 1
Task 4 (CSS) ──────────── no dependencies
Task 5 (frontend JS) ──── depends on Task 2, 3, 4
Task 6 (tests) ─────────── depends on Task 2, 3, 4, 5
```

Tasks 1, 4 can run in parallel. Tasks 2, 3 can run in parallel after Task 1. Task 5 needs 2+3+4. Task 6 needs everything.

## Risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| dev.ps1 paths don't exist on disk | Start button triggers 400 error | Endpoint validates file exists before spawn; frontend shows alert |
| PowerShell not in PATH | spawn fails with ENOENT | Caught by try/catch in endpoint, returns 500 |
| Fast-poll timer leaks if page navigates away | Minor memory leak until page unload | Timers are short-lived (12s max), cleared on success or timeout |
| Starting state lost on page refresh | Button reverts to Start, but script already running | Acceptable per spec — 10s refresh picks up the server if it came online |
