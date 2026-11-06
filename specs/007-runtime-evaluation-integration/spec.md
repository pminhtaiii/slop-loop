# Feature Specification: Observable Python Repair Evaluation

**Feature Branch**: `feat/uc03-evaluation-integration-plan`
**Created**: 2026-11-01 (Asia/Saigon)
**Status**: T001–T011 retain their recorded controlled implementation release. The 2026-11-04 host-composition remediation went through planning and then an explicit separate release for T020–T034, source and controlled-tier tests only; [decisions and gates](contracts/decisions.md) own authorization and the planning step is superseded for implementation.
**Input**: Integrate the existing coding workflow and evaluator, exercise real Python fixes, expose where agents/tools struggle, and provide a local interactive interface. User selects DeepSeek Flash through the Anthropic-compatible API, configures their environment, and requests no user-set spend cap or early cost optimization.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Evaluate an actual repair (Priority: P1)

As a developer, I select a prepared Python bug case and receive evidence from the actual workflow, without supplying the solution.

**Why this priority**: This exposes integration, tool and agent failures on the smallest useful journey.
**Independent Test**: A seeded case records baseline failure, model-generated diagnosis, explicit approval, model-generated patch, required tests, read-only review and independent final-state grading.

**Acceptance Scenarios**:

1. **Given** a prepared case and admitted runtime, **When** evaluation starts, **Then** bind case, repository, configuration and run identities to a fresh isolated workspace before effects.
2. **Given** a reproduced bug, **When** the coder investigates, **Then** generate the diagnosis, plan and patch from permitted evidence; refuse caller-supplied solutions and private grader data in real mode.
3. **Given** a pending approval, **When** the task pauses, **Then** expose the bound request and continue only after explicit valid human action. Rejection waits for explicit direction; no background model calls continue.
4. **Given** a proposed fix, **When** completion is evaluated, **Then** require focused/required existing checks, protected-test integrity, accepted review and grading bound to the same final snapshot.
5. **Given** missing credentials, adapters, pricing, dependencies, containment or authority, **When** preflight fails, **Then** report the prerequisite and perform zero affected execution, without mock fallback.
6. **Given** a paused task, **When** resumed, **Then** preserve task identity, usage, evidence and decisions without repeating settled effects.
7. **Given** configured host capabilities, **When** the operator requests readiness or a run, **Then** check all required deliveries and their current bindings, report missing capabilities, and start no affected effects on refusal.
8. **Given** a model or repository operation, **When** it is admitted, **Then** carry its exact current authority through dispatch and accounting once; stale, substituted or repeated authority cannot authorize another effect.
9. **Given** investigation or continuation, **When** baseline evidence or protected-test identity is needed, **Then** obtain it from current host observations and acknowledged durable evidence; missing, changed or unavailable evidence blocks progress.
10. **Given** explicit material revision, **When** a new strategy is accepted, **Then** consume one durable task-scoped replan allowance, invalidate prior edit authority and obtain renewed approval; duplicate requests consume no additional allowance and a fourth material revision cannot proceed.

### User Story 2 - Diagnose and compare experiments (Priority: P1)

As a developer, I distinguish environment, tool, integration, model, verification, review and human-input blockers and compare compatible experiments.

**Why this priority**: Observed failures should direct the next investment.
**Independent Test**: Exercise fault scenarios through the graph-backed driver with controlled dependencies and compare reports with known differences. Keep this evidence labeled controlled.

**Acceptance Scenarios**:

1. **Given** tool denial, malformed model output, failed tests or uncertain effects, **When** stopped, **Then** preserve stage/component, safe reason, evidence, effect status and usage uncertainty without claiming an unproven root cause.
2. **Given** only one selected case, **When** it passes, **Then** distinguish selected success from incomplete suite acceptance; omitted required cases remain not-run.
3. **Given** matching cases/repositories/graders, **When** configurations differ, **Then** show differences alongside outcome/time/usage changes. Incompatible case/grader identities prevent direct comparison.
4. **Given** private grading, **When** a final snapshot is checked, **Then** grade independently under isolation, keep grading material outside coder/reviewer authority and bind the verdict to the snapshot. Missing grading remains incomplete.
5. **Given** missing usage information, **When** reporting, **Then** preserve unknown/uncertain values rather than invent zero cost or real verification.

