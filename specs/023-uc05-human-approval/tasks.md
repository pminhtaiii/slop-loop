# Tasks: UC-05 — Bound Human Approval and Safe Continuation

**Input**: [spec](spec.md), [plan](plan.md), [research](research.md), [data model](data-model.md), and [contracts](contracts/interfaces.md).

**Status**: T001–T019 and T023–T028 corrections are complete locally under separate phase authorizations; see [decisions](contracts/decisions.md). At integrated source `391d3ff9e484864f89cecf28133ec413b7607e86`, the full runtime gate passed typecheck, full lint, clean build and 1098 compiled tests; contributor tests passed 227/227 (exit 0). T019 source/emitted focused checks pass 2/2 each; each catalog run observes all 192 inherited approval checks in a fresh subprocess. All C01–C24 have explicit partial local evidence; all 104 required real/restart vectors remain not-run and unobserved effect counts remain null. Safe history keeps immutable consent separate from current assessments and observed/unknown execution. Phase 8 T019–T022 was separately authorized on 2026-10-22 (Asia/Saigon). T020–T022 remain blocked on external owner delivery and G-PROFILE/G-REAL/G-RESTART; real adapters, production profiles, durable atomicity, real execution and actual restart remain unverified. Full UC-05 acceptance remains unverified. Checkboxes below remain the sole completion ledger. Planned preparation tiers are recorded separately from observed local tiers derived from explicitly mapped unit/mock/CLI witnesses.

Final review found an in-scope T007 retry defect and two standards corrections. T023 below records their accepted correction only; it does not release any later story or real-delivery gate.

**Tests**: Required by FR-022 and repository TDD guidance. Write behavioral RED against actual owned SUT exports before implementation; create neutral no-effect skeletons only where needed. Import/type/fixture failures and tests against a mocked SUT are not behavioral RED. Coordinator alone changes checkboxes after integration and required checks. Unchecked future source paths below remain unimplemented.

## Phase 1: Setup and shared agreement

**Goal**: Agree exact delivery boundaries without inventing foreign task IDs or owner approval.

- [x] T001 Record implementation authorization, companion-contract signoff and shared ownership in specs/023-uc05-human-approval/contracts/decisions.md.
  - **Owner**: Trong Tan coordinating Tai and Thanh Tan.
  - **Dependencies**: None; external G-AUTH and G-CONTRACT.
  - **Owned Paths**: specs/023-uc05-human-approval/contracts/decisions.md; specs/023-uc05-human-approval/contracts/interfaces.md; specs/023-uc05-human-approval/contracts/policy.md; specs/023-uc05-human-approval/contracts/cli.md; specs/023-uc05-human-approval/data-model.md; specs/023-uc05-human-approval/plan.md.
  - **Acceptance Checks**: Record actual owner agreements on durable control/claim atomicity, immutable resolutions, presentation/operator capability, exact-digest plan behavior, proposed schemas and foreign path ownership. Preserve canonical version; record finite fixture profiles and production delivery gates. No inferred signoff or production backend selection by UC-05.
  - **Current Evidence**: Phase 1 user authorization, the explicit confirmation "Đã thống nhất cả ba người với bản hiện tại", accepted contract snapshot and owner/responsibility matrix are recorded in the decisions document. Phase 2 was separately authorized afterward; its task progress is tracked only by the checkboxes below.

## Phase 2: Foundational contracts, cases and mocks

**Goal**: Stable executable record contracts and all case inputs before feature implementation.

- [x] T002 [P] Add companion record/profile validators test-first in src/contracts/approvals/contracts.ts and tests/runtime/approvals/contracts.test.ts.
  - **Owner**: Trong Tan / contracts lane.
  - **Dependencies**: T001.
  - **Owned Paths**: src/contracts/approvals/contracts.ts; tests/runtime/approvals/contracts.test.ts.
  - **Acceptance Checks**: Validate all data-model records, safe results, versions/epochs/IDs, unknown fields, finite profiles, pending-only creation and complete trusted identities. Reuse unchanged canonical types/validators. C04/C12/C20/C22 vectors pass; no persistence implementation.
  - **Current Evidence**: Integrated merge `d1452b3fe0191a3d1f26a175834266327b5f37f3` contains only the two owned paths. `node --test tests/runtime/approvals/contracts.test.ts` passed 11/11; `corepack pnpm typecheck`, `corepack pnpm lint`, and `corepack pnpm build` exited 0; `corepack pnpm test:runtime` passed 463/463. Worker recorded a sparse-array behavioral RED before the fix. No persistence or runtime execution capability is claimed.

- [x] T003 [P] Prepare versioned C01–C24 fixtures and outcome oracles in tests/runtime/support/uc05/fixtures.ts.
  - **Owner**: Trong Tan / cases lane.
  - **Dependencies**: T001.
  - **Owned Paths**: tests/runtime/support/uc05/fixtures.ts.
  - **Acceptance Checks**: Register every case from acceptance contract with explicit finite profile, fixture/oracle version/digest, operator events, expected dispatch/prompt/effect counts and required evidence level. Include all independent freshness fields and failpoints; no hidden expected outputs enter product-agent context. Validate with T002 after integration; no SUT feature implementation.
  - **Current Evidence**: Integrated merge `ea555f2111765b6a069df1488245e4fc3706dfed` contains only the owned fixture path on top of T002 integration. Independent audit passed all 24 unique cases, 104 vectors, 17 separate C13 freshness vectors, 16 vector failpoints, canonical digests, exact finite test profile, evidence tiers/gates and count totals; every fixture context passed T002 `validateApprovalRequestRecord`. Fixture syntax check, focused T002 suite (11/11), `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm build`, full runtime suite (463/463), planning validation, context check and `git diff --check` all exited 0. Real/restart evidence remains explicitly not-run; no runtime capability is claimed.

