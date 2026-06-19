// Security integration tests — start the server, make HTTP requests, verify
// rate limiting and security headers behave correctly.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEST_PORT = 19595;
const AUTH_FILE = path.join(__dirname, '..', 'auth.json');
const ORIG_AUTH = fs.existsSync(AUTH_FILE)
  ? fs.readFileSync(AUTH_FILE, 'utf8')
  : null;

let serverProcess;

function request(method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers || {}) };
    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: urlPath,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          json: (() => { try { return JSON.parse(body); } catch { return null; } })(),
        });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// Helper: make a password login attempt from a specific spoofed IP
function passwordAttempt(password, ip = '10.99.0.1') {
  return request('POST', '/auth/password', {
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': ip,
    },
    body: JSON.stringify({ password }),
  });
}

before(async () => {
  // Write a temp auth.json with a known password
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('testpass123', salt, 64).toString('hex');
  fs.writeFileSync(AUTH_FILE, JSON.stringify({
    password: { salt, hash },
    sessionSecret: crypto.randomBytes(32).toString('hex'),
  }, null, 2), 'utf8');

  return new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        NO_NGROK: '1',
        SWITCHER_PORT: String(TEST_PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    serverProcess.stdout.on('data', (data) => {
      if (data.toString().includes('listening on')) {
        started = true;
        setTimeout(resolve, 200);
      }
    });
    serverProcess.on('error', reject);
    setTimeout(() => {
      if (!started) reject(new Error('Server did not start in time'));
    }, 5000);
  });
});

after(() => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
  if (ORIG_AUTH !== null) {
    fs.writeFileSync(AUTH_FILE, ORIG_AUTH, 'utf8');
  } else {
    try { fs.unlinkSync(AUTH_FILE); } catch {}
  }
});

