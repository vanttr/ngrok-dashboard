# Start Server from Dashboard — Design Spec

**Date:** 2026-05-29
**Status:** Draft
**Owner:** Van
**Related plan:** TBD
**Related ADRs:** None
**Extends:** 2026-05-28-ngrok-tunnel-switcher-design.md

## 1. Problem

When a server shows as offline in the ngrok dashboard, the user must manually open a terminal, navigate to that app's project directory, and run `dev.ps1` to start it — then wait and refresh the dashboard. This is tedious when juggling 7+ servers.

## 2. Goals

- G1. User can start an offline server directly from the dashboard with one click.
- G2. The dashboard shows visual feedback while the server is starting.
- G3. After a few seconds, the dashboard auto-refreshes and the server appears online.
- G4. If the server fails to start, the dashboard simply reverts to the Start button — no debugging, no error investigation.

## 3. Non-goals

- NG1. Diagnosing why a server didn't start — user handles that manually.
- NG2. Stopping a running server from the dashboard (only the Tunnel/Stop tunnel toggle exists).
- NG3. Streaming logs or build output from the dev script.
- NG4. Tracking the spawned process lifecycle beyond the initial fire-and-forget.

## 4. Requirements

### Functional

- R1. `servers.json` gains a `devScript` field per server entry — absolute path to that app's `dev.ps1`.
- R2. Servers without a `devScript` field do not show a Start button (graceful degradation).
- R3. New API endpoint: `POST /api/servers/:port/start` spawns the dev script as a detached background process and returns immediately.
- R4. The endpoint validates: port exists in config, `devScript` is configured, script file exists on disk. Returns 400 with descriptive error if any check fails.
- R5. Down servers show a "Start" button instead of the current disabled "Tunnel" button.
- R6. Clicking Start: POSTs to the endpoint, button enters "Starting..." state (disabled, animated).
- R7. After clicking Start, the frontend polls `GET /api/servers` every 3 seconds for that port.
- R8. If the server comes online within 12 seconds (4 polls), the fast poll stops and the card shows the normal healthy state.
- R9. If the server is still down after 12 seconds, the fast poll stops and the button reverts to "Start" — no error message.
- R10. The normal 10s refresh cycle continues unaffected during and after the fast poll.

### Non-functional

- N1. The spawned process is fully detached — the Node.js server does not track or manage it after spawn.
- N2. No new npm dependencies.

## 5. Constraints And Existing Facts

- C1. All 7 servers have a `dev.ps1` in their project root that starts the server.
- C2. Dev scripts run on Windows — must use `powershell.exe -ExecutionPolicy Bypass -File <path>`.
- C3. Some dev scripts exit after starting the server (fire-and-forget wrapper); others may stay running. The dashboard doesn't care either way.
- C4. The existing `GET /api/servers` response does not need to change — starting state is tracked purely in the frontend.

## 6. Proposed Design

### 6.1 servers.json Schema Change

Add `devScript` field (absolute path) to each server entry:

```json
{
  "servers": [
    { "name": "Codenomad",   "port": 9896,  "devScript": "E:/Van/Documents/GitHub/codenomad/dev.ps1" },
    { "name": "Companion",   "port": 3470,  "devScript": "E:/Van/Documents/GitHub/companion/dev.ps1" },
    { "name": "Ollama",      "port": 4000,  "devScript": "E:/Van/Documents/GitHub/ollama/dev.ps1" },
    { "name": "Vanforms",    "port": 8086,  "devScript": "E:/Van/Documents/GitHub/vanforms/dev.ps1" },
    { "name": "Hub",         "port": 8099,  "devScript": "E:/Van/Documents/GitHub/hub/dev.ps1" },
    { "name": "Thevanbot",   "port": 8787,  "devScript": "E:/Van/Documents/GitHub/thevanbot/dev.ps1" },
    { "name": "Openchamber", "port": 57123, "devScript": "E:/Van/Documents/GitHub/openchamber/dev.ps1" }
  ],
  "scanRange": 50,
  "switcherPort": 9595,
  "healthIntervalMs": 10000
}
```

### 6.2 Backend: POST /api/servers/:port/start

| Step | Behavior |
|------|----------|
| Parse port from URL | Extract `:port` param, parse as integer |
| Validate port | Look up port in `CONFIG.servers`. Return `400 { ok: false, error: "Unknown port" }` if not found |
| Validate devScript | Check server entry has `devScript` field. Return `400 { ok: false, error: "No devScript configured for <name>" }` if missing |
| Validate file exists | `fs.existsSync(devScript)`. Return `400 { ok: false, error: "dev.ps1 not found at <path>" }` if missing |
| Spawn process | `spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', devScript], { detached: true, stdio: 'ignore', windowsHide: true })` then `process.unref()` |
| Respond | `200 { ok: true, starting: true }` |

