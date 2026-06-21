# Usage Limit Cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port provider usage limit tracking (backend + frontend cards) from llm-dashboard into ngrok-dashboard as compact cards in the top row.

**Architecture:** Backend adds provider service modules + SQLite cache + API endpoints to existing Node.js HTTP server. Frontend adds vanilla JS card rendering in index.html with CSS grid + flicker-free DOM diffing. No new dependencies.

**Tech Stack:** Node.js >=18, better-sqlite3, vanilla HTML/CSS/JS, Playwright for E2E

---

### Task 1: Create directory structure + port provider-result.js

**Files:**
- Create: `server/providers/provider-result.js`
- Create: `server/providers/` (directory)
- Create: `server/jobs/` (directory)

- [ ] **Step 1: Create directories and provider-result.js**

```js
// server/providers/provider-result.js
'use strict';

function normalizeWindow(window) {
  if (!window) return null;
  return {
    usedPercent: window.usedPercent ?? null,
    resetsAt: window.resetsAt ?? null,
    windowDurationMins: window.windowDurationMins ?? null
  };
}

function createProviderResult({ fiveHour = null, sevenDay = null, balanceUsd = null, balanceAud = null, error = null } = {}) {
  return {
    fiveHour: normalizeWindow(fiveHour),
    sevenDay: normalizeWindow(sevenDay),
    balanceUsd,
    balanceAud,
    error
  };
}

module.exports = { normalizeWindow, createProviderResult };
```

- [ ] **Step 2: Commit**

```bash
git add server/providers/ server/jobs/
git commit -m "feat: add provider directory structure and provider-result module"
```

---

### Task 2: Port exchange-rates.js

**Files:**
- Create: `server/providers/exchange-rates.js`

- [ ] **Step 1: Write exchange-rates.js**

```js
// server/providers/exchange-rates.js
'use strict';
const { createProviderResult } = require('./provider-result.js');

const EXCHANGE_RATES_URL = 'https://open.er-api.com/v6/latest/USD';

async function fetchUsdToAudRate({ fetchFn } = {}) {
  const fetcher = fetchFn || fetch;
  const response = await fetcher(EXCHANGE_RATES_URL);
  if (!response.ok) {
    throw new Error(`Exchange rate request failed with status ${response.status}.`);
  }
  const payload = await response.json();
  const audRate = payload?.rates?.AUD;
  if (typeof audRate !== 'number' || !Number.isFinite(audRate)) {
    throw new Error('Exchange rate response did not contain rates.AUD.');
  }
  return audRate;
}

async function fetchExchangeRateProviderData({ deps = {} } = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const audRate = await fetchUsdToAudRate({ fetchFn });
  return {
    ...createProviderResult(),
    rates: { AUD: audRate }
  };
}

async function resolveUsdToAudRate({ providerCacheRepo, deps = {} } = {}) {
  if (providerCacheRepo) {
    const cached = providerCacheRepo.getByProviderId('exchange_rates');
    const cachedRate = cached?.data?.rates?.AUD;
    if (typeof cachedRate === 'number' && Number.isFinite(cachedRate)) {
      return cachedRate;
    }
  }
  const fetchFn = deps.fetchFn || fetch;
  return fetchUsdToAudRate({ fetchFn });
}

module.exports = { fetchExchangeRateProviderData, resolveUsdToAudRate, fetchUsdToAudRate };
```

- [ ] **Step 2: Commit**

```bash
git add server/providers/exchange-rates.js
git commit -m "feat: add exchange-rates provider service"
```

---

### Task 3: Port claude-code.js provider

**Files:**
- Create: `server/providers/claude-code.js`

- [ ] **Step 1: Write claude-code.js**

```js
// server/providers/claude-code.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProviderResult } = require('./provider-result.js');

function getClaudeCredentialsPath(homeDir = os.homedir(), platform = process.platform) {
  if (platform === 'win32') {
    return path.join(homeDir, '.claude', '.credentials.json');
  }
  return path.join(homeDir, '.claude', '.credentials.json');
}

function readCredentials(credentialsPath, readFileFn = fs.readFileSync) {
  const raw = JSON.parse(readFileFn(credentialsPath, 'utf8'));
  const oauth = raw.claudeAiOauth || raw.oauth || raw;
  return {
    accessToken: oauth.accessToken || oauth.access_token || raw.accessToken || raw.access_token,
    refreshToken: oauth.refreshToken || oauth.refresh_token || raw.refreshToken || raw.refresh_token,
    expiresAt: oauth.expiresAt || oauth.expires_at || raw.expiresAt || raw.expires_at || null
  };
}

function normalizeClaudeUtilization(utilization) {
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null;
  if (utilization <= 1) return Math.round(utilization * 100);
  return Math.round(utilization);
}

async function fetchClaudeCodeProviderData({ deps = {} } = {}) {
  const credentialsPath = deps.credentialsPath || getClaudeCredentialsPath(deps.homeDir || os.homedir(), deps.platform || process.platform);
  let credentials = readCredentials(credentialsPath, deps.readFileFn);
  if (!credentials.accessToken || !credentials.refreshToken) {
    throw new Error('Claude credentials file is missing OAuth tokens.');
  }
  const fetcher = deps.fetchFn || fetch;
  const response = await fetcher('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20'
    }
  });
  if (!response.ok) {
    throw new Error(`Claude usage request failed with status ${response.status}.`);
  }
  const payload = await response.json();
  return createProviderResult({
    fiveHour: {
      usedPercent: normalizeClaudeUtilization(payload?.five_hour?.utilization),
      resetsAt: payload?.five_hour?.resets_at ?? null,
      windowDurationMins: 300
    },
    sevenDay: {
      usedPercent: normalizeClaudeUtilization(payload?.seven_day?.utilization),
      resetsAt: payload?.seven_day?.resets_at ?? null,
      windowDurationMins: 10080
    }
  });
}

module.exports = { fetchClaudeCodeProviderData, getClaudeCredentialsPath, readCredentials, normalizeClaudeUtilization };
```

