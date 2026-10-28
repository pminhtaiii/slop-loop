# Feature Specification: UC-03 — Verified Code Repair

**Feature Branch**: `feat/001-verified-code-repair`

**Feature Identity**: `001-verified-code-repair` (renamed from `005-uc03-bug-fix` at user request); original authoring branch `feat/005-uc03-execution-design`.

**Created**: 2026-10-16

**Status**: User-recorded authorizations and remaining scope gates are in [decisions](contracts/decisions.md); [tasks](tasks.md) reports implementation progress only and does not confer permission.

**Input**: Specify only UC-03 from approved scope, acceptance criteria, security policy and decisions; enable parallel work with contract-bound mocks without claiming real acceptance.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Receive a verified localized fix (Priority: P1)

As a developer, I supply observed behavior, reproduction and expected behavior, approve the diagnosis and plan, and receive a minimal diff with evidence against agreed checks.

**Why this priority**: The first useful slice runs from a supplied bug task to evidence-backed delivery.

**Independent Test**: A seeded disposable repository reproduces the bug before editing, passes a focused check after editing, preserves required existing checks and receives read-only review of the final state.

**Acceptance Scenarios**:

1. **Given** missing reproduction, criteria or repository identity, or materially ambiguous behavior, **When** input is validated, **Then** request missing information/confirmation and make no speculative fix.
2. **Given** valid input, **When** investigation reproduces the bug, **Then** persist baseline, criteria and required checks; present diagnosis, evidence, suspected cause/locations, proposed changes and verification approach for human approval before production edits. A new regression test may demonstrate failure during investigation; existing tests remain protected.
3. **Given** an approved plan and authorized actions, **When** a minimal patch passes focused and required existing checks and separate read-only review, **Then** the harness permits a final diff/report with linked evidence, actual outcome and limitations.
4. **Given** a rejected plan, **When** feedback has not arrived, **Then** wait rather than generate alternatives. A requested material revision requires renewed approval and consumes the replan allowance.
5. **Given** changes after verification or review, **When** completion is proposed, **Then** invalidate stale evidence and repeat required verification and review on the resulting state.

### User Story 2 - Repair or stop honestly within limits (Priority: P2)

As a developer, I receive a repair informed by failure evidence, or an incomplete outcome when no safe allowance remains.

**Why this priority**: Failed patches must not cause unbounded retries or false completion.

**Independent Test**: From a saved baseline fixture, inject failed patches, regressions, reviewer findings and exhausted budgets; each branch returns through verification/review or stops with evidence.

**Acceptance Scenarios**:

1. **Given** a failed patch/check or actionable review, **When** repair remains allowed, **Then** propagate that evidence and reserve the persisted allowance before attempting repair, then rerun verification.
2. **Given** a previously passing check now fails, **When** the focused check passes, **Then** regression still prevents completion; weakening existing tests is rejected.
3. **Given** new evidence requires another strategy, **When** fewer than three material replans after the initial plan are consumed/reserved, **Then** record and charge the replan and obtain renewed human approval before edits. A fourth material replan stops incomplete.
4. **Given** restart or a new run for the same task, **When** accounting is restored, **Then** retain spent/reserved allowances and reconcile uncertain effects before replay. Missing/exhausted accounting prevents the next constrained action.
5. **Given** unavailable required checks, exhausted limits or no safe next action, **When** work stops, **Then** report the actual blocker and partial evidence; applied code lacking required verification remains `IMPLEMENTED_UNVERIFIED`.

### User Story 3 - Trust and inspect controlled execution (Priority: P1)

As a developer, I see meaningful activity and approval requests while repository code and content remain constrained by policy.

**Why this priority**: Security applies to the first real operation, independently of story ordering.

**Independent Test**: Attack fixtures exercise escapes, secret access, injection, approval pauses and missing limits; verify denial, absence of side effects and absence of protected payloads in context, logs and reports.

**Acceptance Scenarios**:

