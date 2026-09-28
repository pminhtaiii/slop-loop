# Feature Specification: Policy Engine and Capabilities

**Feature Branch**: `feat/004-policy-engine-capabilities`
**Created**: 2026-09-28
**Status**: Draft for review
**Input**: Phase 3 in the progress tracker, ADR 0001/0005/0006/0007/0008, and the developer's architecture grilling decisions.

## User Scenarios & Testing

### User Story 1 - Only authorized tool calls execute (Priority: P1)

A developer starts a task in Ask or Edit mode. For each agent-requested tool call, Slop Loop uses the task's sealed maximum authority and current trusted facts to decide whether the call may reach an executor. A listed or model-visible tool is not automatically authorized.

**Why this priority**: Preventing unauthorized execution is the Phase 3 exit gate.

**Independent Test**: With a fake executor, submit valid, unknown, malformed, wrong-mode, missing-capability, and policy-failure calls; only explicit allows invoke the executor.

**Acceptance Scenarios**:

1. **Given** a registered call within the task ceiling and current policy, **when** the gateway evaluates it, **then** exactly one selected fake executor invocation occurs.
2. **Given** an unknown, malformed, forbidden, or unsupported call, **when** it is dispatched, **then** no executor invocation occurs and a bounded reason is returned.
3. **Given** a failure in trusted authorization state, **when** policy cannot safely decide, **then** the task ends with `FAILED / POLICY_FAILURE` and no executor invocation.
4. **Given** two calls in one model response, **when** the first receives ordinary `DENY`, **then** later proposals in that response are discarded without dispatch or tool-attempt charge.

---

### User Story 2 - File authority stays narrow and current (Priority: P1)

An Edit task may use an exact developer-approved update or create grant only while its task ceiling permits the operation and trusted workspace facts still match. Repository reads require policy checks but no per-file developer prompt.

**Why this priority**: Session-level grant reuse must not turn into blanket or stale write authority.

**Independent Test**: Use a fake workspace boundary and grant ledger to compare approved, missing, forbidden, externally changed, and unavailable path facts without touching a real checkout.

**Acceptance Scenarios**:

1. **Given** an eligible Edit call with no exact path-operation grant, **when** it is evaluated, **then** it returns `NEEDS_FILE_PERMISSION` and performs no operation.
2. **Given** an exact valid grant, **when** another Edit task in the same open session requests that operation, **then** it may reuse the grant only if the new sealed ceiling and fresh repository facts allow it.
3. **Given** an external target change, **when** the grant is checked, **then** it remains invalid even if old bytes are restored; fresh authorization is required.
4. **Given** a validly evaluated forbidden path, **when** it is requested, **then** policy returns ordinary `DENY`; inability to produce trustworthy required path facts ends the task with `FAILED / POLICY_FAILURE`.

---

### User Story 3 - Tasks remain bounded and stoppable (Priority: P1)

The developer's chosen mode stays fixed for one task. Trusted budget policy bounds model turns, dispatched tool attempts, active work, and shared recovery retries. Explicit stop prevents new work and late results from continuing the task.

**Why this priority**: The existing Phase 1 runner still embodies superseded mode and step behavior, which must be reconciled before policy integration.

**Independent Test**: Use scripted time, model responses, and a fake executor to prove fixed mode, separate counters, sealed promotions, denial-loop termination, and stop fencing.

**Acceptance Scenarios**:

1. **Given** a task admitted in one mode, **when** a mid-task mode change is requested, **then** the task does not switch mode; the developer may stop it and start a later task in a new mode.
2. **Given** internal lifecycle events or human permission waiting, **when** budgets are measured, **then** neither is charged as a model turn or tool attempt, and human waiting does not consume active-work time.
3. **Given** a capacity threshold, **when** trusted promotion occurs, **then** it follows the admission-sealed schedule with cumulative usage and never increases the initially sealed shared retry ceiling.
4. **Given** exhausted verification/repair, model-recovery, or denial-recovery retries, **when** the runner would retry, **then** the task ends at its current profile without promotion.
5. **Given** a developer stop during a pending pre-execution append or executor call, **when** the append completes or a late result arrives, **then** no new executor starts or state transition occurs; the checkout slot releases only after local mutation is impossible and cleanup reaches `CANCELLED`.
6. **Given** terminal finite-budget exhaustion, **when** the task ends, **then** the developer receives a bounded handoff stating budget, limit, usage, work done, changed paths, verification state, unresolved work, and next steps.

