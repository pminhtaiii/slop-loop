# Tasks: Workspace Boundary

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contract](contracts/workspace-boundary.md), and [quickstart.md](quickstart.md).

**Tests**: Required by `coding-agent-context/context/workflow.md`. Write each story's tests first, confirm they fail for the missing behavior, then implement. IDs continue the repository-wide Spec Kit sequence after Phase 3's T058.

## Phase 1: Setup

**Purpose**: Make the planned native boundary buildable on both supported hosts.

- [X] T059 Add a fail-closed Node-API addon build and load target in package.json and native/workspace/binding.gyp; pin the build dependency in pnpm-lock.yaml
- [X] T060 [P] Add Windows and Ubuntu native build prerequisites and boundary test jobs in .github/workflows/ci.yml

## Phase 2: Foundational

**Purpose**: Establish one trusted workspace identity and an OS-backed access contract before story work.

- [X] T061 Add workspace identity, path request, safe opened-target, and typed failure contracts in src/workspace/types.ts
- [X] T062 Add a native loader that rejects missing, incompatible, or unsupported backends without falling back to path-only access in src/workspace/native.ts
- [X] T063 [P] Add shared Git-checkout, symlink, and denied-path fixture helpers in tests/workspace/fixtures.ts

**Checkpoint**: Story tests can use one workspace contract and controlled real filesystem fixtures.

## Phase 3: User Story 1 — Work across one selected checkout (P1) 🎯 MVP

**Goal**: Admit a task from any subdirectory of one valid checkout and seal that checkout's identity.

**Independent test**: Root and subdirectory admission select the same eligible checkout; non-repository, sibling, nested, submodule, and same-path replacement identities fail before admission or later access.

- [X] T064 [US1] Write failing selector-to-admission, missing/forged ID, and same-path linked-worktree replacement tests in tests/workspace/admission.test.ts
- [X] T065 [P] [US1] Write failing tracked, untracked, ignored, gitlink, and nested-repository membership tests in tests/workspace/membership.test.ts
- [X] T066 [US1] Implement fixed-argv Git discovery, physical root and held-handle OS identity, worktree gitdir identity, and same-path replacement check in src/workspace/admission.ts
- [X] T067 [US1] Implement NUL-delimited Git membership with gitlink and nested-repository exclusion in src/workspace/membership.ts
- [X] T068 [US1] Require successful trusted selectWorkspace before admitting a task and seal only its returned ID in src/orchestration/task.ts and src/workspace/admission.ts

**Checkpoint**: US1 tests pass without model-visible file executors.

## Phase 4: User Story 2 — Deny unsafe repository paths (P1)

**Goal**: Produce authoritative path facts and safe opened targets only for eligible content in the selected checkout.

**Independent test**: Adversarial path, link, mount, secret, file-type, swap, and missing-fact fixtures never expose forbidden content or reach the fake executor.

- [ ] T069 [P] [US2] Write failing relative-path, secret-alias, and symlink policy tests in tests/workspace/path-policy.test.ts
- [ ] T070 [P] [US2] Write failing native open, hard-link, nonregular, cycle, and eligible-to-outside/ignored/secret swap tests in tests/workspace/native-boundary.test.ts
- [ ] T071 [P] [US2] Write failing Linux bind-mount and Windows junction/reparse integration tests, with an explicit unavailable-fixture outcome, in tests/workspace/mount-boundary.test.ts
- [X] T072 [P] [US2] Write failing gateway tests for explicit paths, implicit roots, search scope, and missing/duplicate/extra/wrong-alias facts in tests/tools/workspace-gateway.test.ts
- [X] T073 [US2] Implement strict relative-path parsing plus requested-alias and resolved-target deny checks in src/workspace/path-policy.ts
- [ ] T074 [US2] Implement root-held Linux openat2 read and directory traversal, including safe in-root symlink resolution and no nested-mount crossing, in native/workspace/linux.cc
- [ ] T075 [P] [US2] Implement root-held Windows relative read and directory traversal with symlink handling and junction/reparse denial in native/workspace/windows.cc
- [ ] T076 [US2] Implement common Node-API binding, opened-handle identity and link/type checks, bounded traversal, and handle cleanup in native/workspace/addon.cc
- [ ] T077 [US2] Recheck held-root/gitdir identity and implement current Git/path/native eligibility with opened-target identity matching in src/workspace/boundary.ts
- [X] T078 [US2] Add requestedPath facts and exact request-to-fact coverage for paths, implicit roots, and search scope before dispatch in src/policy/engine.ts and src/tools/gateway.ts