1. **Given** traversal, symlink/junction escapes, protected-file/embedded-secret access or hidden-grading requests, **When** tools or executed code attempt access, **Then** enforce containment and denial/sanitization without revealing protected payloads.
2. **Given** command or prompt injection, **When** execution is proposed, **Then** treat repository content as untrusted data and enforce executable/argument policy without shell parsing. Forbidden actions cannot be approved.
3. **Given** an approval-required action, **When** execution is requested, **Then** pause before effects; resume only with a decision bound to normalized action, repository state and policy version. Changed bindings require reevaluation; equivalent commands cannot bypass rejection.
4. **Given** missing isolation, prepared dependencies or finite required limits, **When** an affected operation is requested, **Then** refuse before effects and report the prerequisite/configuration failure, without downloading dependencies during the task.
5. **Given** active work, **When** milestones occur, **Then** show concise activity, evidence and consequential choices without raw internal reasoning; final output and traces contain sanitized bounded information only.

### Edge Cases

- Baseline does not reproduce, or collection/environment errors/pre-existing failures occur: distinguish them; do not claim verified completion without agreed reproduction and passing required evidence.
- Existing tests that appear incorrect are surfaced for justification and applicable approval; deleting/skipping/weakening assertions to pass is prohibited.
- Malformed model/reviewer results, invalid diff-line findings, timeouts and absent diagnostics are failures rather than passes.
- Wording clarification, extra searches and adjustments within an approved strategy are not material replans. Rejection waits for feedback; material user-requested revisions use the same cap.
- Workspace drift invalidates affected assumptions/decisions. A crash after an effect but before persistence requires reconciliation before replay.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Accept directly supplied structured bug tasks/fixtures; validate repository identity, reproduction and criteria, and confirm materially ambiguous intended behavior. Automated issue triage is deferred.
- **FR-002**: Establish criteria, required checks and persisted pre-edit reproduction/baseline; distinguish expected bug failures, previously passing tests and environment failures.
- **FR-003**: Permit adaptive investigation inside harness stage gates; record diagnosis/plan and obtain human approval before production edits, with feedback wait after rejection.
- **FR-004**: Apply the smallest coherent authorized fix through controlled tools, protect existing tests and request permission for unrelated scope. Plan approval never waives action policy.
- **FR-005**: Require focused and regression checks, compatibility where applicable, final-diff validation and separate read-only review before completion. Later changes invalidate stale evidence.
- **FR-006**: Propagate tool/test/review evidence into bounded repair with persisted reservation/settlement; repeat verification after changes and report incomplete outcomes honestly.
- **FR-007**: Permit at most three task-scoped material replans after the initial plan, each with renewed approval before edits. Stop before a fourth; replans/restarts reset no other allowances.
- **FR-008**: Compose shared recovery and approval interfaces; preserve task/workspace identity, evidence and spent/reserved budgets across runs; reconcile uncertain effects before retry.
- **FR-009**: Enforce workspace and protected-data boundaries, test protection, command policy, no-shell execution, minimal environment, network denial and finite limits before effects; refuse absent isolation. Allowed repository commands grant neither direct source/test writes nor protected-data reads. Coder and reviewer calls obey the same task token/cost budget enforcement.
- **FR-010**: Keep credentials, harness files, checkpoints, Docker control and hidden grading outside repository authority. Supply bounded approved source evidence with provenance; sanitize/reject embedded secrets and injected instructions.
- **FR-011**: Validate model output and structured review; the distinct reviewer has read-only authority, real diff/line validation and finite iterations. Only the harness determines completion.
- **FR-012**: Provide milestone activity and final diff with actual outcome, baseline/check/review evidence, limitations and safe next action. Record identities, outcomes, timing, approvals and per-run usage/cost without raw prompts, streams or protected payloads.
- **FR-013**: Evaluate seeded success, repair, exhaustion, regression, test weakening, escapes, secrets, command/prompt injection and missing limits using real isolated execution. Mocks enable development but never establish end-to-end acceptance. Behavioral, contract, security and integration tests are required in implementation.

