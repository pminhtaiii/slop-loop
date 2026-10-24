# Feature Specification: UC-04 — Multi-step Feature with Resume

**Feature Branch**: `feat/037-uc04-recovery-spec`

**Created**: 2026-10-21 (Asia/Saigon)

**Status**: T001–T012 are authorized under G-AUTH/G-EXTENSION; implementation and verification remain separate states. Thanh Tan owns UC-04. The user relayed his request to help write the spec at 12:28 on this date; this delegates authoring, not new contract agreement. See [decisions](contracts/decisions.md).

**Input**: Specify durable task/step state, checkpoints, cumulative allowances and safe continuation. First deliver the controlled pause/recovery foundation from ADR-0007; integrated feature workflow and cross-task repository memory remain later phases.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Recover progress without repeating completed work (Priority: P1)

As a developer, I want an interrupted multi-step task to retain its goal and progress and continue from an evidenced safe point.

**Why this priority**: Durable progress underpins every later workflow.

**Independent Test**: Actually terminate a scripted multi-step task after a completed step; restore a new process from retained durable state with controlled external seams.

**Acceptance Scenarios**:

1. **Given** repository/workspace identity, goal, criteria, constraints, steps and required checks, **When** input is admitted, **Then** preserve it; missing or incompatible records admit no execution or invented intent.
2. **Given** a completed step and evidence, **When** restored under a new run ID, **Then** preserve task/workspace identity, completed steps, changed-file/check references, risks and next action without rerunning completed work merely because the run changed.
3. **Given** unexplained repository drift, **When** recovery checks assumptions, **Then** inspect current files and reassess affected assumptions without overwriting drift or asking about routine drift; invalidate affected evidence and let UC-05 revalidate approval before the affected action.
4. **Given** apparently completed work, **When** the owning verification capability is available, **Then** verify current state and report actual evidence; unavailable/incomplete checks cannot certify completion.
5. **Given** no deliberate pause, **When** all restoration prerequisites pass, **Then** automatic continuation is eligible without extra successful-recovery narration. Missing/corrupt/incompatible state instead blocks with a concise reason and safe next action.
6. **Given** a step depends on earlier steps, **When** admission is considered before or after restart, **Then** every required predecessor must be `done` with valid required completion evidence. A `todo`, `doing`, `failed`, missing or invalidated predecessor blocks the dependent step with zero dispatch; stale dependent evidence cannot make it ready.

### User Story 2 - Pause and explicitly resume one task (Priority: P1)

As a developer, I want one selected task to stop admitting work while unrelated tasks remain eligible.

**Why this priority**: Pause preserves human control without promising rollback of already-started effects.

**Independent Test**: Pause task A with a bounded call outstanding, observe B progressing, decline early resume, record A's result and explicitly resume; repeat across process restart.

**Acceptance Scenarios**:

1. **Given** a running task, **When** I request pause, **Then** present `paused` and block all new agent work immediately; no user-visible `pausing` state. Already-started bounded work may finish under its existing limit and its result is retained for inspection.
2. **Given** outstanding work, **When** resume is requested, **Then** decline until the result is recorded and uncertainty reconciled; do not queue automatic resume. Unknown outcomes stay held.
3. **Given** deliberate pause, **When** restarting, **Then** retain it until explicit resume. Resume clears only that pause, preserving approval/rejection, recovery and accounting holds.
4. **Given** pending approval/rejection, **When** pause/resume or restart occurs, **Then** preserve UC-05 control and immutable history; no new model, tool, reviewer or background work begins. Harness recording/cancellation/recovery may continue. Rejection uses UC-05 cancellation rules, distinct from deliberate pause.
5. **Given** concurrent pause/dispatch, **When** serialized, **Then** pause-first denies the claim; claim-first is already outstanding and must be recorded/reconciled. Failed/uncertain writes grant no new work authority.

### User Story 3 - Keep allowances and reconcile unfinished effects (Priority: P1)

As a developer, I want interruptions to preserve spending and uncertainty so restart cannot spend twice or blindly repeat effects.

