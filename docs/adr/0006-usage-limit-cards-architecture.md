# 0006 - Usage Limit Cards Architecture

Date: 2026-06-22
Status: Accepted

## Context

The llm-dashboard has a fully functional provider usage tracking system (React frontend + Express backend + SQLite). We need to port this feature into the ngrok-dashboard, which is a vanilla HTML/CSS/JS app served by a single Node.js HTTP server with no build step (per ADR-0002). The port spans backend (provider API services, caching, scheduling) and frontend (usage limit cards with progress bars).

## Options Considered

### A - Vanilla JS rewrite with JSON config (chosen)

**What it is:** Rewrite React `LimitBar`/`ProviderCard` components as vanilla JS DOM manipulation in `index.html` using the existing `innerHTML` template + `cardMap` diffing pattern. Backend ported as CommonJS modules under `server/providers/`. Config via `usage.json` (matching existing `servers.json`/`auth.json` pattern). Scheduling via `setInterval` (matching existing 10s server poll). 5 providers: Claude Code, Codex, OpenRouter, DeepSeek, OpenCode Go (new).

**Why you'd pick it:** Zero new dependencies. Consistent with every existing pattern in the codebase. No build pipeline. Single-file frontend changes. Backend modules are focused single-responsibility files.

**How it gets implemented:**
- Backend: `server/providers/*.js` (6 service modules) + `server/jobs/refresh-providers.js` + SQLite `provider_cache` table via existing `better-sqlite3`
- Frontend: new `<section id="provider-grid">` in `index.html` + `renderProviders()` function + compact CSS classes
- Config: `usage.json` with API keys + poll interval
- API: `GET /api/providers`, `POST /api/providers/refresh` added to `server.js` HTTP router

**What it costs:** ~800 lines of new code across ~12 files. Manually maintaining vanilla JS where React would handle state/rendering automatically. The `renderProviders()` function must implement its own flicker-free DOM diffing (already proven pattern from `renderServers()`).

### B - Add React build step to ngrok-dashboard

**What it is:** Add React + Vite to ngrok-dashboard's `package.json`. Port llm-dashboard's React components directly. Keep the existing vanilla JS dashboard alongside React-rendered sections.

**Why you'd pick it:** Direct code reuse from llm-dashboard. React handles state management and DOM updates. Faster to port initially.

**How it gets implemented:** Add `react`, `react-dom`, `vite`, `@vitejs/plugin-react` to dependencies. Create `client/` directory with build pipeline. Update `server.js` to serve Vite output. Mount React root for provider cards only.

**What it costs:** ~5 new npm dependencies. Build step required for every frontend change. Violates ADR-0002 (no-framework architecture). Creates two frontend paradigms in one project (vanilla JS dashboard + React cards). Build pipeline adds deployment complexity.

### C - Proxy provider data from llm-dashboard

**What it is:** Instead of porting backend, add a proxy endpoint in ngrok-dashboard that forwards `GET /api/providers` to a running llm-dashboard instance. Frontend renders cards from proxied data.

**Why you'd pick it:** Minimal backend code. No need to duplicate provider service logic. Always in sync with llm-dashboard's provider implementations.

**How it gets implemented:** Single proxy route in `server.js`. Frontend fetches `/api/providers` which internally calls `http://localhost:3000/api/providers`.

**What it costs:** Requires llm-dashboard to be running. Creates runtime dependency between two apps. If llm-dashboard is down, usage cards show nothing. No standalone operation.

## Decision

Option A — Vanilla JS rewrite with JSON config, matching all existing ngrok-dashboard patterns.

## Consequences

- **Easier:** Zero new dependencies. Consistent with codebase conventions (ADR-0002). Standalone operation. Same diffing pattern as `renderServers()`.
- **Harder:** Manual DOM diffing for flicker-free updates (mitigated by proven `cardMap` pattern). More boilerplate than React would require. Provider service modules must be manually kept in sync with llm-dashboard if it evolves.
- **Reversible:** Yes with effort. Could add React later or proxy from llm-dashboard. Reversal cost: ~800 lines to remove/replace, no dependency cleanup needed.
