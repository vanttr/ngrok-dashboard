// server.js — Ngrok Tunnel Switcher
const { spawn, execFile } = require('child_process');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
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
const FAVORITES_PATH = path.join(__dirname, 'opencode-dash-config.json');

// Resolve opencode binary path (npm global install on Windows)
function resolveOpencodePath() {
  const npmBin = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  if (fs.existsSync(npmBin)) return npmBin;
  return 'opencode'; // fallback to PATH
}
const OPENCODE_PATH = resolveOpencodePath();

// ---- Provider Usage Tracking ----
const { createProviderRegistry } = require('./server/providers/registry.js');
const { createRefreshService } = require('./server/jobs/refresh-providers.js');
const { createProviderCacheRepo } = require('./server/db/provider-cache-repo.js');
const Database = require('better-sqlite3');

let USAGE_CONFIG;
try {
  USAGE_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'usage.json'), 'utf8'));
} catch (e) {
  USAGE_CONFIG = {};
}
const USAGE_POLL_MS = Math.max(1, Math.min(60, USAGE_CONFIG.pollIntervalMinutes || 5)) * 60 * 1000;

let refreshService = null;
function initProviderTracking() {
  try {
    const dbDir = path.join(__dirname, '.tmp');
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    const database = new Database(path.join(dbDir, 'provider-cache.sqlite'));
    const providerCacheRepo = createProviderCacheRepo(database);
    const registry = createProviderRegistry();
    const settings = {
      openrouterApiKey: USAGE_CONFIG.openrouterApiKey || '',
      deepseekApiKey: USAGE_CONFIG.deepseekApiKey || '',
      opencodeGoApiKey: USAGE_CONFIG.opencodeGoApiKey || ''
    };
    refreshService = createRefreshService({ registry, providerCacheRepo, settings });
    // Initial fetch (async, non-blocking)
    refreshService.refreshAll().catch(err => console.error('Provider refresh error:', err.message));
    // Periodic refresh
    setInterval(() => {
      if (refreshService) refreshService.refreshAll().catch(err => console.error('Provider refresh error:', err.message));
    }, USAGE_POLL_MS);
    console.log('Provider tracking initialized. Poll interval:', USAGE_POLL_MS / 60000, 'min');
  } catch (e) {
    console.error('Failed to initialize provider tracking:', e.message);
  }
}

// ---- Authentication Config ----
let AUTH;
let AUTH_ACTIVE = false;
try {
  AUTH = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth.json'), 'utf8'));
  // Auto-generate session secret if blank
  if (!AUTH.sessionSecret || AUTH.sessionSecret.length < 16) {
    AUTH.sessionSecret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(__dirname, 'auth.json'), JSON.stringify(AUTH, null, 2), 'utf8');
    console.log('Generated new session secret in auth.json');
  }
  // Check if any auth method is actually configured
  const hasPassword = !!(AUTH.password && AUTH.password.hash);
  const hasGoogle = !!(AUTH.google && AUTH.google.clientId);
  if (hasPassword || hasGoogle) {
    AUTH_ACTIVE = true;
    const methods = [];
    if (hasPassword) methods.push('password');
    if (hasGoogle) methods.push('Google');
    console.log(`Authentication enabled: ${methods.join(' + ')}`);
  } else {
    console.log('auth.json loaded but no methods configured — running WITHOUT authentication');
    console.log('  To enable: edit auth.json and set a password or Google OAuth credentials, then restart.');
  }
} catch (e) {
  AUTH = null;
  console.log('auth.json not found — running WITHOUT authentication');
}

// ---- Session Store ----
const SESSION_COOKIE = 'ngrok_dash_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const sessions = new Map();

// Periodic cleanup of expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, 5 * 60 * 1000);

// ---- Rate Limiting ----
const RATE_LIMIT = { maxAttempts: 5, windowMs: 15 * 60 * 1000 }; // 5 attempts per 15 min
const rateLimitStore = new Map();

// Periodic cleanup of expired rate-limit windows
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.windowStart > RATE_LIMIT.windowMs) rateLimitStore.delete(key);
  }
}, 5 * 60 * 1000);

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

function checkRateLimit(key, store, config) {
  store = store || rateLimitStore;
  config = config || RATE_LIMIT;
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now - entry.windowStart > config.windowMs) {
    store.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }
  entry.count++;
  if (entry.count > config.maxAttempts) {
    const retryAfter = Math.ceil((entry.windowStart + config.windowMs - now) / 1000);
    return { allowed: false, retryAfter };
  }
  return { allowed: true };
}

// ---- Password Hashing ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, stored) {
  if (!stored || !stored.salt || !stored.hash) return false;
  try {
    const derived = crypto.scryptSync(password, stored.salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(stored.hash, 'hex'));
  } catch {
    return false;
  }
}

// ---- Cookie Helpers ----
function parseCookies(req) {
  const h = req.headers.cookie;
  if (!h) return {};
  const out = {};
  for (const part of h.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.substring(0, idx).trim()] = decodeURIComponent(part.substring(idx + 1).trim());
  }
  return out;
}

function signCookieVal(sessionId) {
  const sig = crypto.createHmac('sha256', AUTH.sessionSecret).update(sessionId).digest('base64url');
  return `${sessionId}.${sig}`;
}

function unsignCookieVal(signed) {
  const dot = signed.lastIndexOf('.');
  if (dot === -1) return null;
  const sid = signed.substring(0, dot);
  const sig = signed.substring(dot + 1);
  const expected = crypto.createHmac('sha256', AUTH.sessionSecret).update(sid).digest('base64url');
  if (expected.length !== sig.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  } catch { return null; }
  return sid;
}

function getSession(req) {
  if (!AUTH_ACTIVE) return null;
  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  const sid = unsignCookieVal(raw);
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) { sessions.delete(sid); return null; }
  return { ...s, id: sid };
}

function createSession(email, provider) {
  const sid = crypto.randomUUID();
  sessions.set(sid, { email, provider, createdAt: Date.now() });
  return sid;
}

// ---- Auth Route Helpers ----
function setSessionCookie(res, sessionId) {
  const signed = signCookieVal(sessionId);
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(signed)}; ` +
    `Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

function redirect(res, location) {
  res.setHeader('Location', location);
  res.writeHead(302);
  res.end();
}

function jsonResponse(res, status, obj) {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(obj));
}

