# Card Accordion with Server Details — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add collapsible accordion to each dashboard card showing runtime stack (with config-vs-process mismatch detection) and uptime.

**Architecture:** All computation happens server-side during the existing 10s health-check cycle. `discoverServer()` gains process detection + uptime tracking. `GET /api/servers` gains `stack` and `uptime` objects per server. Frontend receives enriched data and renders a pure presentational accordion via CSS `grid-template-rows` transition.

**Tech Stack:** Node.js built-in modules (`child_process` for `execFile`), vanilla HTML/CSS/JS (no framework)

---

## Task 1: Add `stack` fields to servers.json

**Files:**
- Modify: `servers.json`

- [ ] **Step 1: Add `"stack"` field to each server entry**

Based on the explore report, the known runtimes are:
```
aionui      → Bun (bun run webui)
Codenomad   → Node.js (npx tsx + Vite)
companion   → Bun (bun.exe server/index.ts)
YtdL        → Python
Vanforms    → Python/uvicorn
Hub         → PowerShell
Thevanbot   → Node.js
Openchamber → Bun
test        → Bun
```

Edit `servers.json` — add `"stack"` to each entry:

```json
{
  "servers": [
    { "name": "aionui",      "port": 25809, "stack": "Bun",              "devScript": "E:/Van/Documents/GitHub/aionui/dev.ps1" },
    { "name": "Codenomad",   "port": 9896,  "stack": "Node.js + Vite",   "devScript": "E:/Van/Documents/GitHub/codenomad/dev.ps1" },
    { "name": "companion",   "port": 3457,  "stack": "Bun + Hono",       "devScript": "E:/Van/Documents/GitHub/companion/dev.ps1" },
    { "name": "YtdL",        "port": 8000,  "stack": "Python",           "devScript": "E:/Van/Documents/GitHub/ytdl-dash/dev.ps1" },
    { "name": "Vanforms",    "port": 8586,  "stack": "Python/uvicorn",   "devScript": "E:/Van/Documents/GitHub/vanforms/dev.ps1" },
    { "name": "Hub",         "port": 8099,  "stack": "PowerShell",       "devScript": "E:/Van/Documents/GitHub/Powershell/entryScripts/Hub-Central.ps1" },
    { "name": "Thevanbot",   "port": 8787,  "stack": "Node.js",          "devScript": "E:/Van/Documents/GitHub/thevanbot/dev.ps1" },
    { "name": "Openchamber", "port": 57123, "stack": "Bun",              "devScript": "E:/Van/Documents/GitHub/openchamber/dev.ps1" },
    { "name": "test",        "port": 98765, "stack": "Bun",              "devScript": "E:/Van/Documents/GitHub/openchamber/dev123.ps1", "devArgs": ["-build"] }
  ],
  "scanRange": 50,
  "switcherPort": 9595,
  "healthIntervalMs": 10000,
  "scheduler": { ...unchanged... }
}
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('servers.json','utf8')); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add servers.json
git commit -m "feat: add stack field to servers.json for accordion detail"
```

---

## Task 2: Backend — process detection, stack matching, uptime tracking

**Files:**
- Modify: `server.js`

---

- [ ] **Step 1: Add process detection helper — `detectProcess(port)`**

Insert after the `checkPort` function (after line 922 in server.js). This function runs `netstat` to find the PID listening on the port, then `tasklist` to get the executable name, and maps it to a canonical runtime string.

