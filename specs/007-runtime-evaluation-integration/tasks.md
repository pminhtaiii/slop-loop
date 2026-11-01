# Tasks: Observable Python Repair Evaluation

**Input**: [spec](spec.md), [plan](plan.md), [contract](contracts/integration.md), [release gates](contracts/decisions.md).
**Status**: All implementation tasks proposed/unreleased. Task checkboxes record acceptance, never permission. Tests are required by FR-011 and existing repository TDD policy.

## Phase 1: Setup

- [ ] T001 Define validated profile/catalog and exposure derivation in src/runtime/evaluation-profile.ts and tests/runtime/unit/evaluation-profile.test.ts.
  - **Dependencies**: None.
  - **Owned Paths**: src/runtime/evaluation-profile.ts; tests/runtime/unit/evaluation-profile.test.ts.
  - **Acceptance Checks**: Contract sections 1/2; explicit finite limits, contained local catalog, real snapshot identities, missing fixtures/pricing denial, safe credential references, integer upward cost derivation/overflow. Typed catalog/custom bug input, configured repository/check-set binding and incomplete intake with no task/effects. No user economic cap; derivation covers all permitted coder/reviewer calls, caches and uncertainty.

## Phase 2: Foundational

- [ ] T002 Add versioned workflow reports and scoped execution admission to eval/uc03/types.ts, eval/uc03/validation.ts, eval/uc03/results.ts, eval/uc03/runner.ts, eval/shared-types.ts and eval/shared.ts with tests/runtime/unit/evaluation-report-v1.test.ts.
  - **Dependencies**: T001.
  - **Owned Paths**: eval/uc03/types.ts; eval/uc03/validation.ts; eval/uc03/results.ts; eval/uc03/runner.ts; eval/shared-types.ts; eval/shared.ts; tests/runtime/unit/evaluation-report-v1.test.ts.
  - **Acceptance Checks**: Sections 3–5, FR-007–009; tagged overload, pause/unknown effects/usage, selected vs suite acceptance, real capability receipt validation, forged real denial. Expected C02 wait predicate yields case/selected pass while task stays paused; unresolved C01 wait stays pending. Existing legacy/UC-01 behavior preserved. No global real-mode switch or flag-only authority.

- [ ] T003 Implement actual DeepSeek transport in src/foundation/deepseek-transport.ts and tests/runtime/unit/deepseek-transport.test.ts.
  - **Dependencies**: T001.
  - **Owned Paths**: src/foundation/deepseek-transport.ts; tests/runtime/unit/deepseek-transport.test.ts.
  - **Acceptance Checks**: Section 2; exact HTTPS endpoint/origin, redirects denied, host-only credentials, thinking-disabled nonstreaming JSON, strict content/request/model/usage parsing, conservative admission before dispatch, timeout after possible dispatch charged uncertain, no automatic retry or secret logs. Controlled HTTP responses are not real-model evidence.

- [ ] T004 Implement actual Docker controller in src/foundation/docker-controller.ts and tests/runtime/unit/docker-controller.test.ts.
  - **Dependencies**: T001.
  - **Owned Paths**: src/foundation/docker-controller.ts; tests/runtime/unit/docker-controller.test.ts.
  - **Acceptance Checks**: Sections 1/3; existing lifecycle/view/executor contract, structured argv/no shell, profile/image/platform pinning, fresh workspaces, read-only admitted views, scratch-only writes, resource/network/secret boundaries and safe cleanup preserving uncertain evidence. Unit checks do not replace T024 containment proof.

- [ ] T005 Implement read-only runtime reviewer in src/foundation/reviewer.ts and tests/runtime/unit/runtime-reviewer.test.ts.
  - **Dependencies**: T003.
  - **Owned Paths**: src/foundation/reviewer.ts; tests/runtime/unit/runtime-reviewer.test.ts.
  - **Acceptance Checks**: Section 2; fresh role/context, bounded admitted model calls, shared task usage/reviewer iteration accounting, real diff-line validation and rejected write/tool authority. No provider-mode bypass or canned acceptance.

