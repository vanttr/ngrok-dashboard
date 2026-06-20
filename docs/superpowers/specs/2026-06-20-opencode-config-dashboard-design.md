# OpenCode Config Dashboard — Design Spec

**Date:** 2026-06-20
**Status:** Specified

## Problem

Changing a subagent's provider/model in opencode requires manually editing
`opencode.json`, finding the right agent key, knowing the exact model ID
format (`provider/model-id`), and restarting opencode. This is slow, error-prone,
and impossible without knowing which models are available.

## Solution

Add an "OpenCode Config" card to the ngrok-dashboard. Clicking it navigates to
a subpage where the user can:
- See all configured subagents and their current models
- Browse available providers and models (discovered dynamically via opencode CLI)
- Switch any subagent to a different provider/model
- Bookmark favorite provider/model combos for quick reassignment
- Save changes to `opencode.json` (openCode restart required)

## Success criteria

1. Model list is discovered dynamically via `opencode models --verbose`
2. All subagents (`mode: "subagent"`) from opencode.json are shown and editable
3. Provider dropdown filters the model dropdown
4. Favorites persist across sessions in a local JSON file
5. Save writes only `agent.<name>.model` fields — all other config preserved
6. "Restore Defaults" reverts the UI to the snapshot loaded on page open
7. Page works without opencode tunnel (tested via `NO_NGROK=1`)

---

## Architecture

### No new dependencies

Zero-framework approach continues. All built on Node.js built-ins:
`http`, `child_process.spawn`, `fs`, `crypto`, `path`.

### Files

| File | Purpose |
|---|---|
| `server.js` | +6 new API routes, +1 page route, NDJSON parser, opencode.json reader/writer |
| `opencode-config.html` | New subpage — glassmorphism style matching `login.html` |
| `opencode-dash-config.json` | Favorites store (add to `.gitignore`) |
| `tests/opencode-config.test.js` | Unit tests: NDJSON parser, config patching |
| `tests/opencode-config-integration.test.js` | Integration: server spawn, HTTP tests |

### Model discovery

Invoked via `child_process.spawn('opencode', ['models', '--verbose'], { stdio: ['ignore', 'pipe', 'ignore'] })`.

Output is NDJSON: alternating model ID line + JSON metadata block.
Parsed server-side on each `/api/opencode/models` request (~500ms).
Providers derived from `providerID` field in model metadata.

### Config reading

Read `~/.config/opencode/opencode.json`. Filter agents with `"mode": "subagent"`.
Return `{ agentName: { model: "provider/id", provider: "provider", modelId: "id" } }`.

**Compound model ID parsing:** Split on the first `/` only. Everything before is `provider`;
everything after (including any further slashes) is `modelId`. Example:
`"openrouter/xiaomi/mimo-v2.5"` → `provider: "openrouter"`, `modelId: "xiaomi/mimo-v2.5"`.

### Config writing

POST `{ reviewer: "opencode-go/qwen3.6-plus", mini: "openrouter/xiaomi/mimo-v2.5", ... }`.
Server reads current file, patches `agent.<name>.model`, writes back with preserved
formatting. Non-agent keys untouched. Other agent fields preserved.

### Favorites

`opencode-dash-config.json` in project root (gitignored, like `auth.json`):
```json
{
  "favorites": [
    { "provider": "opencode-go", "model": "deepseek-v4-pro" },
    { "provider": "openrouter", "model": "xiaomi/mimo-v2.5" }
  ]
}
```

---

## API Routes

All under auth gate (except page route which redirects to login).

| Route | Method | Purpose |
|---|---|---|
| `/opencode-config` | GET | Serve subpage HTML |
| `/api/opencode/models` | GET | Spawn CLI, parse NDJSON, return JSON |
| `/api/opencode/config` | GET | Read opencode.json, return subagent assignments |
| `/api/opencode/config` | POST | Patch and write opencode.json |
| `/api/opencode/favorites` | GET | Read favorites file |
| `/api/opencode/favorites` | POST | Update favorites (add/remove) |

### Request bodies

**POST `/api/opencode/config`:**
```json
{
  "agents": {
    "reviewer": "opencode-go/qwen3.6-plus",
    "mini": "openrouter/xiaomi/mimo-v2.5",
    "worker": "opencode-go/deepseek-v4-flash"
  }
}
```
All subagent names must be present. The server rejects unknown agent names with 400.

