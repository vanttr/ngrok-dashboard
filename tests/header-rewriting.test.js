const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---- Stub helpers from server.js (pure functions, no Node deps) ----

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteHtmlBody(html, targetHost, targetPort, publicOrigin) {
  if (!html) return html;
  const withPort = new RegExp(`https?://${escapeRegex(targetHost)}:${targetPort}`, 'gi');
  let rewritten = html.replace(withPort, publicOrigin);
  const bareHost = new RegExp(`https?://${escapeRegex(targetHost)}(?=/|"|'|\\s|>)`, 'gi');
  rewritten = rewritten.replace(bareHost, publicOrigin);
  return rewritten;
}

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

// ---- Tests ----

describe('rewriteOrigin', () => {
  const publicOrigin = 'https://abc123.ngrok-free.app';

  it('rewrites http://localhost:PORT to public origin', () => {
    assert.equal(
      rewriteOrigin('http://localhost:8086/dashboard', 'localhost', 8086, publicOrigin),
      'https://abc123.ngrok-free.app/dashboard'
    );
  });

  it('rewrites https://localhost:PORT to public origin', () => {
    assert.equal(
      rewriteOrigin('https://localhost:8086/dashboard', 'localhost', 8086, publicOrigin),
      'https://abc123.ngrok-free.app/dashboard'
    );
  });

  it('rewrites bare localhost without port', () => {
    assert.equal(
      rewriteOrigin('http://localhost/dashboard', 'localhost', 8086, publicOrigin),
      'https://abc123.ngrok-free.app/dashboard'
    );
  });

  it('does not rewrite non-localhost URLs', () => {
    assert.equal(
      rewriteOrigin('https://example.com/dashboard', 'localhost', 8086, publicOrigin),
      'https://example.com/dashboard'
    );
  });

  it('handles relative URLs (no rewrite needed)', () => {
    assert.equal(
      rewriteOrigin('/dashboard', 'localhost', 8086, publicOrigin),
      '/dashboard'
    );
  });

  it('preserves query strings in rewritten URLs', () => {
    assert.equal(
      rewriteOrigin('http://localhost:8086/callback?code=abc123', 'localhost', 8086, publicOrigin),
      'https://abc123.ngrok-free.app/callback?code=abc123'
    );
  });

  it('handles null/undefined gracefully', () => {
    assert.equal(rewriteOrigin(null, 'localhost', 8086, publicOrigin), null);
    assert.equal(rewriteOrigin(undefined, 'localhost', 8086, publicOrigin), undefined);
  });

  it('handles different port numbers', () => {
    assert.equal(
      rewriteOrigin('http://localhost:8099/api/ft/homeloan/calculate', 'localhost', 8099, publicOrigin),
      'https://abc123.ngrok-free.app/api/ft/homeloan/calculate'
    );
  });
});

describe('rewriteCookie', () => {
  it('strips Domain=localhost from cookies', () => {
    assert.equal(
      rewriteCookie('sessionid=abc123; Domain=localhost; Path=/', 'https://x.ngrok.app', true),
      'sessionid=abc123; Path=/; SameSite=None; Secure'
    );
  });

  it('strips Domain=localhost:PORT from cookies', () => {
    assert.equal(
      rewriteCookie('sessionid=abc123; Domain=localhost:8086; Path=/', 'https://x.ngrok.app', true),
      'sessionid=abc123; Path=/; SameSite=None; Secure'
    );
  });

  it('preserves Domain that is not localhost', () => {
    const result = rewriteCookie('sessionid=abc123; Domain=example.com; Path=/', 'https://x.ngrok.app', true);
    assert.ok(result.includes('Domain=example.com'));
  });

  it('adds SameSite=None and Secure for https tunnels', () => {
    const result = rewriteCookie('sessionid=abc123', 'https://x.ngrok.app', true);
    assert.ok(result.includes('SameSite=None'));
    assert.ok(result.includes('Secure'));
  });

  it('does not add SameSite=None for http (non-https) tunnels', () => {
    const result = rewriteCookie('sessionid=abc123', 'http://localhost:9595', false);
    assert.ok(!result.includes('SameSite'));
    assert.ok(!result.includes('Secure'));
  });

  it('changes SameSite=Lax to SameSite=None for https tunnels', () => {
    const result = rewriteCookie('sessionid=abc123; SameSite=Lax', 'https://x.ngrok.app', true);
    assert.ok(result.includes('SameSite=None'));
    assert.ok(!result.includes('SameSite=Lax'));
    assert.ok(result.includes('Secure'));
  });

  it('changes SameSite=Strict to SameSite=None for https tunnels', () => {
    const result = rewriteCookie('sessionid=abc123; SameSite=Strict', 'https://x.ngrok.app', true);
    assert.ok(result.includes('SameSite=None'));
    assert.ok(result.includes('Secure'));
  });

  it('preserves HttpOnly attribute', () => {
    const result = rewriteCookie('sessionid=abc123; HttpOnly; Domain=localhost', 'https://x.ngrok.app', true);
    assert.ok(result.includes('HttpOnly'));
  });

  it('preserves Path attribute', () => {
    const result = rewriteCookie('sessionid=abc123; Path=/app; Domain=localhost', 'https://x.ngrok.app', true);
    assert.ok(result.includes('Path=/app'));
  });

  it('handles null/undefined gracefully', () => {
    assert.equal(rewriteCookie(null, 'https://x.ngrok.app', true), null);
    assert.equal(rewriteCookie(undefined, 'https://x.ngrok.app', true), undefined);
  });

  it('preserves existing Secure flag without adding duplicate', () => {
    const result = rewriteCookie('sessionid=abc123; Secure; Domain=localhost', 'https://x.ngrok.app', true);
    const secureCount = (result.match(/Secure/gi) || []).length;
    assert.equal(secureCount, 1);
  });

  it('preserves Max-Age attribute', () => {
    const result = rewriteCookie('sessionid=abc123; Max-Age=3600; Domain=localhost', 'https://x.ngrok.app', true);
    assert.ok(result.includes('Max-Age=3600'));
  });
});

