# 0002 - Node.js Built-in http Module Over Express

Date: 2026-05-28
Status: Accepted

## Context

The backend needs to serve an HTML dashboard, expose a small JSON API (3 routes), proxy HTTP requests, and manage an ngrok child process. The user's constraint was "whatever takes fewer lines" and "no build step." Node.js built-in modules (`http`, `child_process`, `fs`) versus Express.js was the primary framework decision.

## Options Considered

### A - Node.js Built-in `http` Module (No Framework)

**What it is:** Use `http.createServer` with manual URL parsing (`new URL(req.url)`) and manual route dispatch via `if/else` on `pathname`. Body reading via a small `readBody()` helper. Static file serving via `fs.readFileSync`.

**Why you'd pick it:** Zero dependencies. No `npm install`. Single `node server.js` works anywhere. Maximum transparency — no middleware magic to debug.

**How it gets implemented:**
```javascript
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${SWITCHER_PORT}`);
  if (url.pathname === '/api/servers') { /* ... */ }
  else if (url.pathname === '/') { /* serve index.html */ }
  else { /* proxy */ }
});
```

**What it costs:** Manual CORS handling. Manual body parsing. Manual content-type headers. ~20 extra lines compared to Express for these concerns. No ecosystem middleware (rate limiting, compression, etc.) — but none needed for a single-user personal tool.

### B - Express.js

**What it is:** Use `express` package with route definitions (`app.get('/api/servers', ...)`), `express.static` for static files, `express.json()` for body parsing, and `http-proxy-middleware` or manual `http.request` for proxying.

**Why you'd pick it:** Established patterns. Ecosystem middleware available. Less boilerplate for CORS, body parsing, and route organization.

**How it gets implemented:**
```javascript
const express = require('express');
const app = express();
app.use(express.json());
app.use(cors());
app.get('/api/servers', (req, res) => { /* ... */ });
app.post('/api/target', (req, res) => { /* ... */ });
app.get('/', (req, res) => { res.sendFile('index.html'); });
app.use('/', (req, res) => { /* proxy */ });
app.listen(9595);
```

**What it costs:** Requires `npm install express` (adds ~60 packages to node_modules). Additional dependency surface. "It's just Express" obscures the proxy logic for future maintenance.

### C - Python with Flask

**What it is:** Same architecture but in Python with Flask, `subprocess.Popen` for ngrok, `requests` for health checks.

**Why you'd pick it:** User is familiar with Python (based on existing projects).

**How it gets implemented:** Flask routes for `/`, `/api/servers`, `/api/target`. `subprocess.Popen` for ngrok with stdout polling. `requests.get` for health checks and proxying.

**What it costs:** Requires `pip install flask requests`. Python subprocess stdout handling is line-buffered and clunkier for streaming URL parsing. More code than Option A.

## Decision

Option A (Node.js built-in `http` module) chosen. It is the only option that satisfies "zero dependencies" and "single command to run," while Node.js `child_process.spawn` provides the best streaming stdout API for parsing ngrok's URL in real time.

## Consequences

- **Easier:** `node server.js` works on any machine with Node 18+. No install step. Full control over every request/response.
- **Harder:** Manual CORS, body parsing, and content-type headers. Route dispatch is a flat `if/else` chain (acceptable for 5 routes). No ecosystem tools if requirements grow.
- **Reversible:** With effort — migrating to Express would require restructuring route handlers but the core logic (ngrok management, proxy, discovery) stays the same. ~30 minutes of refactoring.
