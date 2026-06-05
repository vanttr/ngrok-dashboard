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

describe('extractResponseText', () => {
  function extractClaudeResponse(data) {
    const text = data?.content?.[0]?.text;
    return typeof text === 'string' ? text : '';
  }

  function extractCodexResponse(data) {
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text : '';
  }

  it('extracts Claude response text', () => {
    const claudeResp = { content: [{ type: 'text', text: 'Hello! How can I help you today?' }] };
    assert.strictEqual(extractClaudeResponse(claudeResp), 'Hello! How can I help you today?');
  });

  it('returns full Claude response without truncation', () => {
    const long = 'A'.repeat(200);
    const claudeResp = { content: [{ type: 'text', text: long }] };
    assert.strictEqual(extractClaudeResponse(claudeResp).length, 200);
  });

  it('extracts Codex response text', () => {
    const codexResp = { choices: [{ message: { content: 'Hi there!' } }] };
    assert.strictEqual(extractCodexResponse(codexResp), 'Hi there!');
  });

  it('returns empty string for malformed response', () => {
    assert.strictEqual(extractClaudeResponse({}), '');
    assert.strictEqual(extractCodexResponse({}), '');
    assert.strictEqual(extractClaudeResponse(null), '');
    assert.strictEqual(extractCodexResponse(null), '');
  });
});

describe('scheduler tick logic', () => {
  it('fires when current minute matches an offset and slot not yet fired', () => {
    const offsets = [0, 30];
    const minute = 0;
    const lastFiredSlot = null;
    const slotKey = `${String(Math.floor(new Date().getHours())).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

    const shouldFire = offsets.includes(minute) && lastFiredSlot !== slotKey;
    assert.strictEqual(shouldFire, true);
  });

  it('skips when current minute is not in offsets', () => {
    const offsets = [0, 30];
    const minute = 15;
    const lastFiredSlot = null;

    const shouldFire = offsets.includes(minute);
    assert.strictEqual(shouldFire, false);
  });

  it('skips when slot was already fired', () => {
    const offsets = [0, 30];
    const minute = 30;
    const lastFiredSlot = '09:30';

    const slotKey = '09:30';
    const shouldFire = offsets.includes(minute) && lastFiredSlot !== slotKey;
    assert.strictEqual(shouldFire, false);
  });

  it('fires again when slot changes (new hour)', () => {
    const offsets = [0, 30];
    const minute = 0;
    const lastFiredSlot = '09:30';

    const slotKey = '10:00';
    const shouldFire = offsets.includes(minute) && lastFiredSlot !== slotKey;
    assert.strictEqual(shouldFire, true);
  });
});