- [ ] **Step 2: Commit**

```bash
git add server/providers/claude-code.js
git commit -m "feat: add claude-code provider service"
```

---

### Task 4: Port codex.js provider

**Files:**
- Create: `server/providers/codex.js`

- [ ] **Step 1: Write codex.js**

```js
// server/providers/codex.js
'use strict';
const { spawn } = require('child_process');
const { createProviderResult } = require('./provider-result.js');

function createJsonRpcError(message) {
  return new Error(`Codex JSON-RPC error: ${message}`);
}

function writeJsonRpc(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

function normalizeResetTimestamp(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const epochMs = value < 10000000000 ? value * 1000 : value;
    return new Date(epochMs).toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function resolveCommandAndArgs(deps) {
  if (deps.command) return { command: deps.command, args: ['app-server'] };
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'codex', 'app-server'] };
  }
  return { command: 'codex', args: ['app-server'] };
}

async function fetchCodexProviderData({ deps = {} } = {}) {
  const spawnFn = deps.spawnFn || spawn;
  const timeoutMs = deps.timeoutMs || 10000;
  const { command, args } = resolveCommandAndArgs(deps);
  const child = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let requestId = 0;
  let buffer = '';
  const initializePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Codex app-server timed out.')); }, timeoutMs);
    function cleanup() { clearTimeout(timeout); child.stdout?.off('data', onData); child.stderr?.off('data', onStderr); child.off('error', onError); child.off('exit', onExit); }
    function onError(error) { cleanup(); reject(error); }
    function onExit(code) { cleanup(); reject(new Error(`Codex app-server exited before responding (code ${code}).`)); }
    function onStderr(chunk) { buffer += ''; }
    function onData(chunk) {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { cleanup(); reject(new Error('Codex app-server returned invalid JSON.')); return; }
        if (message.error) { cleanup(); reject(createJsonRpcError(message.error.message || 'Unknown error')); return; }
        if (message.id === 2) { cleanup(); child.kill('SIGTERM'); resolve(message.result); }
      }
    }
    child.on('error', onError);
    child.on('exit', onExit);
    child.stderr?.on('data', onStderr);
    child.stdout?.on('data', onData);
    requestId += 1;
    writeJsonRpc(child.stdin, { jsonrpc: '2.0', id: requestId, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'llm-dashboard', version: '0.1.0' }, capabilities: {} } });
    writeJsonRpc(child.stdin, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    requestId += 1;
    writeJsonRpc(child.stdin, { jsonrpc: '2.0', id: requestId, method: 'account/rateLimits/read', params: {} });
  });
  const payload = await initializePromise;
  return createProviderResult({
    fiveHour: {
      usedPercent: payload?.rateLimits?.primary?.usedPercent ?? null,
      resetsAt: normalizeResetTimestamp(payload?.rateLimits?.primary?.resetsAt),
      windowDurationMins: payload?.rateLimits?.primary?.windowDurationMins ?? null
    },
    sevenDay: {
      usedPercent: payload?.rateLimits?.secondary?.usedPercent ?? null,
      resetsAt: normalizeResetTimestamp(payload?.rateLimits?.secondary?.resetsAt),
      windowDurationMins: payload?.rateLimits?.secondary?.windowDurationMins ?? null
    }
  });
}

module.exports = { fetchCodexProviderData, normalizeResetTimestamp, resolveCommandAndArgs };
```

- [ ] **Step 2: Commit**

```bash
git add server/providers/codex.js
git commit -m "feat: add codex provider service"
```

---

### Task 5: Port openrouter.js provider

**Files:**
- Create: `server/providers/openrouter.js`

- [ ] **Step 1: Write openrouter.js**

