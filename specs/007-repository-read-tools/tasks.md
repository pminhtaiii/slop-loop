# Tasks: Repository Read Tools

**Input:** [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/read-tools.md](contracts/read-tools.md), [quickstart.md](quickstart.md).

**Status:** All tasks planned; no implementation checkbox is complete. IDs continue the repository ledger after T131 to avoid GitHub issue collisions.

**Tests:** Mandatory TDD under project workflow. For every RED task, run the stated command and confirm failure for its specified missing behavior before corresponding GREEN. Existing behavior assertions alone do not establish RED. Each GREEN delivers its named interface, targeted PASS and relevant existing regressions; commit the cohesive pair after verification. Do not treat unavailable native/security/performance evidence as PASS.

## Phase 1: Setup

**Goal:** Establish prerequisites without claiming unfinished earlier phases complete.

- [ ] T132 Confirm Phase 4 available-fixture prerequisite and current Phase 5 OPEN gate in coding-agent-context/context/progress-checker.md; run frozen install, pinned native build and existing workspace/tools/orchestration regressions from specs/007-repository-read-tools/quickstart.md, recording host versions and unavailable fixtures in specs/007-repository-read-tools/review.md

## Phase 2: Foundational Contracts and Dispatch

**Goal:** Strict outputs and shared real-time dispatch exist before executors/bootstrap.

- [ ] T133 Write RED strict list scope/entries/kinds/omissions, read and search SHA-256 fields, complete/incomplete reason consistency, metadata-inclusive byte caps and fake-output compatibility tests in tests/tools/output-contracts.test.ts; verify with corepack pnpm exec vitest run tests/tools/output-contracts.test.ts
- [ ] T134 Implement T133 output definitions in src/tools/registry.ts and consumed-byte/incremental-result contracts in src/workspace/retrieval.ts; migrate tests/workspace/read-bounds.test.ts, tests/workspace/search-bounds.test.ts and hash-less fake outputs in tests/tools/workspace-gateway.test.ts plus affected gateway/sandbox fixtures; preserve model inputs and run workspace/tools/orchestration regressions to GREEN
- [ ] T135 Write RED trusted AGENT/BOOTSTRAP origin, unknown secret-bearing tool-name audit sentinel, fresh-clock/remaining-active-work facts, near-time-limit slow final success, pre-audit expiry, single elapsed-time charge, budget parity and after-execution cancellation/late-result tests in tests/orchestration/runner.test.ts and tests/tools/gateway.test.ts; verify with corepack pnpm exec vitest run tests/orchestration/runner.test.ts tests/tools/gateway.test.ts
- [ ] T136 Implement trusted origin, validated-tool/sentinel audit identifiers and remainingActiveWorkMs executor authority in src/tools/gateway.ts plus fresh number-or-clock dispatch/TICK accounting in src/orchestration/runner.ts; account pre-execution and final successful-call time, suppress exhausted/late payloads without mislabeling cancellation, preserve audit/denial semantics, and run runner/gateway plus tests/sandbox/review-regressions.test.ts to GREEN

## Phase 3: User Story 1 — Faithful Whole-File Reads (P1)

**Independent test:** One real safe read through admitted Ask/Edit task and gateway returns complete text/hash or typed size/binary outcome, with no forbidden bytes.

- [ ] T137 [US1] Write RED consumed-byte hashing, JSON-envelope size limit, exact 4 MiB versus 4 MiB+1 search-probe capacity, alias identity revalidation, binary/invalid UTF-8 and all-exit handle-close tests in tests/tools/read.test.ts and tests/workspace/read-bounds.test.ts; run those suites and existing tests/workspace/boundary.test.ts
- [ ] T138 [US1] Implement createReadExecutors read_file in src/tools/read.ts and hash integration in src/workspace/retrieval.ts; lift only private probe capacity guards in src/workspace/boundary.ts and native/workspace/addon.cc to 4 MiB+1, preserving public file caps and point-of-use checks; rebuild pinned native addon and run T137 plus tests/tools/output-contracts.test.ts to GREEN

## Phase 4: User Story 2 — Bounded Listing and Literal Search (P1)

**Independent test:** Script list -> scoped search -> read with real boundary/gateway; every truncation/incomplete state is truthful and every accessed target confined.

