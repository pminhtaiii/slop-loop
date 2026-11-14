# Tasks: UC-06 — Reviewer Agent

**Input**: [spec](spec.md), [plan](plan.md), [research](research.md), [data model](data-model.md), [context contract](contracts/review-context.md), [evaluation](contracts/evaluation.md), [decisions](contracts/decisions.md).
**Status**: T001 agreement is recorded in [decisions](contracts/decisions.md). T002 passed full independent source/controlled prerequisite verification on `6c08306`; see [T002 evidence](checklists/t002-verification.md). The user's 2026-11-13 request separately releases Phase 3 T003–T006 in dependency order at the same bounded tier. T007–T014 remain unreleased. No actual owner delivery, real integration or full-feature acceptance is claimed.

## Phase 1: Setup

- [x] T001 Record exact UC-06 owner assignment, shared-owner contract/path agreement, reviewed profile/rubric proposal and explicit implementation tier release in specs/009-reviewer-agent/contracts/decisions.md.
  - **Dependencies**: None.
  - **Owned Paths**: specs/009-reviewer-agent/contracts/decisions.md.
  - **Verification Evidence**: User selected T001 and identified as Trọng Tấn, confirming all owners agreed to the prepared exact packet; recorded as user-relayed agreement, not separate signatures. Assignment, contract/path baseline, documentation-only T001 release and outstanding profile/rubric/delivery/real gates are explicit in decisions.md. Targeted review/check evidence is in checklists/t001-validation.md. No runtime code or successor task released.
  - **Acceptance Checks**: G-AUTH/G-OWNER; explicitly labeled direct, user-relayed or delegated agreement provenance (T001 records the user's relayed confirmation, not independent signatures/delegation), exact APIs including uc06-review-evidence/1 UC-04 supplement, graph v0.2, trusted transport byte-cap configuration and evaluator v2, owned paths and controlled vs real releases. No invented owner consent. Production/rubric approval remain separate; unavailable real deliveries do not block expressly released controlled work.

## Phase 2: Foundational

- [x] T002 Add strict versioned review companion types and runtime validation in src/contracts/review.ts and src/uc06/validation.ts with tests/runtime/contract/uc06-review.test.ts.
  - **Dependencies**: T001.
  - **Owned Paths**: src/contracts/review.ts; src/uc06/validation.ts; tests/runtime/contract/uc06-review.test.ts.
  - **Verification Evidence**: Original implementation and later bounded repairs are retained in checklists/t002-verification.md. Complete independent merger `/root/phase3_merger` verified `6c08306`: original 230 criteria pass in both source/emitted modules, 29 additional arithmetic controls pass each, public suites 21/21 each. T002-MERGE-003/004 were independently reproduced, repaired with public assertion RED–GREEN, then reverified; noEmit/build/scoped lint pass and omission of the gap guard is assertion-killed in isolation. Snapshot 16/16 unchanged; report digest 380de45342cc293b7597cfc09d8c1b66abd1b944b0073115d9e06a8ac6965f44. Acceptance is pure source/controlled validation/correlation only; no actual owner authority/storage, real execution or successor acceptance follows. End-of-batch review/publication remain separate.
  - **Acceptance Checks**: Contract sections 2/3/5/6; exact companion and ReviewEvidencePortV1 persist/load/recover request/result/ACK fields/digests, candidate-bound recovery without graph locator, safe identifiers/paths/finite bounds, forged/mismatched ACK rejection, mandatory evidence, side/revision mapping, whole-diff/mixed/overflow refusal, contradictions/output bounds and no protected payload. Canonical schemas unchanged. Neutral assertion RED then GREEN; import/type failure is not RED.

## Phase 3: User Story 1 - Bound review (Priority: P1)

**Goal**: Current requirements/conventions/verification reach the same existing reviewer used by UC-03.
**Independent Test**: Actual reviewer sees captured full context for clean/faulty controlled responses; stale/missing/invalid cases refuse. No model-quality claim.

- [x] T003 [US1] Assemble immutable host-fed review context in src/uc06/context.ts with tests/runtime/unit/uc06-context.test.ts.
  - **Dependencies**: T002.
  - **Owned Paths**: src/uc06/context.ts; tests/runtime/unit/uc06-context.test.ts.
  - **Verification Evidence**: Integrated `5abd366`; source 47 context +21 contract tests and fresh emitted 68/68 each, noEmit/build/scoped lint/format pass. Separate merger `/root/phase3_merger` verified all T003 pure source/controlled criteria with 266 independent assertions in each source/emitted module, focused suites 47/47 each, fresh 20-input snapshot unchanged; report digest dd2c83e772a3af3eec5555a54afda31519835203279b55672a4913bb1cf7b6b8. Public RED–GREEN covers neutral entry, required source, D0 substitution and malformed data. Host-only requiredSourcePaths makes required spans explicit and permits deletion without a fabricated head excerpt. No actual owner delivery/authority or IO/model/state effects; end-of-batch review/CI/publication remain separate.
  - **Acceptance Checks**: FR-001/002/009, SC-001; measured base/head/diff, actual acknowledged baseline/checks, criteria/constraints/conventions/profile/evidence, current D1/original D0, required passing checks, safe complete bounded context. Zero model/IO/state mutations in pure assembler. Synthetic name collisions, forged/stale records, empty/missing mandatory conventions and truncated evidence refuse. Controlled host doubles explicitly labeled.

- [x] T004 [P] [US1] Extend existing reviewer snapshot/digest and opt-in context/output validation in src/foundation/reviewer.ts with tests/runtime/unit/uc06-reviewer.test.ts.
  - **Dependencies**: T003.
  - **Owned Paths**: src/foundation/reviewer.ts; tests/runtime/unit/uc06-reviewer.test.ts; src/foundation/model.ts; tests/runtime/unit/model.test.ts.
  - **Verification Evidence**: Integrated `31af9a4`; public RED–GREEN for token boundary, snapshot/output/actions and self-consistently reminted base/D1/plan contradictions. Separate merger `/root/phase3_merger` passed all scoped source/controlled criteria: 83 independent runtime assertions and 7 complete T003-prepared→actual reviewer/model/transport fake-HTTP assertions each source/emitted; focused regressions 234/234 each. Shared filter reassessment T002230/230 and T003266/266 each. Build/noEmit/scoped lint/format pass. Report digest ea0efa014497e19ecc9adb07394ba600c870903247d1019f293df221c43b65c8; see Phase 3 record. External delivery, final review/CI/publication remain separate.
  - **Acceptance Checks**: FR-003–006/008, SC-001–003; same existing factory/closure/ingress, optional context resolver and snapshot companion, identical mint/dispatch projection, mandatory evidence/rationale/count/byte limits, no action proposals, no partial acceptance. Existing legacy/runtime/accounting suites remain passing; new suite invokes actual reviewer/HostModelPortV02 with fake transport, no second accounting. Usage of invalid output remains charged.

- [x] T005 [P] [US1] Add trusted role-specific reviewer instructions/schema in src/foundation/deepseek-transport.ts with tests/runtime/unit/uc06-review-prompt.test.ts.
  - **Dependencies**: T003.
  - **Owned Paths**: src/foundation/deepseek-transport.ts; tests/runtime/unit/uc06-review-prompt.test.ts.
  - **Verification Evidence**: Integrated `31af9a4`; compiled prompt identity now fits the unchanged profile schema after public RED–GREEN. Same separate merger report as T004 verifies complete role/profile/immutable config/token/wire/decoded bounds and combined actual transport flow in both module modes; 83/83 plus7/7 independent checks each, focused234/234 each, static checks pass. Stream/fetch are controlled; no real provider, production profile or owner delivery claim.
  - **Acceptance Checks**: FR-002/005/006/012; trusted role/purpose/profile select reviewer schema, criteria/constraints/conventions/checks stay untrusted, coder branch unchanged. Host-only reviewPrompt carries matching version/digest/maxOutputBytes/maxResponseBytes. Bounded HTTP reader enforces received bytes before outer JSON; decoded content cap precedes inner verdict parse. Test exact/above cap, multibyte chunks/escaped JSON, absent/false Content-Length and unreadable body, cancel-on-excess, observed usage for oversized inner content versus charged uncertainty for unreadable outer usage. Capture fake requests for both roles, no tools/credentials/context-policy injection or real network.

- [x] T006 [US1] Propagate bound context through src/uc03/graph.ts, src/uc03/graph-types.ts, src/uc03/graph-types-v02.ts, src/uc03/graph-v02.ts, src/uc03/graph-state.ts, src/uc03/graph-review.ts, src/uc03/graph-completion.ts, src/uc03/verification-types.ts and src/uc03/verification-review.ts with tests/runtime/integration/uc06-review-route.test.ts.
  - **Dependencies**: T004, T005.
  - **Owned Paths**: src/uc03/graph.ts; src/uc03/graph-types.ts; src/uc03/graph-types-v02.ts; src/uc03/graph-v02.ts; src/uc03/graph-state.ts; src/uc03/graph-review.ts; src/uc03/graph-completion.ts; src/uc03/verification-types.ts; src/uc03/verification-review.ts; tests/runtime/support/uc06/review-evidence.ts; tests/runtime/integration/uc06-review-route.test.ts.
  - **Verification Evidence**: Integrated `b3ba7d6`, development refreshed at `a4ff5c8`. Separate merger `/root/phase3_merger` passed all 7 released-batch criteria/14 source-emitted checks: T006214/214 independent actual-graph assertions each tier; prerequisite reviewer83, prepared-flow7, T002230+29, T003266 and actual-producer8 each tier. Focused source/emitted405/405 each, noEmit/build/lint/format pass, independent107-input snapshot unchanged. Report SHA-256 5f552d20bc7321aaff950e3cc8e94c51bf052b677ef4aca0fc76ac5fd57f9787; receipt 8e0085025b061536714898695169358a3b3e23ea942d4fc4cc535656bb550475. Actual graph completion, both fresh material/load checks and TaskState-only lost-ACK recovery preserve charges with zero replay; controlled in-memory evidence only. See Phase 3 record. Final semantic review, exact-head CI/publication and actual storage/real/quality/restart remain separate gates.
  - **Acceptance Checks**: Context contract 1/4/5/6, SC-001/004; same prepared resolver/evidence port, replace [] consistently, persist/load/recover exact observation; fresh owner lookup in both graph-review.ts and graph.ts Deliver calls. Controlled double: atomic observation/index commit then lost ACK before graph CAS, reconstruct consumers from TaskState only/no locator, candidate discovery then exact load with zero provider replay, operationRef uncertainty, latest-missing versus older accepted, post-settlement/pre-persist missing, cross-task/stale/conflicting/forged ACK. No durable claim. Actual graph Verify→Review→Deliver/absent-port refusal; exact own accounting/CAS deltas only. Pause/drift cannot complete; preserve brand/legacy behavior. No fixture-private call or second reservation/claim.

## Phase 4: User Story 2 - Authority and bounded failure (Priority: P1)

**Goal**: Deny hostile actions and stop safely with truthful accounting.
**Independent Test**: Real reviewer/model ingress against controlled owner/transport spies; assert returned outcome, journal charges and zero forbidden effects separately.

- [ ] T007 [US2] Add adversarial authority/accounting vectors in tests/runtime/security/uc06-review-safety.test.ts.
  - **Dependencies**: T006.
  - **Owned Paths**: tests/runtime/security/uc06-review-safety.test.ts.
  - **Acceptance Checks**: R11–R15/R19–R20, FR-006–009/012, SC-002/003; source/diff/log/convention injection, secret/grader access, write/patch/delete/install/command/tool attempts, task-wide pending/rejected pause, missing/exhausted/invalid time/review/token/cost bounds, timeout/invalid response/uncertain usage/settlement/observation acknowledgment. Exact duplicate/conflict/new-run behavior; owner high-water marks and no refund/retry. Reuse existing reviewer-v02-accounting tests without treating MemoryStatePortV02 as durable. Any production defect goes back to its exact owned task for repair, not unauthorized test-worker edits.

## Phase 5: User Story 3 - Repair and independent evaluation (Priority: P2)

**Goal**: New candidate evidence after findings, independent judging and honest tier coverage.
**Independent Test**: Actual controlled graph path plus independent synthetic labels; real quality and restart remain not-run.

- [ ] T008 [US3] Drive bounded review-repair-verification-review in tests/runtime/integration/uc06-review-repair.test.ts.
  - **Dependencies**: T007.
  - **Owned Paths**: tests/runtime/integration/uc06-review-repair.test.ts.
  - **Acceptance Checks**: R16/R17, SC-004; actual shared graph with actual reviewer, controlled coder/repository/owner, one actionable finding, permitted repair, changed revision, invalidated prior evidence, fresh verification/D1 where needed and fresh reviewer request before delivery. Missing current authority/exhausted loops stop without extra patch/provider dispatch; material replan preserves existing cap/renewed approval. Preserve original UC-03/007 acceptance ownership; route defects remain owned there.

- [ ] T009 [US3] Add frozen case descriptors and independent grading in eval/uc06/catalog.ts and eval/uc06/grade.ts with tests/runtime/unit/uc06-grade.test.ts.
  - **Dependencies**: T002.
  - **Owned Paths**: eval/uc06/catalog.ts; eval/uc06/grade.ts; tests/runtime/unit/uc06-grade.test.ts.
  - **Acceptance Checks**: Evaluation contract; R01–R20 inventory, Q01–Q12 private independent labels/oracle digests, one-to-one localized semantic matching, TP/FP/FN/null denominators/invalid cases and exact per-milestone tier coverage. Regression: Q+controlled safety pass/R18 not-run means quality pass, restart/full incomplete; missing Q/safety means quality incomplete. Controlled labels test grader only; absent approved independent labels keeps G-QUALITY closed. No self-grading or private labels in public payload.

- [ ] T010 [US3] Register UC-06 on existing evaluation infrastructure in eval/uc06/registration.ts and add gated additive evaluator v2 in eval/shared.ts and eval/shared-types.ts with tests/runtime/contract/uc06-evaluation.test.ts.
  - **Dependencies**: T008, T009.
  - **Owned Paths**: eval/uc06/registration.ts; eval/shared.ts; eval/shared-types.ts; tests/runtime/contract/uc06-evaluation.test.ts.
  - **Acceptance Checks**: Evaluation contract v2 migration; existing shared v1 stays unchanged/mock-only and retains real-execution-unavailable. New capability-aware v2 uses existing real-admission validation, exact registered callbacks/model/profile/case/oracle pins, controlled and unavailable-real witnesses with zero unauthorized dispatch. New real context never masquerades as mock. Preserve UC-01/UC-03 registrations, coverage/not-run/error/selected-vs-suite and hidden-oracle isolation. Source/controlled implementation is not real execution.

## Phase 6: Separately gated real acceptance (User Story 3)

**Goal**: Real evidence only after exact external receipts and explicit release.
**Independent Test**: Distinct actual-provider, quality and process-kill witnesses; absent prerequisites return not-run, never simulated pass.

- [ ] T011 [US3] Prove one real integrated review in tests/runtime/integration/uc06-review-real.test.ts.
  - **Dependencies**: T010.
  - **Owned Paths**: tests/runtime/integration/uc06-review-real.test.ts.
  - **External Gates**: G-AUTH, G-DELIVERY, G-ROUTE, G-PROFILE, G-SECURITY.
  - **Acceptance Checks**: SC-001–004 with actual reviewer/provider/current accepted owners and isolated target checks, no supplied verdict/mock fallback. Pin candidate/profile/model/owner/evidence/journal. Consume original T024/T025/T028/007 proofs without marking their tasks complete here. Missing delivery/refusal remains not-run/nonzero, not successful integration.

- [ ] T012 [US3] Evaluate approved independent real quality set in tests/runtime/integration/uc06-review-quality.test.ts.
  - **Dependencies**: T011.
  - **Owned Paths**: tests/runtime/integration/uc06-review-quality.test.ts.
  - **External Gates**: G-AUTH, G-QUALITY, G-PROFILE, G-SECURITY.
  - **Acceptance Checks**: SC-005, approved frozen 12-case rubric with independent label author/judge, exact model/prompt/provider/profile identity, all TP/FP/FN/invalid/not-run counts and localization/evidence support, private oracle isolation. Proposed target: valid observations on all 12, no actionable FP on six clean, >=5/6 seeded faults found, all safety predicates pass. No statistical/generalized claim or hidden retry/cherry-picking.

- [ ] T013 [US3] Prove cumulative review recovery across process termination in tests/runtime/integration/uc06-review-restart.test.ts.
  - **Dependencies**: T011.
  - **Owned Paths**: tests/runtime/integration/uc06-review-restart.test.ts.
  - **External Gates**: G-AUTH, G-DELIVERY, G-PROFILE, G-RESTART.
  - **Acceptance Checks**: R18/SC-006; distinct PIDs/actual durable owner journal around reservation, possible dispatch, settlement and observation persistence. Kill after atomic observation/index commit but before ACK/graph CAS and restore TaskState with graph locator withheld; recoverObservation must discover exact committed bytes then load without provider replay. Pre-persist missing or unknown commit stops safely, never falls back to older accepted. Preserve task reviewer/token/cost/pricing/pauses/holds and exact uncertainty predecessors; no duplicate provider/repair effect or new-run reset. In-process reconstruction cannot pass.

## Phase 7: Polish and local batch handoff

- [ ] T014 Refresh implementation evidence and affected context through specs/009-reviewer-agent/quickstart.md, context/progress_checker.md, context/architecture.md, context/architecture-evaluation.md and context/testing.md using the managed context updater.
  - **Dependencies**: T010.
  - **Owned Paths**: specs/009-reviewer-agent/quickstart.md; context/progress_checker.md; context/architecture.md; context/architecture-evaluation.md; context/testing.md.
  - **Acceptance Checks**: Record exact released batch/candidate/commands/criterion-level evidence, independent merger/review and unchanged source hashes; updater apply/context check passes. Local controlled handoff leaves T011–T013 unchecked and real/quality/restart explicitly not-run. Full feature completion additionally requires T011, T012 and T013, their external gates and all SCs. Contributor publication is a separate user request/gate.

## Dependencies and execution order

Internal DAG above is authoritative. T001 → T002 → T003 → {T004,T005} → T006 → T007 → T008; T002 → T009; {T008,T009} → T010 → {T011,T014}; T011 → {T012,T013}. External gates are owner evidence, not fabricated foreign task IDs or authority.

Only T004/T005 have [P]: disjoint paths and the same accepted prerequisite T003. T002 is now accepted at its pure source/controlled scope; T009 still needs a separate release before scheduling. No unresolved dependency is bypassed by [P]. Shared graph and evaluator files serialize with any other owner work.

## Implementation strategy

MVP T001–T006 covers current bound review while enforcing read-only/admission/accounting invariants from the start; US2 adds hostile/failure proof. US3 adds actual graph loop and independent grading. Controlled T002–T010 can be separately released without real gates. Do not reimplement existing Feature 007 T005/T034, UC-03 reviewer/accounting or UC-04 recovery. T001 and the pure source/controlled T002 prerequisite are checked; Phase 3 tasks require their own independent evidence.