```js
// server/providers/openrouter.js
'use strict';
const { createProviderResult } = require('./provider-result.js');
const { resolveUsdToAudRate } = require('./exchange-rates.js');

const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';

async function fetchJson(fetcher, url, apiKey) {
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`OpenRouter request failed with status ${response.status}.`);
  return response.json();
}

async function fetchOpenRouterProviderData({ settings, providerCacheRepo, deps = {} } = {}) {
  const apiKey = settings.openrouterApiKey;
  if (!apiKey) throw new Error('OpenRouter API key is not configured.');
  const fetchFn = deps.fetchFn || fetch;
  const payload = await fetchJson(fetchFn, OPENROUTER_KEY_URL, apiKey);
  const remainingValue = payload?.data?.limit_remaining;
  let balanceUsd = typeof remainingValue === 'number' ? remainingValue
    : typeof remainingValue === 'string' && remainingValue.trim() ? Number(remainingValue) : null;
  if (balanceUsd !== null && !Number.isFinite(balanceUsd)) {
    throw new Error('OpenRouter response contained an invalid data.limit_remaining value.');
  }
  if (balanceUsd === null) {
    const creditsPayload = await fetchJson(fetchFn, OPENROUTER_CREDITS_URL, apiKey);
    const totalCredits = creditsPayload?.data?.total_credits;
    const totalUsage = creditsPayload?.data?.total_usage;
    if (typeof totalCredits !== 'number' || !Number.isFinite(totalCredits) ||
        typeof totalUsage !== 'number' || !Number.isFinite(totalUsage)) {
      return createProviderResult();
    }
    balanceUsd = Number(Math.max(0, totalCredits - totalUsage).toFixed(2));
  }
  const audRate = await resolveUsdToAudRate({ providerCacheRepo, deps });
  return createProviderResult({
    balanceUsd,
    balanceAud: Number((balanceUsd * audRate).toFixed(2))
  });
}

module.exports = { fetchOpenRouterProviderData };
```

- [ ] **Step 2: Commit**

```bash
git add server/providers/openrouter.js
git commit -m "feat: add openrouter provider service"
```

---

### Task 6: Port deepseek.js provider

**Files:**
- Create: `server/providers/deepseek.js`

- [ ] **Step 1: Write deepseek.js**

```js
// server/providers/deepseek.js
'use strict';
const { createProviderResult } = require('./provider-result.js');
const { resolveUsdToAudRate } = require('./exchange-rates.js');

const DEEPSEEK_URL = 'https://api.deepseek.com/user/balance';

async function fetchDeepSeekProviderData({ settings, providerCacheRepo, deps = {} } = {}) {
  const apiKey = settings.deepseekApiKey;
  if (!apiKey) throw new Error('DeepSeek API key is not configured.');
  const fetchFn = deps.fetchFn || fetch;
  const response = await fetchFn(DEEPSEEK_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`DeepSeek request failed with status ${response.status}.`);
  const payload = await response.json();
  const usdEntry = payload?.balance_infos?.find(entry => entry?.currency === 'USD') || payload?.balance_infos?.[0];
  const rawBalance = usdEntry?.total_balance;
  const balanceUsd = typeof rawBalance === 'string' ? Number.parseFloat(rawBalance) : rawBalance;
  if (typeof balanceUsd !== 'number' || !Number.isFinite(balanceUsd)) {
    throw new Error('DeepSeek response did not contain balance_infos[0].total_balance.');
  }
  const audRate = await resolveUsdToAudRate({ providerCacheRepo, deps });
  return createProviderResult({
    balanceUsd,
    balanceAud: Number((balanceUsd * audRate).toFixed(2))
  });
}

module.exports = { fetchDeepSeekProviderData };
```

- [ ] **Step 2: Commit**

```bash
git add server/providers/deepseek.js
git commit -m "feat: add deepseek provider service"
```

---

### Task 7: Create opencode-go.js provider (new)

**Files:**
- Create: `server/providers/opencode-go.js`

- [ ] **Step 1: Write opencode-go.js**

```js
// server/providers/opencode-go.js
'use strict';
const { createProviderResult } = require('./provider-result.js');

// Static Go limits from OpenCode docs
const GO_LIMITS = {
  fiveHour: { usedPercent: 0, resetsAt: null, windowDurationMins: 300 },
  sevenDay: { usedPercent: 0, resetsAt: null, windowDurationMins: 10080 },
  monthly: { usedDollars: 0, limitDollars: 60 }
};

const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

async function fetchOpenCodeGoProviderData({ settings, deps = {} } = {}) {
  const apiKey = settings.opencodeGoApiKey;
  if (!apiKey) {
    // No key = show static limits as stale
    return createProviderResult({
      fiveHour: { ...GO_LIMITS.fiveHour },
      sevenDay: { ...GO_LIMITS.sevenDay },
      error: { message: 'OpenCode Go API key is not configured. Showing static limits.' }
    });
  }
  const fetchFn = deps.fetchFn || fetch;
  try {
    const response = await fetchFn(GO_USAGE_URL, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!response.ok) {
      throw new Error(`OpenCode Go usage request failed with status ${response.status}.`);
    }
    const payload = await response.json();
    return createProviderResult({
      fiveHour: {
        usedPercent: payload?.fiveHour?.usedPercent ?? GO_LIMITS.fiveHour.usedPercent,
        resetsAt: payload?.fiveHour?.resetsAt ?? null,
        windowDurationMins: payload?.fiveHour?.windowDurationMins ?? GO_LIMITS.fiveHour.windowDurationMins
      },
      sevenDay: {
        usedPercent: payload?.sevenDay?.usedPercent ?? GO_LIMITS.sevenDay.usedPercent,
        resetsAt: payload?.sevenDay?.resetsAt ?? null,
        windowDurationMins: payload?.sevenDay?.windowDurationMins ?? GO_LIMITS.sevenDay.windowDurationMins
      }
    });
  } catch {
    // API unavailable — fall back to static limits
    return createProviderResult({
      fiveHour: { ...GO_LIMITS.fiveHour },
      sevenDay: { ...GO_LIMITS.sevenDay },
      error: { message: 'OpenCode Go API unavailable. Showing static limits.' }
    });
  }
}

module.exports = { fetchOpenCodeGoProviderData, GO_LIMITS };
```

