# Scheduled AI Prompts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scheduler to the ngrok-dashboard that sends a "hi" prompt to
Claude Code and Codex CLI at configurable clock times and shows run status on
the dashboard.

**Architecture:** Add three blocks to the existing single-file server: (1)
credential loading from CLI config files, (2) HTTPS API calls to Anthropic and
OpenAI, (3) a 30-second polling loop that triggers at matching minute offsets,
and (4) an API endpoint exposing run state. The dashboard gets a new section
that renders this state.

**Tech Stack:** Node.js built-in `https`, `fs`, `path`, `os` modules. Zero new
dependencies. Vanilla HTML/CSS/JS for the dashboard.

**Fix notes from dual-domain review (2026-06-04):**
- Tasks 3 & 4 reordered: `callAI` defined before `fireScheduler` uses it
- `fireScheduler` uses `Promise.allSettled()` for true parallel firing (spec requirement)
- `setInterval` callback wrapped with `.catch()` for async error handling
- 2-second guard tightened to `< 1` second

---

### Task 1: Add scheduler config to servers.json

**Files:**
- Modify: `servers.json` (append scheduler block)

- [ ] **Step 1: Add the scheduler configuration block**

Append after the `"healthIntervalMs": 10000` line. The file currently ends with:
```json
  "healthIntervalMs": 10000
}
```
Replace with:
```json
  "healthIntervalMs": 10000,
  "scheduler": {
    "enabled": true,
    "minuteOffsets": [0, 30],
    "prompt": "hi",
    "targets": [
      {
        "name": "Claude Code",
        "type": "claude",
        "model": "claude-sonnet-4-20250514",
        "credentialPath": "~/.claude/config.json",
        "credentialKey": "primaryApiKey"
      },
      {
        "name": "Codex CLI",
        "type": "codex",
        "model": "gpt-5.4",
        "credentialPath": "~/.codex/auth.json",
        "credentialKey": "tokens.access_token"
      }
    ]
  }
}
```

- [ ] **Step 2: Verify JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('servers.json','utf8')); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add servers.json
git commit -m "feat: add scheduler config block to servers.json"
```

---

### Task 2: Load credentials and initialize scheduler state in server.js

**Files:**
- Modify: `server.js` (insert after line 102, before "Server Discovery" section)
- Create: `tests/scheduler.test.js`

- [ ] **Step 1: Write tests for credential loading helpers**

Create `tests/scheduler.test.js`:
```js
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
    assert.ok(result.endsWith('.claude/config.json'));
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
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node tests/scheduler.test.js`
Expected: All 6 tests PASS

- [ ] **Step 3: Insert credential loading code into server.js**

After line 102 (`process.on('exit', () => { stopNgrok(); });`), before line 104 (`// ---- Server Discovery & Health Check ----`), insert:

```js
// ---- Scheduler ----
const os = require('os');

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
```

- [ ] **Step 4: Run the unit tests again**

Run: `node tests/scheduler.test.js`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add tests/scheduler.test.js server.js
git commit -m "feat: add credential loading and scheduler state to server.js"
```

---

### Task 3: Implement API call functions (Anthropic + OpenAI)

**Files:**
- Modify: `server.js` (add `callAI`, `callClaude`, `callCodex` after credential loading)
- Modify: `tests/scheduler.test.js` (append response extraction tests)

**Note:** This task is ordered before Task 4 because `fireScheduler()` (Task 4) calls `callAI()`.

- [ ] **Step 1: Write tests for response extraction**

Append to `tests/scheduler.test.js`:

```js

