# Tasks: UC-01 Evidence-backed Issue Triage

**Input**: [spec](spec.md), [plan](plan.md), [research](research.md), [data model](data-model.md), [schema](contracts/schema.md), [interfaces](contracts/interfaces.md), [acceptance](contracts/acceptance.md).
**Status**: DRAFT. All tasks are future work; only planning/publication is authorized. All checkboxes remain open.
**Tests**: Required controlled contract/behavior/evaluation cases. Follow repository test-first guidance after implementation authorization; collection failures do not constitute behavioral RED.
**Ledger**: This is the only implementation task-status ledger. Tickets group tasks into verifiable slices, never a competing checklist of task completion.

## Format and ownership

Sequential T001–T016; story tasks carry [US1], [US2] or [US3]. Thai owns all local tasks; Tai owns shared foundation, Thanh Tan persistence/recovery, Trong Tan approval. External delivery names below are gates, not invented foreign task IDs. Paths are proposed, pending T001 agreement.

`[P]` is reserved for tasks whose dependencies are already complete and whose owned paths are disjoint. **Zero tasks are marked [P] in this initial ledger** because every implementation task has an uncompleted agreement/implementation prerequisite. Future parallel opportunities are described below; markers may be reassessed only at an actually ready frontier. No marker grants implementation authority.

## Phase 1: Setup and agreement

- [ ] T001 Record approved artifacts and consumer-contract/path agreement in specs/002-uc01-issue-triage/contracts/decisions.md.
  - **Owner**: Thai; coordinates Tai, Thanh Tan and Trong Tan.
  - **Dependencies**: None internally; A-ARTIFACTS and X-FOUNDATION-AGREEMENT are external exit gates.
  - **Owned Paths**: specs/002-uc01-issue-triage/contracts/decisions.md; specs/002-uc01-issue-triage/contracts/schema.md; specs/002-uc01-issue-triage/contracts/interfaces.md; specs/002-uc01-issue-triage/plan.md (coordinator-only agreement amendments).
  - **Acceptance Checks**: Record actual approval provenance/version and implementation scope; agree triage model role/signature, evidence locator projection, guarded read/search, accounting/policy/continuation binding, finite fixture profile and path ownership. Keep production choices open until real execution. No shared/runtime changes or fabricated approval. Initial dependency status READY for owner review; implementation permission remains absent.

## Phase 2: Contract validation and controlled mocks

- [ ] T002 Implement assessment-specific contract validators in src/uc01/contracts.ts and tests/runtime/uc01/contract.test.ts.
  - **Owner**: Thai.
  - **Dependencies**: T001.
  - **Owned Paths**: src/uc01/contracts.ts; tests/runtime/uc01/contract.test.ts.
  - **Acceptance Checks**: Behavioral vectors reject malformed/extra fields, invalid catalogs/limits/identity/digests, forged evidence/locators, wrong severity dimensions and model variants. Check all outcome unions and reference consistency against agreed schema; never fork src/contracts/uc03.ts. C13,C14,C22 pass; validation alone authorizes no tool.

- [ ] T003 Create controlled shared-port mocks and call spies in tests/runtime/support/uc01/ports.ts and tests/runtime/uc01/ports.test.ts.
  - **Owner**: Thai; shared owners review conformance.
  - **Dependencies**: T002.
  - **Owned Paths**: tests/runtime/support/uc01/ports.ts; tests/runtime/uc01/ports.test.ts.
  - **Acceptance Checks**: Scripted model/read/search, caller continuation, policy/accounting and safe telemetry ports conform to agreed consumer seam; explicit mock provenance and finite profile. Simulate denial/pause/stale/budget/uncertain usage; record attempted calls including zero on denied admission. No real network/files/commands/storage; replacements T011/T012.

- [ ] T004 Create controlled assessment and evaluation fixtures in tests/runtime/support/uc01/fixtures.ts.
  - **Owner**: Thai; Tai coordinates future shared runner.
  - **Dependencies**: T002.
  - **Owned Paths**: tests/runtime/support/uc01/fixtures.ts; tests/runtime/uc01/fixtures.test.ts.
  - **Acceptance Checks**: C01–C22 fixture inputs/expected semantic assertions include all five severity outcomes, non-defects, conflicting origins, later answers, catalog variants and attacks. Separate model-visible inputs from expected labels; verify records using agreed validators, with explicit test-only finite limits. No held-out labels exposed to model; no live calls.

## Phase 3: User Story 1 - Evidence-backed assessment (Priority: P1)

**Goal**: Complete mock-backed input-to-assessment slice. **Independent Test**: C01–C08 through injected ports; no UC-03 workflow dependency.

- [ ] T005 Bind validated intake and original issue in src/uc01/intake.ts and tests/runtime/uc01/intake.test.ts.
  - **Owner**: Thai.
  - **Dependencies**: T002, T003, T004.
  - **Owned Paths**: src/uc01/intake.ts; tests/runtime/uc01/intake.test.ts.
  - **Acceptance Checks**: One issue/repository, trusted config/workspace and original-report digest; supplied evidence stays reporter-origin and protected text is rejected before context use. Invalid/oversized input makes zero constrained calls. Preserve caller issue without rewrite stage. C01,C08,C22 pass.

