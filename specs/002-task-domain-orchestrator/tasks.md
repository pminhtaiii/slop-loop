# Tasks: Phase 1 Task Domain and Orchestrator

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/orchestrator.md](./contracts/orchestrator.md)

**Prerequisites**: The developer approved this plan and chose the dedicated `feat/002-task-domain-orchestrator` branch in the current checkout. The developer then explicitly authorized isolated Phase 1 code work before Phase 0 is complete. Phase 0 remains an open integration gate; T001 stays open until its full exit gate passes.

**Tests**: TDD is mandatory. Each RED task writes a behavior test, runs it, and records that it fails because the behavior is absent. Each paired GREEN task implements the minimum behavior and reruns the focused test. `pnpm test` is the regression suite.

**Organization**: Tasks are grouped by the four independently testable user stories in the spec. These task phases are Spec Kit implementation phases, not the product-level Phase 1 name in `progress-checker.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Independent files and no unfinished prerequisite in the same wave.
- **[Story]**: Spec story label; Setup and Polish tasks have none.
- Paths are repository-relative and exact unless a verification task names a command.

## Phase 1: Setup and approval gates

**Purpose**: Establish the already-selected TypeScript runtime as a verified prerequisite. This phase does not implement Phase 0 on behalf of Phase 1.

- [ ] T001 Run the Phase 0 exit gate from `coding-agent-context/context/progress-checker.md` and `specs/001-project-foundation/quickstart.md` (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm smoke`) before declaring Phase 1 integration-ready; the developer explicitly allowed isolated Phase 1 code and test work while this remains open.
- [x] T002 Record the developer-approved dedicated `feat/002-task-domain-orchestrator` branch in this checkout in `specs/002-task-domain-orchestrator/plan.md` before editing `src/` or `tests/`.

---

## Phase 2: Foundational

The Phase 0 project and Vitest source-test boundary supply the shared foundation. Do not create speculative policy, session, model, tool, or sandbox scaffolding. The developer explicitly allowed isolated Phase 1 story work before T001; T001 still blocks integration-ready completion.

---

## Phase 3: User Story 1 - Track one task through legal states (Priority: P1)

**Goal**: Create an immutable task context and enforce the full lifecycle graph, including terminal sealing.

**Independent Test**: `pnpm exec vitest run tests/orchestration/task.test.ts tests/orchestration/transitions.test.ts` proves stable identity/objective, admission, legal Ask/Edit paths, illegal-edge failure, and terminal replay rejection.

### TDD slices

- [x] T003 [US1] Write RED task-creation and admission tests in `tests/orchestration/task.test.ts`; include trusted intent and its immutability, run the focused test, and confirm failure is the missing `TaskContext` behavior.
- [x] T004 [US1] Implement immutable task identity, bounded objective, mode, state, usage, and admission in `src/orchestration/task.ts`; rerun `tests/orchestration/task.test.ts` until T003 is GREEN.
- [x] T005 [US1] Write RED legal/illegal graph tests in `tests/orchestration/transitions.test.ts`, including `RECEIVED → IMPLEMENTING` rejection and no skipped admission; run the focused file and confirm the expected behavioral failure.
- [x] T006 [US1] Implement the declared state enum, transition table, mode guards, and typed internal invalid-transition failure in `src/orchestration/transitions.ts`; rerun `tests/orchestration/transitions.test.ts` until T005 is GREEN.
- [x] T007 [US1] Extend `tests/orchestration/task.test.ts` with a RED terminal replay test for all four terminal states; run the focused file and confirm the missing seal behavior.
- [x] T008 [US1] Seal terminal state/outcome snapshots in `src/orchestration/task.ts`; rerun `tests/orchestration/task.test.ts` and the existing `pnpm test` regression suite.

**Checkpoint**: The task reaches only declared states; terminal outcomes are immutable. T003 precedes T004, T005 precedes T006, and T007 precedes T008 regardless of checklist display order.

---

## Phase 4: User Story 2 - Stop autonomous work within finite limits (Priority: P1)

**Goal**: Enforce the architecture's task-step and time defaults and the approved three general retries in a deterministic runner.

**Independent Test**: `pnpm exec vitest run tests/orchestration/budget.test.ts tests/orchestration/runner.test.ts` proves last-allowed completion, first-disallowed refusal, retry accounting, and simulated-time expiry.

### TDD slices

