# Tasks: Observable Python Repair Evaluation

**Input**: [spec](spec.md), [plan](plan.md), [contract](contracts/integration.md), [release gates](contracts/decisions.md).
**Status**: T001–T011 are released as one batch on 2026-11-01 (Asia/Saigon) for source and controlled-tier tests only; no paid provider call, container execution, real-owner adapter delivery or merge is released. All other tasks remain proposed/unreleased. Task checkboxes record acceptance, never permission. Tests are required by FR-011 and existing repository TDD policy.

## Phase 1: Setup

- [x] T001 Define validated profile/catalog and exposure derivation in src/runtime/evaluation-profile.ts and tests/runtime/unit/evaluation-profile.test.ts.
  - **Dependencies**: None.
  - **Owned Paths**: src/runtime/evaluation-profile.ts; tests/runtime/unit/evaluation-profile.test.ts.
  - **Acceptance Checks**: Contract sections 1/2; explicit finite limits, contained local catalog, real snapshot identities, missing fixtures/pricing denial, safe credential references, integer upward cost derivation/overflow. Typed catalog/custom bug input, configured repository/check-set binding and incomplete intake with no task/effects. No user economic cap; derivation covers all permitted coder/reviewer calls, caches and uncertainty.

## Phase 2: Foundational

- [x] T002 Add versioned workflow reports and scoped execution admission to eval/uc03/types.ts, eval/uc03/validation.ts, eval/uc03/results.ts, eval/uc03/runner.ts, eval/shared-types.ts and eval/shared.ts with tests/runtime/unit/evaluation-report-v1.test.ts.
  - **Dependencies**: T001.
  - **Owned Paths**: eval/uc03/types.ts; eval/uc03/validation.ts; eval/uc03/results.ts; eval/uc03/runner.ts; eval/shared-types.ts; eval/shared.ts; tests/runtime/unit/evaluation-report-v1.test.ts.
  - **Acceptance Checks**: Sections 3–5, FR-007–009; tagged overload, pause/unknown effects/usage, selected vs suite acceptance, real capability receipt validation, forged real denial. Expected C02 wait predicate yields case/selected pass while task stays paused; unresolved C01 wait stays pending. Existing legacy/UC-01 behavior preserved. No global real-mode switch or flag-only authority.

- [x] T003 Implement actual DeepSeek transport in src/foundation/deepseek-transport.ts and tests/runtime/unit/deepseek-transport.test.ts.
  - **Dependencies**: T001.
  - **Owned Paths**: src/foundation/deepseek-transport.ts; tests/runtime/unit/deepseek-transport.test.ts.
  - **Acceptance Checks**: Section 2; exact HTTPS endpoint/origin, redirects denied, host-only credentials, thinking-disabled nonstreaming JSON, strict content/request/model/usage parsing, conservative admission before dispatch, timeout after possible dispatch charged uncertain, no automatic retry or secret logs. Controlled HTTP responses are not real-model evidence.

- [x] T004 Implement actual Docker controller in src/foundation/docker-controller.ts and tests/runtime/unit/docker-controller.test.ts.
  - **Dependencies**: T001.
  - **Owned Paths**: src/foundation/docker-controller.ts; tests/runtime/unit/docker-controller.test.ts.
  - **Acceptance Checks**: Sections 1/3; existing lifecycle/view/executor contract, structured argv/no shell, profile/image/platform pinning, fresh workspaces, read-only admitted views, scratch-only writes, resource/network/secret boundaries and safe cleanup preserving uncertain evidence. Unit checks do not replace T024 containment proof.

- [x] T005 Implement read-only runtime reviewer in src/foundation/reviewer.ts and tests/runtime/unit/runtime-reviewer.test.ts.
  - **Dependencies**: T003.
  - **Owned Paths**: src/foundation/reviewer.ts; tests/runtime/unit/runtime-reviewer.test.ts.
  - **Acceptance Checks**: Section 2; fresh role/context, bounded admitted model calls, shared task usage/reviewer iteration accounting, real diff-line validation and rejected write/tool authority. No provider-mode bypass or canned acceptance.

