# Tasks: Evidence-backed repository questions

**Input**: [spec](spec.md), [plan](plan.md), [research](research.md), [data model](data-model.md), [contracts](contracts/decisions.md).
**Authorization**: Planning only. All tasks unchecked; G-PLAN and a subsequent G-IMPLEMENT release required before runtime edits. External G-LIVE/G-QUALITY prerequisites are not waived by controlled checks.
**Tests**: Explicitly required by user; exercise behavior and authority boundaries, not mirror implementation. Contributor batches require registered merger verification and end-of-batch review under the existing workflow when implementation is released.

## Phase 1: Setup

- [ ] T001 Freeze question contracts/validators and schema versions in src/contracts/questions/contracts.ts and src/contracts/questions/validation.ts with contract vectors in tests/runtime/contract/questions.test.ts.
  - **Dependencies**: None; external G-IMPLEMENT required.
  - **Acceptance**: All contract shapes in the three interface documents represented; malformed IDs/ranges/limits/decisions/usage rejected; no repair schema change.
- [ ] T002 Build deterministic disposable Python repository trees and scripted model support in tests/runtime/support/questions/fixtures.ts and tests/runtime/support/questions/scripted-model.ts.
  - **Dependencies**: T001.
  - **Acceptance**: ~1k/~10k/~30k size bands, late definition, three-file flow, docs/config/tests, canaries and isolated target roots; Python never executed; judging data not copied into target.

## Phase 2: Foundational prerequisites

- [ ] T003 Add bounded line spans, match-centered literal search, paged directory access and work/deadline-aware filesystem operations in src/foundation/repository-types.ts, src/foundation/repository-read.ts, src/foundation/repository-tools.ts and src/foundation/host-filesystem-port.ts; cover old/new behavior in tests/runtime/unit/question-repository.test.ts and tests/runtime/unit/repository-tools.test.ts.
  - **Dependencies**: T001, T002.
  - **Acceptance**: repository-tools contract vectors pass; legacy signatures/results retained; guards run, no unbounded directory/digest traversal or unguarded file reopen; unknown adapter capabilities denied before use. Validate immutable snapshot/manifest admission and expected file bytes, including ABA mutation, mutation during acquisition and corrupt manifest tests. Mandatory baseline/regression on existing repository/guard/filesystem suites.
- [ ] T004 Implement Q&A-only repository adapter and binding validation in src/questions/repository.ts with root-isolation/denial/revision tests in tests/runtime/unit/question-repository.test.ts.
  - **Dependencies**: T003.
  - **Acceptance**: Only four read/binding operations exposed; host bindings immutable; cursor forgery/staleness denied; no patch/command/tool escape.
- [ ] T005 Implement cumulative reservations, scan/call/byte/time/token/cost accounting and cancellation in src/questions/budget.ts with tests/runtime/unit/question-budget.test.ts.
  - **Dependencies**: T001, T002.
  - **Acceptance**: Invalid config denies before IO; finite worst-case reservations including snapshot admission; exact settlement/uncertain hold; follow-ups retain ledger; each costly loop charged; late responses ignored. Exact-boundary tests show zero final IO after exhaustion; no source-bearing result without admitted final validation.
- [ ] T006 Implement issued-span registry, citation validation and safe presentation in src/questions/evidence.ts and src/questions/presentation.ts with tests/runtime/unit/question-evidence.test.ts.
  - **Dependencies**: T004, T005.
  - **Acceptance**: Reject unread/forged/copied/wrong-task/wrong-revision citations; full-line coverage and expected snapshot byte digests; final protection checks; no raw trace body leaks; final binding recheck only within admitted remaining budget, otherwise claim-free fallback.

## Phase 3: User Story 1 — Answer with evidence (P1, MVP)

**Goal**: Useful source-grounded answers without implementation names.
**Independent test**: Known symbol, late definition, three-file paraphrase and architecture cases with controlled decisions; later live quality evaluated separately.

- [ ] T007 [US1] Add question model protocol validation and host transport/accounting composition in src/questions/model.ts with malformed output/usage tests in tests/runtime/contract/questions.test.ts.
  - **Dependencies**: T005, T006.
  - **Acceptance**: No fake repair state, no secrets/model-selected authority; deterministic request compiler with exact/certified upper bound includes system/tool/serialization overhead before reservation/dispatch. Accumulated-evidence and mandatory-context overflow tests show fitting selection or claim-free context-limit with zero provider calls; transport output cap enforced. Finite reservations/denied unknown accounting; scripted transport/counter clearly controlled.
- [ ] T008 [US1] Compose sequential LangGraph investigation and final delivery in src/questions/graph.ts with tests/runtime/integration/question-runtime.test.ts.
  - **Dependencies**: T007.
  - **Acceptance**: Search/read/navigation decisions can reach late/cross-file evidence; final claims cited; drift rechecked; unknown tools fail without execution; graph loops bounded by domain counters.

## Phase 4: User Story 2 — Clarify and stop honestly (P1)

**Goal**: Appropriate clarification/uncertainty, no invented goals or activity after stop.
**Independent test**: Ambiguous question/clear control, unsupported premise/author intent, malicious source, write request and exhaustion/cancellation.

- [ ] T009 [US2] Add clarification, insufficient-evidence, blocked, stale, exhausted and cancelled transitions to src/questions/graph.ts and safe results to src/questions/presentation.ts with tests/runtime/integration/question-runtime.test.ts.
  - **Dependencies**: T008.
  - **Acceptance**: Typed outcomes, no partial-search absence claims, cap stops new clarification, waits without background calls, invalid output never delivered as answer; no model retry after exhausted/denied/unknown usage. Exhausted/deadline/cancelled/stale/unknown-accounting/context-limit outcomes contain no source claims/citations and zero post-limit IO.
