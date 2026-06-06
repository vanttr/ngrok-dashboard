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
    return callAntigravityCLI(prompt);
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
function callAntigravityCLI(prompt) {
  const { spawn } = require('child_process');
  const Database = require('better-sqlite3');

  const conversationsDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
  const lastConvPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json');

  // Record existing DBs as fallback
  let before;
  try { before = new Set(fs.readdirSync(conversationsDir).filter(f => f.endsWith('.db'))); }
  catch { before = new Set(); }

  return new Promise((resolve, reject) => {
    const child = spawn('agy', [
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--print-timeout', '60s'
    ], {
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
          'SELECT step_payload FROM steps WHERE step_type IN (15, 23) ORDER BY idx DESC'
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
  // Fallback: any short text
  for (const t of candidates) {
    if (t.length >= 1 && t.length <= 200) return t;
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
    pathname === '/api/scheduler/fire' ||
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(202);
    res.end(JSON.stringify({ ok: true, message: 'Fire triggered' }));
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
