# Ngrok Tunnel Switcher — Design Spec

**Date:** 2026-05-28
**Status:** Draft
**Owner:** Van
**Related plan:** TBD
**Related ADRs:** None

## 1. Problem

I run 7+ local development servers (Codenomad, Vanforms, Ollama, etc.) that I occasionally need to reach from outside my network. Ngrok's Personal plan gives one public URL. Manually killing and restarting `ngrok http <port>` every time I want to switch which server is exposed is tedious and error-prone.

## 2. Goals

- G1. One public ngrok URL that I can reach from anywhere.
- G2. A dashboard (hosted behind that same URL) where I select which local server gets traffic.
- G3. Instant switching — no tunnel restart, no downtime for the dashboard itself.
- G4. Auto-discover server ports so the list stays accurate even when ports drift.
- G5. Vanilla stack: no frameworks, no build step, minimal dependencies.

## 3. Non-goals

- NG1. Managing multiple ngrok URLs (Personal plan only supports one).
- NG2. Authenticating dashboard users (ngrok's `--oauth=google` handles that at the tunnel level).
- NG3. Persisting state across restarts (target resets to "none" on reboot — acceptable for a personal tool).
- NG4. TLS termination at the proxy (ngrok handles HTTPS; proxy speaks plain HTTP to localhost).

## 4. Requirements

### Functional

- R1. Backend starts one ngrok process at launch and parses its public URL from stdout.
- R2. Backend serves the dashboard HTML at `GET /`.
- R3. Backend exposes a JSON API at `/api/servers`, `/api/target`, `/api/health`.
- R4. Backend proxies all non-API, non-dashboard requests to the currently selected target server.
- R5. Dashboard shows each server's name, configured port, actual port, health dot, and a tunnel toggle button.
- R6. Clicking "Tunnel" on a server sets it as the active target. Clicking "Stop" unsets it.
- R7. Dashboard auto-refreshes server health every 10 seconds.

### Non-functional

- N1. Proxy adds no more than 50ms overhead to request latency.
- N2. Dashboard loads in under 1 second on a cold request.
- N3. Node.js built-in modules only — no Express, no npm install for the backend.

## 5. Constraints And Existing Facts

- C1. Ngrok Personal plan = 1 public URL, all active tunnels share it.
- C2. Ngrok free tier injects a browser warning interstitial. Requests must include header `ngrok-skip-browser-warning: true` to bypass it.
- C3. Ngrok `--oauth=google --oauth-allow-email=vant.tr@gmail.com` authenticates all traffic at the tunnel edge.
- C4. The main app (Codenomad, port 9896) is managed separately — not part of the switcher.

## 6. Assumptions, Gaps, And Open Questions

| Type | Statement | Impact | Owner / Resolution trigger |
|---|---|---|---|
| Assumption | Ngrok is installed and in PATH on the host machine. | If missing, server fails at startup with clear error message. | Van |
| Assumption | All target servers speak HTTP (not WebSocket or raw TCP). | Proxying non-HTTP traffic would require a different approach. Out of scope for v1. | Van |
| Assumption | The `scanRange` of ±50 ports around configured ports is sufficient to catch port drift. | If a server moves more than 50 ports away, it appears "down" until the config is updated. Acceptable. | Van |

## 7. Proposed Design

### 7.1 Architecture

Reverse proxy model: one ngrok process, one URL, the switcher routes traffic.

```
Internet → ngrok → localhost:9595 (switcher)
                      ├─ GET /              → dashboard HTML
                      ├─ GET /api/*         → JSON API (health, target, servers)
                      └─ everything else    → proxied to current target server
                                                (e.g., localhost:4000 for Ollama)
```

- Ngrok process is started once at server launch. Never killed, never restarted.
- The proxy uses Node.js built-in `http` module (no Express).
- The target server is an in-memory variable: `{ port: number, name: string } | null`.

### 7.2 Backend Routes

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/` | Serves `index.html` from disk with `ngrok-skip-browser-warning: true` header. |
| `GET` | `/ngrok-skip-browser-warning` | Returns 204 — satisfies the ngrok interstitial bypass. |
| `GET` | `/api/servers` | Returns full server list with health status, current target, ngrok URL, and any ngrok error. |
| `GET` | `/api/target` | Returns `{"target":{"port":4000,"name":"Ollama"},"ngrokUrl":"https://..."}` or `{"target":null,"ngrokUrl":null}`. |
| `POST` | `/api/target` | Body: `{"port":4000}`. Validates port against known servers. Returns `{"ok":true,"target":{...}}`. |
| `GET` | `/api/health` | Returns `{"status":"ok","uptime":...,"ngrokConnected":true,"target":{...}}`. |
| `*` | catch-all | If target is set, proxies request to `localhost:<target_port>`. If no target, returns 503. |

### 7.3 Server Discovery

Config file `servers.json`:

```json
{
  "servers": [
    { "name": "Codenomad",   "port": 9896 },
    { "name": "Companion",   "port": 3470 },
    { "name": "Ollama",      "port": 4000 },
    { "name": "Vanforms",    "port": 8086 },
    { "name": "Hub",         "port": 8099 },
    { "name": "Thevanbot",   "port": 8787 },
    { "name": "Openchamber", "port": 57123 }
  ],
  "scanRange": 50
}
```

Discovery algorithm (runs per health-check cycle):

```
for each server in config:
  http GET localhost:<configuredPort> with 2s timeout
  if responds 2xx/3xx:
    health = "ok", actualPort = configuredPort
  else:
    for port in range(configuredPort - scanRange, configuredPort + scanRange):
      http GET localhost:<port> with 0.5s timeout
      if responds 2xx/3xx:
        health = "ok", actualPort = port, status = "drifted"
        break
    if nothing found:
      health = "down", actualPort = null, status = "down"
```

### 7.4 Frontend

Single file `index.html`. Vanilla HTML, CSS, JS. No framework, no build step.

States per server row:

| State | Dot | Button | Row style |
|---|---|---|---|
| Healthy, not active | 🟢 green | "Tunnel" (enabled) | default |
| Down | 🔴 red | "Tunnel" (disabled, dimmed) | dimmed text |
| Active | 🟢 green | "Stop" (enabled, prominent) | highlighted background |
| Drifted | 🟢 green + port shift badge | "Tunnel" (enabled) | subtle warning indicator |

Auto-refresh: `setInterval(fetchServers, 10000)` — calls `GET /api/servers` and diff-updates the DOM rows.

## 8. Edge Cases And Failure Modes

| Case | Expected behavior | Mitigation / test |
|---|---|---|
| Ngrok not installed or not in PATH | Server logs error and exits with code 1 at startup. | Test: remove ngrok from PATH, start server, verify exit code and message. |
| Ngrok fails to start (auth expired, network down) | Server starts anyway (dashboard works locally). Underlying error shown in header. | Test: start with invalid authtoken, verify dashboard still serves and error is displayed. |
| Target port not in server list | `POST /api/target` returns 400 with error message. | Test: POST to `/api/target` with port 9999, verify 400. |
| Proxy target is unreachable during proxying | Proxy returns 502 with JSON error. Dashboard still works. | Test: set target to a port that goes down, request through proxy, verify 502. |
| `servers.json` is missing or malformed | Server logs error, starts with empty server list. Dashboard shows "No servers configured." | Test: delete/truncate servers.json, restart, verify graceful degradation. |
| Port scan takes too long (>5s) | Health check times out, shows servers as "down." Next cycle retries. | Test: configure a server at a port with no listener, verify scan completes within scanRange*timeout limit. |
| Concurrent requests during proxy | Each request is independently proxied. No shared state corruption. | Node.js single-threaded event loop handles this naturally. |
| Large request/response bodies in proxy | Streamed via pipes — no buffering in memory. | Node.js `http.request` returns a readable stream; piped directly to response. |

## 9. Alternatives Considered

| Alternative | Why rejected |
|---|---|
| 3-slot tunnel model (3 separate ngrok processes) | Personal plan shares 1 URL across all tunnels — can't distinguish which server gets traffic. |
| Express.js backend | Adds dependency for 4 routes. Built-in `http` module is sufficient. |
| WebSocket for live health updates | Overkill for 10s refresh. Polling is simpler, more reliable through ngrok. |
| Database for state persistence | In-memory state is acceptable for a personal tool. Restart resets to "no target." |

## 10. Risks And Limitations

- **Ngrok browser warning:** Free-tier interstitial must be bypassed with the `ngrok-skip-browser-warning` header and a dedicated bypass path. Tested and confirmed working.
- **OAuth doubles as auth:** Anyone with `vant.tr@gmail.com` Google account can access the dashboard and switch targets. Acceptable since I'm the only user.
- **No WebSocket support:** The proxy forwards HTTP only. If a target server relies on WebSocket upgrades, it won't work through the switcher.
- **Port scan noise:** Scanning up to 101 ports per down server per cycle generates ~50-700 HTTP requests every 10s at most. Negligible load but mildly noisy in server logs.

## 11. Acceptance Criteria

1. Dashboard loads at the ngrok URL and shows all 7 servers with health status.
2. Clicking "Tunnel" on a server makes subsequent requests to the same URL hit that server.
3. Clicking "Stop" returns to "no target selected" state (503 on proxied requests).
4. Health dots update every 10 seconds without page reload.
5. If a server moves to a port within ±50 of its configured port, it appears as "drifted" with the correct new port and is still tunnel-able.
6. Server starts with `node server.js` and launches ngrok automatically.
7. No `npm install` required — only Node.js built-ins.

## 12. Verification Strategy

- **Automated:** None (personal tool, no test framework planned). Manual verification against acceptance criteria.
- **Manual:** Start the switcher, visit the ngrok URL, verify all 7 acceptance criteria above.
