# Ngrok Dashboard - Current State

Last updated: 2026-06-04 by Van + agent

## Active work

### Scheduled AI Prompts
- Plan: [docs/superpowers/plans/2026-06-04-scheduled-ai-prompts.md](../superpowers/plans/2026-06-04-scheduled-ai-prompts.md)
- Current step: Implementation plan written, pending dual-domain review
- Status: Planned
- Mode: plan

## Active spec

[docs/superpowers/specs/2026-06-04-scheduled-ai-prompts-design.md](../superpowers/specs/2026-06-04-scheduled-ai-prompts-design.md)
Status: Specified

## Known blockers

None.

## Recent decisions

- ADR 0004: Scheduled prompt architecture — server-side HTTPS scheduler with read-only credential loading, minute-offset polling for time accuracy
- Proxy now rewrites Location and Set-Cookie headers so redirects and cookies work through the ngrok tunnel
- Dashboard uses incremental DOM updates (cardMap) instead of full innerHTML rebuild — no more flickering
- CORS preflight restricted to API routes only, so OPTIONS requests to backend apps are proxied through correctly

## Completed features

- [x] Ngrok tunnel switcher (2026-05-29) — reverse proxy, server discovery, dashboard with server card grid, bug fixes (3 rounds)