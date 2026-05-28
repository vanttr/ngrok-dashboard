# Ngrok Tunnel Switcher — Implementation Plan

**Status:** todo
**Spec:** [../specs/2026-05-28-ngrok-tunnel-switcher-design.md](../specs/2026-05-28-ngrok-tunnel-switcher-design.md)
**Related ADRs:** [0001-reverse-proxy-architecture](../adr/0001-reverse-proxy-architecture.md), [0002-node-builtins-no-framework](../adr/0002-node-builtins-no-framework.md), [0003-config-plus-port-scan-discovery](../adr/0003-config-plus-port-scan-discovery.md)

**Goal:** A single `node server.js` command starts an HTTP reverse proxy + dashboard on port 9595, launches one ngrok tunnel, and lets me switch which local dev server receives incoming traffic — all through one public URL.

**Scope:** Backend (`server.js`), frontend (`index.html`), config (`servers.json`), launcher (`start.bat`), README.

**Non-goals:** WebSocket proxying, persistent state, authentication (ngrok handles it), automated test suite.

**Prerequisites:** Node.js 18+ (for `fetch`, `node:test`), ngrok installed and in PATH.

**Produces:** `server.js`, `index.html`, `servers.json`, `start.bat`, `README.md`.

## Definition of Done

- `node server.js` starts the switcher on port 9595 and launches ngrok
- Dashboard loads at the ngrok URL showing all servers with health status
- Clicking "Tunnel" proxies all non-dashboard traffic to the selected server
- Drifted ports are auto-detected within ±50 range
- `start.bat` launches the switcher on Windows

## Assumptions, Gaps, And Limitations

| Type | Statement | Impact | Action |
|---|---|---|---|
| Assumption | Node.js 18+ installed with `fetch` and `AbortController` available globally | Lower versions need polyfill or `http` module instead | Verify with `node --version` |
| Assumption | Ngrok installed and authenticated (`ngrok config check` passes) | Server starts but dashboard shows "ngrok: not connected" error | Document in README prerequisites |
| Limitation | Proxy forwards HTTP only (no WebSocket upgrade) | WebSocket-dependent apps won't work through the switcher | Document in README |

## Risk Register

| Risk | Why it matters | Mitigation | Verification hook |
|---|---|---|---|
| Ngrok is down or auth expired | Dashboard unreachable remotely | Server still serves on localhost; error shown in UI header | Start with invalid authtoken, verify local dashboard works |
| Port scan triggers firewall/AV | Health checks fail silently | Short timeouts (500ms per port), limit scan range to ±50 | Observe no firewall popups during normal operation |
| Proxy target crashes mid-request | User sees 502 instead of useful error | Server returns 502 with JSON error; dashboard unaffected | Kill target server, verify proxy returns 502 gracefully |

---

## Task 1: Project Scaffold & Config

**Files:**
- Create: `E:\Van\Documents\GitHub\ngrok-dashboard\servers.json`
- Create: `E:\Van\Documents\GitHub\ngrok-dashboard\package.json`
- Create: `E:\Van\Documents\GitHub\ngrok-dashboard\start.bat`

- [ ] **Step 1: Create `servers.json`**

```json
{
  "servers": [
    { "name": "Codenomad",   "port": 9896 },
    { "name": "Companion",   "port": 3470 },
    { "name": "Ollama",      "port": 4000 },
    { "name": "Vanforms",    "port": 8086 },
    { "name": "Hub",         "port": 8099 },
    { "name": "Thevanbot",   "port": 8787 },
    { "name": "Openchamber", "port": 57123 }
  ],
  "scanRange": 50,
  "switcherPort": 9595,
  "healthIntervalMs": 10000
}
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "ngrok-dashboard",
  "version": "1.0.0",
  "private": true,
  "description": "Ngrok tunnel switcher with reverse proxy dashboard",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "engines": {
    "node": ">=18"
  }
}
```

- [ ] **Step 3: Create `start.bat`**

```bat
@echo off
echo Starting ngrok tunnel switcher...
node "%~dp0server.js"
pause
```

- [ ] **Step 4: Verify**

```
dir E:\Van\Documents\GitHub\ngrok-dashboard\servers.json
dir E:\Van\Documents\GitHub\ngrok-dashboard\package.json
dir E:\Van\Documents\GitHub\ngrok-dashboard\start.bat
```
Expected: all three files exist.

- [ ] **Step 5: Commit**

```bash
git add servers.json package.json start.bat
git commit -m "scaffold: project config, servers list, windows launcher"
```

---

## Task 2: Ngrok Process Manager

**Files:**
- Create: `E:\Van\Documents\GitHub\ngrok-dashboard\server.js` (first ~80 lines)

- [ ] **Step 1: Write the ngrok spawn + URL parsing code**