- [ ] **Step 2: Commit**

```bash
git add server/providers/opencode-go.js
git commit -m "feat: add opencode-go provider service with static limit fallback"
```

---

### Task 8: Port registry.js

**Files:**
- Create: `server/providers/registry.js`

- [ ] **Step 1: Write registry.js**

```js
// server/providers/registry.js
'use strict';
const { fetchClaudeCodeProviderData } = require('./claude-code.js');
const { fetchCodexProviderData } = require('./codex.js');
const { fetchOpenRouterProviderData } = require('./openrouter.js');
const { fetchDeepSeekProviderData } = require('./deepseek.js');
const { fetchOpenCodeGoProviderData } = require('./opencode-go.js');
const { fetchExchangeRateProviderData } = require('./exchange-rates.js');

function createProviderRegistry(overrides = {}) {
  const defaultProviders = [
    { providerId: 'claude_code', displayName: 'Claude Code', exposeInProvidersApi: true, fetchProviderData: fetchClaudeCodeProviderData },
    { providerId: 'codex', displayName: 'Codex', exposeInProvidersApi: true, fetchProviderData: fetchCodexProviderData },
    { providerId: 'openrouter', displayName: 'OpenRouter', exposeInProvidersApi: true, fetchProviderData: fetchOpenRouterProviderData },
    { providerId: 'deepseek', displayName: 'DeepSeek', exposeInProvidersApi: true, fetchProviderData: fetchDeepSeekProviderData },
    { providerId: 'opencode_go', displayName: 'OpenCode Go', exposeInProvidersApi: true, fetchProviderData: fetchOpenCodeGoProviderData },
    { providerId: 'exchange_rates', displayName: 'Exchange Rates', exposeInProvidersApi: false, fetchProviderData: fetchExchangeRateProviderData }
  ];
  return defaultProviders.map(provider => ({ ...provider, ...(overrides[provider.providerId] || {}) }));
}

module.exports = { createProviderRegistry };
```

- [ ] **Step 2: Commit**

```bash
git add server/providers/registry.js
git commit -m "feat: add provider registry with 5 visible providers"
```

---

### Task 9: Create SQLite provider-cache-repo + schema

**Files:**
- Create: `server/db/provider-cache-repo.js`
- Modify: `server.js` (add schema + repo initialization)

- [ ] **Step 1: Write provider-cache-repo.js**

```js
// server/db/provider-cache-repo.js
'use strict';

function createProviderCacheRepo(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS provider_cache (
      provider_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);

  const upsertStatement = database.prepare(`
    INSERT INTO provider_cache (provider_id, data, fetched_at)
    VALUES (@providerId, @data, @fetchedAt)
    ON CONFLICT(provider_id) DO UPDATE SET
      data = excluded.data,
      fetched_at = excluded.fetched_at
  `);
  const getStatement = database.prepare(`
    SELECT provider_id, data, fetched_at FROM provider_cache WHERE provider_id = ?
  `);

  return {
    upsert({ providerId, data, fetchedAt }) {
      upsertStatement.run({ providerId, data: JSON.stringify(data), fetchedAt });
    },
    getByProviderId(providerId) {
      const row = getStatement.get(providerId);
      if (!row) return null;
      return { providerId: row.provider_id, data: JSON.parse(row.data), fetchedAt: row.fetched_at };
    }
  };
}

module.exports = { createProviderCacheRepo };
```

- [ ] **Step 2: Commit**

```bash
git add server/db/provider-cache-repo.js
git commit -m "feat: add provider-cache SQLite repo"
```

---

### Task 10: Create refresh-providers job

**Files:**
- Create: `server/jobs/refresh-providers.js`

- [ ] **Step 1: Write refresh-providers.js**

