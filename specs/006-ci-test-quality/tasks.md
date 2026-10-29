# Tasks: Contributor CI and Mutation-Guided Test Quality

**Input**: [spec](spec.md), [plan](plan.md), [research](research.md), [data model](data-model.md) and [contracts](contracts/decisions.md).
**Authorization**: Planning only. All implementation tasks remain unchecked; [decisions](contracts/decisions.md) controls release. External rollout gates are not satisfied by passing local tests.
**Tests**: Required behavioral RED/GREEN slices. A task that changes behavior writes its focused test first, implements that slice, and records exact commands/statuses; do not bulk-write all tests before implementations.

## Phase 1: Setup

- [x] T001 Inventory current workflow/test/protection identities and retained public historical heads/conventions; prepare a stage-A/operator/cleanup rollout checklist in docs/agents/ci-rollout.md without changing live settings.
  - **Owned Paths**: `docs/agents/ci-rollout.md`.
  - **Dependencies**: none
  - **Acceptance**: Record source revision and local evidence pointers; env files remain unread.

## Phase 2: Foundational

- [x] T002 [P] Implement versioned direct check policies and exact historical identity selection with RED/GREEN refusal fixtures in scripts/ci/required-checks.mjs, config/legacy-ci-heads.json and tests/ci/required-checks.test.mjs.
  - **Dependencies**: T001
  - **Acceptance**: Keep ci-v1 as the sole active policy during preparation; test the explicit Stage A2 switch and subsequent new/open-head refusal of historical ci-v1. Cover unknown profiles, duplicate/wildcard bindings, exact repository/PR/head/tree/MERGED identity, application, latest failure, skipped/cancelled/missing results and historical convention separation. Active policy is not selected by environment or PR input.
- [x] T003 [P] Add a clean-build-only mode while preserving the default full local gate in scripts/ci/check-runtime.mjs and tests/ci/runtime-gate.test.mjs.
  - **Dependencies**: T001
  - **Acceptance**: Deny unknown options before effects; test clean output, bounded command failure and unchanged default sequence. Do not run the full local publication gate during worker implementation.

## Phase 3: US1 — Required CI Responsibilities

**Goal**: Separate visible checks while preserving complete behavioral coverage and readiness.
**Independent Test**: Current-policy fixtures refuse each missing/failing responsibility; both OS runtime artifacts preserve exact inventory and identity.

- [x] T004 [US1] Migrate the three consumers and retained publication policy accounting to the shared policies in scripts/agents/pr-workflow-status.mjs, scripts/agents/paired-issue-state.mjs, scripts/agents/paired-merge-eligibility.mjs and scripts/agents/pr-workflow-publish.mjs, updating tests/agents/support/pr-workflow-fixture.mjs, tests/agents/support/complete-paired-issues-fixture.mjs, tests/agents/pr-workflow-readiness.test.mjs, tests/agents/paired-merge-eligibility.test.mjs, tests/agents/complete-paired-issues.test.mjs and tests/agents/paired-issue-followup.test.mjs.
  - **Dependencies**: T002
  - **Acceptance**: Integrate shared-policy support with ci-v1 still current until T012 activates ci-v2. Preserve each consumer's result vocabulary, exact candidate binding, read-only eligibility behavior, paired privacy and historical merged-ticket completion; no old-or-new success fallback. Test ci-v2 selection through the pure selector without prematurely activating production requirements.
- [x] T005 [US1] Stage new direct jobs while retaining the four transitional old jobs in .github/workflows/contributor-checks.yml and .github/workflows/runtime-checks.yml, with cross-file contract fixtures in tests/ci/workflow-contracts.test.mjs.
  - **Owned Paths**: `.github/workflows/contributor-checks.yml`, `.github/workflows/runtime-checks.yml`, `tests/ci/workflow-contracts.test.mjs`, `docs/agents/ci-rollout.md`, `context/testing.md`.
  - **Dependencies**: T003, T004
  - **Acceptance**: Preserve PR/push/manual triggers, finite limits, pinned actions, non-persisted credentials and fail-fast:false OS lanes. Cross-file tests require runnable counterparts for the active ci-v1 policy and inventory staged non-required jobs; do not require absent pr-metadata yet. New jobs explicitly check out/verify PR H while recording distinct B/M; bind artifacts to repository/run/attempt/H/OS and hash manifest. Refresh preparation-stage docs/context before any independently released batch's review/publication.
