# Tasks: UC-04 — Multi-step Feature with Resume

**Input**: [spec](spec.md), [plan](plan.md), [research](research.md), [data model](data-model.md), [interfaces](contracts/interfaces.md), [acceptance](contracts/acceptance.md), [decisions](contracts/decisions.md).

**Status**: T001–T012 authorization is recorded in decisions.md; checkboxes record completion, not authorization. This is a conditional future implementation ledger, not work performed by the specification request. Authoring delegation, historical shared agreement and passing planning checks release no task. Each phase needs explicit G-AUTH; new contract/path/test seams need G-EXTENSION. Backend-dependent work must first receive a plan/ledger amendment naming actual selected adapter paths. No runtime paths below are created in this assignment.

**Tests**: Required by FR-015. After authorization and seam confirmation, use vertical behavioral RED/GREEN through actual owned public exports; neutral loadable scaffolds are permitted only then. Missing imports/type errors are not behavioral RED. Retain prior regressions. Coordinator alone updates completion after integrated evidence; implementation workers do not change checkboxes.

## Format: `[ID] [P?] [Story] Description`

Thanh Tan is accountable for local tasks, including proposed persistence paths. Shared owners review their contracts without transferring foreign file authority. `[P]` denotes disjoint paths at a ready dependency frontier; no uncompleted dependency or external gate is waived.

## Phase 1: Setup and agreement

**Goal**: Obtain actual approval of this proposed extension without repeating accepted behavioral interviews.

- [x] T001 Record phase authorization, extension/path/seam agreements and release decisions in specs/037-uc04-recovery/contracts/decisions.md.
  - **Dependencies**: None; external G-AUTH/G-EXTENSION.
  - **Owned Paths**: specs/037-uc04-recovery/contracts/decisions.md; specs/037-uc04-recovery/contracts/interfaces.md; specs/037-uc04-recovery/data-model.md; specs/037-uc04-recovery/plan.md; specs/037-uc04-recovery/tasks.md; specs/037-uc04-recovery/quickstart.md.
  - **Acceptance Checks**: Preserve inherited canonical/companion contracts; confirm new deliberate-pause sidecar/epoch composition, exact schemas/receipts, public test seams and paths with Thanh Tan/Tai/Trong Tan. Record G-STORE/G-CONTROL/G-PROFILE/G-RETENTION decisions only if actually supplied; amendment names chosen adapter/test paths before T004. No foreign runtime edit or inferred grant.

## Phase 2: Foundational contracts, scenarios and durable store

**Goal**: Shared validated contracts/cases and a selected real transactional authority; no memory-only durability substitute.

- [x] T002 [P] Implement recovery extension validators test-first in src/persistence/contracts.ts and tests/runtime/uc04/contracts.test.ts.
  - **Dependencies**: T001.
  - **Owned Paths**: src/persistence/contracts.ts; tests/runtime/uc04/contracts.test.ts.
  - **Acceptance Checks**: Reuse canonical/UC-05 validators unchanged; R01,R02,R13,R15 reject unknown/unsafe/incompatible fields, invalid/cyclic/foreign predecessor refs, invalid steps/summary/identity/budgets and malformed receipts. No new permission class or foreign schema fork. Cover every proposed extension operation's request/result validation.

- [x] T003 [P] Register versioned recovery cases and controlled external seams in tests/runtime/support/uc04/scenarios.ts and tests/runtime/support/uc04/controlled-ports.ts.
  - **Dependencies**: T001.
  - **Owned Paths**: tests/runtime/support/uc04/scenarios.ts; tests/runtime/support/uc04/controlled-ports.ts.
  - **Acceptance Checks**: R01–R16 registry with fixture/oracle/profile IDs, expected counts, acknowledged failpoints and evidence levels. Only external approval/repository/verification/usage behavior is scripted; UC-04 SUT is real. Mock provenance and protected-data restrictions explicit; no foreign fixture edits or real repository effects. Validate against T002 at T004 join.

- [x] T004 Implement the transactional facade and selected durable adapter test-first behind src/persistence/store.ts with tests/runtime/uc04/store.test.ts.
  - **Dependencies**: T002, T003; external G-STORE and exact adapter-path plan amendment approved at T001.
  - **Owned Paths**: src/persistence/store.ts; tests/runtime/uc04/store.test.ts.
  - **Acceptance Checks**: Implement load/register/CAS/coherent checkpoint transactions plus primitives used by accounting/control/outcome operations. Pass canonical StatePort conformance without alternate schema. Validate task refs and lost-response idempotency; R01,R02,R08,R13 concurrency/atomic failure/corruption. Actual backend files/migrations/tests require enumerated owned-path amendment before work; this task cannot be completed on a facade/mock alone. A selected durable backend is required but no backend selected here.

## Phase 3: User Story 1 — Restore progress (Priority: P1)

