# Feature Specification: UC-04 Multi-Step Feature with Resume & Human-in-the-Loop

**Feature Branch**: `feat/004-multi-step-feature-resume`  
**Created**: 2026-10-19  
**Status**: Ready for Implementation  
**Owner**: Thanh Tan  
**Knowledge Areas**: K4 (Memory, State, and Context), K5 (Workflow and Human-in-the-Loop)  
**Authority Reference**: `context/state_and_memory.md`, `docs/progress-checker-matrices.md`, `docs/use-case-delegation.md`

---

## 1. Executive Summary & Problem Statement

In an autonomous coding agent, real-world development tasks span multiple files, tests, and stages. A naive agent loop keeps all progress in ephemeral memory (or in conversation context history). When the process crashes, times out, exceeds rate limits, or pauses for human review:
1. All progress is lost, forcing the agent to restart from scratch and repeat non-idempotent side effects (e.g., editing files, running tests).
2. Token budgets, cost allowances, and repair cycle limits are reset, allowing runaway financial and computational consumption.
3. If human approval is required for sensitive actions, the agent cannot cleanly pause, yield execution, and safely resume without risk of duplicate execution or stale repository state.

**UC-04 delivers a production-grade durable state, checkpointing, and recovery engine** for the slop-loop coding agent runtime. It guarantees that multi-step workflows can pause, survive real process termination, validate repository assumptions upon restart, reconcile uncertain side effects, bound cumulative budgets, compact long execution contexts, and resume seamlessly.

---

## 2. User Scenarios & Testing (Prioritized User Stories)

### User Story 1 - Multi-Step Task Execution with Step State Transitions and Durable Checkpointing (Priority: P1 - MVP)

As an engineer running the coding agent on a feature task,  
I want the agent to execute tasks broken down into sequential steps (`todo`, `doing`, `done`, `failed`) and persist structured checkpoints after every critical boundary,  
So that progress is always inspectable, auditable, and durable on disk.

- **Why this priority**: Without explicit step state and disk persistence, there is no foundation for resume, recovery, or auditability.
- **Independent Test**: Execute a 3-step task. Verify that state files on disk transition through `todo` -> `doing` -> `done` and that checkpoints contain full task state.
- **Acceptance Scenarios**:
  1. **Given** a new task with a 3-step plan, **When** step 1 starts, **Then** its state is marked `doing`, written atomically to disk, and a checkpoint is recorded.
  2. **Given** a step finishes with passing tests, **When** marked `done`, **Then** the checkpoint records changed files, verification results, and sets the next step to `todo`.
  3. **Given** a step fails, **When** marked `failed`, **Then** the error details are recorded in state without corrupting prior completed step evidence.

---

### User Story 2 - Process Termination and True Restart Recovery with Workspace Validation (Priority: P1 - MVP)

As an engineer whose agent process was abruptly killed (Ctrl+C, crash, container restart, OOM),  
I want to restart the agent process and have it resume from the exact interrupted state without repeating already completed steps,  
So that no duplicate work is performed and git work is not corrupted.

- **Why this priority**: The core requirement of UC-04 is that continuing in the same process is *not* recovery. Recovery must be demonstrated across actual OS process boundaries.
- **Independent Test**: Start a multi-step task, complete Step 1, kill the process with `SIGKILL` / `process.exit(1)`. Restart in a fresh Node process. Verify that Step 1 is NOT re-executed and execution picks up at Step 2.
- **Acceptance Scenarios**:
  1. **Given** a task halted after Step 1, **When** resumed in a brand-new runtime process, **Then** it loads the latest valid checkpoint, validates that git HEAD and workspace hashes match saved assumptions, and executes Step 2.
  2. **Given** the workspace was altered externally while the process was dead (files modified or deleted), **When** restart is attempted, **Then** the runtime flags `STALE_WORKSPACE_ASSUMPTIONS`, refuses blind re-execution, and halts safely for review.

---

### User Story 3 - Cumulative Budget Accounting & Interrupted Reservation Settle/Reconcile (Priority: P2)

As an engineering manager with budget controls,  
I want token usage, API cost, repair loop limits, and review iterations to be tracked across runs,  
So that restarting a task or spawning a new `runId` under the same `taskId` cannot bypass or reset consumption limits.

- **Why this priority**: Protects against infinite loops, runaway LLM API costs, and accidental quota draining during retries.
- **Independent Test**: Set a token limit. Complete step 1 consuming 60% of budget. Terminate process. Resume with a new run ID. Verify available budget is strictly 40%, and exceeding it throws `BudgetExhaustionError`.
- **Acceptance Scenarios**:
  1. **Given** a task budget ledger with 10,000 tokens, **When** an action reserves 3,000 tokens, **Then** available allowance drops to 7,000.
  2. **Given** a process crash occurs while a 3,000 token reservation is outstanding (before settlement), **When** recovered, **Then** the reservation remains charged as uncertain until explicitly reconciled with provider evidence.
  3. **Given** a task exhausts its repair budget, **When** a new run is initiated for the same task, **Then** the system refuses further repair actions unless explicit authorized budget override is provided.

---

### User Story 4 - Human-in-the-Loop Pause, Decision Binding, and Continuation (Priority: P2)

As a developer supervising the agent,  
I want the agent to pause before executing sensitive actions (e.g., executing commands outside sandbox, modifying protected configs, git push), persist the pending request, and resume only when explicit matching human approval is granted,  
So that risky operations are safely governed under Human-in-the-Loop (UC-05 integration).