- [x] T006 [US1] Retain machine-readable results, elapsed diagnostics and complete inventory/integrity checks across scripts/ci/run-runtime-tests.mjs, scripts/ci/run-contributor-tests.mjs, scripts/ci/test-selection.mjs, tests/ci/test-partition.test.mjs and the two staged workflows .github/workflows/contributor-checks.yml and .github/workflows/runtime-checks.yml.
  - **Dependencies**: T005
  - **Acceptance**: Test failure propagation, missing/orphan/duplicate emission inside each new lane, distinct PR H/B/M, wrong repository/source/run/attempt/OS or tampered artifact, and failed-only reruns lacking the current build. Count deliberate old/new transition duplication separately. Preserve publication's default runner and discover current inventories; no numerical shards yet.

## Phase 4: US2 — Repository and PR Policy

**Goal**: Reject prohibited content and stale/invalid metadata with sanitized evidence.
**Independent Test**: Synthetic Git/scanner/event/live-read fixtures exercise policy and changed metadata without actual env-file reads or remote writes.

- [x] T007 [P] [US2] Extend tracked-path refusal for environment basenames in scripts/ci/check-tracked-files.mjs and tests/ci/check-tracked-files.test.mjs.
  - **Dependencies**: T002
  - **Acceptance**: Cover nested/mixed-case/force-added names and exact lowercase example exception while preserving existing artifact rules and zero ignored-env reads.
- [x] T008 [P] [US2] Implement bounded Git-blob placeholder validation and redacted diagnostics in scripts/ci/check-env-examples.mjs and tests/ci/env-examples.test.mjs.
  - **Dependencies**: T002
  - **Acceptance**: Cover file mode, encoding, size, syntax, quotes/export and approved literals; reject real-looking values without echoing them.
- [x] T009 [P] [US2] Implement the pinned/checksummed Gitleaks CLI adapter, admitted Git ranges/snapshot fallback and allowlisted summaries in scripts/ci/scan-secrets.mjs and tests/ci/scan-secrets.test.mjs.
  - **Dependencies**: T002
  - **Acceptance**: Exercise checksum/setup failure, unchanged-tree secret, add-then-delete range secret, absent-base complete-tree fallback, malformed/redaction failures, timeout, bounded output and exact synthetic exemptions without live keys or network tests. A requested scan failure cannot become a clean report.
- [x] T010 [US2] Add the pure event/live metadata adapter and reusable convention validation in scripts/ci/check-pr-metadata.mjs, scripts/agents/pr-conventions.mjs and tests/ci/pr-metadata.test.mjs.
  - **Dependencies**: T002
  - **Acceptance**: Test wrong/missing field types, canonical branch/title/body/base, explicitly bound historical conventions, shell-like input as data and draft/readiness separation.
- [x] T011 [US2] Fetch and validate fresh live metadata before readiness/eligibility in scripts/agents/pr-workflow.mjs, scripts/agents/pr-workflow-status.mjs and scripts/agents/paired-merge-eligibility.mjs, with body-only edit/read-failure regressions in tests/agents/pr-workflow-readiness.test.mjs and tests/agents/paired-merge-eligibility.test.mjs.
  - **Dependencies**: T004, T010
  - **Acceptance**: A successful old same-head CI check must not admit newly-invalid live metadata; retain existing bounded read-only behavior.
- [x] T012 [US2] Wire policy and separate metadata events into .github/workflows/contributor-checks.yml and .github/workflows/pr-metadata.yml, then atomically activate ci-v2 in scripts/ci/required-checks.mjs with activation regressions in tests/ci/required-checks.test.mjs and tests/ci/workflow-contracts.test.mjs.
  - **Owned Paths**: `.github/workflows/contributor-checks.yml`, `.github/workflows/pr-metadata.yml`, `scripts/ci/required-checks.mjs`, `tests/ci/required-checks.test.mjs`, `tests/ci/workflow-contracts.test.mjs`, `docs/agents/pr-workflow.md`, `docs/agents/ci-rollout.md`, `context/testing.md`, `context/workflow.md`.
  - **Dependencies**: T006, T007, T008, T009, T011
  - **Acceptance**: All ten executable workflow counterparts and validators exist before the one-source current-policy switch; cross-file fixtures must now require every ci-v2 counterpart and reject absent metadata. Use read-only PR events and isolated concurrency; no privileged target-event checkout, shell interpolation or raw scanner artifact upload. ci-v1 becomes historical-only after this activation. Update each owning current-policy/completion statement through the context updater before independently releasing activation.

## Phase 5: US3 — Manual Mutation Reports

