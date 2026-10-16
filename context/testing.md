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

Before a draft PR is created or updated, publish runs `node scripts/ci/check-tracked-files.mjs`, `node scripts/ci/check-context.mjs`, `node scripts/ci/check-runtime.mjs`, and `node --test`. The tracked-file gate rejects installed node_modules directories at any depth and root docs/verification records, including force-added ignored files; local untracked artifacts and tracked lockfiles are permitted. Runtime validation cleans dist and runs typecheck, lint, build and compiled smoke tests, matching runtime CI. Dependency-input changes since the last published head (or development for a first publication) additionally require `node scripts/ci/check-dependency-install.mjs`: a frozen install with fresh metadata and explicit supply-chain policy verification. Remote readiness separately requires all four current-head contributor/runtime Ubuntu and Windows jobs and no unresolved review threads or GitHub merge blocker. CodeRabbit approval is advisory and optional. See the [PR workflow](../docs/agents/pr-workflow.md) for status and repair behavior. These gates verify repository helpers, context consistency and runtime bootstrap integration; they do not verify planned product-runtime capabilities.

## Local helper tests

The task-context and managed-session helpers require Node.js 20 or newer, use Node.js built-ins, and can be tested without installing packages:

```powershell
node --test tests/agents/agent-context.test.mjs tests/agents/agent-work.test.mjs
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

Phase 1 selects the tools recorded in [tech_stack.md](tech_stack.md). Run `pnpm install --frozen-lockfile` and `pnpm run validate:runtime` from the repository root. The shared runtime validator removes stale dist output before typecheck, lint, build and compiled runtime tests. Use `pnpm run check:dependency-install` for a frozen install with a new metadata cache and lockfile policy verification; it preserves the configured release-age policy. [Runtime checks](../.github/workflows/runtime-checks.yml) runs the bootstrap gates on Node.js 24 on Ubuntu and Windows. The runtime smoke test validates only dependency/build integration. The T003 contract suite additionally checks schema rejection and trusted current-state admission; after building, run `node --test dist/tests/runtime/contract/uc03.test.js`. Its deterministic vectors do not demonstrate real provider dispatch, isolation or recovery. Continue to run `node --test` for contributor helpers. Runtime boundary changes also need evidence from the relevant [target verification matrices](../docs/progress-checker-matrices.md); bootstrap success does not establish UC-03 acceptance.