// ---- Auth Route Handlers ----
function serveLoginPage(res, errorMsg) {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8');
    if (!AUTH_ACTIVE) {
      // No auth config → redirect straight to dash
      redirect(res, '/dash');
      return;
    }
    // Check which auth methods are available
    const hasPassword = !!(AUTH.password && AUTH.password.hash);
    const hasGoogle = !!(AUTH.google && AUTH.google.clientId);
    if (!hasPassword && !hasGoogle) {
      // No methods configured — show setup
      html = html.replace('<p>Sign in to continue</p>',
        '<p style="color:#a84747;">No authentication methods configured. Edit auth.json to set a password or Google OAuth credentials.</p>');
    }
    // Inject method availability into the page
    const pwAvailable = hasPassword ? 'true' : 'false';
    const googAvailable = hasGoogle ? 'true' : 'false';
    html = html.replace('</body>',
      `<script>window.__AUTH_PASSWORD=${pwAvailable};window.__AUTH_GOOGLE=${googAvailable};</script></body>`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    res.writeHead(200);
    res.end(html);
  } catch (e) {
    res.writeHead(500);
    res.end('Login page error');
  }
}

function getOAuthRedirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `${SWITCHER_HOST}:${SWITCHER_PORT}`;
  return `${proto}://${host}/auth/google/callback`;
}

function handleGoogleLogin(req, res) {
  if (!AUTH || !AUTH.google || !AUTH.google.clientId) {
    serveLoginPage(res, 'Google authentication is not configured.');
    return;
  }
  const state = crypto.randomBytes(16).toString('hex');
  sessions.set(`oauth:${state}`, { createdAt: Date.now() });
  const params = new URLSearchParams({
    client_id: AUTH.google.clientId,
    redirect_uri: getOAuthRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
  });
  redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

function handleGoogleCallback(req, res) {
  const url = new URL(req.url, `http://${SWITCHER_HOST}:${SWITCHER_PORT}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    redirect(res, `/auth/login?error=${encodeURIComponent('Google sign-in was cancelled or denied.')}`);
    return;
  }

  if (!state || !sessions.has(`oauth:${state}`)) {
    redirect(res, `/auth/login?error=${encodeURIComponent('Invalid state token. Please try again.')}`);
    return;
  }
  sessions.delete(`oauth:${state}`);

  if (!code) {
    redirect(res, `/auth/login?error=${encodeURIComponent('No authorization code received.')}`);
    return;
  }

  // Exchange code for token
  const tokenBody = new URLSearchParams({
    code,
    client_id: AUTH.google.clientId,
    client_secret: AUTH.google.clientSecret,
    redirect_uri: getOAuthRedirectUri(req),
    grant_type: 'authorization_code',
  }).toString();

  const tokenReq = https.request({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(tokenBody),
    },
  }, (tokenRes) => {
    let data = '';
    tokenRes.on('data', (c) => { data += c; });
    tokenRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.error) {
          console.error('Google token error:', parsed);
          redirect(res, `/auth/login?error=${encodeURIComponent('Google authentication failed.')}`);
          return;
        }
        // Fetch user info
        https.get({
          hostname: 'www.googleapis.com',
          path: '/oauth2/v3/userinfo',
          headers: { 'Authorization': `Bearer ${parsed.access_token}` },
        }, (infoRes) => {
          let infoData = '';
          infoRes.on('data', (c) => { infoData += c; });
          infoRes.on('end', () => {
            try {
              const user = JSON.parse(infoData);
              if (!user.email) {
                redirect(res, `/auth/login?error=${encodeURIComponent('Could not retrieve email from Google.')}`);
                return;
              }
              // Check allowed emails
              const allowed = AUTH.allowedEmails || [];
              if (allowed.length > 0 && !allowed.includes(user.email)) {
                redirect(res, `/auth/login?error=${encodeURIComponent(`Email ${user.email} is not authorized.`)}`);
                return;
              }
              // Success — create session
              const sid = createSession(user.email, 'google');
              setSessionCookie(res, sid);
              redirect(res, '/dash');
            } catch (e) {
              redirect(res, `/auth/login?error=${encodeURIComponent('Failed to parse user info from Google.')}`);
            }
          });
        }).on('error', () => {
          redirect(res, `/auth/login?error=${encodeURIComponent('Failed to reach Google API.')}`);
        });
      } catch (e) {
        redirect(res, `/auth/login?error=${encodeURIComponent('Invalid response from Google.')}`);
      }
    });
  });

  tokenReq.on('error', () => {
    redirect(res, `/auth/login?error=${encodeURIComponent('Failed to reach Google token endpoint.')}`);
  });
  tokenReq.write(tokenBody);
  tokenReq.end();
}

function handlePasswordLogin(req, res) {
  // Rate limit check before any processing
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    jsonResponse(res, 429, { ok: false, error: 'Too many login attempts. Please wait and try again.' });
    return;
  }

  return readBody(req).then(body => {
    let password;
    try { password = JSON.parse(body).password; } catch { password = ''; }
    if (!password) {
      jsonResponse(res, 400, { ok: false, error: 'Password is required.' });
      return;
    }
    if (!AUTH || !AUTH.password || !AUTH.password.hash) {
      jsonResponse(res, 400, { ok: false, error: 'Password authentication is not configured.' });
      return;
    }
    if (!verifyPassword(password, AUTH.password)) {
      jsonResponse(res, 401, { ok: false, error: 'Invalid password.' });
      return;
    }
    const sid = createSession('admin', 'password');
    setSessionCookie(res, sid);
    jsonResponse(res, 200, { ok: true, redirect: '/dash' });
  });
}

function handleLogout(req, res) {
  const session = getSession(req);
  if (session) sessions.delete(session.id);
  clearSessionCookie(res);
  redirect(res, '/auth/login');
}

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
    const args = ['http', String(SWITCHER_PORT), '--log=stdout', '--log-format=json'];
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

function wordWrap(s, width) {
  if (!s || s.length <= width) return s;
  const lines = [];
  let remaining = s;
  while (remaining.length > width) {
    // Try to break at last space within width, otherwise hard-break
    let breakAt = remaining.lastIndexOf(' ', width);
    if (breakAt === -1 || breakAt < width / 2) breakAt = width;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines.join('\n');
}

// Auto-detect the auth header type from the credential value or config field.
// "api-key" tokens start with "sk-ant-api" — use x-api-key header.
// "bearer" tokens (OAuth from web login) start with "sk-ant-oat" or are JWT-like.
function detectCredentialType(value) {
  if (!value || typeof value !== 'string') return 'api-key';
  if (value.startsWith('sk-ant-api')) return 'api-key';
  if (value.startsWith('sk-ant-oat')) return 'bearer';
  if (value.startsWith('sk-')) return 'api-key'; // generic sk- prefix → api-key
  // JWT-like tokens (eyJ...) or long random strings → bearer
  if (value.startsWith('eyJ') || value.length > 200) return 'bearer';
  return 'api-key';
}

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
    let credentialType = (t.credentialType && t.credentialType !== 'auto') ? t.credentialType : null; // explicit override from config, 'auto' means detect
    try {
      const resolvedPath = resolveTilde(t.credentialPath);
      const raw = fs.readFileSync(resolvedPath, 'utf8');
      const parsed = JSON.parse(raw);

      // Try primary key first, then fallback keys if empty
      const keysToTry = [t.credentialKey, ...(t.fallbackKeys || ['oauthToken', 'accessToken', 'token'])];
      for (const key of keysToTry) {
        credential = getNestedValue(parsed, key);
        if (typeof credential === 'string' && credential.length > 0) {
          if (!credentialType) credentialType = detectCredentialType(credential);
          break;
        }
        credential = null;
      }

      if (!credential) {
        credentialError = `No credential found. Tried keys: ${keysToTry.join(', ')}`;
      }
    } catch (e) {
      credentialError = e.message;
    }

    // Resolve credential type: explicit config wins, else detect from value
    if (!credentialType && credential) credentialType = detectCredentialType(credential);
    if (!credentialType) credentialType = 'api-key'; // default

    schedulerState.targets.push({
      name: t.name,
      type: t.type,
      model: t.model,
      credential,
      credentialType,
      credentialError,
      lastRun: null,
      status: credential ? 'pending' : 'error',
      credentialOK: !!credential,
      responsePreview: null,
      error: credentialError,
    });
  }
  for (const t of schedulerState.targets) {
    if (t.credential) {
      console.log(`  "${t.name}" — credential OK (${t.credentialType}, ${t.credential.slice(0, 12)}...)`);
    } else {
      console.log(`  "${t.name}" — FAILED`);
      console.log(`    reason: ${wordWrap(t.credentialError || 'unknown', 70)}`);
    }
  }
  const ok = schedulerState.targets.filter(t => t.credential).length;
  console.log(`Scheduler: ${schedulerState.targets.length} target(s) — ${ok} OK, ${schedulerState.targets.length - ok} failed`);
} else if (SCHEDULER_CONFIG) {
  console.log('Scheduler: enabled but no targets configured');
}

// ---- API call functions ----

function callAI(target, prompt) {
  if (target.type === 'claude') {
    return callClaude(target, prompt);
  } else if (target.type === 'codex') {
    // Codex auth tokens are ChatGPT web-session JWTs, not OpenAI API keys.
    // The OpenAI API rejects them with "quota exceeded". Use CLI directly instead.
    return callCodexCLI(prompt);
  } else if (target.type === 'antigravity') {
    // Antigravity uses Google OAuth tokens — CLI subprocess only.
    return callAntigravityCLI(prompt, target.model);
  }
  throw new Error(`Unknown target type: ${target.type}`);
}

function callClaude(target, prompt) {
  const body = JSON.stringify({
    model: target.model,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });

  // Use x-api-key for API key auth, Authorization: Bearer for OAuth tokens
  const authHeaders = {};
  if (target.credentialType === 'bearer') {
    authHeaders['Authorization'] = `Bearer ${target.credential}`;
  } else {
    authHeaders['x-api-key'] = target.credential;
  }

  const options = {
    hostname: 'api.anthropic.com',
    port: 443,
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body)
    },
    timeout: 30000
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let detail = `status ${res.statusCode}`;
          try {
            const errData = JSON.parse(raw);
            detail = errData?.error?.message || errData?.error?.type || detail;
          } catch {}
          reject(new Error(`Claude API ${detail}`));
          return;
        }
        try {
          const data = JSON.parse(raw);
          const text = data?.content?.[0]?.text;
          if (typeof text !== 'string' || text.length === 0) {
            reject(new Error('Claude returned empty response'));
            return;
          }
          resolve(text);
        } catch (e) {
          reject(new Error(`Claude response parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Claude network error: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Claude request timed out (30s)')); });
    req.write(body);
    req.end();
  });
}

