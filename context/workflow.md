# Contributor Workflow

This workflow governs contributors implementing an approved local Spec Kit feature. The feature's `spec.md`, `plan.md`, and `tasks.md` are the source of truth for that feature's scope. For an explicitly authorized helper, documentation, or maintenance task without an approved feature, follow the user's stated scope and do not invent Spec Kit task IDs or planning artifacts. This describes repository work, not the slop-loop product runtime; see [architecture.md](architecture.md) for the target runtime flow.

## Input readiness

Before starting edits in an assigned feature checkout, run `node scripts/agents/pr-workflow.mjs preflight` and inspect its status, freshness, branch name, and dirty paths. Follow [the PR workflow](../docs/agents/pr-workflow.md#branch-and-size) for blocked reports; preserve existing work. For a selected use case, run `node scripts/agents/agent-context.mjs assignment --uc UC-03` with its canonical ID, then confirm the reported owner, prerequisites, and approved artifacts. `NEEDS_PLANNING` and `REVIEW_REQUIRED` are not implementation authorization. Before implementation, confirm the selected feature has `spec.md`, `plan.md`, and `tasks.md`, and resolve inconsistencies that block safe execution. Do not regenerate planning artifacts unless the user asks or a concrete gap requires it. `tasks.md` is the only task-status ledger.

## Active-task handoff

Before a coordinator or worker edits its assigned scope, register a unique owner/task entry. All linked worktrees share the primary checkout's ignored `.agent-work/state/active-tasks.json`; [active_task.md](active_task.md) is a readable checkout-local view. `tasks.md` remains the only feature task-status ledger, separate from product runtime state in [state_and_memory.md](state_and_memory.md). Use the primary checkout's helper with `--root <worker-checkout>` when a worker has an older helper version.

Use a distinct owner ID for each session or worker and a task ID that identifies its assignment:

```powershell
node scripts/agents/active-task.mjs start --owner <owner-id> --task <task-id> --summary "<assignment>" --next "<next action>"
node scripts/agents/active-task.mjs update --owner <owner-id> --task <task-id> --next "<next action>" --verification "<verification evidence>"
node scripts/agents/active-task.mjs update --owner <owner-id> --task <task-id> --status blocked --next "<blocker or resume action>"
node scripts/agents/active-task.mjs finish --owner <owner-id> --task <task-id> --result "<completed work and evidence>"
node scripts/agents/active-task.mjs archive --owner <owner-id> --task <task-id> --output docs/verification/<unique-name>.json
node scripts/agents/active-task.mjs archive --owner <owner-id> --task <task-id> --output docs/verification/<unique-name>.json --apply
node scripts/agents/active-task.mjs list
node scripts/agents/active-task.mjs render
```

Update the next action at meaningful progress and pause points; include verification when it changes. Mark blocked or interrupted work `blocked` and keep its entry. Set it back to `active` when resuming. A worker must finish its entry before reporting and include its owner and task IDs in the report. `finish` retains the completed handoff for coordinator review. After integrating the result and recording durable evidence and task status, the coordinator runs `archive` in preview mode, reviews the selected completed entry and unique output path, then repeats with `--apply`. The helper saves and verifies the entry before clearing only that matching completed handoff. Commit the returned archive with the verification evidence; retain active/blocked entries. If interrupted after archive creation, rerun the same command and output; a different or changed entry is refused. Handoff archival is separate from worktree retirement and never deletes a worktree or its evidence. Coordinators follow the same lifecycle for their own entry and leave other owners' entries untouched. Only completed entries can be cleared; clearing removes the one matching managed entry while preserving the file's permanent instructions and data markers. The helper does not commit or push.

Routine mutations in every checkout update only the ignored shared store, keeping tracked Markdown clean. Use `list` for current assignments; only explicit `render` refreshes the selected checkout's optional Markdown view. Treat rendered assignments as local snapshots and keep them out of unrelated PRs; commit durable handoff evidence through the archive workflow. Workers do not write another checkout's Markdown file. On first use, the helper imports existing handoffs from registered checkouts, rejecting conflicting legacy entries for reconciliation. Shared writes use one lock across worktrees; a busy lock requires retry after the writer finishes, not automatic reclamation. Use `--root <checkout>` to select the invoking view and `--help` for command syntax.

## Workflow pipeline

```text
build-spec (task graph and TDD) → speckit-converge → code-review → context refresh → contributor PR/CI
```

`/build-spec` owns implementation, convergence, and code review for the integrated revision. The contributor PR pilot has standing limited authorization for coordinator commits, feature-branch pushes, and draft PR creation/updates; workers have no remote authority. Follow the [PR and CI workflow](../docs/agents/pr-workflow.md). The pilot uses `development` as its base. A human decides each merge; coordinator execution requires an explicit instruction for that PR and passing required checks. Remote issue changes and deployment remain separately authorized.

## Agent coordination

Keep worker changes scoped to assigned task IDs and owned files. Implementers do not change task checkboxes; only the coordinator marks a task complete after integration and applicable checks pass. Recompute dependencies and the ready task frontier after each accepted integration.

Use the task helper to derive context from the canonical ledger:

```powershell
node scripts/agents/agent-context.mjs handoff --tasks specs/<feature>/tasks.md [--root <checkout>]
node scripts/agents/agent-context.mjs task --tasks specs/<feature>/tasks.md --task T001 --plan specs/<feature>/plan.md [--root <checkout>]
```

These commands report task context only; they never change task status.

Create a managed session directory before coordinated work:

```powershell
node scripts/agents/agent-work.mjs start --session <session-id> [--date YYYY-MM-DD] [--root <checkout>]
node scripts/agents/agent-work.mjs list [--root <checkout>]
node scripts/agents/agent-work.mjs finish --session <date>/<session-id> [--root <checkout>]
```

Keep drafts, worker notes, raw logs, and review snapshots in `.agent-work/<date>/<session-id>/`. Before creating task worktrees or cleaning a run, follow [the dump workspace guide](../docs/agents/workspace.md): worktrees live separately under `.agent-work/worktrees/`, with machine-readable ownership receipts. Keep approved specs, task ledgers, and concise verification records at their canonical paths. Leave a session active while work may resume. Cleanup previews by default; only explicitly authorized human action may apply cleanup.

### Task briefs and handoffs

Give each worker one or two ready task IDs (or name the approved maintenance goal), the relevant plan section, owned paths, required outputs, dependencies, observable acceptance criteria, and focused verification commands. Share only the contract and context needed for that assignment.

Record a concise handoff with checkout, branch/revision, ledger and next candidate, authorized next step, blockers and verification status, path ownership, worker states, and evidence locations. Refresh worker state before acting on it; a sent message alone does not mean a worker resumed.

### Review snapshots

Pin the review to a base/target revision or create a file snapshot:

```powershell
node scripts/agents/agent-context.mjs snapshot --files <repo-relative-path>... [--root <checkout>]
node scripts/agents/agent-context.mjs verify --snapshot <snapshot.json> [--root <checkout>]
```

Verify the snapshot against the same checkout before relying on review findings. Recheck findings against current source before acting.

### Skill evaluation evidence

Before each baseline or follow-up evaluation, use `agent-context.mjs snapshot --files ... --root <checkout>` to save that phase's exact source revision and hashes in its own session subfolder. Include the skill, loaded references, and helper source files that can affect the scenario; a no-skill baseline records the source environment and explicitly records that the skill was absent. Store the request, output, checks/exit statuses, and a relative pointer to that snapshot with the result. Verify the snapshot before dispatch and again after the evaluation; if verification fails, mark the result invalid and repeat against a new snapshot. Keep baseline and follow-up artifacts separate and keep each evaluated checkout unchanged while its agent runs. Historical evaluations without snapshots remain labelled unversioned, rather than assigning them inferred hashes later.

## Step 1: Implement with TDD (`/build-spec`)

Implement each ready task in a test-first vertical slice, following [testing.md](testing.md) and the existing-test protections in [tools_permissions.md](tools_permissions.md). Resolve unrelated harness failures before claiming a behavioral RED. Report actual commands and exit statuses, and leave failed or unintegrated tasks unchecked.

Integrate one worker at a time. Confirm its base is current, changes stay within owned paths, and acceptance checks pass on the integration branch before recording task completion.

## Step 2: Converge (`/speckit-converge`)

Assess the integrated implementation against the approved spec, plan, and task ledger. If actionable gaps are added as tasks, implement them through the same dependency and verification process, then rerun convergence until no actionable gaps remain.

## Step 3: Code review (`/code-review`)

Review the pinned integrated revision against [backend code standards](code_standard.md), other applicable repository conventions, and the originating specification. Resolve blocking findings within the authorized task scope and rerun affected checks, convergence, and review for the changed revision.

## Context refresh

After implementation and verification, update affected context documents from inspected code and test evidence, preserving their existing format. Follow [context maintenance](../docs/agents/context-maintenance.md) for the update-plan format, preview/apply commands, and failure handling. Review semantic consistency and report validation before finishing the active task.

## Step 4: PR and CI (`/pr-feedback-loop`)

After implementation, refresh affected context before publishing. The approved contributor PR pilot authorizes the coordinator to run the [PR workflow](../docs/agents/pr-workflow.md) for draft creation and updates on `development`; workers do not write remotely. Only `READY_FOR_HUMAN` permits the `ready` command. A human decides each merge; the coordinator may execute it only when explicitly instructed for that PR, after required checks pass, following the linked workflow. Report missing or stale evidence as waiting or blocked, never as ready.