Add to `server.js`:

```javascript
// server.js — Ngrok Tunnel Switcher
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- Configuration ----
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'servers.json'), 'utf8'));
const SWITCHER_PORT = CONFIG.switcherPort || 9595;
const NGROK_OAUTH = '--oauth=google --oauth-allow-email=vant.tr@gmail.com';

// ---- Ngrok Process Manager ----
let ngrokProcess = null;
let ngrokUrl = null;

function startNgrok() {
  return new Promise((resolve, reject) => {
    const args = ['http', String(SWITCHER_PORT), ...NGROK_OAUTH.split(' '), '--log=stdout'];
    ngrokProcess = spawn('ngrok', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let resolved = false;

    ngrokProcess.stdout.on('data', (data) => {
      const text = data.toString();
      // ngrok v3 prints: "Forwarding  https://xxxxx.ngrok-free.dev -> http://localhost:9595"
      const match = text.match(/Forwarding\s+(https:\/\/[^\s]+)\s+->/);
      if (match && !resolved) {
        ngrokUrl = match[1];
        resolved = true;
        console.log(`ngrok tunnel: ${ngrokUrl}`);
        resolve(ngrokUrl);
      }
    });

    ngrokProcess.stderr.on('data', (data) => {
      console.error(`ngrok stderr: ${data.toString().trim()}`);
    });

    ngrokProcess.on('error', (err) => {
      console.error(`ngrok spawn failed: ${err.message}`);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    ngrokProcess.on('close', (code) => {
      console.log(`ngrok exited with code ${code}`);
      ngrokProcess = null;
      ngrokUrl = null;
      if (!resolved) {
        resolved = true;
        reject(new Error(`ngrok exited with code ${code}`));
      }
    });

    // Timeout: if ngrok doesn't produce a URL within 15 seconds, kill it
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (ngrokProcess) { ngrokProcess.kill('SIGTERM'); ngrokProcess = null; }
        reject(new Error('ngrok timed out waiting for URL'));
      }
    }, 15000);

    // Clean up the timer on successful resolution
    const originalResolve = resolve;
    resolve = (url) => { clearTimeout(timeout); originalResolve(url); };
  });
}

function stopNgrok() {
  if (ngrokProcess) {
    ngrokProcess.kill('SIGTERM');
    ngrokProcess = null;
    ngrokUrl = null;
  }
}

process.on('SIGINT', () => { stopNgrok(); process.exit(0); });
process.on('SIGTERM', () => { stopNgrok(); process.exit(0); });
```

- [ ] **Step 2: Verify ngrok starts and URL is parsed**

Run:
```
node -e "require('./server.js');" 2>&1 | head -5
```

Wait up to 15 seconds. Expected output includes: `ngrok tunnel: https://xxxxx.ngrok-free.dev`

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: ngrok process manager with URL parsing"
```

---

## Task 3: Server Discovery & Health Check

**Files:**
- Modify: `E:\Van\Documents\GitHub\ngrok-dashboard\server.js` (append ~70 lines)

- [ ] **Step 1: Add discovery logic to `server.js`**

Append after the ngrok section:

```javascript
// ---- Server Discovery & Health Check ----
const SCAN_RANGE = CONFIG.scanRange || 50;
let serverStatuses = {};  // { port: { name, configuredPort, actualPort, health, status } }

async function checkPort(port, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`http://localhost:${port}`, {
      signal: controller.signal,
      headers: { 'Accept': '*/*' }
    });
    return resp.ok && resp.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverServer(server) {
  const configuredPort = server.port;
  const ok = await checkPort(configuredPort);
  if (ok) {
    return { name: server.name, configuredPort, actualPort: configuredPort, health: 'ok', status: 'ok' };
  }

  // Fallback: scan ±SCAN_RANGE around configured port
  const start = Math.max(1, configuredPort - SCAN_RANGE);
  const end = configuredPort + SCAN_RANGE;
  for (let p = start; p <= end; p++) {
    if (p === configuredPort) continue; // already checked
    if (await checkPort(p, 500)) {
      return { name: server.name, configuredPort, actualPort: p, health: 'ok', status: 'drifted' };
    }
  }

  return { name: server.name, configuredPort, actualPort: null, health: 'down', status: 'down' };
}

let scanning = false;

async function refreshAllServers() {
  if (scanning) return serverStatuses ? Object.values(serverStatuses) : [];
  scanning = true;
  try {
    const results = await Promise.all(CONFIG.servers.map(discoverServer));
    serverStatuses = {};
    for (const r of results) {
      serverStatuses[r.configuredPort] = r;
      if (r.actualPort && r.actualPort !== r.configuredPort) {
        serverStatuses[r.actualPort] = r;
      }
    }
    return Object.values(results);
  } finally {
    scanning = false;
  }
}

