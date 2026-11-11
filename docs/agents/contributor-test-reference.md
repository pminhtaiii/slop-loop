# Contributor helper test reference

## Local helper tests

Session-retro contributor regressions exercise public CLI boundaries in `tests/agents/active-task-factory.test.mjs`, `contributor-prepare.test.mjs`, `focused-check.test.mjs`, `publication-policy.test.mjs`, `publication-job.test.mjs`, `pr-workflow.test.mjs`, `pr-workflow-push-only.test.mjs`, `whitespace-hook.test.mjs`, and `tests/ci/check-context.test.mjs`. Capture focused output on its first run through the [receipt runner](orchestration-tools.md#focused-verification-receipts); reuse requires unchanged command, candidate, declared inputs, runtime identity and retained output. These receipts do not substitute for independent CI or required full-mode publication gates. Public lifecycle fixture results establish local contributor behavior, not product-runtime acceptance.

The planning-workflow regressions cover required artifact types, unique sequential task IDs, invalid dependency graphs, normalized explicit ownership and directory overlap, dependency-ordered shared paths, nested contract inventories, malformed review rejection, and automated-only status. These checks do not certify independent reviews or authorize feature implementation.

The task-context, managed-session, and planning-workflow helpers require Node.js 20 or newer and use Node.js built-ins, so they can be tested without installing packages. Resume regressions cover status-column preservation, rename pairing, canonical checkout aliases and missing checkout records; task context excludes sibling-task continuation bullets; direct invocation follows path aliases while imports remain inert:

```powershell
node --test tests/agents/agent-context.test.mjs tests/agents/agent-work.test.mjs tests/agents/planning-workflow.test.mjs
```

Test active-task handoff behavior, explicit reassignment to a terminal status, legacy recorded-transfer migration, preview/apply archival, collision refusal, and archive recovery directly with:

```powershell
node --test tests/agents/active-task.test.mjs tests/agents/active-task-reassignment.test.mjs
```

Test worktree retirement eligibility and safe removal in disposable Git repositories with `node --test tests/agents/agent-worktree.test.mjs`. These checks cover preview-only operation, retained branches, unmerged commits, dirty/untracked/ignored data, resumed tasks, changed evidence, locked or unknown worktrees, and retirement after the successor work is complete or handed off; active or blocked successors remain blockers while reassigned predecessors do not. Skill evaluations additionally follow [the versioned evidence procedure](../../context/workflow.md#skill-evaluation-evidence).

The publication contributor gate covers preflight reporting without publication, UC brief extraction without ledger writes, archive-before-clear safety, and completion refusals for unpublished, dirty, stale, unlinked, pending, or failing revisions.

## Context consistency check

After changing [the context contract](../../context/contract.json), `AGENTS.md`, `context/*.md`, the matrices, or referenced agent documentation, run the consistency check. It follows local inline links transitively into Markdown documents from the existing roots, visits cycles once, and enforces checkout containment for every checked link. It checks that required documents exist, declared fact sources resolve to one table row, every context Markdown page is linked from `context/README.md`, `AGENTS.md` links to that README, local inline Markdown file links resolve, and explicitly marked fact claims match their source rows. It also checks authorizationReferences: every configured summary links to its designated source document, and each declared skill stage links to that skill inside its stage section. These pointer checks do not interpret decision contents or infer permission from task progress. It ignores external URLs, heading-only links, and examples in fenced code blocks or HTML comments. It cannot detect conflicts in unmarked prose, so review related documents for semantic consistency.

Run:

```powershell
node scripts/ci/check-context.mjs
```

## Context updater tests

Test post-implementation context updates with `node --test tests/agents/update-context.test.mjs`. The CLI checks cover read-only preview, architecture and progress updates, newline preservation, stale or ambiguous edits, heading preservation, out-of-scope targets, batch rollback on invalid links, no-change validation, and updater lock retention. Follow [context maintenance](context-maintenance.md) for update plans and post-write progress-format checks.
