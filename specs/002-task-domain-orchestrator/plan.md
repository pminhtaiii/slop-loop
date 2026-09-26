# Implementation Plan: Phase 1 Task Domain and Orchestrator

**Branch**: `feat/002-task-domain-orchestrator` | **Date**: 2026-09-25 | **Spec**: [spec.md](./spec.md)

**Input**: Phase 1 specification and the developer-approved design decisions recorded in [research.md](./research.md).

**Approval gate**: The developer approved this plan and chose a dedicated Phase 1 branch in the current checkout. The developer subsequently requested Phase 1 TypeScript implementation before the Phase 0 exit checks. That explicit override permits isolated Phase 1 code and tests now; integration readiness still requires Phase 0 and the full quality gate.

## Summary

Create the isolated orchestration module before Phase 0 integration under the developer's explicit approval. It owns one task's identity, immutable objective, current mode, legal lifecycle state, finite budget, pause checkpoint, and typed outcome. A deterministic in-memory runner processes scripted events, refuses model proposals that are invalid in the current state, fails on illegal internal transitions, and stops at a finite budget. No model, real tool, Docker, filesystem, Git, CLI, or audit persistence is introduced.

## Technical Context

**Language/Version**: TypeScript in strict mode on Node.js 24 LTS, native ESM

**Primary Dependencies**: Existing Zod 4 for strict runtime boundary values; standard library for time/immutability; no new dependency

**Storage**: In-memory task snapshots only

**Testing**: Vitest unit tests for state, outcome, budget and retry boundaries; a deterministic source-level lifecycle E2E test; existing pnpm quality gates after Phase 0

**Target Platform**: Windows developer checkout and Ubuntu CI, under the Phase 0 single-process application

**Project Type**: Private single-package application; a real orchestration module within the modular monolith

**Performance Goals**: A finite scripted lifecycle returns after no more than its configured step count; no external latency goal is claimed for Phase 1

**Constraints**: `maxAgentSteps=30`, `maxRetries=3`, `maxTaskSeconds=900` by default; task deadline includes paused time; no autonomous budget increases; no provider or privileged adapter; no session scheduler or real timer yet

**Scale/Scope**: One task instance per runner; one unfinished task per session is a future session-controller invariant. Four focused production files and five focused test files are expected after approval.

## Constitution Check

The repository constitution is an unfilled template and adds no operative gate. The governing documents are `CONTEXT.md`, the context pack, and ADR 0003. Pre-design and post-design review both **pass for documentation** with these constraints:

- Phase 0 is complete on `development` and its source is present in this checkout. The combined branch still needs the full pinned-manager quality gate before Phase 1 is integration-ready.
- This plan adds a real orchestration boundary only when its behavior is implemented. It does not change the private TypeScript, native ESM, single-process decision in ADR 0003.
- The model never owns state, mode, budget, capabilities, or authorization. Phase 1 only simulates later trusted events.
- The tool, file permission, sandbox, audit, and CLI decisions in tool policy and ADRs 0001–0002 remain later-phase work.
- The mandatory scope → context → design → threat review → plan → TDD → verify → security convergence → dual-axis review → context sync workflow applies when implementation is approved.

## Project Structure

### Documentation (this feature)

```text
specs/002-task-domain-orchestrator/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── orchestrator.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (Phase 0 runtime and Phase 1 domain core)

```text
src/
├── config.ts
├── logging.ts
├── index.ts
└── orchestration/
    ├── task.ts          # TaskContext, mode/state/outcome types and admission
    ├── transitions.ts   # Legal graph and guarded state changes
    ├── budget.ts        # Defaults, validation, accounting and exhaustion evidence
    └── runner.ts        # Bounded deterministic event loop

tests/
├── config.test.ts
├── logging.test.ts
├── smoke.test.ts
└── orchestration/
    ├── task.test.ts
    ├── transitions.test.ts
    ├── budget.test.ts
    ├── runner.test.ts
    └── runner.e2e.test.ts