### User Story 3 - Operate through a local interface (Priority: P2)

As the operator, I select a prepared repository, submit a bug, launch an evaluation, inspect progress, answer questions, decide approvals, and inspect results/comparisons.

**Why this priority**: Interactive operation is part of the milestone and follows the first proven real route.
**Independent Test**: Browser journey submits a case, observes approval, rejects a stale decision, records a current decision and displays actual diff/checks/diagnostics.

**Acceptance Scenarios**:

1. **Given** a configured app, **When** opened, **Then** show catalog/readiness without credentials or arbitrary host browsing.
2. **Given** an advancing/paused task, **When** inspected, **Then** display safe milestones, persisted state and bound requests; browser state never grants authority.
3. **Given** duplicate clicks or stale pages, **When** mutations repeat, **Then** accept at most one transition and refuse stale/conflicting bindings before effects.
4. **Given** a final/incomplete run, **When** inspected, **Then** distinguish workflow outcome, case grade and full-suite acceptance and expose only safe artifacts.
5. **Given** a custom bug against a configured repository, **When** submitted, **Then** validate public goal/behavior/reproduction/criteria against trusted repository/check configuration, preserve immutable input identity, and label the run exploratory/ungraded until independent criteria are pinned. Never reuse a catalog grade for edited input.
6. **Given** a bound clarification, **When** answered, **Then** store reporter data separately from approval/control. Explicit resume/revise/end action and current owner binding remain necessary; answers alone do not resume.

### Edge Cases

- Nonreproduction, collection failure and pre-existing test failures cannot certify a fix.
- Provider/patch timeout after possible effect requires reconciliation, not automatic replay.
- Rolling model alias changes are recorded; identical aliases do not prove identical weights.
- Changes after checks/review invalidate affected evidence and grading.
- Browser refresh/same-process continuation is not process-restart acceptance.
- Local-only fixtures may be absent from a fresh checkout; missing cases remain not-run.
- Real delivery declarations without the required callable authority, revision, configuration or conformance evidence remain unavailable.
- Command-view exclusions or scratch identity differing from the owner's admission facts prevent command dispatch.
- An unknown action or a changed observed action cannot be reconstructed from model output or an old approval presentation.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Reuse existing UC-03 graph, evaluation entry, manifest and comparison machinery; add one execution bridge.
- **FR-002**: Bind cases to supplied public tasks and fresh workspaces, keeping solutions/private grading outside agent authority.
- **FR-003**: Connect actual model generation and admitted evidence/tool actions to investigation, patch and bounded repair/replan. Supplied answers remain controlled-only.
- **FR-004**: Preserve canonical approval, test-protection, verification, review, repair/replan and completion rules; no automatic production plan approval.
- **FR-005**: Admit real components before effects, fail on missing prerequisites and retain truthful provider accounting.
- **FR-006**: Require no user-set economic cap. Derive conservative finite accounting exposure from explicit operational limits and pinned pricing; defer optimization. Unsupported accounting blocks dispatch.
- **FR-007**: Project actual workflow evidence into evaluation, including waits, effects, usage uncertainty, artifacts and safe diagnostic attribution.
- **FR-008**: Separate selected-case result from complete acceptance and compare different configurations only under explicit compatibility rules.
- **FR-009**: Version new report semantics while preserving legacy inputs/reports and mock evidence boundaries.
- **FR-010**: Deliver US3 over the same execution service with server-side authority, request binding and bounded/protected input/output.
- **FR-011**: Use contract, behavioral, security and real integration checks; separate controlled harness evidence from real-model observations.
- **FR-012**: Preserve safe bounded activity/evidence without credentials, raw prompts/streams/reasoning or private grader payloads.
- **FR-013**: Supply a host-owned entry path that resolves trusted operator configuration, checks complete capability readiness, and connects the existing workflow/evaluator. Public task input cannot construct authority. Both CLI adapters must preserve truthful missing-prerequisite outcomes.
- **FR-014**: Carry exact versioned authority through every production consumer, including coder tools, reviewer, repair and replan. Preserve legacy controlled behavior separately; implicit compatibility cannot satisfy production admission.
- **FR-015**: Mediate repository reads with task/workspace/current-policy authority and bounded protected-content filtering. Obtain trusted repository/test snapshots from host measurement, not task claims.
- **FR-016**: Persist and restore baseline evidence through an accepted durable owner capability with content/identity acknowledgement; forged acknowledgements and stale snapshots prevent progress.
- **FR-017**: Observe registered actions and current host facts for approval context; retain UC-05 policy/decision/control authority and UC-04 accounting. Missing owner capability, reconciliation proof or bound explicit control prevents continuation.
- **FR-018**: Require coherent command-view identity, exactly-once provider/replan accounting and effect receipts in controlled contract/integration tests before real proofs. Preserve separate owner/profile/isolation/approval/route gates and the existing real-success criterion.