- [ ] T139 [P] [US2] Write RED sorted immediate child kinds, root scope, canonical alias deduplication, 1–100 count, 16 KiB serialized cap, omittedEntries and >=1024-child fail-closed fixtures in tests/tools/list.test.ts; verify with corepack pnpm exec vitest run tests/tools/list.test.ts
- [ ] T140 [US2] Implement list_files within createReadExecutors in src/tools/read.ts using validated immediate directory snapshots, deterministic ordering and strict bounded output; retain native high-fanout authority failure and close handles; run tests/tools/list.test.ts tests/tools/output-contracts.test.ts to GREEN
- [ ] T141 [P] [US2] Write RED case-sensitive literal/metacharacter/newline queries, safe file/directory scopes, oversize/binary skips, match/line/envelope caps, alias/cycle/depth limits, source-byte accounting including discarded probes, quota-shortened-read no-prefix-search, deadlines and incomplete no-match in tests/tools/search.test.ts; verify with corepack pnpm exec vitest run tests/tools/search.test.ts
- [ ] T142 [US2] Implement search_code in src/tools/read.ts, safe file-or-directory facts in src/workspace/boundary.ts and incremental bounded matching in src/workspace/retrieval.ts; enforce plan-owned counters/yields, safe 4 MiB+1 probing, content identity and complete/reason flags; run tests/tools/search.test.ts tests/workspace/search-bounds.test.ts tests/tools/output-contracts.test.ts to GREEN
- [ ] T143 [US2] Write RED listing-path fidelity plus root/read/search narrow-heuristic false-positive and failure-without-content regression tests in tests/tools/output-contracts.test.ts; assert no rewritten canonical path, no raw affected content/audit and no broader scanner behavior; run that suite
- [ ] T144 [US2] Extend retrieval output fidelity to list_files in src/tools/gateway.ts while retaining existing narrow read/search heuristic semantics; add an internal benchmark-accessible sanitizer seam only if necessary, never an execution bypass; run tests/tools/output-contracts.test.ts tests/tools/gateway.test.ts to GREEN
- [ ] T145 [US2] Add RED then GREEN real safe-boundary/gateway integration and hostile fixtures in tests/tools/read.integration.test.ts and tests/tools/read.security.test.ts for traversal, hard links, nested repos, mount/reparse/path swaps, missing native authority, audit outages, cooperative cancellation and late-result suppression; run both suites on Ubuntu and Windows, naming T088/unavailable cases explicitly

## Phase 5: User Story 3 — Small Authorized Bootstrap (P2)

**Independent test:** Root-only instruction discovery and explicit references use normal dispatch/budgets/audit; nested instruction discovery and external import remain absent.

- [ ] T146 [US3] Write RED root-only discovered instructions, references/deduplication including a developer-referenced nested instruction file, 32-raw-reference/1024-character preprocessing bounds and bounded omission summaries, unknown-versus-missing root, bootstrap caps, budget parity, sensitive instructions and failure/cancellation suppression in tests/orchestration/context.test.ts; verify with corepack pnpm exec vitest run tests/orchestration/context.test.ts
- [ ] T147 [US3] Implement collectInitialContext and bounded BootstrapInput/BootstrapContext in src/orchestration/context.ts using runner.dispatchProposals with trusted BOOTSTRAP origin after INSPECTING eligibility; include only safe gateway fragments, preserve failure/cancellation behavior and explicit-reference exception, and run context plus runner/gateway suites to GREEN

## Phase 6: User Story 4 — Evaluation and Performance Evidence (P2)

**Independent test:** Deterministic fixture traces emit correct finite metrics and evidence expectations, and measured narrow-heuristic overhead meets frozen host baselines.

- [ ] T148 [P] [US4] Write RED fixture expectation validation, delivered-content versus discovery accounting, zero-denominator formulas, forbidden-delivery/denied-attempt distinction and NOT_MEASURED live-answer tests in tests/retrieval/evaluation.test.ts with tests/fixtures/retrieval/expectations.json; run the evaluation suite
- [ ] T149 [US4] Implement test-only metric/trace helpers in tests/retrieval/evaluation.test.ts and fixture repositories under tests/fixtures/retrieval/; execute bootstrap -> search -> read through real admitted runner/gateway/native boundary, assert declared evidence properties and diagnostic verification selections, and run evaluation plus read integration to GREEN
- [ ] T150 [P] [US4] Write RED maximum read/search/list envelope, long/repeated heuristic candidate, normal/no-match/Unicode and secret-free benchmark-report correctness tests in tests/retrieval/performance.test.ts; define measurement cases and host metadata expectations without unit timing assertions, then run that suite
- [ ] T151 [US4] Implement scripts/benchmark-retrieval.ts and package.json retrieval:bench using the actual gateway sanitization path; calibrate 100 warmups and >=1000 sanitizer samples plus >=30 end-to-end runs per Ubuntu/Windows host, record p50/p95/p99 and isolate baseline overhead in tests/fixtures/retrieval/performance-baselines.json; freeze justified thresholds before enablement and run performance correctness tests to GREEN
- [ ] T152 [US4] Write RED baseline selection, missing/unknown host baseline, correctness-before-timing, check-mode no-baseline-rewrite and sanitizer baseline*1.25+1 ms regression-gate tests in tests/retrieval/performance.test.ts; verify that invalid/missing evidence cannot authorize retrieval enablement
- [ ] T153 [US4] Implement T152 check gates in scripts/benchmark-retrieval.ts and dedicated performance execution in .github/workflows/ci.yml; record reference-host evidence in coding-agent-context/context/testing.md, run retrieval:bench -- --check on Ubuntu/Windows, and keep enablement blocked where evidence is unavailable or fails

