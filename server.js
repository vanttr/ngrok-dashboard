// server.js — Ngrok Tunnel Switcher
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
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
process.on('exit', () => { stopNgrok(); stopScheduler(); });

// ---- Scheduler ----

function resolveTilde(filePath) {
  if (filePath.startsWith('~/') || filePath === '~') {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

function getNestedValue(obj, dottedPath) {
  const keys = dottedPath.split('.');
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

const SCHEDULER_CONFIG = CONFIG.scheduler || null;

let schedulerState = {
  enabled: SCHEDULER_CONFIG ? !!SCHEDULER_CONFIG.enabled : false,
  minuteOffsets: SCHEDULER_CONFIG ? (SCHEDULER_CONFIG.minuteOffsets || [0]) : [],
  prompt: SCHEDULER_CONFIG ? (SCHEDULER_CONFIG.prompt || 'hi') : 'hi',
  targets: [],
  lastFiredSlot: null,
};

if (SCHEDULER_CONFIG && SCHEDULER_CONFIG.targets) {
  for (const t of SCHEDULER_CONFIG.targets) {
    let credential = null;
    let credentialError = null;
    try {
      const resolvedPath = resolveTilde(t.credentialPath);
      const raw = fs.readFileSync(resolvedPath, 'utf8');
      const parsed = JSON.parse(raw);
      credential = getNestedValue(parsed, t.credentialKey);
      if (typeof credential !== 'string' || credential.length === 0) {
        credentialError = `Credential key "${t.credentialKey}" not found or empty`;
        credential = null;
      }
    } catch (e) {
      credentialError = e.message;
    }
    schedulerState.targets.push({
      name: t.name,
      type: t.type,
      model: t.model,
      credential,
      credentialError,
      lastRun: null,
      status: credential ? 'pending' : 'error',
      responsePreview: null,
      error: credentialError,
    });
  }
  console.log(`Scheduler: ${schedulerState.targets.length} target(s) loaded (${schedulerState.targets.filter(t => t.credential).length} with credentials)`);
} else if (SCHEDULER_CONFIG) {
  console.log('Scheduler: enabled but no targets configured');
}

// ---- API call functions ----

function callAI(target, prompt) {
  if (target.type === 'claude') {
    return callClaude(target, prompt);
  } else if (target.type === 'codex') {
    return callCodex(target, prompt);
  }
  throw new Error(`Unknown target type: ${target.type}`);
}

function callClaude(target, prompt) {
  const body = JSON.stringify({
    model: target.model,
    max_tokens: 100,
    messages: [{ role: 'user', content: prompt }]
  });

  const options = {
    hostname: 'api.anthropic.com',
    port: 443,
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': target.credential,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body)
    },
    timeout: 15000
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Claude API returned ${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        try {
          const data = JSON.parse(raw);
          const text = data?.content?.[0]?.text;
          if (typeof text !== 'string' || text.length === 0) {
            reject(new Error('Claude returned empty response'));
            return;
          }
          resolve(text.slice(0, 80));
        } catch (e) {
          reject(new Error(`Claude response parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Claude network error: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Claude request timed out (15s)')); });
    req.write(body);
    req.end();
  });
}

function callCodex(target, prompt) {
  const body = JSON.stringify({
    model: target.model,
    max_tokens: 100,
    messages: [{ role: 'user', content: prompt }]
  });

  const options = {
    hostname: 'api.openai.com',
    port: 443,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${target.credential}`,
      'Content-Length': Buffer.byteLength(body)
    },
    timeout: 15000
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`OpenAI API returned ${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        try {
          const data = JSON.parse(raw);
          const text = data?.choices?.[0]?.message?.content;
          if (typeof text !== 'string' || text.length === 0) {
            reject(new Error('OpenAI returned empty response'));
            return;
          }
          resolve(text.slice(0, 80));
        } catch (e) {
          reject(new Error(`OpenAI response parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`OpenAI network error: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI request timed out (15s)')); });
    req.write(body);
    req.end();
  });
}

// ---- Scheduler time-keeping ----
let schedulerTimer = null;

function getSlotKey() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function computeNextFire() {
  if (!schedulerState.enabled || schedulerState.minuteOffsets.length === 0) return null;
  const now = new Date();
  const currentMinute = now.getMinutes();
  const sorted = [...schedulerState.minuteOffsets].sort((a, b) => a - b);
  let nextOffset = sorted.find(o => o > currentMinute);
  if (nextOffset === undefined) {
    nextOffset = sorted[0];
    now.setHours(now.getHours() + 1);
  }
  now.setMinutes(nextOffset, 0, 0);
  return now.toISOString();
}

async function fireOneTarget(target, prompt) {
  if (!target.credential) {
    target.status = 'error';
    target.error = target.credentialError || 'No credential';
    target.lastRun = new Date().toISOString();
    return;
  }
  try {
    target.status = 'pending';
    const response = await callAI(target, prompt);
    target.status = 'success';
    target.responsePreview = response;
    target.error = null;
  } catch (e) {
    target.status = 'error';
    target.error = e.message;
    target.responsePreview = null;
  }
  target.lastRun = new Date().toISOString();
}

async function fireAllTargets() {
  const slotKey = getSlotKey();
  if (schedulerState.lastFiredSlot === slotKey) return;
  const minute = new Date().getMinutes();
  if (!schedulerState.minuteOffsets.includes(minute)) return;

  // Guard: skip first second of a new minute to avoid race with tick timing
  const second = new Date().getSeconds();
  if (second < 1) return;

  schedulerState.lastFiredSlot = slotKey;
  console.log(`Scheduler: firing at ${slotKey}`);

  // Fire all targets in parallel — one timeout does not block the other
  await Promise.allSettled(
    schedulerState.targets.map(t => fireOneTarget(t, schedulerState.prompt))
  );
}

function startScheduler() {
  if (!schedulerState.enabled) {
    console.log('Scheduler: disabled — not starting');
    return;
  }
  if (schedulerState.targets.length === 0) {
    console.log('Scheduler: no targets — not starting');
    return;
  }
  console.log(`Scheduler: started (offsets: ${schedulerState.minuteOffsets.join(', ')})`);
  schedulerTimer = setInterval(() => {
    fireAllTargets().catch(err => console.error('Scheduler tick error:', err));
  }, 30000);
}

function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

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
    return { name: server.name, configuredPort, actualPort: configuredPort, health: 'ok', status: 'ok', hasDevScript: !!server.devScript };
  }

  // Build set of all configured ports to skip during drift scan
  const configuredPorts = new Set(CONFIG.servers.map(s => s.port));

  // Fallback: scan ±SCAN_RANGE around configured port
  const start = Math.max(1, configuredPort - SCAN_RANGE);
  const end = configuredPort + SCAN_RANGE;
  for (let p = start; p <= end; p++) {
    if (p === configuredPort) continue; // already checked
    if (configuredPorts.has(p)) continue; // skip other servers' configured ports
    if (await checkPort(p, 500)) {
      return { name: server.name, configuredPort, actualPort: p, health: 'ok', status: 'drifted', hasDevScript: !!server.devScript };
    }
  }

  return { name: server.name, configuredPort, actualPort: null, health: 'down', status: 'down', hasDevScript: !!server.devScript };
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
        // Don't overwrite a server legitimately configured on this port
        const existing = serverStatuses[r.actualPort];
        if (!existing || existing.configuredPort !== r.actualPort) {
          serverStatuses[r.actualPort] = r;
        }
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

  const url = new URL(req.url, `http://${SWITCHER_HOST}:${SWITCHER_PORT}`);
  const pathname = url.pathname;
  console.log(`${new Date().toISOString().slice(11,19)} ${req.method} ${pathname}`);

  // CORS preflight — only for switcher API routes, NOT for proxied paths
  // Dashboard is same-origin so never needs CORS; proxied paths must reach the target
  const isSwitcherApiRoute = pathname === '/api/servers' ||
    pathname === '/api/target' ||
    pathname === '/api/health' ||
    pathname === '/api/scheduler' ||
    /^\/api\/servers\/\d+\/start$/.test(pathname);

  if (req.method === 'OPTIONS' && isSwitcherApiRoute) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- API Routes ----
  if (pathname === '/api/servers') {
    const list = await refreshAllServers();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
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
    res.setHeader('Access-Control-Allow-Origin', '*');
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
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: `Port ${port} is not a known server` }));
          return;
        }
        currentTarget = { port: found.actualPort || found.configuredPort, name: found.name };
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, target: currentTarget }));
    } catch (e) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
    }
    return;
  }

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
      // Spawn the dev.ps1 script in a fully independent process.
      // Using cmd /c start ensures the PowerShell process gets its own console
      // and its Start-Process children survive after the wrapper exits.
      // Direct powershell.exe -File with detached:true kills grandchildren on Windows.
      const spawnArgs = [
        '/c',
        'start',
        '/min',
        'powershell.exe',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        serverEntry.devScript,
        ...(serverEntry.devArgs || [])
      ];
      const child = spawn('cmd.exe', spawnArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.on('error', (err) => {
        console.error(`Spawn error for ${serverEntry.name}: ${err.message}`);
      });
      child.unref();

      const argsStr = serverEntry.devArgs ? ' ' + serverEntry.devArgs.join(' ') : '';
      console.log(`Started ${serverEntry.name} via ${serverEntry.devScript}${argsStr} (PID: ${child.pid})`);

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

  if (pathname === '/ngrok-skip-browser-warning') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/api/health') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      ngrokConnected: !!ngrokUrl,
      target: currentTarget,
    }));
    return;
  }

  if (pathname === '/api/scheduler') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(200);
    res.end(JSON.stringify({
      enabled: schedulerState.enabled,
      minuteOffsets: schedulerState.minuteOffsets,
      nextFire: computeNextFire(),
      prompt: schedulerState.prompt,
      targets: schedulerState.targets.map(t => ({
        name: t.name,
        lastRun: t.lastRun,
        status: t.status,
        responsePreview: t.responsePreview,
        error: t.error
      }))
    }));
    return;
  }

  // ---- Dashboard ----
  // Serve dashboard at /dash, or at / when no target is set
  if ((pathname === '/dash' || pathname === '/') && req.method === 'GET') {
    // If a target IS set and they hit /, proxy through instead
    if (pathname === '/' && currentTarget) {
      // fall through to proxy below
    } else {
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
  }

  // ---- Proxy (catch-all) ----
  if (!currentTarget) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(503);
    res.end(JSON.stringify({ error: 'No target selected. Visit /dash to choose a server.' }));
    return;
  }

  const targetHost = 'localhost';
  const targetPort = currentTarget.port;
  const targetPath = req.url;

  // Filter hop-by-hop headers that Node.js manages itself
  const HOP_BY_HOP = new Set(['transfer-encoding', 'connection', 'keep-alive',
    'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);

  // Determine the original protocol and host the client used to reach us
  const origProto = req.headers['x-forwarded-proto'] || ((req.socket && req.socket.encrypted) ? 'https' : 'http');
  const origHost = req.headers['x-forwarded-host'] || req.headers.host || `${SWITCHER_HOST}:${SWITCHER_PORT}`;
  const origIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';

  // Filter request headers before forwarding
  const filteredReqHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) filteredReqHeaders[k] = v;
  }
  filteredReqHeaders.host = `${targetHost}:${targetPort}`;
  // Add standard forwarding headers so backend apps can construct correct URLs
  filteredReqHeaders['x-forwarded-for'] = origIp;
  filteredReqHeaders['x-forwarded-proto'] = origProto;
  filteredReqHeaders['x-forwarded-host'] = origHost;
  // Force uncompressed responses so HTML body rewriting doesn't need decompression
  filteredReqHeaders['accept-encoding'] = 'identity';

  // Build the public origin URL (what the browser sees)
  // e.g. "https://abc123.ngrok-free.app" or "http://localhost:9595"
  const publicOrigin = `${origProto}://${origHost}`;

  const proxyReq = http.request(
    {
      hostname: targetHost,
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: filteredReqHeaders,
      timeout: 30000,
      // Disable connection pooling: backend servers (e.g. PowerShell HttpListener)
      // close connections after each response. The default Agent retries stale
      // connections for GET but not POST, causing ECONNRESET (502) on form submits.
      agent: false,
    },
    (proxyRes) => {
      // Filter and rewrite response headers
      const filteredHeaders = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        const lk = k.toLowerCase();
        if (HOP_BY_HOP.has(lk)) continue;

        // Rewrite Location header in redirect responses so the browser
        // stays on the public origin instead of being sent to localhost
        if (lk === 'location') {
          filteredHeaders[k] = rewriteOrigin(v, targetHost, targetPort, publicOrigin);
          continue;
        }

        // Rewrite Set-Cookie: strip/fix Domain and SameSite attributes
        // so cookies work through the tunnel
        if (lk === 'set-cookie') {
          const cookies = Array.isArray(v) ? v : [v];
          filteredHeaders[k] = cookies.map(c => rewriteCookie(c, publicOrigin, origProto === 'https'));
          continue;
        }

        filteredHeaders[k] = v;
      }

      // Ensure ngrok-skip-browser-warning is present
      if (!filteredHeaders['ngrok-skip-browser-warning']) {
        filteredHeaders['ngrok-skip-browser-warning'] = 'true';
      }

      // Rewrite HTML bodies: replace hardcoded localhost:PORT URLs with the
      // public origin so HTMX attributes, form actions, and links stay on-proxy
      const contentType = (filteredHeaders['content-type'] || '').toLowerCase();
      if (contentType.startsWith('text/html')) {
        const chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf8');
          body = rewriteHtmlBody(body, targetHost, targetPort, publicOrigin);
          filteredHeaders['content-length'] = String(Buffer.byteLength(body, 'utf8'));
          delete filteredHeaders['content-encoding'];
          res.writeHead(proxyRes.statusCode, filteredHeaders);
          res.end(body);
        });
      } else {
        res.writeHead(proxyRes.statusCode, filteredHeaders);
        proxyRes.pipe(res);
      }
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

  // Explicitly handle request body to avoid stream piping issues
  let reqEnded = false;
  if (req.method === 'GET' || req.method === 'HEAD') {
    proxyReq.end();
    reqEnded = true;
  } else {
    req.on('data', (chunk) => {
      proxyReq.write(chunk);
    });
    req.on('end', () => {
      reqEnded = true;
      proxyReq.end();
    });
  }

  req.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('Client request error');
    }
    proxyReq.destroy();
  });

  // Only abort the upstream request if the client disconnects before the request
  // body was fully sent. Node.js v16+ streams auto-destroy after 'end', emitting
  // 'close' immediately — we must not treat that as an abandoned request.
  req.on('close', () => {
    if (!reqEnded && !res.headersSent && !proxyReq.destroyed) {
      proxyReq.destroy();
    }
  });
  return;
});