### Key Entities

- **Evaluation case**: Versioned public bug scenario with separate judging criteria.
- **Experiment**: Selected cases/configuration in an identified attempt, referencing product tasks/runs.
- **Case observation**: Actual workflow behavior, effects, pauses and uncertainty.
- **Case grade**: Independent judgment of evidence, distinct from workflow completion.
- **Diagnostic**: Safe stage/component/reason/evidence with attribution confidence.
- **Capability receipt**: Pinned trusted admission of specific runtime operations and configuration.

## Success Criteria *(mandatory)*

- **SC-001**: Demonstrate one real seeded repair without supplied solution, with baseline failure, explicit approval, required passes, accepted review and independent final-snapshot grade. Failed experiments are useful observations but do not alone complete this milestone.
- **SC-002**: Every exercised fault/wait preserves actual status, evidence tier and safe diagnostic; zero incomplete/paused cases claim verified repair.
- **SC-003**: Reports/UI distinguish selection and suite acceptance; missing required cases/grading never pass.
- **SC-004**: Two compatible reports show attributable differences and changed configuration; incompatible cases/graders are refused with reasons.
- **SC-005**: Operator can submit, inspect, approve/reject, resume and inspect results without duplicate effects or protected-data exposure.
- **SC-006**: Every required host capability has a positive controlled witness and a missing/stale/substituted witness that causes zero forbidden downstream effects; no controlled witness is reported as real readiness.
- **SC-007**: Repeated dispatch/control requests create at most one effect and one applicable charge; all exercised stale evidence, changed identities, fourth-replan and unsupported-recovery cases withhold completion.

## Assumptions and Exclusions

Start with one configured local Python/pytest case. No GitHub sync, arbitrary repository import, hosted multi-user service, automatic merge, new persistence owner, broad benchmark or full C01–C17/restart claim. Console follows real-route proof but stays in scope. Existing UC-03 ledgers retain their acceptance ownership; this feature does not mark them complete.

Custom public bug submissions are limited to configured repositories/check sets. They exercise the same workflow but are not frozen acceptance cases: show exploratory outcome and independent grade not-run, without inventing suite coverage. Catalog evaluation is immutable; material changes to its input/criteria require a newly pinned case version and cannot overwrite its existing attempt.

## Host-composition remediation — 2026-11-04

This targeted amendment closes verified gaps in US1; it does not add a second workflow or expand console/comparison scope. [Host contract](contracts/host-composition.md) and T019–T034 define the proposed work. Existing T001–T010 statuses are historical controlled evidence; they do not establish the new acceptance criteria. T011 remains the sole first-real-repair acceptance task. Existing UC-03 T024/T025/T026/T028/T066 and external owner gates retain their acceptance ownership. The 2026-11-04 request that produced this amendment authorized planning, validation and independent review only; the later same-day direction recorded in [decisions](contracts/decisions.md) separately released T020–T034 implementation at source/controlled tier and nothing beyond it.