- [x] T006 Compose accepted public owner capabilities in src/runtime/evaluation-composition.ts and tests/runtime/contract/evaluation-composition.test.ts.
  - **Dependencies**: T001, T002, T003, T004, T005.
  - **Owned Paths**: src/runtime/evaluation-composition.ts; tests/runtime/contract/evaluation-composition.test.ts; src/foundation/model-v02.ts; tests/runtime/unit/model-v02-production.test.ts.
  - **Acceptance Checks**: G-OWNERS/G-PROFILE for real tier; exact state/evidence/approval/admission capabilities, durable reservation/settlement and charged uncertainty, version compatibility and explicit actor/fencing. Complete real-capable v0.2 composition and conformance, not a provenance relabel. Missing/incompatible delivery refuses before effects. Controlled seams may be tested before owner delivery; real capability remains unavailable. UC-04/UC-05 implementation is external, not owned here.

## Phase 3: User Story 1 - Actual workflow evaluation

**Goal**: Controlled graph-backed evidence followed by one real Python repair.
**Independent test**: SC-001; real acceptance requires named owner/profile/route/isolation/approval gates. No requirement to complete T028 before attempting its proof; T028 and this feature share actual result evidence, each judged against its own criteria.

- [x] T007 [US1] Add bounded coder generation in src/uc03/agent.ts and tests/runtime/unit/uc03-agent.test.ts.
  - **Dependencies**: T003, T006.
  - **Owned Paths**: src/uc03/agent.ts; tests/runtime/unit/uc03-agent.test.ts.
  - **Acceptance Checks**: Section 2, FR-003; exact inspect/plan/patch/info/stop schemas and byte/list/action bounds, malformed/extra/absolute-path/multiple-action rejection before effects, admitted tools, no private oracle/reference patch, exact evidence/state binding, model-output failures counted, no model calls during human wait, finite task calls/active time/repairs/replans. Actual provider tests stay separately opt-in.

- [x] T008 [US1] Wire generation and continuation into src/uc03/graph-nodes.ts, src/uc03/graph-types.ts and src/uc03/graph-feedback.ts with tests/runtime/unit/uc03-agent-route.test.ts.
  - **Dependencies**: T007, T005.
  - **Owned Paths**: src/uc03/graph-nodes.ts; src/uc03/graph-types.ts; src/uc03/graph-feedback.ts; tests/runtime/unit/uc03-agent-route.test.ts.
  - **Acceptance Checks**: US1.2–4/6; real profile refuses supplied plan/patch/replan/repair answers, obtains model proposals, preserves explicit exact plan/action approval, baseline/check protection, fresh post-patch authority, bounded repair/replan and final completion predicate. Existing controlled route remains testable. Relevant T026/T066 defects stay assigned to original ledger and must close before real tier; do not silently mark them fixed here.

- [x] T009 [US1] Connect graph-backed driver/service in eval/uc03/workflow-driver.ts, eval/uc03/registration.ts and src/runtime/evaluation-service.ts with tests/runtime/unit/workflow-evaluation.test.ts.
  - **Dependencies**: T002, T006, T008.
  - **Owned Paths**: eval/uc03/workflow-driver.ts; eval/uc03/registration.ts; src/runtime/evaluation-service.ts; tests/runtime/unit/workflow-evaluation.test.ts.
  - **Acceptance Checks**: Sections 1/3/4; invoke actual graph, immutable catalog/custom submission, complete intake before task allocation, fresh workspace, single experiment, duplicate/stale input/answer/direction/continue receipts, questions bound to immutable input, UC-05 explicit control issuance, answers not approval/resume, waiting/usage/effects, zero-dispatch preflight. Custom runs stay ungraded; material catalog input changes cannot reuse grading. Controlled tests exercise actual graph, not fabricated CaseResults. No private payload in public context.

