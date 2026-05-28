# ngrok Tunnel Switcher

Single-command dashboard that lets you switch which local dev server is exposed through your ngrok tunnel.

## How it works

- One `node server.js` starts an HTTP reverse proxy on `localhost:9595`
- It launches one ngrok tunnel pointing at port 9595, giving you one public URL
- The dashboard loads at that URL — showing all your servers, their health, and a tunnel toggle
- Non-dashboard requests are proxied to whichever server you selected
- Server ports are auto-discovered: if a server moved within ±50 ports of its configured port, the switcher finds it

## Prerequisites

- **Node.js 18+** (for `fetch`, `AbortController`)
- **ngrok** installed, in PATH, and authenticated (`ngrok config check`)
- One or more local HTTP servers you want to expose

## Quickstart

```bash
# 1. Configure your servers
notepad servers.json

# 2. Start (Windows double-click start.bat, or command line)
node server.js
```

The terminal shows the ngrok URL. Open it in a browser, click "Tunnel" on any server, and the URL now serves that server.

## Configuration (`servers.json`)

```json
{
  "servers": [
    { "name": "Codenomad",   "port": 9896 },
    { "name": "Ollama",      "port": 4000 }
  ],
  "scanRange": 50,
  "switcherPort": 9595,
  "healthIntervalMs": 10000
}
```

| Field | Purpose |
|---|---|
| `servers[].name` | Display name |
| `servers[].port` | Expected port (scanned first) |
| `scanRange` | If expected port is down, scan ± this many ports |
| `switcherPort` | Port the dashboard runs on |
| `healthIntervalMs` | How often to re-check server health |

## Files

| File | Purpose |
|---|---|
| `server.js` | Everything: HTTP server, ngrok manager, proxy, discovery |
| `index.html` | Dashboard UI (vanilla HTML/CSS/JS) |
| `servers.json` | Your server list and settings |
| `start.bat` | Double-click launcher for Windows |

## Limitations

- HTTP only — WebSocket upgrade is not proxied
- No persistent state — target resets to "none" on restart
- Ngrok free tier: browser warning interstitial is bypassed automatically
- Port scan adds latency to health checks for down/drifted servers