- [x] T009 [US2] Write RED budget-default, validation, immutable-limit, and step-boundary tests in `tests/orchestration/budget.test.ts`; run the focused file and confirm failure is missing budget behavior.
- [x] T010 [US2] Implement system-owned defaults, finite validation, admission freeze, step accounting, and exhaustion evidence in `src/orchestration/budget.ts`; rerun `tests/orchestration/budget.test.ts` until T009 is GREEN.
- [x] T011 [US2] Extend `tests/orchestration/budget.test.ts` with RED three-retry/fourth-retry and 900-second deadline tests, including time while `WAITING_FOR_FILE_PERMISSION`; run the focused file and confirm expected failure.
- [x] T012 [US2] Add explicit retry accounting and clock-driven deadline checks to `src/orchestration/budget.ts`; rerun `tests/orchestration/budget.test.ts` until T011 is GREEN.
- [x] T013 [US2] Write RED bounded-loop tests in `tests/orchestration/runner.test.ts` for every automatic cycle charging one step and for a valid completion at step 30; run the focused file and confirm expected failure.
- [x] T014 [US2] Implement the finite scripted-event loop and budget prechecks in `src/orchestration/runner.ts`; rerun `tests/orchestration/runner.test.ts`, then `pnpm test`.

**Checkpoint**: Scripted autonomous work is step-bounded, retry-bounded, and expires on simulated time. T009 precedes T010, T011 precedes T012, and T013 precedes T014.

---

## Phase 5: User Story 3 - Change mode without expanding the task (Priority: P1)

**Goal**: Preserve one task and its budget across trusted mode switches, pause Edit work, and require safe reinspection after returning to Edit.

**Independent Test**: `pnpm exec vitest run tests/orchestration/transitions.test.ts tests/orchestration/runner.test.ts` proves Edit→Ask→Edit pause/resume, objective stability, no step reset, no Edit action in Ask, and permission-gate traversal.

### RED tests

- [x] T015 [P] [US3] Extend `tests/orchestration/transitions.test.ts` with RED `PAUSED_FOR_MODE` and guarded resume scenarios; run the focused file and confirm expected failure.
- [x] T016 [P] [US3] Extend `tests/orchestration/runner.test.ts` with RED developer-mode events, no-step-charge, preserved objective/intent/budget, rejected informational→Edit and objective replacement, paused-time expiry, stale-verification invalidation after Edit resumption, and rejected Edit proposals while Ask tests; run the focused file and confirm expected failure.

### Minimal implementation and GREEN checks

- [x] T017 [US3] Implement pause checkpoint and resume-to-`INSPECTING` transitions in `src/orchestration/task.ts` and `src/orchestration/transitions.ts`; rerun `tests/orchestration/transitions.test.ts` until T015 is GREEN.
- [x] T018 [US3] Route trusted developer-mode events separately from automatic steps, reject objective replacement, and expire a paused task when the clock advances in `src/orchestration/runner.ts`; rerun `tests/orchestration/runner.test.ts`, then `pnpm test`.

**Checkpoint**: Edit cannot run while Ask; resumed Edit must follow normal inspection and permission stages. T015 and T016 may be written in parallel; each must be RED before its paired implementation.

---

## Phase 6: User Story 4 - Report truthful outcomes and recoverable refusals (Priority: P2)

**Goal**: Distinguish action refusals from terminal task outcomes and make completion evidence-gated.

**Independent Test**: `pnpm exec vitest run tests/orchestration/task.test.ts tests/orchestration/runner.test.ts tests/orchestration/runner.e2e.test.ts` proves recoverable model errors, policy blocking only when no route remains, no-change completion, verification failure, cancellation, and full Ask/Edit scripts.

### RED tests

- [x] T019 [P] [US4] Extend `tests/orchestration/task.test.ts` with RED typed-outcome and cancellation tests, including `NO_CHANGE_NEEDED`, `VERIFICATION_FAILED`, `POLICY_DENIED`, and `CANCELLED_BY_DEVELOPER`; run the focused file and confirm expected failure.
- [x] T020 [P] [US4] Extend `tests/orchestration/runner.test.ts` with RED tests that reject an invalid model proposal without changing state, charge one step, preserve a permitted route after one policy denial, and reject completion without current-attempt passing evidence after repair; run the focused file and confirm expected failure.
- [x] T021 [P] [US4] Write RED full-lifecycle scripts in `tests/orchestration/runner.e2e.test.ts` for Ask success, verified Edit success, no-change early exit, mode pause/resume, and exhaustion; run the focused file and confirm at least the missing US4 contract fails.

