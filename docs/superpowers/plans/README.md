# {project_name} Plans - Master Index

This directory holds every implementation plan for {project_name}. Plans are organised hierarchically: **core / framework** plans build the foundation; **feature** or **module** plans build individual components on top.

## How to use this index

- **Picking up cold?** Read [`docs/ai/agents-handbook.md`](../../ai/agents-handbook.md) first, then [`docs/ai/work-state.md`](../../ai/work-state.md), then [`docs/ai/todo.md`](../../ai/todo.md), then come here.
- **Each plan is self-contained.** It lists prerequisites and what it produces. You don't need to read other plans unless yours depends on them.
- **Status column reflects truth.** When you start a plan, change to `in progress`. When all tasks check off and the Definition of Done is verified, change to `complete`.
- **Adding a new feature?** Create a new plan file in the appropriate folder; add a row here. Don't expand existing plans. (See [`writing-hierarchical-plans`](https://github.com/Van/.claude/skills/writing-hierarchical-plans/SKILL.md) skill for the rationale.)

## Status legend

- `todo` - not started
- `in progress` - actively being worked on (also reflected in `work-state.md`)
- `complete` - all tasks ticked, DoD verified, committed
- `superseded` - replaced by a newer plan (rare; explain in the row)

---

## Core / framework plans

The foundation every feature plan depends on. Dependency-ordered (later plans depend on earlier ones unless noted).

| # | Plan | Status | Depends on | Produces |
|---|---|---|---|---|
| 01 | [Repo scaffold](core/01-{slug}.md) | todo | (none) | {what this plan delivers} |
| 02 | [{Plan name}](core/02-{slug}.md) | todo | 01 | {what this plan delivers} |
| ... | | | | |

[Sub-index with more detail in `core/README.md`](core/README.md).

### Suggested execution order

```
{ASCII dependency diagram, e.g.}
01 -> 02 -> 03 ----> 07
         \      \    /
          ->04 -+    /
          ->05 ---+
              \    \
               ->06 +
```

---

## Feature / module plans

Each feature or module has its own folder. The folder structure mirrors the core: one plan for the skeleton, additional plans for each major feature within the module.

| Module | Folder | Status |
|---|---|---|
| (no modules yet - first one needs a brainstorm + spec first) | | |

When a module is added, the table grows. Example future row:

| `{module-name}` | [`{module-name}/`](features/{module-name}/) | in progress |

---

## Cross-cutting work

Plans that affect multiple modules or that are not strictly "core" or "feature" work go here.

| Plan | Status | Notes |
|---|---|---|
| (none yet) | | |

---

## Workflow for adding a new plan

1. Decide whether the plan is **core**, **feature/module-specific**, or **cross-cutting**.
2. Create the plan file in the appropriate folder, named with a 2-digit prefix matching its order within that folder (e.g. `03-{slug}.md`).
3. Use the template at [`_plan-template.md`](_plan-template.md) as a starting point.
4. Add a row to the relevant table above. Set status to `todo`.
5. Add the first action to [`docs/ai/todo.md`](../../ai/todo.md) so the next agent picks it up.
6. Commit.

## Workflow for executing a plan

1. Open the plan file.
2. Set status to `in progress` here AND in the plan's own header.
3. Update [`docs/ai/work-state.md`](../../ai/work-state.md) to point at this plan.
4. Execute task-by-task using `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
5. Mark each step with `[x]` as it completes.
6. When the plan's Definition of Done is verified, set status to `complete` here, in the plan, and update `work-state.md` + `todo.md`.
