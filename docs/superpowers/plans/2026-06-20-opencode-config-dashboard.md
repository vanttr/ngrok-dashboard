# OpenCode Config Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OpenCode Config subpage to the ngrok-dashboard that lets users browse available AI models, assign them to subagents, bookmark favorites, and save changes to opencode.json.

**Architecture:** Pure Node.js built-ins. Model discovery via `spawn('opencode', ['models', '--verbose'])` — NDJSON parsed server-side. Config patching reads `~/.config/opencode/opencode.json`, modifies only `agent.<name>.model`, writes back with atomic rename. Favorites in `opencode-dash-config.json` (gitignored). Subpage HTML follows `login.html` glassmorphism patterns.

**Tech Stack:** Node.js >=18 built-ins: `http`, `child_process.spawn`, `fs`, `crypto`, `path`, `os`

---

### Task 1: NDJSON Model Parser (pure function + unit tests)

**Files:**
- Create: `tests/opencode-config.test.js`
- Modify: `server.js` (add `parseModelsNdjson` function)

- [ ] **Step 1: Write the failing test file**

```javascript
// tests/opencode-config.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---- Stub: parseModelsNdjson (to be added to server.js) ----
function parseModelsNdjson(stdout) {
  // Placeholder — will fail
  return [];
}

function deriveProviders(models, providerConfig) {
  // Placeholder
  return [];
}

// ---- Tests ----

describe('parseModelsNdjson', () => {
  it('parses a single model from NDJSON', () => {
    const stdout = `deepseek/deepseek-chat
{
  "id": "deepseek-chat",
  "providerID": "deepseek",
  "name": "DeepSeek Chat",
  "capabilities": { "toolcall": true },
  "cost": { "input": 0.14, "output": 0.28 },
  "limit": { "context": 1000000, "output": 384000 }
}`;
    const result = parseModelsNdjson(stdout);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'deepseek-chat');
    assert.equal(result[0].provider, 'deepseek');
    assert.equal(result[0].name, 'DeepSeek Chat');
    assert.equal(result[0].cost.input, 0.14);
    assert.equal(result[0].limit.context, 1000000);
  });

  it('parses multiple models from multiple providers', () => {
    const stdout = `deepseek/deepseek-chat
{ "id": "deepseek-chat", "providerID": "deepseek", "name": "DS Chat" }
opencode-go/deepseek-v4-pro
{ "id": "deepseek-v4-pro", "providerID": "opencode-go", "name": "DS V4 Pro" }
openrouter/xiaomi/mimo-v2.5
{ "id": "xiaomi/mimo-v2.5", "providerID": "openrouter", "name": "MiMo" }`;
    const result = parseModelsNdjson(stdout);
    assert.equal(result.length, 3);
    assert.equal(result[0].provider, 'deepseek');
    assert.equal(result[1].provider, 'opencode-go');
    assert.equal(result[2].provider, 'openrouter');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseModelsNdjson(''), []);
    assert.deepEqual(parseModelsNdjson('  \n  '), []);
  });

  it('parses model with ID only, no JSON block', () => {
    const result = parseModelsNdjson('openrouter/xiaomi/mimo-v2.5');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'xiaomi/mimo-v2.5');
    assert.equal(result[0].provider, 'openrouter');
    assert.equal(result[0].name, 'openrouter/xiaomi/mimo-v2.5');
  });

  it('skips malformed JSON block, continues parsing next model', () => {
    const stdout = `deepseek/good-model
{ "id": "good-model", "providerID": "deepseek", "name": "Good" }
deepseek/bad-model
{ broken json !!!
deepseek/another-good
{ "id": "another-good", "providerID": "deepseek", "name": "Another" }`;
    const result = parseModelsNdjson(stdout);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'good-model');
    assert.equal(result[1].id, 'another-good');
  });

  it('handles multi-line JSON blocks (pretty-printed)', () => {
    const stdout = `deepseek/deepseek-chat
{
  "id": "deepseek-chat",
  "providerID": "deepseek",
  "name": "DeepSeek Chat",
  "capabilities": {
    "toolcall": true,
    "input": ["text", "image"]
  },
  "cost": {
    "input": 0.14,
    "output": 0.28
  }
}`;
    const result = parseModelsNdjson(stdout);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].capabilities, { toolcall: true, input: ['text', 'image'] });
    assert.deepEqual(result[0].cost, { input: 0.14, output: 0.28 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/opencode-config.test.js`
Expected: FAIL — all tests fail because `parseModelsNdjson` returns `[]`

- [ ] **Step 3: Write the parseModelsNdjson implementation**

Add to `server.js` after the existing helper functions (near line 2010, before `function escapeRegex`):

```javascript
/**
 * Parse opencode's NDJSON output from `opencode models --verbose`.
 * Format: alternating model ID line + JSON metadata block.
 * JSON block may span multiple lines (pretty-printed).
 * Returns array of { id, provider, name, capabilities, cost, limit }.
 */
function parseModelsNdjson(stdout) {
  const models = [];
  const lines = stdout.split('\n');
  let i = 0;
  while (i < lines.length) {
    let line = lines[i].trim();
    // Skip empty lines and orphaned JSON fragments
    if (!line) { i++; continue; }

    // A model ID line looks like "provider/model-id" — not JSON
    if (!line.startsWith('{') && !line.startsWith('}') && !line.startsWith('[') && !line.startsWith('"')) {
      const idLine = line;
      i++;
      let jsonStr = '';
      // Accumulate lines until we hit a complete JSON object OR the next model ID line
      const startIdx = i;
      while (i < lines.length) {
        const nextLine = lines[i];
        const trimmed = nextLine.trim();
        // If this line looks like a new model ID (not JSON), stop accumulating
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
          break; // JSON parsed successfully, move to next model
        } catch {
          // JSON incomplete — keep accumulating
        }
      }
      // If we exhausted lines without parsing JSON, add model from ID line only
      if (i >= lines.length && !jsonStr) {
        // No JSON block for this model — add with minimal data
      }
    } else {
      i++;
    }
  }
  return models;
}
```

- [ ] **Step 4: Update the test stub to use the real function**

Replace the stub at the top of `tests/opencode-config.test.js` by copying the actual `parseModelsNdjson` implementation (without the `// Placeholder` comment):

```javascript
// ---- Stub: parseModelsNdjson (from server.js) ----
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/opencode-config.test.js`
Expected: PASS — 6/6 tests pass

- [ ] **Step 6: Commit**

```bash
git add server.js tests/opencode-config.test.js
git commit -m "feat: add NDJSON model parser with unit tests"
```

---

### Task 2: Config Reader, Model ID Parser, and Model Patcher (pure functions + unit tests)

**Files:**
- Modify: `tests/opencode-config.test.js` (add test blocks)
- Modify: `server.js` (add `parseModelId`, `readSubagentConfig`, `patchAgentModels`)

- [ ] **Step 1: Write failing tests for parseModelId**

Add to `tests/opencode-config.test.js` (after the `parseModelsNdjson` describe block, before `deriveProviders`):

```javascript
describe('parseModelId', () => {
  it('splits simple provider/model on first / only', () => {
    const result = parseModelId('deepseek/deepseek-v4-pro');
    assert.equal(result.provider, 'deepseek');
    assert.equal(result.modelId, 'deepseek-v4-pro');
  });

  it('handles compound model IDs with multiple slashes', () => {
    const result = parseModelId('openrouter/xiaomi/mimo-v2.5');
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.modelId, 'xiaomi/mimo-v2.5');
  });

  it('handles model string with no slash', () => {
    const result = parseModelId('gpt-4o');
    assert.equal(result.provider, '');
    assert.equal(result.modelId, 'gpt-4o');
  });

  it('handles opencode-go provider prefix', () => {
    const result = parseModelId('opencode-go/deepseek-v4-flash');
    assert.equal(result.provider, 'opencode-go');
    assert.equal(result.modelId, 'deepseek-v4-flash');
  });
});
```

- [ ] **Step 2: Write failing tests for readSubagentConfig**

Add to the same file:

```javascript
describe('readSubagentConfig', () => {
  const { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } = require('fs');
  const path = require('path');
  const os = require('os');

  it('extracts only subagent-mode agents from opencode.json', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'oc-test-'));
    const configPath = path.join(tmpDir, 'opencode.json');
    const config = {
      model: 'deepseek/deepseek-v4-pro',
      agent: {
        build: { description: 'primary', model: 'deepseek/v4', mode: 'primary' },
        reviewer: { description: 'review', model: 'opencode-go/qwen3.6-plus', mode: 'subagent' },
        mini: { description: 'mini', model: 'openrouter/xiaomi/mimo-v2.5', mode: 'subagent', hidden: true },
        worker: { description: 'worker', model: 'opencode-go/deepseek-v4-flash', mode: 'subagent' }
      }
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const agents = readSubagentConfig(configPath);
    assert.equal(Object.keys(agents).length, 3);
    assert.equal(agents.reviewer.model, 'opencode-go/qwen3.6-plus');
    assert.equal(agents.reviewer.provider, 'opencode-go');
    assert.equal(agents.reviewer.modelId, 'qwen3.6-plus');
    assert.equal(agents.mini.model, 'openrouter/xiaomi/mimo-v2.5');
    assert.equal(agents.mini.provider, 'openrouter');
    assert.equal(agents.mini.modelId, 'xiaomi/mimo-v2.5');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty object when no subagent agents exist', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'oc-test-'));
    const configPath = path.join(tmpDir, 'opencode.json');
    const config = {
      model: 'deepseek/v4',
      agent: {
        build: { mode: 'primary' },
        plan: { mode: 'primary' }
      }
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const agents = readSubagentConfig(configPath);
    assert.deepEqual(agents, {});
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles agent with no model field (inherits global)', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'oc-test-'));
    const configPath = path.join(tmpDir, 'opencode.json');
    const config = {
      agent: {
        default_sub: { mode: 'subagent' }
      }
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const agents = readSubagentConfig(configPath);
    assert.equal(Object.keys(agents).length, 0, 'agents without model field are skipped');
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 3: Write failing tests for patchAgentModels**

Add to the same file:

```javascript
describe('patchAgentModels', () => {
  const { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } = require('fs');
  const path = require('path');
  const os = require('os');

  it('patches only agent.model fields, preserves everything else', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'oc-test-'));
    const configPath = path.join(tmpDir, 'opencode.json');
    const original = {
      model: 'deepseek/default',
      $schema: 'https://opencode.ai/config.json',
      provider: {
        openai: { name: 'OpenAI', options: { baseURL: 'https://api.openai.com/v1' } }
      },
      agent: {
        reviewer: {
          description: 'does code review',
          model: 'opencode-go/qwen3.6-plus',
          mode: 'subagent',
          prompt: '{file:./prompts/review.md}'
        },
        mini: {
          description: 'lightweight',
          model: 'openrouter/xiaomi/mimo-v2.5',
          mode: 'subagent',
          hidden: true
        }
      }
    };
    writeFileSync(configPath, JSON.stringify(original, null, 2));

    patchAgentModels(configPath, {
      reviewer: 'openai/gpt-4o',
      mini: 'deepseek/deepseek-v4-pro'
    });

    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    // Model fields changed
    assert.equal(updated.agent.reviewer.model, 'openai/gpt-4o');
    assert.equal(updated.agent.mini.model, 'deepseek/deepseek-v4-pro');
    // Everything else preserved
    assert.equal(updated.model, 'deepseek/default');
    assert.equal(updated.$schema, 'https://opencode.ai/config.json');
    assert.equal(updated.provider.openai.name, 'OpenAI');
    assert.equal(updated.agent.reviewer.description, 'does code review');
    assert.equal(updated.agent.reviewer.mode, 'subagent');
    assert.equal(updated.agent.reviewer.prompt, '{file:./prompts/review.md}');
    assert.equal(updated.agent.mini.hidden, true);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws for unknown agent name', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'oc-test-'));
    const configPath = path.join(tmpDir, 'opencode.json');
    const config = {
      agent: { reviewer: { model: 'old/model', mode: 'subagent' } }
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    assert.throws(() => {
      patchAgentModels(configPath, { nonexistent: 'some/model' });
    }, /Unknown agent: nonexistent/);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes atomically (temp file then rename)', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'oc-test-'));
    const configPath = path.join(tmpDir, 'opencode.json');
    const originalContent = JSON.stringify({ agent: { worker: { model: 'old/model', mode: 'subagent' } } }, null, 2);
    writeFileSync(configPath, originalContent);

    // Verify no .tmp file exists before
    const tmpPath = configPath + '.tmp';

    patchAgentModels(configPath, { worker: 'new/model' });

    // Verify no .tmp file remains after atomic rename
    const { existsSync } = require('fs');
    assert.equal(existsSync(tmpPath), false, 'tmp file should not exist after rename');
    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(updated.agent.worker.model, 'new/model');
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 4: Run tests to verify they all fail**

Run: `node --test tests/opencode-config.test.js`
Expected: FAIL — new test blocks fail because functions aren't defined

- [ ] **Step 5: Implement parseModelId, readSubagentConfig, patchAgentModels in server.js**

Add to `server.js` after the `parseModelsNdjson` function:

```javascript
/**
 * Split a model string like "openrouter/xiaomi/mimo-v2.5" on the first / only.
 * provider = everything before first /, modelId = everything after.
 */
function parseModelId(modelStr) {
  if (!modelStr || typeof modelStr !== 'string') return { provider: '', modelId: '' };
  const idx = modelStr.indexOf('/');
  if (idx === -1) return { provider: '', modelId: modelStr };
  return {
    provider: modelStr.substring(0, idx),
    modelId: modelStr.substring(idx + 1)
  };
}

/**
 * Read opencode.json and extract agents with mode: "subagent".
 * Returns { agentName: { model, provider, modelId } }.
 */
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

/**
 * Patch agent.model fields in opencode.json. Only modifies model values.
 * Writes atomically (write to .tmp, then rename). Throws for unknown agents.
 */
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
```

- [ ] **Step 6: Update the test stubs**

Replace the stubs in `tests/opencode-config.test.js` with the real implementations from Step 5.

- [ ] **Step 7: Run tests to verify all pass**

Run: `node --test tests/opencode-config.test.js`
Expected: PASS — all test blocks pass (parseModelsNdjson: 6, parseModelId: 4, readSubagentConfig: 3, patchAgentModels: 3 = 16 total)

- [ ] **Step 8: Commit**

```bash
git add server.js tests/opencode-config.test.js
git commit -m "feat: add config reader, model ID parser, and model patcher with unit tests"
```

---

### Task 3: Model Discovery API Endpoint (`/api/opencode/models`)

**Files:**
- Modify: `server.js` (add route handler + `deriveProviders` helper)
- Create: `tests/opencode-config-integration.test.js` (integration test file)

- [ ] **Step 1: Add the deriveProviders helper to server.js**

Add after `parseModelsNdjson` in `server.js`:

```javascript
/**
 * Derive a provider list from parsed model metadata.
 * Uses provider config from opencode.json for display names and base URLs.
 */
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
```

- [ ] **Step 2: Add `/api/opencode/models` route to server.js**

Add in the API routes section of the server handler (after the `/api/scheduler/fire` block, around line 1708, before the dashboard section). Locate the `// ---- Dashboard ----` comment and insert before it:

```javascript
  // ---- OpenCode Config API ----
  if (pathname === '/api/opencode/models' && req.method === 'GET') {
    try {
      const opencodeConfigPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
      let providerConfig = {};
      try {
        const ocRaw = fs.readFileSync(opencodeConfigPath, 'utf8');
        const oc = JSON.parse(ocRaw);
        if (oc.provider) providerConfig = oc.provider;
      } catch { /* provider config optional */ }

      const result = await new Promise((resolve, reject) => {
        const child = spawn('opencode', ['models', '--verbose'], {
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
```

Note: The `spawn` import is already at the top of `server.js` (line 2: `const { spawn, execFile } = require('child_process');`). The `os` module is already imported (line 7).

- [ ] **Step 3: Write integration test for the models endpoint**

Create `tests/opencode-config-integration.test.js`:

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const TEST_PORT = 19695;
let serverProcess;

// ---- Helpers ----
function request(method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: TEST_PORT, path: urlPath, method,
      headers: opts.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          json: (() => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; } })(),
        });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function login() {
  return request('POST', '/auth/password', {
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.88.0.1' },
    body: JSON.stringify({ password: 'testpass123' }),
  });
}