---

### User Story 4 - Evidence and results stay safe (Priority: P2)

Each dispatched tool call leaves bounded canonical request and decision evidence before any executor invocation. Executor results are checked before audit representation or model context. Failure after an effect never causes the effectful operation to replay.

**Why this priority**: Authorization without evidence and safe result handling is not a usable tool boundary.

**Independent Test**: Use a fake audit sink and fake executor to assert event order, unavailable-sink zero-execution, idempotent result-append retry, oversized or invalid result handling, and preserved effect status.

**Acceptance Scenarios**:

1. **Given** a dispatched read, mutation, or verification call, **when** the canonical pre-execution append fails, **then** no executor runs and the task becomes `BLOCKED / AUDIT_UNAVAILABLE`.
2. **Given** an unknown or malformed dispatched call, **when** it is rejected, **then** bounded request identity and validation-decision evidence are recorded without raw arguments.
3. **Given** an effect followed by result-event append failure, **when** synchronous idempotent persistence retries fail, **then** further calls stop, the task reports `BLOCKED / AUDIT_INCOMPLETE`, and the executor is never replayed.
4. **Given** an invalid or oversized executor result, **when** it is handled, **then** raw output does not enter audit or model context and any completed or uncertain effect is reported separately.

### Edge Cases

- A model response can propose several calls; only calls individually dispatched to the gateway count as tool attempts. The first ordinary denial discards later proposals from that response.
- Reads receive no interactive file permission prompt, but still require current capability, workspace path policy, and canonical audit evidence.
- A file grant cannot add tools, switch mode, increase budgets, change workspace, or survive `/clear`, CLI exit, switching to Ask, or relevant repository drift.
- A policy exception, unavailable trusted budget state, or untrustworthy required path facts must never become `ALLOW`.
- An audit sink may commit an event but lose the acknowledgment; retry must detect the existing event rather than append a duplicate.
- A returned result can be invalid even when its executor already changed the checkout. Result failure cannot imply that no effect occurred.
- An active-work deadline can exhaust at Small or Medium; its handoff is still required.

## Requirements

### Functional Requirements

- **FR-001**: Every individually dispatched agent tool request MUST pass one mandatory gateway before any executor; the application MUST NOT expose direct executor invocation to outside modules.
- **FR-002**: The gateway MUST validate or revalidate the registered call and use one trusted, complete tool-definition source for capability and effect metadata. Model-visible selection MUST NOT authorize invocation.
- **FR-003**: Admission MUST seal task/session and workspace identity, fixed task mode, eligible tools/capability classes, resource limits, initial budget profile, permitted promotion schedule and triggers, cumulative accounting, Large maximum, and the initial profile's shared recovery-retry ceiling.
- **FR-004**: A later grant MUST NOT expand the sealed task ceiling. Exact update/create permissions MUST be held separately and rechecked on every relevant call.
- **FR-005**: The gateway MUST assemble a fresh, invocation-scoped trusted decision context and MUST NOT reuse it for another call or session. Policy evaluation MUST remain side-effect-free and default to denial.
- **FR-006**: Policy outcomes MUST distinguish `ALLOW`, `NEEDS_FILE_PERMISSION`, and ordinary `DENY`; internal authorization failure or unavailable required trusted authority facts MUST stop the task as `FAILED / POLICY_FAILURE`.
- **FR-007**: Path-sensitive decisions MUST consume trusted canonical repository-relative facts from a workspace-boundary contract. This phase MUST NOT claim real canonicalization, symlink, or containment enforcement.
- **FR-008**: Reads MUST NOT require interactive per-file grants. Write grant reuse MUST be confined to the same open session and current task ceiling; external target change MUST invalidate the affected grant even after restoration to old bytes.
- **FR-009**: The runner MUST fix mode for one task, permit only one in-flight tool call per task, and retain an active checkout slot during permission wait and until safe terminal cleanup after stop.
- **FR-010**: Model turns and individually dispatched tool attempts MUST be counted separately; internal lifecycle events MUST consume neither. Invalid, unknown, and denied dispatched calls MUST count as attempts; undispatched proposals MUST NOT.
- **FR-011**: Trusted promotion MAY increase only model-turn and tool-attempt capacity along the sealed schedule, with cumulative usage and no active-work-clock reset. It MUST NOT increase the admission-time shared retry ceiling.
- **FR-012**: Verification/repair, model-recovery, and denial-recovery retries MUST share one bounded counter with recorded reason. Its exhaustion MUST end the task at the active profile without promotion or similarity heuristics.
- **FR-013**: Active-work time MUST exclude developer-input waits. Stop MUST block new turns/calls, atomically fence executor start after awaited checks or audit append, abort in-flight work where supported, fence late results, and release the checkout slot only after mutation is impossible and cleanup reaches `CANCELLED`.
- **FR-014**: Any terminal `BUDGET_EXHAUSTED` MUST produce a bounded developer-facing handoff with budget, limit, usage, objective, completed actions, changed paths, verification state, blockers, stop reason, and remaining steps. It MUST confer no continuation authority.
- **FR-015**: Every dispatched model tool request, including malformed or unknown requests, MUST have bounded canonical request/decision evidence without raw arguments. Successful pre-execution append MUST precede every executor invocation, including read-only calls.
- **FR-016**: Audit unavailability or pre-execution append failure MUST produce `BLOCKED / AUDIT_UNAVAILABLE` and zero executor calls. Audit evidence MUST NOT be an input to policy authorization.
- **FR-017**: Result-event persistence retries after a possible effect MUST be synchronous, finite, and idempotent by stable event identity; no executor replay or background recovery is permitted. Unconfirmed persistence MUST stop further dispatch as `BLOCKED / AUDIT_INCOMPLETE` and report actual or possible effects.
- **FR-018**: Executor results MUST pass output-contract validation, size bounds, normalization, sanitization, and redaction before canonical audit representation or model context. An invalid result after an effect MUST not cause re-execution or hide the effect.
- **FR-019**: Phase 3 MUST prove routing and failures with fake workspace, grant, executor, and audit adapters. Real path resolution, mutation adapters, sandbox execution, Git-state enforcement, and canonical JSONL persistence remain later-phase integrations.

