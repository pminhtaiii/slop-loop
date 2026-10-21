# Feature Specification: UC-05 — Bound Human Approval and Safe Continuation

**Feature Branch**: `feat/023-uc05-human-approval-spec`

**Feature Identity**: `023-uc05-human-approval` (use-case ID: UC-05)

**Created**: 2026-10-19 (Asia/Saigon, UTC+07:00)

**Status**: T001–T015 and T023–T027 review corrections are integrated and verified locally through source `41c4215264106fef27a90ae83ee680cd0edbb1aa`. Phase 6 T014–T015 and the service/control mock-recovery seam were separately authorized on 2026-10-21 (Asia/Saigon); see [decisions](contracts/decisions.md). Source/emitted approvals pass 160/160; runtime typecheck/full lint/clean build and 1005 compiled tests pass. Evidence remains mock-only. T016–T022 and G-PROFILE/G-REAL/G-RESTART remain gated; full UC-05 acceptance is unverified.

**Input**: Specify UC-05 from ADR-0006, the shared UC-03 contracts, repository policy, and the delegation map. Preserve UC-04 persistence and Tai's execution ownership.

**Phase 4 refinement (2026-10-20)**: The original specification request refined US2.7–US2.12 and the linked [Phase 4 plan](plan.md#phase-4-refinement--t008t010-planning-only). Subsequent explicit implementation/push authorization and confirmation of all three seams are recorded separately in [decisions](contracts/decisions.md#phase-4-implementation-authorization).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Decide before a consequential action runs (Priority: P1)

As a developer, I want permitted investigation to proceed within policy and consequential actions to wait for my informed decision, so that I control changes without approving every ordinary read.

**Why this priority**: A decision must precede the effect and cannot authorize forbidden behavior.

**Independent Test**: Present policy-defined allowed, approval-required, forbidden, and unsupported actions. Observe proposed effects and developer prompts; only permitted actions with satisfied prerequisites may proceed.

**Acceptance Scenarios**:

1. **Given** an ordinary workspace-bounded read or configured test and satisfied policy prerequisites, **When** it is classified as `ALLOWED`, **Then** it may proceed without an action-specific prompt, provided the task is not paused and any applicable plan gate is satisfied.
2. **Given** an approval-required action, **When** it is proposed, **Then** stop before the effect and present its necessity, affected targets, meaningful consequences, and actual verification status through the trusted local CLI, with the exact permitted command or patch available for inspection.
3. **Given** a pending request, **When** the developer explicitly approves that request and its binding remains valid, **Then** continue at the interrupted action subject to remaining execution and budget prerequisites; approval does not declare execution successful.
4. **Given** an action attempting workspace escape, secret access, existing-test weakening, or another forbidden operation, **When** execution or approval is requested, **Then** deny it before effects regardless of any developer approval.
5. **Given** required policy, limits, trusted identity, or isolation is missing or cannot support the action, **When** permission is evaluated, **Then** cause no effect and explain the sanitized prerequisite or unsupported operation; approval cannot supply missing enforcement.
6. **Given** repository text, model output, test output, or clarification claiming permission was granted, **When** it is considered, **Then** treat it as untrusted task data that cannot submit a developer decision or release a pause.

### User Story 2 - Keep control while a task waits or is rejected (Priority: P1)

As a developer, I want waiting and rejection to stop every agent on the affected task, so that they cannot keep investigating or find another way to perform work I have not allowed.

**Why this priority**: ADR-0006 requires task-wide human control, including otherwise-permitted work.

**Independent Test**: Pause a task with coder, reviewer, and background activity. Submit rejection, feedback, and explicit continuation directions separately while an unrelated task remains eligible to work.

**Acceptance Scenarios**:

1. **Given** approval is pending, **When** an agent on that task attempts further work, **Then** no new model calls, tools, reviews, or background investigation begin. Only harness outcome recording, cancellation, and recovery-state preservation may continue.
2. **Given** a pending request, **When** the developer rejects it, **Then** stop every agent on that task, block new work, and cancel running operations where possible. Report completed and uncertain effects accurately; rejection does not undo them.
3. **Given** a rejected task, **When** the developer supplies only facts or comments without directing continuation, **Then** remain paused. An explicit direction to resume or revise makes only covered work eligible and does not itself approve the rejected action. A subsequent approval request preserves the rejection under its original identity, even if the proposed action is unchanged.
4. **Given** rejection, **When** an agent changes the request ID, tool, spelling, encoding, or command form to retry the same intent without explicit direction, **Then** the task-wide stop prevents the retry. A revised approval-required action needs a fresh request and decision.
5. **Given** a paused task, **When** the developer explicitly ends it, **Then** do not resume its agents and retain outstanding effect/accounting uncertainty for reconciliation. An unrelated task is not paused merely because this task waits or ends.
6. **Given** a pending prompt, **When** input is empty, malformed, interrupted, or unavailable because the terminal closes, **Then** infer no approval and preserve the recoverable pause.
7. **Given** a waiting, recovery-blocked, or ended task, **When** resume or revise is requested, **Then** it cannot clear that state; these directions release only a rejection hold with no outstanding effects or other blocking prerequisites.
8. **Given** an explicit direction already recorded, **When** the same response is delivered again, **Then** confirm its original identity without adding a direction, changing the latest task state, or repeating cancellation. Reusing its response key for different content conflicts.
9. **Given** a task/control version changed after inspection, **When** a new direction is submitted against the old version, **Then** refuse the change and retain current control; do not silently retry against a newer version.
10. **Given** saving a pending request, decision, or direction fails or its outcome is unknown, **When** further work is attempted, **Then** grant no new authority. Retain the stop until authoritative state and outstanding effects can be established; never claim that an uncertain write did not commit.
11. **Given** an operation finishes or cannot be cancelled after a stop, **When** the harness records its outcome, **Then** preserve completed, cancelled, and uncertain observations without reopening the task. Explicit end retains this evidence and all outstanding accounting.
12. **Given** a complete explicit response was recorded before terminal loss, **When** the developer checks status again, **Then** report that recorded response and the current task state; terminal loss neither invents a response nor undoes a committed one.

### User Story 3 - Approve only the intended action and plan (Priority: P1)

As a developer, I want approval to cover the exact work I inspected, so that a changed repository, policy, action, or strategy cannot silently reuse my earlier decision.

**Why this priority**: A recorded approval is insufficient unless its identity and scope are checked before execution.

**Independent Test**: Vary task, workspace, repository state, policy, action, and fix-plan bindings separately; attempt foreign, duplicate, and conflicting decisions. Only a current matching decision can authorize continuation.

**Acceptance Scenarios**:

1. **Given** an approved action, **When** its normalized action, task/workspace identity, repository revision or relevant working-tree state, or policy identity/version no longer matches, **Then** refuse its authority, explain the changed binding, and obtain fresh approval if reevaluation requires it.
2. **Given** a foreign decision or conflicting response to an already-resolved request, **When** it is submitted, **Then** it cannot authorize this action or overwrite the recorded decision. Repeated delivery of the same accepted response causes no additional effect.
3. **Given** UC-03 investigation has produced criteria, diagnosis, baseline evidence, scope/strategy, and required checks, **When** production edits are proposed, **Then** require explicit approval of that diagnosis/fix plan first. Permitted reproduction and a policy-compliant new regression test may precede approval; existing tests remain protected.
4. **Given** an approved fix plan, **When** a material strategy revision is proposed, **Then** invalidate old plan permission for the revised strategy and require a new decision within the shared limit of three material replans after the initial plan. A fourth cannot execute even if approved.
5. **Given** unchanged material strategy and valid applicable bindings, **When** wording or an ordinary implementation adjustment stays within the approved plan, **Then** it consumes no material replan. Covered authentication/authorization edits do not trigger another patch prompt solely because of their paths.
6. **Given** an approved plan, **When** an action falls under a separate approval rule, such as dependency changes, deletion, sensitive configuration, or an unusually broad patch, **Then** the action gate still applies. Plan approval never waives forbidden-action, isolation, verification, or budget requirements.

### User Story 4 - Preserve control across restart (Priority: P1)

As a developer, I want restart to preserve pending/rejected decisions and safe continuation, so that interruption cannot erase my control or repeat a consequential effect.

**Why this priority**: Process termination must not turn waiting or already-performed work into fresh executable work.

**Independent Test**: With UC-04 recovery and shared execution integrated, actually terminate/restart while pending, after rejection, after approval-before-execution, and after an effect-before-recording.

**Acceptance Scenarios**:

1. **Given** a waiting or rejected task, **When** the process terminates and is restored, **Then** retain the same task/request, binding, decision history, and pause. A new run or reopened CLI does not release it.
2. **Given** approval recorded before interruption, **When** continuation is considered after restart, **Then** restore and revalidate action, repository, policy, task state, and accounting before the interrupted action; stale approval requires reevaluation.
3. **Given** an effect may have happened before its outcome was saved, **When** recovery runs or a response is repeated, **Then** approval alone cannot trigger another attempt. Reconcile through the shared executor and UC-04; retain uncertainty and prohibit blind replay when the outcome cannot be established.
4. **Given** a decision, restart, or new run, **When** allowances are restored, **Then** retain consumed and outstanding reservations. Approval never replenishes replan, repair, reviewer, token, cost, or other applicable limits.
5. **Given** authoritative pause, decision, or accounting records are missing, conflicting, or cannot be saved, **When** continuation is requested, **Then** perform no constrained action and explain the recovery prerequisite without inventing a decision or fresh budget.

### User Story 5 - Inspect a safe decision history (Priority: P2)

As a developer, I want to understand what was proposed, what I decided, and what happened, without exposing protected data in prompts, diagnostics, or history.

**Why this priority**: Decision evidence supports review and recovery; protected-data exclusions apply from the first request regardless of this story's priority.

**Independent Test**: Inspect successful, denied, stale, cancelled, and uncertain requests containing ordinary text, injection attempts, and secret markers. Compare decision references with observed outcomes and confirm protected payloads are absent.

**Acceptance Scenarios**:

1. **Given** a classified or resolved request, **When** its history is inspected, **Then** distinguish classification, request, decision, binding, continuation, and observed outcome using stable references and timestamps. Approval and execution success are separate facts.
2. **Given** protected data or injected instructions in an action/diagnostic, **When** the CLI or audit history displays it, **Then** reject or safely exclude protected payloads and prevent untrusted text from impersonating trusted decision controls. Never record raw prompts, raw tool streams, credentials, or hidden grading.
3. **Given** no confirmed execution outcome, **When** a report is generated, **Then** state pending, cancelled, denied, stale, failed, or uncertain status as applicable; never claim completion solely because approval was granted.

### Edge Cases

- An old reply arrives while a revised request waits: preserve both identities and do not apply the old reply to the new action.
- Repository/policy state changes after prompt display: revalidate before effects and explain why renewed approval is required.
- Two replies race or one response is delivered twice: accept one authoritative resolution, surface conflicts, and cause no duplicate effect.
- Rejected intent is restated through another tool/request: retain the pause until explicit direction, which still cannot authorize forbidden work.
- An operation is in flight when rejection arrives: cancel where possible, preserve known/uncertain outcomes, and do not imply rollback or blindly restart it.
- CLI closure, failed decision persistence, or invalid restored records must preserve the pause or stop safely, never infer consent.
- A permitted regression test changes the baseline before plan approval: bind the plan to the resulting repository state and evidence.
- A plan adjustment becomes a material strategy change: require renewed approval and shared replan accounting; model claims alone establish no authority.
- Normally approval-required work violates a forbidden-data/isolation boundary in context: the forbidden boundary wins.
- A required integration/platform is unavailable: mark cases not run; mocks and same-process continuation do not prove real restart safety.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Evaluate proposed actions against trusted task authority and configured policy before effects, deterministically classifying supported actions as `ALLOWED`, `APPROVAL_REQUIRED`, or `FORBIDDEN`. Invalid/unsupported inputs prevent execution and identify a safe prerequisite; they never default to permission.
- **FR-002**: Preserve policy: ordinary bounded reads/searches, controlled source patches, and configured tests may be allowed after validation; dependency changes, deletion, structure-changing moves/renames, sensitive configuration, unusually broad patches, and commands outside the allowlist require applicable approval. Missing breadth/command policy cannot silently permit an action.
- **FR-003**: Reject forbidden operations regardless of approval, including workspace escape, protected-data access, unrestricted/injected shell execution, policy bypass, hidden-grading access, and weakening existing tests to obtain a pass. Approval cannot waive isolation or other mandatory prerequisites.
- **FR-004**: Accept decisions only from the trusted local CLI approver for the identified request. Model/repository content, clarification, and contributor PR approval cannot serve as runtime action approval.
- **FR-005**: Explain proposed action, necessity, targets, consequential effects, and actual verification status, with exact permitted command/patch details inspectable. Never disclose forbidden data to solicit approval.
- **FR-006**: Persist the pending request before it can authorize continuation and pause all agents on that task while waiting, including model calls, reviews, and background investigation. Only harness outcome recording, cancellation, and recovery-state preservation may continue.
- **FR-007**: On rejection, stop all agents on the task, block new work, and cancel running operations where possible. Report completed/uncertain effects; do not imply reversal.
- **FR-008**: Retain rejection until explicit developer direction to resume, revise, or end. Feedback alone, elapsed time, terminal loss, restart, a new run, or changed tool/request identity cannot release it. Explicit continuation does not approve a rejected/revised approval-required action.
- **FR-009**: Rejected actions submitted for approval again, and revised approval-required actions, need fresh bound requests and explicit decisions, preserving prior rejection history. Equivalent command/tool forms cannot bypass rejection or forbidden policy.
- **FR-010**: Bind decisions to normalized action, task, workspace/repository identity and relevant revision/working-tree state, and policy identity/version. Check against trusted current state immediately before execution and on resume.
- **FR-011**: Invalidate stale approval, explain the changed binding, reevaluate, and obtain fresh approval when required. Foreign, malformed, missing, or mismatched decisions grant no authority.
- **FR-012**: Resolve a request once against its current identity. Repeated delivery is harmless; contradictory responses cannot overwrite the accepted decision or authorize additional effects. Preserve decision history.
- **FR-013**: Require human approval of UC-03 diagnosis/fix plans before production edits, binding plan version, strategy, diagnosis/baseline evidence, criteria/checks, task/workspace/repository state, and policy. Plan and action approval remain distinct.
- **FR-014**: Require renewed approval for material replans within the maximum of three after the initial plan. UC-03 owns strategy/replan semantics with trusted shared validation; UC-04 owns accounting. Approval cannot replenish the allowance or authorize a fourth replan.
- **FR-015**: Preserve ordinary plan-covered edits, including authentication/authorization paths, without another prompt solely for path sensitivity. Non-material wording/implementation adjustments consume no replan; stale bindings and action-specific gates still apply.
- **FR-016**: Continue at the interrupted action only after recording explicit matching approval, checking current bindings and task eligibility, and satisfying shared execution/accounting prerequisites. UC-05 cannot bypass the shared execution boundary or itself execute repository operations.
- **FR-017**: Use UC-04's authoritative durable state for requests, decisions, task-wide pause, and recovery references. Preserve pending/rejected control across real process restart; do not create competing persistence/recovery.
- **FR-018**: Coordinate uncertain-effect reconciliation with UC-04 and the executor before retry. Preserve consumed/reserved allowances across decisions, runs, and restarts; approval neither proves non-execution nor grants a fresh budget.
- **FR-019**: Keep unrelated tasks eligible under their own authority. Ending a task cannot resume its agents or discard unresolved effects/accounting.
- **FR-020**: Record sanitized classification, request, decision, binding, continuation, cancellation, and effect outcomes with stable task/run/request references, policy references, timestamps, and safe reasons. Exclude raw prompts/streams, credentials, protected payloads, and hidden grading from CLI output, history, and reports.
- **FR-021**: Distinguish permission from observed execution success. Preserve actual denied, pending, stale, failed, cancelled, and uncertain outcomes; approval does not establish verified task completion.
- **FR-022**: Later implementation validation must include behavioral, contract, security, CLI, and recovery checks covering every Human approval matrix row. Real acceptance proves task-wide pause/binding and no duplicate effects through actual restart; mocks prove only exercised local behavior.

### Key Entities *(include if feature involves data)*

- **Proposed action**: Operation and targets, stable identity, and exact normalized meaning used for policy/approval checks.
- **Policy context**: Trusted rules, authority, bounds, and policy identity/version; repository text cannot change them.
- **Approval request**: Specific action or plan awaiting a decision, its task/workspace/repository binding, explanation, and interrupted continuation point.
- **Human decision**: Explicit response to one request, bound status, safe reason, and history; permission and effect are separate.
- **Fix-plan coverage**: Approved diagnosis, baseline, strategy, scope, criteria, checks, and plan version used before UC-03 edits.
- **Task control state**: Waiting, rejected, explicitly directed continuation/revision, or ended state, with references UC-04 needs to restore control.
- **Decision/effect evidence**: Sanitized classification, decisions, execution/cancellation, and reconciliation observations for the task/action.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All required classification cases produce expected outcomes; permitted cases with satisfied prerequisites and an unpaused task incur zero unnecessary action-specific prompts, and forbidden/invalid cases cause zero unauthorized effects.
- **SC-002**: Every pending/rejected case permits zero new agent work on the affected task until the required explicit response/direction; unrelated tasks remain eligible. In-flight outcomes distinguish completed, cancelled, and uncertain effects.
- **SC-003**: Every request provides proposed action, necessity, targets, meaningful consequences, and actual verification status, with permitted exact details inspectable. Zero empty, malformed, untrusted, or interrupted inputs become approval.
- **SC-004**: All stale, foreign, revised, duplicate, and conflicting decision cases prevent incorrect authorization/duplicate effects. Every stale request identifies the changed binding before renewed approval.
- **SC-005**: All plan cases enforce initial/revised strategy approval with zero fourth-replan executions and zero extra prompts solely for covered authentication/authorization paths; action-specific gates remain effective.
- **SC-006**: Actual restart cases while pending, after rejection, after approval-before-effect, and after effect-before-recording retain control/accounting with zero blind retries or duplicate effects. Unreconciled outcomes stay explicitly uncertain.
- **SC-007**: Every required decision/outcome has inspectable safe evidence, with zero protected markers or raw prompts/streams in CLI output, history, or reports, and zero success claims solely from approval.
- **SC-008**: Every Human approval matrix row maps to a required case and observed result; failed, missing, mock-only, or unrun required integration evidence prevents a UC-05 verification claim.

## Assumptions

- Initially one developer operates the trusted local CLI, as discussed in [ADR-0006](../../docs/adr/0006-uc05-cli-and-human-control.md). This draft adds no web application, remote approvers, multi-user approval delegation, or new identity service.
- Accepted behavior follows [ADR-0004](../../docs/adr/0004-uc03-adaptive-workflow-and-replan-limit.md), ADR-0006, [tools and permissions](../../context/tools_permissions.md), [runtime policy](../../context/runtime_policy.md), and [state and memory](../../context/state_and_memory.md). Older wording "reject and adapt" means explicit developer-directed revision, never autonomous adaptation after rejection.
- The [delegation map](../../docs/use-case-delegation.md) assigns Trong Tan classification/decision validity, Thanh Tan durable waiting/recovery/accounting, and Tai controlled tools/execution composition. UC-01 clarification/recommendation grants no approval.
- Accepted [shared interfaces](../001-verified-code-repair/contracts/interfaces.md) and [contract decisions](../001-verified-code-repair/contracts/decisions.md) are the compatibility baseline. Canonical validators and scripted test approvals do not prove a production approval service. Contract changes require coordinated agreement; this draft does not silently change them.
- Scope is product-runtime approval. Contributor Git/PR workflows, automatic merging/deployment, replacement executors, independent storage, and general-purpose planning are excluded.
- Detailed classification, identity, CLI and UC-04 transaction proposals are recorded in the [plan](plan.md) and its contracts for owner agreement. ADR-0006 deferred production values, supported real-execution profiles, retention configuration and numeric latency/benchmark targets; none is silently selected here. Missing required configuration or unsupported enforcement denies the affected operation.
- The [acceptance catalog](contracts/acceptance.md) defines required C01–C24 cases and SC-001–SC-008 traceability before implementation. Distinguish contract, mock, real execution, and real restart evidence, including UC-03 integration and joint UC-04/UC-05 cases in the [target matrices](../../docs/progress-checker-matrices.md).
- `.specify/memory/constitution.md` is an unratified placeholder. Apply `AGENTS.md`, current context, and accepted ADRs without claiming ratification, owner approval of new details, independent planning reviews, or runtime verification. Planning quality and implementation authorization remain separate gates.
