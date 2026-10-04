# Tasks: Offline Verification Sandbox

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contract](contracts/sandbox.md), [quickstart.md](quickstart.md).

**Tests**: Mandatory TDD and security/integration/E2E checks under the project workflow and FR-022. Run each RED test and confirm the intended missing-behavior failure before implementation. The IDs begin at **T089** because T088 is the existing unchecked Workspace Boundary verification task, outside Feature 006. No Phase 5 task is already implemented.

## Phase 1: Setup

**Purpose**: Make the design executable using the satisfied Phase 4 prerequisite without claiming sandbox infrastructure exists.

- [x] T089 Add fail-closed sandbox types in src/sandbox/types.ts and RED tests in tests/sandbox/contracts.test.ts; confirm the recorded Phase 4 gate evidence in specs/006-offline-verification-sandbox/quickstart.md before real boundary integration
- [x] T090 [P] Add bounded trusted configuration and profile fixture builders in tests/sandbox/fixtures.ts without model, network, or writable-host authority
- [ ] T091 Pin maintained YAML/archive parsers for bounded input and transfer validation in package.json and pnpm-lock.yaml; preserve Node/pnpm pins and validate the frozen install
- [ ] T092 [P] Add sandbox:test in package.json and separate source/real Linux Docker jobs in .github/workflows/ci.yml; record unavailable-platform and Windows evidence requirements in specs/006-offline-verification-sandbox/quickstart.md (local script added; CI/platform evidence remains open)

## Phase 2: Foundational

**Purpose**: Seal trusted configuration and identity before repository execution.

- [x] T093 Write RED trusted config/profile limits, unknown-field, local-engine, source-policy, hook and credential rejection tests in tests/sandbox/config.test.ts
- [x] T094 [P] Write RED canonical preparation fingerprint, exact-script-policy identity, immutable image metadata and source-only stability tests in tests/sandbox/identity.test.ts
- [x] T095 Implement strict trusted configuration/profile/limit validation and versioned canonical identities in src/sandbox/config.ts and src/sandbox/preparation.ts; satisfy T093 and T094 without preparation execution
- [x] T096 [P] Add controlled checkout, artifact registry, late-output, owned-resource and finite-clock fixtures in tests/sandbox/fixtures.ts with no unbounded public network requirement

**Checkpoint**: Fixtures and trusted immutable contracts exist; the satisfied Phase 4 prerequisite permits real workspace integration, subject to the unfinished Phase 5 implementation and its own gates.

## Phase 3: User Story 1 — Verify the actual edited repository offline (P1)

**Goal**: Capture one eligible snapshot and run fresh offline check containers against its identified bytes.

**Independent test**: A valid prepared fixture verifies permitted edits/untracked inputs and native source with distinct container IDs, one snapshot ID, finite limits and no host changes.

- [x] T097 [US1] Write RED safe-handle snapshot, secret/nested/link/mount exclusion, copied-byte hash, metadata/path collision, cap and observed-race retry tests in tests/sandbox/snapshot.test.ts
- [x] T098 [US1] Implement safe bounded capture, alias materialization, exclusions, manifest and rescan in src/sandbox/snapshot.ts; extend src/workspace/types.ts and src/workspace/boundary.ts only for separate snapshot bounds
- [x] T099 [P] [US1] Write RED fixed-argv local Docker readiness, immutable image, required hardening, mount/no-network and enforced-limit tests in tests/sandbox/docker.test.ts plus real smoke fixtures in tests/sandbox/docker.integration.test.ts
- [x] T100 [US1] Implement fixed-argv Linux Docker readiness and fresh check-container bootstrap in src/sandbox/docker.ts with read-only private snapshot input, non-root/no-network/root-readonly/capdrop/seccomp/no-new-privileges and sized tmpfs
- [x] T101 [P] [US1] Write RED trusted logical-target mapping, argv-injection, offline native prelude, prepared headers, missing prerequisite and recursive-Docker-suite rejection tests in tests/sandbox/profiles.test.ts
- [x] T102 [US1] Implement fixed profile and exact target mappings, trusted pinned node-gyp prelude and ordinary-source-test selection in src/sandbox/config.ts and src/sandbox/verification.ts without mutable repository build policy or automatic installation
- [x] T103 [US1] Write RED cross-call snapshot retention, required-check coverage, targeted/duplicate/partial result rejection, mixed identities and output/native failure tests in tests/sandbox/verification.test.ts
- [x] T104 [US1] Implement task-attempt verdict coordination, retained snapshot, required full-check coverage and fresh clones in src/sandbox/verification.ts with bounded output and no cross-attempt evidence reuse
- [ ] T105 [US1] Prove real edited TypeScript/native source verification, readonly dependency layout and no checkout writeback in tests/sandbox/verification.integration.test.ts using a developer-provisioned valid prepared fixture

## Phase 4: User Story 2 — Prepare under developer authority (P1)

**Goal**: Prepare only supported locked public dependencies and explicit exact-identity scripts, then publish trusted immutable metadata.