- [x] T010 [US1] Add independent snapshot grader in eval/uc03/workflow-grade.ts and tests/runtime/unit/workflow-grade.test.ts.
  - **Dependencies**: T004, T009.
  - **Owned Paths**: eval/uc03/workflow-grade.ts; tests/runtime/unit/workflow-grade.test.ts.
  - **Acceptance Checks**: Sections 3/4; repair-success baseline/check/test-protection/review/diff evidence; distinct expected-clarification/refusal/exhaustion/regression predicates can pass without claiming repair. Hidden checks bind frozen applicable snapshot/evidence, isolated execution, mutation invalidation, forged receipt/missing grader refusal, no grader data/hints. Custom submissions stay ungraded. Real isolation acceptance remains G-ISOLATION.

- [ ] T011 [US1] Expose and prove real first-case operation in src/cli/evaluate.ts and tests/runtime/integration/evaluation-success.test.ts.
  - **Dependencies**: T009, T010, T030, T031.
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

External gates are not fake task IDs. UC-03 T026/T066 corrections, T024/T025 proofs and X04/X05 delivery are prerequisites for real T011, not tasks silently implemented here. If corrections touch shared paths, serialize with the owner before T008/T012. On 2026-11-01 the user directed Phases 1–3: T001–T011 are authorized as one batch for source and controlled-tier tests (see [authorization](contracts/decisions.md)). Paid calls, container execution, foreign-owner implementation, comparison, console and merge remain unreleased.

## Implementation Strategy

First release candidate: T001–T010 for controlled graph-backed integration and generation evidence. Then real prerequisite proofs and T011 establish the first useful real milestone. Add T012–T014 diagnostic/comparison evidence and T015–T017 console. T018 closes acceptance/publication separately. Keep every unmet gate visible rather than broadening scope or relaxing completion rules.

## Phase 7: Foundational corrections — Host capability contracts

**Status**: T019–T034 are proposed, planning/review only under the 2026-11-04 request. They do not inherit T001–T011's implementation release. FR-013–018 require test-first controlled contract/unit/integration coverage. Write runnable failing behavioral assertions before each implementation; type/import failures are not RED. Run typecheck/build and the named source tests plus their emitted counterparts. External signoff/delivery is additional to the acyclic internal dependencies; absent delivery leaves production unavailable.

- [ ] T019 Record exact owner-reviewed supplemental capability and migration agreement in specs/007-runtime-evaluation-integration/contracts/host-composition.md and specs/007-runtime-evaluation-integration/contracts/decisions.md.
  - **Dependencies**: None.
  - **Owned Paths**: specs/007-runtime-evaluation-integration/contracts/host-composition.md; specs/007-runtime-evaluation-integration/contracts/decisions.md.
  - **Acceptance Checks**: Tai/Thanh Tan/Trong Tan explicitly agree exact version/revision/public surfaces for read fencing, baseline evidence write/read, current action observation, view identity, material replan transaction, approval presentation/control and uncertainty lookup. Record provenance and separate controlled implementation release. Owner implementations/delivery are external, not this task's work. Current planning reviews do not check this task. If canonical signatures need change, obtain targeted owner amendment/review before dependent implementation.

- [ ] T020 Define explicit production port/coder types in src/uc03/graph-types-v02.ts, src/uc03/agent-types.ts and tests/runtime/contract/uc03-production-ports.test.ts.
  - **Dependencies**: T019.
  - **Owned Paths**: src/uc03/graph-types-v02.ts; src/uc03/agent-types.ts; tests/runtime/contract/uc03-production-ports.test.ts.
  - **Acceptance Checks**: Contract sections 1/2/4; additive versioned types require complete model/repository admission and owner supplements. Compile fixtures keep legacy callers compiling while missing/v0.1 context cannot satisfy the production surface; runtime tests reject missing/substituted public capabilities. No required v0.1 interface expansion or implicit production compatibility.