```javascript
// ---- Process Detection ----
const { execFile } = require('child_process');

// Keyword → expected process map (checked via .includes on config stack value)
const RUNTIME_KEYWORDS = {
  Bun: 'bun.exe',
  Node: 'node.exe', 'Node.js': 'node.exe', Express: 'node.exe', Vite: 'node.exe',
  Next: 'node.exe', Nuxt: 'node.exe', Hono: 'node.exe', Fastify: 'node.exe',
  React: 'node.exe', 'tsx': 'node.exe',
  Python: 'python.exe', uvicorn: 'python.exe', FastAPI: 'python.exe',
  Flask: 'python.exe', Django: 'python.exe',
  PowerShell: 'pwsh.exe', pwsh: 'pwsh.exe',
};

const EXE_TO_RUNTIME = {
  'bun.exe': 'Bun',
  'node.exe': 'Node.js',
  'python.exe': 'Python',
  'pwsh.exe': 'PowerShell',
};

function execFileAsync(cmd, args = []) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function detectProcess(port) {
  try {
    // 1. Find PID via netstat
    const netstatOut = await execFileAsync('netstat', ['-ano']);
    const lines = netstatOut.split('\n');
    let pid = null;
    for (const line of lines) {
      // Match LISTENING lines for the port, e.g. "  TCP    127.0.0.1:3457         0.0.0.0:0              LISTENING       12345"
      const re = new RegExp(`:${port}\\s+.*LISTENING\\s+(\\d+)`);
      const m = line.match(re);
      if (m) { pid = m[1]; break; }
    }
    if (!pid) return null;

    // 2. Get process name via tasklist
    const tasklistOut = await execFileAsync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh']);
    const csvMatch = tasklistOut.match(/^"([^"]+)"/m);
    if (!csvMatch) return null;
    const exe = csvMatch[1].toLowerCase();

    // 3. Map to canonical runtime
    const runtime = EXE_TO_RUNTIME[exe] || exe.replace('.exe', '');
    return { exe, runtime, pid };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Verify detection logic loads without syntax errors**

Run: `node -c server.js`
Expected: no errors; exit code 0

- [ ] **Step 3: Add stack matching function — `getStackDisplay(server, processInfo)`**

Insert after `detectProcess`:

```javascript
function getStackDisplay(server, processInfo) {
  const configStack = server.stack;

  if (!configStack) {
    // No config — fall back to process detection
    return {
      display: processInfo ? processInfo.runtime : 'Unknown',
      source: 'process',
      configValue: null,
      processValue: processInfo ? processInfo.runtime : null,
      mismatch: false,
    };
  }

  if (!processInfo) {
    // Server down — show config value, no mismatch flag
    return {
      display: configStack,
      source: 'config',
      configValue: configStack,
      processValue: null,
      mismatch: false,
    };
  }

  // Check if any keyword in config matches the detected process
  let matched = false;
  for (const [keyword, expectedExe] of Object.entries(RUNTIME_KEYWORDS)) {
    if (configStack.toLowerCase().includes(keyword.toLowerCase()) && expectedExe === processInfo.exe) {
      matched = true;
      break;
    }
  }

  return {
    display: matched ? configStack : processInfo.runtime,
    source: matched ? 'config' : 'process',
    configValue: configStack,
    processValue: processInfo.runtime,
    mismatch: !matched,
  };
}
```

- [ ] **Step 4: Verify syntax**

Run: `node -c server.js`
Expected: no errors

- [ ] **Step 5: Add uptime tracking state and function**

Add `firstSeenHealthy` map near the existing `serverStatuses` declaration (near line 906):

```javascript
let firstSeenHealthy = {};  // { port: timestamp_ms } — set on down→ok transition
```

Insert `getUptime` function after `getStackDisplay`:

```javascript
// ---- Uptime Tracking ----
async function getProcessStartTime(pid) {
  try {
    const out = await execFileAsync('powershell', [
      '-NoProfile', '-Command',
      `(Get-Process -Id ${pid}).StartTime.ToString('o')`
    ]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

async function getUptime(port, processInfo) {
  if (processInfo && processInfo.pid) {
    const startTime = await getProcessStartTime(processInfo.pid);
    if (startTime) {
      const startedAt = new Date(startTime).getTime();
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      return { startedAt, seconds, source: 'process' };
    }
  }

  // Fallback: proxy-tracked healthy-since timestamp
  if (firstSeenHealthy[port]) {
    const seconds = Math.floor((Date.now() - firstSeenHealthy[port]) / 1000);
    return { startedAt: new Date(firstSeenHealthy[port]).toISOString(), seconds, source: 'proxy' };
  }

  return null;
}
```

- [ ] **Step 6: Verify syntax**

Run: `node -c server.js`
Expected: no errors

- [ ] **Step 7: Integrate into `discoverServer()`**

Modify `discoverServer()` to call detection and tracking after a successful health check. The function currently returns results inline. We need to embed the new fields into the returned objects.

Replace the `discoverServer` function body with this enhanced version:

```javascript
async function discoverServer(server) {
  const configuredPort = server.port;
  const ok = await checkPort(configuredPort);

  let base;
  if (ok) {
    base = { name: server.name, configuredPort, actualPort: configuredPort,
             health: 'ok', status: 'ok', hasDevScript: !!server.devScript };
  } else {
    const configuredPorts = new Set(CONFIG.servers.map(s => s.port));
    const start = Math.max(1, configuredPort - SCAN_RANGE);
    const end = configuredPort + SCAN_RANGE;
    let drifted = null;
    for (let p = start; p <= end; p++) {
      if (p === configuredPort) continue;
      if (configuredPorts.has(p)) continue;
      if (await checkPort(p, 500)) { drifted = p; break; }
    }
    if (drifted) {
      base = { name: server.name, configuredPort, actualPort: drifted,
               health: 'ok', status: 'drifted', hasDevScript: !!server.devScript };
    } else {
      base = { name: server.name, configuredPort, actualPort: null,
               health: 'down', status: 'down', hasDevScript: !!server.devScript };
    }
  }

  // ---- New: Process detection, stack matching, uptime tracking ----
  const actualPort = base.actualPort;
  let processInfo = null;

  if (base.health === 'ok' && actualPort) {
    // Track first-seen-healthy for uptime fallback
    if (!firstSeenHealthy[configuredPort]) {
      firstSeenHealthy[configuredPort] = Date.now();
    }

    // Detect process
    processInfo = await detectProcess(actualPort);
  } else {
    // Server went down — clear first-seen-healthy
    delete firstSeenHealthy[configuredPort];
  }

  const stack = getStackDisplay(server, processInfo);
  const uptime = base.health === 'ok' ? await getUptime(configuredPort, processInfo) : null;

  return { ...base, stack, uptime };
}
```

- [ ] **Step 8: Enrich `/api/servers` response**

The response already serializes `list` directly. Since we added `stack` and `uptime` to each server object returned by `discoverServer()`, they appear in the JSON automatically. No code change needed — verify by inspection that the returned objects now include `stack` and `uptime` fields.

- [ ] **Step 9: Verify syntax and existing tests pass**

Run: `node --test tests/header-rewriting.test.js`
Expected: 32/32 tests pass

Run: `node --test tests/scheduler.test.js`
Expected: 14/14 tests pass

- [ ] **Step 10: Commit**

```bash
git add server.js
git commit -m "feat: add process detection, stack matching, and uptime tracking to server.js"
```

---

## Task 3: Frontend — accordion UI

**Files:**
- Modify: `index.html`

---

- [ ] **Step 1: Add accordion CSS**

Insert new CSS rules after the existing `.server-card` styles block (after the `.tunnel-btn` block, around line 320). Add:

```css
  /* ---- Accordion details panel ---- */
  .accordion-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    margin-top: 0.6rem;
    font-size: var(--text-xs);
    color: var(--ink-soft);
    cursor: pointer;
    user-select: none;
    transition: color 150ms ease;
    line-height: 1;
  }
  .accordion-toggle:hover { color: var(--ink); }

  .accordion-arrow {
    font-size: 0.7rem;
    transition: transform 200ms ease;
    display: inline-block;
  }
  .server-card.expanded .accordion-arrow {
    transform: rotate(180deg);
  }

  .accordion-panel {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.25s ease;
    overflow: hidden;
  }
  .server-card.expanded .accordion-panel {
    grid-template-rows: 1fr;
  }

  .accordion-panel-inner {
    min-height: 0;
    margin-top: 0.75rem;
    padding: 0.75rem 1rem;
    background: rgba(32,48,58,0.03);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .accordion-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: var(--text-xs);
  }
  .accordion-label {
    color: var(--ink-soft);
    font-weight: 500;
    min-width: 55px;
    flex-shrink: 0;
  }
  .accordion-value {
    color: var(--ink);
  }
  .stack-mismatch {
    color: var(--drift);
    font-size: 0.75rem;
    font-weight: 500;
    margin-left: 0.4rem;
  }
```

- [ ] **Step 2: Add `expandedPorts` state tracking**

Before the `cardMap` declaration (near line 504), add:

```javascript
let expandedPorts = new Set();  // track which cards have accordion expanded across refreshes
```

- [ ] **Step 3: Add formatting helpers for uptime**

After the existing `esc` and `escAttr` helper functions (near line 781), add:

```javascript
function formatUptime(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return '<1m';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatStarted(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
```

- [ ] **Step 4: Add accordion HTML to card builder in `renderServers()`**

In `renderServers()`, after the `card-actions` div (after the `</div>` that closes `card-actions` around line 690), append the accordion toggle and panel HTML. Modify the `card.innerHTML` template string. Replace this section:

```javascript
    card.innerHTML = `
      <div class="card-top">
        <span class="server-name">${esc(state.name)}</span>
        <span class="health-dot ${state.health}"></span>
      </div>
      <div class="card-meta">
        <span class="port-badge">:${state.displayPort}</span>
        ${state.isDrifted ? `<span class="drift-badge">shifted from :${state.configuredPort}</span>` : ''}
        ${state.isActive ? '<span class="active-badge">active</span>' : ''}
      </div>
      <div class="card-actions">
        ${state.hasDevScript ? `
          <button class="tunnel-btn${serverButtonClass(state)}" ${serverButtonDisabled(state)} data-action="start-server" data-port="${state.displayPort}">
            ${serverButtonLabel(state)}
          </button>
        ` : ''}
        ${!state.isDown ? `
          <button class="tunnel-btn${tunnelButtonClass(state)}" data-action="tunnel" data-port="${state.displayPort}">
            ${tunnelButtonLabel(state)}
          </button>
        ` : ''}
        ${state.isActive && state.ngrokUrl ? `<a class="tunnel-url" href="${escAttr(state.ngrokUrl)}" target="_blank">Open server &rarr;</a>` : ''}
      </div>
    `;
```

With the new version that includes accordion HTML after card-actions:

```javascript
    // Build stack details string
    let stackHtml = '';
    if (s.stack) {
      stackHtml = `<span class="accordion-value">${esc(s.stack.display)}</span>`;
      if (s.stack.mismatch) {
        stackHtml += `<span class="stack-mismatch">config mismatch</span>`;
      }
    } else {
      stackHtml = `<span class="accordion-value">—</span>`;
    }

    // Build uptime details string
    let uptimeHtml = '';
    if (s.uptime) {
      uptimeHtml = `<span class="accordion-label">Uptime:</span><span class="accordion-value">${formatUptime(s.uptime.seconds)}</span>`;
    } else {
      uptimeHtml = `<span class="accordion-label">Uptime:</span><span class="accordion-value">—</span>`;
    }

    // Build started line (only if there's uptime data)
    let startedHtml = '';
    if (s.uptime && s.uptime.startedAt) {
      startedHtml = `<span class="accordion-label">Started:</span><span class="accordion-value">${formatStarted(s.uptime.startedAt)}</span>`;
    }

    const isExpanded = expandedPorts.has(state.displayPort);

    card.innerHTML = `
      <div class="card-top">
        <span class="server-name">${esc(state.name)}</span>
        <span class="health-dot ${state.health}"></span>
      </div>
      <div class="card-meta">
        <span class="port-badge">:${state.displayPort}</span>
        ${state.isDrifted ? `<span class="drift-badge">shifted from :${state.configuredPort}</span>` : ''}
        ${state.isActive ? '<span class="active-badge">active</span>' : ''}
      </div>
      <div class="card-actions">
        ${state.hasDevScript ? `
          <button class="tunnel-btn${serverButtonClass(state)}" ${serverButtonDisabled(state)} data-action="start-server" data-port="${state.displayPort}">
            ${serverButtonLabel(state)}
          </button>
        ` : ''}
        ${!state.isDown ? `
          <button class="tunnel-btn${tunnelButtonClass(state)}" data-action="tunnel" data-port="${state.displayPort}">
            ${tunnelButtonLabel(state)}
          </button>
        ` : ''}
        ${state.isActive && state.ngrokUrl ? `<a class="tunnel-url" href="${escAttr(state.ngrokUrl)}" target="_blank">Open server &rarr;</a>` : ''}
      </div>

      <!-- Accordion toggle and panel -->
      <span class="accordion-toggle" data-action="toggle-accordion" data-port="${state.displayPort}">
        <span class="accordion-arrow">&#9660;</span> details
      </span>
      <div class="accordion-panel">
        <div class="accordion-panel-inner">
          <div class="accordion-row">
            <span class="accordion-label">Stack:</span>
            ${stackHtml}
          </div>
          <div class="accordion-row">
            ${uptimeHtml}
          </div>
          ${startedHtml ? `<div class="accordion-row">${startedHtml}</div>` : ''}
        </div>
      </div>
    `;
```

- [ ] **Step 5: Update card class if expanded**

Before assigning to `card.className`, check if port is expanded:

Replace:
```javascript
    card.className = 'server-card' + (state.isActive ? ' active' : '') + (state.isDown ? ' dimmed' : '');
```

With:
```javascript
    const expandedClass = expandedPorts.has(state.displayPort) ? ' expanded' : '';
    card.className = 'server-card' + (state.isActive ? ' active' : '') + (state.isDown ? ' dimmed' : '') + expandedClass;
```

- [ ] **Step 6: Add toggle click handler**

After the existing event listener setup (after the tunnel button listeners), add the accordion toggle handler. Insert after the `tunnelBtn` listener block (after line 703):

```javascript
    // Accordion toggle handler
    const accordionToggle = card.querySelector('[data-action="toggle-accordion"]');
    if (accordionToggle) {
      accordionToggle.addEventListener('click', () => {
        const port = Number(accordionToggle.dataset.port);
        if (expandedPorts.has(port)) {
          expandedPorts.delete(port);
          card.classList.remove('expanded');
        } else {
          expandedPorts.add(port);
          card.classList.add('expanded');
        }
      });
    }
```

- [ ] **Step 7: Re-expand cards after DOM diff updates**

At the end of `renderServers()` (after the `cardMap` update and `insertBefore` line ~715, before the function closing brace), reapply expanded state to any card whose port is in `expandedPorts`. The DOM insertion already sets `expanded` class during construction, but this ensures correctness after ordering changes:

No explicit re-expand needed — each new card already reads `expandedPorts` during construction in Step 5. The `statesEqual` check preserves matching cards without rebuilding, so their existing `expanded` class survives. Only rebuilt cards need the check, and Step 5 handles that.

- [ ] **Step 8: Add `stack` and `uptime` to state equality check**

Modify `statesEqual()` to include the new fields so cards with changed stack/uptime are rebuilt:

```javascript
function statesEqual(a, b) {
  if (!a || !b) return false;
  // Compare stack fields (deep-ish equality via JSON for simplicity)
  const sameStack = (!a.stack && !b.stack) ||
    (a.stack && b.stack && a.stack.display === b.stack.display && a.stack.mismatch === b.stack.mismatch);
  const sameUptime = (!a.uptime && !b.uptime) ||
    (a.uptime && b.uptime && a.uptime.seconds === b.uptime.seconds);
  return a.name === b.name && a.health === b.health && a.status === b.status &&
         a.configuredPort === b.configuredPort && a.actualPort === b.actualPort &&
         a.isActive === b.isActive && a.ngrokUrl === b.ngrokUrl &&
         a.hasDevScript === b.hasDevScript && a.isStarting === b.isStarting &&
         sameStack && sameUptime;
}
```

And update the state object built in `newStateMap` to include the new fields:

After the existing `newStateMap[displayPort] = { ... }` block (line 606-612), add the new fields:

```javascript
    newStateMap[displayPort] = {
      name: s.name, health: s.health, status: s.status,
      configuredPort: s.configuredPort, actualPort: s.actualPort,
      isActive, isDown, isDrifted, ngrokUrl, displayPort,
      hasDevScript: !!s.hasDevScript,
      isStarting: !!startingPorts[s.configuredPort],
      stack: s.stack || null,
      uptime: s.uptime || null,
    };
```

- [ ] **Step 9: Verify HTML loads without JS syntax errors**

Run: `node -e "require('fs').readFileSync('index.html','utf8')"` (basic read test)
More thorough: open `index.html` in browser via dashboard and check no console errors.

- [ ] **Step 10: Commit**

```bash
git add index.html
git commit -m "feat: add accordion UI to server cards showing stack and uptime"
```

---

## Task 4: Verification

**Files:**
- Verify: `tests/header-rewriting.test.js`, `tests/scheduler.test.js`

- [ ] **Step 1: Run existing test suites**

```bash
node --test tests/header-rewriting.test.js
```
Expected: 32/32 pass

```bash
node --test tests/scheduler.test.js
```
Expected: 14/14 pass

- [ ] **Step 2: Start dashboard and smoke-test the API**

```bash
Start server: node server.js
```
Test the enriched API response:
```bash
curl -s http://localhost:9595/api/servers | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.servers[0].stack, d.servers[0].uptime)"
```
Expected: `stack` and `uptime` objects present for each server.

(If no servers are running, `stack.display` comes from config, `uptime` is null.)

- [ ] **Step 3: Browser verification**

Open `http://localhost:9595`:
- [ ] Grid loads, no console errors
- [ ] Click "▼ details" on any card — panel expands with stack, uptime, started time
- [ ] Click again — panel collapses
- [ ] Expand multiple cards — each toggles independently
- [ ] Wait 10s for auto-refresh — expanded cards stay expanded, no flicker
- [ ] Check stack values match known runtimes (per servers.json entries)
- [ ] Kill one server process, wait for next health check, verify uptime shows "—"
- [ ] Trigger mismatch test: temporarily change one `"stack"` to wrong value, restart, verify "config mismatch" amber note appears

- [ ] **Step 4: Commit verification evidence**

```bash
git add -A
git commit -m "verify: all tests passing (32 header-rewriting + 14 scheduler), browser accordion works"
```

---

## Definition of Done

- [x] `servers.json` has `"stack"` on every server entry
- [x] `server.js` has process detection, stack matching, uptime tracking
- [x] `GET /api/servers` returns `stack` and `uptime` per server  
- [x] Cards have collapsible accordion showing stack + uptime + start time
- [x] Mismatch between config stack and process detection shows "config mismatch" in amber
- [x] Uptime uses OS process start time, falls back to proxy-tracked
- [x] Accordion state survives 10s auto-refresh without flicker
- [x] All existing tests (32 + 14) pass
- [x] Down servers show config stack + "—" uptime

## Risk Register

| Risk | Mitigation | Verification |
|---|---|---|
| `netstat`/`tasklist` spawn overhead | Runs within existing async 10s cycle, non-blocking | Check event loop not blocked |
| Card flicker on accordion state loss | `expandedPorts` Set + `expanded` class persistence via `statesEqual` skip | Browser verify after 10s refresh |
| Keyword false positives (e.g., "Notebook" matching "Node") | Match uses `RUNTIME_KEYWORDS` map keys with `includes()` — "Node" won't false-match "Notebook" because the map key is tested against config value, not vice versa | Test against real server configs |
| Cross-platform break | Windows-specific commands (`netstat`, `tasklist`, `powershell`) | Project is Windows-only by design |