describe('Security Headers', () => {
  it('sets X-Content-Type-Options: nosniff on dashboard', async () => {
    const res = await request('GET', '/dash');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  it('sets X-Frame-Options: DENY on dashboard', async () => {
    const res = await request('GET', '/dash');
    assert.equal(res.headers['x-frame-options'], 'DENY');
  });

  it('sets Content-Security-Policy on dashboard', async () => {
    // Need to be authenticated to reach the dashboard route (where CSP is set).
    // First log in to get a session cookie.
    const loginRes = await request('POST', '/auth/password', {
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '10.9.0.1',
      },
      body: JSON.stringify({ password: 'testpass123' }),
    });
    const setCookie = loginRes.headers['set-cookie'];
    const cookieMatch = setCookie && setCookie[0] && setCookie[0].match(/(ngrok_dash_session=[^;]+)/);
    assert.ok(cookieMatch, 'Login should set a session cookie');

    const res = await request('GET', '/dash', {
      headers: { Cookie: cookieMatch[1] },
    });
    const csp = res.headers['content-security-policy'];
    assert.ok(csp, 'CSP header should be present');
    assert.ok(csp.includes("default-src 'self'"), `CSP should include default-src, got: ${csp}`);
    assert.ok(csp.includes("frame-ancestors 'none'"), `CSP should include frame-ancestors, got: ${csp}`);
    assert.ok(csp.includes("script-src 'self' 'unsafe-inline'"), `CSP should include script-src`);
    assert.ok(csp.includes("style-src 'self' 'unsafe-inline'"), `CSP should include style-src`);
  });

  it('sets CSP on login page', async () => {
    const res = await request('GET', '/auth/login');
    // Login page returns 200 with the form
    const csp = res.headers['content-security-policy'];
    assert.ok(csp, 'CSP should be present on login page');
  });

  it('sets X-Content-Type-Options on API responses', async () => {
    const res = await request('GET', '/api/health',
      { headers: { 'Accept': 'application/json' } });
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  it('does NOT set CORS wildcard on API responses', async () => {
    const res = await request('GET', '/api/health',
      { headers: { 'Accept': 'application/json' } });
    assert.equal(res.headers['access-control-allow-origin'], undefined,
      'Access-Control-Allow-Origin should not be present');
    assert.equal(res.headers['access-control-allow-methods'], undefined,
      'Access-Control-Allow-Methods should not be present');
  });

  it('does NOT respond to OPTIONS preflight with CORS headers', async () => {
    const res = await request('OPTIONS', '/api/servers');
    assert.notEqual(res.status, 204,
      'OPTIONS should not return 204 No Content (CORS preflight removed)');
    assert.equal(res.headers['access-control-allow-origin'], undefined,
      'CORS headers should not be on OPTIONS response');
  });

  it('does not set HSTS for plain HTTP connections', async () => {
    const res = await request('GET', '/dash');
    assert.equal(res.headers['strict-transport-security'], undefined,
      'HSTS should not be set on non-HTTPS connections');
  });
});

describe('Rate Limiting', () => {
  it('allows first attempt with wrong password (401)', async () => {
    const res = await passwordAttempt('wrongpass', '10.1.0.1');
    assert.equal(res.status, 401);
    assert.equal(res.json.ok, false);
  });

  it('allows up to 5 attempts from same IP', async () => {
    const ip = '10.1.0.2';
    for (let i = 0; i < 5; i++) {
      const res = await passwordAttempt('wrongpass', ip);
      assert.equal(res.status, 401, `Attempt ${i + 1}: expected 401, got ${res.status}`);
    }
  });

  it('blocks 6th attempt from same IP with 429', async () => {
    const ip = '10.1.0.3';
    // Exhaust the limit (5 attempts)
    for (let i = 0; i < 5; i++) {
      await passwordAttempt('wrongpass', ip);
    }
    // 6th should be blocked
    const res = await passwordAttempt('wrongpass', ip);
    assert.equal(res.status, 429, `Expected 429 rate limit, got ${res.status}`);
    assert.equal(res.json.ok, false);
    assert.ok(res.json.error.toLowerCase().includes('too many'),
      `Error should mention rate limiting: ${JSON.stringify(res.json)}`);
  });

  it('includes Retry-After header when rate limited', async () => {
    const ip = '10.1.0.4';
    for (let i = 0; i < 5; i++) {
      await passwordAttempt('wrongpass', ip);
    }
    const res = await passwordAttempt('wrongpass', ip);
    assert.equal(res.status, 429);
    const retryAfter = parseInt(res.headers['retry-after']);
    assert.ok(retryAfter > 0 && retryAfter <= 900,
      `Retry-After should be reasonable (1-900s), got ${retryAfter}`);
  });

  it('tracks different IPs independently', async () => {
    // Exhaust IP A
    for (let i = 0; i < 5; i++) {
      await passwordAttempt('wrongpass', '10.2.0.1');
    }
    const blocked = await passwordAttempt('wrongpass', '10.2.0.1');
    assert.equal(blocked.status, 429, 'IP A should be blocked');

    // IP B should still be allowed
    const allowed = await passwordAttempt('wrongpass', '10.2.0.2');
    assert.equal(allowed.status, 401, 'IP B should still be allowed (wrong password, not rate-limited)');
  });

  it('successful login with correct password works (from clean IP)', async () => {
    const res = await passwordAttempt('testpass123', '10.3.0.1');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.redirect, '/dash');
  });
});

describe('Auth Gate', () => {
  it('redirects unauthenticated browser requests to login', async () => {
    const res = await request('GET', '/dash', {
      headers: { 'Accept': 'text/html,application/xhtml+xml' },
    });
    assert.equal(res.status, 302, `Expected 302 redirect, got ${res.status}`);
    assert.equal(res.headers.location, '/auth/login');
  });

  it('logged-in session cookie allows access (cookie-based auth)', async () => {
    // First, log in to get a session cookie
    const loginRes = await passwordAttempt('testpass123', '10.4.0.1');
    assert.equal(loginRes.status, 200);

    // Extract session cookie
    const setCookie = loginRes.headers['set-cookie'];
    assert.ok(setCookie, 'Login should set a session cookie');
    const cookieMatch = setCookie[0] && setCookie[0].match(/(ngrok_dash_session=[^;]+)/);
    assert.ok(cookieMatch, 'Cookie should contain ngrok_dash_session');

    // Use the cookie for a dashboard request
    const dashRes = await request('GET', '/dash', {
      headers: { Cookie: cookieMatch[1] },
    });
    assert.equal(dashRes.status, 200, `Dashboard should return 200 with valid session, got ${dashRes.status}`);
  });
});
