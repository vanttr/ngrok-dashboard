# Architecture Decision Records (ADRs)

This directory captures architecturally significant decisions made for {project_name}. Each ADR is a numbered file documenting one decision, its context, the options considered, the choice made, and the consequences.

## Why ADRs

- **Searchable history.** "Why did we pick X?" -> a single linkable file.
- **Cold-start orientation.** New agents (and future-you) see the design rationale without re-deriving it.
- **Append-only audit trail.** Decisions are dated; if revisited later, the original ADR is preserved and a new ADR supersedes it.

## When to write an ADR

- The decision affects the architecture (deployment target, auth model, dependency tooling, framework choice, data model shape).
- Multiple plausible alternatives were considered and rejected.
- A future agent could plausibly ask "why did we pick X?" and the answer is not obvious from reading the code.
- The decision was made during a `superpowers:brainstorming` or `superpowers:writing-plans` session - the `writing-adrs` companion skill should auto-trigger to author the file.

When NOT to write an ADR:
- Trivial decisions (style preferences, single-file naming).
- Decisions that are forced by the stack (we use Python because the codebase is Python).
- Reversible decisions with low cost.

## Format

Each ADR uses these sections in this order:

```markdown
# 00XX - Title

Date: YYYY-MM-DD
Status: Accepted | Superseded by 00YY | Deprecated

## Context
What situation forced a choice? Constraints, prior state, what triggered the decision.

## Options Considered

### A - Option name
**What it is:** concrete description, including specific tools/libraries/files.
**Why you'd pick it:** the use case it solves.
**How it gets implemented:** what the code/config/files actually look like.
**What it costs:** tooling overhead, learning curve, future migration cost.

### B - Option name
(same four sub-headings)

### C - Option name (if any)
(same four sub-headings)

## Decision
Which option was chosen, in one sentence.

## Consequences
- Easier: what becomes easier
- Harder: what becomes harder
- Reversible: yes/no/with effort - and what the reversal costs
```

The Options Considered detail is the most-violated part. Each option must have all four sub-fields filled with concrete content. **No "Option A: use Docker" with one tradeoff line.** If an option needs research to be answerable, write the research into the option itself.

## Discipline (non-negotiable)

- **Append-only.** A superseded ADR keeps its file but gets `Status: Superseded by 00YY` at the top. Never delete.
- **Numbering is permanent.** Numbers are assigned at creation; never renumbered.
- **One decision per file.** Compound decisions are split.
- **Concise.** Most ADRs are 50-100 lines. Long enough for the rationale; short enough to scan in 2 minutes.
- **Author when the decision is locked, not later.** Memory drifts.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-reverse-proxy-architecture.md) | Reverse proxy architecture over 3-slot tunnel model | Accepted |
| [0002](0002-node-builtins-no-framework.md) | Node.js built-in http module over Express | Accepted |
| [0003](0003-config-plus-port-scan-discovery.md) | Config-file server list with port-range fallback scan | Accepted |