- [ ] T021 Produce fenced guarded reads in src/foundation/guarded-read-capability.ts and tests/runtime/unit/guarded-read-capability.test.ts.
  - **Dependencies**: T020.
  - **Owned Paths**: src/foundation/guarded-read-capability.ts; tests/runtime/unit/guarded-read-capability.test.ts.
  - **Acceptance Checks**: Section 3 guarded reads; current owner identity/control/policy before exactly one closure invocation. Cover valid list/read/search, unknown operation, task/workspace/revision mismatch, paused/fenced/drifting control, malformed path/query and missing/invalid finite bounds. Race witness changes control between observation/dispatch; owner-agreed fencing prevents closure. Persisted control remains unchanged on denial; repository filtering/containment tests remain intact. No execute-through capability.

- [ ] T022 Produce trusted snapshots in src/runtime/trusted-host-snapshot.ts and tests/runtime/unit/trusted-host-snapshot.test.ts.
  - **Dependencies**: T020.
  - **Owned Paths**: src/runtime/trusted-host-snapshot.ts; tests/runtime/unit/trusted-host-snapshot.test.ts.
  - **Acceptance Checks**: Section 3 trusted snapshot; actual measured revision/check/test identities, configured expected inventory, bounded files. Test valid identity, forged task digest, changed/missing protected tests, revision drift mid-measurement, symlink/junction escape and unreadable/oversized file; no partial trusted snapshot or command/provider call. Unsupported platform proof stays explicit.

- [ ] T023 Consume owner baseline evidence in src/runtime/baseline-evidence-adapter.ts and tests/runtime/contract/baseline-evidence-adapter.test.ts.
  - **Dependencies**: T020.
  - **Owned Paths**: src/runtime/baseline-evidence-adapter.ts; tests/runtime/contract/baseline-evidence-adapter.test.ts.
  - **Acceptance Checks**: Section 3 baseline; exact durable acknowledgement plus lookup for continuation. Valid write/read matches all canonical identity/digest/check fields; forged/stale/partial ack, duplicate conflicting ID, uncertain write and absent lookup block without synthetic success or fallback storage. Controlled tests are not actual owner durability/restart delivery; accepted UC-04 public writer is an external prerequisite.

- [ ] T024 Produce observed action context in src/runtime/host-action-context.ts and tests/runtime/unit/host-action-context.test.ts.
  - **Dependencies**: T020, T022.
  - **Owned Paths**: src/runtime/host-action-context.ts; tests/runtime/unit/host-action-context.test.ts.
  - **Acceptance Checks**: Section 3 observed actions; host-only registration/observation with current measured facts/elements feeds existing real context provider. Unknown/cross-task/replaced action, revision drift, expired authority and fabricated caller facts refuse. Continuation re-observes current facts; changed action cannot reuse a decision. No policy evaluation/decision generation/real-provenance guard weakening in this task.

- [ ] T025 Bind command views to accepted owner measurements in src/foundation/docker-view-builder.ts and tests/runtime/contract/command-view-owner-binding.test.ts.
  - **Dependencies**: T020, T022.
  - **Owned Paths**: src/foundation/docker-view-builder.ts; tests/runtime/contract/command-view-owner-binding.test.ts.
  - **Acceptance Checks**: Section 5; round-trip exact exclusions/scratch/admitted digests/revision/read-only/isolation facts through a supplied owner seam. Test legitimate nonliteral values and mismatches in each field; mismatch yields zero executor calls and unchanged accounting. UC-04 removal of hardcoded admission literals is an external delivered correction, not permission to edit its implementation here. Existing Docker view regressions remain green; no T024 real containment claim.

## Phase 8: User Story 1 — Production consumer corrections and assembly

**Goal**: A complete versioned host route, demonstrated with controlled deliveries before real acceptance.
**Independent test**: Actual graph/evaluator plus bounded transport/controller doubles, owner contract fixtures and explicit human decisions; all effects/charges witnessed, all evidence labeled controlled. SC-006/007 do not imply SC-001.