**POST `/api/opencode/favorites`:**
```json
{ "action": "add", "provider": "openrouter", "model": "xiaomi/mimo-v2.5" }
```
```json
{ "action": "remove", "provider": "openrouter", "model": "xiaomi/mimo-v2.5" }
```
`action` must be `"add"` or `"remove"`. Missing or invalid fields → 400.

### Response schemas

**GET `/api/opencode/models` (success):**
```json
{
  "ok": true,
  "models": [
    {
      "id": "deepseek-v4-pro",
      "provider": "deepseek",
      "name": "DeepSeek V4 Pro",
      "capabilities": { "toolcall": true, "input": ["text"] },
      "cost": { "input": 0.14, "output": 0.28 },
      "limit": { "context": 1000000, "output": 384000 }
    }
  ],
  "providers": [
    { "id": "deepseek", "name": "DeepSeek", "baseURL": "https://api.deepseek.com/v1" }
  ]
}
```

**GET `/api/opencode/config` (success):**
```json
{
  "ok": true,
  "agents": {
    "reviewer": { "model": "opencode-go/qwen3.6-plus", "provider": "opencode-go", "modelId": "qwen3.6-plus" },
    "mini": { "model": "openrouter/xiaomi/mimo-v2.5", "provider": "openrouter", "modelId": "xiaomi/mimo-v2.5" },
    "worker": { "model": "opencode-go/deepseek-v4-flash", "provider": "opencode-go", "modelId": "deepseek-v4-flash" }
  }
}
```

---

## UI Layout

### Dashboard card (index.html)

New card at the top of the server grid:
- Title: "OpenCode Config"
- Status line: "N subagents configured"
- Button: "Configure" → navigates to `/opencode-config`

### Config subpage (opencode-config.html)

Glassmorphism style matching `login.html`.

```
┌──────────────────────────────────────────────────────┐
│  ⬅ Back to Dashboard                                 │
│                                                       │
│  ★ Favorites                                         │
│  ┌─────────────────┐ ┌─────────────────┐             │
│  │ opencode-go      │ │ deepseek        │             │
│  │ deepseek-v4-pro ★│ │ deepseek-v4-flash│            │
│  └─────────────────┘ └─────────────────┘             │
│  (starts empty, populates as user stars models)       │
│                                                       │
│  Subagents                                            │
│  ┌───────────────────────────────────────────────┐   │
│  │ reviewer    opencode-go › qwen3.6-plus    ▸   │   │
│  ├───────────────────────────────────────────────┤   │
│  │ mini        openrouter › xiaomi/mimo-v2.5 ▸   │   │
│  ├───────────────────────────────────────────────┤   │
│  │ worker      opencode-go › v4-flash         ▸   │   │
│  └───────────────────────────────────────────────┘   │
│                                                       │
│  [Save Changes]  [Restore Defaults]                   │
│  ⚠ Restart opencode after saving.                    │
└──────────────────────────────────────────────────────┘
```

**Favorites row:**
- Empty on first use. Each chip shows `provider / model` + ★ toggle.
- Clicking a chip on an expanded subagent sets that subagent's dropdowns.
- ★ toggles add/remove from favorites.

**Subagent rows:**
- Collapsed: shows current `provider › model` + expand arrow.
- Click to expand → highlighted row + two dropdowns (Provider, Model) + ☆.
- Provider dropdown: populated from providers list derived from models.
- Changing provider filters the model dropdown.
- ☆ appears when a model is selected → click to favorite.

**Save:**
- POSTs all agent model assignments.
- On success: shows green confirmation + restart reminder.
- On failure: shows error toast, unsaved changes preserved in UI.

**Restore Defaults:**
- Client-side only. Resets all dropdowns to the snapshot from initial page load.

---

## Error handling

| Scenario | Behavior |
|---|---|
| `opencode` CLI not found | Spawn error → `{ ok: false, error: "..." }`. Subpage shows error banner, no models |
| `opencode models` empty | Empty lists. Subpage shows "No models discovered" message |
| `opencode.json` missing | GET returns error. Subpage shows error, save disabled |
| `opencode.json` malformed | Read/write wrapped in try/catch. Error returned to UI |
| No subagents in config | Empty agents list. Subpage shows info message |
| Save fails (disk/permissions) | 500 error with message. UI preserves unsaved state |
| `opencode-dash-config.json` missing | Returns empty favorites `[]`. Created on first write |
| Malformed NDJSON line | Skipped, logged, continues parsing rest |

