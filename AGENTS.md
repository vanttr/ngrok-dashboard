# {project_name} - Agent Quickstart

This is the canonical agent entrypoint for this repository. Codex CLI, Claude Code, Gemini CLI, and any other agent CLI should start here.

## Read order (cold start)

```
1. cat AGENTS.md                                 (this file - rules)
2. cat docs/ai/agents-handbook.md                (orientation)
3. cat docs/ai/work-state.md                     (right-now state)
4. cat docs/ai/todo.md                           (what to do next)
5. cat docs/superpowers/plans/README.md          (master plan index)
```

After these five commands you know the rules, the layout, the active step, the prioritised actions, and the design + plan being executed.

## Instruction precedence

1. Direct user instructions in the current conversation.
2. Nearest scoped `AGENTS.md`, then this root `AGENTS.md`.
3. Referenced markdown under `docs/ai/`, `docs/adr/`, or `docs/superpowers/`.
4. Agent-specific adapters such as `CLAUDE.md`, `GEMINI.md`, or `CODEX.md`.
5. General model defaults.

## Required workflow

1. Read this file first.
2. Read scoped `AGENTS.md` in any folder you edit (if present).
3. For code changes, follow the testing policy in [docs/ai/global-rules.md](docs/ai/global-rules.md).
4. Use `godpowers` as the workflow entrypoint:
   - `godpowers brainstorm` for new features, architecture changes, and requirement shaping
   - `godpowers plan` after the spec is approved and before non-trivial implementation
   - `godpowers execute` for implementation, verification, and completion gates
   - `godpowers debug` for bugs, regressions, and failing behavior
5. Treat direct `superpowers:*` names as internal steps wrapped by `godpowers`, not the repo-facing entrypoint.
6. Architecturally significant decisions go to [docs/adr/](docs/adr/) as numbered files.
7. Plans are hierarchical (see [docs/superpowers/plans/README.md](docs/superpowers/plans/README.md)). New features add new plan files; existing plans don't bloat.
8. Author specs from [docs/superpowers/specs/_spec-template.md](docs/superpowers/specs/_spec-template.md) and plans from [docs/superpowers/plans/_plan-template.md](docs/superpowers/plans/_plan-template.md). Keep them concise, explicit, and ambiguity-free.

## Where to find things

- Cold-start handbook: [docs/ai/agents-handbook.md](docs/ai/agents-handbook.md)
- Right-now state: [docs/ai/work-state.md](docs/ai/work-state.md)
- Running TODO: [docs/ai/todo.md](docs/ai/todo.md)
- Global rules + testing policy: [docs/ai/global-rules.md](docs/ai/global-rules.md)
- Decisions: [docs/ai/decisions.md](docs/ai/decisions.md) -> [docs/adr/](docs/adr/)
- Active spec: [docs/superpowers/specs/](docs/superpowers/specs/)
- Plans (master index): [docs/superpowers/plans/README.md](docs/superpowers/plans/README.md)
- Long-form references: [docs/ai/references/](docs/ai/references/)
- Documentation model rationale: [docs/ai/references/agent-doc-model.md](docs/ai/references/agent-doc-model.md)

## Documentation rules

- Keep `AGENTS.md` files concise and task-routing focused.
- Move detail longer than ~10 lines into a reference file under `docs/ai/references/`.
- Do not duplicate rule blocks across `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CODEX.md`, or other agent files.
- One Markdown file owns each durable rule or behaviour. When content overlaps, keep the detail in the owner and link from elsewhere.
- Use repo-relative links for files inside this repository.
- **Documentation is agent-agnostic.** Body content uses "the agent" / "agents". Agent names appear only in `CLAUDE.md` / `GEMINI.md` / `CODEX.md` adapter files.

## Behavioral Rules

1. **Think before coding.** When a request is ambiguous, state assumptions and ask clarifying questions before writing code. Present multiple interpretations of vague requests.
2. **Simplicity first.** Write the minimum code that solves the problem. No speculative features, no abstractions for single-use code. If 200 lines could be 50, rewrite it.
3. **Surgical changes.** Every changed line must trace directly to the user's request. Don't refactor adjacent code, don't "improve" unbroken code, don't change formatting or style. Match existing conventions.
4. **Goal-driven execution.** For fixes: write a test that reproduces the bug first. For features: define verifiable success criteria before coding. Loop until verified. Never claim completion without evidence.

## Project-specific quick rules

- Language / runtime version: Node.js >=18
- Dependency manager: npm
- Testing policy: see [docs/ai/global-rules.md](docs/ai/global-rules.md)
- **Background processes:** When subagents need to run a long-lived process (dev servers, dashboards, databases), use `run_background_process` — never run them as foreground commands in a subagent, which causes hangs and timeouts. Subagents should only run quick commands (curl, node -c, file reads/writes) with short timeouts.
- **Port cleanup:** Before starting any server on a port, kill existing processes on that port first. Use `powershell -Command "Get-NetTCPConnection -LocalPort <port> -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`
- **Scheduler AI auth:** The scheduler pings Claude and Codex via CLI subprocesses, not API keys. Subscription-based accounts (Claude Pro, ChatGPT Plus) don't include API credits — the CLI uses OAuth from `claude login` / `codex login`. See [docs/ai/references/scheduler-ai-auth-setup.md](docs/ai/references/scheduler-ai-auth-setup.md) for credential setup, spawn rules, and testing. Debug history: [docs/diagnose/2026-06-05-claude-codex-scheduler-auth-fix.md](docs/diagnose/2026-06-05-claude-codex-scheduler-auth-fix.md).
- **Process spawn on Windows:** Never use `execFileSync` in server code — it blocks the event loop and kills timers. Use `spawn` with explicit `stdio`. For `.cmd` wrappers, bypass them by calling the underlying `.js` file with `process.execPath`. For independent long-lived processes, use `cmd /c start` pattern. See diagnose docs for examples.
- **Temp files:** Use `.tmp/` as the single temp directory for all artifacts (logs, screenshots, test output, CLI output files). Do NOT create scattered temp dirs like `test-screenshots/`, `.test-screenshots/`, `.test-scripts/`. All are gitignored.