```

**Structure Decision**: The `orchestration/` directory appears with its first real behavior. No speculative policy, tool, repository, sandbox, model, audit, or session directory is created. Phase 1 does not wire `src/index.ts` to the runner.

## Domain Design

1. **Task creation and admission**: The trusted application layer supplies a nonempty task ID, bounded objective, trusted `INFORMATIONAL`/`CHANGE` intent, and developer-selected `Ask`/`Edit` mode. The task starts `RECEIVED`; admission fixes the system-owned budget and deadline. Task snapshots are returned immutably. A new objective or intent requires a new task.
2. **State reducer**: `TaskState` contains the complete architecture graph plus `PAUSED_FOR_MODE` and `CANCELLED`. `transitions.ts` declares legal edges and mode guards. Normal success is reachable only from `ANSWERING` for Ask, `REVIEWING` after passing verification for changed Edit work, or `INSPECTING`/`PLANNING` for trusted `NO_CHANGE_NEEDED`. Any active state can terminalize with a matching typed fatal, blocked, or cancellation outcome. Terminal snapshots never change.
3. **Mode change**: Only trusted developer events change mode. Edit→Ask records `pausedFrom` and enters `PAUSED_FOR_MODE`. Ask→Edit resumes through `INSPECTING`, so later mutation must traverse planning and permission stages again. The future permission subsystem must revoke grants on Edit→Ask; Phase 1 does not implement grants. A same-objective Ask→Edit transition may enter `PLANNING` only for a task with trusted `CHANGE` intent. An informational task refuses Edit mode.
4. **Budget accounting**: Defaults are 30 automatic steps, three general retries, and a 900-second total task deadline. Every autonomous runner cycle, including rejected model proposals and explicit retries, charges one step; developer mode switches and progress reads do not. Retry is explicit, never automatic. A consumed retry sets a one-use internal marker required for the `REPAIRING` transition. Before processing, the runner checks time, step capacity, then retry capacity. A last allowed step may complete. Exhaustion captures resource kind, limit, used, and attempted counts. Tool-call, patch-attempt, single-tool-time, and output-byte budgets are documented architecture defaults and integrated in their later phases.
5. **Event origin and error behavior**: A model proposal names an intended action or completion, not a target state. The model-facing entry point validates unknown input with a strict closed schema before constructing a model event; it cannot construct trusted or developer events. `PLAN` may advance a change-intent task from inspection to planning; `IMPLEMENT` is not a model action in Phase 1 because no permission or tool adapter exists. A refused proposal returns a bounded typed reason and leaves state unchanged. Results expose old/new state and usage. A trusted reducer request for an illegal edge terminalizes `FAILED / INVALID_TRANSITION` without recording the illegal state. A single policy denial is a refused action; `BLOCKED / POLICY_DENIED` is reserved for a task with no allowed route.
6. **Completion evidence**: Phase 1 fixtures represent trusted verification and no-change conclusions. The reducer remembers bounded verification status for the current change attempt so `REVIEWING → COMPLETED` requires a fresh pass. `FAILED / VERIFICATION_FAILED` requires a recorded failed check. Repair, a new implementation attempt, or Edit resumption clears an earlier pass. Reason-specific outcome validation rejects invented passing evidence. Actual verification results and audits arrive in later phases.
7. **Termination guarantee**: The runner loops over a finite budget and accepts only bounded scripted events. A controllable clock proves deadline behavior, including pauses. It cannot interrupt a future hung external call or wake itself while idle; the future runtime must schedule clock checks and enforce per-tool timeouts. The Phase 1 exit gate is a domain-loop guarantee, not a claim of integration readiness.

The exhaustive state transitions and input/output semantics are in [data-model.md](./data-model.md) and [contracts/orchestrator.md](./contracts/orchestrator.md).

## Threat Review

| Question | Phase 1 answer and test |
| --- | --- |
| New capability | State and budget decisions only; no privileged sink. Assert no model/tool/filesystem/Git/sandbox import or invocation. |
| Model-controlled data to a sink | Model proposals are validated data and cannot name target state, mode, budget, permission, or executable action. Reject malformed proposals without mutation. |
| Path traversal or symlink escape | No path input or filesystem operation exists in Phase 1; Phase 4/7 own those tests. |
| Command injection | No command execution exists; no arbitrary command field in the contract. |
| Secret exposure | Objective remains in memory; outcomes and refusals carry bounded reason metadata, not raw objective or exception stacks. |
| Repository content changes policy | No repository input exists; mode and budget come only from trusted events. |
| Security component crash | Unexpected trusted transition error becomes typed `FAILED / INVALID_TRANSITION` or `INTERNAL_ERROR`; no later work runs. |
| Execution bound | Step, retry, and time checks stop processing; tests cover final-allowed and first-disallowed operations. |
| Auditability | Each reducer result exposes old/new state, decision, usage, and reason for later audit adapters; no canonical audit persistence is claimed. |
| Boundary proof | Negative unit tests, a mode-switch and permission-gate script, budget-exhaustion tests, and a full scripted lifecycle E2E test. |

## Verification Strategy

- **RED**: Add one behavior/boundary test before each implementation slice. Run the focused Vitest file and record the expected failure caused by missing behavior, not by an unrelated environment error.
- **GREEN**: Implement only the behavior needed for that test; rerun the focused file.
- **REGRESSION**: Run `pnpm test` after each coherent slice. After completion, run lint, format check, typecheck, tests, build, and smoke.
- **Boundary cases**: Invalid internal edge, invalid model proposal, terminal replay, mode switch and pause, permission-gate traversal, off-by-one step/retry limits, time expiry while paused, cancellation, no-change completion, stale verification after repair/resumption, and failed verification.
- **Lifecycle E2E**: Use scripted events to prove Ask completion, Edit completion after trusted verification, Edit→Ask→Edit reinspection, and budget exhaustion. This satisfies the code-standard E2E requirement for an orchestrator state change without claiming real adapters exist.
- **Security convergence and review**: Compare implementation with the state contract, context tool policy, threat review, and acceptance scenarios; run separate standards/security and spec reviews; update `progress-checker.md` only when behavior and required checks really exist.

## Dependency and Approval Gates

1. **Phase 0 integration prerequisite**: The Phase 0 runtime and its standalone CI gate are complete on `development` and merged into this checkout. Run all six pinned pnpm exit commands on the combined branch before calling Phase 1 integration-ready.
2. **Developer approval**: The developer approved this plan and chose the dedicated `feat/002-task-domain-orchestrator` branch in the current checkout. No isolated worktree is required for the approved arrangement.
3. **Implementation**: The developer authorized the isolated Phase 1 RED → GREEN work recorded in [tasks.md](./tasks.md) before the Phase 0 gate. No Phase 0 runtime or package script was added as part of that override.

**Local verification note**: Windows Application Control blocks the pinned pnpm 12.5.1 native executable. The current checkout's lockfile has a pnpm 12 package-manager document plus a dependency document, which pnpm 10 cannot read together. For local tests only, pnpm 10.34.5 JavaScript was bootstrapped in ignored `node_modules/`; the dependency document was used temporarily for a frozen install and the tracked lockfile was restored byte-for-byte. The full pinned-manager gate remains unverified.

**Implementation verification**: Before this merge, the isolated Phase 1 suite passed 45 tests. After merging Phase 0, the combined checkout passes 98 tests, lint, source and test typechecks, build, compiled smoke, and Prettier with `--end-of-line auto` using the installed binaries directly. The pinned pnpm 12 executable is blocked on this Windows host. Plain Prettier check flags CRLF checkout line endings from `core.autocrlf=true`; the full pnpm-script gate remains open for the combined branch. T001 stays open until that gate passes.

## Complexity Tracking

| Added complexity | Why needed | Simpler alternative rejected because |
| --- | --- | --- |
| `PAUSED_FOR_MODE` state and checkpoint | The developer chose mid-task mode changes and Edit pause/resume | A separate pause flag makes illegal Edit work easier to miss |
| `CANCELLED` terminal state | Developer stop differs from failure and external blocking | Mapping cancellation to `BLOCKED` obscures outcome meaning |
| Distinct model proposal and trusted transition results | Allows coding-agent recovery while preserving a strict state machine | Fatalizing every invalid proposal destroys recoverable work |