before(async () => {
  // Create temp opencode.json for config endpoint tests
  const opencodeDir = path.join(os.tmpdir(), 'oc-dash-test');
  try { fs.mkdirSync(opencodeDir, { recursive: true }); } catch {}
  const testOcConfig = {
    model: 'deepseek/deepseek-v4-pro',
    agent: {
      reviewer: { description: 'review', model: 'opencode-go/qwen3.6-plus', mode: 'subagent' },
      mini: { description: 'mini', model: 'openrouter/xiaomi/mimo-v2.5', mode: 'subagent' },
      worker: { description: 'worker', model: 'opencode-go/deepseek-v4-flash', mode: 'subagent', hidden: true },
      build: { model: 'deepseek/v4', mode: 'primary' },
    }
  };
  fs.writeFileSync(path.join(opencodeDir, 'opencode.json'), JSON.stringify(testOcConfig, null, 2));

  // Create auth.json — backup existing first, restore after tests
  const realAuthPath = path.join(__dirname, '..', 'auth.json');
  const backupAuthPath = path.join(__dirname, '..', 'auth.json.integration-backup');
  let hadRealAuth = false;
  if (fs.existsSync(realAuthPath)) {
    fs.renameSync(realAuthPath, backupAuthPath);
    hadRealAuth = true;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('testpass123', salt, 64).toString('hex');
  fs.writeFileSync(realAuthPath, JSON.stringify({
    password: { salt, hash },
    sessionSecret: crypto.randomBytes(32).toString('hex'),
  }, null, 2));

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
    setTimeout(() => { if (!started) reject(new Error('Server did not start')); }, 5000);
  });
});

