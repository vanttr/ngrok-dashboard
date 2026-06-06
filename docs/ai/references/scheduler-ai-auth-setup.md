# Scheduler AI Setup Guide

How to configure the ngrok-dashboard scheduler to send prompts to Claude Code, Codex CLI, and Antigravity CLI — and receive responses. All three use CLI subprocesses because subscription-based auth tokens don't work with the public REST APIs.

---

## Quick Start

### 1. Configure `servers.json`

Add one target per AI provider under `scheduler.targets`:

```json
{
  "scheduler": {
    "enabled": true,
    "minuteOffsets": [0, 30],
    "prompt": "respond with 'hi' only",
    "targets": [
      { "name": "Claude Code",      "type": "claude", ... },
      { "name": "Codex CLI",       "type": "codex", ... },
      { "name": "Antigravity CLI", "type": "antigravity", ... }
    ]
  }
}
```

| Field | Purpose |
|-------|---------|
| `enabled` | Master on/off toggle |
| `minuteOffsets` | Minute-of-hour marks to fire (e.g. `[0, 30]` = :00 and :30) |
| `prompt` | Message sent to every target on each tick |
| `targets` | Array of AI provider configs (see per-provider sections below) |

### 2. Start the server

```bash
node server.js
```

The server loads credentials from disk, resolves CLI paths, and starts the polling timer. Look for startup output like:

```
Scheduler: 3 target(s) — 3 OK, 0 failed
  claude CLI: C:\Users\...\.local\bin\claude.exe
  codex CLI:  C:\Users\...\AppData\Roaming\npm\codex.cmd
  antigravity CLI: agy (v1.0.5)
Scheduler: started (offsets: 0, 30)
```

### 3. Fire manually (skip the schedule)

```bash
curl -X POST http://localhost:9595/api/scheduler/fire
# → {"ok": true, "message": "Fire triggered"}
```

### 4. Check results

```bash
curl http://localhost:9595/api/scheduler
```

Response includes per-target status, last-run timestamp, response preview, and errors:

```json
{
  "targets": [
    { "name": "Claude Code",      "status": "success", "responsePreview": "hi", "lastRun": "..." },
    { "name": "Codex CLI",       "status": "success", "responsePreview": "hi", "lastRun": "..." },
    { "name": "Antigravity CLI", "status": "success", "responsePreview": "Simple Greeting Response", "lastRun": "..." }
  ]
}
```

### 5. Enable debug logging

```bash
set SCHEDULER_DEBUG=1
node server.js
```

### 6. View in dashboard

Open `http://localhost:9595` — the scheduler card at the bottom of the page shows each target's status, credential health, last response, and next fire time. The UI polls the scheduler API every 10 seconds.

---

## Claude Code

### Setup

**1. Install the CLI**

```bash
npm i -g @anthropic-ai/claude-code
```

**2. Authenticate**

```bash
claude login
```

This opens a browser for OAuth. After login, credentials are stored at `~/.claude/config.json`.

**3. Verify**

```bash
claude -p "say hi" --print --output-format text
```

Should print `hi` (or similar) to stdout within a few seconds.

### How it works (in the scheduler)

1. Server loads credential from `~/.claude/config.json`
2. Attempts HTTP POST to `api.anthropic.com/v1/messages` (uses API credits if available)
3. If API call fails (no credits, auth error) → falls back to `claude` CLI subprocess
4. CLI command: `claude -p "<prompt>" --print --output-format text`
5. Response captured from **stdout**

### Credential config

| Field | Value |
|-------|-------|
| **File** | `~/.claude/config.json` |
| **Keys tried** | `primaryApiKey` → `oauthToken` → `accessToken` → `token` |
| **Auto-detection** | `sk-ant-api...` → API key, `sk-ant-oat...` / `eyJ...` → Bearer |

### `servers.json` entry

```json
{
  "name": "Claude Code",
  "type": "claude",
  "model": "claude-sonnet-4-20250514",
  "credentialPath": "~/.claude/config.json",
  "credentialKey": "primaryApiKey",
  "fallbackKeys": ["oauthToken", "accessToken", "token"]
}
```

---

## Codex CLI

### Setup

**1. Install the CLI**

```bash
npm i -g @openai/codex
```

