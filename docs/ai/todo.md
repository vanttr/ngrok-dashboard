# Ngrok Dashboard - Running TODO

Last updated: 2026-06-04 by Van + agent

## Scheduled AI Prompts

### Now
- [ ] Plan: Complete dual-domain review and commit plan

### Soon (this week)
- [ ] Execute: Implement 8 tasks (config, credentials, scheduler, API calls, endpoint, dashboard UI, dashboard JS, integration)

### Blocked
(empty)

## Unfeatured / backlog

### Soon
- [ ] Live-test auth login flow through ngrok tunnel

### Later
- [ ] Consider adding request body size limit (currently unbounded)
- [ ] Consider adding ngrok `--request-header-add` for extra auth layer on public computers

## Blocked / waiting

(empty)

## Recently completed

- [x] Bug fix (round 3): POST requests 502 — Node.js v16+ autoDestroy on req emits 'close' after 'end', triggering premature proxyReq.destroy(); fixed with reqEnded flag
- [x] Bug fix (round 3): Added agent: false to http.request to avoid stale connection pool reuse
- [x] Live-test calculate buttons in Hub through proxy: PASS (screenshot verified)
- [x] Live-test dashboard zombie card fix: PASS (1 Hub card before/after activation/after poll)
- [x] Re-diagnosis: confirmed three remaining bugs after initial fix
- [x] Bug fix (round 2): Zombie card DOM leak in renderServers() — old el not removed before replacement
- [x] Bug fix (round 2): renderHeader rebuilding innerHTML every poll unnecessarily — now conditional
- [x] Bug fix (round 2): Proxy HTML body rewriting — localhost:PORT URLs in HTML attrs/JS not rewritten → HTMX bypasses proxy → auth/CSRF fail
- [x] Unit tests: 32/32 passing (10 new rewriteHtmlBody tests added)
- [x] Bug fix: Dashboard flickering on 10s refresh → DOM diffing (cardMap pattern)
- [x] Bug fix: Auth login errors through tunnel → Location + Set-Cookie header rewriting
- [x] Bug fix: Calculate buttons broken through tunnel → X-Forwarded-* headers + scoped CORS
- [x] Smoke tests: all endpoints responding correctly
- [x] Spec: ngrok tunnel switcher design (brainstorming + user approval)
- [x] ADR 0001: Reverse proxy architecture
- [x] ADR 0002: Node.js built-in http module
- [x] ADR 0003: Config + port scan discovery
- [x] Implementation plan written and peer-reviewed (8 tasks)
- [x] Task 1-8: All implementation tasks complete
- [x] Smoke test: 15/15 PASS
- [x] Final code review: PASS
- [x] Post-review fixes: dedup + 3xx health check