**Why this priority**: Recovery without durable accounting and effect evidence is unsafe.

**Independent Test**: Terminate after reservation, after claim and after effect before persistence; restore and independently observe allowances, attempt and effect counts.

**Acceptance Scenarios**:

1. **Given** a constrained action, **When** admitted, **Then** atomically reserve all applicable finite task/run allowances durably before dispatch; partial reservation allows zero dispatch.
2. **Given** interruption before settlement, **When** restored, **Then** retain the charged reservation. New runs, approvals, configuration reloads and model-role changes replenish no task repair/reviewer/token/cost/replan allowance.
3. **Given** uncertain non-idempotent or billable outcome, **When** retry is considered, **Then** first reconcile trusted repository/external evidence: record confirmed completion once, freshly admit confirmed non-dispatch, or rely on explicitly evidenced idempotency/duplicate prevention. Unresolved outcomes remain held without blind replay.
4. **Given** known usage, including malformed/rejected model responses, **When** settled, **Then** charge once under original pricing/configuration identity. Missing/inconsistent/exhausted accounting blocks the next affected action without refund or invented balance.
5. **Given** UC-03 material replan evidence, **When** restored, **Then** preserve its maximum three after the initial plan and all charges/reservations. UC-03 determines materiality; generic feature-step strategy rules are not invented here.

### User Story 4 - Inspect state and compact reasoning safely (Priority: P2)

As a developer, I want useful compact reasoning and inspectable state without losing authority or exposing protected data.

**Why this priority**: Summaries/history support reasoning; data safety applies from the first write.

**Independent Test**: Compact a long scripted history, restart, supply a conflicting summary and compare safe status/history with authoritative records.

**Acceptance Scenarios**:

1. **Given** compaction, **When** a summary is supplied, **Then** retain goal, constraints, completed work, current state, open risks and next action; missing fields reject the summary for resumed reasoning without changing state.
2. **Given** a stale/conflicting summary, **When** continuing, **Then** inspect authoritative state and current repository evidence; summary content changes no steps, approval or allowances.
3. **Given** requested status inspection, **When** displayed, **Then** show goal, completed steps, hold/outstanding operation and next safe action with bounded safe evidence. Notify unsafe recovery; successful restoration needs no extra narration.
4. **Given** completed local work, **When** inspected, **Then** state/history remain available. Explicit deletion requires the future agreed policy; unresolved approvals/effects/accounting cannot be purged merely because visible work looks complete.

### Edge Cases