**Independent test**: Explicit developer preparation produces a usable image; forged confirmation, source/integrity/script violations and missing tools publish none.

- [x] T106 [US2] Write RED trusted developer-action binding, model/repo confirmation rejection, recipe ownership and changed-input cancellation tests in tests/sandbox/preparation.test.ts
- [x] T107 [P] [US2] Write RED bounded supported lock grammar, exact artifact graph, unsupported URLs/hooks/configDependencies, integrity and multiversion script allowlist tests in tests/sandbox/downloads.test.ts
- [x] T108 [P] [US2] Write RED approved-destination, redirect/private-IP/DNS-rebinding, direct-bypass, disabled-script fetch and finite download tests in tests/sandbox/broker.test.ts
- [x] T109 [US2] Implement strict YAML/schema locked graph, sanitized pnpm inputs, exact-identity-to-name allow map and frozen no-hook fetch in src/sandbox/downloads.ts; reject unsupported source/config forms before network access
- [x] T110 [US2] Implement a temporary trusted approved-public-destination broker and isolated preparation egress setup in src/sandbox/broker.ts and src/sandbox/docker.ts; prove no direct bypass and keep network setup authority out of untrusted code
- [ ] T111 [US2] Write RED offline exact dependency scripts with root hooks disabled, hostile archive/link/sparse/expansion, frozen export, safe publication and failure cleanup tests in tests/sandbox/preparation.integration.test.ts
- [x] T112 [US2] Add the application-owned digest-pinned offline recipe in sandbox/verification.Dockerfile with prepared readonly dependencies and toolchain checks; never execute the target Dockerfile or fetch OS tools/headers during verification
- [x] T113 [US2] Implement bounded developer preparation, safe frozen store/context import in src/sandbox/archive.ts, immutable publication and private records in src/sandbox/preparation.ts; preserve prior image on failure
- [x] T114 [US2] Add the developer-only explicit-confirmation preparation helper in scripts/prepare-verification.ts and package.json as sandbox:prepare without registering any model tool or resuming a blocked task
- [ ] T115 [US2] Prove exact locked public artifacts and approved scripts through the controlled registry plus a reference-lock smoke case in tests/sandbox/preparation.integration.test.ts; record broker, builder quota and platform enforcement evidence

## Phase 5: User Story 3 — Recognize stale preparation and verification (P1)

**Goal**: Only current complete evidence satisfies verification; stale preparation ends a task before a developer helper and new task.

**Independent test**: Source-only edits reuse preparation; dependency/tag/policy drift blocks; checkout drift produces historical stale evidence; explicit preparation is followed by new admission.

- [x] T116 [US3] Write RED external-readiness BLOCKED with zero executor/recovery charge versus ordinary denial or policy failure, audit/fence and snapshot identity tests in tests/sandbox/gateway.test.ts
- [x] T117 [US3] Extend typed readiness/blocker and result contracts in src/policy/engine.ts, src/tools/gateway.ts and src/tools/registry.ts; wire src/sandbox/gateway.ts with eligibility-first, audit-first zero-executor blockers
- [x] T118 [P] [US3] Write RED stale-image BLOCKED, preserved edits, no resume, subset/boolean/replayed verdict rejection, fresh complete evidence and late-success tests in tests/sandbox/lifecycle.test.ts
- [x] T119 [US3] Validate trusted task-attempt complete verdict evidence at src/orchestration/runner.ts and src/sandbox/gateway.ts; reject bare success booleans, partial/stale/replayed results and map blockers without resumable state
- [x] T120 [P] [US3] Write RED mutable-tag swap, captured-dependency fingerprint mismatch and final content/path/mode change tests in tests/sandbox/identity.test.ts and tests/sandbox/verification.test.ts
- [x] T121 [US3] Implement immutable image point-of-use validation and safe final checkout comparison in src/sandbox/preparation.ts, src/sandbox/snapshot.ts and src/sandbox/verification.ts; distinguish historical pass from current verified state
- [ ] T122 [US3] Add the full stale-image developer-confirmation preparation and new-task reevaluation/snapshot journey in tests/sandbox/verification.e2e.test.ts with fixture grants and existing fake audit ports (harness added; real Docker journey unavailable locally)

## Phase 6: User Story 4 — Contain failure and clean up (P1)

**Goal**: Enforce finite abuse/cancellation/cleanup behavior and reconcile only positively owned resources.

**Independent test**: Hostile checks remain bounded; all exits clean up or explicitly block/fence; restart never removes unrelated resources.

