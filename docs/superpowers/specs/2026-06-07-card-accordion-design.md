# Card Accordion with Server Details — Design Spec

**Date:** 2026-06-07
**Status:** Draft
**Owner:** Van
**Related plan:** TBD
**Related ADRs:** 0003 (Config + Port-Scan Discovery)

## 1. Problem

Dashboard cards currently show only name, port, health dot, and tunnel controls. Users who manage
multiple servers want to see at a glance what **runtime stack** each server uses (Bun, Node.js,
Python, etc.) and **how long each server has been up** — without leaving the dashboard.

## 2. Goals

- G1. Each card has a collapsible accordion that reveals stack and uptime on click.
- G2. Stack info is accurate even if the config file falls out of date.
- G3. Uptime is accurate even across dashboard restarts (prefer OS process start time).
- G4. No new npm dependencies. No new files. Minimal server load.

## 3. Non-goals

- NG1. Real-time process introspection (CPU, memory, etc.).
- NG2. Historical uptime tracking or metrics storage.
- NG3. Editing config from the dashboard UI.
- NG4. Parsing external dev.ps1 scripts for stack info.

## 4. Requirements

### Functional

- R1. Each card has a "details" toggle that expands/collapses an accordion panel.
- R2. Expanded panel shows: runtime stack, uptime duration, server start time.
- R3. Stack value comes from config `"stack"` field, validated against OS process detection.
- R4. If config stack and process detection disagree, show process-detected value with "config mismatch" note.
- R5. If config has no `"stack"` field, show process-detected value with no mismatch note.
- R6. Uptime uses OS process start time when available, falls back to proxy-tracked healthy-since timestamp.
- R7. Accordion state (expanded/collapsed) survives the 10s auto-refresh and always defaults to collapsed.
- R8. When server is down, stack shows config value (or "Unknown" if none), uptime shows "—".

### Non-functional

- N1. Process detection must complete in <500 ms per server (same window as health check).
- N2. No flicker — accordion state preserved across DOM diffing via `expandedPorts` Set.
- N3. API response size increase per server: ~150 bytes.

## 5. Constraints And Existing Facts

- C1. Backend is a single `server.js` file (1506 lines) using Node.js built-ins only.
- C2. Frontend is a single `index.html` file (847 lines) with vanilla JS + CSS.
- C3. Server discovery polls every 10 seconds via `setInterval`.
- C4. Card rendering uses incremental DOM diffing (`cardMap` pattern) to avoid flicker.
- C5. Platform is Windows; process detection uses `netstat` + `tasklist` + `Get-Process`.
- C6. Config file is `servers.json`, edited manually.

## 6. Assumptions, Gaps, And Open Questions

| Type | Statement | Impact | Owner / Resolution trigger |
|---|---|---|---|
| Assumption | All managed servers run on Windows | Process detection uses Windows-specific commands | Van |
| Assumption | `servers.json` is updated when stack changes | Mismatch flag triggers config update | Van |
| Assumption | Process PID is available for all running servers | Some hardened processes may hide PIDs; fall back to proxy uptime | Van |

## 7. Proposed Design

### Architecture

All computation happens server-side during the existing health-check cycle. The frontend receives
enriched data via `GET /api/servers` and renders purely presentational accordion UI.

```
health check loop (10s)
  └─ discoverServer()
       ├─ HTTP health check (existing)
       ├─ detectProcess(port) ─→ { exe, runtime } or null
       ├─ getStackDisplay(server, processInfo) ─→ { display, source, configValue, processValue, mismatch }
       └─ getUptime(port, processInfo) ─→ { startedAt, seconds, source }
            └─ prefers: OS process start time (Get-Process)
               fallback: proxy-tracked firstSeenHealthy[port]
```

### Interfaces And Data Flow

**API: `GET /api/servers`** — response gains per-server fields:

```json
{
  "servers": [{
    "...existing fields...": "...",
    "stack": {
      "display": "Bun",
      "source": "config",
      "configValue": "Bun + Hono",
      "processValue": "Bun",
      "mismatch": false
    },
    "uptime": {
      "startedAt": "2026-06-07T14:30:00.000Z",
      "seconds": 3600,
      "source": "process"
    }
  }]
}
```

**Config: `servers.json`** — new optional field per server:

```json
{ "name": "companion", "port": 3457, "stack": "Bun + Hono", "devScript": "..." }
```

**Process detection: `detectProcess(port)`**

```
1. netstat -ano | findstr :<port>     → extract PID from last column
2. tasklist /fi "PID eq <pid>" /fo csv → parse executable name
3. Map exe → canonical runtime:
   bun.exe     → "Bun"
   node.exe    → "Node.js"
   python.exe  → "Python"
   pwsh.exe    → "PowerShell"
   (other)     → exe name as-is
4. Return { exe, runtime } or null
```

**Stack matching: `getStackDisplay(server, processInfo)`**

Keyword-to-expected-process mapping:

| Config contains keyword... | Expected process |
|---|---|
| `Bun` | `bun.exe` |
| `Node`, `Node.js`, `Express`, `Vite`, `Next`, `Nuxt`, `Hono`, `Fastify`, `React` | `node.exe` |
| `Python`, `uvicorn`, `FastAPI`, `Flask`, `Django` | `python.exe` |
| `PowerShell`, `pwsh` | `pwsh.exe` |