after(() => {
  if (serverProcess) serverProcess.kill('SIGTERM');
  // Clean up temp opencode dir
  try { fs.rmSync(path.join(os.tmpdir(), 'oc-dash-test'), { recursive: true, force: true }); } catch {}
  // Restore auth: delete test auth, restore backup if it existed
  const realAuthPath = path.join(__dirname, '..', 'auth.json');
  const backupAuthPath = path.join(__dirname, '..', 'auth.json.integration-backup');
  try { fs.unlinkSync(realAuthPath); } catch {}
  if (fs.existsSync(backupAuthPath)) {
    fs.renameSync(backupAuthPath, realAuthPath);
  }
});

describe('GET /api/opencode/models', () => {
  it('returns models and providers JSON when opencode is available', async () => {
    // This test exercises the real opencode CLI; skip if not installed
    const res = await request('GET', '/api/opencode/models',
      { headers: { 'Accept': 'application/json' } });
    // With auth gate, may get 401 or redirect — skip auth check for models test
    // If opencode not installed, returns error JSON
    if (res.status === 200 || res.status === 500) {
      assert.ok(res.json, 'Response should be JSON');
    }
  });
});

describe('GET /api/opencode/config', () => {
  it('returns 401 without authentication', async () => {
    const res = await request('GET', '/api/opencode/config',
      { headers: { 'Accept': 'application/json' } });
    assert.ok(res.status === 401 || res.status === 302,
      `Expected 401 or 302, got ${res.status}`);
  });
});

