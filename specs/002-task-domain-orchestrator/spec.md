# Feature Specification: Task Domain and Orchestrator

**Feature Branch**: `feat/002-task-domain-orchestrator`

**Created**: 2026-09-25

**Status**: Plan approved; Phase 0 source merged locally; Phase 1 core implemented; combined pinned-manager gate pending

**Input**: Phase 1 product-level Task Domain & Orchestrator from `coding-agent-context/context/progress-checker.md`, refined by the developer's Phase 1 design decisions.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Track one task through legal states (Priority: P1)

As a developer, I can start one task with a stable identity and objective and see an accurate state as it progresses through an Ask or Edit workflow. The system refuses impossible jumps, never skips admission, and never continues a terminal task.

**Why this priority**: Every later agent capability depends on a trustworthy task lifecycle.

**Independent Test**: Feed a task a valid sequence for each mode and an invalid transition; verify the valid states are reachable, the invalid target state is never entered, and a terminal task remains sealed.

**Acceptance Scenarios**:

1. **Given** a newly received task, **When** it is admitted and inspected, **Then** its identity and objective remain stable and its state follows the declared path.
2. **Given** a task in `RECEIVED`, **When** the system attempts to enter `IMPLEMENTING`, **Then** the task ends `FAILED / INVALID_TRANSITION` without entering `IMPLEMENTING`.
3. **Given** a terminal task, **When** any action is proposed, **Then** the action is rejected and the existing outcome is preserved.

---

### User Story 2 - Stop autonomous work within finite limits (Priority: P1)

As a developer, I can rely on the task runner to stop autonomous work when its step, retry, or elapsed-time budget is reached, including a loop of rejected actions or retries.

**Why this priority**: A coding agent must not keep consuming resources or attempting actions indefinitely.

**Independent Test**: Feed a nonterminal task a repeated sequence of otherwise legal actions and retries; verify it reaches a typed budget outcome within the configured limit, while a valid completion on the last allowed step succeeds.

**Acceptance Scenarios**:

1. **Given** a task that keeps processing events, **When** it needs a step beyond its limit, **Then** it ends `FAILED / BUDGET_EXHAUSTED` and names the exhausted budget, limit, observed use, and attempted use.
2. **Given** three allowed retries, **When** a fourth retry is requested, **Then** no retry runs and the task ends `FAILED / BUDGET_EXHAUSTED`.
3. **Given** a valid completion on the final allowed step, **When** that step is processed before the time deadline, **Then** the task completes.
4. **Given** the task deadline has arrived, **When** the runner checks the task, **Then** the task ends with a time-budget outcome even if it was paused waiting for the developer.

---

### User Story 3 - Change mode without expanding the task (Priority: P1)

As a developer, I can switch the current task between Ask and Edit without changing its objective or resetting its budget. Switching from Edit to Ask pauses Edit work; switching back requires fresh inspection and permission checks before any future edit. The future permission subsystem revokes existing grants on the switch to Ask.

**Why this priority**: The developer controls mode and file authority, while a mid-task question should not silently authorize or discard work.

**Independent Test**: Switch an in-progress Edit task to Ask and back; verify its identity, objective, and budget are preserved, Edit work does not run in Ask, and the resume path cannot bypass permission revalidation.

**Acceptance Scenarios**:

1. **Given** an Edit task in progress, **When** the developer switches to Ask, **Then** the task enters `PAUSED_FOR_MODE` and cannot perform Edit work.
2. **Given** a paused task, **When** the developer returns to Edit, **Then** work resumes through a guarded path and prior file permissions are unavailable.
3. **Given** a task whose trusted intent is informational and whose objective is to explain a defect, **When** the developer requests Edit, **Then** the switch is refused; a new request to fix the defect starts a new task.
4. **Given** an unfinished task, **When** an event attempts to replace its objective, **Then** the runner rejects that event; a later session controller will enforce one unfinished task per session.
5. **Given** an Edit task with a previous passing verification result, **When** it enters repair or resumes Edit after a pause, **Then** that result cannot authorize completion of subsequent changes.

