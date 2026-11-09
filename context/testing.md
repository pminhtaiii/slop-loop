# Contributor Testing Guidance

This document describes current contributor testing guidance and the helper tests present in this repository. It is not the complete verification specification for the planned slop-loop runtime; see [the target verification matrices](../docs/progress-checker-matrices.md).

Recorded run results — dates, revisions, pass counts and remaining gaps — belong in the [implementation status ledger](progress_checker.md). This page states what to test and which command exercises it; it is not a log. A result recorded here or there describes the revision it was pinned to and does not establish current readiness.

Use the repository's established test and quality commands. Read `AGENTS.md`, project documentation, and the feature plan for applicable requirements; do not assume a test framework or invent project-wide commands.

## What to test

- Prioritize critical functionality: core business logic, authentication, important API endpoints, database operations, and essential user workflows.
- Focus on high-risk areas: where a failure would have the greatest impact.
- Keep testing minimal: write only meaningful tests that catch realistic bugs; avoid excessive coverage, redundant tests, and trivial assertions.
- Choose the test level: prefer fast unit and integration tests; add E2E tests only for essential user journeys.
- Avoid overengineering: use existing tools and conventions; do not add unnecessary frameworks, mocks, or complex test infrastructure.
- Verify and report: run the relevant tests, fix discovered issues, and summarize what was tested, what passed, and what remains risky.

## Test-first implementation

- For code changes, use the repository's `tdd` skill and write or update focused behavioral tests before implementation.
- Run the narrowest relevant tests first, then the broader applicable regression checks.
- Treat unrelated collection, environment, harness, or fixture failures as blockers to test evidence, not as a passing behavioral test.
- Do not skip coverage, weaken assertions, change expected behavior, or relax a safety constraint just to obtain a passing result.
- Acceptance evidence checks the returned outcome and persisted state separately; a passing command does not establish acceptance when either result is wrong.
- On refusal or denial, assert zero effects: persisted state is unchanged and no downstream port, tool, or external effect runs.
- For a public port-only wrapper, verify that it forwards the expected input, preserves the returned outcome, and adds no policy or side effect.
- When changed logic spans a meaningful predecessor-to-successor transition, cover at least one such flow; do not test every graph edge or trivial edit. Test names, comments, and acceptance claims must match the exercised boundary: a node-factory test proves node behavior; graph routing requires invoking the graph through the relevant transition. If the required witness belongs to another task, record the gap, owner, and completion dependency; ownership or deferral does not establish a passing criterion.
- For changed decisions, identify the behavior each regression protects and assert its observable outcome and relevant effects. Prefer meaningful behavioral coverage over a raw coverage percentage. Use a focused mutation check when it is unclear whether an assertion distinguishes the intended branch; a numeric mutation gate or tests for equivalent mutants are not required by this guidance.
- For UC-03, select applicable boundary regressions for mixed-version input, missing authority, forged receipts, refusal with zero effects, and no-funds settlement. These are focused boundary evidence, not a per-task review or universal matrix.

## Reporting results

Report exact commands and exit statuses, and distinguish passed, failed, and unrun checks. For criterion-level task evidence and handoff status, follow the [task-verification contract](../docs/agents/task-verification.md); explain why an applicable check was not run. A focused pass proves only the behavior it exercised.

For focused mutation evidence, retain the exact mutation and confirm it changed the intended source before running the test. Check that it alters the targeted decision for the fixture, especially for compound conditions. Count a mutant as detected only when the relevant behavioral assertion fails; compilation, collection, or harness failures are inconclusive. A source edit that did not apply is an invalid experiment, not a surviving or detected mutant. Restore the original source, verify restoration, and rerun the focused check on the clean candidate. Keep mutant output separate from clean-candidate evidence.

Task completion requires integrated implementation and passing applicable checks; feature completion also requires resolved test, convergence, and review gates. Historical or intentionally red runs do not establish current readiness.

