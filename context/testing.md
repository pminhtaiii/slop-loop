# Contributor Testing Guidance

This document describes current contributor testing guidance and the helper tests present in this repository. It is not the complete verification specification for the planned slop-loop runtime; see [the target verification matrices](../docs/progress-checker-matrices.md).

Use the repository's established test and quality commands. Read `AGENTS.md`, project documentation, and the feature plan for applicable requirements; do not assume a test framework or invent project-wide commands.

## Test-first implementation

- For code changes, use the repository's `tdd` skill and write or update focused behavioral tests before implementation.
- Run the narrowest relevant tests first, then the broader applicable regression checks.
- Treat unrelated collection, environment, harness, or fixture failures as blockers to test evidence, not as a passing behavioral test.
- Do not skip coverage, weaken assertions, change expected behavior, or relax a safety constraint just to obtain a passing result.

## Reporting results

For every validation command, report the exact command and its exit status. Distinguish passed, failed, and unrun checks; explain why an applicable check was not run. A focused pass proves only the behavior it exercised.

Do not mark a task complete until its implementation is integrated and its applicable checks pass. Do not claim feature completion while required tests, convergence, or review gates remain unresolved.

Before a draft PR is created or updated, publish runs `node scripts/ci/check-tracked-files.mjs`, `node scripts/ci/check-context.mjs`, `node scripts/ci/check-runtime.mjs`, and `node --test`. The tracked-file gate rejects installed node_modules directories at any depth and root docs/verification records, including force-added ignored files; local untracked artifacts and tracked lockfiles are permitted. Runtime validation cleans dist and runs typecheck, lint, build and compiled smoke tests, matching runtime CI. Dependency-input changes since the last published head (or development for a first publication) additionally require `node scripts/ci/check-dependency-install.mjs`: a frozen install with fresh metadata and explicit supply-chain policy verification. Remote readiness separately requires all four current-head contributor/runtime Ubuntu and Windows jobs and no GitHub merge blocker. Unresolved comments remain visible and advisory for the human merge decision. CodeRabbit approval is advisory and optional. See the [PR workflow](../docs/agents/pr-workflow.md) for status and repair behavior. These gates verify repository helpers, context consistency and runtime bootstrap integration; they do not verify planned product-runtime capabilities.

T004 test support lives under `tests/runtime/support/uc03/`, with state/approval vectors in `tests/runtime/contract/uc03-mocks.test.ts` and provider/repository vectors in `tests/runtime/support/uc03/provider-mocks.test.ts`. `pnpm validate:runtime` builds and runs the emitted suites alongside the unchanged canonical contract vectors. Missing/exhausted budgets and exhausted scripts deny simulated dispatch; all five ports advertise mock provenance and cannot satisfy production admission. CAS, reservation/settlement, approval freshness and interrupted-request tests establish deterministic mock behavior only. No network, real command, durable store, provider quality or actual restart claim follows from these passes.

The shared mock scenario matrix in `tests/runtime/contract/uc03-port-conformance.test.ts` covers missing/exhausted profiles, malformed results, stale state and valid progression where applicable to each port. It retains typed stale-patch rejection and combines settlement-to-actual usage with fresh replan admission. Identity-keyed approval decisions are not consumable queues.

Paired publication uses `tests/agents/publication-targets.test.mjs`, `tests/agents/submission-pr.test.mjs`, `tests/agents/paired-issues.test.mjs` and the PR-helper integration tests. They exercise configured-target refusal, unrelated Git histories with exact source-tree snapshots, fast-forward mirror updates, interrupted publication recovery, stable ticket identity, duplicate refusal, canonical Windows fixture paths and publication of the validated body snapshot through disposable Git repositories and injected GitHub APIs. These tests create no live review or submission objects. New-publication regressions additionally cover scoped branch names, action summaries, three-section descriptions, unique identifiers across local/live/paginated historical refs, development-based mirror ancestry distinct from main, unchanged base refs, and legacy main-record verification with target-change refusal. Preflight keeps its historical syntax check; strict naming and inventory checks run before first publication and prepare-next.

Paired issue completion uses `tests/agents/complete-paired-issues.test.mjs` at the public CLI/module and external GitHub boundaries. Coverage includes preview without remote mutations, merged-PR/current-head CI and source-tree admission, exact stable-key identity, metadata-only audit comments, per-comment/per-close revalidation and recovery from interrupted per-side comments or closes. Disposable fixture roots are canonicalized for Windows; these tests close no live issues.

Phase 3 telemetry checks run with `node --test tests/runtime/unit/telemetry.test.ts` (source) or the emitted test after building. The integrated 19-case telemetry suite covers secret redaction, tiny and UTF-8 byte bounds, protected metadata rejection before sink effects, and independent task/run usage keys. The integrated runtime gate passed typecheck, lint, build and 249 compiled tests on 2026-10-18. T005 local-only fixtures (not shipped in the published repository) passed canonical JSON and static Python checks; pytest has not been executed because real execution remains gated at T024/T028. Other Phase 3 worker results require independent review and integrated checks before their task status changes.

## Local helper tests