### Minimal implementation and GREEN checks

- [x] T022 [US4] Implement typed terminal-outcome construction, cancellation, and no-change/verification guards in `src/orchestration/task.ts` and `src/orchestration/transitions.ts`; rerun `tests/orchestration/task.test.ts` until T019 is GREEN.
- [x] T023 [US4] Implement proposal-refusal versus fatal-transition handling and evidence-aware completion in `src/orchestration/runner.ts`; rerun `tests/orchestration/runner.test.ts` and `tests/orchestration/runner.e2e.test.ts` until T020–T021 are GREEN, then run `pnpm test`.

**Checkpoint**: The runner reports truthful terminal outcomes and can recover from a refused model proposal without permitting an illegal state. T019–T021 may be written in parallel; all three must be RED before T022–T023.

---

## Phase 7: Polish and cross-cutting review

- [x] T024 Run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm smoke` using `specs/002-task-domain-orchestrator/quickstart.md`; format only intentionally modified files, rerun the relevant focused tests after any fix, and record any remaining gate failure.
- [x] T025 Review `src/orchestration/runner.ts` and `specs/002-task-domain-orchestrator/plan.md` against the threat review and `coding-agent-context/context/tool-policy.md`; fix and retest any high/critical or authorization-relevant medium finding before completion.
- [x] T026 Perform distinct standards/security and specification reviews of `src/orchestration/task.ts`, `src/orchestration/transitions.ts`, `src/orchestration/budget.ts`, `src/orchestration/runner.ts`, and `specs/002-task-domain-orchestrator/spec.md`; resolve blocking findings and rerun affected checks.
- [x] T027 Synchronize the accepted pause/cancel state graph in `coding-agent-context/context/architecture.md` and mark only verified Phase 1 items complete in `coding-agent-context/context/progress-checker.md`; keep Phase 0 status factual and review the final diff.

---

## Dependencies and execution order

### Phase dependencies

1. T002 and the isolated Phase 1 implementation are complete. The developer explicitly authorized isolated source and test work with T001 open; T001 still blocks integration-ready completion.
2. US1 task and transition contracts block US2 runner construction.
3. US2 budgeted runner blocks US3 mid-task mode tests and US4 outcome scripts.
4. US3 and US4 both depend on the US1/US2 base; US4 E2E scripts include the US3 pause path.
5. Polish follows all selected stories and their GREEN focused tests.

### Within each story

- RED tests are written and observed failing before the paired GREEN implementation.
- Each GREEN slice runs its focused test, then the existing regression suite at the checkpoint.
- A test that fails because pnpm or Phase 0 is missing is a prerequisite failure, not a valid RED result.
- Do not weaken a valid failing test to match production behavior; revise the approved specification first if behavior changes.

## Parallel execution examples

- After US2 completes, T015 and T016 can be written independently because they modify different test files. Their production follow-ups remain ordered T017 then T018.
- After US3 completes, T019, T020, and T021 can be written independently because they modify different test files. Confirm each intended RED failure before T022 or T023.
- Standards and spec review reports in T026 may be prepared independently; fixes and verification must be reconciled in one final diff.

## Implementation strategy

1. Build and test the isolated Phase 1 module under the developer's explicit Phase 0 gate override; plan and branch choice are approved. Do not mark T001 complete until Phase 0 actually passes.
2. Deliver US1 as the minimum testable lifecycle contract.
3. Add US2 to meet the finite-budget exit gate before exposing more lifecycle behavior.
4. Add US3 mode control and US4 outcome honesty without connecting privileged adapters.
5. Run the full quality gate and record its Phase 0 failures; complete security convergence, dual-axis review, and factual context sync. T001 remains open until Phase 0 passes.

## Scope guardrails

- No LLM, provider SDK, tool registry, capability policy engine, Docker, repository/filesystem access, Git write/read adapter, CLI, network, or canonical audit persistence is implemented here.
- Scripted permission, sandbox, and verification events are domain fixtures, never claims that those services exist.
- The architecture's later 60-tool-call, three-patch-attempt, 120-second-per-tool, and 65,536-output-byte limits remain future enforcement tasks.
