// server.js — Ngrok Tunnel Switcher
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- Configuration ----
let CONFIG;
try {
  CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'servers.json'), 'utf8'));
} catch (e) {
  console.error('servers.json not found or invalid. Using empty config.');
  CONFIG = { servers: [], scanRange: 50, switcherPort: 9595, healthIntervalMs: 10000 };
}
const SWITCHER_PORT = process.env.SWITCHER_PORT || CONFIG.switcherPort || 9595;
const SWITCHER_HOST = process.env.SWITCHER_HOST || '127.0.0.1';
const NO_NGROK = !!process.env.NO_NGROK;
const NGROK_OAUTH = '--oauth=google --oauth-allow-email=vant.tr@gmail.com';

// ---- Ngrok Process Manager ----
let ngrokProcess = null;
let ngrokUrl = null;

function startNgrok() {
  // If ngrok is already running, don't spawn another
  if (ngrokProcess && ngrokProcess.exitCode === null) {
    console.log('ngrok already running');
    return Promise.resolve(ngrokUrl);
  }

  return new Promise((resolve, reject) => {
    const args = ['http', String(SWITCHER_PORT), ...NGROK_OAUTH.split(' '), '--log=stdout', '--log-format=json'];
    ngrokProcess = spawn('ngrok', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let resolved = false;

    ngrokProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.msg === 'started tunnel' && entry.url && !resolved) {
            ngrokUrl = entry.url;
            resolved = true;
            console.log(`ngrok tunnel: ${ngrokUrl}`);
            resolve(ngrokUrl);
            return;
          }
        } catch {
          // non-JSON line (banner, warning, etc.) — ignore
        }
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
    return resp.status >= 200 && resp.status < 400;
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
  if (scanning) {
    const seen = new Set();
    return Object.values(serverStatuses).filter(r => {
      const key = r.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
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

  const url = new URL(req.url, `http://${SWITCHER_HOST}:${SWITCHER_PORT}`);
  const pathname = url.pathname;
  console.log(`${new Date().toISOString().slice(11,19)} ${req.method} ${pathname}`);

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
  return;
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
  if (!NO_NGROK) {
    try {
      await startNgrok();
    } catch (err) {
      ngrokError = err.message;
      console.error('ngrok failed to start, running without tunnel:', err.message);
    }
  } else {
    console.log('ngrok disabled (NO_NGROK=1)');
  }

  server.on('error', (err) => {
    console.error(`Server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(SWITCHER_PORT, SWITCHER_HOST, () => {
    console.log(`Switcher listening on http://${SWITCHER_HOST}:${SWITCHER_PORT}`);
  });
}

main();
