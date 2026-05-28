# Decision Index

This file is the agent-facing pointer to the canonical Architecture Decision Records under [`../adr/`](../adr/).

For format, discipline, and full content, see [`../adr/README.md`](../adr/README.md).

## When to write an ADR vs a quick note

- **ADR (per-decision file under `docs/adr/`):** the decision affects the architecture, multiple alternatives were considered, and a future agent could plausibly ask "why did we pick X?". Always for choices made during `superpowers:brainstorming` or `superpowers:writing-plans` sessions - the `writing-adrs` companion skill auto-triggers.
- **Quick note:** trivial decisions (style preferences, single-file naming) - put them in the relevant reference doc or as a comment in the affected code.

Do NOT collapse multiple ADRs into one file in this index. The per-file structure is the value.

## Locked decisions

| # | Title | One-line summary |
|---|---|---|
| [0001](../adr/0001-reverse-proxy-architecture.md) | Reverse proxy architecture over 3-slot tunnel model | Single tunnel with reverse proxy — dashboard always reachable, instant server switching |
| [0002](../adr/0002-node-builtins-no-framework.md) | Node.js built-in http module over Express | Zero dependencies, single `node server.js` works anywhere |
| [0003](../adr/0003-config-plus-port-scan-discovery.md) | Config-file server list with port-range fallback scan | Predictable configured ports + resilient auto-discovery when ports drift |

When the first real ADR is authored, add a row here with format:

```
| [00XX](../adr/00XX-{slug}.md) | {Title} | {one-line summary} |
```

## How to add a new decision

1. Pick the next number (current highest + 1).
2. Create `docs/adr/00XX-{slug}.md` using the format in [`../adr/README.md`](../adr/README.md).
3. Add a row to the table above AND a row to [`../adr/README.md`](../adr/README.md)'s index.
4. Reference the ADR from any code or doc that depends on the decision.

## How to supersede a decision

1. Author the new ADR (00YY) explaining what changes and why.
2. Edit the old ADR's `Status:` line to `Superseded by 00YY`.
3. Do NOT delete the old ADR. The append-only history is the point.
4. Update both index tables to mark the old ADR's status.