- [ ] T026 [US1] Migrate coder provider/check dispatch in src/uc03/agent.ts and src/uc03/graph-generation.ts with tests/runtime/unit/uc03-coder-v02.test.ts.
  - **Dependencies**: T020, T021.
  - **Owned Paths**: src/uc03/agent.ts; src/uc03/graph-generation.ts; tests/runtime/unit/uc03-coder-v02.test.ts.
  - **Acceptance Checks**: Section 2; exact owner-issued context reaches model fourth argument; model boundary alone claims/begins/settles, graph does not preclaim. Assert one reservation/claim/attempt per request, shared task accounting, no replay after uncertain dispatch, stale/substituted/missing context zero network calls. Preserve sanitized inspect observations, obtain newly evidence-bound admission/request each next turn, and loop within existing finite budgets until purpose-appropriate proposal or explicit wait/stop/failure. Each run-check gets exact fresh repository admission. Graph-backed tests require inspect-read/check -> observed evidence -> next request -> plan/patch, tool denial/uncertainty, exhaustion, request-info wait with zero calls until explicit continuation, and stop withholding completion. Validate canonical provider result and retain legacy controlled behavior.

- [ ] T027 [US1] Migrate the production graph and replan consumers in src/uc03/graph-v02.ts and existing route modules with tests/runtime/integration/uc03-v02-route.test.ts.
  - **Dependencies**: T020, T021, T022, T023, T024, T025, T026, T034.
  - **Owned Paths**: src/uc03/graph-v02.ts; src/uc03/graph.ts; src/uc03/graph-types.ts; src/uc03/graph-nodes.ts; src/uc03/graph-feedback.ts; src/uc03/graph-patch.ts; src/uc03/graph-review.ts; src/uc03/graph-verify.ts; src/uc03/graph-validation.ts; src/uc03/graph-state.ts; src/uc03/graph-transitions.ts; src/uc03/graph-completion.ts; src/uc03/graph-patch-ancestry.ts; src/uc03/investigation.ts; src/uc03/investigation-types.ts; src/uc03/investigation-baseline.ts; src/uc03/investigation-baseline-evidence.ts; src/uc03/investigation-baseline-checks.ts; src/uc03/investigation-plan.ts; src/uc03/investigation-plan-resume.ts; src/uc03/investigation-snapshot.ts; src/uc03/verification.ts; src/uc03/verification-types.ts; src/uc03/verification-context.ts; src/uc03/verification-checks.ts; src/uc03/verification-review.ts; src/uc03/verification-completion.ts; src/uc03/post-patch-verification-authority.ts; src/uc03/repair.ts; src/uc03/repair-types.ts; src/uc03/replan.ts; tests/runtime/integration/uc03-v02-route.test.ts.
  - **Acceptance Checks**: Sections 2–5; migrate every reachable production consumer, explicit current approvals/check/reviewer/patch receipts and baseline restore; no legacy reserve/settle call or test-only duck typing on the production route. Initial plan/nonmaterial clarification zero material charges, accepted revision one durable transaction; canonical candidate payload/schema/digest checked before commit, digest mismatch/same-ID changed content/CAS race refused without mutation, replay returns same committed state and receipts, uncertain owner commit blocks, fourth material replan denied; prior edit authority invalidated and renewed approval required. Repair uses v0.2 arm. Accepted UC-04 transaction/current authority and UC-05 real control remain external. Preserve legacy controlled behavior. Fresh evidence for original UC-03 T026/T066 findings is cross-referenced, not presumed closure.