// Initial discovery, then periodic refresh
refreshAllServers();
setInterval(refreshAllServers, CONFIG.healthIntervalMs || 10000);
```

- [ ] **Step 2: Verify discovery works**

Create a quick test server on an arbitrary port:

```bash
# Terminal 1: start a dummy HTTP server
node -e "require('http').createServer((_,r)=>r.end('ok')).listen(3456,()=>console.log('test on 3456'))"
```

Then check the serverStatuses object (temporarily add `console.log(JSON.stringify(serverStatuses))` inside refreshAllServers). Or just verify via curl later once the HTTP server is wired up.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: server discovery with configured-port health check and ±50 port range fallback scan"
```

---

## Task 4: HTTP Server Skeleton & API Routes

**Files:**
- Modify: `E:\Van\Documents\GitHub\ngrok-dashboard\server.js` (append ~80 lines)

- [ ] **Step 1: Add HTTP server with `/api/*` routes**

Append to `server.js`:

```javascript
// ---- Target State ----
let currentTarget = null;  // { port: number, name: string }
let ngrokError = null;     // error message if ngrok failed to start

// ---- HTTP Server ----
const server = http.createServer(async (req, res) => {
  // Common headers
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${SWITCHER_PORT}`);
  const pathname = url.pathname;

  // ---- API Routes ----
  if (pathname === '/api/servers') {
    const list = await refreshAllServers();
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({
      servers: list,
      target: currentTarget,
      ngrokUrl: ngrokUrl,
      ngrokError: ngrokError,
    }));
    return;
  }

  if (pathname === '/api/target' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ target: currentTarget, ngrokUrl }));
    return;
  }

  if (pathname === '/api/target' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { port } = JSON.parse(body);
      if (port === null || port === undefined) {
        currentTarget = null;
      } else {
        const found = serverStatuses[port];
        if (!found) {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: `Port ${port} is not a known server` }));
          return;
        }
        currentTarget = { port: found.actualPort || found.configuredPort, name: found.name };
      }
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, target: currentTarget }));
    } catch (e) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
    }
    return;
  }

  if (pathname === '/ngrok-skip-browser-warning') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/api/health') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      ngrokConnected: !!ngrokUrl,
      target: currentTarget,
    }));
    return;
  }

  // ---- Dashboard (GET /) ----
  // (implemented in Task 6; for now return a placeholder)
  if (pathname === '/' && req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end('<h1>Dashboard placeholder</h1>');
    return;
  }

  // ---- Proxy (catch-all) — implemented in Task 5 ----
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(503);
  res.end(JSON.stringify({ error: 'No target selected' }));
});