### Key Entities

- **Task capability ceiling**: Admission-sealed maximum authority and trusted promotion schedule.
- **Policy decision context**: Current trusted facts assembled only for one dispatched call.
- **Policy decision**: Explicit allow, permission-needed, or denial plus bounded reason.
- **File grant**: Session-scoped exact canonical path and update/create operation, subject to invalidation.
- **Budget state**: Separate model-turn, dispatched tool-attempt, active-work, and shared retry accounting.
- **Audit evidence**: Bounded request/decision and result records correlated to one call.
- **Budget handoff**: Developer-facing summary after terminal budget exhaustion, never an authority token.

## Success Criteria

### Measurable Outcomes

- **SC-001**: In the adversarial fixture suite, 100% of unknown, malformed, wrong-mode, missing-capability, forbidden-path, unavailable-facts, and policy-exception calls make zero executor calls.
- **SC-002**: In every fake-executor scenario, execution occurs only after an explicit allow and a successfully recorded canonical pre-execution event.
- **SC-003**: All scripted stop and late-result cases cause zero later mutation and release the active checkout slot only after safe cleanup.
- **SC-004**: Budget fixtures distinguish model turns, dispatched attempts, internal events, waits, promotions, and shared retries, with no retry ceiling increase after promotion.
- **SC-005**: Every terminal finite-budget fixture emits a handoff with its stop budget, limit, observed usage, and required task summary fields.
- **SC-006**: Audit-outage and result-failure fixtures produce no duplicate executor calls or duplicate events.

## Assumptions

- The current Phase 1 runner is implemented but must be reconciled with ADR 0006 and ADR 0007 before integration. Phase 2 registry source is planned rather than implemented in this checkout; its validated-call interface is an integration prerequisite.
- Phase 3 uses fake trusted boundaries to prove authority flow. Phase 4 supplies real workspace/path facts; Phase 7 supplies actual grant and patch mechanics; Phase 12 supplies the canonical JSONL writer. Phase 3 completion does not claim those later integrations.
- The MVP session stays in memory while the CLI process is open and may contain multiple tasks. Ended sessions are not reopened; canonical audit evidence is not restorable conversation history.
- A hard executor-output capture limit before in-memory parsing, an internal contract-failure outcome after an effect, idempotent audit append semantics, and staged completion of real tool contracts are planning assumptions to resolve in the design artifacts.
