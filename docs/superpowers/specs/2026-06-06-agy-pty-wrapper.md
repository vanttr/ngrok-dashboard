# AGY PTY Wrapper Spec

**Date:** 2026-06-06
**Status:** Draft
**Owner:** Van
**Related plan:** TBD
**Related ADRs:** None

## 1. Problem

The `agy` CLI (Antigravity/Gemini CLI v1.0.5) authenticates via keyring and works with `--print` mode, but writes all output to the Windows console via `WriteConsole` API — not stdout/stderr. Direct `child_process.spawn` captures 0 bytes. To use agy programmatically from Node.js (e.g., the scheduler), we need a PTY-based wrapper that captures terminal output.

## 2. Goals

- G1. Invoke `agy -p "prompt"` from Node.js and capture the plain-text response
- G2. Strip ANSI escape codes and terminal control sequences from captured output
- G3. Handle auth timing (keyring authentication completes asynchronously after process start)
- G4. Support configurable timeout and model selection
- G5. Return clean text suitable for downstream consumption (scheduler, pipeline)

## 3. Non-goals

- NG1. No interactive chat mode — print-only (`--print` / `-p`)
- NG2. No protobuf parsing of conversation DBs
- NG3. No direct Google API calls (uses agy CLI as intermediary)
- NG4. No cross-platform support (Windows-only for now)

## 4. Requirements

### Functional

- R1. Accept a prompt string and optional model name, return the text response
- R2. Spawn agy via ConPTY (`node-pty`) to capture terminal output
- R3. Strip ANSI escape sequences from captured output
- R4. Detect response completion via output silence (configurable, default 3s)
- R5. Kill the agy process after response is captured
- R6. Handle agy errors (auth failure, API error, timeout) with clear error messages
- R7. Accept `--model` flag to set the Gemini model
- R8. Return exit code 0 on success, non-zero on failure

### Non-functional

- N1. Response capture latency < 30s for simple prompts (typical: 5-10s)
- N2. No npm dependencies beyond `node-pty` (already installed)
- N3. Compatible with Node.js >= 18 (project requirement)

## 5. Constraints And Existing Facts

- C1. agy writes to Windows console via WriteConsole API, not stdout/stderr
- C2. agy authenticates via Windows keyring (Credential Manager) — account `vant.tr@gmail.com`
- C3. agy stores data in `~/.gemini/antigravity-cli/`
- C4. Model: `Gemini 3.5 Flash (Medium)` (code: `gemini-3.5-flash-low`)
- C5. agy sometimes enters agentic planning loops depending on prompt phrasing
- C6. Simple directive prompts (`"respond with just the word: X"`) avoid agentic behavior
- C7. `node-pty` v1.1.0 installed (prebuilt Windows binary)
- C8. `node-pty` has a known `AttachConsole failed` crash on `term.kill()` (needs graceful handling)
- C9. agy process exits ~1-2s after last output in print mode

## 6. Assumptions, Gaps, And Open Questions

| Type | Statement | Impact | Owner / Resolution trigger |
|---|---|---|---|
| Assumption | `node-pty` ConPTY captures all WriteConsole output | Core mechanism | Validate with diverse prompts |
| Assumption | Auth succeeds within 5s of process start | Must handle auth-failure fallback | Monitor `auth.go:114` in logs |
| Assumption | `--dangerously-skip-permissions` suppresses all prompts | Required for non-interactive use | Test with tool-using prompts |
| Gap | "no active conversation" error seen in some PTY spawns | Root cause unknown (auth timing?) | Debug if reproducible |
| Gap | agy agentic loops consume API quota unnecessarily | Prompt engineering mitigates but doesn't eliminate | Warn caller, add hard timeout |

## 7. Proposed Design

### Architecture

```
┌─────────────┐     spawn (ConPTY)     ┌──────────┐    WriteConsole    ┌──────┐
│  PTY Wrapper │ ────────────────────→ │ node-pty │ ←─────────────── │ agy  │
│  (Node.js)   │                       │ (ConPTY) │                   │ CLI  │
└──────┬───────┘                       └────┬─────┘                   └──┬───┘
       │                                    │ onData(text)               │
       │  ┌─────────────────────────────────┘                            │
       │  │  raw output (ANSI + text)                                   │
       ▼  ▼                                                              │
  ┌──────────┐                                                           │
  │  Strip   │ ──→ clean text ──→ stdout                                │
  │  ANSI    │                                                           │
  └──────────┘                                                           │
```

### Interface

```js
// Module export
async function agyPrompt(prompt, options = {}) {
  // options: { model?, timeout?, silenceTimeout?, cwd? }
  // returns: { text: string, exitCode: number, duration: number }
}
```

### CLI usage
```
node scripts/agy-pty.js "what is 2+2?"
node scripts/agy-pty.js "summarize this file" --model "gemini-2.0-flash"
```

### Data Flow
1. Caller invokes wrapper with prompt string
2. Wrapper spawns agy via `pty.spawn()` with: `-p`, `--dangerously-skip-permissions`, `--print-timeout`
3. Wrapper accumulates `onData` chunks with a silence timer
4. On 3s silence (configurable), wrapper kills agy process
5. Wrapper strips ANSI codes from accumulated text
6. Wrapper returns clean text to caller via stdout/Promise

## 8. Edge Cases And Failure Modes

| Case | Expected behavior | Mitigation / test |
|---|---|---|
| Auth fails (no keyring) | Exit with error message, code 1 | Check for "not logged in" in output |
| agy hangs (infinite planning) | Hard timeout kills process, returns partial + error | 60s hard timeout + silence timer |
| Empty prompt | Exit with usage error | Validate input |
| agy crashes mid-response | Return captured text + warning | Check exit code |
| Response contains ANSI art | Strip to clean text | ANSI regex tested on known patterns |
| Prompt triggers tool use | May produce tool output in response | Accept as-is, caller filters |
| `node-pty` kill crash | Suppress crash, process already dead | Try/catch around term.kill() |

## 9. Alternatives Considered

| Alternative | Verdict | Reason |
|---|---|---|
| Direct Google AI Studio API | Rejected | Requires separate API key; agy subscription already paid/available |
| Parse conversation SQLite DB | Rejected | Protobuf BLOBs; fragile; schema may change with agy updates |
| PowerShell `Start-Process` | Rejected | Timed out — agy waits for terminal interaction |
| `cmd /c` redirect | Rejected | 0 bytes captured; agy uses WriteConsole, not stdout |
| `child_process.spawn` + log polling | Rejected | Log shows response length but not content; response text only in DB |

## 10. Risks And Limitations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `node-pty` ConPTY instability | Medium | High (wrapper broken) | Fallback to PowerShell-based PTY if needed |
| agy version update breaks behavior | Medium | Medium | Pin agy version; integration test on update |
| Agentic loops waste quota | Medium | Medium | Short prompts; hard timeout; monitor quota |
| Keyring auth expires | Low | High | Detect auth failure; prompt user to re-auth |

## 11. Acceptance Criteria

1. `node scripts/agy-pty.js "respond with just: pong"` prints "pong" to stdout within 15s
2. ANSI codes are stripped (no `\x1b[...` in output)
3. Exit code 0 on success
4. Exit code non-zero on failure (auth missing, timeout)
5. Works when called from another Node.js script via `child_process.execFile`
6. Does not leave orphan agy processes after completion

## 12. Verification Strategy

- **Automated:** Unit test with mock PTY output (ANSI stripping, silence detection)
- **Manual:** Run against real agy with 3 different prompt types (simple, medium, agentic-adjacent)
- **Integration:** Call from scheduler prototype, verify text response received