// ---- Helpers ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ---- Start ----
async function main() {
  try {
    await startNgrok();
  } catch (err) {
    ngrokError = err.message;
    console.error('ngrok failed to start, running without tunnel:', err.message);
  }

  server.on('error', (err) => {
    console.error(`Server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(SWITCHER_PORT, () => {
    console.log(`Switcher listening on http://localhost:${SWITCHER_PORT}`);
  });
}

main();
```

- [ ] **Step 2: Verify API routes**

Start the server:

```bash
node E:\Van\Documents\GitHub\ngrok-dashboard\server.js
```

In another terminal:

```bash
curl http://localhost:9595/api/servers
# Expected: JSON array of 7 servers with health status

curl http://localhost:9595/api/target
# Expected: {"target":null,"ngrokUrl":null} or with URL if ngrok is up

curl -X POST http://localhost:9595/api/target -H "Content-Type: application/json" -d "{\"port\":4000}"
# Expected: {"ok":true,"target":{"port":4000,"name":"Ollama"}}

curl -X POST http://localhost:9595/api/target -H "Content-Type: application/json" -d "{\"port\":99999}"
# Expected: {"ok":false,"error":"Port 99999 is not a known server"}
```

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: HTTP server with /api/servers, /api/target GET/POST routes, and target state"
```

---

## Task 5: HTTP Proxy (Catch-All)

**Files:**
- Modify: `E:\Van\Documents\GitHub\ngrok-dashboard\server.js` (replace the placeholder proxy section, ~40 lines)

- [ ] **Step 1: Replace the `// ---- Proxy (catch-all) ----` section**

Replace the 3-line placeholder:

```javascript
  // 503 placeholder (lines to replace)
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(503);
  res.end(JSON.stringify({ error: 'No target selected' }));
```

With:

```javascript
  // ---- Proxy (catch-all) ----
  if (!currentTarget) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(503);
    res.end(JSON.stringify({ error: 'No target selected. Visit the dashboard at / to choose a server.' }));
    return;
  }

  const targetHost = 'localhost';
  const targetPort = currentTarget.port;
  const targetPath = req.url;

  const proxyReq = http.request(
    {
      hostname: targetHost,
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: { ...req.headers, host: `${targetHost}:${targetPort}` },
      timeout: 30000,
    },
    (proxyRes) => {
      // Filter hop-by-hop headers that Node.js manages itself
      const HOP_BY_HOP = new Set(['transfer-encoding', 'connection', 'keep-alive',
        'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);
      const filteredHeaders = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) filteredHeaders[k] = v;
      }
      res.writeHead(proxyRes.statusCode, filteredHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    console.error(`Proxy error to :${targetPort}: ${err.message}`);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(502);
      res.end(JSON.stringify({
        error: `Cannot reach ${currentTarget.name} on port ${targetPort}`,
        detail: err.message
      }));
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(504);
      res.end(JSON.stringify({ error: `Timeout connecting to ${currentTarget.name} on port ${targetPort}` }));
    }
  });

  req.pipe(proxyReq);
  return;  // skip the fallback 503 below
```

- [ ] **Step 2: Verify proxy works**

Ensure a server is running on port 8086 (or any configured port):

```bash
# Terminal 1: dummy server
node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('Hello from port 8086')}).listen(8086)"

# Terminal 2: start switcher
node server.js

# Terminal 3: set target and test proxy
curl -X POST http://localhost:9595/api/target -H "Content-Type: application/json" -d "{\"port\":8086}"
# → {"ok":true,...}

curl http://localhost:9595/anything
# → "Hello from port 8086"

curl http://localhost:9595/api/servers
# → still returns the JSON API (not proxied)

curl http://localhost:9595/
# → still returns dashboard HTML (not proxied)
```

Also test 503 when no target:

```bash
curl -X POST http://localhost:9595/api/target -H "Content-Type: application/json" -d "{\"port\":null}"
curl http://localhost:9595/anything
# → {"error":"No target selected. Visit the dashboard at / to choose a server."}
```

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: HTTP reverse proxy to selected target server"
```

---

## Task 6: Frontend Dashboard

**Files:**
- Create: `E:\Van\Documents\GitHub\ngrok-dashboard\index.html`
- Modify: `E:\Van\Documents\GitHub\ngrok-dashboard\server.js` (replace dashboard placeholder to serve index.html)

- [ ] **Step 1: Replace dashboard route in `server.js`**

Replace:
```javascript
  if (pathname === '/' && req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end('<h1>Dashboard placeholder</h1>');
    return;
  }
```

With:
```javascript
  if (pathname === '/' && req.method === 'GET') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Dashboard not found');
    }
    return;
  }