// ---- Header Rewriting Helpers ----

/**
 * Rewrite a Location header value so redirects stay on the public origin.
 * Replaces http(s)://localhost:PORT with the public origin URL.
 * Also handles relative-to-absolute conversions for common backend patterns.
 */
function rewriteOrigin(value, targetHost, targetPort, publicOrigin) {
  if (!value) return value;
  // Pattern: http://localhost:PORT/path or https://localhost:PORT/path
  const localPattern = new RegExp(`^https?://${escapeRegex(targetHost)}:${targetPort}`, 'i');
  let rewritten = value.replace(localPattern, publicOrigin);
  // Also handle bare localhost without port (some backends omit the port)
  const bareLocalPattern = new RegExp(`^https?://${escapeRegex(targetHost)}(?=/|$)`, 'i');
  rewritten = rewritten.replace(bareLocalPattern, publicOrigin);
  return rewritten;
}

/**
 * Rewrite a Set-Cookie header so cookies work through the tunnel.
 * - Strips Domain=localhost(:port) attributes
 * - Downgrades Secure to remove it when accessed via http (or keeps for https)
 * - Relaxes SameSite=Lax to SameSite=None;Secure when tunnel is https
 */
function rewriteCookie(cookieStr, publicOrigin, isSecure) {
  if (!cookieStr) return cookieStr;
  let parts = cookieStr.split(';').map(p => p.trim());

  // Remove Domain attributes that reference localhost
  parts = parts.filter(p => {
    const lk = p.toLowerCase();
    if (lk.startsWith('domain=')) {
      const domainVal = p.substring(p.indexOf('=') + 1).trim().toLowerCase();
      // Remove domain=localhost or domain=localhost:port
      if (domainVal === 'localhost' || domainVal.startsWith('localhost:')) {
        return false; // strip it — browser will default to the public origin
      }
    }
    return true;
  });

  // For https tunnels, ensure SameSite=None so cross-site framing works
  // and add Secure flag so SameSite=None is valid
  if (isSecure) {
    const hasSameSite = parts.some(p => p.toLowerCase().startsWith('samesite='));
    if (!hasSameSite) {
      parts.push('SameSite=None');
    } else {
      parts = parts.map(p => {
        if (p.toLowerCase().startsWith('samesite=')) {
          const val = p.substring(p.indexOf('=') + 1).trim();
          if (val.toLowerCase() === 'lax' || val.toLowerCase() === 'strict') {
            return 'SameSite=None';
          }
        }
        return p;
      });
    }
    // Ensure Secure flag is present (required with SameSite=None)
    const hasSecure = parts.some(p => p.toLowerCase() === 'secure');
    if (!hasSecure) {
      parts.push('Secure');
    }
  }

  return parts.join('; ');
}