No backend state is maintained. The process is fire-and-forget.

### 6.3 Frontend: Card States

| State | Button text | Button style | Card style | When |
|-------|------------|-------------|-----------|------|
| Down, no devScript | "Tunnel" | disabled, dimmed | dimmed | Server offline, no script configured |
| Down, has devScript | "Start" | enabled, green accent | dimmed | Server offline, script available |
| Starting | "Starting..." | disabled, animated spinner | dimmed | After clicking Start, waiting for server |
| Healthy | "Tunnel" | enabled | default | Server online, not active target |
| Active | "Stop" | enabled, red accent | highlighted | Server is the active proxy target |
| Drifted | "Tunnel" | enabled | default + drift badge | Server online on different port |

### 6.4 Frontend: Start Flow

```
User clicks "Start"
  → POST /api/servers/:port/start
  → If error: alert(error), stay in "Start" state
  → If ok:
      Button → "Starting..." (disabled, spinner)
      Start 3s fast-poll timer for this port
      On each fetchState:
        If server.health === "ok":
          Stop fast-poll → card shows healthy "Tunnel" button
        If 12s elapsed (4 polls) and still down:
          Stop fast-poll → revert to "Start" button
```

The normal `setInterval(fetchState, 10000)` continues independently. The fast poll is additive — it just calls the same `fetchState()` function more frequently while a start is in progress.

### 6.5 CSS Additions

- `.tunnel-btn.start` — green accent background (uses existing `--ok` / `--ok-bg` design tokens), same shape as Tunnel button
- `.tunnel-btn.starting` — subtle pulse animation on the button text, disabled state
- `@keyframes pulse` — opacity oscillation for the "Starting..." text

## 7. Edge Cases And Failure Modes

| Case | Expected behavior |
|------|-------------------|
| dev.ps1 path is wrong / file missing | API returns 400 with descriptive error, Start button stays, alert shown |
| dev.ps1 runs but server crashes during startup | Fast poll times out after 12s, button reverts to Start. User debugs manually. |
| User clicks Start twice quickly | First click enters "Starting..." (disabled). Second click is a no-op — button is already disabled. |
| User clicks Start on a server that's already starting | Same as above — button is disabled during starting state. |
| User clicks Start, server starts on a drifted port (not the configured port) | The discovery scan finds it on the drifted port. Next fetchState shows it as healthy/drifted. Start succeeded. |
| dev.ps1 is missing from servers.json entry | No "Start" button shown — falls back to disabled "Tunnel" button (existing behavior). |
| Multiple servers starting simultaneously | Each port tracks its own fast-poll timer independently. No conflicts. |

## 8. Alternatives Considered

| Alternative | Why rejected |
|-------------|-------------|
| Backend tracks starting state with timestamp | Adds backend state for a transient UI concern. Frontend can own the timeout without any backend changes beyond the spawn endpoint. |
| SSE / WebSocket for instant start notification | Overkill for a 3-12 second window on a personal tool. Polling at 3s is simple and sufficient. |
| Kill script process after timeout | Some dev.ps1 scripts are long-running server wrappers. Killing them would kill the server they just started. Let them run. |
| Relative paths in devScript | Absolute paths are unambiguous on Windows and avoid working-directory confusion. |

## 9. Acceptance Criteria

1. `servers.json` includes `devScript` paths for all servers.
2. A down server with a `devScript` shows a "Start" button instead of a disabled "Tunnel" button.
3. Clicking "Start" posts to `POST /api/servers/:port/start`, button enters "Starting..." state.
4. The script is spawned as a detached PowerShell process.
5. If the server comes online within 12 seconds, the card updates to show healthy status with a "Tunnel" button.
6. If the server doesn't come online within 12 seconds, the button reverts to "Start".
7. A server without a `devScript` field shows no Start button — just the disabled Tunnel button.
8. `POST /api/servers/:port/start` returns 400 with descriptive error for: unknown port, missing devScript, missing script file.
9. Clicking Start while already starting is a no-op (button is disabled).

## 10. Verification Strategy

- **Manual:** Start the switcher, verify each acceptance criterion by stopping a server, clicking Start in the dashboard, and observing the state transitions.
- **Automated:** Playwright test for the API endpoint (spawn validation, error cases) and the frontend button state transitions.