- [ ] T028 [US1] Assemble pinned deliveries in src/runtime/uc03-host-bootstrap.ts and src/runtime/evaluation-composition.ts with tests/runtime/contract/uc03-host-bootstrap.test.ts.
  - **Dependencies**: T021, T022, T023, T024, T025, T027, T010, T032.
  - **Owned Paths**: src/runtime/uc03-host-bootstrap.ts; src/runtime/evaluation-composition.ts; eval/uc03/workflow-driver.ts; eval/uc03/registration.ts; src/runtime/evaluation-service.ts; tests/runtime/contract/uc03-host-bootstrap.test.ts; tests/runtime/contract/evaluation-composition.test.ts; tests/runtime/unit/workflow-evaluation.test.ts.
  - **Acceptance Checks**: Sections 1/5; return complete explicit production ports/config/resolvers with matching revisions/profiles, including execution guard, baseline writer with required lookup, snapshot, per-action/check/provider/reviewer authority, fenced closure/start lookup and grader. Migrate workflow-driver/registration/service production dispatch to the explicit v0.2 graph entry and its result types, preserving legacy controlled dispatch separately; assembly alone cannot leave the evaluator calling the old graph. Construct only Tai-owned components; consume external owner deliveries. Missing/ambiguous/stale/wrong-contract/wrong-profile/mock or incomplete conformance yields safe unavailable. Static preflight causes zero task/approval/accounting mutation, workspace creation, provider/command/patch effects; after service allocation, per-task binding failure retains blocked state with zero graph/tool/model effects. Production capability cannot be minted from provenance/function names; accepted deliveries must satisfy behavior and evidence binding. Unsupported patch recovery stays blocked.

- [ ] T029 [US1] Wire trusted operator bootstrap in src/cli/evaluate.ts and src/cli/uc03.ts with tests/runtime/unit/uc03-host-cli.test.ts.
  - **Dependencies**: T028, T009.
  - **Owned Paths**: src/cli/evaluate.ts; src/cli/uc03.ts; tests/runtime/unit/uc03-host-cli.test.ts; tests/runtime/unit/evaluation-cli.test.ts.
  - **Acceptance Checks**: Section 6; operator-only configuration loader resolves configured IDs without ports/credentials/policy facts from BugTask. Direct shell preflight/run reaches bootstrap/service; controlled programmatic callers remain supported. Actual missing prerequisites produce evaluation exit 4 / legacy UC03 exit 5, malformed input 2; C02 expected-wait 0 with task paused versus unresolved C01 wait 3. Decision records choice, explicit direction enables continuation, stale/double requests cause no extra effect. Preserve safe output and no mock fallback; real tests require separate release.

- [ ] T030 [US1] Prove complete controlled host traversal in tests/runtime/integration/uc03-host-pipeline.test.ts.
  - **Dependencies**: T029, T010.
  - **Owned Paths**: tests/runtime/integration/uc03-host-pipeline.test.ts.
  - **Acceptance Checks**: SC-006/007 and host contract all sections; actual bootstrap/graph/evaluator from retained baseline through inspect-read/check -> observed evidence -> fresh request -> generated plan, explicit approve, generated patch, checks, canonical reviewer ingress and grade plus reject/revise path. Doubles supply only external effects/owner deliveries, not generated CaseResults or solutions in config. Assert report, persisted task/control/accounting, distinct coder/reviewer claim/attempt/outcome chains and unchanged protected sentinels. Exercise each required missing/stale/substituted capability, absent retained baseline, view mismatch, read race, uncertain provider/replan/patch recovery, absent evidence lookup and changed final snapshot, explicit request-info pause/continuation, stop and loop exhaustion. Controlled success remains non-real and suite incomplete. Run source/emitted checks; no paid/provider/container run.

## Phase 9: Cross-Cutting correction handoff

- [ ] T031 Record correction evidence and remaining real gates in specs/007-runtime-evaluation-integration/quickstart.md and context/progress_checker.md.
  - **Dependencies**: T030.
  - **Owned Paths**: specs/007-runtime-evaluation-integration/quickstart.md; context/progress_checker.md; context/architecture.md; context/testing.md; context/tech_stack.md.
  - **Acceptance Checks**: Trace FR-013–018/SC-006–007 to exact candidate/tests and retained evidence; review/context updater/contributor workflow. Name unmet owner delivery, command-view, approval control, UC-03 T024/T025/T026/T066 and profile gates. Request original-owner review of original-ledger closure; leave T011 unchecked until actual successful real repair. No automatic marking of old acceptance or fixture publication. Planning completion alone never checks T019–T034.

### Remediation dependency and parallel policy

