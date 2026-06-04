# Scheduled AI Prompts — Design Spec

## Overview

Add a configurable scheduled-prompt service to the ngrok-dashboard that sends a
prompt to Claude Code and Codex CLI at configured minute offsets (e.g., :00
and :30 every hour), and displays run status on the dashboard.

## Success Criteria

1. Scheduler fires at each configured minute offset (e.g., 8:00, 8:30, 9:00,
   9:30...) with no clock drift across days.
2. Each target (Claude, Codex) receives the configured prompt and the response
   is captured.
3. Status (success/error with timestamp and response snippet) is visible on
   the dashboard.
4. Credential files are read once at startup; the CLI tool sessions are never
   invalidated.
5. Configuration lives in `servers.json`; the scheduler can be disabled
   without deleting config.

## Configuration

New `scheduler` block in `servers.json`:

```json
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
```

| Field | Purpose |
|-------|---------|
| `enabled` | On/off toggle |
| `minuteOffsets` | Array of minute-of-hour marks to fire at (e.g., `[0, 30]` = top and half past) |
| `prompt` | The message to send to each target |
| `targets[].credentialPath` | Path to JSON file on disk with the credential |
| `targets[].credentialKey` | Dotted path to the key inside that JSON file |

### Credential safety

- Files are **read once at startup** via `fs.readFileSync`.
- The access pattern is strictly read-only; no token refresh, no writes, no
  OAuth flow.
- Claude: uses `primaryApiKey` (static API key — never causes sign-out).
- Codex: uses `tokens.access_token` (read-only; no refresh triggered — does
  not invalidate the CLI session).

## Scheduler Logic

### Time-keeping

A `setInterval` fires every 30 seconds. Each tick checks the current minute
against `minuteOffsets`. When the minute matches and the scheduler hasn't
already fired for that hour+minute slot, it triggers a run.

Slot dedup key: `HH:MM` (e.g., `"08:30"`). After firing, the key is recorded
so the same slot can't fire again. The key resets when the minute changes.

This avoids the cumulative drift of `setInterval`-based timers and stays
accurate regardless of server start time.

### API calls

Each target fires in parallel using `https.request` (Node.js built-in — zero
new dependencies):

- **Claude:** POST to `https://api.anthropic.com/v1/messages` with
  `x-api-key: <primaryApiKey>`, anthropic-version header, and a messages
  payload.
- **Codex:** POST to `https://api.openai.com/v1/chat/completions` with
  `Authorization: Bearer <access_token>` and a chat completions payload.

Each request gets a 15-second timeout. Responses are parsed for the first
~80 chars of text content.

### State tracking

In-memory state per target:

```js
{
  lastRun: ISO timestamp or null,
  status: "success" | "error" | "pending",
  responsePreview: string | null,
  error: string | null
}
```

## API Endpoint

### `GET /api/scheduler`

Returns the scheduler state:

```json
{
  "enabled": true,
  "minuteOffsets": [0, 30],
  "nextFire": "2026-06-04T09:00:00.000Z",
  "prompt": "hi",
  "targets": [
    {
      "name": "Claude Code",
      "lastRun": "2026-06-04T08:30:05.123Z",
      "status": "success",
      "responsePreview": "Hello! How can I help you today?",
      "error": null
    },
    {
      "name": "Codex CLI",
      "lastRun": "2026-06-04T08:30:07.456Z",
      "status": "success",
      "responsePreview": "Hi there! What can I assist with?",
      "error": null
    }
  ]
}
```

- `nextFire` is computed by rounding the current time forward to the next
  minute offset.

## Dashboard

A new **"Scheduled Prompts"** section appears below the server grid. One
compact card containing:

1. **Header row:** title, prompt text, next-fire time
2. **Target rows** (one per target):
   - Name label
   - Status pill: green "Success" / red "Error" / gray "Pending"
   - Relative timestamp ("2 min ago", "never")
   - Response snippet (first ~80 chars, dimmed)

The section auto-refreshes with the existing 10-second client poll (same
`fetchState()` cycle that calls `/api/servers` — just add a parallel call
to `/api/scheduler`).

### UI sketch

```
┌──────────────────────────────────────────┐
│  🕐 Scheduled Prompts                    │
│  Prompt: "hi"   Every: :00, :30         │
│  Next: 9:00 AM                          │
├──────────────────────────────────────────┤
│  Claude Code    ● Success   2 min ago    │
│  Hello! How can I help you today?       │
├──────────────────────────────────────────┤
│  Codex CLI      ● Success   2 min ago    │
│  Hi there! What can I assist with?      │
└──────────────────────────────────────────┘
```

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Credential file missing | Scheduler starts but target shows `"status":"error"` with `"error":"credential file not found"` |
| Invalid credential JSON | Same — error with parse details |
| API request timeout (15s) | Target marked `"error"` with timeout message |
| API returns non-2xx | Target marked `"error"` with status code + body |
| Network failure | Target marked `"error"` with connection error |
| Dashboard fetch fails | Existing error-handling in `fetchState()` — no change needed |

Errors are per-target: one target failing does not block the other.

## Integration Points

1. **`server.js`:** New `scheduler` module block (~150 lines) — credential
   loading, time-keeping loop, API calls, `/api/scheduler` route handler.
2. **`servers.json`:** New `scheduler` config block.
3. **`index.html`:** New `renderScheduler()` function (~80 lines) + new HTML
   section + CSS styles for scheduler card (~40 lines).

## Constraints

- Zero new npm dependencies — use Node.js built-in `https`, `fs`, and
  `setInterval`.
- No credential files are written or modified.
- Scheduler is optional — if `scheduler.enabled` is `false` or the config
  block is missing, the server behaves as before with no scheduler code
  executing.
