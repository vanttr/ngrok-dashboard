const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- Helpers under test ----

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

function loadCredential(credentialPath, credentialKey) {
  const resolved = resolveTilde(credentialPath);
  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw);
  const value = getNestedValue(parsed, credentialKey);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Credential key "${credentialKey}" not found or empty in ${credentialPath}`);
  }
  return value;
}

// ---- Tests ----

describe('resolveTilde', () => {
  it('resolves ~/ to homedir', () => {
    const result = resolveTilde('~/.claude/config.json');
    assert.ok(result.includes(os.homedir()));
    const expected = path.normalize(path.join(os.homedir(), '.claude/config.json'));
    assert.strictEqual(result, expected);
  });

  it('returns non-tilde paths unchanged', () => {
    assert.strictEqual(resolveTilde('/absolute/path'), '/absolute/path');
    assert.strictEqual(resolveTilde('relative/path'), 'relative/path');
  });
});

describe('getNestedValue', () => {
  const obj = { a: { b: { c: 'found' } }, x: 1 };

  it('traverses dotted path', () => {
    assert.strictEqual(getNestedValue(obj, 'a.b.c'), 'found');
  });

  it('returns top-level value', () => {
    assert.strictEqual(getNestedValue(obj, 'x'), 1);
  });

  it('returns undefined for missing path', () => {
    assert.strictEqual(getNestedValue(obj, 'a.b.z'), undefined);
    assert.strictEqual(getNestedValue(obj, 'nope'), undefined);
  });

  it('returns undefined for null/undefined input', () => {
    assert.strictEqual(getNestedValue(null, 'a.b'), undefined);
    assert.strictEqual(getNestedValue(undefined, 'a.b'), undefined);
  });
});

describe('loadCredential', () => {
  it('reads and returns a string credential', () => {
    const tmpFile = path.join(os.tmpdir(), 'test-cred-' + Date.now() + '.json');
    fs.writeFileSync(tmpFile, JSON.stringify({ apiKey: 'sk-test-123' }));
    try {
      const result = loadCredential(tmpFile, 'apiKey');
      assert.strictEqual(result, 'sk-test-123');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('resolves tilde paths', () => {
    const result = loadCredential('~/.claude/config.json', 'primaryApiKey');
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.length > 10);
  });
});