- [ ] T006 Implement bounded assessment through shared ports in src/uc01/assess.ts and tests/runtime/uc01/assess.test.ts.
  - **Owner**: Thai.
  - **Dependencies**: T005.
  - **Owned Paths**: src/uc01/assess.ts; tests/runtime/uc01/assess.test.ts.
  - **Acceptance Checks**: Validate classification, severity and three impact dimensions, factual/inferred/unknown assertions and all cited evidence; collect only guarded bounded read/search. C01–C08,C14,C16,C17,C22 pass including no rewrite-only call, zero unsupported tools and charged uncertain usage. Return material questions with trusted binding, complete result or typed failure. Minimal undetermined destination is supported here; configurable recommendation is US3. Mock slice demonstrates assessment, not model quality/production readiness.

## Phase 4: User Story 2 - Clarification across invocations (Priority: P2)

**Goal**: Caller receives questions and supplies later answers. **Independent Test**: C06,C09–C11 using prepared assessment fixtures and mocked continuation owner.

- [ ] T007 Implement question/answer binding in src/uc01/clarify.ts and tests/runtime/uc01/clarify.test.ts.
  - **Owner**: Thai.
  - **Dependencies**: T002, T003, T004.
  - **Owned Paths**: src/uc01/clarify.ts; tests/runtime/uc01/clarify.test.ts.
  - **Acceptance Checks**: Material question affects intent/scope/severity/destination, stable IDs and immutable report binding. Accept subset of same-issue answers as reporter data, reject foreign/duplicate/stale identities before calls. No durable wait/store or action approval. C09–C11 and answer-injection C19 pass independently of assessment implementation.

- [ ] T008 Compose later-invocation reassessment in src/uc01/assess.ts and tests/runtime/uc01/continuation.test.ts.
  - **Owner**: Thai.
  - **Dependencies**: T006, T007.
  - **Owned Paths**: src/uc01/assess.ts; tests/runtime/uc01/continuation.test.ts.
  - **Acceptance Checks**: C06,C09–C11,C18,C19 preserve original report, answer provenance, unresolved questions and task-scoped spending across invocation/run IDs. Revalidate snapshot/config before new evidence; changed binding returns conflict. Simulated continuation provides no restart evidence; real acceptance T012.

## Phase 5: User Story 3 - Configured recommendation (Priority: P3)

**Goal**: Supported recommendation without dispatch. **Independent Test**: C07,C12,C13 with prepared valid assessments and varied catalogs.

- [ ] T009 Implement catalog-constrained recommendation in src/uc01/recommend.ts and tests/runtime/uc01/recommend.test.ts.
  - **Owner**: Thai.
  - **Dependencies**: T002, T003, T004.
  - **Owned Paths**: src/uc01/recommend.ts; tests/runtime/uc01/recommend.test.ts.
  - **Acceptance Checks**: Accept only configured compatible destination with responsibility rationale or undetermined; empty/ambiguous/unsupported catalogs preserve uncertainty and material questions. Reject approval/recovery capabilities as destinations; tests assert zero dispatch. No duplicate backend or repair task creation. C07,C12,C13 pass.

- [ ] T010 Compose recommendation with assessment in src/uc01/assess.ts and tests/runtime/uc01/routing.test.ts.
  - **Owner**: Thai.
  - **Dependencies**: T008, T009.
  - **Owned Paths**: src/uc01/assess.ts; tests/runtime/uc01/routing.test.ts.
  - **Acceptance Checks**: C07,C12,C13 jointly validate classification/severity/destination consistency and clarification; changing trusted catalog changes only valid recommendations. Feature urgency never produces defect severity; no dispatch/approval side effect. All story suites remain independently runnable.

## Phase 6: Real integration and cross-cutting acceptance

- [ ] T011 Compose real shared adapters in src/uc01/compose.ts and tests/runtime/uc01/composition.test.ts.
  - **Owner**: Thai; adapters delivered by external owners.
  - **Dependencies**: T010; external X-READ-MODEL, X04-STATE, X05-GATE and A-PRODUCTION.
  - **Owned Paths**: src/uc01/compose.ts; tests/runtime/uc01/composition.test.ts.
  - **Acceptance Checks**: Record owner-approved contract versions/adapter revisions; bind selected workspace/config/policy and durable accounting. Reject mock/missing/incompatible adapter before constrained call (C20). Consume shared guards; no implementation under src/foundation/, src/persistence/ or src/approvals/.

- [ ] T012 Prove guarded real integration and restart behavior in tests/runtime/uc01/integration.test.ts.
  - **Owner**: Thai; joint evidence with Tai, Thanh Tan and Trong Tan.
  - **Dependencies**: T011; external real-delivery checks for X04-STATE and X05-GATE.
  - **Owned Paths**: tests/runtime/uc01/integration.test.ts.
  - **Acceptance Checks**: C15–C20 prove actual shared reads, policy allowed/pending/reject/forbidden, bound resume and provider usage. Kill/restart after reservation before settlement; no allowance reset/duplicate call, unknown usage remains charged. Mock passes do not satisfy. Paid/live run requires explicit configured authorization; record safe real evidence.