### Key Entities *(include if feature involves data)*

- **Bug task**: Stable goal, repository, reproduction, criteria, constraints and required checks across runs.
- **Fix plan**: Diagnosis, evidence references, proposed scope/strategy, revision and human decision.
- **Verification evidence**: Baseline/focused/regression/compatibility/diff results bound to the state checked.
- **Action/approval**: Normalized operation, repository/policy binding, decision and resulting effect.
- **Budget/checkpoint**: Limits, scopes, spent/reserved amounts, progress, replan count and uncertain effects.
- **Review/delivery**: Validated findings, evidence, final diff and harness-controlled outcome.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The seeded success case has pre-fix failure, post-fix focused success, 100% of required existing checks passing unchanged and accepted review of the same final state.
- **SC-002**: Every required failed-fix, exhaustion and regression case yields expected repair/incompletion; zero incomplete cases claim completion.
- **SC-003**: All specified attack/invalid-limit cases prevent unauthorized effects and protected-data disclosure; unavailable isolation results in zero repository commands.
- **SC-004**: Every delivered fix links baseline, final checks, review and diff evidence; every material replan has a charge and renewed decision, and zero fourth-replan executions occur.
- **SC-005**: Integrated pause/restart cases retain task identity and budgets with zero duplicate uncertain effects; milestone/final reports pass protected-data checks.

## Assumptions

- Scope follows [ADR-0001](../../docs/adr/0001-uc03-scope-and-completion.md), [ADR-0002](../../docs/adr/0002-uc03-specification-order-and-shared-dependencies.md), [ADR-0003](../../docs/adr/0003-docker-task-workspace-boundary.md), [delegation](../../docs/use-case-delegation.md) and [matrices](../../docs/progress-checker-matrices.md). Technical design belongs in plan.md.
- Plan/replan rules follow current context and accepted [ADR-0004](../../docs/adr/0004-uc03-adaptive-workflow-and-replan-limit.md), whose approval-gate decisions and closure are recorded on 2026-10-16 (UTC+07:00) in development commit 5a81b3a. That acceptance does not approve these feature artifacts, exact shared contracts or implementation.
- Tai owns UC-03 plus shared tools/evaluation, Thanh Tan owns UC-04 persistence/recovery, Trong Tan owns UC-05 approval. Shared contract proposals require owner agreement; mocks may then support early work.
- Required runtime review does not select all of UC-06. Generic triage, MCP coverage, runtime skill loading, stop controls, deployment and a full UI are outside this feature. Contributor skills/CodeRabbit do not prove runtime capabilities.
- Except the replan cap, required finite limit values remain explicit trusted inputs with no permissive defaults. Tests may use explicit finite fixture configurations.
- Placeholder constitution, open stack choices and shared signoff are implementation-readiness gates, not authorization to invent decisions or widen scope.

## Scoped intake amendment — 2026-10-28

On 2026-10-28 (Asia/Bangkok), the user reported Tai had delegated full implementation and technical decisions within UC-03 T011 → T012 → UC-01 T013, including required specification/contract amendments. This releases only that sequential batch, its tests, independent review, context refresh and contributor publication. It supersedes earlier unreleased wording only for these tasks. No real LLM/provider, UC-04/UC-05 implementation, dispatch, automatic repair, production choices or other successor work is authorized.

FR-001 now also permits an explicitly supplied UC-01 assessment as advisory source metadata through [uc01-uc03-receiver-v1](contracts/uc01-receiver.md). A caller still supplies reproduction, expected behavior, criteria and all other BugTask fields; no assessment creates an executable task or verified diagnosis. Complete/missing/ambiguous input, stale identity/configuration and unsupported recommendations have distinct safe outcomes. Acceptance remains pure intake, not automated issue dispatch or end-to-end repair.
