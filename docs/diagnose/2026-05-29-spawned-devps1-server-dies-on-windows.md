# Diagnosis Session: Spawned dev.ps1 Server Process Dies Immediately on Windows

**Date:** 2026-05-29
**Session ID:** start-server-spawn-fix
**Bug Severity:** critical
**Files Changed:** 2 files
**Root Cause Layer:** 2+ layers below

---

## 1. Bug Description

**Reported symptom:**
User clicks "Start" button on the ngrok dashboard to start an offline server (e.g., Openchamber on port 57123). The API returns `{"ok":true,"starting":true}` but the server never comes online. After 12 seconds the fast-poll times out and the button reverts to "Start". The server process was spawned but died silently.

**Impact assessment:**
The entire "Start Server from Dashboard" feature was non-functional. Every `dev.ps1` script that uses `Start-Process` internally to launch its server would fail. This affects all 7 configured servers on this Windows machine.

**Reproduction steps:**
1. Start the ngrok dashboard (`node server.js`)
2. Verify a server (e.g., Openchamber) shows as "down" on the dashboard
3. Click "Start" on that server's card
4. API returns `{ok: true, starting: true}`
5. Wait 12+ seconds — server stays down, button reverts to "Start"

---

## 2. Investigation Summary

**Hypotheses generated:**

1. **H1: The dev.ps1 script itself is broken** — the script fails to start the server
2. **H2: The spawn command is wrong** — Node.js `spawn` arguments are malformed
3. **H3: The spawned process tree collapses** — grandchildren die when the PowerShell wrapper exits

**Evidence for each:**

- **H1 ruled out:** Running `powershell -ExecutionPolicy Bypass -File dev.ps1` directly from a terminal works perfectly. The dummy server starts and listens on port 57123. The real Openchamber dev.ps1 also works when run manually.
- **H2 partially supported:** The original `spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', devScript])` syntax is correct — PowerShell does receive and execute the script. The script runs, does its port cleanup, and launches the server. But the server process dies.
- **H3 confirmed:** On Windows, when Node.js spawns `powershell.exe` with `detached: true, stdio: 'ignore'`, the PowerShell process runs the script. The script's `Start-Process node ...` creates a grandchild node process. When the PowerShell wrapper exits (after the script completes), the grandchild process does NOT survive — despite `detached: true` and `Start-Process -WindowStyle Hidden`. The console hosting the PowerShell process terminates and takes its child processes with it.

**Backwards trace:**
```
User sees server still down after clicking Start
  ← API returned success but server never listened on port
    ← Node.js spawned PowerShell, which ran dev.ps1, which launched node server
      ← PowerShell exited after script completed
        ← Windows terminated the console and all child processes
          ← The node server (grandchild) was killed along with the console
```

Layer depths: symptom (server down) → 1 layer (spawn succeeded but server died) → 2+ layers (Windows console process lifecycle kills grandchildren)

---

## 3. Blast Radius (from diagnostic-rigor Phase 1)

**Call chain depth:** 4 layers (Node.js → cmd/powershell → powershell script → Start-Process → node/bun server)

**Interfaces touched:**
| Interface | Consumers | Impact |
|-----------|-----------|--------|
| `POST /api/servers/:port/start` | Dashboard frontend | direct — the entire feature was broken |
| `spawn()` call in server.js | All 7 server start operations | direct — every server start was affected |
| `dev.ps1` scripts | Each server's start process | indirect — scripts work correctly when run standalone |

**Contract dependencies:**
- The API contract (`{ok: true, starting: true}`) was correct — the bug was in the side effect (process spawn), not the API response.
- No return type or signature changes were needed.

---

## 4. Root Cause

**Root cause location:**
`server.js` — the `spawn('powershell.exe', ...)` call inside the `POST /api/servers/:port/start` handler.

**Root cause description:**
Node.js `child_process.spawn('powershell.exe', ['-File', script], { detached: true, stdio: 'ignore' })` on Windows creates a new console for the PowerShell process. When the PowerShell script completes and exits, Windows destroys that console. Any child processes created by the script (via `Start-Process`) that share the same console are terminated along with it.

This is a Windows-specific behavior: `detached: true` in Node.js creates a new process group, but `Start-Process -WindowStyle Hidden` inside a PowerShell script doesn't create a fully independent console session. The grandchild process inherits the parent console and dies when it's destroyed.

The fix requires using `cmd.exe /c start` to launch PowerShell, which creates a genuinely independent console process that survives after the Node.js parent disengages.