- [x] T004 Build explicit test-only companion ports in tests/runtime/support/uc05/mock-store.ts and tests/runtime/support/uc05/mock-context.ts.
  - **Owner**: Trong Tan / test support.
  - **Dependencies**: T002, T003.
  - **Owned Paths**: tests/runtime/support/uc05/mock-store.ts; tests/runtime/support/uc05/mock-context.ts; tests/runtime/approvals/mock-ports.test.ts.
  - **Acceptance Checks**: Same companion validation suite checks atomic failure/conflict, scripted resolutions, immutable history, epoch fences and recorded activity/effect attempts. Mark mock provenance; real composition rejects these dependencies. No disk durability or actual restart claim.
  - **Current Evidence**: Integrated merge `dbafa8aef44bb5781c0ae0e075b728fb4398baf9` contains only the three owned paths on top of accepted T003. Worker demonstrated behavior-level RED/GREEN for pending creation/pause and the pause-wins activity result. Integrated focused T002+T004 tests passed 19/19; fixture audit, syntax, planning validation, context check and `git diff --check` passed. `corepack pnpm run validate:runtime` passed typecheck, lint, build and runtime 471/471; because the Windows gate invokes `pnpm.cmd` directly, this successful rerun used a temporary ignored-directory shim forwarding to Corepack, removed after validation. Mocks declare mock provenance, live only under test support, store only in memory, and record effect attempts without executing effects. No UC-05 production composition or real store exists in this phase; no production-adapter, durability, execution, or restart proof is claimed.

## Phase 3: User Story 1 — Informed pre-effect decision (Priority: P1)

**Goal**: Correct deterministic classification and safe first request/CLI projection.

**Independent Test**: C01–C05/C21–C23 prove expected permission, safe prompt and zero premature effects using the actual service with injected mock dependencies.

- [x] T005 [US1] Write classification behavioral RED in tests/runtime/approvals/policy.test.ts against src/approvals/policy.ts.
  - **Owner**: Trong Tan / policy tests.
  - **Dependencies**: T004.
  - **Owned Paths**: tests/runtime/approvals/policy.test.ts; src/approvals/policy.ts.
  - **Acceptance Checks**: Establish loadable no-effect policy skeleton; allowed/required expectations fail behaviorally. Cover full precedence table, forbidden overrides, command argv grammar, unsupported facts and configured breadth; freeze tests/source handoff to T006.
  - **Current Evidence**: Integrated at `93effc72cf0edf2786d7f6f90c12617a607b6b9f` after independent merger review. Fifteen public-seam behavioral tests exercise the actual classifier; retained RED/GREEN slices include configured command/patch permission, forbidden precedence, finite trusted facts, plan prerequisites, breadth, exact argv rules, immutable policy and malformed-role/attached-eval regressions. Import/type failures are not counted as behavioral RED. Focused policy plus prior foundation suites passed 39/39; required integrated runtime validation passed typecheck, lint, build and 596 compiled tests. Evidence is retained locally under `.agent-work/2026-10-19/uc05-phase3/policy/`; no real enforcement or execution claim.

- [x] T006 [US1] Implement deterministic in-process policy compilation in src/approvals/policy.ts.
  - **Owner**: Trong Tan / policy implementation.
  - **Dependencies**: T005.
  - **Owned Paths**: src/approvals/policy.ts.
  - **Acceptance Checks**: T005 vectors green with no LLM/network/process calls or whole-repo scans. Consume trusted admission facts, canonical exact digests and explicit finite profiles; no shell equivalence claims or permissive defaults.
  - **Current Evidence**: Same initial accepted integration and checks as T005. Follow-up integration `375dda8bd79194c30108c929da598b02bae5b936` requires complete matched trusted proposal context for revised plans, preserving explicit nonmaterial renewal without a new replan charge; policy/foundation checks passed 40/40 and the required runtime gate passed 597 compiled tests. `compilePolicy` validates and freezes an explicit fixture profile; classification consumes action/policy-bound trusted facts and unchanged canonical validators. The closed argv rule matches the complete configured tuple; malformed/unsupported inputs deny with safe typed outcomes, and forbidden/evaluation forms cannot be approved by configuration. No filesystem scan, subprocess, network, model or effect dispatch is introduced. Real isolation, durable adapters and production profiles remain gated.

- [x] T007 [US1] Implement initial ApprovalPort service, bounded presentation and decision CLI test-first in src/approvals/service.ts, src/approvals/presentation.ts and src/approvals/cli.ts.
  - **Owner**: Trong Tan / service and operator boundary.
  - **Dependencies**: T006.
  - **Owned Paths**: src/approvals/service.ts; src/approvals/presentation.ts; src/approvals/cli.ts; tests/runtime/approvals/service.test.ts; tests/runtime/approvals/cli.test.ts.
  - **Acceptance Checks**: Preserve all four canonical signatures with injected fresh context/store/operator capability. Actual CLI subprocess parser handles list/show/inspect/decide, versions/digests/response keys, bounded safe presentation, protected-data/terminal-injection rejection and missing store denial. Pending creation closes task admission through the mock contract; no production autoapproval or local fallback store. Safe output is mandatory from this first slice.
  - **Current Evidence**: Independently accepted candidate `f8782960eb27e94832e224102b526cecb5eeec96` integrated at `df5615e0d1b9f71b850673724d8d45091ce37124`, changing exactly the five owned paths. Source and emitted approval suites each passed 64/64; `node scripts/ci/check-runtime.mjs` passed typecheck, full lint, clean build and 621/621 compiled tests; whitespace checks passed. Public-seam behavioral RED/GREEN covers first pending/pause, exact inspected consent, immutable retries, safe complete UTF-8 pages, actual CLI subprocesses, pause races, delayed-context expiry fences, protected/corrupt store receipts and uncertain commits. Malformed or uncertain mutation receipts close local admission and never assert execution or definite noncommit. Detailed local evidence is retained under `.agent-work/2026-10-19/uc05-phase3/service/` and `service/resume/`. Service/store provenance remains mock; direct CLI entry is unconfigured and returns unavailable. No durable store, production adapter, task-wide executor coordination, real effects or restart evidence is claimed. T008 onward remains gated.