- [ ] T006 Compose accepted public owner capabilities in src/runtime/evaluation-composition.ts and tests/runtime/contract/evaluation-composition.test.ts.
  - **Dependencies**: T001, T002, T003, T004, T005.
  - **Owned Paths**: src/runtime/evaluation-composition.ts; tests/runtime/contract/evaluation-composition.test.ts; src/foundation/model-v02.ts; tests/runtime/unit/model-v02-production.test.ts.
  - **Acceptance Checks**: G-OWNERS/G-PROFILE for real tier; exact state/evidence/approval/admission capabilities, durable reservation/settlement and charged uncertainty, version compatibility and explicit actor/fencing. Complete real-capable v0.2 composition and conformance, not a provenance relabel. Missing/incompatible delivery refuses before effects. Controlled seams may be tested before owner delivery; real capability remains unavailable. UC-04/UC-05 implementation is external, not owned here.

## Phase 3: User Story 1 - Actual workflow evaluation

**Goal**: Controlled graph-backed evidence followed by one real Python repair.
**Independent test**: SC-001; real acceptance requires named owner/profile/route/isolation/approval gates. No requirement to complete T028 before attempting its proof; T028 and this feature share actual result evidence, each judged against its own criteria.

- [ ] T007 [US1] Add bounded coder generation in src/uc03/agent.ts and tests/runtime/unit/uc03-agent.test.ts.
  - **Dependencies**: T003, T006.
  - **Owned Paths**: src/uc03/agent.ts; tests/runtime/unit/uc03-agent.test.ts.
  - **Acceptance Checks**: Section 2, FR-003; exact inspect/plan/patch/info/stop schemas and byte/list/action bounds, malformed/extra/absolute-path/multiple-action rejection before effects, admitted tools, no private oracle/reference patch, exact evidence/state binding, model-output failures counted, no model calls during human wait, finite task calls/active time/repairs/replans. Actual provider tests stay separately opt-in.

- [ ] T008 [US1] Wire generation and continuation into src/uc03/graph-nodes.ts, src/uc03/graph-types.ts and src/uc03/graph-feedback.ts with tests/runtime/unit/uc03-agent-route.test.ts.
  - **Dependencies**: T007, T005.
  - **Owned Paths**: src/uc03/graph-nodes.ts; src/uc03/graph-types.ts; src/uc03/graph-feedback.ts; tests/runtime/unit/uc03-agent-route.test.ts.
  - **Acceptance Checks**: US1.2–4/6; real profile refuses supplied plan/patch/replan/repair answers, obtains model proposals, preserves explicit exact plan/action approval, baseline/check protection, fresh post-patch authority, bounded repair/replan and final completion predicate. Existing controlled route remains testable. Relevant T026/T066 defects stay assigned to original ledger and must close before real tier; do not silently mark them fixed here.

- [ ] T009 [US1] Connect graph-backed driver/service in eval/uc03/workflow-driver.ts, eval/uc03/registration.ts and src/runtime/evaluation-service.ts with tests/runtime/unit/workflow-evaluation.test.ts.
  - **Dependencies**: T002, T006, T008.
  - **Owned Paths**: eval/uc03/workflow-driver.ts; eval/uc03/registration.ts; src/runtime/evaluation-service.ts; tests/runtime/unit/workflow-evaluation.test.ts.
  - **Acceptance Checks**: Sections 1/3/4; invoke actual graph, immutable catalog/custom submission, complete intake before task allocation, fresh workspace, single experiment, duplicate/stale input/answer/direction/continue receipts, questions bound to immutable input, UC-05 explicit control issuance, answers not approval/resume, waiting/usage/effects, zero-dispatch preflight. Custom runs stay ungraded; material catalog input changes cannot reuse grading. Controlled tests exercise actual graph, not fabricated CaseResults. No private payload in public context.