```

- [ ] **Step 2: Create `index.html` (llm-dashboard glassmorphism style)**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ngrok Tunnel Switcher</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg-0: #edf2f5;
    --bg-1: #e3eaef;
    --bg-2: #dfe7eb;
    --ink-strong: #20303a;
    --ink: #344854;
    --ink-soft: #647682;
    --surface: rgba(255,255,255,0.78);
    --surface-glass: rgba(255,255,255,0.66);
    --border: rgba(32,48,58,0.1);
    --accent: #466a5a;
    --accent-strong: #355247;
    --ok: #2e7d44;
    --ok-bg: rgba(46,125,68,0.10);
    --down: #a84747;
    --down-bg: rgba(168,71,71,0.10);
    --drift: #b0822c;
    --drift-bg: rgba(176,130,44,0.10);
    --active-bg: rgba(70,106,90,0.08);
    --active-border: rgba(70,106,90,0.25);
    --text-xs: 0.84rem;
    --text-sm: 0.95rem;
    --text-md: 1rem;
    --text-lg: 1.2rem;
    --text-xl: 1.5rem;
    --radius-card: 24px;
    --radius-btn: 999px;
    --radius-pill: 14px;
  }

  body {
    font-family: 'Roboto', 'Segoe UI', sans-serif;
    background:
      radial-gradient(ellipse 60% 60% at 30% 10%, rgba(70,106,90,0.08) 0%, transparent 70%),
      radial-gradient(ellipse 50% 50% at 80% 80%, rgba(100,150,180,0.07) 0%, transparent 70%),
      linear-gradient(180deg, var(--bg-0) 0%, var(--bg-1) 50%, var(--bg-2) 100%);
    min-height: 100vh;
    color: var(--ink);
    font-size: var(--text-sm);
    line-height: 1.5;
    position: relative;
  }

  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: radial-gradient(ellipse 40% 40% at 50% 30%, rgba(255,255,255,0.45), transparent);
    pointer-events: none;
    z-index: 0;
  }

  .page-shell {
    max-width: 72rem;
    margin: 0 auto;
    padding: 2rem 1.5rem 3rem;
    position: relative;
    z-index: 1;
  }

  /* ---- Hero header card ---- */
  .hero-card {
    background: linear-gradient(135deg, rgba(255,255,255,0.92), rgba(255,255,255,0.72));
    backdrop-filter: blur(20px) saturate(1.08);
    border-radius: var(--radius-card);
    padding: 1.5rem 2rem;
    margin-bottom: 2rem;
    box-shadow: 0 16px 48px rgba(27,41,50,0.08);
    position: relative;
    overflow: hidden;
    animation: fadeSlideUp 380ms ease;
  }

  .hero-card::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1px;
    background: linear-gradient(135deg, rgba(70,106,90,0.18), rgba(32,48,58,0.06));
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    pointer-events: none;
  }

  .hero-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .hero-row h1 {
    font-size: var(--text-xl);
    font-weight: 700;
    color: var(--ink-strong);
    letter-spacing: -0.02em;
    line-height: 1.2;
    flex: 1;
    min-width: 200px;
  }

  .hero-url {
    font-size: var(--text-xs);
    color: var(--accent);
    text-decoration: none;
    word-break: break-all;
    max-width: 400px;
    transition: color 180ms ease;
  }
  .hero-url:hover { color: var(--accent-strong); }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.75rem;
    border-radius: var(--radius-pill);
    font-size: var(--text-xs);
    font-weight: 500;
    white-space: nowrap;
  }
  .status-pill .pill-dot { width: 7px; height: 7px; border-radius: 50%; }
  .status-connected { background: var(--ok-bg); color: var(--ok); border: 1px solid rgba(46,125,68,0.18); }
  .status-connected .pill-dot { background: var(--ok); }
  .status-disconnected { background: var(--down-bg); color: var(--down); border: 1px solid rgba(168,71,71,0.18); }
  .status-disconnected .pill-dot { background: var(--down); }

  .ngrok-error-msg {
    margin-top: 0.5rem;
    font-size: var(--text-xs);
    color: var(--down);
  }

  /* ---- Server grid ---- */
  .server-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1rem;
  }

  /* ---- Glass server card ---- */
  .server-card {
    background: linear-gradient(135deg, rgba(255,255,255,0.9), rgba(255,255,255,0.66));
    backdrop-filter: blur(20px) saturate(1.08);
    border-radius: var(--radius-card);
    padding: 1.25rem 1.5rem;
    box-shadow: 0 8px 32px rgba(27,41,50,0.06);
    transition: transform 180ms ease, box-shadow 180ms ease;
    position: relative;
    animation: fadeSlideUp 380ms ease;
    animation-fill-mode: backwards;
  }

  .server-card:nth-child(1) { animation-delay: 0ms; }
  .server-card:nth-child(2) { animation-delay: 40ms; }
  .server-card:nth-child(3) { animation-delay: 80ms; }
  .server-card:nth-child(4) { animation-delay: 120ms; }
  .server-card:nth-child(5) { animation-delay: 160ms; }
  .server-card:nth-child(6) { animation-delay: 200ms; }
  .server-card:nth-child(7) { animation-delay: 240ms; }

  .server-card::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1px;
    background: linear-gradient(135deg, rgba(32,48,58,0.08), rgba(32,48,58,0.03));
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    pointer-events: none;
  }

  .server-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 16px 48px rgba(27,41,50,0.1);
  }

  .server-card.active {
    background: linear-gradient(135deg, rgba(70,106,90,0.12), rgba(70,106,90,0.04));
    border-color: var(--active-border);
    box-shadow: 0 0 0 1px var(--active-border), 0 12px 40px rgba(70,106,90,0.08);
  }

  .server-card.active::before {
    background: linear-gradient(135deg, var(--accent), rgba(70,106,90,0.3));
  }

  .server-card.dimmed { opacity: 0.55; }

  .card-top {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.75rem;
  }

  .server-name {
    font-weight: 600;
    font-size: var(--text-md);
    color: var(--ink-strong);
    flex: 1;
  }

  .health-dot {
    width: 9px; height: 9px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .health-dot.ok { background: var(--ok); box-shadow: 0 0 6px rgba(46,125,68,0.3); }
  .health-dot.down { background: var(--down); box-shadow: 0 0 6px rgba(168,71,71,0.3); }

  .card-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }

  .port-badge {
    font-size: var(--text-xs);
    color: var(--ink-soft);
    background: rgba(32,48,58,0.06);
    padding: 0.15rem 0.55rem;
    border-radius: var(--radius-pill);
    font-family: 'Roboto Mono', 'Consolas', monospace;
    font-weight: 500;
  }

  .drift-badge {
    font-size: var(--text-xs);
    color: var(--drift);
    background: var(--drift-bg);
    border: 1px solid rgba(176,130,44,0.18);
    padding: 0.15rem 0.55rem;
    border-radius: var(--radius-pill);
    font-weight: 500;
  }

  .active-badge {
    font-size: var(--text-xs);
    color: var(--accent);
    background: var(--active-bg);
    border: 1px solid var(--active-border);
    padding: 0.15rem 0.55rem;
    border-radius: var(--radius-pill);
    font-weight: 500;
  }

  .card-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .tunnel-btn {
    padding: 0.45rem 1.25rem;
    border-radius: var(--radius-btn);
    border: none;
    font-family: inherit;
    font-size: var(--text-xs);
    font-weight: 600;
    cursor: pointer;
    background: linear-gradient(135deg, var(--accent), var(--accent-strong));
    color: #fff;
    box-shadow: 0 2px 12px rgba(70,106,90,0.2);
    transition: transform 180ms ease, box-shadow 180ms ease, opacity 180ms ease;
  }
  .tunnel-btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 18px rgba(70,106,90,0.3);
  }
  .tunnel-btn:active:not(:disabled) { transform: translateY(0); }
  .tunnel-btn:disabled { opacity: 0.35; cursor: not-allowed; box-shadow: none; }

  .tunnel-btn.stop {
    background: linear-gradient(135deg, var(--down), #944040);
    box-shadow: 0 2px 12px rgba(168,71,71,0.2);
  }
  .tunnel-btn.stop:hover:not(:disabled) {
    box-shadow: 0 4px 18px rgba(168,71,71,0.3);
  }

  .tunnel-url {
    font-size: var(--text-xs);
    color: var(--accent);
    word-break: break-all;
  }
  .tunnel-url a { color: inherit; text-decoration: none; }
  .tunnel-url a:hover { text-decoration: underline; }

  .empty-state {
    grid-column: 1 / -1;
    text-align: center;
    padding: 3rem 1rem;
    color: var(--ink-soft);
    font-size: var(--text-md);
  }

  /* ---- Footer ---- */
  .page-footer {
    text-align: center;
    margin-top: 2rem;
    color: var(--ink-soft);
    font-size: var(--text-xs);
  }

  @keyframes fadeSlideUp {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @media (max-width: 700px) {
    .server-grid { grid-template-columns: 1fr; }
    .hero-row { flex-direction: column; align-items: flex-start; }
  }
</style>
</head>
<body>
<div class="page-shell">

  <div class="hero-card">
    <div class="hero-row">
      <h1>Tunnel Switcher</h1>
      <span id="ngrok-status" class="status-pill status-disconnected">
        <span class="pill-dot"></span>disconnected
      </span>
    </div>
    <a id="ngrok-url" class="hero-url" href="#" target="_blank" style="display:none"></a>
    <div id="ngrok-error" class="ngrok-error-msg"></div>
  </div>

  <div id="server-list" class="server-grid"></div>

  <div class="page-footer">
    Auto-refresh: 10s &middot; Last checked: <span id="last-checked">--</span>
  </div>

</div>

<script>
const API = '/api';

async function fetchState() {
  try {
    const resp = await fetch(`${API}/servers`);
    const data = await resp.json();
    renderHeader(data.ngrokUrl, data.ngrokError);
    renderServers(data.servers, data.target);
    document.getElementById('last-checked').textContent = new Date().toLocaleTimeString();
  } catch (err) {
    document.getElementById('ngrok-error').textContent = 'Cannot reach switcher';
  }
}

function renderHeader(url, error) {
  const link = document.getElementById('ngrok-url');
  const status = document.getElementById('ngrok-status');
  const errorEl = document.getElementById('ngrok-error');

  if (url) {
    link.href = url.startsWith('http') ? url : 'https://' + url;
    link.textContent = url;
    link.style.display = '';
    status.className = 'status-pill status-connected';
    status.innerHTML = '<span class="pill-dot"></span>connected';
  } else {
    link.style.display = 'none';
    status.className = 'status-pill status-disconnected';
    status.innerHTML = '<span class="pill-dot"></span>disconnected';
  }

  errorEl.textContent = error || '';
}

function renderServers(servers, target) {
  const container = document.getElementById('server-list');
  container.innerHTML = '';

  if (!servers || servers.length === 0) {
    container.innerHTML = '<div class="empty-state">No servers configured.<br>Add entries to <code>servers.json</code> and restart.</div>';
    return;
  }

  for (const s of servers) {
    const isActive = target && s.actualPort === target.port;
    const isDown = s.health === 'down';
    const isDrifted = s.status === 'drifted';
    const displayPort = s.actualPort || s.configuredPort;
    const ngrokUrl = target && isActive ? (document.getElementById('ngrok-url').textContent || '') : '';

    const card = document.createElement('div');
    card.className = 'server-card' + (isActive ? ' active' : '') + (isDown ? ' dimmed' : '');

    card.innerHTML = `
      <div class="card-top">
        <span class="server-name">${esc(s.name)}</span>
        <span class="health-dot ${s.health}"></span>
      </div>
      <div class="card-meta">
        <span class="port-badge">:${displayPort}</span>
        ${isDrifted ? `<span class="drift-badge">shifted from :${s.configuredPort}</span>` : ''}
        ${isActive ? '<span class="active-badge">active</span>' : ''}
      </div>
      <div class="card-actions">
        <button class="tunnel-btn${isActive ? ' stop' : ''}" ${isDown ? 'disabled' : ''} data-port="${displayPort}">
          ${isActive ? 'Stop' : 'Tunnel'}
        </button>
        ${isActive && ngrokUrl ? `<span class="tunnel-url"><a href="${escAttr(ngrokUrl)}" target="_blank">${esc(ngrokUrl)}</a></span>` : ''}
      </div>
    `;

    const btn = card.querySelector('button');
    btn.addEventListener('click', () => handleTunnel(btn.dataset.port, isActive));

    container.appendChild(card);
  }
}

async function handleTunnel(port, isActive) {
  const newTarget = isActive ? null : parseInt(port);
  try {
    const resp = await fetch(`${API}/target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: newTarget })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      alert(err.error || 'Failed to switch tunnel');
      return;
    }
    fetchState();
  } catch (err) {
    alert('Network error — cannot reach switcher');
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
}
function escAttr(s) { return String(s).replace(/"/g, '&quot;'); }

fetchState();
setInterval(fetchState, 10000);
</script>
</body>
</html>
```

- [ ] **Step 3: Verify dashboard**

```bash
node server.js
```

Open `http://localhost:9595` in a browser. Expected:
- Header shows ngrok URL (if ngrok is up) or "(no tunnel)" with red disconnected badge
- 7 server rows with correct names and ports
- Green dots for running servers, red for down
- "Tunnel" buttons active for healthy servers, dimmed for down servers
- Clicking "Tunnel" highlights the row, button changes to "Stop"
- Clicking "Stop" unhighlights and returns to "Tunnel"
- "Last checked" timestamp updates every 10 seconds

- [ ] **Step 4: Commit**

```bash
git add index.html server.js
git commit -m "feat: dashboard UI with server list, health dots, tunnel toggle, auto-refresh"
```

---

## Task 7: Error Handling & Edge Case Hardening

**Files:**
- Modify: `E:\Van\Documents\GitHub\ngrok-dashboard\server.js` (scattered improvements)

- [ ] **Step 1: Handle missing `servers.json` gracefully**

Wrap the config load:

```javascript
let CONFIG;
try {
  CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'servers.json'), 'utf8'));
} catch (e) {
  console.error('servers.json not found or invalid. Using empty config.');
  CONFIG = { servers: [], scanRange: 50, switcherPort: 9595, healthIntervalMs: 10000 };
}
```

- [ ] **Step 2: Handle ngrok spawn already running**

Add a check before spawning:

```javascript
function startNgrok() {
  // If ngrok is already running, don't spawn another
  if (ngrokProcess && ngrokProcess.exitCode === null) {
    console.log('ngrok already running');
    return Promise.resolve(ngrokUrl);
  }
  // ... rest of existing function
```

- [ ] **Step 3: Guard against double-response in proxy & abort on client disconnect**

Add `res.headersSent` check before the 502 handler (already in Task 5 code). Also abort the proxy request if the client disconnects:

```javascript
// In the proxy catch-all handler, after the req.pipe(proxyReq):
  req.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('Client request error');
    }
    proxyReq.destroy();
  });

  req.on('close', () => {
    if (!res.headersSent && !proxyReq.destroyed) {
      proxyReq.destroy();
    }
  });
```

- [ ] **Step 4: Prevent overlapping health-scan cycles**

The `scanning` guard already added in Task 3 prevents overlapping cycles. Verify it works by wrapping `refreshAllServers` with the guard if not already present:

```javascript
let scanning = false;  // added in Task 3 alongside refreshAllServers

async function refreshAllServers() {
  if (scanning) return Object.values(serverStatuses);
  scanning = true;
  try {
    const results = await Promise.all(CONFIG.servers.map(discoverServer));
    // ... update serverStatuses ...
    return Object.values(results);
  } finally {
    scanning = false;
  }
}
```

(If the Task 3 code already includes the guard, confirm it's in place. The `Promise.all` keeps concurrency within a single cycle; the guard prevents cycle overlap.)

- [ ] **Step 5: Add request logging (minimal)**

```javascript
// At the top of the http.createServer callback:
  console.log(`${new Date().toISOString().slice(11,19)} ${req.method} ${pathname}`);
```

- [ ] **Step 6: Verify error cases**

```bash
# 1. Start with servers.json missing (rename it)
ren servers.json servers.json.bak
node server.js
# Expected: "servers.json not found" log, server starts with empty list
curl http://localhost:9595/api/servers
# → {"servers":[],"target":null,"ngrokUrl":null}
ren servers.json.bak servers.json

# 2. Proxy to a down server
curl -X POST http://localhost:9595/api/target -H "Content-Type: application/json" -d "{\"port\":3470}"
curl http://localhost:9595/test
# → 502 with JSON error if Companion is down

# 3. Invalid POST body
curl -X POST http://localhost:9595/api/target -H "Content-Type: application/json" -d "not json"
# → 400 with "Invalid JSON body"
```

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "fix: error handling for missing config, double-responses, ngrok re-spawn, and request logging"
```

---

## Task 8: README & Final Integration Test

**Files:**
- Create: `E:\Van\Documents\GitHub\ngrok-dashboard\README.md`

- [ ] **Step 1: Create `README.md`**

```markdown
# ngrok Tunnel Switcher

Single-command dashboard that lets you switch which local dev server is exposed through your ngrok tunnel.

## How it works

- One `node server.js` starts an HTTP reverse proxy on `localhost:9595`
- It launches one ngrok tunnel pointing at port 9595, giving you one public URL
- The dashboard loads at that URL — showing all your servers, their health, and a tunnel toggle
- Non-dashboard requests are proxied to whichever server you selected
- Server ports are auto-discovered: if a server moved within ±50 ports of its configured port, the switcher finds it

## Prerequisites

- **Node.js 18+** (for `fetch`, `AbortController`)
- **ngrok** installed, in PATH, and authenticated (`ngrok config check`)
- One or more local HTTP servers you want to expose

## Quickstart

```bash
# 1. Configure your servers
notepad servers.json

# 2. Start (Windows double-click start.bat, or command line)
node server.js
```

The terminal shows the ngrok URL. Open it in a browser, click "Tunnel" on any server, and the URL now serves that server.

## Configuration (`servers.json`)

```json
{
  "servers": [
    { "name": "Codenomad",   "port": 9896 },
    { "name": "Ollama",      "port": 4000 }
  ],
  "scanRange": 50,
  "switcherPort": 9595,
  "healthIntervalMs": 10000
}
```

| Field | Purpose |
|---|---|
| `servers[].name` | Display name |
| `servers[].port` | Expected port (scanned first) |
| `scanRange` | If expected port is down, scan ± this many ports |
| `switcherPort` | Port the dashboard runs on |
| `healthIntervalMs` | How often to re-check server health |

## Files

| File | Purpose |
|---|---|
| `server.js` | Everything: HTTP server, ngrok manager, proxy, discovery |
| `index.html` | Dashboard UI (vanilla HTML/CSS/JS) |
| `servers.json` | Your server list and settings |
| `start.bat` | Double-click launcher for Windows |

## Limitations

- HTTP only — WebSocket upgrade is not proxied
- No persistent state — target resets to "none" on restart
- Ngrok free tier: browser warning interstitial is bypassed automatically
- Port scan adds latency to health checks for down/drifted servers
```

- [ ] **Step 2: Final integration test**

Full end-to-end:

```bash
# 1. Start the switcher
node E:\Van\Documents\GitHub\ngrok-dashboard\server.js

# 2. Verify local dashboard
start http://localhost:9595

# 3. Verify ngrok (if running)
# The terminal shows: "ngrok tunnel: https://xxxxx.ngrok-free.dev"
# Open that URL — dashboard should load through ngrok

# 4. Test proxy chain through ngrok
curl -X POST http://localhost:9595/api/target -H "Content-Type: application/json" -d "{\"port\":<a-running-port>}"
# Then through ngrok URL:
curl https://xxxxx.ngrok-free.dev/api/servers
# → shows dashboard data through ngrok

# 5. Test tunnel toggle in browser
# Open ngrok URL, click "Tunnel" on a server, verify row highlights
# Open a new tab to the same ngrok URL — should hit the proxied server

# 6. Test stop
# Click "Stop" on the active server — row unhighlights
# New tab to same URL → shows dashboard again
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with quickstart, config reference, limitations"
```

---

## Evidence Required Before Completion

- Code paths changed match scope.
- All curl-based verification steps pass.
- Dashboard loads through ngrok URL with all 7 servers listed.
- Proxy forwards correctly; API routes not forwarded.
- Remaining limitations are documented in README.

## Completion Checklist

- [ ] All 8 tasks complete
- [ ] Definition of Done met
- [ ] `docs/ai/work-state.md` updated to point at next plan or mark as complete
- [ ] `docs/ai/todo.md` updated