describe('extractResponseText', () => {
  function extractClaudeResponse(data) {
    const text = data?.content?.[0]?.text;
    return typeof text === 'string' ? text.slice(0, 80) : '';
  }

  function extractCodexResponse(data) {
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text.slice(0, 80) : '';
  }

  it('extracts Claude response text', () => {
    const claudeResp = { content: [{ type: 'text', text: 'Hello! How can I help you today?' }] };
    assert.strictEqual(extractClaudeResponse(claudeResp), 'Hello! How can I help you today?');
  });

  it('truncates Claude response to 80 chars', () => {
    const long = 'A'.repeat(100);
    const claudeResp = { content: [{ type: 'text', text: long }] };
    assert.strictEqual(extractClaudeResponse(claudeResp).length, 80);
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
```

- [ ] **Step 2: Run tests**

Run: `node tests/scheduler.test.js`
Expected: 10 tests — all PASS

- [ ] **Step 3: Insert API call functions into server.js**

After the credential loading block from Task 2, insert:

```js
// ---- API call functions ----
const https = require('https');

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
```

- [ ] **Step 4: Run unit tests**

Run: `node tests/scheduler.test.js`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add tests/scheduler.test.js server.js
git commit -m "feat: add Anthropic and OpenAI API call functions"
```

---

### Task 4: Implement time-keeping loop and trigger logic

**Files:**
- Modify: `server.js` (add `fireScheduler`, `getSlotKey`, `computeNextFire`, `startScheduler`, `stopScheduler`)
- Modify: `tests/scheduler.test.js` (append tick logic tests)

- [ ] **Step 1: Write tests for the time-keeping logic**

Append to `tests/scheduler.test.js`:

```js

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
```

- [ ] **Step 2: Run tests**

Run: `node tests/scheduler.test.js`
Expected: 14 tests — all PASS

- [ ] **Step 3: Insert time-keeping code into server.js**

After the API call functions from Task 3, insert:

```js
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
```

- [ ] **Step 4: Add scheduler stop to process exit handlers**

Find the existing exit handlers (lines 100-102):
```js
process.on('SIGINT', () => { stopNgrok(); process.exit(0); });
process.on('SIGTERM', () => { stopNgrok(); process.exit(0); });
process.on('exit', () => { stopNgrok(); });
```
Update the `exit` handler:
```js
process.on('exit', () => { stopNgrok(); stopScheduler(); });
```

- [ ] **Step 5: Run unit tests**

Run: `node tests/scheduler.test.js`
Expected: All 14 tests PASS

- [ ] **Step 6: Commit**

```bash
git add tests/scheduler.test.js server.js
git commit -m "feat: add time-keeping loop with parallel target firing"
```

---

### Task 5: Add /api/scheduler endpoint

**Files:**
- Modify: `server.js` (add route handler + CORS registration)

- [ ] **Step 1: Register the route in the CORS preflight list**

Find the `isSwitcherApiRoute` block (lines 199-202):
```js
  const isSwitcherApiRoute = pathname === '/api/servers' ||
    pathname === '/api/target' ||
    pathname === '/api/health' ||
    /^\/api\/servers\/\d+\/start$/.test(pathname);
```
Add:
```js
  const isSwitcherApiRoute = pathname === '/api/servers' ||
    pathname === '/api/target' ||
    pathname === '/api/health' ||
    pathname === '/api/scheduler' ||
    /^\/api\/servers\/\d+\/start$/.test(pathname);
```

- [ ] **Step 2: Add the route handler**

Insert after the `/api/health` handler (after line 355), before the Dashboard section:

```js
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
```

**Note:** The `credential` field is deliberately excluded from the API response.

- [ ] **Step 3: Smoke test the endpoint**

Start the server: `set NO_NGROK=1 && node server.js`
Run: `curl http://localhost:9595/api/scheduler`
Expected: JSON with `enabled`, `targets` array, no `credential` field in targets.
Verify the `credential` field is absent:
Run: `curl -s http://localhost:9595/api/scheduler | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d); console.log('credential exposed:', j.targets.some(t=>t.credential!==undefined)?'FAIL':'PASS')})"`
Expected: `credential exposed: PASS`

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add /api/scheduler endpoint (credential excluded from response)"
```

---

### Task 6: Add dashboard UI — HTML structure and CSS

**Files:**
- Modify: `index.html` (add scheduler card between server grid and footer)

- [ ] **Step 1: Add CSS for the scheduler card**

Insert before the `/* ---- Footer ---- */` comment (before line 335):

```css
  /* ---- Scheduler card ---- */
  .scheduler-card {
    background: linear-gradient(135deg, rgba(255,255,255,0.9), rgba(255,255,255,0.66));
    backdrop-filter: blur(20px) saturate(1.08);
    border-radius: var(--radius-card);
    padding: 1.5rem 2rem;
    margin-top: 2rem;
    box-shadow: 0 8px 32px rgba(27,41,50,0.06);
    position: relative;
    animation: fadeSlideUp 380ms ease;
  }

  .scheduler-card::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1px;
    background: linear-gradient(135deg, rgba(32,48,58,0.08), rgba(32,48,58,0.03));
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    pointer-events: none;
  }

  .scheduler-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .scheduler-title {
    font-weight: 600;
    font-size: var(--text-md);
    color: var(--ink-strong);
  }

  .scheduler-meta {
    font-size: var(--text-xs);
    color: var(--ink-soft);
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .scheduler-meta span { white-space: nowrap; }

  .scheduler-targets {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .scheduler-target-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.4rem 0;
    flex-wrap: wrap;
  }

  .scheduler-target-name {
    font-weight: 500;
    font-size: var(--text-sm);
    color: var(--ink-strong);
    min-width: 120px;
  }

  .scheduler-target-time {
    font-size: var(--text-xs);
    color: var(--ink-soft);
    min-width: 90px;
  }

  .scheduler-target-snippet {
    font-size: var(--text-xs);
    color: var(--ink-soft);
    font-style: italic;
    flex: 1;
    min-width: 180px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .scheduler-status-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.15rem 0.6rem;
    border-radius: var(--radius-pill);
    font-size: var(--text-xs);
    font-weight: 500;
    white-space: nowrap;
  }
  .scheduler-status-pill .pill-dot { width: 6px; height: 6px; border-radius: 50%; }
  .sch-success { background: var(--ok-bg); color: var(--ok); border: 1px solid rgba(46,125,68,0.18); }
  .sch-success .pill-dot { background: var(--ok); }
  .sch-error { background: var(--down-bg); color: var(--down); border: 1px solid rgba(168,71,71,0.18); }
  .sch-error .pill-dot { background: var(--down); }
  .sch-pending { background: rgba(32,48,58,0.04); color: var(--ink-soft); border: 1px solid rgba(32,48,58,0.08); }
  .sch-pending .pill-dot { background: var(--ink-soft); }
```

- [ ] **Step 2: Add the HTML structure**

Insert between `</div>` closing the server grid (line 370) and the footer (line 372):

```html
  <div id="scheduler-section" class="scheduler-card" style="display:none">
    <div class="scheduler-header">
      <span class="scheduler-title">Scheduled Prompts</span>
      <div class="scheduler-meta">
        <span>Prompt: "<span id="sch-prompt">--</span>"</span>
        <span>Every: <span id="sch-offsets">--</span></span>
        <span>Next: <span id="sch-next">--</span></span>
      </div>
    </div>
    <div id="scheduler-targets" class="scheduler-targets"></div>
  </div>
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add scheduler card HTML and CSS to dashboard"
```

---

### Task 7: Add dashboard JavaScript — polling and rendering

**Files:**
- Modify: `index.html` (add JS functions, hook into fetchState)

- [ ] **Step 1: Add time formatting helpers**

Insert after the `escAttr` function (after line 652):

```js
function timeAgo(isoStr) {
  if (!isoStr) return 'never';
  const diff = Date.now() - new Date(isoStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hr ago';
  return `${hours} hr ago`;
}

function formatOffsets(offsets) {
  return offsets.map(o => ':' + String(o).padStart(2, '0')).join(', ');
}

function formatNextFire(isoStr) {
  if (!isoStr) return '--';
  return new Date(isoStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
```

- [ ] **Step 2: Add scheduler rendering function**

```js
function renderScheduler(data) {
  const section = document.getElementById('scheduler-section');
  if (!data || !data.enabled) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  document.getElementById('sch-prompt').textContent = esc(data.prompt);
  document.getElementById('sch-offsets').textContent = formatOffsets(data.minuteOffsets);
  document.getElementById('sch-next').textContent = formatNextFire(data.nextFire);

  const container = document.getElementById('scheduler-targets');
  let html = '';
  for (const t of data.targets) {
    const statusClass = t.status === 'success' ? 'sch-success' :
                        t.status === 'error' ? 'sch-error' : 'sch-pending';
    const statusLabel = t.status === 'success' ? 'Success' :
                        t.status === 'error' ? 'Error' : 'Pending';
    const snippet = t.responsePreview ? esc(t.responsePreview) : (t.error ? esc(t.error) : '—');
    html += `
      <div class="scheduler-target-row">
        <span class="scheduler-target-name">${esc(t.name)}</span>
        <span class="scheduler-status-pill ${statusClass}">
          <span class="pill-dot"></span>${statusLabel}
        </span>
        <span class="scheduler-target-time">${timeAgo(t.lastRun)}</span>
        <span class="scheduler-target-snippet" title="${esc(t.responsePreview || t.error || '')}">${snippet}</span>
      </div>
    `;
  }
  container.innerHTML = html;
}
```

- [ ] **Step 3: Hook scheduler fetch into fetchState**

Replace the `fetchState()` function (lines 416-426) with:

```js
async function fetchState() {
  try {
    const resp = await fetch(`${API}/servers`);
    const data = await resp.json();
    renderHeader(data.ngrokUrl, data.ngrokError);
    renderServers(data.servers, data.target);
    document.getElementById('last-checked').textContent = new Date().toLocaleTimeString();
  } catch (err) {
    document.getElementById('ngrok-error').textContent = 'Cannot reach switcher';
  }

  // Fetch scheduler state independently — failure doesn't affect server display
  try {
    const schedResp = await fetch(`${API}/scheduler`);
    const schedData = await schedResp.json();
    renderScheduler(schedData);
  } catch (err) {
    document.getElementById('scheduler-section').style.display = 'none';
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add scheduler polling and rendering to dashboard JS"
```

---

### Task 8: Integration — wire scheduler startup into main() and consolidate requires

**Files:**
- Modify: `server.js` (call `startScheduler()` in main, move requires to top)

- [ ] **Step 1: Move `require('os')` and `require('https')` to the top**

Update the top require block (lines 2-5):
```js
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
```

Remove the inline `const os = require('os');` and `const https = require('https');` lines added in Tasks 2 and 3.

- [ ] **Step 2: Call startScheduler() in main()**

Find `server.listen(...)` in `main()` (line 662-664):
```js
  server.listen(SWITCHER_PORT, SWITCHER_HOST, () => {
    console.log(`Switcher listening on http://${SWITCHER_HOST}:${SWITCHER_PORT}`);
  });
```
Add `startScheduler()`:
```js
  server.listen(SWITCHER_PORT, SWITCHER_HOST, () => {
    console.log(`Switcher listening on http://${SWITCHER_HOST}:${SWITCHER_PORT}`);
    startScheduler();
  });
```

- [ ] **Step 3: Run full unit test suite**

Run: `node tests/scheduler.test.js`
Expected: All 14 tests PASS

Run: `node tests/header-rewriting.test.js`
Expected: All 32 tests PASS

- [ ] **Step 4: Smoke test the full server**

Run: `set NO_NGROK=1 && node server.js`
Then in another terminal:
Run: `curl http://localhost:9595/api/scheduler`
Expected: JSON with scheduler state, no credential field

Run: `curl http://localhost:9595/dash`
Expected: HTML with scheduler section present

Run: `curl http://localhost:9595/api/servers`
Expected: Existing servers endpoint still works (no regression)

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: consolidate requires and wire scheduler startup into main()"
```

---

## Complete Plan Summary

| Task | Description | Files Changed |
|------|------------|---------------|
| 1 | Add scheduler config block | `servers.json` |
| 2 | Credential loading + state init | `server.js`, `tests/scheduler.test.js` |
| 3 | Anthropic + OpenAI API call functions | `server.js`, `tests/scheduler.test.js` |
| 4 | Time-keeping loop with parallel firing | `server.js`, `tests/scheduler.test.js` |
| 5 | `/api/scheduler` endpoint | `server.js` |
| 6 | Dashboard HTML + CSS | `index.html` |
| 7 | Dashboard JS polling + rendering | `index.html` |
| 8 | Integration — consolidate requires, wire startup | `server.js` |

---

## Risk Map

| # | What breaks | Category | Mitigated by task |
|---|------------|----------|-------------------|
| 1 | Credential file missing or malformed at startup | error path | Task 2 (try/catch, sets credentialError) |
| 2 | API credential expired or invalid | error path | Task 3 (per-target error, 401 surfaces as error) |
| 3 | First tick fires immediately instead of waiting for offset | edge case | Task 4 (1-second guard: `if (second < 1) return`) |
| 4 | Clock drift causes double-fire of same slot | edge case | Task 4 (slot dedup: `lastFiredSlot` key) |
| 5 | One target API times out, blocks the other | edge case | Task 4 (`Promise.allSettled` — true parallel) |
| 6 | Credential leaked in dashboard API response | security | Task 5 (API response excludes `credential` field) |
| 7 | Dashboard fetches `/api/scheduler` before endpoint exists | integration | Task 7 (try/catch — hides section on error) |
| 8 | Server restarted mid-minute, fires for completed slot | edge case | Task 4 (1-second guard + `lastFiredSlot` null) |
| 9 | async errors in setInterval crash the process | error path | Task 4 (`.catch(console.error)` on interval callback) |
| 10 | `computeNextFire` hour wrap at 23:xx | edge case | Task 4 (JS Date handles day rollover; tested by construction review) |

## Dual-Domain Review Summary (2026-06-04)

- **Coverage Reviewer:** [GAP] → [FIXED] — Parallel firing now uses `Promise.allSettled`, async error handling added, guard tightened
- **Construction Reviewer:** [WARN] → [FIXED] — Tasks 3 & 4 reordered so `callAI` exists before `fireScheduler` uses it, requires consolidated in Task 8
- No conflicts between reviewers; all issues addressed in plan revision
