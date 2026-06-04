# ADR 0004: Scheduled Prompt Architecture

## Context

The dashboard needs a scheduler that sends a prompt to Claude Code and Codex
CLI at configured clock times (minute offsets), and displays run status on the
dashboard. The system must use existing CLI credential files without
invalidating CLI sessions.

## Decision: Server-side HTTPS scheduler with credential file reading

The scheduler runs in-process in `server.js` using `https.request` (Node.js
built-in). It reads credential JSON files from disk once at startup.

## Options Considered

### Option A: Server-side HTTPS scheduler (Chosen)

- Call Anthropic Messages API and OpenAI Chat Completions API directly via
  `https.request`.
- Read credentials from `~/.claude/config.json` (primaryApiKey) and
  `~/.codex/auth.json` (tokens.access_token) once at startup.
- Track state in memory, expose via `/api/scheduler`.

**Pros:**
- Zero new dependencies (Node.js built-in `https`, `fs`, `setInterval`).
- Claude uses static API key — never touches OAuth session, no sign-out risk.
- Codex access token is read-only — no refresh triggered, session stays valid.
- Fits existing single-file, zero-framework architecture.
- Lightweight — two HTTPS POSTs every 30 minutes.

**Cons:**
- API key stored in config.json is sent over the network (to api.anthropic.com
  and api.openai.com). These are the same endpoints the CLI tools use — no new
  trust boundary.

### Option B: CLI process spawning

- Spawn `claude -p "hi"` and `codex -p "hi"` as child processes.

**Pros:**
- CLI handles its own auth — no credential reading needed.

**Cons:**
- Heavy — spawns a full Node.js process per call (hundreds of MB of memory
  churn).
- Slow startup — CLI init can take seconds before producing output.
- Fragile — output parsing depends on CLI output format, which can change
  across versions.
- Risk of stale/orphaned processes if the server restarts mid-spawn.

### Option C: External cron + standalone script

- Use Windows Task Scheduler or a cron daemon to run a script that calls APIs
  and writes results to a file the dashboard reads.

**Pros:**
- Decoupled from the server process — survives server restarts.

**Cons:**
- Two systems to manage, configure, and debug.
- File-based state sync adds complexity and race conditions.
- Windows Task Scheduler is cumbersome; cross-platform story is poor.

### Option D: Separate worker process spawned by server

- Fork a child Node.js process that handles scheduling independently.

**Pros:**
- Isolated crash boundary — scheduler failure doesn't take down the server.

**Cons:**
- Adds IPC complexity.
- Overkill for two HTTPS calls every 30 minutes.
- Violates the project's single-process simplicity ethos.

## Time-keeping: Minute-offset polling vs. setInterval

### setInterval-aligned (rejected)

Start a `setInterval(fn, 30 * 60 * 1000)` aligned to the next trigger time.

**Problem:** `setInterval` drifts over time. After 24 hours, the cumulative
drift can be seconds, growing to minutes over days. The "on the half-hour"
requirement is violated.

### Minute-offset polling (chosen)

A 30-second polling tick checks `new Date().getMinutes()`. When the current
minute matches a configured offset and the slot hasn't fired yet, it triggers.

This is accurate regardless of server start time or uptime duration. The
30-second poll is negligible overhead (one `Date` read per tick).

## Credential Safety

| Risk | Mitigation |
|------|------------|
| OAuth token refresh invalidates session | Files are read-only; no token refresh code exists |
| Token used by two clients simultaneously | Access tokens support concurrent use; API keys are stateless |
| Credential file corruption from disk read | `try/catch` on `fs.readFileSync` + `JSON.parse` — error surface is per-target, non-fatal |
| Credentials leaked in logs | Credential values are never logged; only target names and status appear |

## Consequences

### Positive

- Clean fit into existing architecture — no new files except the spec and ADR.
- Credential safety by design — read-only, no OAuth flow.
- Configurable schedule without code changes.
- Time-accurate with no drift.

### Negative

- Depends on the file format of `~/.claude/config.json` and
  `~/.codex/auth.json` — if Anthropic or OpenAI change the format in a CLI
  update, credential reading may break. (Mitigation: fail gracefully per
  target, show error on dashboard.)
- API key leaves the machine (sent to api.anthropic.com). This is inherent to
  any API-based approach and matches how the CLI tools themselves work.
