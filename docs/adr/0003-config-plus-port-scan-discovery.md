# 0003 - Config-File Server List with Port-Range Fallback Scan

Date: 2026-05-28
Status: Accepted

## Context

The switcher needs to know which local servers exist, their names, and their current ports. Hardcoding ports in `server.js` is brittle — ports drift as servers are reconfigured or multiple instances run. The user requested: "ports [should be] scanned and refreshed in the UI." The question was how to balance predictability (configured ports) with resilience (auto-discovery when ports drift).

## Options Considered

### A - Config File + Port-Range Fallback Scan (Hybrid)

**What it is:** A `servers.json` file defines server names and their expected ports. On each health-check cycle, the switcher hits the configured port first. If unreachable, it scans ±N ports around it (configurable `scanRange`, default 50). The first responding port is assumed to be the drifted server.

**Why you'd pick it:** Deterministic primary path (configured port). Self-healing secondary path (fallback scan). No full-port-range scanning noise. User controls server names and primary ports in one file.

**How it gets implemented:**
```javascript
async function discoverServer(server) {
  if (await checkPort(server.port)) return { ...server, actualPort: server.port, status: 'ok' };
  for (let p = server.port - SCAN_RANGE; p <= server.port + SCAN_RANGE; p++) {
    if (p === server.port) continue;
    if (await checkPort(p, 500)) return { ...server, actualPort: p, status: 'drifted' };
  }
  return { ...server, actualPort: null, status: 'down' };
}
```

**What it costs:** On each cycle, down servers trigger up to 101 port probes (2 × scanRange + 1). At 500ms timeout per probe, worst case is ~50 seconds for all down servers sequentially. Acceptable for a 10-second refresh cycle (probes are async and non-blocking, results update when available). Slightly noisy in firewall logs.

### B - Full Port-Range Scan (No Config)

**What it is:** No `servers.json`. On each cycle, scan a wide port range (e.g., 3000-10000) for any HTTP responders. Display discovered ports in the UI with auto-generated names like "Server on :8086."

**Why you'd pick it:** Truly zero configuration. Catches any server regardless of port. No manual config maintenance.

**How it gets implemented:** Scan 3000-10000 with short timeouts. Build server list from responders. Optionally fingerprint responses to guess server identity.

**What it costs:** 7000 port probes per cycle — unacceptably slow (~58 minutes at 500ms timeout) and noisy. Cannot provide meaningful server names. May trigger intrusion detection on some networks.

### C - Config-Only (No Scan)

**What it is:** `servers.json` defines both names and ports. Health check only hits configured ports. No fallback scanning. If port drifts, server appears "down."

**Why you'd pick it:** Simplest code. Zero scan overhead. Deterministic.

**How it gets implemented:** Single `checkPort(server.port)` per server per cycle.

**What it costs:** Port drift causes false "down" status. User must manually update `servers.json` whenever a port changes. Brittle for frequently changing dev environments.

## Decision

Option A (Config file with port-range fallback scan) chosen. It gives the user the predictability of named, configured servers while automatically handling the common case of a server starting on a slightly different port — exactly the balance the user requested ("config, fallback to scan within the config range").

## Consequences

- **Easier:** Servers found even when ports drift. Config file is the single source of truth for server names and expected ports. Scan range is tunable.
- **Harder:** Slightly more complex discovery logic (~20 extra lines vs config-only). Down servers trigger port scans that add latency to status updates (mitigated by async non-blocking design). Ambiguous case: if two servers both respond within a scan range, the first found wins — could misidentify. Acceptable given the narrow ±50 port window.
- **Reversible:** With effort — switching to Option C requires removing the fallback loop (~10 lines). Switching to Option B requires replacing the entire discovery module.
