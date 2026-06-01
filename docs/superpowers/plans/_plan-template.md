# Implementation Plan Template

Canonical source: `agent-shared/docs/reference/implementation-plan-template.md`
Authoring standard: `agent-shared/docs/reference/engineering-docs-standard.md`

```md
# <Feature / Component> Implementation Plan

**Status:** todo | in progress | complete | superseded
**Spec:** <link>
**Related ADRs:** <links or `None`>

**Goal:** <one sentence outcome>
**Scope:** <what this plan covers>
**Non-goals:** <what it does not cover>
**Prerequisites:** <required prior plans or `(none)`>
**Produces:** <files, behavior, tests, docs>

## Definition of Done

- <required shipped behavior>
- <required automated verification>
- <required manual verification>

## Assumptions, Gaps, And Limitations

| Type | Statement | Impact | Action |
|---|---|---|---|
| Assumption | <statement> | <impact> | <action> |

## Risk Register

| Risk | Why it matters | Mitigation | Verification hook |
|---|---|---|---|
| <risk> | <impact> | <control> | <test/check> |

## Task 1: <concrete deliverable>

**Files:**
- Modify: `<path>`

**Steps:**
- [ ] <concrete step>
- [ ] <verification step>

**Tests / checks:**
- `<command>`

## Evidence Required Before Completion

- Code paths changed match scope.
- Listed checks ran successfully or are marked environment-dependent.
- Remaining limitations are documented.

## Completion Checklist

- [ ] All tasks complete
- [ ] Definition of Done met
- [ ] Indexes/state docs updated if required
```