/**
 * Rewrite localhost:PORT URLs in an HTML response body.
 * Replaces http(s)://localhost:PORT with publicOrigin everywhere in the body
 * so HTMX attributes, form actions, script src, and anchor hrefs all point
 * through the proxy instead of directly to localhost.
 */
function rewriteHtmlBody(html, targetHost, targetPort, publicOrigin) {
  if (!html) return html;
  const withPort = new RegExp(`https?://${escapeRegex(targetHost)}:${targetPort}`, 'gi');
  let rewritten = html.replace(withPort, publicOrigin);
  // Also handle bare localhost without port (port 80/443 omitted)
  const bareHost = new RegExp(`https?://${escapeRegex(targetHost)}(?=/|"|'|\\s|>)`, 'gi');
  rewritten = rewritten.replace(bareHost, publicOrigin);
  return rewritten;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
    let retries = 2;
    while (retries > 0) {
      try {
        await startNgrok();
        break;
      } catch (err) {
        retries--;
        ngrokError = err.message;
        if (retries > 0 && err.message.includes('already online')) {
          console.error('ngrok endpoint conflict, retrying in 2s...');
          await new Promise(r => setTimeout(r, 2000));
        } else {
          console.error('ngrok failed to start, running without tunnel:', err.message);
          break;
        }
      }
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
    startScheduler();
  });
}

main();