The planning-workflow regressions cover required artifact types, unique sequential task IDs, invalid dependency graphs, normalized explicit ownership and directory overlap, dependency-ordered shared paths, nested contract inventories, malformed review rejection, and automated-only status. These checks do not certify independent reviews or authorize feature implementation.

The task-context, managed-session, and planning-workflow helpers require Node.js 20 or newer, use Node.js built-ins, and can be tested without installing packages:

```powershell
node --test tests/agents/agent-context.test.mjs tests/agents/agent-work.test.mjs tests/agents/planning-workflow.test.mjs
```

Test active-task handoff behavior, preview/apply archival, collision refusal, and archive recovery directly with:

```powershell
node --test tests/agents/active-task.test.mjs
```

Test worktree retirement eligibility and safe removal in disposable Git repositories with `node --test tests/agents/agent-worktree.test.mjs`. These checks cover preview-only operation, retained branches, unmerged commits, dirty/untracked/ignored data, resumed tasks, changed evidence, and locked or unknown worktrees. Skill evaluations additionally follow [the versioned evidence procedure](workflow.md#skill-evaluation-evidence).

For contributor coordination changes, run `node --test tests/agents/pr-workflow.test.mjs tests/agents/agent-context.test.mjs tests/agents/active-task.test.mjs`. These cover preflight reporting without publication, UC brief extraction without ledger writes, and archive-before-clear safety, alongside existing behavior. Completion regressions also cover active-task finish refusing unpublished work, worker handoff without contributor completion, session closure refusing active work, and PR completion refusing dirty/stale/unlinked/pending/failing revisions. Report partial evidence separately from complete regression results.

Run the complete contributor test suite with Node's test-runner discovery:

```powershell
node --test
```

## Context consistency check

After changing [the context contract](contract.json), `AGENTS.md`, `context/*.md`, the matrices, or referenced agent documentation, run the consistency check. It follows local inline links transitively into Markdown documents from the existing roots, visits cycles once, and enforces checkout containment for every checked link. It checks that required documents exist, declared fact sources resolve to one table row, every context Markdown page is linked from `context/README.md`, `AGENTS.md` links to that README, local inline Markdown file links resolve, and explicitly marked fact claims match their source rows. It ignores external URLs, heading-only links, and examples in fenced code blocks. It cannot detect conflicts in unmarked prose, so review related documents for semantic consistency.

Run:

```powershell
node scripts/ci/check-context.mjs
```

## Context updater tests

Test post-implementation context updates with `node --test tests/agents/update-context.test.mjs`. The CLI checks cover read-only preview, architecture and progress updates, newline preservation, stale or ambiguous edits, heading preservation, out-of-scope targets, batch rollback on invalid links, no-change validation, and updater lock retention. Follow [context maintenance](../docs/agents/context-maintenance.md) for the update-plan format and completion procedure.

## Runtime bootstrap gate

Phase 1 selects the tools recorded in [tech_stack.md](tech_stack.md). Run `pnpm install --frozen-lockfile` and `pnpm run validate:runtime` from the repository root. The shared runtime validator removes stale dist output before typecheck, lint, build and compiled runtime tests. Use `pnpm run check:dependency-install` for a frozen install with a new metadata cache and lockfile policy verification; it preserves the configured release-age policy. [Runtime checks](../.github/workflows/runtime-checks.yml) runs the bootstrap gates on Node.js 24 on Ubuntu and Windows. The runtime smoke test validates only dependency/build integration. The T003 contract suite additionally checks schema rejection and trusted current-state admission; after building, run `node --test dist/tests/runtime/contract/uc03.test.js`. Node.js 24 also discovers TypeScript source tests in `node --test`; relative source imports use `.ts`, and `rewriteRelativeImportExtensions` emits `.js` imports for the compiled suite. Keep source syntax erasable by Node type stripping; the source suite also runs directly with `node --test tests/runtime/contract/uc03.test.ts`. Its deterministic vectors do not demonstrate real provider dispatch, isolation or recovery. Continue to run `node --test` for contributor helpers. Runtime boundary changes also need evidence from the relevant [target verification matrices](../docs/progress-checker-matrices.md); bootstrap success does not establish UC-03 acceptance.

Run `node --test tests/runtime/uc01/contract.test.ts tests/runtime/uc01/ports.test.ts tests/runtime/uc01/fixtures.test.ts` (36 passed, exit 0). On integrated feature revision 2ad6e94, `npx --no-install tsc --noEmit` exited 0, and `npx --no-install eslint src/uc01/contracts.ts tests/runtime/support/uc01/fixtures.ts tests/runtime/support/uc01/ports.ts tests/runtime/uc01/contract.test.ts tests/runtime/uc01/fixtures.test.ts tests/runtime/uc01/ports.test.ts` exited 0. Regression vectors verify safety failures block acceptance, unobserved safety and unknown real metrics keep completeness incomplete, invalid trusted context remains an input error, rejected guard contexts do not consume task invocation quota, and C12's empty catalog supports an undetermined assessment. An independent PowerShell 7.6.5/.NET 10.0.11 producer matched all 33 public-case and 33 grading-case digests and the canonical Unicode/null vector. These checks cover local contracts, mocks, grading and fixtures only; they do not verify live provider quality, shared-runner compatibility, production adapters, or an assessment workflow.
