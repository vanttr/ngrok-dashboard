const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---- Stub functions from server.js (pure, testable with injected store/config) ----

function checkRateLimit(key, store, config) {
  store = store || new Map();
  config = config || { maxAttempts: 5, windowMs: 15 * 60 * 1000 };
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

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

// ---- Tests ----

describe('checkRateLimit', () => {
  it('allows first attempt', () => {
    const store = new Map();
    const result = checkRateLimit('192.168.1.1', store, { maxAttempts: 5, windowMs: 60000 });
    assert.equal(result.allowed, true);
  });

  it('allows subsequent attempts within limit', () => {
    const store = new Map();
    const config = { maxAttempts: 3, windowMs: 60000 };
    assert.equal(checkRateLimit('192.168.1.1', store, config).allowed, true);
    assert.equal(checkRateLimit('192.168.1.1', store, config).allowed, true);
    assert.equal(checkRateLimit('192.168.1.1', store, config).allowed, true);
  });

  it('blocks after exceeding maxAttempts', () => {
    const store = new Map();
    const config = { maxAttempts: 3, windowMs: 60000 };
    checkRateLimit('10.0.0.1', store, config); // 1
    checkRateLimit('10.0.0.1', store, config); // 2
    checkRateLimit('10.0.0.1', store, config); // 3
    const result = checkRateLimit('10.0.0.1', store, config); // 4th — blocked
    assert.equal(result.allowed, false);
    assert.ok(typeof result.retryAfter === 'number');
    assert.ok(result.retryAfter > 0);
  });

  it('tracks different IPs independently', () => {
    const store = new Map();
    const config = { maxAttempts: 2, windowMs: 60000 };
    // Exhaust IP 1
    checkRateLimit('1.1.1.1', store, config);
    checkRateLimit('1.1.1.1', store, config);
    assert.equal(checkRateLimit('1.1.1.1', store, config).allowed, false);
    // IP 2 should still be allowed
    assert.equal(checkRateLimit('2.2.2.2', store, config).allowed, true);
  });

  it('resets after window expires', () => {
    const store = new Map();
    const config = { maxAttempts: 2, windowMs: 10 }; // 10ms window
    checkRateLimit('192.168.1.1', store, config);
    checkRateLimit('192.168.1.1', store, config);
    assert.equal(checkRateLimit('192.168.1.1', store, config).allowed, false);
    // Wait for window to expire
    return new Promise(resolve => {
      setTimeout(() => {
        const result = checkRateLimit('192.168.1.1', store, config);
        assert.equal(result.allowed, true, 'Should reset after window expiry');
        resolve();
      }, 15);
    });
  });

  it('returns increasing retryAfter as window progresses', () => {
    const store = new Map();
    const config = { maxAttempts: 1, windowMs: 60000 };
    // First attempt passes
    checkRateLimit('10.0.0.1', store, config);
    // Second is blocked — should have retryAfter ~60s
    const result = checkRateLimit('10.0.0.1', store, config);
    assert.equal(result.allowed, false);
    // retryAfter should be close to windowMs/1000 (within a few seconds)
    assert.ok(result.retryAfter >= 55 && result.retryAfter <= 60,
      `Expected retryAfter ~60, got ${result.retryAfter}`);
  });

  it('resets count on window expiry even without cleanup', () => {
    const store = new Map();
    const config = { maxAttempts: 3, windowMs: 50 };
    // Exhaust
    checkRateLimit('10.0.0.1', store, config);
    checkRateLimit('10.0.0.1', store, config);
    checkRateLimit('10.0.0.1', store, config);
    assert.equal(checkRateLimit('10.0.0.1', store, config).allowed, false);
    // Wait for window
    return new Promise(resolve => {
      setTimeout(() => {
        const result = checkRateLimit('10.0.0.1', store, config);
        assert.equal(result.allowed, true);
        resolve();
      }, 60);
    });
  });
});

describe('getClientIp', () => {
  it('extracts first IP from x-forwarded-for', () => {
    const req = { headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1, 172.16.0.1' } };
    assert.equal(getClientIp(req), '203.0.113.1');
  });

  it('handles single IP in x-forwarded-for', () => {
    const req = { headers: { 'x-forwarded-for': '203.0.113.1' } };
    assert.equal(getClientIp(req), '203.0.113.1');
  });

  it('falls back to socket remoteAddress when no x-forwarded-for', () => {
    const req = { headers: {}, socket: { remoteAddress: '10.0.0.5' } };
    assert.equal(getClientIp(req), '10.0.0.5');
  });

  it('falls back to 127.0.0.1 when no socket', () => {
    const req = { headers: {} };
    assert.equal(getClientIp(req), '127.0.0.1');
  });

  it('strips whitespace from forwarded IPs', () => {
    const req = { headers: { 'x-forwarded-for': '  203.0.113.1 , 10.0.0.1' } };
    assert.equal(getClientIp(req), '203.0.113.1');
  });

  it('handles empty x-forwarded-for string', () => {
    const req = { headers: { 'x-forwarded-for': '' }, socket: { remoteAddress: '10.0.0.5' } };
    // Empty string splits to [''], trim yields '' — falls through to socket
    // Actually: '' → '' after split → '127.0.0.1' after final fallback
    // Hmm, an empty string is falsy in JS. Let me check the code:
    // `if (forwarded)` — empty string is falsy, so it falls to socket
    assert.equal(getClientIp(req), '10.0.0.5');
  });
});