function callCodex(target, prompt) {
  const body = JSON.stringify({
    model: target.model,
    max_tokens: 500,
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
    timeout: 30000
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let detail = `status ${res.statusCode}`;
          let errorCode = null;
          try {
            const errData = JSON.parse(raw);
            errorCode = errData?.error?.code || null;
            detail = errData?.error?.message || errData?.error?.type || detail;
          } catch {}
          // Include HTTP status + error code for easier diagnosis
          const suffix = errorCode ? ` (code: ${errorCode})` : '';
          reject(new Error(`OpenAI API ${detail}${suffix}`));
          return;
        }
        try {
          const data = JSON.parse(raw);
          const text = data?.choices?.[0]?.message?.content;
          if (typeof text !== 'string' || text.length === 0) {
            reject(new Error('OpenAI returned empty response'));
            return;
          }
          resolve(text);
        } catch (e) {
          reject(new Error(`OpenAI response parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`OpenAI network error: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI request timed out (30s)')); });
    req.write(body);
    req.end();
  });
}

// Resolve full path to a globally-installed npm CLI tool (e.g. claude, codex).
// Server processes may not inherit the user's terminal PATH on Windows.
// Prefers .exe (can run without shell), falls back to .cmd/.ps1 (needs shell).
function resolveCliPath(name) {
  const candidates = [];

  // Home .local/bin (common for standalone exe installs like Claude)
  candidates.push(path.join(os.homedir(), '.local', 'bin', `${name}.exe`));
  candidates.push(path.join(os.homedir(), '.local', 'bin', `${name}.cmd`));
  candidates.push(path.join(os.homedir(), '.local', 'bin', name));

  // npm global bin (Windows: %APPDATA%/npm)
  const npmBin = path.join(os.homedir(), 'AppData', 'Roaming', 'npm');
  candidates.push(path.join(npmBin, `${name}.exe`));
  candidates.push(path.join(npmBin, `${name}.cmd`));
  candidates.push(path.join(npmBin, `${name}.ps1`));
  candidates.push(path.join(npmBin, name));

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  // Fallback: hope it's in PATH
  return name;
}

// Check if a path requires a shell to execute on Windows (.cmd/.ps1/.bat wrappers)
function needsShell(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.cmd' || ext === '.ps1' || ext === '.bat';
}

// Fallback: use the `claude` CLI tool directly (uses OAuth/subscription auth from `claude login`).
// Useful when the API key has no credits but the user has an active subscription.
// Uses async spawn to avoid blocking the event loop.
function callClaudeCLI(prompt) {
  const { spawn } = require('child_process');
  const claudePath = resolveCliPath('claude');
  return new Promise((resolve, reject) => {
    const child = spawn(claudePath, [
      '-p', prompt,
      '--print',
      '--output-format', 'text'
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: needsShell(claudePath)
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Claude CLI timed out (90s)'));
    }, 90000);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim().slice(0, 200) || `exit code ${code}`;
        reject(new Error(`Claude CLI error: ${detail}`));
        return;
      }
      const text = stdout.trim();
      if (!text) {
        reject(new Error('Claude CLI returned empty response'));
        return;
      }
      resolve(text);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error(`Claude CLI not found: 'claude' command not in PATH`));
      } else {
        reject(new Error(`Claude CLI spawn error: ${err.message}`));
      }
    });
  });
}