---

### User Story 4 - Report truthful outcomes and recoverable refusals (Priority: P2)

As a developer, I can distinguish completed, failed, blocked, cancelled, and budget-exhausted work, and see whether a rejected model proposal affected the task or only that proposed action.

**Why this priority**: A coding agent must report what happened without claiming success for failed verification or treating every invalid proposal as fatal.

**Independent Test**: Exercise success, no-change, failed verification, policy denial, cancellation, and invalid proposals; verify the state/outcome pair and whether the task may continue.

**Acceptance Scenarios**:

1. **Given** a model proposal invalid for the current state, **When** it is evaluated, **Then** the proposal is rejected before any state change, consumes a step, and may be corrected within budget.
2. **Given** one denied action with a remaining authorized path, **When** it is evaluated, **Then** only that action is denied and the task may continue.
3. **Given** an Edit task with no change needed, **When** the system accepts a supported no-change conclusion, **Then** the task ends `COMPLETED / NO_CHANGE_NEEDED` without claiming verification occurred.
4. **Given** an Edit task with changes and failed required verification, **When** no allowed recovery remains, **Then** the task ends `FAILED` and reports the actual verification result.
5. **Given** an unfinished task, **When** the developer explicitly cancels it, **Then** it ends `CANCELLED` and cannot run again.

### Edge Cases

- A model proposal is not a direct state-transition command. Invalid proposals are rejected before changing the task; an invalid transition attempted by trusted orchestration is a fatal internal failure.
- A policy denial does not itself prove the whole task is blocked. `BLOCKED / POLICY_DENIED` applies only when the objective has no permitted path.
- Completion on the final allowed step succeeds; a step requested after the limit does not execute.
- A task can pause for a mode switch or future human permission, but its finite task deadline keeps running. The Phase 1 runner uses simulated time; a real timer is a later integration responsibility.
- Developer mode changes and progress questions do not consume agent steps, and never extend the task deadline.
- Switching modes cannot revive a terminal task or restore revoked file permissions.
- Only one unfinished task exists in a session; unrelated work requires ending the current task first.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST create a task context with a stable task identity, immutable objective and trusted intent (`INFORMATIONAL` or `CHANGE`), current developer-selected mode, current state, system-owned budget and usage, and an optional terminal outcome.
- **FR-002**: The system MUST admit a task before any inspection, answering, planning, mutation, verification, or review state.
- **FR-003**: The system MUST define and enforce the full Ask/Edit task-state graph, including `PAUSED_FOR_MODE` and terminal states `COMPLETED`, `FAILED`, `BLOCKED`, and `CANCELLED`.
- **FR-004**: The system MUST reject an invalid model proposal before any state change and count its processing as an agent step.
- **FR-005**: The system MUST end an active task as `FAILED / INVALID_TRANSITION` if trusted orchestration attempts an illegal transition, without recording the illegal target state.
- **FR-006**: The system MUST preserve the state and outcome of any terminal task against later requests.
- **FR-007**: The system MUST bound autonomous task processing by agent steps, retries, and elapsed task time, with limits fixed at admission and unavailable for model modification.
- **FR-008**: The initial limits MUST follow the architecture baseline: 30 agent steps and 900 seconds per task, plus a separate maximum of three general retries per task. Later tool and patch limits remain reserved for their owning phases.
- **FR-009**: Each autonomous runner cycle, including rejected proposals and explicit retries, MUST consume one agent step. Each explicit retry MUST also consume one retry allowance; the runner MUST NOT retry automatically.
- **FR-010**: A final allowed step MAY complete the task. A request that exceeds a limit MUST NOT run and MUST produce `BUDGET_EXHAUSTED` with budget kind, configured limit, observed use, and attempted use.
- **FR-011**: The developer MUST be able to change the current task mode without changing its identity, objective, budget limits, or accumulated usage.
- **FR-012**: Entering Ask from an active Edit flow MUST pause Edit work; returning to Edit MUST use a guarded resume path through inspection and a fresh permission event before any future mutation. The future permission subsystem MUST revoke prior grants on the switch to Ask.
- **FR-013**: A mode switch alone MUST NOT change the task objective or intent. An informational task MUST refuse a switch to Edit; an Ask task with trusted change intent MAY switch to Edit for that same objective.
- **FR-014**: The Phase 1 runner MUST keep one task context and reject an event that attempts to replace its objective. Informational questions about that task do not create a new task or spend agent steps. The later session controller MUST enforce one unfinished task per session.
- **FR-015**: The model MAY propose completion, but only trusted orchestration MAY accept it after checking the legal state, budget, and required evidence for that path.
- **FR-016**: An Edit task with changes MUST NOT end `COMPLETED` unless its required verification passed for the current change attempt. Repair or Edit resumption MUST invalidate any earlier passing result. An Edit task MAY end `COMPLETED / NO_CHANGE_NEEDED` from an authorized early-exit state without claiming unrun checks passed.
- **FR-017**: The system MUST distinguish terminal state from typed outcome reason. A denied action MAY leave the task active; `BLOCKED / POLICY_DENIED` applies only when no permitted path remains.
- **FR-018**: Explicit developer cancellation MUST end an unfinished task in `CANCELLED`, while preserving already completed external changes for later phases to report.
- **FR-019**: Phase 1 MUST exercise task transitions and budget exhaustion with deterministic events without invoking a model, tool, filesystem, Git, sandbox, CLI, or audit persistence.