```js
// server/jobs/refresh-providers.js
'use strict';
const { createProviderResult } = require('../providers/provider-result.js');

const STALE_WARNING_MS = 6 * 60 * 1000;
const STALE_ERROR_MS = 30 * 60 * 1000;

function getProviderStatus({ fetchedAt, error, now = Date.now() }) {
  if (fetchedAt === null || fetchedAt === undefined) return 'never_fetched';
  if (error) return 'error';
  const age = now - fetchedAt;
  if (age >= STALE_ERROR_MS) return 'error';
  if (age >= STALE_WARNING_MS) return 'stale';
  return 'fresh';
}

function buildProviderApiRow(provider, cacheRow, now = Date.now()) {
  const payload = cacheRow?.data || createProviderResult();
  return {
    providerId: provider.providerId,
    displayName: provider.displayName,
    status: getProviderStatus({ fetchedAt: cacheRow?.fetchedAt ?? null, error: payload.error, now }),
    fiveHour: payload.fiveHour ?? null,
    sevenDay: payload.sevenDay ?? null,
    balanceUsd: payload.balanceUsd ?? null,
    balanceAud: payload.balanceAud ?? null,
    error: payload.error ?? null,
    fetchedAt: cacheRow?.fetchedAt ?? null
  };
}

function createRefreshService({ registry, providerCacheRepo, settings, now = () => Date.now() }) {
  const ownerFacingProviders = registry.filter(p => p.exposeInProvidersApi);

  async function refreshProvider(providerId) {
    const provider = registry.find(e => e.providerId === providerId);
    if (!provider) return null;
    try {
      const result = await provider.fetchProviderData({ settings, providerCacheRepo, deps: { now } });
      providerCacheRepo.upsert({ providerId: provider.providerId, data: result, fetchedAt: now() });
      return providerCacheRepo.getByProviderId(provider.providerId);
    } catch (error) {
      const previous = providerCacheRepo.getByProviderId(provider.providerId);
      providerCacheRepo.upsert({
        providerId: provider.providerId,
        data: { ...(previous?.data || createProviderResult()), error: { message: error.message } },
        fetchedAt: previous?.fetchedAt ?? now()
      });
      return providerCacheRepo.getByProviderId(provider.providerId);
    }
  }

  async function refreshAll() {
    for (const provider of registry) {
      await refreshProvider(provider.providerId);
    }
  }

  function listProviderRows() {
    return ownerFacingProviders.map(provider =>
      buildProviderApiRow(provider, providerCacheRepo.getByProviderId(provider.providerId), now())
    );
  }

  return { ownerFacingProviders, refreshAll, refreshProvider, listProviderRows };
}

module.exports = { createRefreshService, getProviderStatus, buildProviderApiRow };
```

- [ ] **Step 2: Commit**

```bash
git add server/jobs/refresh-providers.js
git commit -m "feat: add refresh-providers job service"
```

---

### Task 11: Wire backend into server.js

**Files:**
- Modify: `server.js`
- Create: `usage.json`

- [ ] **Step 1: Add imports and initialization at top of server.js** (after existing requires)

```js
// ---- Provider Usage Tracking ----
const { createProviderRegistry } = require('./server/providers/registry.js');
const { createRefreshService } = require('./server/jobs/refresh-providers.js');
const { createProviderCacheRepo } = require('./server/db/provider-cache-repo.js');

let USAGE_CONFIG;
try {
  USAGE_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'usage.json'), 'utf8'));
} catch (e) {
  USAGE_CONFIG = {};
}
const USAGE_POLL_MS = Math.max(1, Math.min(60, USAGE_CONFIG.pollIntervalMinutes || 5)) * 60 * 1000;

// Initialize provider tracking (only if better-sqlite3 Database is available)
let refreshService = null;
function initProviderTracking(database) {
  if (!database) return;
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
}
```

- [ ] **Step 2: Add API routes** (before the "Dashboard" section, after existing API routes)

```js
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
```

- [ ] **Step 3: Call initProviderTracking after DB init** (find where better-sqlite3 DB is created in server.js and add the call)

Find: `const db = new Database(...)` or similar, add after:
```js
  initProviderTracking(db);
```

- [ ] **Step 4: Create usage.json**

```json
{
  "pollIntervalMinutes": 5,
  "openrouterApiKey": "",
  "deepseekApiKey": "",
  "opencodeGoApiKey": ""
}
```

- [ ] **Step 5: Commit**

```bash
git add server.js usage.json
git commit -m "feat: wire provider tracking backend into server.js"
```

---

### Task 12: Add CSS for compact usage cards

**Files:**
- Modify: `index.html` (add CSS in `<style>` block)

- [ ] **Step 1: Add CSS** — insert before the `</style>` closing tag