// Codex CLI: uses ChatGPT subscription auth (Google OAuth) from `codex login`.
// The OpenAI API rejects ChatGPT web-session tokens — CLI is the only working path.
// Calls codex.js directly with node.exe; discards stdout (goes to -o file) to avoid
// buffering issues with the large JSONL output.
function callCodexCLI(prompt) {
  const { spawn } = require('child_process');
  const codexScript = path.join(os.homedir(), 'AppData', 'Roaming', 'npm',
    'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(__dirname, '.tmp', `codex-output-${Date.now()}.txt`);
    const child = spawn(process.execPath, [
      codexScript,
      'exec', prompt,
      '--json',
      '-o', tmpFile,
      '--ephemeral',
      '--skip-git-repo-check',
      '--color', 'never'
    ], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']  // discard stdout, keep stderr
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      try { fs.unlinkSync(tmpFile); } catch {}
      reject(new Error('Codex CLI timed out (60s)'));
    }, 60000);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        try { fs.unlinkSync(tmpFile); } catch {}
        const detail = stderr.trim().slice(0, 200) || `exit code ${code}`;
        reject(new Error(`Codex CLI error: ${detail}`));
        return;
      }
      try {
        const text = fs.readFileSync(tmpFile, 'utf8').trim();
        fs.unlinkSync(tmpFile);
        if (!text) {
          reject(new Error('Codex CLI returned empty response'));
          return;
        }
        resolve(text);
      } catch (e) {
        try { fs.unlinkSync(tmpFile); } catch {}
        reject(new Error(`Codex CLI output read error: ${e.message}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch {}
      if (err.code === 'ENOENT') {
        reject(new Error(`Codex CLI not found: node or codex.js not accessible`));
      } else {
        reject(new Error(`Codex CLI spawn error: ${err.message}`));
      }
    });
  });
}

// Antigravity CLI (agy): standalone Go binary at %LOCALAPPDATA%/agy/bin/agy.exe.
// Uses OAuth via Windows keyring. Response goes to TUI, not stdout, so we
// extract it from the SQLite conversation DB that agy writes on exit.
function callAntigravityCLI(prompt, model) {
  const { spawn } = require('child_process');
  const Database = require('better-sqlite3');

  const conversationsDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
  const lastConvPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json');

  // Record existing DBs as fallback
  let before;
  try { before = new Set(fs.readdirSync(conversationsDir).filter(f => f.endsWith('.db'))); }
  catch { before = new Set(); }

  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--print-timeout', '60s'
    ];
    if (model) args.push('--model', model);
    const child = spawn('agy', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Antigravity CLI timed out (60s)'));
    }, 60000);

    child.on('close', (code) => {
      clearTimeout(timer);

      // Discover the conversation DB. Primary: last_conversations.json.
      // Fallback: find a new .db file that appeared during this session.
      let convId = null;
      try {
        // Primary: last_conversations.json maps workspace paths to conversation IDs.
        // IDs are bare UUIDs (no .db extension) — the actual files are UUID.db.
        const lastConv = JSON.parse(fs.readFileSync(lastConvPath, 'utf8'));
        const cwd = process.cwd().replace(/\\/g, '/');
        for (const [wsPath, id] of Object.entries(lastConv)) {
          if (wsPath.replace(/\\/g, '/') === cwd) { convId = id; break; }
        }
      } catch {}

      // Fallback: find a new DB file (filenames already include .db)
      if (!convId) {
        try {
          const after = fs.readdirSync(conversationsDir).filter(f => f.endsWith('.db'));
          const newDbs = after.filter(f => !before.has(f));
          if (newDbs.length === 1) {
            convId = newDbs[0];
          } else if (newDbs.length > 1) {
            let bestSteps = -1;
            for (const dbFile of newDbs) {
              try {
                const db = new Database(path.join(conversationsDir, dbFile), { readonly: true });
                const row = db.prepare('SELECT count(*) as c FROM steps').get();
                db.close();
                if (row.c > bestSteps) { bestSteps = row.c; convId = dbFile; }
              } catch {}
            }
          }
        } catch {}
      }

      // Ensure convId has .db extension. last_conversations.json stores bare UUIDs;
      // directory listings already include the extension.
      if (convId && !convId.endsWith('.db')) convId += '.db';

      if (!convId) {
        const detail = stderr.trim().slice(0, 200) || (code !== 0 ? `exit code ${code}` : 'no conversation DB found');
        reject(new Error(`Antigravity CLI error: ${detail}`));
        return;
      }

      // Extract model response from the conversation DB
      const dbPath = path.join(conversationsDir, convId);
      if (!fs.existsSync(dbPath)) {
        reject(new Error(`Antigravity CLI: conversation DB not found at ${dbPath}`));
        return;
      }

      let db;
      try {
        db = new Database(dbPath, { readonly: true });
        const rows = db.prepare(
          'SELECT step_payload FROM steps WHERE step_type IN (15, 23) ORDER BY CASE WHEN step_type = 15 THEN 0 ELSE 1 END, idx DESC'
        ).all();

        if (rows.length === 0) {
          reject(new Error('Antigravity CLI: no model response steps in conversation'));
          return;
        }

        let responseText = '';
        for (const row of rows) {
          responseText = extractProtoField1(row.step_payload);
          if (responseText) break;
        }

        if (!responseText) {
          reject(new Error('Antigravity CLI: could not extract response from conversation DB'));
          return;
        }
        resolve(responseText);
      } catch (e) {
        reject(new Error(`Antigravity CLI DB error: ${e.message}`));
      } finally {
        if (db) { try { db.close(); } catch {} }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error('Antigravity CLI not found: agy is not on PATH'));
      } else {
        reject(new Error(`Antigravity CLI spawn error: ${err.message}`));
      }
    });
  });
}

// ---- Protobuf helpers for extracting text from agy conversation DBs ----

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  while (offset < buf.length) {
    const byte = buf[offset++];
    result |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { value: result >>> 0, offset };
    shift += 7;
  }
  return { value: 0, offset };
}

// Extract the model's response text from a protobuf step_payload.
// Walks the wire format recursively, collects all UTF-8 strings, then filters.
function extractProtoField1(buf) {
  const texts = [];
  _walkProtoAllFields(buf, 0, texts);

  // Also do a raw ASCII scan as fallback — catches text in non-standard field encoding
  const rawRuns = extractAsciiRuns(buf);
  for (const t of rawRuns) { if (t.length >= 2) texts.push(t); }

  // Filter: skip UUIDs, hex blobs, JSON, file contents, and garbage
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const hexRe = /^[0-9a-f]{20,}$/i;
  const garbageRe = /[^\x20-\x7e\n\r\t]/;

  // Collect candidates
  const candidates = [];
  for (const t of texts) {
    if (t.length < 1 || t.length > 5000) continue;
    if (uuidRe.test(t)) continue;
    if (t.includes('$')) continue; // protobuf artifact (e.g. "b$cf332efb-...")
    if (hexRe.test(t)) continue;
    if (t[0] === '{' || t[0] === '[' || t[0] === '<') continue;
    if (garbageRe.test(t)) continue;
    if (/^(syntax|=|\/\/|#|--|import |package |func |class |def )/.test(t)) continue;
    candidates.push(t);
  }

  // Prefer: looks like natural language (contains spaces, or all-lowercase short text)
  for (const t of candidates) {
    if (t.includes(' ') && t.length <= 2000) return t;
  }
  // Then: short all-lowercase text (like "hi"), excluding camelCase identifiers
  const camelRe = /[a-z][A-Z]/;
  for (const t of candidates) {
    if (t.length >= 1 && t.length <= 200 && !camelRe.test(t) && /^[a-z]/.test(t)) return t;
  }
  // Fallback: any short text that contains at least one letter (skip pure noise like "@:")
  for (const t of candidates) {
    if (t.length >= 1 && t.length <= 200 && /[a-zA-Z]/.test(t)) return t;
  }
  // Last resort: any text
  for (const t of candidates) {
    return t;
  }
  return '';
}

// Raw ASCII extraction: find all runs of printable characters in a buffer.
// Catches text in deeply nested or non-standard protobuf field encodings.
function extractAsciiRuns(buf) {
  const runs = [];
  let run = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 0x20 && b <= 0x7e) {
      run += String.fromCharCode(b);
    } else {
      if (run.length >= 2) runs.push(run);
      run = '';
    }
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

function _walkProtoAllFields(buf, offset, texts) {
  while (offset < buf.length) {
    const { value: tag, offset: off2 } = readVarint(buf, offset);
    offset = off2;
    if (tag === 0) continue; // field 0 used by agy internally
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === 0) {
      // varint — skip
      const { offset: off3 } = readVarint(buf, offset);
      offset = off3;
    } else if (wireType === 2) {
      // length-delimited — could be string, bytes, or nested message
      const { value: length, offset: off3 } = readVarint(buf, offset);
      offset = off3;
      if (offset + length > buf.length) break;
      const data = buf.slice(offset, offset + length);
      offset += length;
      // Try decoding as UTF-8 text for any field number
      if (length >= 1 && length <= 10000) {
        try {
          const text = data.toString('utf8');
          if (text.length > 0 && text.length < length * 3) texts.push(text);
        } catch {}
      }
      // Recurse into nested messages that aren't plain text
      if (length > 2 && data[0] !== 0x7b && data[0] !== 0x5b) {
        _walkProtoAllFields(data, 0, texts);
      }
    } else if (wireType === 5) {
      offset += 4; // 32-bit fixed
    } else if (wireType === 1) {
      offset += 8; // 64-bit fixed
    } else {
      break;
    }
  }
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
  // Codex and Antigravity use CLI directly (have their own auth). Claude needs a credential for API fallback.
  if (target.type !== 'codex' && target.type !== 'antigravity' && !target.credential) {
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
  } catch (apiErr) {
    // If API call fails and this is a Claude target, try CLI fallback
    if (target.type === 'claude') {
      try {
        console.log(`  "${target.name}" — API failed, trying CLI fallback...`);
        const cliResponse = await callClaudeCLI(prompt);
        target.status = 'success';
        target.responsePreview = cliResponse;
        target.error = null;
        target.lastRun = new Date().toISOString();
        return;
      } catch (cliErr) {
        target.status = 'error';
        target.error = `API: ${apiErr.message}; CLI: ${cliErr.message}`;
        target.responsePreview = null;
      }
    } else {
      target.status = 'error';
      target.error = apiErr.message;
      target.responsePreview = null;
    }
  }
  target.lastRun = new Date().toISOString();
}

// Tick counter for heartbeat — log every 60th tick (~30 min) even when idle
let _schedulerTickCount = 0;
const SCHEDULER_DEBUG = !!process.env.SCHEDULER_DEBUG;

async function fireAllTargets(force = false) {
  _schedulerTickCount++;
  const slotKey = getSlotKey();
  const minute = new Date().getMinutes();
  const second = new Date().getSeconds();

  // Heartbeat: log every ~30 min (60 ticks) even when idle, so we know the timer is alive
  if (_schedulerTickCount % 60 === 0) {
    console.log(`Scheduler: heartbeat tick #${_schedulerTickCount}, slot=${slotKey}, minute=${minute}, lastFired=${schedulerState.lastFiredSlot || 'never'}`);
  }

  if (!force) {
    if (schedulerState.lastFiredSlot === slotKey) {
      if (SCHEDULER_DEBUG) console.log(`Scheduler: skip — slot ${slotKey} already fired`);
      return;
    }
    if (!schedulerState.minuteOffsets.includes(minute)) {
      if (SCHEDULER_DEBUG) console.log(`Scheduler: skip — minute ${minute} not in offsets [${schedulerState.minuteOffsets.join(',')}]`);
      return;
    }
    // Guard: skip first second of a new minute to avoid race with tick timing
    if (second < 1) {
      if (SCHEDULER_DEBUG) console.log(`Scheduler: skip — second ${second} too early, waiting for next tick`);
      return;
    }
  }

  schedulerState.lastFiredSlot = slotKey;
  console.log(`Scheduler: firing at ${slotKey}`);

  // Fire all targets in parallel — one timeout does not block the other
  await Promise.allSettled(
    schedulerState.targets.map(t => fireOneTarget(t, schedulerState.prompt))
  );

  // Log per-target results
  for (const t of schedulerState.targets) {
    if (t.status === 'success') {
      console.log(`  ${t.name}: OK`);
      console.log(`    "${t.responsePreview || ''}"`);
    } else {
      console.log(`  ${t.name}: FAIL`);
      console.log(`    ${wordWrap(t.error || 'unknown error', 70)}`);
    }
  }
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
  // Log resolved CLI paths so we can verify they're found
  console.log(`  claude CLI: ${resolveCliPath('claude')}`);
  console.log(`  codex CLI:  ${resolveCliPath('codex')}`);
  console.log(`  antigravity CLI: agy (v1.0.5)`);
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
let firstSeenHealthy = {};  // { configuredPort: timestamp_ms } — set on down→ok transition

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

// ---- Process Detection ----
const RUNTIME_KEYWORDS = {
  Bun: 'bun.exe',
  Node: 'node.exe', 'Node.js': 'node.exe', Express: 'node.exe', Vite: 'node.exe',
  Next: 'node.exe', Nuxt: 'node.exe', Hono: 'node.exe', Fastify: 'node.exe',
  React: 'node.exe', tsx: 'node.exe',
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
    const netstatOut = await execFileAsync('netstat', ['-ano']);
    let pid = null;
    for (const line of netstatOut.split('\n')) {
      const re = new RegExp(`:${port}\\s+.*LISTENING\\s+(\\d+)`);
      const m = line.match(re);
      if (m) { pid = m[1]; break; }
    }
    if (!pid) return null;

    const tasklistOut = await execFileAsync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh']);
    const csvMatch = tasklistOut.match(/^"([^"]+)"/m);
    if (!csvMatch) return null;
    const exe = csvMatch[1].toLowerCase();

    const runtime = EXE_TO_RUNTIME[exe] || exe.replace('.exe', '');
    return { exe, runtime, pid };
  } catch {
    return null;
  }
}