### Key Entities

- **Task context**: One objective with stable identity, current mode and state, budget limits and use, pause checkpoint, and terminal outcome.
- **Task state**: One stage in the legal Ask/Edit lifecycle or one terminal state.
- **Task budget**: System-controlled finite limits for autonomous steps, retries, and elapsed time.
- **Task event**: A proposed action or trusted lifecycle signal evaluated by the runner; its origin determines whether a refusal is recoverable or fatal.
- **Terminal outcome**: The final state plus typed reason and bounded evidence about completion, failure, blocking, cancellation, or exhaustion.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every declared legal Ask/Edit path reaches a terminal state or a bounded pause in deterministic scenarios; 100% of tested illegal transitions are prevented.
- **SC-002**: Every scripted autonomous sequence processes at most 30 agent steps and three retries; a clock-driven check at the 900-second deadline terminalizes any waiting or paused task.
- **SC-003**: 100% of terminal-state replay scenarios preserve the original terminal outcome.
- **SC-004**: 100% of tested mode switches preserve task identity, objective, and accumulated usage, and none permits Edit work while the current mode is Ask.
- **SC-005**: Every budget-exhaustion scenario reports the exhausted budget, its limit, observed usage, and attempted usage; a valid completion at the last permitted step remains successful.
- **SC-006**: Every tested completion with changed files has passing required-verification evidence for the current change attempt; repair and Edit resumption cannot reuse earlier passing evidence. No-change completion reports that verification was not run when applicable.

## Assumptions

- Phase 0 application runtime and quality gates must pass before Phase 1 implementation is integration-ready. The Phase 1 specification and plan may be prepared now.
- Phase 1 uses deterministic events and simulated time to prove domain-loop and budget rules. Real timers, tool calls, and verification evidence arrive in later phases.
- The task objective is fixed at task creation. A new objective is a new task, even inside the same session.
- The architecture's remaining initial limits are 60 tool calls, three patch attempts, 120 seconds per tool call, and 65,536 bytes of tool output. Their enforcement belongs to the later tool, patch, and execution phases.
- This feature adds no model, file, network, command, Git, sandbox, CLI, or audit capability.