```css
  /* ---- Provider Usage Cards ---- */
  .provider-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
    gap: 0.9rem;
    margin-bottom: 1.5rem;
  }

  .provider-card {
    background: linear-gradient(180deg, rgba(240,248,252,0.92), rgba(235,244,248,0.75));
    backdrop-filter: blur(20px) saturate(1.08);
    border-radius: var(--radius-card);
    padding: 0.9rem;
    box-shadow: 0 8px 32px rgba(27,41,50,0.06);
    position: relative;
    overflow: hidden;
    animation: fadeSlideUp 380ms ease;
  }

  .provider-card::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1px;
    background: linear-gradient(135deg, rgba(70,106,90,0.12), rgba(32,48,58,0.04));
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    pointer-events: none;
  }

  .provider-card--danger {
    background: linear-gradient(180deg, rgba(255,245,245,0.92), rgba(255,240,240,0.75));
  }

  .provider-card__header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.5rem;
    margin-bottom: 0.65rem;
  }

  .provider-name {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--ink-strong);
  }

  .status-pill--fresh {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: var(--text-xs);
    font-weight: 500;
    padding: 0.2rem 0.55rem;
    border-radius: var(--radius-pill);
    background: rgba(46,125,68,0.13);
    color: #315343;
    white-space: nowrap;
  }

  .status-pill--stale {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: var(--text-xs);
    font-weight: 500;
    padding: 0.2rem 0.55rem;
    border-radius: var(--radius-pill);
    background: rgba(176,130,44,0.13);
    color: #6b4f1d;
    white-space: nowrap;
  }

  .status-pill--error {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: var(--text-xs);
    font-weight: 500;
    padding: 0.2rem 0.55rem;
    border-radius: var(--radius-pill);
    background: rgba(168,71,71,0.13);
    color: #6b3535;
    white-space: nowrap;
  }

  .status-pill--never_fetched {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: var(--text-xs);
    font-weight: 500;
    padding: 0.2rem 0.55rem;
    border-radius: var(--radius-pill);
    background: rgba(100,118,130,0.1);
    color: var(--ink-soft);
    white-space: nowrap;
  }

  .provider-card__body {
    display: grid;
    gap: 0.5rem;
  }

  .limit-row {
    display: grid;
    gap: 0.3rem;
    padding: 0.55rem 0.65rem;
    border: 1px solid rgba(88,114,132,0.12);
    border-radius: 14px;
    background: linear-gradient(180deg, rgba(255,255,255,0.5), rgba(255,255,255,0.22));
  }

  .limit-row__header {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    align-items: flex-start;
    font-size: var(--text-xs);
    color: var(--ink-strong);
  }

  .limit-row__subtext {
    font-size: var(--text-xs);
    color: var(--ink-soft);
  }

  .limit-bar {
    height: 0.5rem;
    border-radius: 999px;
    background: rgba(52,72,84,0.08);
    overflow: hidden;
    box-shadow: inset 0 1px 2px rgba(26,39,47,0.08);
  }

  .limit-bar__fill {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #567a6a 0%, #7a9e8c 100%);
    transition: width 320ms ease;
    position: relative;
  }

  .limit-bar__fill::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(255,255,255,0.34), transparent 75%);
  }

  .limit-bar__fill--danger {
    background: linear-gradient(90deg, #a65c52 0%, #d88e73 100%);
  }

  .provider-card__error {
    font-size: var(--text-xs);
    color: #a84747;
    padding-top: 0.3rem;
  }
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat: add compact provider card CSS styles"
```

---

### Task 13: Add HTML + vanilla JS renderProviders()

**Files:**
- Modify: `index.html` (add HTML section + JS functions)

- [ ] **Step 1: Add HTML** — insert `<section id="provider-grid">` between hero-card and opencode-card

```html
  <section id="provider-grid" class="provider-grid"></section>
```

- [ ] **Step 2: Add JS format utilities** — add after existing `esc()` function

```js
function formatCountdown(resetsAt) {
  if (!resetsAt) return 'N/A';
  const diffMs = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 'now';
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatResetAt(resetsAt) {
  if (!resetsAt) return 'N/A';
  return new Date(resetsAt).toLocaleString();
}

function formatPercentage(value) {
  if (value === null || value === undefined) return 'N/A';
  return `${value}%`;
}
```

- [ ] **Step 3: Add renderProviders() function** — add before `fetchState()`

```js
let providerCardMap = {};

function providerStatesEqual(a, b) {
  if (!a || !b) return false;
  if (a.status !== b.status) return false;
  if (a.error !== b.error) return false;
  if (!!a.fiveHour !== !!b.fiveHour) return false;
  if (a.fiveHour && b.fiveHour && (a.fiveHour.usedPercent !== b.fiveHour.usedPercent || a.fiveHour.resetsAt !== b.fiveHour.resetsAt)) return false;
  if (!!a.sevenDay !== !!b.sevenDay) return false;
  if (a.sevenDay && b.sevenDay && (a.sevenDay.usedPercent !== b.sevenDay.usedPercent || a.sevenDay.resetsAt !== b.sevenDay.resetsAt)) return false;
  return true;
}

const STATUS_LABELS = { fresh: 'fresh', stale: 'stale', error: 'error', never_fetched: 'waiting' };

async function fetchProviders() {
  try {
    const resp = await fetch('/api/providers');
    if (!resp.ok) return;
    const providers = await resp.json();
    renderProviders(providers);
  } catch (err) {
    // silently ignore — provider fetch is non-critical
  }
}

function renderProviders(providers) {
  const container = document.getElementById('provider-grid');
  if (!container) return;

  if (!providers || providers.length === 0) {
    container.innerHTML = '';
    providerCardMap = {};
    return;
  }

  // Build new state map
  const newStateMap = {};
  for (const p of providers) {
    const fivePct = p.fiveHour?.usedPercent ?? null;
    const sevenPct = p.sevenDay?.usedPercent ?? null;
    const maxPct = Math.max(fivePct ?? 0, sevenPct ?? 0);
    newStateMap[p.providerId] = {
      displayName: p.displayName,
      status: p.status,
      error: p.error?.message || null,
      fiveHour: p.fiveHour,
      sevenDay: p.sevenDay,
      isDanger: maxPct > 80
    };
  }

  // Remove cards that no longer exist
  for (const id of Object.keys(providerCardMap)) {
    if (!(id in newStateMap)) {
      providerCardMap[id].el.remove();
      delete providerCardMap[id];
    }
  }

  // Create or update cards
  for (const p of providers) {
    const state = newStateMap[p.providerId];
    const existing = providerCardMap[p.providerId];

    // Skip if unchanged
    if (existing && providerStatesEqual(existing.state, state)) continue;

    const card = existing ? existing.el : document.createElement('div');
    const dangerClass = state.isDanger ? ' provider-card--danger' : '';
    card.className = 'provider-card' + dangerClass;

    let bodyHTML = '';
    // 5h limit row
    if (state.fiveHour) {
      const pct = state.fiveHour.usedPercent ?? 0;
      const fillClass = pct > 80 ? ' limit-bar__fill--danger' : '';
      bodyHTML += `
        <div class="limit-row">
          <div class="limit-row__header">
            <span>5h limit</span>
            <span>${formatPercentage(state.fiveHour.usedPercent)} used · resets in ${formatCountdown(state.fiveHour.resetsAt)}</span>
          </div>
          <div class="limit-row__subtext">Reset at ${formatResetAt(state.fiveHour.resetsAt)}</div>
          <div class="limit-bar">
            <div class="limit-bar__fill${fillClass}" style="width:${Math.max(0, Math.min(100, pct))}%"></div>
          </div>
        </div>`;
    }
    // Weekly limit row
    if (state.sevenDay) {
      const pct = state.sevenDay.usedPercent ?? 0;
      const fillClass = pct > 80 ? ' limit-bar__fill--danger' : '';
      bodyHTML += `
        <div class="limit-row">
          <div class="limit-row__header">
            <span>Weekly</span>
            <span>${formatPercentage(state.sevenDay.usedPercent)} used · resets in ${formatCountdown(state.sevenDay.resetsAt)}</span>
          </div>
          <div class="limit-row__subtext">Reset at ${formatResetAt(state.sevenDay.resetsAt)}</div>
          <div class="limit-bar">
            <div class="limit-bar__fill${fillClass}" style="width:${Math.max(0, Math.min(100, pct))}%"></div>
          </div>
        </div>`;
    }

    card.innerHTML = `
      <div class="provider-card__header">
        <span class="provider-name">${esc(state.displayName)}</span>
        <span class="status-pill--${state.status}">${STATUS_LABELS[state.status] || state.status}</span>
      </div>
      <div class="provider-card__body">
        ${bodyHTML}
        ${state.error ? `<div class="provider-card__error">${esc(state.error)}</div>` : ''}
      </div>
    `;

    if (!existing) {
      container.appendChild(card);
    }

    providerCardMap[p.providerId] = { el: card, state };
  }
}
```