function getStackDisplay(server, processInfo) {
  const configStack = server.stack;
  if (!configStack) {
    return {
      display: processInfo ? processInfo.runtime : 'Unknown',
      source: 'process',
      configValue: null,
      processValue: processInfo ? processInfo.runtime : null,
      mismatch: false,
    };
  }
  if (!processInfo) {
    return {
      display: configStack,
      source: 'config',
      configValue: configStack,
      processValue: null,
      mismatch: false,
    };
  }
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
      return { startedAt: new Date(startedAt).toISOString(), seconds, source: 'process' };
    }
  }
  if (firstSeenHealthy[port]) {
    const seconds = Math.floor((Date.now() - firstSeenHealthy[port]) / 1000);
    return { startedAt: new Date(firstSeenHealthy[port]).toISOString(), seconds, source: 'proxy' };
  }
  return null;
}

async function discoverServer(server) {
  const configuredPort = server.port;
  const ok = await checkPort(configuredPort);

  let base;
  if (ok) {
    base = { name: server.name, configuredPort, actualPort: configuredPort,
             health: 'ok', status: 'ok', hasDevScript: !!server.devScript };
  } else {
    // Build set of all configured ports to skip during drift scan
    const configuredPorts = new Set(CONFIG.servers.map(s => s.port));

    // Fallback: scan ±SCAN_RANGE around configured port
    const start = Math.max(1, configuredPort - SCAN_RANGE);
    const end = configuredPort + SCAN_RANGE;
    let drifted = null;
    for (let p = start; p <= end; p++) {
      if (p === configuredPort) continue; // already checked
      if (configuredPorts.has(p)) continue; // skip other servers' configured ports
      if (await checkPort(p, 500)) {
        drifted = p;
        break;
      }
    }
    if (drifted) {
      base = { name: server.name, configuredPort, actualPort: drifted,
               health: 'ok', status: 'drifted', hasDevScript: !!server.devScript };
    } else {
      base = { name: server.name, configuredPort, actualPort: null,
               health: 'down', status: 'down', hasDevScript: !!server.devScript };
    }
  }

  // ---- Process detection, stack matching, uptime tracking ----
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
  // NOTE: ngrok-skip-browser-warning must be a REQUEST header from the client,
  // not a response header. Setting it here has no effect on ngrok's interstitial.
  // Bypass methods: (1) non-browser User-Agent, (2) request header, (3) paid account.
  // See docs/ai/references/ngrok-browser-warning.md

  const url = new URL(req.url, `http://${SWITCHER_HOST}:${SWITCHER_PORT}`);
  const pathname = url.pathname;
  console.log(`${new Date().toISOString().slice(11,19)} ${req.method} ${pathname}`);

  // ---- Security Headers (applied to all switcher responses; proxied content excluded) ----
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  const clientProto = req.headers['x-forwarded-proto'];
  if (clientProto === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // ---- Authentication Gate ----
  const isAuthRoute = pathname === '/auth/login' || pathname === '/auth/password' ||
    pathname === '/auth/google' || pathname === '/auth/google/callback' ||
    pathname === '/auth/logout';
  const isPublic = pathname === '/ngrok-skip-browser-warning' || isAuthRoute;

  const NO_AUTH = !!process.env.NO_AUTH;
  if (AUTH_ACTIVE && !isPublic && !NO_AUTH) {
    const session = getSession(req);
    if (!session) {
      // Redirect browser requests to login; API clients get 401
      const accept = req.headers.accept || '';
      if (accept.includes('text/html') || accept.includes('*/*')) {
        redirect(res, '/auth/login');
      } else {
        jsonResponse(res, 401, { error: 'Authentication required.' });
      }
      return;
    }
    // Attach session for downstream use
    req.__session = session;
  }

  // ---- Auth Routes ----
  if (isAuthRoute) {
    if (pathname === '/auth/login' && req.method === 'GET') {
      // If already logged in, redirect to dash
      if (AUTH && getSession(req)) {
        redirect(res, '/dash');
        return;
      }
      serveLoginPage(res);
      return;
    }
    if (pathname === '/auth/password' && req.method === 'POST') {
      await handlePasswordLogin(req, res);
      return;
    }
    if (pathname === '/auth/google' && req.method === 'GET') {
      handleGoogleLogin(req, res);
      return;
    }
    if (pathname === '/auth/google/callback' && req.method === 'GET') {
      handleGoogleCallback(req, res);
      return;
    }
    if (pathname === '/auth/logout' && req.method === 'POST') {
      handleLogout(req, res);
      return;
    }
  }

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

  if (pathname.match(/^\/api\/servers\/(\d+)\/start$/) && req.method === 'POST') {
    const portMatch = pathname.match(/^\/api\/servers\/(\d+)\/start$/);
    const port = parseInt(portMatch[1]);
    const serverEntry = CONFIG.servers.find(s => s.port === port);

    if (!serverEntry) {
      res.setHeader('Content-Type', 'application/json');
        res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: 'Unknown port' }));
      return;
    }

    if (!serverEntry.devScript) {
      res.setHeader('Content-Type', 'application/json');
        res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: `No devScript configured for ${serverEntry.name}` }));
      return;
    }

    if (!fs.existsSync(serverEntry.devScript)) {
      res.setHeader('Content-Type', 'application/json');
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
        res.writeHead(200);
      res.end(JSON.stringify({ ok: true, starting: true }));
    } catch (e) {
      console.error(`Failed to start ${serverEntry.name}: ${e.message}`);
      res.setHeader('Content-Type', 'application/json');
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
    res.writeHead(200);
    res.end(JSON.stringify({
      enabled: schedulerState.enabled,
      minuteOffsets: schedulerState.minuteOffsets,
      nextFire: computeNextFire(),
      prompt: schedulerState.prompt,
      targets: schedulerState.targets.map(t => ({
        name: t.name,
        credentialOK: t.credentialOK,
        lastRun: t.lastRun,
        status: t.status,
        responsePreview: t.responsePreview,
        error: t.error
      }))
    }));
    return;
  }

  // Manual fire — triggers a scheduler run immediately (POST only)
  if (pathname === '/api/scheduler/fire' && req.method === 'POST') {
    console.log('Scheduler: manual fire requested');
    fireAllTargets(true).then(() => {
      console.log('Scheduler: manual fire complete');
    }).catch(err => {
      console.error('Scheduler: manual fire error:', err);
    });
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(202);
    res.end(JSON.stringify({ ok: true, message: 'Fire triggered' }));
    return;
  }

  // ---- OpenCode Config API ----

  // GET /api/opencode/models — spawn opencode CLI, parse NDJSON output
  if (pathname === '/api/opencode/models' && req.method === 'GET') {
    try {
      const opencodeConfigPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
      let providerConfig = {};
      try {
        const ocRaw = fs.readFileSync(opencodeConfigPath, 'utf8');
        const oc = JSON.parse(ocRaw);
        if (oc.provider) providerConfig = oc.provider;
      } catch { /* provider config optional */ }

      const result = await new Promise((resolve) => {
        const child = spawn(OPENCODE_PATH, ['models', '--verbose'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 10000
        });
        let stdout = '';
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.on('error', (err) => {
          resolve({
            ok: false,
            error: `opencode CLI not found or failed to start: ${err.message}. Is opencode installed and on your PATH?`
          });
        });
        child.on('close', (code) => {
          if (code !== 0) {
            resolve({ ok: false, error: `opencode CLI exited with code ${code}` });
          } else {
            try {
              const models = parseModelsNdjson(stdout);
              const providers = deriveProviders(models, providerConfig);
              resolve({ ok: true, models, providers });
            } catch (e) {
              resolve({ ok: false, error: `Failed to parse model output: ${e.message}` });
            }
          }
        });
      });
      jsonResponse(res, result.ok ? 200 : 500, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // GET /api/opencode/config — read subagent model assignments
  if (pathname === '/api/opencode/config' && req.method === 'GET') {
    try {
      const opencodeConfigPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
      if (!fs.existsSync(opencodeConfigPath)) {
        jsonResponse(res, 404, { ok: false, error: `opencode config not found at ${opencodeConfigPath}` });
        return;
      }
      const agents = readSubagentConfig(opencodeConfigPath);
      jsonResponse(res, 200, { ok: true, agents });
    } catch (e) {
      const msg = e.code === 'ENOENT'
        ? `opencode config not found at ${path.join(os.homedir(), '.config', 'opencode', 'opencode.json')}`
        : `Failed to read opencode config: ${e.message}`;
      jsonResponse(res, 500, { ok: false, error: msg });
    }
    return;
  }

  // POST /api/opencode/config — save subagent model assignments
  if (pathname === '/api/opencode/config' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch {
        jsonResponse(res, 400, { ok: false, error: 'Invalid JSON body' });
        return;
      }
      if (!payload.agents || typeof payload.agents !== 'object') {
        jsonResponse(res, 400, { ok: false, error: 'Missing or invalid "agents" field. Expected { agents: { name: "provider/model", ... } }' });
        return;
      }
      const opencodeConfigPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
      if (!fs.existsSync(opencodeConfigPath)) {
        jsonResponse(res, 404, { ok: false, error: `opencode config not found at ${opencodeConfigPath}` });
        return;
      }
      patchAgentModels(opencodeConfigPath, payload.agents);
      jsonResponse(res, 200, { ok: true, message: 'Config saved. Restart opencode for changes to take effect.' });
    } catch (e) {
      if (e.message.startsWith('Unknown agent:')) {
        jsonResponse(res, 400, { ok: false, error: e.message });
      } else {
        jsonResponse(res, 500, { ok: false, error: `Failed to save config: ${e.message}` });
      }
    }
    return;
  }

  // GET /api/opencode/favorites — return favorites list
  if (pathname === '/api/opencode/favorites' && req.method === 'GET') {
    try {
      if (!fs.existsSync(FAVORITES_PATH)) {
        jsonResponse(res, 200, { ok: true, favorites: [] });
        return;
      }
      const data = JSON.parse(fs.readFileSync(FAVORITES_PATH, 'utf8'));
      jsonResponse(res, 200, { ok: true, favorites: data.favorites || [] });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: `Failed to read favorites: ${e.message}` });
    }
    return;
  }

  // POST /api/opencode/favorites — add or remove a favorite
  if (pathname === '/api/opencode/favorites' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch {
        jsonResponse(res, 400, { ok: false, error: 'Invalid JSON body' });
        return;
      }
      const { action, provider, model } = payload;
      if (!action || !['add', 'remove'].includes(action)) {
        jsonResponse(res, 400, { ok: false, error: 'Missing or invalid "action". Must be "add" or "remove".' });
        return;
      }
      if (!provider || !model) {
        jsonResponse(res, 400, { ok: false, error: 'Missing "provider" or "model" field.' });
        return;
      }

      let favorites = [];
      if (fs.existsSync(FAVORITES_PATH)) {
        try {
          const data = JSON.parse(fs.readFileSync(FAVORITES_PATH, 'utf8'));
          favorites = data.favorites || [];
        } catch { /* corrupt file — start fresh */ }
      }

      if (action === 'add') {
        const exists = favorites.some(f => f.provider === provider && f.model === model);
        if (!exists) {
          favorites.push({ provider, model });
        }
      } else {
        favorites = favorites.filter(f => !(f.provider === provider && f.model === model));
      }

      const tmpPath = FAVORITES_PATH + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify({ favorites }, null, 2), 'utf8');
      fs.renameSync(tmpPath, FAVORITES_PATH);
      jsonResponse(res, 200, { ok: true, favorites });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: `Failed to save favorites: ${e.message}` });
    }
    return;
  }

  // ---- Provider API ----
  if (pathname === '/api/providers' && req.method === 'GET') {
    if (!refreshService) {
      return jsonResponse(res, 200, []);
    }
    return jsonResponse(res, 200, refreshService.listProviderRows());
  }

  if (pathname === '/api/providers/refresh' && req.method === 'POST') {
    if (!refreshService) {
      return jsonResponse(res, 503, { ok: false, error: 'Provider tracking not initialized.' });
    }
    try {
      await refreshService.refreshAll();
      return jsonResponse(res, 200, refreshService.listProviderRows());
    } catch (err) {
      return jsonResponse(res, 500, { ok: false, error: err.message });
    }
  }

  // ---- OpenCode Config Page ----
  if (pathname === '/opencode-config' && req.method === 'GET') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'opencode-config.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
      res.writeHead(200);
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Config page not found');
    }
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
        res.setHeader('Content-Security-Policy',
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
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

      // Remove switcher-level X-Frame-Options so proxied backends control framing
      res.removeHeader('X-Frame-Options');

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

// ---- OpenCode Config Helpers ----
function parseModelsNdjson(stdout) {
  const models = [];
  const lines = stdout.split('\n');
  let i = 0;
  while (i < lines.length) {
    let line = lines[i].trim();
    if (!line) { i++; continue; }
    if (!line.startsWith('{') && !line.startsWith('}') && !line.startsWith('[') && !line.startsWith('"')) {
      const idLine = line;
      i++;
      let jsonStr = '';
      while (i < lines.length) {
        const nextLine = lines[i];
        const trimmed = nextLine.trim();
        if (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('}') &&
            !trimmed.startsWith('[') && !trimmed.startsWith('"') && !trimmed.startsWith(',')) {
          break;
        }
        jsonStr += (jsonStr ? '\n' : '') + nextLine;
        i++;
        try {
          const meta = JSON.parse(jsonStr);
          models.push({
            id: meta.id || '',
            provider: meta.providerID || '',
            name: meta.name || idLine,
            capabilities: meta.capabilities || {},
            cost: meta.cost || {},
            limit: meta.limit || {}
          });
          break;
        } catch { /* keep accumulating */ }
      }
    } else {
      i++;
    }
  }
  return models;
}

function parseModelId(modelStr) {
  if (!modelStr || typeof modelStr !== 'string') return { provider: '', modelId: '' };
  const idx = modelStr.indexOf('/');
  if (idx === -1) return { provider: '', modelId: modelStr };
  return {
    provider: modelStr.substring(0, idx),
    modelId: modelStr.substring(idx + 1)
  };
}

function readSubagentConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  const agents = {};
  if (config.agent) {
    for (const [name, entry] of Object.entries(config.agent)) {
      if (entry.mode === 'subagent' && entry.model) {
        const parsed = parseModelId(entry.model);
        agents[name] = {
          model: entry.model,
          provider: parsed.provider,
          modelId: parsed.modelId
        };
      }
    }
  }
  return agents;
}

function patchAgentModels(configPath, updates) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  if (!config.agent) config.agent = {};

  for (const [name, model] of Object.entries(updates)) {
    if (!config.agent[name]) {
      throw new Error(`Unknown agent: ${name}`);
    }
    config.agent[name].model = model;
  }

  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmpPath, configPath);
}

function deriveProviders(models, providerConfig) {
  const seen = new Set();
  const providers = [];
  for (const m of models) {
    if (!m.provider || seen.has(m.provider)) continue;
    seen.add(m.provider);
    const pc = (providerConfig && providerConfig[m.provider]) || {};
    providers.push({
      id: m.provider,
      name: pc.name || m.provider,
      baseURL: (pc.options && pc.options.baseURL) || ''
    });
  }
  return providers;
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

  initProviderTracking();

  server.listen(SWITCHER_PORT, SWITCHER_HOST, () => {
    console.log(`Switcher listening on http://${SWITCHER_HOST}:${SWITCHER_PORT}`);
    startScheduler();
  });
}

main();