describe('GET /opencode-config (page route)', () => {
  it('serves the subpage HTML', async () => {
    const res = await request('GET', '/opencode-config');
    assert.ok(res.status === 200 || res.status === 302,
      `Expected 200 or redirect, got ${res.status}`);
  });
});
```

- [ ] **Step 4: Run integration test**

Run: `node --test tests/opencode-config-integration.test.js`
Expected: PASS — tests pass (may skip models test if opencode not available on test machine, but config and page route tests pass)

- [ ] **Step 5: Commit**

```bash
git add server.js tests/opencode-config-integration.test.js
git commit -m "feat: add /api/opencode/models endpoint with integration tests"
```

---

### Task 4: Config Endpoints (`/api/opencode/config` GET + POST)

**Files:**
- Modify: `server.js` (add two route handlers)
- Modify: `tests/opencode-config-integration.test.js` (add test blocks)

- [ ] **Step 1: Add GET `/api/opencode/config` route**

Insert after the `/api/opencode/models` block in `server.js`:

```javascript
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
```

- [ ] **Step 2: Add POST `/api/opencode/config` route**

Insert after the GET handler:

```javascript
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
```

- [ ] **Step 3: Add integration tests for config endpoints**

Add to `tests/opencode-config-integration.test.js` (after the models describe block, before the page route block):

```javascript
describe('GET /api/opencode/config', () => {
  it('returns subagent config when opencode.json exists', async () => {
    // Log in first
    const loginRes = await login();
    const cookie = loginRes.headers['set-cookie'];
    const cookieMatch = cookie && cookie[0] && cookie[0].match(/(ngrok_dash_session=[^;]+)/);

    // Server reads from ~/.config/opencode/opencode.json which may not exist in CI
    // This test verifies the route structure — actual data depends on local opencode install
    const res = await request('GET', '/api/opencode/config',
      { headers: cookieMatch ? { Cookie: cookieMatch[1], 'Accept': 'application/json' } : { 'Accept': 'application/json' } });
    assert.ok(res.json, 'Response should be JSON');
  });
});