---

## Testing Strategy

### Test pattern

Node.js built-in `node:test` + `node:assert/strict`. Unit tests extract pure
functions. Integration tests spawn server with `NO_NGROK=1` on ephemeral port.

### Unit tests (`tests/opencode-config.test.js`)

| Test | What it verifies |
|---|---|
| NDJSON: one model | ID line + JSON block → correct fields extracted |
| NDJSON: multiple models, multiple providers | All parsed, providers deduplicated |
| NDJSON: empty input | Returns empty arrays |
| NDJSON: missing JSON block after ID line | Parsed with ID only, no crash |
| NDJSON: malformed JSON block | Skipped, others still parsed |
| Config: extract subagents | Filters to `mode: "subagent"` only |
| Config: patch agent models | Modifies only `agent.<name>.model`, preserves rest |

### Integration tests (`tests/opencode-config-integration.test.js`)

| Test | What it verifies |
|---|---|
| GET `/api/opencode/models` spawns CLI, returns JSON | Real or mocked spawn |
| GET `/api/opencode/config` returns subagents | Reads temp opencode.json |
| POST `/api/opencode/config` patches correctly | Writes to temp file, reads back |
| GET `/api/opencode/favorites` on new install | Returns empty `[]` |
| POST `/api/opencode/favorites` add/remove | Persists across reads |
| Auth gate on all `/api/opencode/*` routes | 401 without session |
| Subpage HTML serves with correct content-type | `text/html; charset=utf-8` |

### What we're NOT testing

| Exclusion | Reason |
|---|---|
| opencode binary correctness | opencode's responsibility |
| Actual opencode restart after save | User performs manually |
| opencode.json concurrent edit conflicts | Single-user tool |
| Visual/styling regression | Manual screenshot review during integration |
| Playwright E2E browser tests | Manual verification (same as login.html) |

> **PLAN GATE:** Every test scenario above MUST become a plan task.
> Plans without corresponding test tasks are rejected at review.

---

## Non-functional

- **Auth:** All `/api/opencode/*` routes gated behind existing auth middleware
- **Security headers:** Inherited from global headers (X-Content-Type-Options, X-Frame-Options, HSTS). Subpage gets same CSP as dashboard
- **Performance:** Model fetch ~500ms (CLI spawn). No server-side caching — each request re-spawns the CLI. The UI may cache the response in memory for the session lifetime (page reload always re-fetches)
- **Filesystem safety:** Config writes use atomic write pattern (write to temp → rename)
- **No new npm dependencies**

---

## Design decisions (ADR)

1. **CLI over serve+API:** `opencode models --verbose` is simpler (no lifecycle management), faster (~500ms vs 2-3s), and avoids port conflicts
2. **Providers derived from model list:** Rather than maintaining a separate provider list, we extract provider IDs from the model metadata and enrich with opencode.json provider config for display names/baseURLs
3. **Favorites are global:** A single list of bookmarked provider/model combos, not per-subagent. Simpler mental model, less UI complexity
4. **Config patching, not rewriting:** On save, we read the current file, modify only `agent.<name>.model`, and write back. All other config (non-agent keys, agent descriptions, prompts, modes) preserved untouched
5. **Subpage, not inline:** OpenCode config gets its own HTML page (`opencode-config.html`) rather than being crammed into index.html. Matches the `login.html` precedent and keeps concerns separate
6. **Tested in isolation first:** Backend routes and subpage tested independently before integration into main dashboard. Enables parallel testing without disrupting running dashboard
7. **First-slash model ID split:** Model values like `openrouter/xiaomi/mimo-v2.5` are split on the first `/` only — `provider` is everything before, `modelId` is everything after. Consistent with how opencode formats compound vendor model paths under a single provider prefix
8. **No server-side model caching:** The CLI spawn is fast enough (~500ms) that caching adds complexity for minimal gain. If performance becomes an issue, the server layer can add an in-process TTL cache without changing the API contract