**Goal**: A fixed-profile, bounded report without automatic execution or merge enforcement.
**Independent Test**: Controlled runner fixtures establish complete/incomplete statuses; a local real Stryker dry run validates source execution. Live dispatch remains an external gate.

- [ ] T013 [US3] Pin Stryker and the fixed whole-module telemetry profile in package.json, pnpm-lock.yaml, stryker.config.json and .gitignore, with configuration checks in tests/ci/mutation-profile.test.mjs.
  - **Owned Paths**: `package.json`, `pnpm-lock.yaml`, `stryker.config.json`, `.gitignore`, `tests/ci/mutation-profile.test.mjs`, `context/tech_stack.md`.
  - **Dependencies**: T002
  - **Acceptance**: Run the required fresh dependency-install check after dependency changes; preserve release-age policy and existing package scripts. Reports/dependencies stay untracked and no mutation command joins publication gates. Refresh the owning installed-tool statement before any independent release; keep workflow availability unverified until observed.
- [ ] T014 [US3] Implement bounded experiment execution, process-tree timeout cleanup and revision-bound complete/partial artifacts in scripts/ci/run-mutation.mjs and tests/ci/mutation-runner.test.mjs.
  - **Dependencies**: T013
  - **Acceptance**: Cover baseline/instrumentation/worker/overall-timeout/artifact failures, unknown profile and arbitrary-command refusal, survivor-only success, unchanged input hashes, zero pending mutants, consistent integral outcome totals, and fresh identity-matching JSON/HTML from a unique run directory. Reject stale pairs and preserve source restoration and command-runner knowledge limits.
- [ ] T015 [US3] Add workflow-dispatch-only telemetry reporting in .github/workflows/mutation-report.yml and corresponding tests/ci/workflow-contracts.test.mjs fixtures.
  - **Dependencies**: T012, T014
  - **Acceptance**: Exclude it from every required list, PR/push trigger and pre-PR hook; retain bounded available failure artifacts and fixed-profile arguments.

## Phase 6: US4 — Meaningful Survivor Test Improvements

**Goal**: Detect actual sanitizer/truncation regressions while explaining selected equivalent and unresolved findings.
**Independent Test**: Exact-limit original-pass/mutant-assertion-failure witness, then a small explicit disposition batch with focused regressions.

- [ ] T016 [US4] Add the exact-byte-limit preservation assertion to tests/runtime/unit/telemetry.test.ts and record the source fingerprint and exact-mutant RED/original GREEN evidence in the implementing session.
  - **Dependencies**: T001
  - **Acceptance**: Reinspect the pilot test, do not overwrite the current file with its stale copy. Preserve content, byte count and truncation status; production source stays unchanged.
- [ ] T017 [US4] Review a bounded sanitizer/truncation survivor batch and add only justified public-behavior assertions in tests/runtime/unit/telemetry.test.ts, recording dispositions and remaining unreviewed scope in specs/006-ci-test-quality/tasks.md with local evidence pointers.
  - **Dependencies**: T016
  - **Acceptance**: Classify equivalents/harness issues/unresolved cases explicitly; do not require all 85 old survivors or a score target. New implementation bugs or boundaries require their applicable scope decision.
- [ ] T018 [US4] Replay focused source/emitted telemetry regressions and exact-mutant witnesses for tests/runtime/unit/telemetry.test.ts, recording comparable scope/settings and acceptance limits in specs/006-ci-test-quality/tasks.md.
  - **Dependencies**: T017
  - **Acceptance**: Refresh scratch inputs and snapshots; a four-mutant or excerpt score cannot substitute for a whole-module result. Do not rerun the full publication suite outside publish.

## Phase 7: Integration and External Rollout