- [ ] **Step 4: Wire into auto-refresh** — modify `fetchState()` to also call `fetchProviders()` at the end and adjust the initial call + interval

Replace the bottom of the script section:
```js
fetchState();
setInterval(fetchState, 10000);
```
with:
```js
fetchState();
fetchProviders();
setInterval(fetchState, 10000);
setInterval(fetchProviders, 60000);
```

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: add provider grid rendering to dashboard"
```

---

### Task 14: Write unit tests

**Files:**
- Create: `tests/provider-services.test.js`

- [ ] **Step 1: Write test file** — use Node.js native test runner

```js
// tests/provider-services.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { normalizeWindow, createProviderResult } = require('../server/providers/provider-result.js');
const { getProviderStatus, buildProviderApiRow } = require('../server/jobs/refresh-providers.js');
const { createProviderRegistry } = require('../server/providers/registry.js');

describe('normalizeWindow', () => {
  it('returns null for falsy input', () => {
    assert.strictEqual(normalizeWindow(null), null);
    assert.strictEqual(normalizeWindow(undefined), null);
    assert.strictEqual(normalizeWindow(false), null);
  });

  it('normalizes valid window data', () => {
    const result = normalizeWindow({ usedPercent: 50, resetsAt: '2026-01-01T00:00:00Z', windowDurationMins: 300 });
    assert.strictEqual(result.usedPercent, 50);
    assert.strictEqual(result.resetsAt, '2026-01-01T00:00:00Z');
    assert.strictEqual(result.windowDurationMins, 300);
  });

  it('fills nulls for missing fields', () => {
    const result = normalizeWindow({});
    assert.strictEqual(result.usedPercent, null);
    assert.strictEqual(result.resetsAt, null);
    assert.strictEqual(result.windowDurationMins, null);
  });
});

describe('createProviderResult', () => {
  it('creates default result with all nulls', () => {
    const result = createProviderResult();
    assert.strictEqual(result.fiveHour, null);
    assert.strictEqual(result.sevenDay, null);
    assert.strictEqual(result.balanceUsd, null);
    assert.strictEqual(result.balanceAud, null);
    assert.strictEqual(result.error, null);
  });

  it('passes through provided values', () => {
    const result = createProviderResult({ balanceUsd: 10.5, error: { message: 'test' } });
    assert.strictEqual(result.balanceUsd, 10.5);
    assert.deepStrictEqual(result.error, { message: 'test' });
  });
});

describe('getProviderStatus', () => {
  it('returns never_fetched when fetchedAt is null/undefined', () => {
    assert.strictEqual(getProviderStatus({ fetchedAt: null, error: null, now: 1000 }), 'never_fetched');
    assert.strictEqual(getProviderStatus({ fetchedAt: undefined, error: null, now: 1000 }), 'never_fetched');
  });

  it('returns error when error is present', () => {
    assert.strictEqual(getProviderStatus({ fetchedAt: 1000, error: { message: 'fail' }, now: 1001 }), 'error');
  });

  it('returns fresh when within 6 min', () => {
    const now = 1000000;
    assert.strictEqual(getProviderStatus({ fetchedAt: now - 1000, error: null, now }), 'fresh');
  });

  it('returns stale when between 6-30 min', () => {
    const now = 1000000;
    assert.strictEqual(getProviderStatus({ fetchedAt: now - 7 * 60 * 1000, error: null, now }), 'stale');
  });

  it('returns error when older than 30 min', () => {
    const now = 1000000;
    assert.strictEqual(getProviderStatus({ fetchedAt: now - 31 * 60 * 1000, error: null, now }), 'error');
  });
});