- [ ] T010 [US1] Add independent snapshot grader in eval/uc03/workflow-grade.ts and tests/runtime/unit/workflow-grade.test.ts.
  - **Dependencies**: T004, T009.
  - **Owned Paths**: eval/uc03/workflow-grade.ts; tests/runtime/unit/workflow-grade.test.ts.
  - **Acceptance Checks**: Sections 3/4; repair-success baseline/check/test-protection/review/diff evidence; distinct expected-clarification/refusal/exhaustion/regression predicates can pass without claiming repair. Hidden checks bind frozen applicable snapshot/evidence, isolated execution, mutation invalidation, forged receipt/missing grader refusal, no grader data/hints. Custom submissions stay ungraded. Real isolation acceptance remains G-ISOLATION.

- [ ] T011 [US1] Expose and prove real first-case operation in src/cli/evaluate.ts and tests/runtime/integration/evaluation-success.test.ts.
  - **Dependencies**: T009, T010.
  - **Owned Paths**: src/cli/evaluate.ts; tests/runtime/integration/evaluation-success.test.ts; tests/runtime/unit/evaluation-cli.test.ts.
  - **Acceptance Checks**: G-OWNERS/G-ROUTE/G-PROFILE/G-ISOLATION/G-APPROVAL; actual Python case, provider/model, state, gate, tools, reviewer and grader. No solution injection. SC-001 and existing T028 C01/C02/C16/C10 predicates, explicit decisions, durable pre-network reservation/settlement and no mock fallback. Capture exact candidate/profile/image/model/owner/evidence identities. Missing prerequisites are not-run/nonzero; one actual successful repair required. CLI tests prove C02 expected-wait selected pass/exit 0 with task paused versus C01 unresolved-wait pending/exit 3; suite remains incomplete. Existing T024/T025 proofs consumed, not replaced.

## Phase 4: User Story 2 - Diagnosis and Comparison

**Goal**: Explain observed failures and compare experiments without hiding missing coverage.
**Independent test**: SC-002–004 via controlled fault matrix plus two explicitly identified real attempts when admitted.

- [ ] T012 [US2] Preserve safe stage/component diagnostics in src/runtime/evaluation-diagnostics.ts, src/uc03/graph.ts and tests/runtime/unit/evaluation-diagnostics.test.ts.
  - **Dependencies**: T009.
  - **Owned Paths**: src/runtime/evaluation-diagnostics.ts; src/uc03/graph.ts; tests/runtime/unit/evaluation-diagnostics.test.ts.
  - **Acceptance Checks**: Section 5; preserve available milestones/refs through errors, bounded known component codes, unknown attribution/effects, no raw exceptions/secret payloads. Test provider/tool/state/approval/model-output failures separately from pytest/review failures; safe failures never fabricate root cause.

- [ ] T013 [US2] Extend comparisons in eval/uc03/compare.ts and tests/runtime/unit/workflow-comparison.test.ts.
  - **Dependencies**: T002, T009.
  - **Owned Paths**: eval/uc03/compare.ts; tests/runtime/unit/workflow-comparison.test.ts.
  - **Acceptance Checks**: Sections 4/5; differing config allowed only when suite, report contract version, execution mode, case set/order/digests, manifest/case cardinality, repository, grader and per-case expected outcomes all match; any failed guard refuses comparison; report all changed factors/confounding; strict option and legacy compatibility; unknown metrics stay unknown, waits/nonselection retain coverage. No statistical quality claim from one pair.

- [ ] T014 [US2] Verify failure attribution and two-run evidence in tests/runtime/integration/evaluation-failures.test.ts and tests/runtime/integration/evaluation-comparison.test.ts.
  - **Dependencies**: T010, T011, T012, T013.
  - **Owned Paths**: tests/runtime/integration/evaluation-failures.test.ts; tests/runtime/integration/evaluation-comparison.test.ts.
  - **Acceptance Checks**: All US2 scenarios; controlled absent-provider/tool-denial/malformed-output/test-regression/stale-approval/uncertain-effect/unknown-usage cases and explicit tiers; no forbidden effects. Expected incomplete/refusal grades pass only their safe predicates, never verified repair. Two compatible real attempts use fresh tasks but identical initial case/repo/grader; capture actual outcomes even if repair fails. Selected pass/full-suite incomplete shown. Required not-run never auto-skips/passes.

## Phase 5: User Story 3 - Operator Console