Logic:
```
if no config.stack:
    display = processInfo.runtime  (or "Unknown" if processInfo is null)
    source = "process"
    mismatch = false
elif processInfo present AND any config keyword maps to processInfo.exe:
    display = config.stack
    source = "config"
    mismatch = false
elif processInfo present AND no keyword match:
    display = processInfo.runtime
    source = "process"
    mismatch = true
else (no processInfo — server down):
    display = config.stack
    source = "config"
    mismatch = false
```

**Uptime: `getUptime(port, processInfo)`**

```
if processInfo.pid:
    Get-Process -Id <pid> | Select-Object StartTime   → ISO timestamp
    source = "process"
else if firstSeenHealthy[port]:
    timestamp = firstSeenHealthy[port]
    source = "proxy"
else:
    return null (server not healthy)
```

**State tracking:** A `firstSeenHealthy` map stores timestamps keyed by port. Set when `status` transitions from `down` → `ok`. Cleared when server goes down.

### File And Module Impact

| File | Lines changed | Nature |
|---|---|---|
| `servers.json` | ~9 | Add `"stack"` to each server entry |
| `server.js` | ~60 | `detectProcess()`, `getStackDisplay()`, `getUptime()`, enrich API response, state tracking |
| `index.html` | ~80 | Accordion CSS, toggle HTML in `renderServers()`, `expandedPorts` Set, click handler |
| **Total** | ~149 | No new files, no new dependencies |

### Accordion UI

```
Closed:                         Expanded:
┌─────────────────────────┐     ┌─────────────────────────┐
│ ● companion             │     │ ● companion             │
│ :3457  active           │     │ :3457  active           │
│ [Start Tunnel] Open →   │     │ [Start Tunnel] Open →   │
│ ▼ details               │     │ ▲ details               │
└─────────────────────────┘     │ ┌─────────────────────┐ │
                                │ │ Stack: Bun + Hono   │ │
                                │ │ Uptime: 2h 15m      │ │
                                │ │ Started: 2:30 PM    │ │
                                │ └─────────────────────┘ │
                                └─────────────────────────┘
```

- Toggle: `<span>` with `▼`/`▲`, styled as text button below action buttons.
- Panel: collapsible via CSS `grid-template-rows: 0fr → 1fr` with transition.
- Mismatch note: small amber `#b0822c` text, "config mismatch", below stack line.
- Down server: uptime row shows "—", started row omitted.

## 8. Edge Cases And Failure Modes

| Case | Expected behavior | Mitigation / test |
|---|---|---|
| `netstat` fails or returns no PID | `stack.display` = config value, uptime falls back to proxy | Graceful null handling |
| `tasklist` fails | Same as above | Graceful null handling |
| `Get-Process StartTime` fails | Uptime falls back to proxy | Fallback path tested |
| Server restarts with same PID | OS StartTime updates; uptime resets correctly | OS handles this |
| Server uses a process not in keyword map | `display` = exe name, `source` = "process" | Keyword map covers all common runtimes |
| Config `"stack"` is `"Vite + React"` (implies Node.js) | Keywords `Vite`/`React` → node.exe → match | Keyword map entry |
| Server goes down while accordion expanded | Panel still shows; stack = config value, uptime = "—" | Graceful display |
| Card rebuilt during refresh with accordion expanded | `expandedPorts` Set preserves state, re-expand after render | JS state tracking |
| Multiple servers on same exe type | Independent matching per server | Per-port detection |

## 9. Alternatives Considered

- **Parse dev.ps1 scripts:** Rejected — scripts are in external repos, formats vary, fragile.
- **HTTP header detection:** Rejected — servers strip headers, can't distinguish Bun from Node.js.
- **Pure config (no process detection):** Rejected — user wants mismatch detection.
- **Frontend computes uptime:** Rejected — page refresh wipes local timers, inaccurate.

## 10. Risks And Limitations

- **Risk:** Windows-specific process commands won't work on other OSes. **Mitigation:** project is Windows-only by design (PowerShell dev scripts, platform-specific paths).
- **Risk:** `netstat` or `tasklist` may be slow under heavy load. **Mitigation:** runs within existing 10s health-check cycle, non-blocking.
- **Risk:** Some server processes (e.g., containerized, sandboxed) may not expose PID on the listening port. **Mitigation:** graceful fallback to config-only display and proxy uptime.

## 11. Acceptance Criteria

1. Clicking "details" toggle on any card expands/collapses an accordion panel showing stack, uptime, and start time.
2. Stack value matches process-detected runtime for all 9 configured servers.
3. Changing a server's `"stack"` in config to a mismatched value shows "config mismatch" in amber.
4. Omitting `"stack"` from config shows process-detected value with no mismatch note.
5. Uptime survives a dashboard page refresh (server-side timestamp).
6. Accordion state survives the 10s auto-refresh without flicker.
7. Toggling one card does not affect other cards.
8. All existing unit tests (32 header-rewriting, 14 scheduler) still pass.
9. Down servers show stack (from config) and uptime "—".

## 12. Verification Strategy

- **Automated:** Run existing test suites (`node --test tests/header-rewriting.test.js`, `node --test tests/scheduler.test.js`). Add smoke test: `GET /api/servers` response validates `stack` and `uptime` fields exist with correct shape.
- **Manual:** Open dashboard in browser. Expand accordion on each card. Verify stack matches known server runtime. Verify uptime increments. Kill a server, verify uptime resets. Change config `"stack"` to intentionally wrong value, verify mismatch note appears.