`publish` is the sole local full-gate runner; workers, mergers and reviewers run focused checks. Gate contents, automatic changed-path selection, runtime validation, dependency-install and tracked-file rules live in the [PR workflow](../docs/agents/pr-workflow.md#publish-a-draft); full-mode gate results are not cached, automatic contributor-only skips are recorded explicitly, and CI runs independently. The tracked-file gate rejects installed node_modules at any depth and root docs/verification records, including force-added ignored files; local untracked artifacts and tracked lockfiles are permitted. The `ci-v5` policy requires four exact-head GitHub Actions successes with bare check names and Ubuntu-only jobs; `build`, `contributor-tooling-tests` and `runtime-tests` still run but do not gate a merge, and historical ci-v1–ci-v4 need audited merged bindings (see the [Ubuntu-only amendment](../specs/006-ci-test-quality/contracts/ubuntu-only.md)). Unresolved comments and CodeRabbit approval remain advisory for the merge decision. These gates verify repository helpers, context consistency and runtime bootstrap integration; they do not verify planned product-runtime capabilities.

The contributor-checks workflow runs `pnpm run lint` and `pnpm run format:check` before contributor tests.

## Local helper tests

Session-retro contributor regressions exercise public CLI boundaries in `tests/agents/active-task-factory.test.mjs`, `contributor-prepare.test.mjs`, `focused-check.test.mjs`, `publication-policy.test.mjs`, `publication-job.test.mjs`, `pr-workflow.test.mjs`, `pr-workflow-push-only.test.mjs`, `whitespace-hook.test.mjs`, and `tests/ci/check-context.test.mjs`. Capture focused output on its first run through the [receipt runner](../docs/agents/orchestration-tools.md#focused-verification-receipts); reuse requires unchanged command, candidate, declared inputs, runtime identity and retained output. These receipts do not substitute for independent CI or required full-mode publication gates. Public lifecycle fixture results establish local contributor behavior, not product-runtime acceptance.

The planning-workflow regressions cover required artifact types, unique sequential task IDs, invalid dependency graphs, normalized explicit ownership and directory overlap, dependency-ordered shared paths, nested contract inventories, malformed review rejection, and automated-only status. These checks do not certify independent reviews or authorize feature implementation.

The task-context, managed-session, and planning-workflow helpers require Node.js 20 or newer and use Node.js built-ins, so they can be tested without installing packages. Resume regressions cover status-column preservation, rename pairing, canonical checkout aliases and missing checkout records; task context excludes sibling-task continuation bullets; direct invocation follows path aliases while imports remain inert:

```powershell
node --test tests/agents/agent-context.test.mjs tests/agents/agent-work.test.mjs tests/agents/planning-workflow.test.mjs
```

Test active-task handoff behavior, explicit reassignment to a terminal status, legacy recorded-transfer migration, preview/apply archival, collision refusal, and archive recovery directly with:

```powershell
node --test tests/agents/active-task.test.mjs tests/agents/active-task-reassignment.test.mjs
```

Test worktree retirement eligibility and safe removal in disposable Git repositories with `node --test tests/agents/agent-worktree.test.mjs`. These checks cover preview-only operation, retained branches, unmerged commits, dirty/untracked/ignored data, resumed tasks, changed evidence, locked or unknown worktrees, and retirement after the successor work is complete or handed off; active or blocked successors remain blockers while reassigned predecessors do not. Skill evaluations additionally follow [the versioned evidence procedure](workflow.md#skill-evaluation-evidence).

The publication contributor gate covers preflight reporting without publication, UC brief extraction without ledger writes, archive-before-clear safety, and completion refusals for unpublished, dirty, stale, unlinked, pending, or failing revisions.

## Context consistency check

After changing [the context contract](contract.json), `AGENTS.md`, `context/*.md`, the matrices, or referenced agent documentation, run the consistency check. It follows local inline links transitively into Markdown documents from the existing roots, visits cycles once, and enforces checkout containment for every checked link. It checks that required documents exist, declared fact sources resolve to one table row, every context Markdown page is linked from `context/README.md`, `AGENTS.md` links to that README, local inline Markdown file links resolve, and explicitly marked fact claims match their source rows. It also checks authorizationReferences: every configured summary links to its designated source document, and each declared skill stage links to that skill inside its stage section. These pointer checks do not interpret decision contents or infer permission from task progress. It ignores external URLs, heading-only links, and examples in fenced code blocks or HTML comments. It cannot detect conflicts in unmarked prose, so review related documents for semantic consistency.

Run:

```powershell
node scripts/ci/check-context.mjs
```

## Context updater tests

Test post-implementation context updates with `node --test tests/agents/update-context.test.mjs`. The CLI checks cover read-only preview, architecture and progress updates, newline preservation, stale or ambiguous edits, heading preservation, out-of-scope targets, batch rollback on invalid links, no-change validation, and updater lock retention. Follow [context maintenance](../docs/agents/context-maintenance.md) for the update-plan format and completion procedure.

## Runtime bootstrap gate

Bootstrap tools and declaration limitations: [technology stack](tech_stack.md). Publication runs typecheck, lint, clean build and emitted tests with source/emission parity. Focused contract command: `node --test dist/tests/runtime/contract/uc03.test.js`. Package-manager, hook and staged-artifact rules: [workspace guidance](../docs/agents/workspace.md#repository-package-manager). Contributor checks are separate. Mock results do not establish real execution, isolation or restart.

UC-03 test support lives under `tests/runtime/support/uc03/`, with state/approval vectors in `tests/runtime/contract/uc03-mocks.test.ts` and provider/repository vectors in `tests/runtime/support/uc03/provider-mocks.test.ts`. `pnpm validate:runtime` builds and runs the emitted suites alongside the unchanged canonical contract vectors. Missing/exhausted budgets and exhausted scripts deny simulated dispatch; all five ports advertise mock provenance and cannot satisfy production admission. CAS, reservation/settlement, approval freshness and interrupted-request tests establish deterministic mock behavior only; no network, real command, durable store, provider quality or actual restart claim follows from those passes.

The shared mock scenario matrix in `tests/runtime/contract/uc03-port-conformance.test.ts` covers missing/exhausted profiles, malformed results, stale state and valid progression where applicable to each port. It retains typed stale-patch rejection and combines settlement-to-actual usage with fresh replan admission. Identity-keyed approval decisions are not consumable queues.

Feature 007 Phase 4–5 controlled checks run as `node --test tests/runtime/unit/evaluation-diagnostics.test.ts tests/runtime/unit/workflow-comparison.test.ts tests/runtime/unit/evaluation-console.test.ts tests/runtime/unit/evaluation-console-page.test.ts` and `node --test tests/runtime/integration/evaluation-failures.test.ts tests/runtime/integration/evaluation-comparison.test.ts`, with emitted counterparts after build. They cover bounded stage/component diagnostics with unknown attribution, workflow comparison guards over case/config/repository/grader identity plus unknown-usage handling, the loopback console's token/Host/Origin/size/artifact refusals before any owner call, and string-level page assertions for escaping, label pairing and single-use idempotency keys. The shared `tests/runtime/support/uc03/controlled-route.ts` harness parks the route at AwaitPlan with mock ports. Every one of these is controlled/mock evidence: no provider call, container execution or browser ran, T011 and T017 stay not-run, and suite acceptance stays incomplete. The console page checks are not a browser journey.

Phase 3 telemetry checks run with `node --test tests/runtime/unit/telemetry.test.ts` (source) or the emitted test after building. The telemetry suite covers secret redaction, tiny and UTF-8 byte bounds, protected metadata rejection before sink effects, and independent task/run usage keys. T005 local-only fixtures are not shipped in the published repository; pytest remains unexecuted while real execution stays gated at T024/T028.

UC01 and UC03 receiver checks run with `node --test tests/runtime/uc01/safety.test.ts` for T014 and `node --test tests/runtime/uc01/*.test.ts` for UC01 regression, then `node --test tests/runtime/unit/uc03-success.test.ts tests/runtime/uc01/receiver.test.ts` and the emitted counterparts after build. C21 exercises the actual receiver without provider access or dispatch. T014 tests guard ordering, protected data, citations, finite limits and uncertain cumulative usage through controlled ports, not actual containment or restart. The [UC01 quickstart](../specs/002-uc01-issue-triage/quickstart.md) and [decision record](../specs/002-uc01-issue-triage/contracts/decisions.md) retain completion, authorization and dataset state; the [UC03 quickstart](../specs/001-verified-code-repair/quickstart.md) retains RED/GREEN evidence. Neither fixture nor contributor checks establish real-model quality or runtime acceptance. Feature 007 T012–T016 are proven only at the controlled tier; their real-tier halves (T011, T014's two-real-attempt comparison, T017) remain not-run. T020–T034 have a separate source/controlled implementation release in the [007 decision record](../specs/007-runtime-evaluation-integration/contracts/decisions.md); that release and restored code do not establish their full acceptance. Host recovery checks use `node --test tests/runtime/contract/uc03-host-bootstrap.test.ts tests/runtime/contract/evaluation-composition.test.ts tests/runtime/unit/uc03-host-cli.test.ts tests/runtime/unit/evaluation-cli.test.ts tests/runtime/integration/uc03-host-pipeline.test.ts`, plus `node --test tests/runtime/integration/uc03-v02-route.test.ts tests/runtime/unit/uc03-coder-v02.test.ts tests/runtime/unit/uc03-replan-port.test.ts tests/runtime/unit/reviewer-v02-accounting.test.ts` and typecheck. Exercise the corresponding emitted tests after build. Counts and remaining gaps belong in the progress ledger and feature quickstart.

## Paired publication tests

Paired publication uses `tests/agents/publication-targets.test.mjs`, `tests/agents/submission-pr.test.mjs`, `tests/agents/paired-issues.test.mjs` and the PR-helper integration tests. They exercise configured-target refusal, unrelated Git histories with exact source-tree snapshots, fast-forward mirror updates, interrupted publication recovery, stable ticket identity, duplicate refusal, canonical Windows fixture paths and publication of the validated body snapshot through disposable Git repositories and injected GitHub APIs. These tests create no live review or submission objects. New-publication regressions additionally cover unnumbered scoped branch names, matching paired PR titles, action summaries, three-section descriptions, full-name collisions in live and paginated historical refs, development-based mirror ancestry distinct from main, unchanged base refs, and legacy main-record verification with target-change refusal. Version 1 numbered records retain their naming and number-inventory rules; new records use version 2. Preflight accepts current and historical syntax; strict naming and inventory checks run before first publication and prepare-next.

Paired documentation eligibility uses `node --test tests/agents/paired-merge-eligibility.test.mjs` with disposable Git repositories and simulated GitHub reads. Focused fixtures exercise allowed prose, policy exclusions, exact paired identity/tree/base binding, later-page check selection and rerun failure, changed observations, missing objects and unchanged local files. These checks establish exercised preview behavior only; live eligible pairs and actual merging are not verified.

Paired issue close and follow-up behavior uses `tests/agents/complete-paired-issues.test.mjs` and `tests/agents/paired-issue-followup.test.mjs` at the CLI and GitHub boundaries. Coverage includes read-only candidate association, evidence preview, exact stable-key identity, both-PR merge/source-tree and public current-head CI admission, metadata-only audit comments, per-comment/per-close revalidation, and interrupted-close recovery. Disposable fixtures close no live issues; helper output does not decide whether acceptance criteria are true.

## Evidence boundaries

Task state and authorization come from each feature's `tasks.md` and `contracts/decisions.md`; current repository evidence is in the [implementation status ledger](progress_checker.md). Keep planned preparation separate from observed local evidence, and keep historical or intentionally red runs out of current readiness claims.

- UC-05 Phase 8 evidence and remaining external prerequisites are tracked in the [task ledger](../specs/003-uc05-human-approval/tasks.md), [decision record](../specs/003-uc05-human-approval/contracts/decisions.md), and [implementation status](progress_checker.md). Required real/restart vectors remain not-run until their owners provide them, and full UC-05 acceptance remains unverified.
- UC-03 Phase 4 repair/replan evidence is tracked in the [task ledger](../specs/001-verified-code-repair/tasks.md) and [implementation status](progress_checker.md). Focused mock-backed checks establish only exercised behavior; real execution, adapters, durable accounting, process restart, and full phase acceptance remain gated.
- UC-03 real adapters and configuration, durable persistence, containment/restart, and full Phase 5/6 acceptance remain gated. Candidate-specific review and test evidence belongs to its pinned snapshot.

Archived worker and gate runs live under `.agent-work/<date>/`; use the task ledger and linked evidence for current status. Contributor-tooling maintenance handoffs and focused checks follow [workspace guidance](../docs/agents/workspace.md) and [orchestration tools](../docs/agents/orchestration-tools.md); they do not establish full runtime or contributor verification, review, publication, or remote readiness.