**Goal**: Restore coherent progress and determine a safe next action. **Independent Test**: R03,R09,R13 through actual recovery with saved-state inputs; actual restart at T012.

- [x] T005 [US1] Write recovery behavioral RED against loadable src/persistence/recovery.ts in tests/runtime/uc04/recovery.test.ts.
  - **Dependencies**: T004.
  - **Owned Paths**: src/persistence/recovery.ts; tests/runtime/uc04/recovery.test.ts.
  - **Acceptance Checks**: One neutral tracer then vertical slices: completed-step retention, predecessor-readiness zero-dispatch/valid-proof positive oracle before/after restore, repository/view drift, apparently complete work with available/unavailable verification, corrupt/missing authority and safe blockers. Test actual UC-04 exports, not a mocked recovery implementation; transfer source/test ownership to T006.

- [x] T006 [US1] Implement coherent restore and next-action validation in src/persistence/recovery.ts and tests/runtime/uc04/recovery.test.ts.
  - **Dependencies**: T005.
  - **Owned Paths**: src/persistence/recovery.ts; tests/runtime/uc04/recovery.test.ts.
  - **Acceptance Checks**: R02–R05,R09,R13 through real store primitives and controlled external evidence. Recompute dependency readiness after restore/drift: unfinished/missing/invalidated predecessor proof gives zero dependent claim/dispatch; all valid completed prerequisites allow an eligible attempt while independent work remains possible. Preserve newest authority over stale checkpoint, no unaffected completed-step replay or drift overwrite; invalidate affected evidence/approval via owning seam. Recovery calls injected accounting/control capabilities whose actual implementations arrive at T008/T010; deny unavailable capabilities. Automatic continuation only after every hold/prerequisite clears; simulation remains labeled.

## Phase 4: User Story 2 — Pause and preserve human control (Priority: P1)

**Goal**: Independent task pause composes with existing approval holds. **Independent Test**: R06–R08 with task A/B, in-flight outcomes and store races; actual process evidence at T012.

- [x] T007 [US2] Implement deliberate-pause and inherited approval transactions test-first in src/persistence/task-control.ts and tests/runtime/uc04/control.test.ts.
  - **Dependencies**: T004; external G-CONTROL.
  - **Owned Paths**: src/persistence/task-control.ts; tests/runtime/uc04/control.test.ts.
  - **Acceptance Checks**: Actual UC-04 transactions implement UC-05 load/read/create/resolve/replace/direction contract, preserving immutable identity/history/outbox, one pending winner, stale retirement and duplicate/conflict behavior. Add agreed pause/resume sidecar and shared epoch transaction, no new approval-mode enum. Present paused immediately after accepted control boundary, record bounded outstanding work and decline early resume. No new control CLI without owner amendment.

- [x] T008 [US2] Complete task-control race and restart-preparation tests in tests/runtime/uc04/control.test.ts and src/persistence/task-control.ts.
  - **Dependencies**: T007.
  - **Owned Paths**: tests/runtime/uc04/control.test.ts; src/persistence/task-control.ts.
  - **Acceptance Checks**: R06–R08 lost/uncertain receipt, pause/claim winner, duplicated decision/direction after newer pause/end, no runnable gap, unrelated-task progress and separate holds. Approval cannot clear deliberate pause; UC-04 resume cannot release rejection/wait/recovery. Cancellation/outcome callbacks never reopen admission. Scripted external controls remain non-production evidence.

## Phase 5: User Story 3 — Durable accounting and uncertain effects (Priority: P1)

**Goal**: One cumulative ledger and explicit reconciliation. **Independent Test**: R04–R05,R10–R11 with original request/role/config IDs; actual kill windows at T012.

- [x] T009 [US3] Implement atomic multi-budget reservation and settlement test-first in src/persistence/accounting.ts and tests/runtime/uc04/accounting.test.ts.
  - **Dependencies**: T004.
  - **Owned Paths**: src/persistence/accounting.ts; tests/runtime/uc04/accounting.test.ts.
  - **Acceptance Checks**: reserveAll/recordAndSettle use store-owned transactions, full task/run budget sets and exact idempotent receipts; no partial dispatch authority. Independent coder/reviewer token/cost/iteration checks, repair and replan retention, original pricing even on invalid output, config reload no reset; explicit authorized increases retain old history. Missing/inconsistent/exhausted accounting denies before effect.

- [x] T010 [US3] Add dispatch claims and uncertain-outcome reconciliation in src/persistence/accounting.ts and tests/runtime/uc04/accounting.test.ts.
  - **Dependencies**: T009, T008.
  - **Owned Paths**: src/persistence/accounting.ts; tests/runtime/uc04/accounting.test.ts.
  - **Acceptance Checks**: R04–R05,R08,R10–R11: shared epoch/claim transaction composes approved control protocol; no duplicate attempt from retried receipt. Reconcile confirmed non-dispatch/completion/usage and evidenced idempotency; unknown/over-bound/conflicting outcomes retain charge and block, never timer-release. No provider idempotency assumption, generic feature replan rule or executor implementation.