- [x] T019 Refresh the actual implemented workflow/tooling guidance in docs/agents/pr-workflow.md, docs/agents/ci-rollout.md, context/testing.md and context/workflow.md using the context updater, retaining planned-versus-observed evidence. The stage-3 guidance (`docs/guides/mutation-testing.md`, the `context/tech_stack.md` mutation row) is refreshed by the follow-up change that introduces that tooling; it is not claimed here.
  - **Dependencies**: T012, T015, T018
  - **Acceptance**: Review the integrated batch, repair findings and prepare reviewable stage-A publication scope. Preserve existing local full-gate ownership.
  - **Recorded (2026-10-29, Asia/Saigon)**: applied through the sanctioned updater — `node scripts/agents/update-context.mjs --updates <edits.json> --apply` → `{"applied":true,"files":["context/testing.md","context/workflow.md"]}` with `Context checks passed (88 Markdown files; 3 canonical facts). Prose conflicts still require review.`
    - `context/testing.md`: stated the ten `ci-v2` required names and the separate `pr-metadata` event; remote readiness became "all ten current-head `ci-v2` checks … a `ci-v1` head is assessable only through an audited merged binding in `config/legacy-ci-heads.json`".
    - `context/workflow.md`: "all four current-head public CI jobs" → "all ten current-head public `ci-v2` checks".
    - `docs/agents/pr-workflow.md`: two stale readiness statements corrected to name the ten `ci-v2` checks, and each now states explicitly that the required names are a **source** requirement while remote branch protection enforcing them is a separate, unobserved question (see `ci-rollout.md`).
    - `.agents/skills/pr-feedback-loop/SKILL.md`: the finish-gate sentence still claimed "all four public CI jobs"; corrected to the ten `ci-v2` names.
  - **Evidence tier**: every statement above is **planned/source** evidence only. No workflow run, protected-branch state or remote observation backs it; that is T020–T023.
  - **Review batch and repairs (2026-10-29, Asia/Saigon)**: independent review of the integrated A2 batch found and repaired the following, all inside the authorised T007–T019 scope and all behaviour-preserving corrections to the same files. No repair needed a new decision, and none of them observes a remote fact.
    - `tests/ci/workflow-contracts.test.mjs`: the required-counterpart test only asserted `declared.run.length > 0`, which `echo skipped` satisfies. Added a `REQUIRED_COMMANDS` table naming the exact validator invocation(s) each of the ten required jobs must contain, searched over the job block with comment lines removed (the secret scan is a `run: |` body), plus an assertion that the table covers exactly the required job set. A deleted or replaced validator step now fails the suite.
    - `.github/workflows/pr-metadata.yml`: the checkout used the default candidate merge commit, so a PR that edited `scripts/ci/check-pr-metadata.mjs` could certify itself. Pinned the checkout to `github.event.pull_request.base.sha` so the validator and its audited binding list are the base revision's copies. `docs/agents/ci-rollout.md` and `contracts/ci-checks.md` were corrected to match: the earlier "no candidate checkout" wording was inaccurate, because the lane does check out a tree.
    - `scripts/ci/check-env-examples.mjs`: diagnostics substituted `<unprintable path>` for any candidate-controlled path outside printable ASCII, so a filename carrying a newline or ANSI escape cannot forge a second log line; an over-limit blob is now represented by a `MAX_BYTES + 1` buffer instead of `Buffer.alloc(size)`, so a candidate cannot force a multi-gigabyte allocation inside the policy job.
    - `scripts/agents/pr-conventions.mjs`: `validSummary` now rejects every C0 control character and DEL, not only CR/LF.
    - Earlier repairs in the same batch, confirmed present in the working tree: `.env` classification in `scripts/ci/check-tracked-files.mjs` is deny-by-default (any basename containing `.env` except the exact lowercase `.env.example`); `scripts/ci/required-checks.mjs` no longer accepts a caller-supplied historical binding and requires every identity field to be present on both sides; `scripts/ci/check-pr-metadata.mjs` defaults a binding with no recorded convention to the current one; `scripts/ci/scan-secrets.mjs` derives the report filename from the scan kind and checks the `Description` field for leaked matches.
  - **Scope split**: this change carries the CI-policy half only; the mutation tooling and the telemetry survivor assertions are a separate follow-up change.
  - **Repair round 2 (2026-10-29, Asia/Saigon)**: after the first hosted run, the `pr-metadata` lane was red on a reviewed head for a reason no code change could fix. `assertNewDescription` required the body's level-two headings to equal exactly `Summary|Evidence|Merge Danger`, and CodeRabbit appends a `## Summary by CodeRabbit` block to the live description after each review; that edit re-triggers the lane, which then fails, and the next review re-appends the block. `scripts/agents/pr-conventions.mjs` now drops a generated block recognised by its comment markers — never by heading text — before section analysis; a marked block is dropped whether it precedes or follows the canonical sections, an unclosed start marker runs to end of body, and a fenced copy stays literal content. A human-authored fourth `## ` section, a duplicate, a reorder, an empty section and an unmarked `## Summary by CodeRabbit` heading are still refused. Five further review findings were substantiated and fixed (`.gitleaks.toml`/`.gitleaksignore`/inline-allow suppression, the `merge-base --is-ancestor` base rejection, the T016 witness wording, the substring command contract, and the missing candidate-validator existence assertion); one was declined with evidence (`paired-issue-state` needs no historical resolution because the audited binding list is empty by design and the consumer fails closed). All of it stays inside the authorised T007–T019 scope and none of it observes a remote fact.
  - **Local gate for the review batch**: `node --test tests/ci/*.test.mjs` → 107 tests, 106 pass, 0 fail, 1 skipped (file symlinks unavailable on this host); `node --test tests/runtime/unit/telemetry.test.ts` → 26 tests, 26 pass, 0 fail (that file is unmodified in this change); the three reworked agent suites (`pr-workflow-conventions`, `pr-workflow-readiness`, `paired-merge-eligibility`) → 53 tests, 52 pass, 0 fail, 1 skipped. A whole-`tests/agents` sweep was started and abandoned because two of my own concurrent runs contended on shared checkout fixtures and produced spurious failures; only the scoped run is cited. Remote facts are **not** observed by this record: no branch-protection read, no GitHub CI run and no merge backs any statement above; that remains T020–T023.