- [ ] T013 Validate receiving-workflow compatibility without dispatch in tests/runtime/uc01/receiver.test.ts.
  - **Owner**: Thai; receiving owner validates projection.
  - **Dependencies**: T010; external X-RECEIVER.
  - **Owned Paths**: tests/runtime/uc01/receiver.test.ts.
  - **Acceptance Checks**: C21 validates receiving input and missing reproduction/criteria; recommendation never becomes a fake executable UC-03 task. Record agreed receiver contract version; no dispatcher or repair implementation. Independent of real shared adapter availability.

- [ ] T014 Add adversarial and finite-execution acceptance in tests/runtime/uc01/safety.test.ts.
  - **Owner**: Thai.
  - **Dependencies**: T010.
  - **Owned Paths**: tests/runtime/uc01/safety.test.ts.
  - **Acceptance Checks**: C14–C19,C22 cover malicious content, unsupported tools, protected data, forged citations, invalid/missing budgets, configured caps and uncertain usage. Assert guard ordering, safe diagnostics and zero unauthorized effects. Deterministic mocks test composition decisions; shared containment/restart enforcement still needs T012 real evidence.

- [ ] T015 Evaluate held-out model quality through shared harness in tests/runtime/uc01/evaluation.test.ts.
  - **Owner**: Thai; Tai owns runner, project owner approves corpus/thresholds.
  - **Dependencies**: T012, T013, T014; external A-EVALUATION and A-PRODUCTION.
  - **Owned Paths**: tests/runtime/uc01/evaluation.test.ts; fixtures/uc01/public/ (public inputs only).
  - **Acceptance Checks**: Approved hidden labels inaccessible to model/tools; compare two machine-readable runs for SC-006 metrics, all severity cases and unsupported claims, clarification/routing accuracy, usage/cost and latency. Numeric thresholds approved before runs. No local replacement runner or new provider transport; retain raw evidence locally, not tracked.

- [ ] T016 Record integration acceptance and context status in specs/002-uc01-issue-triage/quickstart.md and context/progress_checker.md.
  - **Owner**: Thai; coordinator owns ledger/context publication.
  - **Dependencies**: T015.
  - **Owned Paths**: specs/002-uc01-issue-triage/quickstart.md; context/progress_checker.md; docs/use-case-delegation.md; specs/002-uc01-issue-triage/tasks.md (coordinator only).
  - **Acceptance Checks**: Map real immutable revision/config/check evidence to FR/SC; update context through update-context.mjs. Leave unmet tasks/checks open and runtime unverified; fixture or contributor CI cannot prove runtime. Follow separate contributor PR/CI completion gate and human merge policy.

## Dependencies & Execution Order

Internal adjacency (single authoritative DAG; task metadata above has the same edges):

```text
T001 -> T002
T002 -> T003, T004
T003, T004 -> T005, T007, T009
T002 -> T005, T007, T009
T005 -> T006
T006, T007 -> T008
T008, T009 -> T010
T010 -> T011, T013, T014
T011 -> T012
T012, T013, T014 -> T015
T015 -> T016
```

All edges point toward higher task IDs: no cycle. Redundant explicit contract dependency T002 is intentional for consumer tasks. External gates: [decisions](contracts/decisions.md); they are not UC-01 implementation tasks and do not grant ownership of foreign paths.

## Initial readiness and parallel opportunities

- Dependency READY: T001 has no internal prerequisite; owner review can occur, but approval recording must reflect an actual decision.
- BLOCKED internally: T002–T016 have unchecked predecessors. Every implementation task is also unauthorized until A-ARTIFACTS; technical readiness cannot change that.
- MOCK-capable after agreement: T002–T010 and T014; no real foundation prerequisite. T003 is the explicit mock task, T002 explicit validation; T011–T013 explicit real/receiver integration. T013 may use an agreed receiving contract without dispatch but cannot replace missing X-RECEIVER approval.
- After T002 completes, T003 and T004 own disjoint files. After T003/T004, T005, T007 and T009 own disjoint files and can be delegated in parallel. After T010, T011/T013/T014 are disjoint if external gates permit. These are future opportunities, not present `[P]` markings.
- T006/T008/T010 all edit assess.ts and are strictly sequenced. Never parallelize them or shared contract amendments with consumers.

## Implementation Strategy

First demoable ticket groups T001–T006 into assessment with controlled evidence and all severity outcomes; contracts/mocks are prerequisites inside that slice, not isolated horizontal tickets. US2 adds T007–T008; US3 adds T009–T010. Separate real integration, receiver compatibility, adversarial acceptance and evaluation as verifiable later slices. No Issue grants implementation authority merely by being published; initial label needs-triage.