## Phase 6: User Story 4 — Safe inspection and compaction (Priority: P2)

**Goal**: Inspect authority and compact advisory reasoning. **Independent Test**: R12,R14–R15 through actual projection/validation, with no state mutation by summary.

- [x] T011 [US4] Implement bounded status/history and compact-summary validation test-first in src/persistence/inspection.ts and tests/runtime/uc04/inspection.test.ts.
  - **Dependencies**: T006, T008, T010.
  - **Owned Paths**: src/persistence/inspection.ts; tests/runtime/uc04/inspection.test.ts.
  - **Acceptance Checks**: All six fields; explicit empty risks allowed; long history, individual omission/conflict cases, metadata-only history, protected markers/unsafe receipts refused. Show goal/completed/hold/outstanding/next action on request, concise failure notifications, no extra successful restore narration. Preserve completed history; deletion unavailable until separately approved G-RETENTION mechanics/tasks. No memory across tasks.

## Phase 7: Integration and cross-cutting evidence

**Goal**: Prove actual foundation restart before claiming external integration.

- [x] T012 Prove durable foundation process restart in tests/runtime/uc04/restart.test.ts and tests/runtime/support/uc04/restart-child.ts.
  - **Dependencies**: T006, T008, T010, T011; external approved G-STORE host/crash/profile contract.
  - **Owned Paths**: tests/runtime/uc04/restart.test.ts; tests/runtime/support/uc04/restart-child.ts; specs/037-uc04-recovery/quickstart.md.
  - **Acceptance Checks**: Real selected store and actual UC-04 modules, controlled external seams only. R01–R16 foundation portions twice, acknowledged kill points, confirmed old PID exit/new process, retained workspace/charge/hold, independent attempt/effect witness, multi-process spend/pause/claim races. Same-process and parent-memory restoration cannot pass. Add exact runnable selected-driver invocation to quickstart; retain raw records ignored. Unsupported cases explicit not-run and block their claim; no power-loss/integrated feature claim.

- [ ] T013 Prove actual UC-05/shared-admission recovery integration in tests/runtime/uc04/integration.test.ts.
  - **Dependencies**: T012; external X05-GATE, X03-ADMISSION, G-PROFILE and explicit joint integration authorization.
  - **Owned Paths**: tests/runtime/uc04/integration.test.ts.
  - **Acceptance Checks**: Actual approved store/UC-05/executor/admission/inspector/verification; R06,R08–R09,R15–R16 and repeated kill windows retain controls/budgets without duplicate effects. Record foreign ledger/config/adapter/source revisions; no foreign source edits. This verifies shared recovery integration, not the later generic feature workflow or all UC-03/UC-05 cases. If adapters absent, prepare cases but leave real results not-run.

- [ ] T014 Record reviewed evidence and scoped delivery handoff in specs/037-uc04-recovery/contracts/decisions.md and specs/037-uc04-recovery/quickstart.md.
  - **Dependencies**: T013.
  - **Owned Paths**: specs/037-uc04-recovery/contracts/decisions.md; specs/037-uc04-recovery/quickstart.md.
  - **Acceptance Checks**: Reconcile all FR/SC/case/evidence levels, actual commands/exits and remaining gates; supply X04-STATE/X04-APPROVAL-STORE/X04-X05-RESTART only at observed scope. Run independent review, appropriate tests/context refresh and contributor publication gates. Context/capability changes require separate approved paths based on actual evidence; never claim later feature/memory complete or merge automatically.

## Dependencies & Execution Order

Per-task Dependencies above are authoritative, including external gates. DAG: T001 → T002/T003 → T004; T004 → T005 → T006; T004 → T007 → T008; T004 → T009; T008 + T009 → T010; T006 + T008 + T010 → T011; these join at T012 → T013 → T014. No cycle or foreign invented T-number.

### Parallel opportunities per story

After T001, only T002/T003 carry `[P]`, with disjoint pre-agreed schemas/scenarios; T004 joins validation. Once T004 and external release gates pass, US1 T005–T006, US2 T007–T008 and US3 T009 have disjoint files and can proceed independently on agreed injected interfaces. US3 T010 joins control; US4 T011 requires all three outputs. Every same-file RED-to-GREEN or refinement handoff is sequential. No tasks write shared foreign modules or root dependency configuration. T012/T013 tests use isolated workspaces and read, rather than edit, accepted runtime modules.

## Implementation Strategy

MVP is a controlled durable foundation through T012, including required safety/compaction stories, not US1 simulation alone. A foundation-only handoff may report that milestone without checking T013/T014. Full integration remains pending until external releases; integrated feature workflow and cross-task memory require newly approved artifacts/task amendments, not execution of vague placeholder tasks here. Current next step is owner review of the planning package, not T001 implementation.