- Lost commit response is not proof of rollback: reload stable request identity before mutation/retry. Stale concurrent writers conflict; duplicate delivery creates no extra completion/charge/effect.
- Incomplete/stale checkpoints cannot overwrite newer authority or supply missing accounting; incompatible versions block safely.
- Recorded tool changes and unexplained drift are distinguished; changed bindings invalidate cached command views and verification.
- Deliberate pause and approval wait may coexist. Clearing one preserves the other. End retains unresolved records.
- Provider reconnection differs from process restart; retry/backoff policy is deferred and uncertain billable requests cannot be blindly replayed.
- Unavailable host/backend/ports produce blocked/not-run outcomes, never mock fallback. Cross-task memory is later work.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Validate/preserve stable task/workspace/repository identity, separate runs, goal, criteria, constraints, steps and required checks; incomplete input admits no execution.
- **FR-002**: Persist harness-owned `todo`, `doing`, `done`, `failed` steps and versioned action/evidence transitions; reject invalid/foreign/stale writes without lost updates. Step admission requires every declared predecessor to be `done` with valid required evidence; revalidate readiness after restore/drift and block zero-effect transitions otherwise.
- **FR-003**: Persist coherent checkpoints at plan, baseline, implementation-step, patch, verification, approval and review boundaries, retaining node/full state, pending decisions, finite configuration, consumed/reserved budgets and check progress.
- **FR-004**: Restore validated coherent state in a new process and continue safely without unnecessary replay; same-process checks do not prove restart.
- **FR-005**: Revalidate workspace, Git revision, working tree, expected changed files and relevant digests; reassess drift and invalidate affected views/evidence/approval without overwriting changes.
- **FR-006**: Preserve task-scoped deliberate pause/resume per ADR-0007, outstanding-result refusal, independent holds and unrelated-task isolation across restart.
- **FR-007**: Retain UC-05 request/decision/control/journal/continuation identities and agreed atomic pause/claim semantics; UC-05 evaluates approval and shared execution enforces admission.
- **FR-008**: Reserve all applicable finite budgets atomically/durably before dispatch; persist scopes/configuration/pricing/consumption/reservations. Missing/invalid/exhausted accounting denies the affected action.
- **FR-009**: Settle observed usage/effects once and retain uncertain charges. Config reload never replenishes; an explicit authorized increase retains prior accounting/provenance.
- **FR-010**: Reconcile interrupted non-idempotent/billable outcomes before retry. No lease expiry, run change or approval alone authorizes replay.
- **FR-011**: Retain UC-03's accepted replan accounting without deciding bug-fix strategy or generic feature-strategy semantics; select no new production numeric limits.
- **FR-012**: Validate the six compaction-summary fields and keep summaries advisory; inspect conflicts without changing authoritative state.
- **FR-013**: Provide safe requested status, recovery blockers and actual verification outcome; retain inspectable history, gating deletion and protecting unresolved records.
- **FR-014**: Keep structured runtime state outside human context and repository-code authority. Validate restored input; traces/reports use sanitized bounded metadata/references, never protected data, raw prompts or streams.
- **FR-015**: Require contract/behavior/concurrency/compaction and actual kill/restore foundation evidence; separately require real approval/executor/feature integration evidence. Account every case with pass/fail/error/not-run and evidence level.

### Key Entities *(include if feature involves data)*

- **Task/run/step**: Stable work, attempts, progress and acceptance conditions.
- **Checkpoint**: Coherent durable progress and authority references.
- **Allowance/reservation/settlement**: Scoped finite configuration, committed usage and outstanding charge.
- **Dispatch claim/outcome**: One attempt and evidence for interruption reconciliation.
- **Holds/continuation**: Independent deliberate pause, approval/rejection and recovery blockers.
- **Repository assumptions/evidence**: State bindings for continuation and verification.
- **Summary/status**: Advisory reasoning and safe inspection, distinct from authority.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every completed-step restart case preserves goal/criteria/constraints/progress, with zero unnecessary completed-step reexecutions.
- **SC-002**: Every pause/approval/rejection case blocks new affected-task work across restart and leaves unrelated eligible tasks progressing; zero early resume releases outstanding work/other holds.
- **SC-003**: Every reservation/effect interruption retains task charges, with zero blind duplicate effects or task allowance resets under new run IDs.
- **SC-004**: Every stale/missing/inconsistent/exhausted-state case blocks unsafe continuation and reports a safe next action, with zero unverified completion claims.
- **SC-005**: Every admitted compact summary retains all six required fields; zero summaries mutate authority and zero protected markers/raw payloads appear in safe inspection.
- **SC-006**: Every applicable matrix row maps to cases/evidence; mock-only or absent restart/integration results never promote durability or integrated capability.

## Assumptions

- [ADR-0007](../../docs/adr/0007-uc04-task-pause-and-recovery-foundation.md), [state guidance](../../context/state_and_memory.md), [runtime policy](../../context/runtime_policy.md) and [permissions](../../context/tools_permissions.md) govern behavior.
- Existing shared agreements apply only within recorded scope. New logical extensions/paths require owner agreement; authoring and review do not authorize implementation.
- First foundation uses a scripted task, controlled external seams and a selected real durable adapter/process restart for durability evidence; this proves no executor isolation, provider quality or integrated feature delivery.
- Integrated feature workflow, cross-task memory, backend/checkpointer, host/profile, retention/deletion and reconnection remain later decisions in [plan](plan.md), [acceptance](contracts/acceptance.md) and [decisions](contracts/decisions.md).
