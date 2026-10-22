# Tasks: UC-03 — Verified Code Repair

**Input**: Design documents from `/specs/001-verified-code-repair/`.
**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [interfaces](contracts/interfaces.md), [acceptance](contracts/acceptance.md).
**Status**: Phase 1 (T001–T002) completed; Phase 2 (T003–T004) authorized by the user on 2026-10-16 (Asia/Saigon). Shared-owner agreement to current contracts remains recorded, and production choices remain mandatory before real execution. Phase 3 (T005–T014) is authorized by the user on 2026-10-18 (Asia/Saigon); Phase 4 (T015–T018) is authorized on 2026-10-21 (Asia/Saigon); Phase 5 (T019–T025) is authorized on 2026-10-22 (Asia/Saigon); real-only T024–T025 prerequisites and Phase 6 remain gated. Completion is recorded only after integrated checks; see [decisions](contracts/decisions.md).
**Tests**: Required by FR-013 and repository test-first guidance. Each implementation task demonstrates its behavioral RED before GREEN; a missing module/collection failure is not a valid behavioral RED. Bootstrap commands are available in quickstart.md; behavioral product-runtime commands remain future work.
**Phase 1 evidence**: [Initial verification](https://github.com/pminhtaiii/slop-loop/blob/ee5be9b147efb44511b8e65ece375fc904c5f062/docs/verification/2026-10-16-verified-code-repair-phase1.md) records integrated checks and independent review for T001–T002. Current pnpm verification and future evidence outputs under `docs/verification/` are intentionally local-only and must not be force-added. The current request covers Phase 5 T019–T025; T026–T034 remain outside scope.
**Organization**: User-story phases follow Spec Kit; priorities do not override DAG edges or permit delayed safety gates. US3 is P1 despite its section position. Final phase integrates all stories.

## Format: `[ID] [P?] [Story] Description`

Checkboxes use sequential T001–T034. `[P]` means disjoint owned files and parallel eligibility **only at a ready frontier with all listed dependencies already satisfied**; it never bypasses prerequisites. Dependencies below are authoritative edges, not phase-wide barriers. Only checked tasks with integrated verification evidence count as completed dependencies.

Tai is accountable for all local tasks, including shared foundation. Named lanes (contracts, tools, model, reviewer, workflow, evaluation) describe possible future delegation under Tai; they do not assign new colleagues. Thanh Tan and Trong Tan own external deliverables only. Parallel opportunities assume Tai delegates disjoint ready work; no worker gets remote authority. Only the coordinator changes checkboxes after integrated evidence passes.

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Record reviewed decisions and owner agreement in specs/001-verified-code-repair/contracts/decisions.md before implementation.
  - **Owner**: Tai, coordinating Thanh Tan (UC-04) and Trong Tan (UC-05).
  - **Dependencies**: None; review task can start immediately.
  - **Owned Paths**: specs/001-verified-code-repair/contracts/decisions.md; plan.md; research.md; data-model.md; contracts/interfaces.md; tasks.md (coordinator-only approval amendments).
  - **Acceptance Checks**: Record accepted feature/contract v0.1 revisions, shared path ownership, Tai's reviewer responsibility, UC-05 fix-plan binding and UC-04 accounting semantics; resolve placeholder constitution governance and preserve the accepted ADR-0004 decisions from upstream 5a81b3a; obtain agreement on concrete binding/accounting rather than reopen accepted behavior. Record exact bootstrap toolchain choices. Per the user-approved Phase 1 amendment, provider/storage/platform/isolation/retention/evaluation choices and finite trusted production configuration may remain explicit release blockers before real execution, rather than blockers to T002 build setup. Link actual foreign ledgers when available; do not fabricate external task IDs. Revise draft if owners disagree; no runtime edits under unresolved choices.

- [X] T002 Establish the selected strict TypeScript/LangGraph build in package.json, tsconfig.json and the selected lockfile.
  - **Owner**: Tai / bootstrap lane.
  - **Dependencies**: T001.
  - **Owned Paths**: package.json; tsconfig.json; selected package-manager lockfile; selected lint/build config; .github/workflows/runtime-checks.yml.
  - **Acceptance Checks**: Install only selected versions; document exact build, focused runtime-test, lint and strict compiler commands in quickstart.md through coordinator handoff. CI runs strict compiler and mechanical lint. Existing contributor helpers stay runnable. No provider secret in repository config. A scaffold is not UC-03 acceptance.

## Phase 2: Foundational (Minimal Development Prerequisites)

- [X] T003 Implement canonical contract validators and conformance vectors in src/contracts/foundation/uc03.ts and tests/runtime/contract/uc03.test.ts.
  - **Owner**: Tai / contracts lane; UC-04/UC-05 owners review their ports.
  - **Dependencies**: T001, T002.
  - **Owned Paths**: src/contracts/foundation/uc03.ts; tests/runtime/contract/uc03.test.ts.
  - **Acceptance Checks**: Behavioral tests reject malformed input/model/review/checkpoint/action data, invalid finite limits, stale digests and invalid transitions; agree envelope/version and typed outcomes from interfaces.md. One schema suite applies unchanged to mocks and real adapters. No persistence or approval implementation here. Include CommandView admission/digest and ProviderRequest role, finite ceilings, pre-dispatch reservation refs, observed/uncertain usage vectors from the revised data model; no provider call may accept a post-call estimate as authority.

- [X] T004 Build controlled port mocks in tests/runtime/support/uc03/ and verify them in tests/runtime/contract/uc03-mocks.test.ts.
  - **Owner**: Tai / test-support lane.
  - **Dependencies**: T003.
  - **Owned Paths**: tests/runtime/support/uc03/; tests/runtime/contract/uc03-mocks.test.ts.
  - **Acceptance Checks**: MemoryStatePort, ScriptedApprovalPort, ScriptedModelPort, FakeRepositoryPort and ScriptedReviewerPort pass accepted schema vectors; cover CAS conflict, reservations, stale/denied decisions, failures and partial evidence with explicit finite profiles. No real commands/network/durable-store claim. Mark mock provenance and reject production fallback. Replacement tasks T025/T028/T030/T032 are documented. State mocks support atomic multi-budget reservation and interrupted provider requests; model/reviewer spies count attempted dispatches, including zero-call missing/exhausted-budget cases. These remain simulated accounting, not real durability evidence.

**Checkpoint**: After T004, all three stories can develop independently against the same contracts. Real shared components below are not prerequisites for mock-backed story work. Contract signoff is not a claim those components exist.

## Phase 3: User Story 1 - Receive a verified localized fix (Priority: P1)

**Goal**: Validated task to evidence-backed final result. **Independent Test**: C01/C02/C16 through the injected route; real acceptance at T028. The mock milestone alone is not a delivered verified fix.

- [X] T005 [P] [US1] Prepare public seeded bug and input fixtures in fixtures/uc03/success/ and fixtures/uc03/input/.
  - **Owner**: Tai / evaluation-fixture lane.
  - **Dependencies**: T004.
  - **Owned Paths**: fixtures/uc03/success/; fixtures/uc03/input/.
  - **Acceptance Checks**: Task declares reproduction/criteria/check-set; public Python/pytest source has localized bug, failing reproduction and required existing passing checks. Include missing/ambiguous input, non-reproduction and collection-error vectors. No hidden answers in agent-visible files; no pytest execution until real guard is integrated (T024/T028).

- [ ] T006 [P] [US1] Build Docker workspace lifecycle and structured executor in src/foundation/docker-workspace.ts.
  - **Owner**: Tai / container lane (shared foundation).
  - **Dependencies**: T004.
  - **Owned Paths**: src/foundation/docker-workspace.ts; tests/runtime/unit/docker-workspace.test.ts; docker/uc03/Dockerfile; docker/uc03/profile.json.
  - **Acceptance Checks**: Test-first fake-controller checks enforce the interfaces.md command-view boundary: canonical repository writable only by trusted patches without repository-code execution, protected paths/content excluded before view creation, byte-identical admitted source/tests mounted read-only for every repository command, only scratch writable, no writable source overlay or canonical-volume access. Enforce non-root/read-only root, prepared image, network none, finite resources and absent host/socket/credential/grader mounts. Reject stale views and required files with protected content; no silent executable-source redaction. Preserve canonical workspace identity through UC-04 resume and invalidate derived views on change. Actual malicious-pytest read/write/isolation proof awaits T024; no real repository execution before that gate.

- [ ] T007 [P] [US1] Implement controlled repository operations in src/foundation/repository-tools.ts.
  - **Owner**: Tai / repository-tools lane (shared foundation).
  - **Dependencies**: T004.
  - **Owned Paths**: src/foundation/repository-tools.ts; tests/runtime/unit/repository-tools.test.ts.
  - **Acceptance Checks**: Test-first injected-executor suite covers list/read/search/unified patch, test commands and diff inspection; canonical paths and new-file parents rechecked; protected paths/content sanitized or denied; existing tests cannot be weakened; patch breadth and argv validated without shell. Tool calls require ExecutionGuard capability, never expose raw process access. Use T004 ports/executor spy until T024. Trusted patch path never runs repository hooks/plugins with writable canonical access. Build/check admitted command-view digests, exclude protected content before copying and reject stale or semantically changed source; commands get no canonical writable mount. Verify failed pytest write attempts cannot be promoted from scratch into canonical source/tests.

- [ ] T008 [P] [US1] Implement validated host model boundary in src/foundation/model.ts.
  - **Owner**: Tai / model lane (shared foundation).
  - **Dependencies**: T004.
  - **Owned Paths**: src/foundation/model.ts; tests/runtime/unit/model.test.ts.
  - **Acceptance Checks**: Invalid outputs cannot dispatch tools; validated proposals receive approved bounded evidence/provenance and usage/cost; provider config stays on host. Test provider stub errors/timeouts/injection handling. T028 separately exercises real configured model; no delegated coding-agent product. Implement the host-provider budget protocol in interfaces.md for every coder request: stable providerRequestId, enforced conservative input/output token/cost ceilings and pricing/config IDs, atomic UC-04 reservation before network, observed billable usage settlement even on invalid output, charged uncertain timeout/crash requests and no blind replay. Stub/spy tests assert zero dispatch on missing/exhausted/inconsistent budgets and no dispatch on partial reservation; no permissive retry fallback.

- [ ] T009 [P] [US1] Implement distinct read-only reviewer boundary in src/foundation/reviewer.ts.
  - **Owner**: Tai / reviewer lane (shared foundation assignment accepted at T001).
  - **Dependencies**: T004.
  - **Owned Paths**: src/foundation/reviewer.ts; tests/runtime/unit/reviewer.test.ts.
  - **Acceptance Checks**: Separate role/config, validated findings and real diff line membership, read-only bounded evidence, write/execute rejection and finite iteration reservations. T004 scripted outputs enable tests; reviewer quality and real enforcement need T030. Route all reviewer model calls through the same budgeted ModelPort protocol; reserve reviewer iterations and token/cost ceilings before provider dispatch, settle actual usage and retain unknown charges on interruption. Tests independently assert zero reviewer provider calls with absent/exhausted token/cost or iteration allowances. Model/reviewer telemetry never replenishes the shared task ledger.

- [X] T010 [P] [US1] Implement sanitized activity and usage event boundary in src/foundation/telemetry.ts.
  - **Owner**: Tai / telemetry lane (shared foundation).
  - **Dependencies**: T004.
  - **Owned Paths**: src/foundation/telemetry.ts; tests/runtime/unit/telemetry.test.ts.
  - **Acceptance Checks**: Stable task/run/node/action IDs, durations/outcomes, approvals and evidence refs; bounded redacted diagnostics, no source bodies/prompts/raw streams/protected payloads. Record per-run usage/cost while cumulative ledgers remain UC-04-owned. Marker-secret tests cover success and error paths.

- [ ] T011 [P] [US1] Create minimal runnable SUT skeletons and failing success checks in tests/runtime/unit/uc03-success.test.ts.
  - **Owner**: Tai / workflow-test lane.
  - **Dependencies**: T004, T005.
  - **Owned Paths**: tests/runtime/unit/uc03-success.test.ts; src/uc03/input.ts, src/uc03/investigation.ts and src/uc03/verification.ts (signature-only skeleton ownership until T011 handoff).
  - **Acceptance Checks**: Create real exported signatures using T003 contracts and neutral incomplete/not-implemented behavior in the three owned source modules, with no feature implementation. Tests load those SUT modules successfully and run C01/C02/C16 assertions on missing/ambiguous input, baseline/plan approval, verification/current-state review and invalidation using T004 dependency mocks. Record expected assertion failures against real SUT skeletons; import/collection/type errors or replacing the SUT itself with a mock do not qualify. After this RED checkpoint, freeze test ownership here and explicitly transfer input.ts to T012, investigation.ts to T013 and verification.ts to T014; successors replace their skeletons and report passing behavioral subsets.

- [ ] T012 [P] [US1] Implement supplied bug-task intake in src/uc03/input.ts.
  - **Owner**: Tai / intake lane.
  - **Dependencies**: T011.
  - **Owned Paths**: src/uc03/input.ts.
  - **Acceptance Checks**: Input subset of T011 passes; missing reproduction/criteria/repository asks for information; ambiguity requires confirmation. No UC-01 issue integration or invented expectations. Use accepted validators and T004 task/state fixtures. Take input.ts ownership from completed T011 and replace its neutral skeleton; exercise the actual SUT, not a mock implementation.

- [X] T013 [US1] Implement adaptive investigation, baseline and plan preparation in src/uc03/investigation.ts.
  - **Owner**: Tai / investigation lane.
  - **Dependencies**: T012.
  - **Owned Paths**: src/uc03/investigation.ts.
  - **Acceptance Checks**: T011 baseline/plan subset passes against T004 ports. Persist reproduction/previously passing checks, criteria/check-set and diagnosis/strategy before edits; allow protected-policy-compliant new regression test; approval rejection waits for feedback. Does not implement UC-05 gate or UC-04 store. Take investigation.ts skeleton ownership from completed T011 (through dependency T012); do not modify sibling source paths owned by T012/T014.

- [X] T014 [P] [US1] Implement verification and deterministic completion predicates in src/uc03/verification.ts.
  - **Owner**: Tai / verification lane.
  - **Dependencies**: T011.
  - **Owned Paths**: src/uc03/verification.ts.
  - **Acceptance Checks**: T011 verification subset passes on saved baseline fixtures independently of T013. Require focused, existing/regression, applicable compatibility, diff and reviewer evidence at current digests; distinguish timeout/not-run/environment failure. Mutating final state invalidates old evidence; applied unverified code stays incomplete. Take verification.ts skeleton ownership from completed T011; its independent path permits parallel work with T012.

## Phase 4: User Story 2 - Repair or stop within limits (Priority: P2)

**Goal**: Evidence-informed repair/replan or honest termination. **Independent Test**: C03–C05/C12 using injected saved-state fixtures without completed US1; real proof T029/T032.

- [X] T015 [P] [US2] Create repair and replan scenarios in fixtures/uc03/repair/.
  - **Owner**: Tai / repair-fixture lane.
  - **Dependencies**: T004.
  - **Owned Paths**: fixtures/uc03/repair/.
  - **Acceptance Checks**: Failed patch then repair, exhausted/absent accounting, focused-pass/regression-fail, reviewer finding, three replans and fourth refusal; explicit finite profiles and versioned saved baseline states. No dependency on US1 implementation or actual UC-04/UC-05.
  - **Local-only verification (2026-10-21)**: Worker handoff verified at `3fb6fdd`; all 21 repair fixture files match source/destination SHA-256 hashes and remain ignored/untracked. `node fixtures/uc03/repair/validate.mjs` passed 18 entries (14 saved states, three evidence records and four-profile bundle). Static contract checks only; no real execution or UC-04/UC-05 integration evidence.

- [X] T016 [US2] Create the runnable repair SUT skeleton and failing checks in tests/runtime/unit/uc03-repair.test.ts.
  - **Owner**: Tai / repair-test lane.
  - **Dependencies**: T015.
  - **Owned Paths**: tests/runtime/unit/uc03-repair.test.ts; src/uc03/repair.ts (signature-only skeleton ownership until T016 handoff).
  - **Acceptance Checks**: C03–C05/C12 cover failure-evidence propagation, reservation-before-repair, exhaustion, persistent task budgets across simulated runs, user feedback wait, material/minor distinction, no fourth execution and no reset. T004 mocks only; simulation is labelled, not process-restart evidence. Create actual repair/replan exports with neutral incomplete behavior so the test runner loads and reaches assertions against the real SUT; missing-module/type/collection failures and mocking the SUT do not qualify. Record expected assertion RED, then transfer repair.ts ownership to T017 and subsequently T018 in dependency order. Keep genuine implementation in those successors.

- [X] T017 [US2] Implement bounded evidence-driven repair in src/uc03/repair.ts.
  - **Owner**: Tai / repair lane.
  - **Dependencies**: T016.
  - **Owned Paths**: src/uc03/repair.ts (repair behavior).
  - **Acceptance Checks**: Repair subset T016 passes with T004 state/repository/reviewer mocks. Require new failure evidence and reserved budget; return typed transition to verification; exhausted/uncertain/missing accounting returns incomplete rather than retry. No local durable ledger. Take repair.ts skeleton ownership from completed T016, then transfer that same file to dependent T018 after repair behavior acceptance.
  - **Integrated evidence (2026-10-21)**: Accepted mock-only repair at `48611bea`: 26 repair checks pass; persisted guard-confirmed canonical revision routes to Verify and invalidates old active approval/review authority; independent malformed-digest, retained-reservation, replay and both post-effect CAS probes pass. Strict typecheck/lint pass. T016 neutral-skeleton behavioral RED is retained from `eb99ad7`; the unchanged T018 subset collects 11 checks with 3 passing and 8 expected assertion failures. No real execution, durability or restart claim.

- [X] T018 [US2] Add material replan and feedback transitions to src/uc03/repair.ts.
  - **Owner**: Tai / repair lane, sequential after T017 to avoid shared-file writes.
  - **Dependencies**: T017.
  - **Owned Paths**: src/uc03/repair.ts; src/uc03/replan.ts; src/uc03/repair-types.ts (plan/replan behavior).
  - **Acceptance Checks**: Remaining T016 scenarios pass: initial plan zero, three unique charged material revisions, fourth refused; renewed UC-05 decision before revised-strategy edits; rejection waits for user feedback; minor adjustment/clarification does not charge. Simulated recovery preserves reservations; real durability awaits T032.
  - **Integrated evidence (2026-10-21)**: Accepted `63bc871baf03625adabdcd41d69120eaa55311f1` at integration `3f364505`: source/emitted repair suites each pass 57/57; typecheck, lint and build pass. Public StatePort regressions verify charged Investigate-to-AwaitPlan accounting and authoritative reload after failed admission; prior feedback-direction, reservation/replay, finite-ledger and stale-authority checks remain green. Mock-only evidence; no real execution, durability, production adapter or restart claim.

## Phase 5: User Story 3 - Controlled execution and visible outcomes (Priority: P1)

**Goal**: Enforced safety from the first real operation and honest visible reports. **Independent Test**: Guard and attack fixtures work without US1/US2 code; actual isolation/policy proof at T024/T025 and T031.

- [X] T019 [P] [US3] Prepare adversarial repositories and finite-limit profiles in fixtures/uc03/security/.
  - **Owner**: Tai / security-fixture lane.
  - **Dependencies**: T004.
  - **Owned Paths**: fixtures/uc03/security/.
  - **Acceptance Checks**: C06–C11/C13 vectors cover protected tests, traversal/link/parent escapes, .env/PEM/SSH/embedded secrets, injection/equivalent commands, provider env marker, network/resource attempts, unavailable prepared dependencies and each missing finite bound. Safe disposable sentinel design; no actual malicious execution during fixture creation. Include malicious pytest code attempting direct source/existing-test writes, protected-path and embedded-secret reads, and scratch-to-canonical promotion; distinguish prevention from post-run detection. Use synthetic secret markers only, and include required-source embedded-secret refusal before command-view admission.

- [X] T020 [US3] Write isolated attack assertions in tests/runtime/security/uc03-isolation.test.ts.
  - **Owner**: Tai / isolation-test lane.
  - **Dependencies**: T019.
  - **Owned Paths**: tests/runtime/security/uc03-isolation.test.ts.
  - **Acceptance Checks**: Assert denied effects and no protected payloads, not just refusal text. Fixtures are public and isolated; test cannot mount provider/hidden grader. Unit spies may prove assertions initially; real cases must remain not-run until T024, never mock-pass them as isolation evidence. Command-view assertions verify required included files are byte-identical to canonical state, repository source/tests are read-only, protected content was excluded before materialization and temporary/cache writes are confined to scratch. Existing-test/source write probes must be denied before modification, not accepted merely because a digest mismatch is detected afterward.

- [X] T021 [P] [US3] Create the runnable guard SUT skeleton and failing checks in tests/runtime/contract/execution-guard.test.ts.
  - **Owner**: Tai / gate-test lane.
  - **Dependencies**: T004.
  - **Owned Paths**: tests/runtime/contract/execution-guard.test.ts; src/foundation/execution-guard.ts (signature-only skeleton ownership until T021 handoff).
  - **Acceptance Checks**: T004 ports demonstrate zero dispatch before valid config, isolation, reservation and decision; pending/rejected/stale/forbidden handling, exact action identity, CAS conflict and uncertain-effect reconciliation. No UC-05 policy reimplementation. Create the actual guard exports as neutral no-dispatch/incomplete skeletons so tests execute assertions against the real SUT, using T004 only for injected dependencies. No collection/import/type failures count as RED. A valid-action success expectation must fail behaviorally; transfer guard source ownership to dependent T022 only after recording this RED checkpoint.

- [ ] T022 [US3] Compose authoritative execution checks in src/foundation/execution-guard.ts.
  - **Owner**: Tai / execution-integration lane (shared foundation).
  - **Dependencies**: T021, T040, T041, T044, T045, T046.
  - **Owned Paths**: src/foundation/execution-guard.ts.
  - **Acceptance Checks**: T021 passes; compose deterministic pre-effect validation and calls to UC-05/UC-04 ports using contract v0.2.0 and uc05-approval/0.2-draft. Orchestrate workspace lease acquisition, UC-04 single journal claim creation and beginAttempt CAS before low-level dispatch. Enforce receiver one-shot gate, authenticated incarnation, and fencing generation across patch, command, test, and provider adapters. Dispatch only from the winning gate call; record typed outcome receipt (RepositoryActionOutcomeReceipt vs ProviderRequestOutcomeReceipt) and preserve holds. Use T004/T041 mocks for local logic only; no bypass path, local approval store, or blanket environment inheritance. Actual adapters required at T024/T025. Take execution-guard.ts skeleton ownership from completed T021. Deny commands without a fresh admitted read-only view and isolate scratch; enforce controlled-patch versus repository-process authority. Provider requests use host dispatch protocol rather than being misrouted through RepositoryPort.

- [X] T023 [P] [US3] Implement sanitized milestone and final output in src/uc03/report.ts.
  - **Owner**: Tai / delivery lane.
  - **Dependencies**: T004, T010.
  - **Owned Paths**: src/uc03/report.ts; tests/runtime/unit/uc03-report.test.ts.
  - **Acceptance Checks**: Test-first C16 checks show meaningful milestones, final diff/evidence/limitations and actual status without raw reasoning/prompts/streams/protected data. Use saved T004 states; incomplete verification cannot render completed status. UI/streaming framework not added.

- [ ] T024 [US3] Prove real Docker containment with tests/runtime/security/uc03-isolation.test.ts and record docs/verification/uc03-isolation.md.
  - **Owner**: Tai / security-integration lane; Thanh Tan/Trong Tan supply their real ports.
  - **Dependencies**: T006, T007, T020, T022; external X04-STATE and X05-GATE.
  - **Owned Paths**: docs/verification/uc03-isolation.md; evidence artifacts owned by that report. T020 owns test source; failures return to its owner before rerun.
  - **Acceptance Checks**: Run C06–C11 through real shared guard/adapters in disposable containers before any real UC-03 mutation. Prove no-shell argv, network/filesystem/env/resource isolation, test protection, fresh task state, secret-safe outputs and failure before effects for missing bounds/isolation. Capture exact image/profile/platform/adapter revisions, commands/exit codes and sentinels. No mocks in this acceptance run; unsupported junction platform is explicit, not a pass. Real malicious pytest cannot read excluded .env/key/embedded-secret markers or write source/existing tests despite an allowed test command; no canonical writable volume is present. Assert forbidden content never entered view/cache, required secret-bearing source refuses before execution, permitted source bytes match canonical digests, and scratch output cannot mutate or silently replace canonical files.

- [ ] T025 [US3] Verify real UC-05 action and plan gating in tests/runtime/integration/uc03-approvals.test.ts.
  - **Owner**: Tai / approval-consumer integration; Trong Tan owns X05-GATE, Thanh Tan owns X04-STATE.
  - **Dependencies**: T024; external X05-GATE and X04-STATE.
  - **Owned Paths**: tests/runtime/integration/uc03-approvals.test.ts; docs/verification/uc03-approvals.md.
  - **Acceptance Checks**: C13 real allowed/pending/approved/rejected/revised/stale/forbidden decisions and plan approval prerequisites before edits, exact continuation and equivalence rejection. Replace ScriptedApprovalPort with real gate; decisions supplied explicitly by human/test driver, never automatic production approval. Restart evidence remains T032.

## Phase 6: Integration, Evaluation & Cross-Cutting Concerns

- [ ] T026 Wire the gated LangGraph route and thin entry point in src/uc03/graph.ts and src/cli/uc03.ts.
  - **Owner**: Tai / workflow integrator.
  - **Dependencies**: T013, T014, T018, T022, T023.
  - **Owned Paths**: src/uc03/graph.ts; src/cli/uc03.ts; tests/runtime/unit/uc03-graph.test.ts.
  - **Acceptance Checks**: Test-first full route with T004 mocks covers success, pending/feedback, repair/replan, verification/review and honest delivery. Validate restored state and typed outcomes. Production adapter path refuses mock dependencies and real dispatch until accepted real components are supplied; no unrestricted host IO. Mock route pass is development evidence only.

- [ ] T027 [P] Build one-command evaluation and comparison in eval/uc03/runner.ts and eval/uc03/compare.ts.
  - **Owner**: Tai / evaluation infrastructure (shared foundation).
  - **Dependencies**: T005, T015, T019, T003.
  - **Owned Paths**: eval/uc03/runner.ts; eval/uc03/compare.ts; eval/uc03/manifest.json; eval/uc03/private/; tests/runtime/unit/uc03-evaluation.test.ts.
  - **Acceptance Checks**: Test-first manifest covers C01–C17; validated case JSON, expected/actual outcomes, pass/fail/error/not-run, digests, metrics and two-run comparison. Fake driver permits development before T026; hidden grading stays host-private and grader executes repository code under isolation. Nonzero for required failure/error/not-run; mock mode cannot emit real-verified result. Provide future commands from quickstart.md after T002's build contract.

- [ ] T028 Integrate real success route and all port replacements in tests/runtime/integration/uc03-success.test.ts.
  - **Owner**: Tai / UC-03 integrator with Thanh Tan and Trong Tan delivery evidence.
  - **Dependencies**: T008, T009, T025, T026, T027; external X04-STATE and X05-GATE.
  - **Owned Paths**: tests/runtime/integration/uc03-success.test.ts; docs/verification/uc03-success.md.
  - **Acceptance Checks**: C01/C02/C16 with actual Docker tools, model, UC-04 store, UC-05 decisions and reviewer; no T004 mocks. Persist baseline failure, require explicit plan approval, execute focused/regression checks, final current-state review/diff and report. Record model usage, evidence identities and all actual/not-run outcomes; hidden grading independent. C10 also checks real coder-provider zero-dispatch on absent/exhausted budgets, pre-network durable reservations and observed-usage settlement; include the provider accounting/config identities and command-view digest. Observation instrumentation must not substitute a mock model for the real composition.

- [ ] T029 [P] Verify real repair/replan outcomes in tests/runtime/integration/uc03-repair.test.ts.
  - **Owner**: Tai / repair integration.
  - **Dependencies**: T028.
  - **Owned Paths**: tests/runtime/integration/uc03-repair.test.ts; docs/verification/uc03-repair.md.
  - **Acceptance Checks**: Real C03–C05/C10/C12: failed patch informs repair, focused pass cannot hide regression, finite exhaustion stops, initial/replan human pauses and feedback wait, no fourth strategy. Budgets remain same-task across runs; T032 separately proves actual process restart.

- [ ] T030 [P] Evaluate real reviewer and invalidation in tests/runtime/integration/uc03-review.test.ts.
  - **Owner**: Tai / reviewer integration.
  - **Dependencies**: T028.
  - **Owned Paths**: tests/runtime/integration/uc03-review.test.ts; fixtures/uc03/reviewer/; docs/verification/uc03-review.md.
  - **Acceptance Checks**: C14/C16 with known-good/bad logic/security/missing-test diffs; separate read-only configuration, denied writes/execute, validated real lines, finite loop and reverification after repair/final-state changes. Replace ScriptedReviewerPort; CodeRabbit is not evidence. C10 independently exercises real reviewer provider budgets: absent/exhausted token/cost or iteration allowance causes zero network requests, while admitted calls use durable reservations and observed usage settlement through the shared ModelPort protocol.

- [ ] T031 [P] Exercise workflow attacks through real ports in tests/runtime/integration/uc03-security.test.ts.
  - **Owner**: Tai / adversarial integration.
  - **Dependencies**: T028.
  - **Owned Paths**: tests/runtime/integration/uc03-security.test.ts; docs/verification/uc03-security.md.
  - **Acceptance Checks**: C06–C11/C16 traverse actual agent route, including malicious repository/test code and injected output. Verify no unauthorized effect, test weakening or protected payload in coder/reviewer/events/report; missing limits/isolation stop before operations. T024 component proof alone is insufficient for this integrated test. Exercise malicious pytest direct protected reads and canonical source/test writes through the actual read-only command view; assert denial before effects, protected-data exclusion before admission and no scratch promotion.

- [ ] T032 [P] Prove actual restart and approval composition in tests/runtime/integration/uc03-restart.test.ts.
  - **Owner**: Tai integration; Thanh Tan UC-04 recovery evidence; Trong Tan UC-05 decision evidence.
  - **Dependencies**: T028; external X04-X05-RESTART (plus accepted X04-STATE/X05-GATE revisions).
  - **Owned Paths**: tests/runtime/integration/uc03-restart.test.ts; docs/verification/uc03-restart.md.
  - **Acceptance Checks**: C04/C11–C13/C15: actually terminate/restart after completed step, after reservation, while approval pending and after effect before settlement. Preserve task/workspace/criteria/limits, reconcile effects exactly once, reject stale repo/policy and never reset budgets. Replace MemoryStatePort simulation; do not implement recovery internals in UC-03. C15 additionally terminates coder and reviewer calls after durable token/cost reservation, after provider dispatch and before usage settlement. Restore request/config/pricing identities and charged unresolved reservations, reconcile actual provider usage or retain the conservative charge, and prove no blind duplicate request or budget reset. Unsupported provider reconciliation is reported explicitly rather than assumed.

- [ ] T033 Run and compare full real evaluations and record docs/verification/uc03-evaluation.md.
  - **Owner**: Tai / evaluation coordinator.
  - **Dependencies**: T029, T030, T031, T032.
  - **Owned Paths**: docs/verification/uc03-evaluation.md; docs/verification/uc03-evaluation/.
  - **Acceptance Checks**: One-command C01–C17 twice with exact runtime/fixture/image/profile/adapter identities; machine-readable comparison, per-UC metrics and host-private grading. Required failed/error/not-run cases prevent VERIFIED claim. Runtime provider variability and unsupported platforms explicitly reported; mock outputs excluded from real acceptance.

- [ ] T034 Refresh validated context and close implementation handoff in docs/verification/uc03-implementation-handoff.md.
  - **Owner**: Tai / coordinator.
  - **Dependencies**: T033.
  - **Owned Paths**: docs/verification/uc03-implementation-handoff.md; context/progress_checker.md; context/tech_stack.md; affected existing context documents via update-context.mjs; docs/use-case-delegation.md (approved links only).
  - **Acceptance Checks**: Reconcile FR/SC/case coverage and remaining blockers, run approved build/lint/type/runtime plus contributor checks with exact exits; update context from actual evidence via updater --apply. Link approved artifacts and accepted foreign revisions; record unfinished acceptance honestly. Finish then preview/apply archive only this owner's active handoff; no automatic issue creation/merge or unrelated ledger edits.

## Dependencies & Execution Order

### Phase and story dependencies

T001 → T002 → T003 → T004 is the minimum development prerequisite chain. All stories start after it. T005–T010 supply US1/shared capabilities in parallel. T015/US2 and T019/T021/US3 start without US1 implementation. US2 uses saved baseline fixtures; US3 uses port/request fixtures. T026 joins story implementations; T028 joins the real components, not merely mock logic. Cross-story edges reflect actual shared-file/module use only.

External dependencies: **X04-STATE** (Thanh Tan), **X05-GATE** (Trong Tan), **X04-X05-RESTART** (both) as defined in plan.md. T001 requires their contract agreement, not completed implementation. T024/T025/T028 need actual state and gate adapters; T032 needs their integrated restart delivery. No UC-01 prerequisite. Actual foreign task IDs are linked when owners publish their ledgers.

```mermaid
flowchart TD
    T001 --> T002 --> T003 --> T004
    T004 --> T005 & T006 & T007 & T008 & T009 & T010 & T015 & T019 & T021 & T037
    T005 --> T011
    T011 --> T012 --> T013
    T011 --> T014
    T015 --> T016 --> T017 --> T018
    T019 --> T020
    T010 --> T023
    T003 & T004 --> T037 --> T038 --> T039 --> T040 --> T041
    T038 --> T042 --> T043 --> T044
    T041 --> T044
    T040 & T004 --> T045
    T040 & T041 --> T046
    T021 & T040 & T041 & T044 & T045 & T046 --> T022
    T022 & T018 --> T047
    T022 & T013 & T014 --> T048
    T041 & T044 & T046 --> T049
    T022 & T047 & T048 & T049 --> T050
    T006 & T007 & T020 & T022 --> T024
    X04[X04-STATE] --> T024
    X05[X05-GATE] --> T024
    T024 --> T025
    T013 & T014 & T018 & T022 & T023 --> T026
    T005 & T015 & T019 & T003 --> T027
    T008 & T009 & T025 & T026 & T027 --> T028
    T028 --> T029 & T030 & T031 & T032
    XR[X04-X05-RESTART] --> T032
    T029 & T030 & T031 & T032 --> T033 --> T034
```

The explicit Dependencies fields also retain transitive/direct contract prerequisites not repeated in every diagram arrow. Skeleton ownership is explicitly sequential: T011 → T012 (input.ts), T011 → T012 → T013 (investigation.ts), T011 → T014 (verification.ts), T016 → T017 → T018 (repair.ts), and T021 → T022 (execution-guard.ts). Test-authoring tasks may create only runnable signature/neutral SUT scaffolds; implementation stays in the named successors, with dependency handoff preventing concurrent writers. T017/T018 share src/uc03/repair.ts and MUST be sequential. T020 owns isolation test source; T024 only executes it and owns evidence, so no competing test writers. Coordinator-only quickstart/context/ledger edits are integrated serially. Shared root config belongs only to T002.

### Parallel frontiers and examples per story

- After T004: T005–T010, T015, T019 and T021 have disjoint paths and no remaining local dependencies. They can be scheduled together; non-[P] successors are ordered within their lane.
- US1: once T011 records runnable behavioral RED and hands off its three SUT skeletons, T012 and T014 may run together. T013 follows T012; model/tools/reviewer lanes continue independently. T014 uses fixtures, so it does not wait for investigation implementation.
- US2: T015 fixture work can run with US1's T005–T010 and US3's T019/T021; T016→T017→T018 is intentionally serial for skeleton/RED-to-implementation ordering and repair.ts ownership handoff. There is no artificial `[P]` within that serial lane.
- US3: T019/T020 attack preparation runs alongside T021/T022 guard skeleton/RED then implementation, with sequential guard source handoff; T023 starts after T010 and does not wait for US1. T024/T025 wait for real components and external deliveries, while mock workflow work can continue.
- Evaluation: T027 can run while story implementation proceeds once its fixture/contract inputs exist. After T028, T029/T030/T031/T032 run on separate disposable task workspaces and disjoint evidence/test paths.
- Atomic admission amendment: T037–T040 (canonical v0.2.0 contracts) and T042–T044 (UC-05 v0.2-draft companion) advance concurrently once T038 defines canonical types; T041 provides the controlled UC-04 journal mock; T045 and T046 implement workspace and provider executor gates; T022 composes authoritative guard checks over those predecessors; consumers T047 (repair accounting) and T048 (investigation/verification guarded runTests) integrate after T022; T049 migrates fixtures and T050 executes the full deterministic barrier/race acceptance matrix. Real adapters and Phase 6 remain gated.

`[P]` is relative to these ready frontiers, never a claim that a task with listed unfinished dependencies can start now. Runtime container/test execution is gated separately from writing fixtures or mock tests.

### Critical path and blocker rules

Without durations there is no justified single time-based critical path. The structural delivery bottleneck is the longest of: workflow T001→T002→T003→T004→T015→T016→T017→T018→T026; security T004→T019→T020→T024→T025; external X04/X05 arrival; model/reviewer and evaluation readiness. These join at T028, then the longest real acceptance lane T029–T032 joins T033→T034. Prioritize contract signoff, shared delivery coordination and guard/isolation preparation; avoid waiting for all US1 code before those lanes start.

Use ready/pending-dependency descriptions, not BLOCKED for unfinished shared components when mock/fixture work remains possible. Mark an affected integration task BLOCKED only when its real-only acceptance cannot progress even after local setup/check preparation, naming the external owner, absent evidence and resume condition. Mock tests never replace real acceptance or allow an integration checkbox to be checked early.

## Implementation Strategy

### MVP first

After T001 approval, deliver US1's narrow seeded route with required US3 security and actual approval/state/tools/reviewer via T024/T025/T028. Demonstrate it as the first slice only. Full UC-03 remains unverified until repair/replan/review/security/restart and complete evaluation tasks T029–T033 pass. No runtime code is created by this ledger.

### Incremental and parallel delivery

Develop accepted contract mocks once (T004), then run independent story lanes on saved-state fixtures. Integrate real components at named tasks, serially merge shared-file changes, rerun affected checks and let only the coordinator update status. Report mode mock/real, exact revisions/commands/exits and limitations in every handoff. Do not publish tickets via to-tickets in this request.

## Phase 2 integration corrections

- [X] T035 Preserve Node.js 24 source-test discovery and compiled runtime-test compatibility per FR-013 (partial).
  - **Owner**: Tai / integration lane.
  - **Dependencies**: T003; apply the same import convention to T004 files before final publication.
  - **Owned Paths**: tsconfig.json; src/contracts/foundation/uc03.ts (erasable TypeScript syntax only); tests/runtime/contract/uc03.test.ts; relative imports in T004 support/tests when integrated.
  - **Acceptance Checks**: Reproduce the publication failure from `node --test` discovering TypeScript tests with unresolved `.js` imports. Use source-resolvable relative imports and compiler rewriting for emitted JavaScript, preserving strict checking and dependency versions. Node 24 source discovery and compiled runtime tests both pass without transformation flags or prebuilt source-side JavaScript. This is a Phase 2 test-tooling correction, not authorization for later runtime phases.

## Phase 2 review corrections

- [X] T036 Use the canonical validation-error type in the controlled repository mock per plan: strict TypeScript boundaries (partial).
  - **Owner**: Tai / test-support lane.
  - **Dependencies**: T004.
  - **Owned Paths**: tests/runtime/support/uc03/fake-repository.ts.
  - **Acceptance Checks**: Replace the unnecessary `unknown[]` / `as never` validation-error cast with the canonical `ValidationError[]` type. Preserve behavior and pass strict typecheck plus existing provider/repository vectors; no additional runtime capability.

## Atomic Admission Amendment: Phase 5 Scoped Implementation Tasks

**Scope**: Implementation decomposition for approved atomic admission amendment (contracts/atomic-admission-amendment.md, v0.2.0 / uc05-approval/0.2-draft).
**Status**: APPROVED DESIGN / NOT IMPLEMENTED. Design approved by user-relayed agreement from Thanh Tan (UC-04) and Trong Tan (UC-05); recorded in contracts/decisions.md. Implementation release is a separate authorization; task IDs confer no implementation permission.
**Boundaries**: T022 remains incomplete/unchecked; Phase 6 (T026+) and real gates (T024, T025, T028+) remain gated. Controlled mock migration only; no real persistence or kernel containment claimed.

- [ ] T037 [US3] Author behavioral contract test vectors for atomic admission v0.2.0 in tests/runtime/contract/uc03.test.ts and tests/runtime/contract/uc03-port-conformance.test.ts.
  - **Owner**: Tai / contracts lane (shared foundation).
  - **Dependencies**: T003, T004.
  - **Owned Paths**: tests/runtime/contract/uc03.test.ts; tests/runtime/contract/uc03-port-conformance.test.ts.
  - **Acceptance Checks**: Test-first behavioral assertions define contract v0.2.0 and port conformance expectations without runtime edits. Exercise tagged outcome union AttemptOutcomeReceipt (RepositoryActionOutcomeReceipt vs ProviderRequestOutcomeReceipt) and AttemptReconciliationReceipt (uncertain-attempt vs observed-unsettled). Require explicit planApplicability discriminator (pre-plan-diagnostic vs approved-plan). Assert that repository-action outcome receipts require actionDigest and reject provider request/budget fields; assert approved-plan repository receipts require planBindingDigest and planDecisionRef while pre-plan diagnostic receipts reject them. Assert that provider request outcome receipts require providerRequestId, requestContentDigest, role (coder | reviewer), providerAdmissionReceiptRef, and budget refs, while rejecting repository actionDigest, action-decision fields, and unneeded plan bindings. Reject cross-branch fields, missing required fields, or fabricated digests.

- [ ] T038 [US3] Implement canonical v0.2.0 types, ports, and versioned interfaces in src/contracts/foundation/uc03.ts.
  - **Owner**: Tai / contracts lane (shared foundation).
  - **Dependencies**: T037.
  - **Owned Paths**: src/contracts/foundation/uc03.ts; src/contracts/foundation/uc03/identity.ts; src/contracts/foundation/uc03/types.ts; src/contracts/foundation/uc03/ports.ts.
  - **Acceptance Checks**: Bump UC-03 canonical schema version from 0.1.0 to 0.2.0. Define separate taskStateSchemaVersion / controlSchemaVersion and expectedEpoch domains. Define tagged union AttemptOutcomeReceipt with branch-matched repository and provider variants. Define AttemptReconciliationReceipt discriminating uncertain-attempt and observed-unsettled. Update StatePort interface to declare recordOutcome, reconcileObservedOutcome, closeUnattemptedClaim, and predecessor-bound reconcileUncertain. Update RepositoryPort signatures to require bound admission context on applyPatch, runCommand, and runTests. Export all v0.2.0 types cleanly through src/contracts/foundation/uc03.ts.

- [ ] T039 [US3] Implement canonical v0.2.0 intake, command-view, and provider validators in src/contracts/foundation/uc03/validation/intake.ts and src/contracts/foundation/uc03/validation/provider.ts.
  - **Owner**: Tai / contracts lane (shared foundation).
  - **Dependencies**: T038.
  - **Owned Paths**: src/contracts/foundation/uc03/validation/intake.ts; src/contracts/foundation/uc03/validation/intake/actions.ts; src/contracts/foundation/uc03/validation/intake/command-view.ts; src/contracts/foundation/uc03/validation/intake/limits.ts; src/contracts/foundation/uc03/validation/intake/task.ts; src/contracts/foundation/uc03/validation/provider.ts; src/contracts/foundation/uc03/validation/provider/admission.ts; src/contracts/foundation/uc03/validation/provider/records.ts; src/contracts/foundation/uc03/validation/provider/request.ts.
  - **Acceptance Checks**: Validate normalized actions and calculate canonical actionDigest from payload bytes. Validate CommandView parameters: revision digest, admitted file digests, exclusions policy, scratch identity, read-only mount fact, finite time/output/process bounds. Validate ProviderRequest envelope and calculate canonical requestContentDigest excluding mutable dispatch state and observed usage. Validate ProviderAdmissionReceipt covering stable request ID, role, requestContentDigest, provider/pricing config, and decision-authority generation. Enforce discriminator checks for pre-plan diagnostic vs approved-plan branches.

- [ ] T040 [US3] Implement canonical v0.2.0 state, attempt, outcome, and reconciliation validators in src/contracts/foundation/uc03/validation/state.ts and src/contracts/foundation/uc03/validation/records.ts.
  - **Owner**: Tai / contracts lane (shared foundation).
  - **Dependencies**: T039.
  - **Owned Paths**: src/contracts/foundation/uc03/validation/state.ts; src/contracts/foundation/uc03/validation/state/budget.ts; src/contracts/foundation/uc03/validation/state/primitives.ts; src/contracts/foundation/uc03/validation/state/task.ts; src/contracts/foundation/uc03/validation/records.ts; src/contracts/foundation/uc03/validation/transition.ts; src/contracts/foundation/uc03/validation/common.ts; src/contracts/foundation/uc03/validation/evidence.ts; src/contracts/foundation/uc03/validation/evidence/baseline.ts; src/contracts/foundation/uc03/validation/evidence/review.ts; src/contracts/foundation/uc03/validation/evidence/source.ts; src/contracts/foundation/uc03/validation/evidence/verification.ts; tests/runtime/contract/uc03-review-regressions.test.ts.
  - **Acceptance Checks**: Validate state progression S0/C0/E0 -> claim S0/C1/E0 -> attempt S0/S1 and C1/C2. Validate tagged union AttemptOutcomeReceipt and AttemptReconciliationReceipt variants. Validate ClaimClosureReceipt requiring proof that no attempt was committed and recipient is fenced. Reject cross-branch fields, missing discriminator fields, or attempts to reconcile against a mismatched predecessor. Conformance and regression tests pass in tests/runtime/contract/uc03.test.ts and tests/runtime/contract/uc03-review-regressions.test.ts.

- [ ] T041 [US3] Implement controlled test-only StatePort journal and recovery mock in tests/runtime/support/uc03/memory-state.ts and tests/runtime/contract/uc03-mocks.test.ts.
  - **Owner**: Tai / test-support lane (coordinating external dependency X04-STATE).
  - **Dependencies**: T040.
  - **Owned Paths**: tests/runtime/support/uc03/memory-state.ts; tests/runtime/support/uc03/state-fixtures.ts; tests/runtime/contract/uc03-mocks.test.ts.
  - **Acceptance Checks**: Implement simulated UC-04 journal operations in MemoryStatePort: atomic claim CAS, beginAttempt single-use attempt consumption, recordOutcome (returning settled on state CAS success, or recorded-unsettled on compatible state conflict), reconcileObservedOutcome, closeUnattemptedClaim, and predecessor-bound reconcileUncertain. Enforce version progression S0/C0/E0 -> S0/C1/E0 -> C2, preserving active holds. Enforce single accounting: repair allowance consumed at beginAttempt without refund; provider reservations attached or created once; zero token/cost charges on repository-only operations. Pass updated mock conformance suite in tests/runtime/contract/uc03-mocks.test.ts. Explicitly mark test-support provenance; make no claims of real database durability or kernel containment.

- [ ] T042 [US3] Implement UC-05 companion contract v0.2-draft in src/contracts/approvals/contracts.ts and tests/runtime/approvals/contracts.test.ts.
  - **Owner**: Tai / approval-contracts lane (coordinating external dependency X05-GATE).
  - **Dependencies**: T038.
  - **Owned Paths**: src/contracts/approvals/contracts.ts; tests/runtime/approvals/contracts.test.ts.
  - **Acceptance Checks**: Update UC-05 companion contract version to uc05-approval/0.2-draft. Update DispatchClaim to bind canonical action payload digest, separate plan binding, command-view identity, task-state version, and consumed attempt identity. Define PolicyEvaluationReceipt, ActionDecisionReceipt, ProviderAdmissionReceipt (with coder and reviewer roles, explicit plan applicability), and ClaimClosureReceipt. Behavioral contract tests in tests/runtime/approvals/contracts.test.ts reject schema mismatches, missing branch fields, or legacy v0.1 claims.

- [ ] T043 [US3] Migrate UC-05 policy evaluation, service, and plan binding to v0.2-draft in src/approvals/policy.ts and src/approvals/service.ts.
  - **Owner**: Tai / approval-service lane (coordinating external dependency X05-GATE).
  - **Dependencies**: T042.
  - **Owned Paths**: src/approvals/policy.ts; src/approvals/service.ts; src/approvals/plan-binding.ts; tests/runtime/approvals/policy.test.ts; tests/runtime/approvals/service.test.ts; tests/runtime/approvals/plan-binding.test.ts; tests/runtime/approvals/plan-context.test.ts.
  - **Acceptance Checks**: Policy evaluation returns PolicyEvaluationReceipt with immutable decision reference and authority generation. Service evaluates proposed ProviderRequest subject into ProviderAdmissionReceipt without coercing into NormalizedAction. Enforce explicit plan applicability: pre-plan diagnostic branch binds task criteria/purpose without requiring plan approval; approved-plan branch binds planBindingDigest and planDecisionRef. Pass policy, service, and plan-binding test suites.

- [ ] T044 [US3] Migrate UC-05 authority publication, continuation, presentation, and CLI records in src/approvals/control.ts and src/approvals/recovery.ts.
  - **Owner**: Tai / approval-control lane (coordinating external dependency X05-GATE).
  - **Dependencies**: T041, T043.
  - **Owned Paths**: src/approvals/control.ts; src/approvals/recovery.ts; src/approvals/presentation.ts; src/approvals/cli.ts; tests/runtime/approvals/control.test.ts; tests/runtime/approvals/cli.test.ts; tests/runtime/approvals/restart-admission.test.ts; tests/runtime/approvals/mock-ports.test.ts; tests/runtime/support/uc05/mock-recovery.ts; tests/runtime/support/uc05/mock-store.ts; tests/runtime/support/uc05/mock-context.ts; tests/runtime/support/uc05/fixtures.ts.
  - **Acceptance Checks**: Publish immutable policy/config and decision authority changes directly into the UC-04 journal before beginAttempt. createApprovalContinuation preserves approval meaning but refuses to treat raw claimId as executor capability. Update SafePresentation and CLI records to conform to uc05-approval/0.2-draft. Migrate UC-05 mock store, context, and recovery test fixtures; pass approval unit and mock suites.

- [ ] T045 [US3] Enforce workspace leases and bound execution context in src/foundation/docker-workspace.ts and src/foundation/repository-tools.ts.
  - **Owner**: Tai / repository-tools lane (shared foundation).
  - **Dependencies**: T004, T040.
  - **Owned Paths**: src/foundation/docker-workspace.ts; src/foundation/repository-tools.ts; tests/runtime/unit/docker-workspace.test.ts; tests/runtime/unit/repository-tools.test.ts.
  - **Acceptance Checks**: Acquire read lease for immutable command view; acquire exclusive writer lease for patch spanning invocation through outcome recording. Require bound admission context on applyPatch, runCommand, and runTests; verify base revision and patch digest. Lower runTests(check) to canonical guarded run_command action with bound check ID, structured argv, immutable view, and finite limits; prohibit direct unadmitted execution. Verify that workspace gate validates fencing generation and rejects stale actors before launch. Pass unit test suites.

- [ ] T046 [US3] Implement authenticated executor admission and receiver one-shot gate in src/foundation/model.ts.
  - **Owner**: Tai / model lane (shared foundation).
  - **Dependencies**: T040, T041.
  - **Owned Paths**: src/foundation/model.ts; tests/runtime/unit/model.test.ts.
  - **Acceptance Checks**: Coder and reviewer requests require valid ProviderAdmissionReceipt with role, requestContentDigest, and plan applicability. Obtain task-wide claim and beginAttempt admission with single pre-network reservation in UC-04 journal; disallow duplicate reservations. Authenticated adapter validates incarnation identity and fencing generation, consuming process-local one-shot gate backed by UC-04 durable attempt record. Settle observed billable usage against pricing configuration; retain uncertain charge on timeout or network interruption without blind replay. Pass unit test suite.

- [ ] T047 [US3] Migrate repair consumer to single-owner guard accounting in src/uc03/repair.ts and src/uc03/repair-types.ts.
  - **Owner**: Tai / repair lane.
  - **Dependencies**: T018, T022.
  - **Owned Paths**: src/uc03/repair.ts; src/uc03/repair-types.ts; tests/runtime/unit/uc03-repair.test.ts.
  - **Acceptance Checks**: Repair passes proposed patch and repair allowance request to execution guard; removes duplicate local reservation and state CAS logic. Guard and UC-04 journal own single reservation, Repair -> Patch persistence, attempt consumption, outcome settlement, revision advance, and Verify transition. Failed or partially applied patch consumes repair attempt without refund; unattempted claim closure releases unconsumed reservation. Material replans and feedback transitions conform to v0.2.0 admission receipts; pass unit tests in tests/runtime/unit/uc03-repair.test.ts.

- [ ] T048 [US3] Route baseline investigation and verification through guarded runTests in src/uc03/investigation.ts and src/uc03/verification.ts.
  - **Owner**: Tai / investigation-verification lane.
  - **Dependencies**: T013, T014, T022.
  - **Owned Paths**: src/uc03/investigation.ts; src/uc03/verification.ts; tests/runtime/unit/uc03-investigation.test.ts; tests/runtime/unit/uc03-verification.test.ts.
  - **Acceptance Checks**: Investigation executes baseline reproduction and policy-approved test-only regression patches via guarded runTests under the pre-plan diagnostic branch without requiring a plan decision. Production patches remain denied during investigation. Verification routes focused and regression checks through guarded runTests with approved-plan binding. Mutating final state invalidates prior evidence; pass unit tests in tests/runtime/unit/uc03-investigation.test.ts and tests/runtime/unit/uc03-verification.test.ts.

- [ ] T049 [US3] Migrate controlled repository, approval, model, and reviewer mock fixtures in tests/runtime/support/uc03/fake-repository.ts and tests/runtime/support/uc03/port-fixtures.ts.
  - **Owner**: Tai / test-support lane.
  - **Dependencies**: T041, T044, T046.
  - **Owned Paths**: tests/runtime/support/uc03/fake-repository.ts; tests/runtime/support/uc03/port-fixtures.ts; tests/runtime/support/uc03/scripted-approval.ts; tests/runtime/support/uc03/scripted-model.ts; tests/runtime/support/uc03/scripted-reviewer.ts.
  - **Acceptance Checks**: Update FakeRepositoryPort, ScriptedApprovalPort, ScriptedModelPort, and ScriptedReviewerPort to conform to contract v0.2.0. Support deterministic synchronization barriers (prevalidation, lease acquisition, authority read/publication, claim commit, beginAttempt, receiver consume, pre-invoke, observe, settle, checkpoint, recovery). Support fault injection, authenticated incarnation tracking, and lost responses.

- [ ] T050 [US3] Implement full deterministic race and recovery acceptance suite in tests/runtime/contract/atomic-admission.test.ts.
  - **Owner**: Tai / integration-test lane.
  - **Dependencies**: T022, T047, T048, T049.
  - **Owned Paths**: tests/runtime/contract/atomic-admission.test.ts.
  - **Acceptance Checks**: Implement and verify all 21 deterministic test cases from Section 10 of atomic-admission-amendment.md: (1) policy publication wins before beginAttempt; (2) beginAttempt wins before policy publication or pause; (3) pause/rejection wins after claim but before beginAttempt (ClaimClosureReceipt closes unattempted claim without attempt ID, releases unconsumed reservations, zero repair attempt consumed); (4) repository writer/view drift wins before beginAttempt; (5) duplicate successful receipt to same executor incarnation (pre-invoke barrier, second sees consumed/status only, restart rejects old attempt); (6) version progression S0/C0/E0 -> S0/C1/E0 -> C2 / S1 with conflict on unrelated mutation; (7) fresh action/run ID while any claim is open denies task-wide; (8) stale/duplicate executor actor after reconciliation rejected by fenced generation; (9) crash or lost response at every boundary (idempotent reload, unknown remains uncertain); (10) settlement failure after patch records observed-unsettled, recovery commits transition once without reexecution; (11) reconcileUncertain accepts only exact uncertain predecessor, reconcileObservedOutcome accepts only exact observed-unsettled predecessor; (12) failed/partial repair attempt charges repair attempt if beginAttempt occurred; (13) pre-plan baseline and test-only regression path succeeds during Investigate without plan decision, production patch denied; (14) provider request/claim race reuses single claim/reservation, fresh competing request denied; (15) provider branch for coder and reviewer validates specific receipts, plan applicability, single pre-network reservation; (16) pre-plan outcome and idempotent settlement: tagged receipt variants, repository requires actionDigest, provider requires requestContentDigest, role, admission ref, budget refs; (17) cross-branch outcome/reconciliation fields rejected without field fabrication; (18) observed patch plus task-state conflict: restart, lost response, duplicate recovery assert one transition, exact revision, one evidence invalidation/charge; (19) provider budget regression: zero repository token/cost entries, unchanged provider accounting; (20) patch workspace gate lifetime: exclusive writer lease spans invoke through outcome settlement, no DB transaction spans invoke; (21) version migration: old claim ID rejected as executor authority. All tests execute under deterministic mock control; mock suite passes do not claim real durability, production adapter delivery, or kernel containment.