- [ ] T020 Record stage-A publication/current-head CI and both old/new named-job observations in docs/agents/ci-rollout.md and specs/006-ci-test-quality/contracts/decisions.md after ordinary contributor review/publication gates.
  - **Dependencies**: T019
  - **Acceptance**: External gate: bounded implementation/publication release and actual observation; local fixtures alone do not complete this task.
- [ ] T021 Record an explicitly authorized operator's protection migration and before/after read-back in docs/agents/ci-rollout.md and specs/006-ci-test-quality/contracts/decisions.md.
  - **Dependencies**: T020
  - **Acceptance**: External gate: specific remote-setting authorization, all ten direct app-bound names, strict/admin policy preserved, and a fresh observed candidate. No remote write is authorized by this ledger.
- [ ] T022 Remove transitional old jobs only after verified migration in .github/workflows/contributor-checks.yml and .github/workflows/runtime-checks.yml, updating tests/ci/workflow-contracts.test.mjs and docs/agents/ci-rollout.md.
  - **Dependencies**: T021
  - **Acceptance**: Publish as a separate bounded cleanup batch; historical ci-v1 identity selection remains for immutable merged heads.
- [ ] T023 Record authorized default-branch workflow availability and a real manual telemetry dispatch in docs/agents/ci-rollout.md and specs/006-ci-test-quality/tasks.md.
  - **Dependencies**: T020
  - **Acceptance**: External gate: ordinary approved default-branch promotion, dispatch authorization and observed revision-bound complete/partial artifacts. Do not push directly or treat the workflow file alone as availability.
- [ ] T024 Finalize scope-specific acceptance, unresolved survivor/rollout limits and context refresh in specs/006-ci-test-quality/tasks.md, context/testing.md and docs/agents/ci-rollout.md before the applicable contributor handoff/completion gate.
  - **Dependencies**: T018, T022, T023
  - **Acceptance**: Keep incomplete external evidence unchecked; no whole-runtime or whole-repository quality claim.

## Dependencies

The per-task declarations above are the authoritative directed acyclic graph. External gates remain separate from task dependencies.

## Parallel Opportunities and Delivery

After T001, T002/T003 own disjoint paths. After their prerequisites, T007/T008/T009 are disjoint policy slices; T010 is independently preparable. US4 can proceed after T001 without waiting for CI rollout. Shared workflow, readiness and telemetry test files are serialized by explicit dependencies; T012 depends on T011/T006, so its shared-policy/workflow activation follows earlier edits; T015 follows T012 because both affect workflow-contract fixtures.

Suggested preparatory delivery: T001–T006 are publishable only with ci-v1 still the sole current policy and old jobs intact; this is Stage A1, not completed ci-v2/US1 acceptance. Stage A2 requires T007–T012 and then activates all ten counterparts together. An independently valuable first test-quality MVP is T001 plus T016–T018, without waiting for CI activation. Release manual tooling and other batches separately where reviewable; target roughly 1,000 reviewable lines per implementation PR and report generated lockfile lines separately. T020–T023 require actual external evidence/authority. Task order and checkboxes never release unapproved successor work.

Every independently released batch performs its own applicable context review/update, integrated review and ordinary publication/completion gates. T019 is the final cross-story reconciliation, not permission to defer earlier documentation or review. Record batch-specific publication evidence locally and in the rollout checklist; T020 summarizes the complete Stage A2 observation after the integrated scope, not the only allowed earlier publication point.