describe('escapeRegex', () => {
  it('escapes special regex characters', () => {
    assert.equal(escapeRegex('hello.world'), 'hello\\.world');
    assert.equal(escapeRegex('a+b*c?'), 'a\\+b\\*c\\?');
  });

  it('leaves normal strings unchanged', () => {
    assert.equal(escapeRegex('localhost'), 'localhost');
  });
});

describe('rewriteHtmlBody', () => {
  const pub = 'https://abc123.ngrok-free.app';

  it('rewrites hx-post with absolute localhost URL', () => {
    const html = '<button hx-post="http://localhost:8099/api/calculate">Go</button>';
    assert.ok(rewriteHtmlBody(html, 'localhost', 8099, pub).includes(`hx-post="${pub}/api/calculate"`));
  });

  it('rewrites form action with absolute localhost URL', () => {
    const html = '<form action="http://localhost:8086/login">';
    assert.ok(rewriteHtmlBody(html, 'localhost', 8086, pub).includes(`action="${pub}/login"`));
  });

  it('rewrites anchor href with absolute localhost URL', () => {
    const html = `<a href="http://localhost:8086/dashboard">Link</a>`;
    assert.ok(rewriteHtmlBody(html, 'localhost', 8086, pub).includes(`href="${pub}/dashboard"`));
  });

  it('rewrites JavaScript string literal with localhost URL', () => {
    const html = `<script>const api = 'http://localhost:8099/api';</script>`;
    assert.ok(rewriteHtmlBody(html, 'localhost', 8099, pub).includes(`'${pub}/api'`));
  });

  it('does not rewrite URLs for a different port', () => {
    const html = '<button hx-post="http://localhost:9000/api">Go</button>';
    const result = rewriteHtmlBody(html, 'localhost', 8099, pub);
    assert.ok(result.includes('http://localhost:9000/api'));
    assert.ok(!result.includes(pub));
  });

  it('does not rewrite non-localhost URLs', () => {
    const html = '<a href="https://example.com/path">Link</a>';
    const result = rewriteHtmlBody(html, 'localhost', 8099, pub);
    assert.ok(result.includes('https://example.com/path'));
  });

  it('rewrites multiple occurrences', () => {
    const html = '<a href="http://localhost:8099/a">A</a><a href="http://localhost:8099/b">B</a>';
    const result = rewriteHtmlBody(html, 'localhost', 8099, pub);
    assert.equal((result.match(new RegExp(pub, 'g')) || []).length, 2);
  });

  it('handles null/undefined gracefully', () => {
    assert.equal(rewriteHtmlBody(null, 'localhost', 8099, pub), null);
    assert.equal(rewriteHtmlBody(undefined, 'localhost', 8099, pub), undefined);
  });

  it('handles empty string', () => {
    assert.equal(rewriteHtmlBody('', 'localhost', 8099, pub), '');
  });

  it('rewrites bare localhost (no port) followed by slash', () => {
    const html = '<a href="http://localhost/dashboard">Link</a>';
    assert.ok(rewriteHtmlBody(html, 'localhost', 8099, pub).includes(`href="${pub}/dashboard"`));
  });
});