**2. Authenticate**

```bash
codex login
```

This opens a browser for ChatGPT OAuth. After login, credentials are stored at `~/.codex/auth.json`.

**3. Verify**

```bash
node "%APPDATA%/npm/node_modules/@openai/codex/bin/codex.js" exec "say hi" --json --ephemeral --skip-git-repo-check --color never
```

Should print a JSON response with the model's reply.

### How it works (in the scheduler)

1. Server loads the OAuth JWT from `~/.codex/auth.json` (for status display only)
2. **Skips the OpenAI API entirely** — goes directly to CLI subprocess
3. CLI command: `node "<npm-global>/@openai/codex/bin/codex.js" exec "<prompt>" --json -o <tmpfile> --ephemeral --skip-git-repo-check --color never`
4. Response read from `-o <tmpfile>` after process exits

### Why not the API?

ChatGPT Plus/Pro subscriptions are separate from OpenAI API billing. The `tokens.access_token` is a web-session JWT for `chatgpt.com`, not an API key for `api.openai.com`. Using it with the API returns "quota exceeded" because the subscription has no API credits. The CLI sidesteps this — it uses your ChatGPT OAuth session directly.

### Credential config

| Field | Value |
|-------|-------|
| **File** | `~/.codex/auth.json` |
| **Key** | `tokens.access_token` |
| **Token type** | ChatGPT web-session JWT |

### `servers.json` entry

```json
{
  "name": "Codex CLI",
  "type": "codex",
  "model": "gpt-5.4",
  "credentialPath": "~/.codex/auth.json",
  "credentialKey": "tokens.access_token"
}
```

---

## Antigravity CLI (Google)

The Antigravity CLI is Google's AI coding assistant. The binary is `agy` (v1.0.5+), a standalone Go executable installed at `%LOCALAPPDATA%/agy/bin/agy.exe`. It replaced the older npm-based `@google/gemini-cli` package.

### Setup

**1. Install the CLI**

Download from Google or run:

```bash
agy install
```

This places `agy.exe` at `%LOCALAPPDATA%/agy/bin/` and adds it to `PATH`.

**2. Authenticate**

```bash
agy
```

On first run, `agy` opens a browser for Google OAuth. Credentials are stored in the Windows Credential Manager (keyring), not in a plaintext file. The OAuth token at `~/.gemini/oauth_creds.json` is read by the scheduler for status display only — the CLI handles auth internally.

**3. Verify (interactive)**

```bash
agy
```

Starts an interactive session. Type a prompt and confirm the model responds.

**Note:** `agy -p "prompt"` sends the prompt to the model but writes the response to the TUI (terminal display), not stdout. This is why the scheduler uses the SQLite extraction approach below.

### How it works (in the scheduler)

Unlike Claude and Codex, `agy` writes responses to the TUI, not stdout. The scheduler cannot capture stdout. Instead:

1. Server spawns: `agy -p "<prompt>" --dangerously-skip-permissions --print-timeout 60s`
2. `--dangerously-skip-permissions` auto-approves tool calls (non-interactive)
3. agy processes the prompt and writes the response to a **SQLite conversation DB** at `~/.gemini/antigravity-cli/conversations/{conversation-id}.db`
4. After agy exits, the server reads the DB and extracts the response text
5. Text is decoded from protobuf-encoded `step_payload` blobs in the `steps` table

**Response extraction — how it works and its limits:**

agy stores responses across two step types in the SQLite `steps` table:

| Step type | Contains | Example (trivial prompt) | Example (substantive prompt) |
|-----------|----------|--------------------------|------------------------------|
| **15** | Model's primary response | `"hi"` (2 chars) | `"A reverse proxy is an intermediary server..."` (300+ chars) |
| **23** | Re-summarized variant + metadata | `"Simple Greeting Response"` (task name) | `"A reverse proxy acts as an intermediary..."` (rephrased) |

The scheduler's proto parser (`extractProtoField1` in `server.js`) walks all `step_payload` blobs, collects every UTF-8 string and ASCII run, then selects a candidate using these priority filters:

1. Prefer text containing spaces (catches multi-word prose — works for substantive prompts)
2. Otherwise prefer short all-lowercase non-camelCase text (filters out `"sessionID"` identifiers)
3. Fallback: any non-garbage text