- [ ] T010 [US2] Add adversarial and clarification behavior fixtures in tests/runtime/support/questions/scripted-model.ts and acceptance vectors in tests/runtime/integration/question-runtime.test.ts.
  - **Dependencies**: T009.
  - **Acceptance**: Expected choices are judgeable for clear/ambiguous controls; cannot access mutation/execution through injected instructions; canaries absent from model-visible evidence/final results/logs.

## Phase 5: User Story 3 — Active-session follow-ups (P2)

**Goal**: Multiple tasks/turns without stale evidence or budget resets.
**Independent test**: Same-revision reuse, ambiguous reference, drift/rebind, switching, compaction and concurrent submissions.

- [ ] T011 [US3] Implement explicit session/task/continuation lifecycle and deterministic bounded context projection in src/questions/session.ts with tests/runtime/unit/question-session.test.ts.
  - **Dependencies**: T009.
  - **Acceptance**: Explicit new task vs continuation; serialized turns; summaries retain intent but cannot mint evidence/budgets; in-memory lifetime only.
- [ ] T012 [US3] Integrate continuation, re-admission, drift/repository switching and cancellation into src/questions/graph.ts and src/questions/session.ts with tests/runtime/integration/question-runtime.test.ts.
  - **Dependencies**: T011, T010.
  - **Acceptance**: Recheck/reissue source spans against admitted immutable snapshot/manifest; same-task drift preserves ledger; switch waits for cancellation/accounting reconciliation, excludes old source text; ABA/current-workspace changes cannot relabel snapshot bytes; no automatic drift loop/restart.

## Phase 6: User Story 4 — Inspectable evaluation (P2)

**Goal**: Diagnose failures and compare finite profiles while keeping judges private.
**Independent test**: Controlled case runs, deliberately wrong semantic claim with valid citation, pending-human/not-run, isolated grading and profile comparison.

- [ ] T013 [US4] Define versioned case/report schemas, 36-case development/regression inventory and explicit fixture profiles in eval/questions/types.ts and eval/questions/cases.ts with tests/runtime/contract/questions.test.ts.
  - **Dependencies**: T002, T012.
  - **Acceptance**: Categories/counts/size distribution/profile fields from evaluation contract; no plaintext held-out material claimed private; separate evaluator-only input required.
- [ ] T014 [US4] Implement isolated case driver, metadata-only diagnostics and configured sanitized result artifacts in eval/questions/runner.ts with tests/runtime/integration/question-evaluation.test.ts.
  - **Dependencies**: T013.
  - **Acceptance**: Case/model/config/repo bindings; no grading data to model; compliant artifact policy required; canary logs tests; controlled vs live tiers explicit; unsupported live prerequisites not-run.
- [ ] T015 [US4] Implement deterministic dimensions and bound semantic/human adjudication in eval/questions/grade.ts with tests/runtime/unit/question-grade.test.ts.
  - **Dependencies**: T014.
  - **Acceptance**: Valid citations cannot pass false claims; disputed/missing semantic judgment pending-human; digest-bound human decisions; no pending/not-run safety failure laundered into success.
- [ ] T016 [US4] Implement profile comparisons in eval/questions/compare.ts with tests/runtime/integration/question-evaluation.test.ts.
  - **Dependencies**: T015.
  - **Acceptance**: Reject incompatible bindings; report denominators/per-case/category/size and each repetition; no automatic production budget selection.

## Phase 7: Polish and cross-cutting verification

- [ ] T017 Verify source/emitted focused suites and existing foundation regression, complete requirement-to-evidence mapping in specs/008-repository-questions/checklists/implementation-evidence.md and run the scenarios in specs/008-repository-questions/quickstart.md.
  - **Dependencies**: T016.
  - **Acceptance**: SC-001–005 controlled evidence retained with candidate identity; SC-006 explicitly not-run without G-LIVE/G-QUALITY. Worker self-checks do not replace independent merger acceptance.
- [ ] T018 Refresh affected context in context/architecture.md, context/architecture-evaluation.md, context/testing.md and context/progress_checker.md using scripts/agents/update-context.mjs with an evidence-based edits file before contributor handoff.
  - **Dependencies**: T017.
  - **Acceptance**: Existing format and evidence tiers preserved; current candidate passes context consistency; published linked PR gate remains separate.

## Dependencies & Execution Order

The per-task dependency declarations above are authoritative; no phase releases its successors without the declared prerequisites and external authorization.

Only T003 and T005 are independent after T002 and own disjoint source/test paths. No task is marked [P] because shared integration is intentionally serialized within phases unless a future coordinator verifies registration/path ownership. US1: T007–T008; US2: T009–T010; US3: T011–T012; US4: T013–T016. Tests for later stories reuse the integrated foundation, not a second ownership implementation.

## Implementation Strategy

MVP = T001–T010 after explicit release, controlled/source tier only. Then sessions T011–T012, evaluator T013–T016 and final verification/refresh T017–T018. No live-model experiment, hidden-set creation by answer agent, production default selection or shared-owner substitute is authorized by this ledger. Each batch follows contributor preparation/manifests/merger/publication gates when released. Scope/numeric contract changes require a refreshed planning candidate and review; workers cannot edit judging criteria to pass.