Per-task dependencies are authoritative: new correction chain joins T011 through T030/T031; no remediation task depends on T011. T019 owner agreement/release precedes controlled implementation. After T020, T021/T022/T023 have disjoint paths; after T022, T024/T025 may run concurrently with those still-independent tasks. T026 can run once T021 is integrated. T027 then serializes all shared route changes before T028/T029. T029 owns both CLI paths and must serialize with any remaining original T011 edits; T031 serializes with T018 context work. No unconditional parallel task markers are added. Split T027 into coordinator-approved disjoint bounded assignments if needed; keep the canonical acceptance task intact. This amendment does not release comparison/console or foreign-owner implementation.

## Phase 10: User Story 1 — Remaining production producer corrections

**Goal**: Complete retained baseline/diff and reviewer ingress capabilities needed by production review/grading.
**Independent test**: Bounded measured diff at exact baseline/current revisions and one durable reviewer attempt, with protected-content, drift and stale-context refusal. These are prerequisites to bootstrap/route migration, not work following real acceptance.

- [ ] T032 [US1] Implement bounded repository diff measurement in src/foundation/repository-tools.ts and src/foundation/repository-diff.ts with tests/runtime/unit/repository-diff.test.ts.
  - **Dependencies**: T021, T022, T033.
  - **Owned Paths**: src/foundation/repository-tools.ts; src/foundation/repository-diff.ts; src/foundation/repository-types.ts; tests/runtime/unit/repository-diff.test.ts.
  - **Acceptance Checks**: Host contract sections 3/7; replace the inspectDiff NOT_IMPLEMENTED stub using trusted baseline/current filesystem observations, configured bounds and guarded read authority. Return canonical unified diff, digest and exact changed paths; reject missing baseline, revision drift, traversal/symlink escape, forbidden/protected content, binary/oversized output and hostile path names without leaking content or mutating files. Reviewer validates actual diff lines. Do not shell out to untrusted Git hooks/config or mount private grading. Existing repository tests remain green. No caller-supplied final diff counts as measurement.

- [ ] T033 [US1] Bind retained initial repository content in src/runtime/repository-baseline-source.ts with tests/runtime/unit/repository-baseline-source.test.ts.
  - **Dependencies**: T020, T022.
  - **Owned Paths**: src/runtime/repository-baseline-source.ts; src/runtime/evaluation-profile.ts; tests/runtime/unit/repository-baseline-source.test.ts; tests/runtime/unit/evaluation-profile.test.ts.
  - **Acceptance Checks**: Section 7; trusted configured immutable initial tree/complete admitted manifest, task/workspace/repository/base binding and bounded content lookup, distinct from UC-04 evidence writer. Prepared source remains outside writable task authority and available on continuation. Test changed/deleted/added current files against retained bytes, manifest omission, source drift, wrong-base/task, missing retention, protected/oversized/binary/linked escape and continuation reload. No generated baseline from current post-patch bytes, no diff-only fixture, no static-preflight writes or new persistence backend. T032/T028 require this capability.

- [ ] T034 [US1] Route reviewer calls through canonical v0.2 model ingress in src/foundation/reviewer.ts and src/uc03/graph-review.ts with tests/runtime/unit/reviewer-v02-accounting.test.ts.
  - **Dependencies**: T020, T005.
  - **Owned Paths**: src/foundation/reviewer.ts; src/uc03/graph-review.ts; tests/runtime/unit/reviewer-v02-accounting.test.ts; tests/runtime/unit/runtime-reviewer.test.ts.
  - **Acceptance Checks**: Section 2; remove production raw executeTransport and graph preclaim; canonical model boundary owns one durable reviewer claim/attempt/outcome and shared task usage. Current reviewer role/request/snapshot/context forwarded exactly; unknown output goes through strict review/diff-line validation. Stale/fenced/wrong-role/context yields zero network calls and unchanged ledger; lost response/timeout charges uncertainty and never repeats dispatch automatically. Test combined coder+reviewer accounting, malformed review, post-check drift and reviewer no-write authority. Preserve legacy controlled tests separately; T027 takes graph-review ownership only after this task integrates.