**Goal**: Interactive local operation on the same service.
**Independent test**: SC-005, controlled browser contract tests and actual admitted first-route browser journey. UI development can use controlled service injection; real acceptance follows G-REAL.

- [ ] T015 [US3] Implement protected local server in src/runtime/console-server.ts and tests/runtime/unit/evaluation-console.test.ts.
  - **Dependencies**: T009, T012, T013.
  - **Owned Paths**: src/runtime/console-server.ts; tests/runtime/unit/evaluation-console.test.ts.
  - **Acceptance Checks**: Section 6 endpoints including public custom bug, bound answers and explicit direction issuance; loopback/token/exact origin-host, idempotency/version/CAS, bounds/artifact allowlist. Cross-origin/rebinding/traversal/forged decision denies before owner/tool effects. No credentials/prompts/private artifacts served. UC-05 presentation/decision/control remain authoritative; answers cannot resume.

- [ ] T016 [US3] Build local operator page in src/runtime/console-page.ts and tests/runtime/unit/evaluation-console-page.test.ts.
  - **Dependencies**: T015.
  - **Owned Paths**: src/runtime/console-page.ts; tests/runtime/unit/evaluation-console-page.test.ts.
  - **Acceptance Checks**: US3 journeys; prepared-case/bug submission, readiness, milestones, explicit decisions/directions, safe diff/tests/diagnostics/usage, selection-vs-suite and comparison. Escaped text rendering, no browser authority/config editor, no double-submit effects, accessible labeled controls and keyboard operation.

- [ ] T017 [US3] Verify end-to-end operator journey in tests/runtime/integration/evaluation-console-journey.test.ts.
  - **Dependencies**: T011, T014, T016.
  - **Owned Paths**: tests/runtime/integration/evaluation-console-journey.test.ts.
  - **Acceptance Checks**: Actual browser catalog and custom-bug submission, clarification -> bound answer -> explicit control -> continuation, approval pause/current decision/result, rejection -> explicit revise/resume/end as permitted by current owner state. Stale/duplicate/missing-question commands cannot act. Custom input stays exploratory; material catalog change cannot reuse grade. Controlled browser evidence separately labeled; real route requires G-REAL. Use installed tooling or human-driven evidence; refresh is not restart.

## Phase 6: Cross-Cutting Verification and Handoff

- [ ] T018 Complete acceptance/context refresh in specs/007-runtime-evaluation-integration/quickstart.md, context/testing.md, context/architecture.md, context/tech_stack.md and context/progress_checker.md.
  - **Dependencies**: T014, T017.
  - **Owned Paths**: specs/007-runtime-evaluation-integration/quickstart.md; context/testing.md; context/architecture.md; context/tech_stack.md; context/progress_checker.md.
  - **Acceptance Checks**: Run required source/emitted/full gates on exact candidate; independent review, context updater, scoped PR publication per workflow. Record actual real/not-run results, revisions/limits and old-ledger mappings without claiming full C01–C17/restart. No source fixture/artifact publication. Contributor completion remains published linked PR gate, distinct from feature acceptance.

## Dependencies

The per-task dependency lists above are authoritative and define the acyclic implementation graph. External release gates are additional requirements.

## Parallel Opportunities

After T001, T002/T003/T004 have disjoint ownership; after T009, T012/T013 have disjoint ownership. No unconditional parallel markers are used: prerequisites and actual active ownership must pass dispatch checks first. Console service work can proceed controlled while real external gates are pending, but its real acceptance cannot pass early.

External gates are not fake task IDs. UC-03 T026/T066 corrections, T024/T025 proofs and X04/X05 delivery are prerequisites for real T011, not tasks silently implemented here. If corrections touch shared paths, serialize with the owner before T008/T012. No feature task is currently authorized for implementation.

## Implementation Strategy

First release candidate: T001–T010 for controlled graph-backed integration and generation evidence. Then real prerequisite proofs and T011 establish the first useful real milestone. Add T012–T014 diagnostic/comparison evidence and T015–T017 console. T018 closes acceptance/publication separately. Keep every unmet gate visible rather than broadening scope or relaxing completion rules.
