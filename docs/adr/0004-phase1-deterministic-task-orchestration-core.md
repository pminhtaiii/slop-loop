# Keep task orchestration deterministic and system-owned

Status: accepted.

Phase 1 adds a task domain and an in-memory orchestrator to the TypeScript application established in ADR 0003. The orchestrator owns a task's identity, immutable objective and intent, developer-selected `Ask` or `Edit` mode, lifecycle state, budget, usage, and typed terminal outcome. This boundary exists so later model and tool adapters can propose work without deciding their own state, authority, or execution limits.

State changes follow a declared transition graph. Invalid internal transitions fail the task without entering the requested state; invalid model proposals are refused and charged as steps, allowing a permitted route to continue. `COMPLETED`, `FAILED`, `BLOCKED`, and `CANCELLED` seal the task. Only a trusted developer event changes mode: `Edit` to `Ask` pauses Edit work, and returning to `Edit` resumes at inspection with earlier verification invalidated. The task's objective, intent, and consumed budget do not reset.

Admission freezes a system-owned budget, defaulting to 30 agent steps, three retries, and 900 seconds for the whole task, including paused time. Each automatic event consumes a step; explicit retries also consume retry capacity. Exhaustion produces `FAILED / BUDGET_EXHAUSTED` with the exhausted resource and counts. A changed Edit task completes only after a passing verification result for its current attempt; a no-change task may complete with verification marked `NOT_RUN`.

The Phase 1 runner processes scripted events and injected time in memory. Unit and scripted lifecycle tests cover legal and illegal transitions, mode changes, retries, deadlines, terminal sealing, and completion evidence. Phase 0 supplies the Node.js, TypeScript, test, build, and CI foundation needed to validate this module in the application. Phase 1 does not wire the runner into `src/index.ts` and does not implement a model provider, real tools, file permissions, Docker, Git, CLI, or persistent audit evidence. A later runtime must schedule real deadline checks and bound external calls; the in-memory runner alone cannot interrupt an idle or hung external operation.

The feature contract and verification steps are in `specs/002-task-domain-orchestrator/`; `coding-agent-context/context/progress-checker.md` remains the source of truth for completion status.