## Phase 4: User Story 2 — Task-wide wait, rejection and direction (Priority: P1)

**Goal**: Pending/rejected control stops every affected agent while preserving unrelated task progress.

**Independent Test**: C06–C11/C20 exercise mock scheduler/model/tool activity, explicit operator events and failure races through the actual control module.

**Planning refinement (2026-10-20)**: See [Phase 4 design](plan.md#phase-4-refinement--t008t010-planning-only), [behavioral scenarios US2.7–US2.12](spec.md) and [local evidence boundary](contracts/acceptance.md#phase-4-local-evidence-boundary). This documentation request does not release runtime work or confirm the proposed TDD seams. T008 → T009 → T010 remain sequential; use one tracer RED then vertical RED/GREEN slices, not a batch of all failing tests.

**Subsequent authorization**: The user separately requested implementation and GitHub push, then confirmed all three Phase 4 seams; see [decisions](contracts/decisions.md#phase-4-implementation-authorization). Execute only T008–T010 with mock dependencies; later phases and real delivery gates remain intact.

- [x] T008 [US2] Write task-control behavioral RED in tests/runtime/approvals/control.test.ts against src/approvals/control.ts.
  - **Owner**: Trong Tan / control tests.
  - **Dependencies**: T007.
  - **Owned Paths**: tests/runtime/approvals/control.test.ts; src/approvals/control.ts.
  - **Acceptance Checks**: Neutral loadable SUT fails valid pause/decision/direction expectations; tests cover all-agent fencing, in-flight cancellation/uncertainty, unrelated tasks, equivalent-ID retries and failed transaction/no runnable gap. Hand source to T009.
  - **Current Evidence**: Loadable neutral tracer and subsequent public coordinator/service RED/GREEN slices retained locally; corrected candidate independently integrated at `6ec06a68b2d9fa59de52bdc17a6f956bd08f663a`. Source and emitted approval suites each passed 82/82, typecheck/build/scoped lint passed. Representative mock callers exercise the actual coordinator; no real scheduler/executor or durability claim.

- [x] T009 [US2] Implement pause/rejection/direction coordination through companion ports in src/approvals/control.ts and src/approvals/service.ts.
  - **Owner**: Trong Tan / control implementation.
  - **Dependencies**: T008.
  - **Owned Paths**: src/approvals/control.ts; src/approvals/service.ts; tests/runtime/approvals/control.test.ts; tests/runtime/support/uc05/mock-store.ts; tests/runtime/approvals/mock-ports.test.ts.
  - **Acceptance Checks**: T008 tracer passes, then extend one behavioral RED/GREEN slice at a time. All mutation/control operations obey CAS/idempotency, explicit direction and hold rules. Extend only mock-store direction retry conformance and its public-port tests as identified in plan.md; no service-local retry cache or duplicate UC-04 transaction engine. An identical direction retry preserves original receipt and newer holds; a new stale response conflicts. Feedback cannot resume, end cannot discard uncertainty, storage/activity failure cannot grant authority.
  - **Current Evidence**: Same independently accepted integration `6ec06a6`: five owned paths, 441 reviewable lines. Actual service wires pending/rejection/end to injected mock activity; store-owned direction retry preserves original metadata and later holds. Failure/expiry/uncertainty remains closed, final reload revalidates identity/schema/claims/version/epoch, cancellation never proves rollback. All 82 source/emitted approval checks and typecheck/build/scoped lint passed; detailed local evidence is retained in the Phase 4 implementation session. T010 remains separate; canonical contracts and foreign runtime modules are unchanged.

- [x] T010 [US2] Add explicit resume/revise/end operator commands and terminal-loss handling in src/approvals/cli.ts and tests/runtime/approvals/cli.test.ts.
  - **Owner**: Trong Tan / CLI control.
  - **Dependencies**: T009.
  - **Owned Paths**: src/approvals/cli.ts; tests/runtime/approvals/cli.test.ts.
  - **Acceptance Checks**: Test-first real subprocess command/exit vectors; empty/malformed/EOF/Ctrl+C input retains pause; explicit scoped direction never becomes approval. Existing service/policy/CLI regressions remain green; no implicit active-task default.
  - **Current Evidence**: Candidate `415431e` independently accepted and integrated at `f6edb85ff50a311ad6ac9881ac66b79fdd9077da`; only two owned paths, 152 reviewable lines. CLI 12/12 and full source/emitted approvals each 88/88 pass; typecheck/build/owned lint/whitespace pass. Windows SIGINT/SIGTERM before mutation and after committed end retain parent-observed snapshots from the same mock store, with original rejection preserved and no inferred consent. These are subprocess/mock observations, not postmortem persistence, actual runtime restart or production composition; direct executable remains unavailable.

## Phase 5: User Story 3 — Exact action and fix-plan binding (Priority: P1)

**Goal**: Immutable approvals, stale/conflict refusal and distinct plan/action prerequisites.

**Independent Test**: C09/C12–C16/C22 vary each binding dimension and strategy/allowance independently.

- [x] T011 [US3] Write binding/decision behavioral RED in tests/runtime/approvals/plan-binding.test.ts and tests/runtime/approvals/service.test.ts.
  - **Owner**: Trong Tan / binding tests.
  - **Dependencies**: T010.
  - **Owned Paths**: tests/runtime/approvals/plan-binding.test.ts; tests/runtime/approvals/service.test.ts; src/approvals/plan-binding.ts.
  - **Acceptance Checks**: Loadable neutral binding SUT, behavioral fresh-approval failure, every canonical freshness field, foreign/raced/duplicate response, immutable rejected/approved history and presentation substitution. No import failures counted as RED; transfer source to T012.
  - **Current Evidence**: Neutral loadable evaluator behavioral RED and successive public evaluator/service RED/GREEN slices retained locally. Independently accepted integration `ec75ebd6347947d3de2828e0b1e1490585f89d97` passes 127 source/emitted approval checks and 239 combined approval/canonical checks; no import/fixture failure is counted as behavioral RED.

- [x] T012 [US3] Implement exact binding and stale projections in src/approvals/plan-binding.ts and src/approvals/service.ts.
  - **Owner**: Trong Tan / binding implementation.
  - **Dependencies**: T011.
  - **Owned Paths**: src/approvals/plan-binding.ts; src/approvals/service.ts.
  - **Acceptance Checks**: T011 passes against canonical admission and journal, fresh IDs for reapproval, no silent repository rebinding. Unknown/missing trusted context false/denied; unchanged strategy charges no replan but concrete repository drift requires fresh approval.
  - **Current Evidence**: Same independently accepted integration `ec75ebd`: exact canonical freshness, immutable stale/rejected projections, fresh-ID pending replacement through the existing mock transaction, sticky retirement, exact receipt/control/journal validation and definite-refusal latch restoration. Initial candidate failed four independent P1 reproductions; one corrective round passed all four plus source/emitted suites, typecheck/build/scoped lint/whitespace. Four owned paths total 559 reviewable lines. Approved staleness remains a derived read projection because no terminal-assessment write port exists; no durable, real execution or restart claim. T013 follows separately after this acceptance.

- [x] T013 [US3] Verify UC-03 plan-consumer compatibility in tests/runtime/approvals/plan-context.test.ts.
  - **Owner**: Trong Tan with Tai reviewing consumer semantics.
  - **Dependencies**: T012; external X03-PLAN-CONTEXT contract agreement (mock context permitted locally).
  - **Owned Paths**: tests/runtime/approvals/plan-context.test.ts.
  - **Acceptance Checks**: Current canonical Patch transition admits only exact approved plan. New regression baseline is bound correctly, material revisions consume three retained slots/fourth refuses, path-only prompt absent, separate risky-action gate remains. Original baseline evidence stays preserved when a nonmaterial current-state refresh gets a fresh decision. No canonical or UC-03 workflow edits.
  - **Current Evidence**: After explicit user-relayed Tai/X03 agreement and third-seam confirmation, one-file test candidate `0db810d02a89d6784e24ea0591dfa389eb8fdddf` was independently accepted and integrated (235 added reviewable lines). Five sequential compatibility slices passed existing behavior without manufactured RED: actual service human approval into canonical Patch, wrong/stale bindings refused, baseline/current-state renewal, MemoryStatePort three retained reservations/fourth exhaustion across a simulated new run, and separate risky-action policy. Combined source approval/canonical 244/244, emitted approvals 132/132, typecheck/build/scoped lint/whitespace passed. No canonical/workflow, real accounting, execution or restart claim.

## Phase 6: User Story 4 — Recovery and continuation admission (Priority: P1)

**Goal**: Prepare correct claim/recovery logic; actual durability is separately proven in T021.

**Independent Test**: C17–C20 use explicit saved control/claims and mocked interruption profiles to prevent blind replay and reset.

- [x] T014 [US4] Add recovery/claim behavioral RED in tests/runtime/approvals/restart-admission.test.ts.
  - **Owner**: Trong Tan / recovery consumer tests.
  - **Dependencies**: T013.
  - **Owned Paths**: tests/runtime/approvals/restart-admission.test.ts; tests/runtime/support/uc05/mock-recovery.ts.
  - **Acceptance Checks**: Exercise real control/service exports with mocked UC-04 load/claim semantics. Assertions cover retained waiting/rejection, decision commit uncertainty, concurrent pause/claim, missing accounting, lost response and post-effect uncertainty. Record local simulation scope; no actual restart claim.
  - **Current Evidence**: Accepted candidate `632ddbc` integrated at `41c4215264106fef27a90ae83ee680cd0edbb1aa`. Eighteen behavioral tests use actual service/control exports with retained mock owner state and canonical in-memory reservations; positive, descriptor-failure and missing-claim-fence RED/GREEN slices are retained. Source/emitted approvals pass 160/160; independent merger repros pass 19/19. No actual process restart or repository effect is exercised.

- [x] T015 [US4] Implement recovery-safe continuation coordination in src/approvals/control.ts and src/approvals/service.ts.
  - **Owner**: Trong Tan / recovery consumer implementation.
  - **Dependencies**: T014.
  - **Owned Paths**: src/approvals/control.ts; src/approvals/service.ts; src/approvals/recovery.ts.
  - **Acceptance Checks**: T014 passes with no retry based solely on approved status, timeout, new run or expired process. No UC-04 backend/ledger implementation; no repository execution. Real claim atomicity still external and required by T020/T021.
  - **Current Evidence**: Same accepted integration adds `createApprovalContinuation` through control.ts and recovery.ts; existing service and generic activity admission behavior remain unchanged. Exact approved bindings, retained claim/control journal, finite owner reservation requirements and complete receipts gate mock continuation; failures/deadlines cannot authorize late work or blind replay. Integrated typecheck/full lint/clean build and 1005 compiled tests pass. Minimal result diagnostics are limited; full safe projections remain T016–T018. Real atomicity, adapters and restart remain external.

## Phase 7: User Story 5 — Safe inspectable history (Priority: P2)

**Goal**: Complete audit/outcome coverage without deferring first-prompt safety.

**Independent Test**: C07/C11/C17–C22 inspect all safe projections and failure paths.

- [x] T016 [US5] Add exhaustive decision/audit behavioral tests in tests/runtime/approvals/audit.test.ts.
  - **Owner**: Trong Tan / evidence tests.
  - **Dependencies**: T015.
  - **Owned Paths**: tests/runtime/approvals/audit.test.ts.
  - **Acceptance Checks**: Test all classification/decision/cancellation/stale/uncertain/effect outcomes, atomic journal/outbox failure, secret/raw-stream markers, UTF-8/page bounds, ANSI/OSC/bidi controls and over-bound uninspectable details. Tests call actual presentation/service exports, not a fake SUT.
  - **Current Evidence**: Corrected candidate `d4a265c8c09b9e525543678819ada87cb264429c` was independently accepted and integrated at `51fe5a9a9d756c4d325fcc16711d8e654e6e8f52`. The 21 audit vectors exercise actual service/presentation exports with injected mock owners. Source/emitted approval suites each pass 181/181; eight independent merger reproductions pass, including six corrected journal/detail-availability failures and positive later-run/historical-policy controls. Typecheck, scoped lint, build and whitespace checks pass. RED/GREEN and integrated command logs remain local under `.agent-work/2026-10-22/uc05-phase7-history-cli/`. These checks establish only exercised mock/local behavior, not durable atomicity, real effects, adapters, production profiles or process restart.

- [x] T017 [US5] Complete safe event/projection behavior in src/approvals/presentation.ts and src/approvals/service.ts.
  - **Owner**: Trong Tan / evidence implementation.
  - **Dependencies**: T016.
  - **Owned Paths**: src/approvals/presentation.ts; src/approvals/service.ts; src/approvals/history.ts; src/approvals/service-context.ts; src/approvals/service-control.ts; src/approvals/service-data.ts; src/approvals/service-decision.ts; src/approvals/service-request.ts.
  - **Acceptance Checks**: T016 green; durable decision/outbox evidence distinct from best-effort telemetry, metadata-only traces, no protected collection, no approval-only success. Do not alter Tai's telemetry implementation.
  - **Current Evidence**: Same accepted integration and checks as T016. The read-only `ApprovalService.history(taskId, page)` projects admitted immutable records and journal metadata as complete JSON entries with snapshot digest and UTF-8 page/aggregate envelope bounds. Consent authority and history share reciprocal record/event admission; missing, foreign, duplicate or contradictory evidence fails closed. Current classification/freshness and injected owner activity observations remain explicitly separate from committed events, with unknown facts preserved; approval never establishes verified completion. Stalled current detail providers yield unknown observations without hiding committed history. Necessary cohesive service helpers preserve canonical ApprovalPort signatures, the shared admission/expiry fence and runtime import acyclicity; all eight authored implementation files are below the 20,000-byte staged-file limit. No telemetry, canonical schema, foreign owner implementation or persistence engine was added. T018 was subsequently accepted as recorded below. The later Phase 8 instruction authorizes T019–T022; real delivery dependencies remain separate.

- [x] T018 [US5] Complete CLI safe outcome/exit behavior in src/approvals/cli.ts and tests/runtime/approvals/cli.test.ts.
  - **Owner**: Trong Tan / operator reporting.
  - **Dependencies**: T017.
  - **Owned Paths**: src/approvals/cli.ts; tests/runtime/approvals/cli.test.ts.
  - **Acceptance Checks**: Test-first CLI outcome matrix matches contracts, current requests never silently selected, contradictory replies conflict, uncertainty and missing stores remain paused. Explicit `history --task TASK --page N` reads the admitted metadata projection without requiring a current request selector or treating approval as effect success. All existing CLI vectors pass without printing raw artifacts or credentials.
  - **Current Evidence**: Candidate `55535c2d7f6484d3e57909bae869b7622edf2872` was independently accepted and integrated at `17b1605c48e47ad85c99f6fba2fe9202a51a1413`, changing only the two owned paths (272 reviewable lines; no generated/binary changes). The integrated source approval suite passes 192/192, including 23 actual CLI subprocess tests; five independent merger checks through actual service/CLI exports and the direct executable pass. Scoped lint and whitespace pass; the candidate separately passed typecheck, build and emitted approvals 192/192. Explicit history reads exit 0 for inspectable stale/rejected/unknown metadata; stale detail access remains exit 3, invalid selectors 2, denied authority 4, unavailable/uncertain 5. Tests retain same-child owner snapshots for pagination, immutable retries/newer holds and lost committed responses; local admission remains closed on uncertainty without inventing durable pause records or definite noncommit. Protected/raw/terminal payloads never enter safe output, and direct executable composition remains unavailable. RED/GREEN, handoff and exact command evidence remain local under `.agent-work/2026-10-22/uc05-phase7-history-cli/`. Evidence is mock/local only; the coordinator subsequently passed the full runtime gate (1037 compiled tests), contributor gate (227 tests) and applied the three-document context refresh. Pinned review/convergence and paired publication remain pending at this checkpoint. Phase 8 is subsequently authorized; real/restart dependencies remain unmet.

## Phase 8: Integration and Cross-Cutting Acceptance

**Goal**: Distinguish complete local coverage from real delivery and prove required integrations.

- [x] T019 Register complete local acceptance and two-run comparison in tests/runtime/approvals/acceptance.test.ts.
  - **Owner**: Trong Tan / UC-scoped acceptance.
  - **Dependencies**: T018.
  - **Owned Paths**: tests/runtime/approvals/acceptance.test.ts.
  - **Acceptance Checks**: Every C01–C24 case accounted for with fixture/profile/oracle/source/evidence identity; required real/restart cases report not-run until delivered. No missing-as-pass or mock-as-real; comparable two-run results. This is a UC-scoped test suite, not a replacement shared evaluation runner. Runtime typecheck/lint/build and applicable regressions pass.
  - **Current Evidence**: Candidate `0a86684da0ac1eeb2bdfa7e669c97ece3cf639b8` was independently accepted and integrated at `26ade4ea581bdc2ae9ddbe918850fe4aab725b14`, adding only the owned test (287 reviewable lines; no generated/binary changes). Source and emitted focused acceptance each pass 2/2; each observes two fresh subprocess runs of the 192 existing approval tests, rather than counting those repeated observations as new tests. All C01–C24 rows retain explicit partial local scopes and fixture/profile/oracle/source/evidence identities; all 104 required real/restart vectors remain not-run, fixture effect counts are unobserved and full acceptance is false. Behavioral RED/GREEN covers changed identity and orphaned global witnesses; twelve independent probes reject missing/error/failed/approval-only evidence, lost vectors, foreign identities and fabricated effect/completion claims. Child commands exclude acceptance itself and reports retain safe metadata without raw streams. On the integrated source, `node scripts/ci/check-runtime.mjs` passed typecheck, full lint, clean build and 1098 compiled tests (including the two new acceptance tests); `pnpm run test:contributors` passed 227/227, both exit 0. Evidence is retained locally under `.agent-work/2026-10-22/uc05-phase8-acceptance/`. T020–T022 remain unchecked with external owner/profile/real/restart prerequisites; no real integration, durable atomicity or process restart is established.

- [ ] T020 Prove real shared admission and approval integration in tests/runtime/approvals/integration.test.ts.
  - **Owner**: Trong Tan approval acceptance; Tai execution/admission; Thanh Tan durable store.
  - **Dependencies**: T019; external X04-APPROVAL-STORE, X03-ADMISSION, X03-PLAN-CONTEXT and G-PROFILE/G-REAL.
  - **Owned Paths**: tests/runtime/approvals/integration.test.ts; docs/verification/uc05-integration.md.
  - **Acceptance Checks**: Actual store, task-wide model/reviewer/tool/scheduler admission and isolated executor, no gate/store replacement mocks. C01–C16/C20–C23 before-effect denial/pause, operator authority and race claims are proven; instrument actual model admission without claiming live model quality. Record owner ledger/revision/profile/host and all commands. Missing evidence remains not-run, not a fabricated adapter. Evidence file stays ignored.

- [ ] T021 Prove actual process restart and uncertain effects in tests/runtime/approvals/restart.test.ts.
  - **Owner**: Trong Tan with Thanh Tan recovery and Tai executor.
  - **Dependencies**: T020; external X04-X05-RESTART and accepted adapter revisions.
  - **Owned Paths**: tests/runtime/approvals/restart.test.ts; tests/runtime/support/uc05/restart-child.ts; docs/verification/uc05-restart.md.
  - **Acceptance Checks**: Actually kill/restore trusted runtime processes at C11/C15/C17–C20 failpoints; preserve pause/rejection/decision/history/epoch/budgets, reconcile uncertain effects or retain charge, no blind duplicate attempt. Disposable isolated workspace, platform-specific evidence and explicit limitations; mocks/same-process reload do not pass. Detailed evidence stays ignored.

- [ ] T022 Review complete evidence and publish the verified UC-05 delivery scope in specs/023-uc05-human-approval/contracts/decisions.md and context/progress_checker.md.
  - **Owner**: Trong Tan / coordinator.
  - **Dependencies**: T021.
  - **Owned Paths**: specs/023-uc05-human-approval/contracts/decisions.md; context/progress_checker.md; docs/use-case-delegation.md; docs/verification/uc05-acceptance.md.
  - **Acceptance Checks**: C24 final comparison, all required cases/current source reviewed, X05-GATE handoff links real consumer-compatible revisions; honest partial/unrun status if applicable. Apply context refresh and required contributor publication gates before contributor completion. No runtime capability promoted by planning/helper CI alone; no automatic merge.

## Dependencies and Execution Order

The canonical dependency edges are declared in each task above; the ready frontier must satisfy every listed prerequisite.

External delivery references are defined in plan.md; they are not foreign T-numbers. Every source/test overlap has an ordered owner transfer. T002 and T003 alone carry [P]: after T001 they can author disjoint validators and pre-agreed fixture records, joining at T004. No story phase is independently concurrent in this initial conservative graph.

## Implementation Strategy

The first local MVP is contracts/cases/mocks plus US1's safe service/CLI. It is not production-ready without US2/US3 control and real external composition. Deliver each story through its own focused tests and retain prior regression coverage. After local T019, obtain actual external adapters for T020/T021 instead of implementing a second executor/store. Only observed acceptance plus review can release a scoped X05-GATE handoff.

Original phase counts: setup 1; foundations 3; US1 3; US2 3; US3 3; US4 2; US5 3; integration/cross-cutting 4. The 22 original delivery tasks plus T023–T028 review corrections total 28 tasks. Planning quality never pre-completes implementation tasks or authorizes phase dispatch.

## Review correction within authorized Phase 3

- [x] T023 [US1] Correct T007 prior-response retry admission and reviewed validation/test issues in src/approvals/service.ts and tests/runtime/approvals/service.test.ts.
  - **Owner**: Trong Tan / service and operator boundary.
  - **Dependencies**: T007.
  - **Owned Paths**: src/approvals/service.ts; tests/runtime/approvals/service.test.ts.
  - **Acceptance Checks**: Behavioral RED/GREEN through the confirmed actual-service/mock-store seam: approve A, create pending B, repeat identical response A, preserve B waiting, approve B and retain valid eligible admission. Validate unknown trusted-provider context before type assertions. Replace or remove the disconnected activity-mock assertion with documented justification, retaining all meaningful consent/pause/admission assertions. Independent integration and required runtime gates pass. This is a correction of T007 under FR-012 and the existing four confirmed seams; no T008–T022 capability is authorized.
  - **Current Evidence**: Candidate `969336904e335fb5f73b4a086b721713488d921f` independently accepted and integrated at `2b80b767ecde9897696dbe30fd70970cbb7ea0dc`, changing only the two owned paths. Behavioral RED/GREEN proves earlier-response retry preserves the later pending hold and both open/previously closed local admission states; complete plain-data context admission rejects malformed records and accessors without getter calls. Removed only a disconnected activity fixture/assertion that could not observe the service, retaining meaningful consent/pause/history/admission assertions. Integrated source/emitted approval suites passed 66/66 each; required runtime typecheck, full lint, clean build and 623/623 compiled tests passed. Evidence remains local under `.agent-work/2026-10-19/uc05-phase3/service/review-correction/`. No later-story, real adapter, execution or restart capability was added.

## Review correction within authorized Phase 4

Post-publication T008–T009 correction (`3816056`, PR #75): user-authorized review repair restores the previous local admission state after validated `denied`, `conflict`, `invalid` or `stale` direction/decision receipts. `unavailable` and `uncertain` remain fail-closed. Public service/control regression tests reproduced denied-resume-then-approval and decision-conflict-then-approval failures before their respective fixes; outcome matrices retain uncertainty coverage. Source approvals pass 103/103; runtime typecheck, lint, build and 660 compiled tests pass. This changes no contract, seam, later-phase authorization or production/restart gate.

- [x] T024 [US2] Complete positive cancellation/completion evidence for T008–T009 in tests/runtime/approvals/control.test.ts per FR-007/019–021 and US2.11.
  - **Owner**: Trong Tan / Phase 4 behavioral coverage.
  - **Dependencies**: T010.
  - **Owned Paths**: tests/runtime/approvals/control.test.ts.
  - **Acceptance Checks**: Through actual service/coordinator admission and rejection fencing, observe successful completed and cancelled mock outcomes separately, retaining original rejection and zero further admission without explicit direction. Cancellation success requires a request issued by the SUT and no recorded effect; completed observations never imply rollback. Keep uncertainty/refused-cancellation coverage intact. This closes the verified Phase 4 review evidence gap only; no new runtime capability, test seam, later story, adapter or real restart work is authorized.
  - **Current Evidence**: Test-only candidate `0acb8c9` independently accepted at `c390fc6a6b9b8afe57168ca24faa3e443f3dbbae`, adding 23 lines to the one owned file. Both new tests passed immediately against existing behavior; no artificial RED or production edit was introduced. Actual service admission/rejection fencing precedes successful completed/cancelled observations, preserving exact rejected control/history and denying current-version admission/classification. Source/emitted approvals each pass 90/90 (control 16/16); typecheck/build/scoped lint/whitespace pass. This resolves the narrow Spec P2 coverage finding only.

## Phase 9: Convergence and review — Phase 5 binding corrections

- [x] T025 [US3] Prevent injected-port failure text from becoming stale authority or protected output in src/approvals/service.ts and tests/runtime/approvals/service.test.ts per FR-010–011/020 (contradicts).
  - **Owner**: Trong Tan / approval failure boundary.
  - **Dependencies**: T012.
  - **Owned Paths**: src/approvals/service.ts; tests/runtime/approvals/service.test.ts.
  - **Acceptance Checks**: Actual service with injected port throwing a service-shaped stale error cannot disclose its protected/raw reason, create a stale assessment or replace a pending request solely from that exception. Validated deterministic freshness still produces safe stale projections. Preserve bounded operation, prior immutable history and fail-closed admission on unavailable/uncertain failures; test-first vertical slices, independent integration and scoped checks. No canonical/store/workflow or T014–T022 expansion.
  - **Current Evidence**: Independently accepted integration `1f02efe4ffddbd3d23d872610af8267941f02510` retains T013 and normalizes injected store/context/activity/clock exceptions to safe unavailable outcomes. Six independent RED/GREEN slices and the related replacement-history regression retain waiting/history and prevent exception-based stale authority. Six independent merger reproductions pass, including the four earlier fixed cases. Combined source approval/contracts 314/314, emitted approvals 139/139, typecheck/build/scoped lint/whitespace pass. Two owned paths, 130 reviewable lines; no canonical/foreign/runtime-composition change.

- [x] T026 [US3] Validate the initial pending-lookup receipt before property access in src/approvals/service.ts and tests/runtime/approvals/service.test.ts per FR-020/US2.10 (contradicts).
  - **Owner**: Trong Tan / approval receipt boundary.
  - **Dependencies**: T025.
  - **Owned Paths**: src/approvals/service.ts; tests/runtime/approvals/service.test.ts.
  - **Acceptance Checks**: Actual service with readRequest returning accessors must refuse before invoking getters; protected service-shaped stale errors cannot escape through outcome/reason or preserve open admission. Retain pending/history and normalized unavailable failure; behavioral RED/GREEN, prior approval regressions, independent integration and review of the changed revision. No new seam or foreign implementation.
  - **Current Evidence**: Independent integration `6d4091c92a2c4ff8161c1746603035ee398e3dfb`, two paths and 24 reviewable lines. Public-service RED/GREEN covers runnable and waiting lookup responses: getters remain uninvoked, failure is safe unavailable, history/control stay unchanged and admission remains closed after adapter recovery. Independent new-plus-prior reproductions pass 7/7; source approval/contracts 315/315, source/emitted approvals 140/140, typecheck/build/scoped lint/whitespace pass. This resolves the pinned Spec-review P1 only.

- [x] T027 [US3] Bind a retired request's stale assessment digest to the admitted context that produced its verdict in src/approvals/service.ts and tests/runtime/approvals/service.test.ts per FR-010–011/020 (contradicts).
  - **Owner**: Trong Tan / exact assessment context.
  - **Dependencies**: T026.
  - **Owned Paths**: src/approvals/service.ts; tests/runtime/approvals/service.test.ts.
  - **Acceptance Checks**: Through the confirmed actual-service/mock-store seam, use different trusted contexts for old and replacement decisions; preserve the exact admitted old context that produced stale reasons and hash it for the old request's assessment. Do not reload a later context or accept exception-supplied authority. Retain request-context stale checks, safe error output, immutable history, waiting transaction and prior failures. Behavioral RED/GREEN, independent integration, affected context consistency and pinned review must pass. Correct the two verified status rows that omitted T026. No new contract, port, seam or later-phase authorization.
  - **Current Evidence**: Independent integration `84be181f68bf56481e53676ad44bc00dd45f1211`, two owned paths and 78 reviewable lines. Two behavioral RED/GREEN slices and independent repros cover canonical freshness and later request-context drift with distinct per-decision contexts, exactly one old-provider load and safe public errors. A private verdict-to-digest association retains the exact admitted old context; no public signature or context reload is added. New/prior independent repros pass 9/9, source approvals/contracts 317/317, source/emitted approvals 142/142, typecheck/build/scoped lint/whitespace pass. Coordinator runtime gate passes typecheck/full lint/build and 896 compiled tests. The verified status omissions are corrected with context refresh; contributor review/publication remains separate.

## Review correction within authorized Phase 8

- [x] T028 Correct observed local evidence tiers in tests/runtime/approvals/acceptance.test.ts per FR-022/SC-008 and T019's result-identity contract.
  - **Owner**: Trong Tan / local acceptance metadata.
  - **Dependencies**: T019.
  - **Owned Paths**: tests/runtime/approvals/acceptance.test.ts.
  - **Acceptance Checks**: Keep the fixture's planned preparation tier separate from the observed tier of explicitly mapped witnesses. C02 policy, C21 direct service/presentation and C23 actual executable observations report their actual local levels; global unrelated CLI checks cannot promote a row's tier. Behavioral RED/GREEN rejects the previous mislabeled metadata and altered observed tiers. Preserve all 24 partial rows, 104 required real/restart vectors as not-run, unknown effect counts, comparable two-run results and fullAcceptance false. Independent integration, affected checks and revised pinned review pass. This corrects the verified T019 Spec P2 only; no product runtime, fixture/oracle amendment, new seam or T020–T022 implementation is released.
  - **Current Evidence**: Candidate `4b865518e94bcdb61db282ef10b797b1315b8928` was independently accepted and integrated at `391d3ff9e484864f89cecf28133ec413b7607e86`, changing only the owned test (27 added + 4 deleted = 31 reviewable/total lines; no generated/binary changes). `plannedPreparationLevel` retains fixture intent while the closed mapped witness suite determines observed `localLevel` and its evidence identity: C02 unit, C21 mock, C23 cli and C24 unit. Actual two-run metadata first failed the C02 observed-tier assertion before correction; source and emitted focused acceptance then each passed 2/2, each observing two 192/192 inherited runs. Independent probes on both final reports each passed 48 row-tier checks and nine changed/identical tier-tamper refusals. All 24 rows remain partial, all 104 required real/restart vectors not-run, effects unobserved and full acceptance false. Parent gates on source `391d3ff` passed runtime typecheck/full lint/clean build/1098 compiled tests with no skips and 227/227 contributor tests (both exit 0). Revised independent Standards and Spec reviews at `b2869c8187f3640387f55305f51fe66c16bc5b39` each report zero findings/zero blocking; Spec explicitly resolves the P2. Local evidence is retained under `.agent-work/2026-10-22/uc05-phase8-acceptance/worker/t028/`, `merger/t028/` and `reviews/`. T020–T022 remain unchecked with their existing external prerequisites; no real integration, durability or actual restart is established.