**Checkpoint**: US2 tests pass on Windows and Ubuntu; any unavailable critical mount/reparse fixture leaves the exit gate open.

## Phase 5: User Story 3 — Retrieval is bounded and unambiguous (P2)

**Goal**: Specify and enforce per-tool result ceilings without exposing partial whole-file content.

**Independent test**: Boundary-level read/search fixtures and gateway results respect all byte, match, line, and file limits; unrelated tool output ceilings stay unchanged.

- [ ] T079 [P] [US3] Write failing whole-file, binary, and explicit size-limit tests in tests/workspace/read-bounds.test.ts
- [ ] T080 [P] [US3] Write failing search file/match/line/total-output and truncation-marker tests in tests/workspace/search-bounds.test.ts
- [ ] T081 [P] [US3] Write failing registered output-schema, per-tool maximum, and gateway validation tests in tests/tools/output-contracts.test.ts
- [ ] T082 [US3] Implement complete-or-size-limit bounded read contract over safe opened handles in src/workspace/retrieval.ts
- [ ] T083 [US3] Implement bounded search result assembly with separate omitted-match and shortened-line markers in src/workspace/retrieval.ts
- [ ] T084 [US3] Split search_code.limit to 1–200 and register output schemas and per-tool byte maxima in src/tools/registry.ts
- [ ] T085 [US3] Enforce trusted 64 KiB read, 32 KiB search, and existing smaller other-tool result ceilings in src/tools/gateway.ts

**Checkpoint**: US3 fixture contracts pass; complete model-visible read/search executors remain Phase 6.

## Phase 6: Polish and phase gate

- [ ] T086 Run specs/005-workspace-boundary/quickstart.md and the pinned project gate on Windows and Ubuntu; record exact native fixture evidence and remaining gates in coding-agent-context/context/testing.md
- [ ] T087 Update Phase 4 status only from observed test evidence in coding-agent-context/context/progress-checker.md and reconcile any changed boundary wording in coding-agent-context/context/tool-policy.md

## Dependencies and execution order

- T059–T063 establish the build and contracts. T064–T068 then prove trusted checkout selection and admission. T069–T078 consume that sealed checkout for safe path facts. T079–T085 consume safe opened handles and enforce catalog-owned result contracts. T086–T087 close the evidence gate.
- Tests T064/T065, T069–T072, and T079–T081 precede their corresponding implementation. Confirm a relevant failure before coding each behavior.
- T060 can proceed alongside T059/T061. T065 can proceed alongside T064. T069–T072 target separate test files. T074 and T075 target separate platform files after the native binding contract is fixed. T079–T081 target separate test files.
- US1 is the first independent MVP checkpoint. US2 is required before any real repository content adapter is enabled. US3 can develop against the safe-open contract after T061/T062, but its final verification depends on US2.

## Parallel examples

- **US1**: T064 and T065 write independent admission and membership fixtures before T066/T067.
- **US2**: T069–T072 write independent policy, OS, mount, and gateway fixtures; T074 and T075 implement different OS backends.
- **US3**: T079–T081 write independent read, search, and gateway contract fixtures before T082–T085.

## Implementation strategy

Complete setup and foundational work, then US1 as the first testable slice. Finish US2's fail-closed OS boundary before enabling any later file adapter. Finish US3's bounded contracts and both-host gate before marking Phase 4 verified. Phase 6 owns model-visible retrieval, Phase 7 owns mutation grants and point-of-use writes, and Phase 9 owns Git evidence and branch-switch detection.
