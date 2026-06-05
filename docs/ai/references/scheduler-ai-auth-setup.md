# Scheduler AI Auth Setup

How to configure the scheduler to send prompts to Claude, Codex, and Antigravity. All three use CLI subprocesses because the API endpoints don't accept subscription-based auth tokens.

---

## Claude Code

### Credential storage
- **File:** `~/.claude/config.json`
- **Keys tried (in order):** `primaryApiKey` → `oauthToken` → `accessToken` → `token`
- **Auth type:** Auto-detected from token prefix:
  - `sk-ant-api...` → API key (sent as `x-api-key` header)
  - `sk-ant-oat...` → OAuth token (sent as `Authorization: Bearer` header)
  - `eyJ...` (JWT) → Bearer token

### How it works
1. Server loads credential from config file
2. Attempts HTTP POST to `api.anthropic.com/v1/messages`
3. If API call fails (credit balance, auth error, etc.) → falls back to `claude` CLI subprocess
4. CLI command: `claude -p "<prompt>" --print --output-format text`
5. CLI uses browser-based OAuth from `claude login` (subscription billing)

### Prerequisites
- `claude` CLI installed globally: `npm i -g @anthropic-ai/claude-code`
- Authenticated: `claude login`
- CLI must resolve from `~/.local/bin/claude.exe` or `%APPDATA%/npm/claude.cmd`

### servers.json config
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

### Credential storage
- **File:** `~/.codex/auth.json`
- **Key:** `tokens.access_token`
- **IMPORTANT:** This is a ChatGPT web-session JWT (Google OAuth). It does NOT work with the OpenAI API (`api.openai.com`). The API requires a separate API key with prepaid credits.

### How it works
1. Server loads the OAuth JWT from config (for status display)
2. **Skips the OpenAI API entirely** — goes directly to CLI subprocess
3. CLI command: `node "<npm-global>/@openai/codex/bin/codex.js" exec "<prompt>" --json -o <tmpfile> --ephemeral --skip-git-repo-check --color never`
4. Output read from `-o <tmpfile>` after process exits
5. CLI uses ChatGPT OAuth session from `codex login` (subscription billing)

### Why not the API?
ChatGPT Plus / Pro subscriptions are separate from OpenAI API billing. The `tokens.access_token` JWT authenticates to the ChatGPT web interface, not to the API. Using it with `api.openai.com/v1/chat/completions` returns "You exceeded your current quota" because the ChatGPT session has no API credits.

### Prerequisites
- `codex` CLI installed globally: `npm i -g @openai/codex`
- Authenticated: `codex login`
- Script path: `%APPDATA%/npm/node_modules/@openai/codex/bin/codex.js`

### servers.json config
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

## Process Spawn Rules (Windows)

| Approach | OK? | Why |
|---|---|---|
| `execFileSync` | ❌ NO | Blocks event loop, can kill setInterval timers |
| `execFile` with `shell: true` for `.cmd` | ⚠️ Fragile | Buffer issues with large stdout |
| `execFile` calling `.exe` directly | ✅ OK | No shell needed |
| `spawn` with `stdio: ['ignore', 'ignore', 'pipe']` | ✅ Best | No buffering issues, discard unneeded stdout |

### Path resolution order
Server's `resolveCliPath(name)` checks:
1. `~/.local/bin/<name>.exe` (standalone installs like Claude)
2. `~/.local/bin/<name>.cmd`
3. `~/.local/bin/<name>`
4. `%APPDATA%/npm/<name>.exe`
5. `%APPDATA%/npm/<name>.cmd`
6. `%APPDATA%/npm/<name>.ps1`
7. `%APPDATA%/npm/<name>`
8. Bare `<name>` (hopes it's in PATH)

---

## Antigravity CLI (Google)

The Antigravity CLI is Google's AI coding assistant. The binary is `agy` (v1.0.5), a standalone Go executable installed at `%LOCALAPPDATA%/agy/bin/agy.exe`. It replaces the older npm-based `@google/gemini-cli` package.

### Credential storage
- **File:** `~/.gemini/oauth_creds.json`
- **Key:** `access_token`
- **Auth method:** OAuth via Windows keyring (Credential Manager) — stored separately from the JSON file
- **IMPORTANT:** This is a Google OAuth token (`ya29....`). It does NOT work as a Gemini API key.

### How it works
1. Server loads the OAuth token from config (for status display)
2. **Skips API entirely** — uses CLI subprocess only
3. CLI command: `agy -p "<prompt>" --dangerously-skip-permissions --print-timeout 60s`
4. `--dangerously-skip-permissions` auto-approves tool calls (non-interactive mode)
5. **agy writes responses to TUI, not stdout** — server extracts the response from the SQLite conversation DB (`~/.gemini/antigravity-cli/conversations/{id}.db`) after agy exits
6. The `steps` table stores protobuf-encoded step payloads; field 1 contains the model's response text

### Prerequisites
- `agy` CLI installed: `agy install` (or downloaded from Google)
- Authenticated: `agy` uses OAuth via Windows keyring (login handled by the CLI)
- Binary path: `%LOCALAPPDATA%/agy/bin/agy.exe` (must be on PATH)
- Node dependency: `better-sqlite3` (for reading conversation DBs)

### servers.json config
```json
{
  "name": "Antigravity CLI",
  "type": "antigravity",
  "model": "Gemini 3.5 Flash",
  "credentialPath": "~/.gemini/oauth_creds.json",
  "credentialKey": "access_token"
}
```

---

## Testing

### Manual fire (bypasses schedule)
```bash
curl -X POST http://localhost:9595/api/scheduler/fire
```

### Check results
```bash
curl http://localhost:9595/api/scheduler
```

### Enable debug logging
```bash
set SCHEDULER_DEBUG=1
node server.js
```

---

## Diagnosis history

- `docs/diagnose/2026-06-05-claude-codex-scheduler-auth-fix.md` — Full debug session for auth, text wrapping, scheduler stop, and spawn issues.
