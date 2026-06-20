# Ngrok Dashboard - Current State

Last updated: 2026-06-20 by Van + agent

## Active work

### OpenCode Config Dashboard
- Plan: [docs/superpowers/plans/2026-06-20-opencode-config-dashboard.md](../superpowers/plans/2026-06-20-opencode-config-dashboard.md)
- Current step: Implementation plan written, dual-domain review in progress
- Status: Planning
- Mode: plan

## Active spec

[docs/superpowers/specs/2026-06-20-opencode-config-dashboard-design.md](../superpowers/specs/2026-06-20-opencode-config-dashboard-design.md)
Status: Specified

## Known blockers

None.

## Recent decisions

- ADR 0005: OpenCode config dashboard — CLI model discovery, config patching, global favorites, isolated testing
- Spec: OpenCode Config Dashboard — 7-task plan, dynamic model discovery via `opencode models --verbose`

## Completed features

- [x] Security hardening (2026-06-20) — rate limiting, security headers, wildcard CORS removal
- [x] Ngrok tunnel switcher (2026-05-29) — reverse proxy, server discovery, dashboard with server card grid, bug fixes (3 rounds)