describe('buildProviderApiRow', () => {
  it('assembles row from provider and cache row', () => {
    const provider = { providerId: 'test', displayName: 'Test' };
    const cacheRow = { data: createProviderResult({ fiveHour: { usedPercent: 10, resetsAt: null, windowDurationMins: 300 } }), fetchedAt: 1000 };
    const row = buildProviderApiRow(provider, cacheRow, 1060000);
    assert.strictEqual(row.providerId, 'test');
    assert.strictEqual(row.displayName, 'Test');
    assert.strictEqual(row.status, 'fresh');
    assert.strictEqual(row.fiveHour.usedPercent, 10);
  });

  it('handles missing cache row', () => {
    const provider = { providerId: 'test', displayName: 'Test' };
    const row = buildProviderApiRow(provider, null, 1000);
    assert.strictEqual(row.status, 'never_fetched');
    assert.strictEqual(row.fiveHour, null);
  });
});

describe('createProviderRegistry', () => {
  it('returns 6 providers (5 visible + 1 internal)', () => {
    const registry = createProviderRegistry();
    assert.strictEqual(registry.length, 6);
  });

  it('visible providers have exposeInProvidersApi=true', () => {
    const registry = createProviderRegistry();
    const visible = registry.filter(p => p.exposeInProvidersApi);
    assert.strictEqual(visible.length, 5);
  });

  it('accepts overrides', () => {
    const registry = createProviderRegistry({ claude_code: { displayName: 'Custom' } });
    const claude = registry.find(p => p.providerId === 'claude_code');
    assert.strictEqual(claude.displayName, 'Custom');
  });
});
```

- [ ] **Step 2: Run tests**

```bash
node --test tests/provider-services.test.js
```
Expected: all tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/provider-services.test.js
git commit -m "test: add provider services unit tests"
```

---

### Task 15: Integration + browser verification

**Files:**
- Create: `tests/provider-dashboard.spec.ts` (Playwright E2E)

- [ ] **Step 1: Write Playwright test**

```ts
// tests/provider-dashboard.spec.ts
import { test, expect } from '@playwright/test';
import { startServer, stopServer } from './start-server-helpers.js';

test.describe('Provider usage cards', () => {
  test('provider grid renders above server grid', async ({ page }) => {
    await page.goto('http://127.0.0.1:9595/dash');
    const providerGrid = page.locator('#provider-grid');
    await expect(providerGrid).toBeVisible();
    const serverGrid = page.locator('#server-list');
    await expect(serverGrid).toBeVisible();
    // Provider grid should appear before server grid in DOM
    const providerBox = await providerGrid.boundingBox();
    const serverBox = await serverGrid.boundingBox();
    if (providerBox && serverBox) {
      expect(providerBox.y).toBeLessThan(serverBox.y);
    }
  });

  test('provider cards have distinct styling from server cards', async ({ page }) => {
    await page.goto('http://127.0.0.1:9595/dash');
    const providerCard = page.locator('.provider-card').first();
    const serverCard = page.locator('.server-card').first();
    const providerBg = await providerCard.evaluate(el => getComputedStyle(el).background);
    const serverBg = await serverCard.evaluate(el => getComputedStyle(el).background);
    // Provider cards should have different background from server cards
    expect(providerBg).not.toBe(serverBg);
  });

  test('limit bars render with correct width', async ({ page }) => {
    await page.goto('http://127.0.0.1:9595/dash');
    const limitBar = page.locator('.limit-bar__fill').first();
    await expect(limitBar).toBeVisible();
    const width = await limitBar.evaluate(el => el.style.width);
    expect(width).toMatch(/%$/);
  });

  test('no console errors on load', async ({ page }) => {
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('http://127.0.0.1:9595/dash');
    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run E2E tests**

```bash
npx playwright test tests/provider-dashboard.spec.ts
```
Expected: all tests PASS

- [ ] **Step 3: Run full test suite**

```bash
node --test tests/provider-services.test.js && npx playwright test tests/provider-dashboard.spec.ts
```
Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/provider-dashboard.spec.ts
git commit -m "test: add provider dashboard E2E tests"
```

---

### Task 16: Final integration check + browser verification

- [ ] **Step 1: Start the dashboard server and verify visually**

Start the server:
```bash
node server.js
```

Open `http://127.0.0.1:9595/dash` and verify:
- Provider cards appear above server grid
- Cards have blue-teal tint distinct from server cards
- Limit bars render (even if showing "not configured" states)
- Grid wraps responsively at narrow widths
- No console errors

- [ ] **Step 2: Commit final adjustments if any**

```bash
git add -A
git commit -m "feat: finalize usage limit cards integration"
```
