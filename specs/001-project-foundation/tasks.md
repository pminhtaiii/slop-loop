---

description: "Actionable task list for the Phase 0 private application foundation"
---

# Tasks: Phase 0 Project Foundation

**Input**: Design documents from `specs/001-project-foundation/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, and `quickstart.md`

**Scope**: A private, single-package, single-process application designed to evolve as a modular monolith when real subsystem boundaries appear. Phase 0 contains only configuration, operational logging, startup, build/smoke verification, and the agreed CI gates.

**TDD rule**: For every behavior-bearing story, write the explicitly marked RED tests first, run the focused test to confirm failure, then implement the corresponding production behavior. Do not make `pnpm test` depend on `dist/`.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the smallest reproducible TypeScript/Node project surface without introducing application behavior.

- [x] T001 Create `package.json` with private single-package metadata, native ESM configuration, Node.js 24 and pnpm 12 requirements, Zod 4 and Pino runtime dependencies, and the planned TypeScript/Vitest/ESLint/Prettier development dependencies.
- [x] T002 [P] Create the root single-package `pnpm-workspace.yaml` without adding workspace packages or future subsystem packages.
- [x] T003 [P] Create strict NodeNext compiler settings in `tsconfig.json` for TypeScript source under `src/`, emitting the private application artifact under `dist/` without bundling tests.
- [x] T004 [P] Create the type-aware flat ESLint configuration in `eslint.config.mjs` for the TypeScript source, tests, and repository configuration files.
- [x] T005 [P] Create the Prettier configuration in `prettier.config.mjs` and formatting exclusions in `.prettierignore` for generated output and dependency directories.
- [x] T006 [P] Create the Node-oriented Vitest configuration in `vitest.config.ts` with source-test discovery under `tests/` and no requirement that `dist/` already exists.
- [x] T007 [P] Add generated-output and dependency exclusions to `.gitignore`, including `dist/`, coverage output, and local installation artifacts.
- [x] T008 Install the pinned dependency graph with `pnpm install` and generate the reproducible lockfile at `pnpm-lock.yaml` for developer review.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Provide the shared type-checking boundary required before any story implementation begins.

**⚠️ CRITICAL**: User-story work starts only after this phase is complete.

- [x] T009 Create the no-emit strict test/configuration type-check project in `tsconfig.test.json`, extending the production settings while including `tests/` and `vitest.config.ts` without emitting into `dist/`.

**Checkpoint**: The repository can install its pinned dependencies and statically validate both production and test configuration without any application behavior or generated artifact.

---

## Phase 3: User Story 1 - Start the private application foundation (Priority: P1) 🎯 MVP

**Goal**: Start one private, single-process application with a default configuration, a structured startup record, and a bounded unsuccessful path for invalid configuration.

**Independent Test**: Exercise the source startup path with a clean injectable environment and confirm a successful structured startup record at `info`; exercise invalid configuration and confirm a bounded diagnostic with no successful-start result.

### RED tests for User Story 1

> Write these tests first and run the focused test so it fails before implementing the startup path.

- [x] T010 [US1] Add RED source startup tests in `tests/smoke.test.ts` that exercise the source entrypoint without `dist/`, assert successful default startup at `info` with a structured record, and assert bounded failure for invalid configuration.

### Implementation for User Story 1

- [x] T011 [P] [US1] Implement the initial injectable configuration seam in `src/config.ts` so startup can receive environment data, default the absent log level to `info`, and return an immutable typed configuration value.
- [x] T012 [P] [US1] Implement the initial Pino factory seam in `src/logging.ts` so startup can create a level-aware operational logger with injectable output for tests.
- [x] T013 [US1] Implement the private application entrypoint in `src/index.ts` to load configuration, create the logger, emit one bounded structured startup record, report configuration errors diagnostically, and exit unsuccessfully rather than claiming startup success.

**Checkpoint**: User Story 1 is independently testable from source and provides the first demonstrable private application startup increment.

---

## Phase 4: User Story 2 - Configure and observe the foundation (Priority: P1)

**Goal**: Complete the strict `SLOP_LOOP_*` configuration contract and controlled operational logging behavior while keeping audit evidence out of scope.

**Independent Test**: Run the configuration and logging tests directly against `src/config.ts` and `src/logging.ts` for all accepted levels, invalid values, unknown prefixed names, unrelated environment variables, nested untrusted fields, and fixed redaction behavior.

### RED tests for User Story 2

> Write these tests first and run them to confirm the strict configuration and logging assertions fail before hardening the implementation.

- [ ] T014 [P] [US2] Add RED configuration contract tests in `tests/config.test.ts` for injectable environments, the `info` default, all six accepted levels, invalid values, unknown `SLOP_LOOP_*` names, ignored unrelated variables, frozen results, and actionable validation failures.
- [ ] T015 [P] [US2] Add RED operational logging tests in `tests/logging.test.ts` for effective levels, structured newline-delimited records, application-controlled nesting of repository/model/tool data, explicit redaction paths, injectable output, and separation from canonical audit evidence.

### Implementation for User Story 2

- [ ] T016 [P] [US2] Complete `src/config.ts` with a strict Zod 4 projected schema that recognizes only `SLOP_LOOP_LOG_LEVEL`, accepts exactly `trace`, `debug`, `info`, `warn`, `error`, and `fatal`, rejects every other `SLOP_LOOP_*` name/value, ignores unrelated environment names, and freezes the typed result.
- [ ] T017 [P] [US2] Complete `src/logging.ts` with a narrow Pino `createLogger()` factory, fixed explicit redaction, injectable test output, and application-controlled nesting for potentially untrusted values; keep operational logging separate from any canonical audit stream.

**Checkpoint**: User Stories 1 and 2 both pass their focused source tests; startup uses the complete strict configuration and controlled operational logging contracts.

---

## Phase 5: User Story 3 - Verify source behavior and the built application separately (Priority: P1)

**Goal**: Make source tests independent of generated output, compile the private application to `dist/`, and prove the compiled entrypoint with a separate smoke command.

**Independent Test**: Run `pnpm test` from a checkout with no `dist/`, then run `pnpm build` and `pnpm smoke`; confirm the latter executes only `node dist/index.js` and exercises configuration plus structured startup logging.

### RED tests for User Story 3

> Add the command/boundary assertions first and confirm they fail before wiring the build and smoke commands.

- [ ] T018 [US3] Extend `tests/smoke.test.ts` with RED package-script and boundary assertions that `pnpm test` is source-level and artifact-independent, `pnpm build` targets the compiled output, and `pnpm smoke` names `node dist/index.js` without source imports or package self-reference.

### Implementation for User Story 3

- [ ] T019 [P] [US3] Add the explicit verification scripts to `package.json`: `lint`, `format`, `format:check`, `typecheck`, `test`, `build`, and `smoke`, with `test` running Vitest independently, `build` invoking `tsc`, and `smoke` executing exactly `node dist/index.js`.
- [ ] T020 [P] [US3] Finalize `tsconfig.json` so `pnpm build` emits the private application entrypoint and its source modules into `dist/` with native ESM semantics and no test output.
- [ ] T021 [P] [US3] Finalize `vitest.config.ts` so `pnpm test` discovers source-level tests under `tests/` without importing, creating, or requiring `dist/`.

**Checkpoint**: Source tests pass before a build, `pnpm build` creates `dist/index.js`, and `pnpm smoke` starts only the compiled entrypoint successfully.

---

## Phase 6: User Story 4 - Run the agreed platform quality gates (Priority: P2)

**Goal**: Run the complete quality gate on Ubuntu and the runtime/build/smoke gate on Windows for pull requests and default-branch pushes.

**Independent Test**: Validate the workflow contract and run the two jobs against a passing change; confirm the assigned commands and failure propagation without publication or deployment behavior.

### RED tests for User Story 4

> Encode the platform command assignment first and confirm it fails until the workflow is present.

- [ ] T022 [US4] Add RED workflow contract assertions in `tests/ci.test.ts` for pull-request/default-branch triggers, frozen installs, the complete Ubuntu command sequence, the Windows test/build/smoke sequence, and the absence of publication/deployment steps.

### Implementation for User Story 4

- [ ] T023 [US4] Create `.github/workflows/ci.yml` with Node.js 24 and pinned pnpm setup, frozen installs, Ubuntu lint/format-check/typecheck/test/build/smoke gates, Windows test/build/smoke gates, pull-request and default-branch push triggers, and no release/publication/deployment jobs.

**Checkpoint**: Each platform job performs exactly its assigned Phase 0 checks and exposes a failed check as a failed job.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Reconcile the implemented Phase 0 surface with the maintainer-facing workflow without widening the application boundary.

- [ ] T024 [P] Document the private single-process startup, `SLOP_LOOP_*` namespace, and source/build/smoke verification commands in `README.md` without describing a public SDK, package self-reference, exports map, or CLI contract.
- [ ] T025 Verify the command sequence and expected outcomes in `specs/001-project-foundation/quickstart.md` against `package.json`, `src/index.ts`, and `dist/index.js` after a clean install/build cycle.
- [ ] T026 Run the canonical local verification sequence from `specs/001-project-foundation/quickstart.md` (`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm smoke`) and confirm no generated artifacts or formatting changes are accidentally committed.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No application behavior dependency; T008 follows the root dependency metadata in T001.
- **Foundational (Phase 2)**: Depends on Setup; T009 blocks all story work by establishing no-emit test/configuration type checking.
- **User Story 1 (Phase 3)**: Depends on T009; its RED test T010 precedes startup implementations T011-T013.
- **User Story 2 (Phase 4)**: Depends on User Story 1 because it hardens the configuration/logger modules used by startup; its focused tests remain independently runnable.
- **User Story 3 (Phase 5)**: Depends on User Stories 1 and 2 so the compiled entrypoint exercises the completed startup contract.
- **User Story 4 (Phase 6)**: Depends on User Story 3 because CI invokes the finalized package scripts and compiled smoke path.
- **Polish (Phase 7)**: Depends on all desired stories and the final build/smoke verification.

### User Story Dependencies

- **US1 (P1)**: Can start after Foundational; no dependency on another user story.
- **US2 (P1)**: Follows US1 because it refines the same `src/config.ts` and `src/logging.ts` seams; its tests cover the complete contract independently of the entrypoint.
- **US3 (P1)**: Follows US1 and US2; it verifies the already-defined application behavior through the build artifact.
- **US4 (P2)**: Follows US3; CI is a consumer of the command and artifact contracts.

### Within Each User Story

- RED tests must be written and observed failing before their corresponding implementation tasks.
- Tasks marked `[P]` touch different files and have no dependency on another incomplete task in the same wave.
- Entry-point composition follows its configuration and logging seams.
- Build/smoke wiring follows the source behavior it verifies.

## Parallel Execution Examples

### User Story 1

After T010 fails as expected, run T011 (`src/config.ts`) and T012 (`src/logging.ts`) in parallel; complete T013 (`src/index.ts`) after both seams exist.

### User Story 2

Run T014 (`tests/config.test.ts`) and T015 (`tests/logging.test.ts`) in parallel. After both RED suites are recorded, run T016 (`src/config.ts`) and T017 (`src/logging.ts`) in parallel, then rerun the US1 startup suite.

### User Story 3

After T018 fails as expected, run T019 (`package.json`), T020 (`tsconfig.json`), and T021 (`vitest.config.ts`) in parallel; then run the source suite before building and smoke-starting the artifact.

### User Story 4

T022 must precede T023. Once T023 is merged, Ubuntu and Windows CI jobs can execute in parallel because each owns a separate runner and has an explicit command set.

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational phases.
2. Complete US1 to obtain the first independently testable startup increment.
3. Complete US2 immediately afterward; strict configuration and controlled logging are required before calling the Phase 0 foundation complete.
4. Stop and validate the source behavior before adding artifact and CI verification.

### Incremental Delivery

1. Setup + Foundational: reproducible TypeScript project and type-check boundary.
2. US1: private application starts and reports bounded success/failure.
3. US2: full strict `SLOP_LOOP_*` configuration and safe operational logging contract.
4. US3: independent source suite, build artifact, and direct compiled smoke startup.
5. US4: Ubuntu and Windows quality gates.
6. Polish: maintainer documentation and clean verification.

### Scope Guardrails

- Do not add agent orchestration, policy, tools, sandboxing, repository mutation, audit persistence, transports, CLI behavior, publication, SDK surfaces, package self-reference, exports maps, tarball consumers, microservices, workspaces, speculative subsystem directories, coverage gates, release jobs, or deployment jobs.
- Keep potentially untrusted repository/model/tool data nested under application-controlled logging keys; Pino redaction is defense in depth, not the application security boundary.
- Keep operational logs separate from any future canonical audit stream.

## Notes

- `[P]` means a task can run in parallel with the adjacent wave without sharing an incomplete file or dependency.
- `[US#]` labels map only to user-story phases; Setup, Foundational, and Polish tasks intentionally have no story label.
- `pnpm format` is the intentional rewrite command; `pnpm format:check` is the non-mutating CI check.
- The smoke boundary is `node dist/index.js`; it never imports from `src/`, uses package self-reference, or implies a publication/SDK contract.