- **Why this priority**: Required for safety, compliance, and integration with UC-05.
- **Independent Test**: Trigger a step requiring human approval. Verify the runtime pauses, persists `status: "waiting_approval"`, and shuts down. Restart with an approval decision; verify execution proceeds. Restart with a rejection; verify execution halts or adapts safely.
- **Acceptance Scenarios**:
  1. **Given** an action classified as `APPROVAL_REQUIRED`, **When** encountered, **Then** the agent creates an approval request, binds it to normalized action + repo HEAD + policy version, writes checkpoint, and pauses.
  2. **Given** approval is granted with a matching binding hash, **When** resumed, **Then** the action executes and transitions the step to `done`.
  3. **Given** git HEAD changed between approval request and resume, **When** resume is attempted, **Then** approval is marked `STALE_BINDING` and renewed approval is demanded.

---

### User Story 5 - Context Compaction & Durable Long-Term Repository Memory (Priority: P3)

As an agent operating over long multi-step workflows,  
I want conversation and tool traces to be compacted into a structured summary without losing critical goals, constraints, and current step state, and store enduring repo conventions in long-term memory,  
So that LLM context limits are not exceeded while maintaining exact adherence to requirements.

- **Why this priority**: Required for K4 (Memory, State, Context) completeness on long-running tasks.
- **Independent Test**: Feed 50 steps of verbose log history. Run compactor. Verify compacted output is within token limit and retains: `goal`, `constraints`, `acceptanceCriteria`, `completedWork`, `currentState`, `openRisks`, and `nextAction`. Verify long-term memory stores durable repository rules.

---

## 3. Edge Cases & Failure Modes

1. **Crash during atomic disk write**: Write to `.tmp` file and perform atomic rename with fsync (`atomicWrite`). Incomplete writes never overwrite the prior valid checkpoint.
2. **Out-of-order checkpoints**: Each checkpoint has a monotonically increasing `stateVersion`. Checkpoints with stale or conflicting versions are rejected.
3. **Workspace drift during downtime**: If git branch, commit hash, or touched file hashes differ between checkpoint and resume, fail fast with `WORKSPACE_DRIFT_DETECTED`.
4. **Uncertain non-idempotent side effects**: If a patch was applied or command ran before crash, resume inspects actual filesystem evidence rather than blindly re-running.

---

## 4. Functional Requirements (FR)

- **FR-001**: System MUST maintain structured Task State containing: `taskId`, `runId`, `taskType`, `goal`, `acceptanceCriteria`, `constraints`, `plan` (with step list), `currentStepId`, `changedFiles`, `verificationStatus`, `budgetLedgers`, and `status`.
- **FR-002**: Every plan step MUST possess one of four canonical states: `todo`, `doing`, `done`, `failed`.
- **FR-003**: System MUST persist checkpoints at all lifecycle boundaries: plan creation, step start, step completion, test execution, approval request, and recovery.
- **FR-004**: Checkpoints MUST be written using atomic file operations (`writeFile` to temp file + `fsync` + `rename`) to prevent partial or corrupted writes upon power loss or crash.
- **FR-005**: Resume MUST restore state from the latest valid checkpoint across independent Node.js process invocations.
- **FR-006**: Resume MUST validate repository assumptions (Git HEAD commit, clean/dirty working tree status, expected touched file hashes) before permitting next action.
- **FR-007**: System MUST maintain cumulative budget ledgers across runs: `tokens`, `cost`, `repairCycles`, `reviewerIterations`.
- **FR-008**: System MUST support atomic two-phase budget reservations (`reserve` -> `settle` or `reconcileUncertain`).
- **FR-009**: Interrupted reservations MUST remain charged upon process restart until verified by external provider evidence.
- **FR-010**: System MUST integrate Human-in-the-Loop pause: suspend execution on `APPROVAL_REQUIRED`, persist approval binding hash (`actionDigest + repoCommit + policyVersion`), and resume upon explicit approval.
- **FR-011**: Resumption MUST invalidate approvals if the repository state or policy version has drifted since the approval request was created.
- **FR-012**: System MUST provide context compaction extracting canonical summary fields: `goal`, `constraints`, `completedSteps`, `currentState`, `openRisks`, `nextAction`.
- **FR-013**: System MUST provide an advisory Long-Term Memory store (`conventions`, `toolConfigurations`, `repositoryConstraints`) that persists across separate tasks.
- **FR-014**: Long-Term Memory MUST be strictly advisory and validated against repository facts before use; it MUST NOT override observed repository evidence.
- **FR-015**: LangGraph orchestrator MUST interface with the durable checkpointer via a custom `DurableFileCheckpointer` complying with LangGraph's checkpointer interface.
- **FR-016**: Trace logs and diagnostic events MUST be stored separately from authoritative task state and checkpoints.

---

## 5. Success Metrics

- **100% Restart Recovery**: Zero lost tasks or corrupted state files across process restarts in automated tests.
- **Zero Duplicate Non-Idempotent Executions**: Completed steps are guaranteed never to re-run after restart.
- **Strict Budget Invariance**: Cumulative token and cost limits are enforced across arbitrary number of process restarts.
- **Zero Stale Approvals Executed**: 100% rejection rate for approvals executed against drifted repository workspaces.