**Why previous fixes missed it:**
This was a first implementation — the bug was introduced in the initial code. The original implementation used the "obvious" approach of `spawn('powershell.exe', ['-File', script])` which appears correct from the Node.js documentation perspective. The Windows console lifecycle behavior is not documented in Node.js docs and is only discoverable through actual runtime testing.

---

## 5. Fix Applied

**Fix location:**
`server.js` — the spawn call in the `POST /api/servers/:port/start` handler.

**Fix description:**
Changed from:
```javascript
spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', devScript], {
  detached: true, stdio: 'ignore', windowsHide: true
});
```

To:
```javascript
spawn('cmd.exe', ['/c', 'start', '/min', 'powershell.exe',
  '-ExecutionPolicy', 'Bypass', '-File', devScript
], {
  detached: true, stdio: 'ignore', windowsHide: true
});
```

`cmd /c start /min` creates a new, fully independent console window for PowerShell. The `/min` flag starts it minimized. This console persists after the Node.js spawn returns, and the PowerShell process inside it survives to run `Start-Process` and keep its children alive.

**Failed intermediate attempts:**

1. **`spawn('powershell.exe', ['-Command', 'Start-Process powershell -ArgumentList ...'])`** — Nested quoting of `-ArgumentList` with embedded single quotes and paths got mangled when passed through Node.js `spawn`'s argument array. PowerShell received malformed arguments.

2. **Temp launcher .ps1 file** — Created a temp `.ps1` file containing `Start-Process powershell -ArgumentList @(...) -WindowStyle Hidden`, then spawned `powershell.exe -File launcher.ps1`. This worked when run from cmd.exe but still failed from Node.js `spawn` — the same console lifecycle issue occurred because the outer PowerShell still hosted the process tree.

**TDD test:**
- `tests/start-server-visual.spec.ts` — Playwright E2E test that starts a dummy server, verifies the full flow (down → Start → Starting → online → Tunnel button)
- Verified with screenshot evidence reviewed by subagent reviewers

---

## 6. Fix Audit (from diagnostic-rigor Phase 2)

**Root cause depth check:**
Fix at correct layer? **Yes** — the fix is at the process spawning layer, which is where the root cause lives (Windows console process lifecycle). No workaround in the dev.ps1 scripts was needed.

**Affected interface coverage:**
- `POST /api/servers/:port/start` — tested via curl and Playwright
- Dashboard UI (Start button, Starting state, Tunnel button) — tested via Playwright with screenshots
- Server process survival — verified by checking port 57123 after spawn and confirming `curl localhost:57123` returns response

**Caller contract impact:**
No API contract changes. The endpoint still returns `{ok: true, starting: true}`. The only change is internal to how the process is spawned.

**Regression suite result:**
- All 4 Playwright visual tests pass
- Screenshot review by subagent: all 4 screenshots PASS
- `node -c server.js` — no syntax errors
- API endpoint validation: unknown port → 400, missing devScript → 400, valid start → 200

---

## 7. Lessons Learned

**What we missed:**
- **No E2E test of the actual spawn.** The initial implementation tested the API endpoint's response codes (400 for unknown port, etc.) but never verified that the spawned process actually survives and starts listening on its port. Unit-level API tests pass even when the side effect (process spawn) is broken.
- **Windows process lifecycle is not intuitive.** `detached: true` in Node.js docs suggests the child process becomes independent, but on Windows it only detaches from the Node.js process group — it doesn't create a fully independent console session. Grandchildren still die with the parent console.
- **The `cmd /c start` pattern is the correct way** to launch independent processes on Windows from Node.js. This should be the default approach for any similar spawn-on-Windows feature.

**Prevention:**
- Always test spawn/process features with actual process survival verification, not just API response codes
- Add a Windows-specific spawn pattern to the project's AGENTS.md or reference docs
- For dev.ps1 scripts, the `Start-Process` inside them works correctly — the fix was only needed at the Node.js spawn layer

**Related work:**
- Updated `AGENTS.md` with background process rules and port cleanup commands
- Created `vanforms/dev.ps1` at project root (moved from `scripts/restart-app.ps1`)
- Added `test-dummy-dev.ps1` pattern for future E2E testing (deleted after testing)

---

## 8. Code Changes

**Files modified:**
- `server.js`: Changed `spawn('powershell.exe', ...)` to `spawn('cmd.exe', ['/c', 'start', '/min', 'powershell.exe', ...])` in the start-server endpoint
- `AGENTS.md`: Added background process and port cleanup rules for subagents

**Commit:**
Not yet committed (pending final review)

**Related issues/PRs:**
- Spec: `docs/superpowers/specs/2026-05-29-start-server-from-dashboard-design.md`
- Plan: `docs/superpowers/plans/2026-05-29-start-server-from-dashboard.md`
