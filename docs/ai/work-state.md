# Ngrok Dashboard - Current State

Last updated: 2026-05-29 by Van

## Active spec

[docs/superpowers/specs/2026-05-28-ngrok-tunnel-switcher-design.md](../superpowers/specs/2026-05-28-ngrok-tunnel-switcher-design.md)
Status: Implemented

## Active plan

[docs/superpowers/plans/2026-05-28-ngrok-tunnel-switcher.md](../superpowers/plans/2026-05-28-ngrok-tunnel-switcher.md)
Status: complete

## Current step

Bug fix release complete. Three issues fixed:
1. Dashboard flickering on refresh → fixed with DOM diffing (cardMap pattern)
2. Auth login errors through tunnel → fixed with Location + Set-Cookie header rewriting
3. Calculate buttons not working through tunnel → fixed with X-Forwarded-* headers + scoped CORS

Unit tests: 22/22 PASS. Smoke tests: all endpoints PASS.

## Known blockers

None.

## Recent decisions

- Proxy now rewrites Location and Set-Cookie headers so redirects and cookies work through the ngrok tunnel
- Dashboard uses incremental DOM updates (cardMap) instead of full innerHTML rebuild — no more flickering
- CORS preflight restricted to API routes only, so OPTIONS requests to backend apps are proxied through correctly

## Next concrete action

Test the fixes with live apps (hub, vanforms) through the ngrok tunnel. Verify:
- Calculate buttons work in FinanceTracker via tunnel
- Auth login flows complete without redirect-to-localhost errors
- Dashboard no longer flickers on 10-second refresh