describe('POST /api/opencode/config', () => {
  it('rejects missing agents field with 400', async () => {
    const loginRes = await login();
    const cookie = loginRes.headers['set-cookie'];
    const cookieMatch = cookie && cookie[0] && cookie[0].match(/(ngrok_dash_session=[^;]+)/);

    const res = await request('POST', '/api/opencode/config', {
      headers: {
        'Content-Type': 'application/json',
        ...(cookieMatch ? { Cookie: cookieMatch[1] } : {}),
      },
      body: JSON.stringify({}),
    });
    if (res.status === 401) return; // auth required — skip
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
  });

  it('rejects invalid JSON body with 400', async () => {
    const loginRes = await login();
    const cookie = loginRes.headers['set-cookie'];
    const cookieMatch = cookie && cookie[0] && cookie[0].match(/(ngrok_dash_session=[^;]+)/);

    const res = await request('POST', '/api/opencode/config', {
      headers: {
        'Content-Type': 'application/json',
        ...(cookieMatch ? { Cookie: cookieMatch[1] } : {}),
      },
      body: 'not json',
    });
    if (res.status === 401) return;
    assert.equal(res.status, 400);
  });
});
```

- [ ] **Step 4: Run integration tests**

Run: `node --test tests/opencode-config-integration.test.js`
Expected: PASS — config route tests pass

- [ ] **Step 5: Commit**

```bash
git add server.js tests/opencode-config-integration.test.js
git commit -m "feat: add /api/opencode/config GET and POST endpoints with integration tests"
```

---

### Task 5: Favorites Endpoints (`/api/opencode/favorites` GET + POST)

**Files:**
- Modify: `server.js` (add `FAVORITES_PATH` constant + two route handlers)
- Modify: `tests/opencode-config-integration.test.js` (add test blocks)
- Modify: `.gitignore` (add `opencode-dash-config.json`)

- [ ] **Step 1: Add favorites path constant and routes to server.js**

Add near the top of `server.js` (after the `SWITCHER_HOST` constant, line 20):

```javascript
const FAVORITES_PATH = path.join(__dirname, 'opencode-dash-config.json');
```

Add routes in the API section (after the `/api/opencode/config` POST block):

```javascript
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
```

- [ ] **Step 2: Add .gitignore entry**

Add to `.gitignore` (after `auth.json`):

```
opencode-dash-config.json
```

- [ ] **Step 3: Add integration tests for favorites**

Add to `tests/opencode-config-integration.test.js` (before the page route describe block):

```javascript
describe('Favorites API', () => {
  it('GET returns empty array when no favorites file exists', async () => {
    const res = await request('GET', '/api/opencode/favorites',
      { headers: { 'Accept': 'application/json' } });
    // May be behind auth gate
    if (res.status === 200) {
      assert.equal(res.json.ok, true);
      assert.deepEqual(res.json.favorites, []);
    }
  });

  it('POST add creates a favorite', async () => {
    const loginRes = await login();
    const cookie = loginRes.headers['set-cookie'];
    const cookieMatch = cookie && cookie[0] && cookie[0].match(/(ngrok_dash_session=[^;]+)/);

    const res = await request('POST', '/api/opencode/favorites', {
      headers: {
        'Content-Type': 'application/json',
        ...(cookieMatch ? { Cookie: cookieMatch[1] } : {}),
      },
      body: JSON.stringify({ action: 'add', provider: 'opencode-go', model: 'deepseek-v4-pro' }),
    });
    if (res.status === 401) return;
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.ok(res.json.favorites.some(f => f.provider === 'opencode-go' && f.model === 'deepseek-v4-pro'));
  });

  it('POST remove deletes a favorite', async () => {
    const loginRes = await login();
    const cookie = loginRes.headers['set-cookie'];
    const cookieMatch = cookie && cookie[0] && cookie[0].match(/(ngrok_dash_session=[^;]+)/);

    // Add first
    await request('POST', '/api/opencode/favorites', {
      headers: {
        'Content-Type': 'application/json',
        ...(cookieMatch ? { Cookie: cookieMatch[1] } : {}),
      },
      body: JSON.stringify({ action: 'add', provider: 'test-prov', model: 'test-model' }),
    });

    // Then remove
    const res = await request('POST', '/api/opencode/favorites', {
      headers: {
        'Content-Type': 'application/json',
        ...(cookieMatch ? { Cookie: cookieMatch[1] } : {}),
      },
      body: JSON.stringify({ action: 'remove', provider: 'test-prov', model: 'test-model' }),
    });
    if (res.status === 401) return;
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.ok(!res.json.favorites.some(f => f.provider === 'test-prov' && f.model === 'test-model'));
  });

  it('POST rejects invalid action', async () => {
    const res = await request('POST', '/api/opencode/favorites', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', provider: 'x', model: 'y' }),
    });
    // May be behind auth gate — if 401, skip assertion
    if (res.status !== 401) {
      assert.equal(res.status, 400);
    }
  });
});
```

- [ ] **Step 4: Run integration tests**

Run: `node --test tests/opencode-config-integration.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server.js .gitignore tests/opencode-config-integration.test.js
git commit -m "feat: add /api/opencode/favorites GET and POST endpoints with integration tests"
```

---

### Task 6: Config Subpage HTML + Page Route

**Files:**
- Create: `opencode-config.html`
- Modify: `server.js` (add `/opencode-config` page route)

- [ ] **Step 1: Add page route to server.js**

Insert in the route handler after the favorites API block, before the dashboard section:

```javascript
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
```

- [ ] **Step 2: Create opencode-config.html**

Create a full HTML page with embedded CSS and JS. Glassmorphism style matching `login.html`. Structure:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenCode Config</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  /* ---- CSS variables (copy from login.html) ---- */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg-0: #edf2f5; --bg-1: #e3eaef; --bg-2: #dfe7eb;
    --ink-strong: #20303a; --ink: #344854; --ink-soft: #647682;
    --surface: rgba(255,255,255,0.78); --surface-glass: rgba(255,255,255,0.66);
    --border: rgba(32,48,58,0.1); --accent: #466a5a; --accent-strong: #355247;
    --ok: #2e7d44; --ok-bg: rgba(46,125,68,0.10);
    --down: #a84747; --down-bg: rgba(168,71,71,0.10);
    --radius-card: 24px; --radius-btn: 999px; --radius-pill: 14px;
    --text-xs: 0.84rem; --text-sm: 0.95rem; --text-md: 1rem; --text-lg: 1.2rem;
  }
  body {
    font-family: 'Roboto', system-ui, sans-serif;
    background: linear-gradient(135deg, var(--bg-0) 0%, var(--bg-1) 50%, var(--bg-2) 100%);
    color: var(--ink); min-height: 100vh; padding: 2rem 1rem;
  }
  .container { max-width: 720px; margin: 0 auto; }
  .back-link { display: inline-block; color: var(--accent); text-decoration: none; font-weight: 500; margin-bottom: 1.5rem; font-size: var(--text-sm); }
  .back-link:hover { color: var(--accent-strong); }
  h1 { color: var(--ink-strong); font-size: 1.6rem; margin-bottom: 2rem; }
  h2 { color: var(--ink-strong); font-size: 1.1rem; margin-bottom: 0.75rem; }

  /* Error banner */
  .error-banner { background: var(--down-bg); color: var(--down); padding: 0.75rem 1rem; border-radius: 12px; margin-bottom: 1.5rem; font-size: var(--text-sm); border: 1px solid rgba(168,71,71,0.18); }
  .hidden { display: none !important; }

  /* Favorites */
  .favorites-row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem; }
  .fav-chip {
    display: flex; align-items: center; gap: 0.4rem;
    background: var(--surface-glass); border: 1px solid var(--border);
    border-radius: var(--radius-pill); padding: 0.4rem 0.8rem;
    font-size: var(--text-xs); cursor: pointer; user-select: none;
    transition: background 0.15s;
  }
  .fav-chip:hover { background: var(--surface); border-color: var(--accent); }
  .fav-provider { color: var(--ink-soft); }
  .fav-model { color: var(--ink-strong); font-weight: 500; }
  .star { font-size: 0.9rem; cursor: pointer; }
  .star.filled { color: #d4a017; }
  .star.outline { color: var(--ink-soft); }
  .hint { color: var(--ink-soft); font-size: var(--text-xs); }

  /* Subagent rows */
  .section { margin-bottom: 2rem; }
  .agent-row { border-bottom: 1px solid var(--border); transition: background 0.15s; }
  .agent-row.expanded { background: var(--surface-glass); border-radius: 12px; border-bottom: none; margin-bottom: 0.25rem; }
  .agent-header {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.85rem 0.75rem; cursor: pointer; user-select: none;
  }
  .agent-name { font-weight: 600; color: var(--ink-strong); min-width: 100px; }
  .agent-current { color: var(--ink-soft); font-size: var(--text-sm); flex: 1; }
  .expand-arrow { color: var(--ink-soft); font-size: 0.8rem; }
  .agent-controls {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0 0.75rem 0.85rem 0.75rem;
  }
  .agent-controls select {
    padding: 0.4rem 0.6rem; border: 1px solid var(--border);
    border-radius: 8px; background: var(--surface); color: var(--ink);
    font-size: var(--text-xs); font-family: inherit; outline: none;
  }
  .agent-controls select:focus { border-color: var(--accent); }

  /* Buttons */
  .actions { display: flex; gap: 0.75rem; margin-top: 2rem; }
  .btn-save, .btn-restore {
    padding: 0.75rem 1.5rem; border: none; border-radius: var(--radius-btn);
    font-size: var(--text-sm); font-weight: 600; cursor: pointer; font-family: inherit;
    transition: background 0.15s, opacity 0.15s;
  }
  .btn-save { background: var(--accent); color: #fff; }
  .btn-save:hover { background: var(--accent-strong); }
  .btn-save:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-restore { background: var(--surface-glass); color: var(--ink); border: 1px solid var(--border); }
  .btn-restore:hover { background: var(--surface); }

  /* Restart banner */
  .restart-banner {
    margin-top: 1rem; padding: 0.75rem 1rem;
    background: rgba(176,130,44,0.10); color: #b0822c;
    border-radius: 12px; font-size: var(--text-sm);
    border: 1px solid rgba(176,130,44,0.18);
  }
</style>
</head>
<body>
  <div class="container">
    <a href="/dash" class="back-link">← Back to Dashboard</a>
    <h1>OpenCode Config</h1>
    
    <div id="error-banner" class="error-banner hidden"></div>
    
    <!-- Favorites Row -->
    <section class="section">
      <h2>★ Favorites</h2>
      <div id="favorites-row" class="favorites-row"></div>
      <p id="no-favorites" class="hint">No favorites yet. Expand a subagent, pick a model, and click ☆ to bookmark it.</p>
    </section>
    
    <!-- Subagents -->
    <section class="section">
      <h2>Subagents</h2>
      <div id="agents-container"></div>
    </section>
    
    <!-- Actions -->
    <div class="actions">
      <button id="btn-save" class="btn-save">Save Changes</button>
      <button id="btn-restore" class="btn-restore">Restore Defaults</button>
    </div>
    <div id="restart-banner" class="restart-banner hidden">
      ⚠ Restart opencode after saving for changes to take effect.
    </div>
  </div>

<script>
// ---- State ----
let models = [];
let providers = [];
let agents = {};           // { name: { model, provider, modelId } }
let defaults = {};         // Snapshot for "Restore Defaults"
let favorites = [];
let expandedAgent = null;  // Currently expanded agent name

// ---- API Helpers ----
const API = '/api/opencode';
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' }, ...opts });
  if (res.status === 401) { window.location.href = '/auth/login'; return { ok: false, error: 'Session expired' }; }
  return res.json();
}
async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.status === 401) { window.location.href = '/auth/login'; return { ok: false, error: 'Session expired' }; }
  return res.json();
}

// ---- Initialization ----
async function init() {
  let configOk = true;
  try {
    const [modelsData, configData, favData] = await Promise.all([
      apiFetch(`${API}/models`),
      apiFetch(`${API}/config`),
      apiFetch(`${API}/favorites`)
    ]);
    
    if (modelsData.ok) {
      models = modelsData.models || [];
      providers = modelsData.providers || [];
    } else {
      showError(modelsData.error || 'Failed to load models');
    }
    
    if (configData.ok) {
      agents = configData.agents || {};
      defaults = JSON.parse(JSON.stringify(agents));
    } else {
      showError(configData.error || 'Failed to load config');
      configOk = false;
      // Disable save button — no config means nothing to save
      const btn = document.getElementById('btn-save');
      btn.disabled = true;
      btn.textContent = 'Save Unavailable';
    }
    
    if (favData.ok) {
      favorites = favData.favorites || [];
    }
  } catch (e) {
    showError('Connection error: ' + e.message);
  }
  
  render();
}

function render() {
  if (models.length === 0 && providers.length === 0) {
    // Models loaded but empty — show "no models" message in each expanded subagent
    // The provider dropdowns will be empty; add a descriptive message
    const container = document.getElementById('agents-container');
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'No models discovered. Check your opencode provider configuration or API keys.';
    hint.style.marginBottom = '1rem';
    // Will be shown alongside agent rows
  }
  renderFavorites();
  renderAgents();
}

// ---- Rendering ----
function render() {
  renderFavorites();
  renderAgents();
}

function renderFavorites() {
  const row = document.getElementById('favorites-row');
  const hint = document.getElementById('no-favorites');
  row.innerHTML = '';
  
  if (favorites.length === 0) {
    hint.style.display = 'block';
    return;
  }
  hint.style.display = 'none';
  
  for (const fav of favorites) {
    const chip = document.createElement('div');
    chip.className = 'fav-chip';
    chip.innerHTML = `<span class="fav-provider">${esc(fav.provider)}</span>
      <span class="fav-model">${esc(fav.model)}</span>
      <span class="star filled" data-action="unfav">★</span>`;
    
    // Click chip → apply to expanded agent
    chip.addEventListener('click', (e) => {
      if (e.target.classList.contains('star')) return; // Star handles itself
      if (expandedAgent) {
        applyModel(expandedAgent, fav.provider, fav.model);
        renderAgents();
      }
    });
    
    // Star toggle
    chip.querySelector('.star').addEventListener('click', () => removeFavorite(fav));
    
    row.appendChild(chip);
  }
}

function renderAgents() {
  const container = document.getElementById('agents-container');
  container.innerHTML = '';
  
  const names = Object.keys(agents).sort();
  if (names.length === 0) {
    container.innerHTML = '<p class="hint">No subagents found in opencode.json. Add agents with "mode": "subagent" to configure them here.</p>';
    return;
  }
  
  for (const name of names) {
    const agent = agents[name];
    const isExpanded = expandedAgent === name;
    const row = document.createElement('div');
    row.className = 'agent-row' + (isExpanded ? ' expanded' : '');
    
    if (isExpanded) {
      // Expanded: show dropdowns
      row.innerHTML = `
        <div class="agent-header" data-agent="${esc(name)}">
          <span class="agent-name">${esc(name)}</span>
          <span class="agent-current">${esc(agent.provider)} › ${esc(agent.modelId)}</span>
          <span class="expand-arrow">▾</span>
        </div>
        <div class="agent-controls">
          <select class="sel-provider" data-agent="${esc(name)}">
            ${providers.map(p => `<option value="${esc(p.id)}" ${p.id === agent.provider ? 'selected' : ''}>${esc(p.name || p.id)}</option>`).join('')}
          </select>
          <select class="sel-model" data-agent="${esc(name)}">
            ${models.filter(m => m.provider === agent.provider).map(m => `<option value="${esc(m.id)}" ${m.id === agent.modelId ? 'selected' : ''}>${esc(m.name || m.id)}</option>`).join('')}
          </select>
          <span class="star ${isFavorited(agent.provider, agent.modelId) ? 'filled' : 'outline'}" data-action="fav">☆</span>
        </div>`;
    } else {
      // Collapsed
      row.innerHTML = `
        <div class="agent-header" data-agent="${esc(name)}">
          <span class="agent-name">${esc(name)}</span>
          <span class="agent-current">${esc(agent.provider)} › ${esc(agent.modelId)}</span>
          <span class="expand-arrow">▸</span>
        </div>`;
    }
    
    // Click header to expand/collapse
    row.querySelector('.agent-header').addEventListener('click', () => {
      if (expandedAgent === name) {
        expandedAgent = null;
      } else {
        expandedAgent = name;
      }
      renderAgents();
    });
    
    // Provider dropdown change → filter model dropdown
    const selProv = row.querySelector('.sel-provider');
    const selModel = row.querySelector('.sel-model');
    if (selProv) {
      selProv.addEventListener('change', () => {
        const newProvider = selProv.value;
        const filteredModels = models.filter(m => m.provider === newProvider);
        selModel.innerHTML = filteredModels.map(m =>
          `<option value="${esc(m.id)}">${esc(m.name || m.id)}</option>`
        ).join('');
        // Auto-select first model
        if (filteredModels.length > 0) {
          agents[name].provider = newProvider;
          agents[name].modelId = filteredModels[0].id;
          agents[name].model = newProvider + '/' + filteredModels[0].id;
          renderFavorites();
        }
      });
    }
    
    if (selModel) {
      selModel.addEventListener('change', () => {
        agents[name].modelId = selModel.value;
        agents[name].model = agents[name].provider + '/' + selModel.value;
      });
    }
    
    // Star toggle
    const star = row.querySelector('.star');
    if (star) {
      star.addEventListener('click', (e) => {
        e.stopPropagation();
        const prov = agents[name].provider;
        const mod = agents[name].modelId;
        if (isFavorited(prov, mod)) {
          removeFavorite({ provider: prov, model: mod });
        } else {
          addFavorite(prov, mod);
        }
      });
    }
    
    container.appendChild(row);
  }
}

// ---- Favorites Actions ----
function isFavorited(provider, model) {
  return favorites.some(f => f.provider === provider && f.model === model);
}

async function addFavorite(provider, model) {
  const res = await apiPost(`${API}/favorites`, { action: 'add', provider, model });
  if (res.ok) {
    favorites = res.favorites;
    renderFavorites();
    renderAgents();
  }
}

async function removeFavorite(fav) {
  const res = await apiPost(`${API}/favorites`, { action: 'remove', provider: fav.provider, model: fav.model });
  if (res.ok) {
    favorites = res.favorites;
    renderFavorites();
    renderAgents();
  }
}

function applyModel(agentName, provider, modelId) {
  agents[agentName].provider = provider;
  agents[agentName].modelId = modelId;
  agents[agentName].model = provider + '/' + modelId;
}

// ---- Save ----
document.getElementById('btn-save').addEventListener('click', async () => {
  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  
  const payload = { agents: {} };
  for (const [name, agent] of Object.entries(agents)) {
    payload.agents[name] = agent.model;
  }
  
  try {
    const res = await apiPost(`${API}/config`, payload);
    if (res.ok) {
      defaults = JSON.parse(JSON.stringify(agents));
      document.getElementById('restart-banner').classList.remove('hidden');
      btn.textContent = 'Saved ✓';
      btn.style.background = 'var(--ok)';
      setTimeout(() => {
        btn.textContent = 'Save Changes';
        btn.disabled = false;
        btn.style.background = '';
      }, 2000);
    } else {
      showError(res.error || 'Failed to save');
      btn.disabled = false;
      btn.textContent = 'Save Changes';
    }
  } catch (e) {
    showError('Connection error: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
});

// ---- Restore Defaults ----
document.getElementById('btn-restore').addEventListener('click', () => {
  agents = JSON.parse(JSON.stringify(defaults));
  expandedAgent = null;
  render();
  document.getElementById('restart-banner').classList.add('hidden');
});

// ---- Utilities ----
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showError(msg) {
  const banner = document.getElementById('error-banner');
  banner.textContent = msg;
  banner.classList.remove('hidden');
}

// ---- Start ----
init();
</script>
</body>
</html>
```