- [x] T123 [US4] Write RED capture/transfer/check cancellation, terminal cleanup-uncertain admission denial, matching reconciliation release and late-generation tests in tests/sandbox/cleanup.test.ts and tests/sandbox/lifecycle.test.ts
- [x] T124 [P] [US4] Write RED owned-resource atomic records, restart reconciliation, ownership conflicts, absent labels and unrelated resource preservation tests in tests/sandbox/reconciliation.test.ts
- [x] T125 [US4] Implement finite container/staging cleanup and private reconciliation in src/sandbox/cleanup.ts; block uncertain deletion, retain byte reservations/effect fencing and never use broad or global deletion
- [x] T126 [US4] Integrate watchdog/output/abort cleanup in src/sandbox/docker.ts and src/sandbox/verification.ts; extend terminal/cancel/settle slot release holds and trusted reconciliation in src/orchestration/runner.ts
- [ ] T127 [US4] Prove root/network/secret/socket denial, CPU/memory/swap/PID/tmpfs/output/time bounds and no host fallback with real hostile fixtures in tests/sandbox/security.integration.test.ts (harness added; real Docker evidence unavailable locally)
- [ ] T128 [US4] Prove daemon-loss uncertainty, interrupted preparation/startup, slot fencing and safe restart recovery in tests/sandbox/recovery.integration.test.ts; require explicit unavailable-fixture outcomes (harness added; real Docker evidence unavailable locally)

## Phase 7: Verification, Review and Context Synchronization

- [ ] T129 Rerun the satisfied Phase 4 prerequisite as final regression verification, then run the pinned gate and specs/006-offline-verification-sandbox/quickstart.md matrix on Ubuntu and Windows Docker Desktop; record versions, limits and fixture availability in coding-agent-context/context/testing.md
- [ ] T130 Perform security convergence and separate standards/spec reviews against specs/006-offline-verification-sandbox/spec.md and plan.md; record and resolve authorization/path/network/storage/cancellation findings before declaring integration ready
- [ ] T131 Sync CONTEXT.md, docs/adr/0011-disposable-offline-verification-containers.md and coding-agent-context/context with observed evidence; close Phase 5 only after its exit gate passes

## Dependencies and Execution Order

- **External prerequisite before real integration:** The Phase 4 exit gate in specs/005-workspace-boundary/quickstart.md is satisfied by PR #164 / CI run #41 on implementation commit `0b990c03718fa9ae9f1f33de230f9cf53ff38d71`. Windows and Ubuntu Quality Gates passed for available fixtures. Linux bind-mount containment remains UNVERIFIED / UNAVAILABLE under the accepted, unchecked T088 MVP exception; T088 is not a PASS and does not independently block Phase 4 completion or Phase 5 work. T089 confirms this existing evidence. Real boundary/container integration in T098–T100, T105, T108/T110, T111/T113/T115, T122 and T127–T128 may proceed on this baseline; each task still needs its own Phase 5 implementation and required evidence. Do not mark tasks complete from partial/unit-only work. T129 reruns the prerequisite as final regression validation, not as the first evidence required to start Phase 5.

- Setup T089–T092 → foundational T093–T096 → US1 T097–T105. US2 T106–T115 depends on foundational contracts; its real smoke uses US1 readiness/layout.
- US3 T116–T122 integrates US1+US2 and current Phase 3 lifecycle. US4 T123–T128 depends on US1 execution contracts; final cancellation wiring and recovery additionally require US2/US3 behavior.
- T129–T131 require every story and the Phase 4 prerequisite. Publishing these planning artifacts does not satisfy any implementation task.
- Within each story, RED tasks precede their corresponding implementation: T097→T098; T099→T100; T101→T102; T103→T104; T106/T111→T113; T107→T109; T108→T110; T111→T112/T113; T116→T117; T118→T119; T120→T121; T123/T124→T125/T126. Integration RED fixtures may be written before implementation but never marked done from skipped/unavailable environments.
- T088 remains the unchecked Workspace Boundary verification task; no task or issue in Feature 006 reuses it.

## Parallel Opportunities

- After T089, setup T090 and T092 touch separate fixture/CI files; YAML dependency work remains sequential with install verification.
- After setup, T093 and T094 write independent config/identity tests. T096 waits for any earlier fixture edit to avoid shared-file writes.
- US1: T097 snapshot tests, T099 Docker tests and T101 profile tests can be prepared in parallel; implementations sharing config/verification files stay sequential.
- US2: T106 preparation, T107 locked graph and T108 broker tests use different files; T110 network lifecycle and T112 recipe work can proceed only after their tests/contracts are settled and without concurrent docker.ts edits.
- US3: T118 lifecycle and T120 identity/verification tests are independent after US1/US2, but shared gateway/runner/verification edits remain sequential.
- US4: T123 cancellation and T124 restart ownership tests are independent; real security and recovery fixtures can run separately once runtime wiring is complete.

## Implementation Strategy

US1 is the first independently testable slice against a valid prepared fixture, not a usable full product or the entire Phase 5 exit gate. Deliver US2 preparation next, then US3 correct stale lifecycle and US4 failure containment. Preserve existing phase boundaries; do not build the later model/provider/interactive CLI/grant/durable-audit adapters. Use the narrow requested backend plus Node/native primitives and the installed parser rather than a general execution framework. All 43 tasks remain unchecked.