## Phase 7: Verification, Review and Context Synchronization

- [ ] T154 After T151–T153 measured gates pass, write RED then GREEN composition coverage in tests/tools/read.integration.test.ts and add createReadGateway in src/tools/read-gateway.ts installing only real read executors/workspace facts with trusted audit/grant ports; run all six quality gates and both-host native retrieval/security/benchmark matrix, recording evidence in specs/007-repository-read-tools/review.md
- [ ] T155 Perform security convergence against specs/007-repository-read-tools/spec.md and contracts/read-tools.md; resolve authorization, secret, path, audit, cancellation and bounding findings in affected src/tools, src/workspace and src/orchestration files before proceeding
- [ ] T156 Perform distinct standards/security and specification reviews of the implemented branch, recording findings and verification in specs/007-repository-read-tools/review.md; fix blocking and relevant security-medium findings and rerun affected tests
- [ ] T157 Synchronize implemented evidence across every phase-relevant coding-agent-context/context document, CONTEXT.md and docs/adr/0012-automatic-context-retrieval-authority.md; preserve Phase 5 OPEN gate and T088, and leave deferred integrations explicitly planned
- [ ] T158 Close only the Phase 6 gate in coding-agent-context/context/progress-checker.md after T154–T157 and both-host measured evidence pass; record remaining limitations and ready-to-compose registration in specs/007-repository-read-tools/review.md without claiming provider/CLI/durable-audit or earlier gate completion

## Dependencies and Execution Order

- T132 -> T133 -> T134 -> T135 -> T136 is foundational. RED tasks precede GREEN, not separate implementation checkboxes preemptively marked done.
- US1 T137 -> T138 depends on foundation. US2 T139 -> T140 and T141 -> T142 depend on T138; T143 -> T144 follows listing/search, and T145 follows T144.
- US3 T146 -> T147 depends on US1/US2 and the shared dispatch contract. Its tests can use fake retrieval results independently, but real bootstrap integration waits for executors.
- US4 T148 -> T149 depends on US3 for full scripted E2E; T150 -> T151 -> T152 -> T153 depends on T144 and real retrieval for end-to-end performance.
- T154 -> T155 -> T156 -> T157 -> T158 requires all stories and measured host gates. Phase 5 Docker gate remains a separate OPEN prerequisite for later complete Edit integration, not a prerequisite for these host-read tests.

## Parallel Opportunities

- After T138, US2 RED tasks T139 and T141 touch separate files and can be prepared concurrently; GREEN tasks share src/tools/read.ts and remain sequential.
- After US3, US4 RED fixture/metric T148 and performance-case T150 can proceed in parallel; evaluation implementation and benchmark work use separate files after their own RED.
- Bootstrap fake-port tests T146 can be prepared alongside search tests after foundation, but implementation waits for US2 and no shared runner/gateway edits run concurrently.

## Implementation Strategy and Interfaces

US1 is the first usable retrieval increment; all four stories are required for Phase 6 completion. Use the factory, trusted dispatch origin/clock and bootstrap signatures in plan.md. The exact result shapes/formulas are in data-model.md and contracts/read-tools.md; do not invent incompatible wrappers. Each task consumes the global constraints and its RED predecessor's assertions; verify targeted GREEN then existing related regression before committing. No task introduces a production evaluation service, general file-loader framework or provider integration.

## Requirement Coverage

| Requirements | Tasks |
| --- | --- |
| FR-001, FR-007–FR-010 | T133/T134, T139–T142 |
| FR-002/FR-003/FR-013/FR-014/FR-018 | T135/T136, T143–T147 |
| FR-004–FR-006/FR-011 | T137/T138, T142/T145 |
| FR-012 | T143/T144, T150–T153 |
| FR-015–FR-017 | T146/T147 |
| FR-019/FR-020/FR-023 | T148/T149, T154/T158 |
| FR-021 | T150–T154 |
| FR-022/FR-024 | T132, T145, T154–T158 |

27 tasks: setup 1, foundation 4, US1 2, US2 7, US3 2, US4 6, final 5. GitHub issues preserve these IDs and dependencies; do not reuse Feature 006 T129/T131.