**For substantive prompts** (e.g. "explain what a reverse proxy is"): step 15 contains full prose with spaces → selected in pass 1 → ✅ correct.

**For trivial prompts** (e.g. "respond with 'hi' only"): step 15 contains only `"hi"` (no spaces), step 23 contains `"Simple Greeting Response"` (also no spaces, also lowercase). Since `"hi"` has no spaces, pass 1 is skipped. Pass 2 picks the first non-camelCase text — which may be `"hi"` or `"Simple Greeting Response"` depending on buffer order. The result is non-deterministic between these two. This is acceptable for a health-check scheduler (either confirms the pipeline works), but future agents should be aware that `responsePreview` is best-effort extraction, not guaranteed to be the model's exact output.

### Credential config

| Field | Value |
|-------|-------|
| **File** | `~/.gemini/oauth_creds.json` |
| **Key** | `access_token` |
| **Auth method** | OAuth via Windows keyring (Credential Manager) |
| **Token type** | Google OAuth (`ya29...`) — NOT a Gemini API key |

### `servers.json` entry

```json
{
  "name": "Antigravity CLI",
  "type": "antigravity",
  "model": "Gemini 3.5 Flash",
  "credentialPath": "~/.gemini/oauth_creds.json",
  "credentialKey": "access_token"
}
```

### Dependencies

The scheduler requires `better-sqlite3` to read agy's conversation DBs. Installed automatically as a project dependency (`npm install`).

---

## Troubleshooting

### Credential errors

If a target shows `credentialOK: false` in the scheduler status:

1. Check the credential file exists at the configured path
2. Verify the key path is correct (use dotted notation for nested keys: `tokens.access_token`)
3. Re-authenticate the CLI: `claude login`, `codex login`, or run `agy` interactively
4. Check server startup logs for credential loading errors

### CLI not found errors

1. Verify the CLI is installed: `where claude`, `where codex`, `where agy`
2. Check the resolved path in server startup logs
3. Reinstall the CLI if the path has changed

### Antigravity "unable to open database file"

1. Verify `agy` is on PATH and authenticated
2. Check that `~/.gemini/antigravity-cli/conversations/` exists and contains `.db` files
3. Run `agy` interactively once to create the conversations directory
4. Ensure `better-sqlite3` is installed (`npm install`)

### Antigravity "no model response steps"

agy creates a new conversation DB on each `-p` invocation. If no steps are found:

1. The prompt may have caused agy to exit without generating a response
2. Try a simpler prompt (e.g. `"say hi"`)
3. Check agy's log files at `~/.gemini/antigravity-cli/log/` for errors

### Timeout errors

The scheduler has a 60-second timeout for each AI call. Long prompts or first-time calls (cold start) may exceed this:

1. For Antigravity, increase `--print-timeout` in `server.js` callAntigravityCLI
2. For Claude/Codex, the timeout is hardcoded at 60s — modify `setTimeout` in the respective `call*CLI` functions

---

## Process Spawn Rules (Windows)

| Approach | OK? | Why |
|---|---|---|
| `execFileSync` | ❌ NO | Blocks event loop, can kill `setInterval` timers |
| `execFile` with `shell: true` for `.cmd` | ⚠️ Fragile | Buffer issues with large stdout |
| `execFile` calling `.exe` directly | ✅ OK | No shell needed |
| `spawn` with `stdio: ['ignore', 'pipe', 'pipe']` | ✅ Best | No buffering, discard unneeded I/O |

### Path resolution order

Server's `resolveCliPath(name)` checks:

1. `~/.local/bin/<name>.exe` (standalone installs like Claude)
2. `~/.local/bin/<name>.cmd`
3. `~/.local/bin/<name>`
4. `%APPDATA%/npm/<name>.exe`
5. `%APPDATA%/npm/<name>.cmd`
6. `%APPDATA%/npm/<name>.ps1`
7. `%APPDATA%/npm/<name>`
8. Bare `<name>` (hopes it's on PATH)

---

## Diagnosis history

- `docs/diagnose/2026-06-05-claude-codex-scheduler-auth-fix.md` — Full debug session for auth, text wrapping, scheduler stop, and spawn issues
