# 0001 - Reverse Proxy Architecture Over 3-Slot Tunnel Model

Date: 2026-05-28
Status: Accepted

## Context

The original design proposed 3 simultaneous ngrok tunnels (slot 1: main app, slot 2: switcher UI, slot 3: dynamically selected server). Testing revealed that ngrok's Personal plan assigns one shared public URL to all active tunnels, load-balancing incoming traffic across them unpredictably. This made the 3-slot model non-functional: you could not reliably reach a specific server through the shared URL. A single-tunnel architecture was required.

The user needs to: (a) reach a dashboard to select which local server to expose, (b) have that dashboard always reachable, and (c) proxy other traffic to the selected server — all through one ngrok URL.

## Options Considered

### A - Reverse Proxy (Switcher as Middleware)

**What it is:** A single ngrok process always points at the switcher on port 9595. The switcher serves its own dashboard at `/` and proxies all other requests to the currently selected target server. Target switching is an in-memory variable change — zero tunnel restart.

**Why you'd pick it:** Dashboard is always reachable. Switching is instant. Only one ngrok process. Matches the Personal plan's 1-URL constraint exactly.

**How it gets implemented:** Node.js `http.createServer` with path-based routing. Dashboard at `GET /`. JSON API at `/api/*`. All other paths forwarded via `http.request` to `localhost:<targetPort>`. Ngrok started once at launch, never killed.

**What it costs:** Adds a proxy hop (~1-5ms latency). Proxy does not support WebSocket upgrade (HTTP only). Slightly more backend code than a direct tunnel approach.

### B - Direct Tunnel with Switcher as Local-Only Controller

**What it is:** Switcher runs at `localhost:9595` (no tunnel). User selects a server locally; switcher kills/restarts ngrok to point at the new port. The ngrok URL changes target but the switcher UI is only reachable from the host machine.

**Why you'd pick it:** No proxy overhead. Simpler backend (no reverse proxy logic).

**How it gets implemented:** Switcher spawns/kills ngrok processes on demand, changing the `--url` argument each time. Dashboard is a local-only web page.

**What it costs:** Dashboard unreachable remotely — you cannot switch servers when away from the machine. Ngrok restart takes 3-5 seconds on each switch, causing downtime.

### C - Paid Plan with 3 Separate URLs

**What it is:** Upgrade ngrok to a paid plan that supports multiple reserved domains, one per tunnel.

**Why you'd pick it:** True multi-tunnel setup. Each server gets its own URL. No proxy needed.

**How it gets implemented:** Reserved domains configured in ngrok.yml. Three ngrok processes, each with `--domain=<reserved>`. Switcher manages slot 3's process lifecycle only.

**What it costs:** Monthly subscription fee. Overkill for a personal tool used occasionally.

## Decision

Option A (Reverse Proxy) chosen. It is the only option that satisfies the constraint of one ngrok URL while keeping the dashboard remotely accessible and switching instant — at zero cost.

## Consequences

- **Easier:** Switching servers is instant (no tunnel restart). Dashboard always reachable. Single ngrok process to manage.
- **Harder:** Must handle proxy errors (target down → 502). WebSocket and non-HTTP protocols not supported. Slightly higher latency per request.
- **Reversible:** Yes — switching to Option B requires removing the proxy logic and adding ngrok restart-on-switch. Switching to Option C requires a paid plan upgrade and domain config changes. Both are < 1 hour of work.