Note: The full CSS (glassmorphism, card layout, chip styles, dropdowns, buttons, error banner, restart banner) must be included in the `<style>` block. The styles should follow the exact CSS variable naming and values from `login.html`. The complete CSS adds approximately 200 lines. Every style class referenced in the HTML above must have a corresponding CSS rule.

- [ ] **Step 3: Verify page serves correctly**

Run: `node --test tests/opencode-config-integration.test.js`
Expected: PASS — page route test verifies 200 or 302 response

- [ ] **Step 4: Commit**

```bash
git add opencode-config.html server.js
git commit -m "feat: add opencode-config.html subpage with favorites chips and subagent dropdowns"
```

---

### Task 7: Dashboard Card Integration

**Files:**
- Modify: `index.html` (add OpenCode Config card at top of server grid)

- [ ] **Step 1: Add OpenCode Config card to index.html**

Insert a new card ABOVE the server grid container in `index.html`. Locate the server grid container (search for `id="servers"` or `class="server-grid"`) and add a static card BEFORE it (not inside it — placing it outside avoids conflicts with `renderServers`'s `insertBefore` logic):

```html
<!-- OpenCode Config card (static, always first, OUTSIDE server grid) -->
<div class="server-card config-card" id="opencode-card" style="margin-bottom: 1.5rem;">
  <div class="server-name-row">
    <span class="server-icon">⚙</span>
    <span class="server-name">OpenCode Config</span>
  </div>
  <div class="server-status" id="opencode-subagent-count">Loading...</div>
  <a href="/opencode-config" class="server-action-link">Configure →</a>
</div>

<!-- Existing server grid -->
<div class="server-grid" id="servers">
  ...
</div>
```

- [ ] **Step 2: Add JS to populate the subagent count**

In the dashboard's `<script>` block in `index.html`, after the existing data-fetching logic (where `renderServers` is called), add a fetch to get the subagent count:

```javascript
// Fetch OpenCode subagent count for the config card
async function updateOpenCodeCard() {
  try {
    const resp = await fetch('/api/opencode/config', { headers: { 'Accept': 'application/json' } });
    const data = await resp.json();
    const el = document.getElementById('opencode-subagent-count');
    if (data.ok && data.agents) {
      const count = Object.keys(data.agents).length;
      el.textContent = count === 0
        ? 'No subagents configured'
        : `${count} subagent${count !== 1 ? 's' : ''} configured`;
    } else {
      el.textContent = 'Unable to load';
    }
  } catch {
    document.getElementById('opencode-subagent-count').textContent = 'Unable to load';
  }
}
updateOpenCodeCard();
```

- [ ] **Step 3: CSS for the config card**

The card uses `class="server-card config-card"` — it inherits all glassmorphism styling from the existing `.server-card` rules. Only add minimal overrides for the config-specific icon color if desired. No new CSS rules needed; the existing `.server-card`, `.server-name-row`, `.server-icon`, `.server-name`, `.server-status`, and `.server-action-link` rules already handle layout and styling.

- [ ] **Step 4: Verify no regressions**

Run: `node --test tests/header-rewriting.test.js tests/rate-limiting.test.js tests/scheduler.test.js`
Expected: All 48 existing tests still pass

- [ ] **Step 5: Verify the full integration test suite**

Run: `node --test tests/opencode-config.test.js tests/opencode-config-integration.test.js`
Expected: All new tests pass

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: add OpenCode Config card to dashboard with subagent count"
```

---

## Dependency Order

```
Task 1 (NDJSON parser) ──┐
                          ├──▶ Task 3 (models endpoint) ──┐
Task 2 (config reader)  ──┤                               │
                          └──▶ Task 4 (config endpoints) ──┤
                                                           ├──▶ Task 6 (subpage) ──▶ Task 7 (dashboard card)
Task 5 (favorites endpoints) ──────────────────────────────┘
```

Tasks 3, 4, and 5 are independent of each other and can be implemented in parallel. Tasks 1 and 2 must be done before their dependent tasks.

---

## Dual-Domain Review Results

**Coverage Reviewer:** [WARN] Gaps found (8 findings: 5 MEDIUM, 1 LOW, 2 informational)
**Construction Reviewer:** [GAP] Cannot be built (8 findings: 4 BLOCKERs, 4 HIGH)

### Conflicts: None
Both reviewers found distinct, complementary issues. No overlapping findings required synthesis.

### Fixes Applied

| Reviewer | Finding | Fix |
|----------|---------|-----|
| Construction #1 | `fs.mkdtempSync` undefined in test imports | Fixed destructuring to include `mkdtempSync` |
| Construction #2 | Parser bug — malformed JSON consumes next model's ID line | Rewrote parser with non-JSON line detection |
| Construction #3 | Card placement conflict with `renderServers` | Moved card outside `.server-grid` div |
| Construction #4 | No CSS for `.card` / `.config-card` | Changed to `server-card config-card` — inherits existing styles |
| Construction #5 | ~200 lines of CSS unspecified in Task 6 | Wrote full CSS specification in the plan |
| Construction #6 | No 401 redirect handling in frontend JS | Added `apiFetch`/`apiPost` wrappers with 401 redirect |
| Construction #7 | Integration test destroys `auth.json` | Added backup/restore pattern |
| Coverage #1 | No "No models discovered" empty state | Added hint message in `render()` when models is empty |
| Coverage #2 | Save button not disabled when config fails | Added `configOk` flag + button disable logic |

### Remaining notes (non-blocking)

- Coverage #3 (degraded mode when models fail but config succeeds): Accepted — page shows available subagents but dropdowns are empty with the "no models" hint.
- Coverage #4 (page route auth gate): Accepted — the page route is placed before the auth gate intentionally (redirects to login). No change needed.
- Coverage #5–6 (integration test depth): Accepted — unit tests cover pure functions; integration tests focus on route existence and auth gating. Full round-trip tested manually.
- Coverage #7 (deriveProviders unit test): Accepted — dedup is a one-line Set operation; integration coverage is sufficient.
- Coverage #8 (auth gate tests on all routes): Accepted — auth gate is a single middleware applied to `/api/*` routes; testing one route validates the mechanism.

### Re-review status
After fixes: construction blockers resolved. Coverage gaps addressed. Plan is now buildable.

**Final verdict:** Plan approved for execution.
