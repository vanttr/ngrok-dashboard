# AGY PTY Wrapper — Implementation Plan

**Date:** 2026-06-06
**Status:** Planned
**Spec:** [../specs/2026-06-06-agy-pty-wrapper.md](../specs/2026-06-06-agy-pty-wrapper.md)
**Related ADRs:** None

## Task Breakdown

| # | Task | Est. | Type | Deps |
|---|---|---|---|---|
| 1 | Fix PTY spawn — resolve "no active conversation" / auth timing in ConPTY | 30m | standard | — |
| 2 | Implement ANSI stripping regex | 15m | standard | 1 |
| 3 | Implement silence-detection timer (3s default) | 10m | standard | 1 |
| 4 | CLI interface (minimist or manual argv parsing) | 15m | standard | 1 |
| 5 | Error handling (auth fail, timeout, crash, kill-crash) | 15m | standard | 1 |
| 6 | Integration test with real agy prompts | 15m | standard | 2–5 |

## Risk Map

| Risk | Severity | Mitigation |
|---|---|---|
| PTY "no active conversation" persists | High | Try `pty.spawn` with `shell: true`, `cmd.exe` wrapper, or different ConPTY config |
| `node-pty` kill crash unresolved | Medium | Try/catch around `term.kill()`, accept zombie process on Windows |
| Agentic loops with certain prompts | Medium | Recommend directive prompts, hard timeout, document limitation |

## Files

| File | Action | Purpose |
|---|---|---|
| `scripts/agy-pty.js` | CREATE | Main wrapper script |
| `.tmp/` test scripts | CLEANUP | Remove PoC test files after implementation |

## Classification

All tasks classified as **standard** (utility script, no security-sensitive data, no migrations, no visual UI).

## Verification

- Task 6: Run 3 prompts of different types, verify clean text output
- Manual: Verify no orphan agy processes (`tasklist | findstr agy`)
