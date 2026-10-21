# Contributor Workflow

This workflow governs contributors implementing an approved local Spec Kit feature. The feature's `spec.md`, `plan.md`, and `tasks.md` are the source of truth for that feature's scope. For an explicitly authorized helper, documentation, or maintenance task without an approved feature, follow the user's stated scope and do not invent Spec Kit task IDs or planning artifacts. This describes repository work, not the slop-loop product runtime; see [architecture.md](architecture.md) for the target runtime flow.

## Input readiness

Before starting edits in an assigned feature checkout, run `node scripts/agents/pr-workflow.mjs preflight` and inspect its status, freshness, branch name, and dirty paths. Follow [the PR workflow](../docs/agents/pr-workflow.md#branch-and-size) for blocked reports; preserve existing work. For a selected use case, run `node scripts/agents/agent-context.mjs assignment --uc UC-03` with its canonical ID, then confirm the reported owner, prerequisites, and approved artifacts. `NEEDS_PLANNING` and `REVIEW_REQUIRED` are not implementation authorization. Before implementation, confirm the selected feature has `spec.md`, `plan.md`, and `tasks.md`, and resolve inconsistencies that block safe execution. Follow the [planning workflow](planning.md) to author or update specs, plans, and task breakdowns through its deterministic P0/P1 review loop before implementation authorization. Do not regenerate planning artifacts unless the user asks or a concrete gap requires it. `tasks.md` is the only task-status ledger.

## Active-task handoff

Before editing, establish the authorized scope from the feature `tasks.md` dependency graph or the user-approved maintenance brief, then register the coordinator's assignment in shared state. `agent-work.mjs start --session <session-id> --date <YYYY-MM-DD> --root <checkout>` creates or reactivates the session marker. After registering an assignment, use `active-task.mjs render --output .agent-work/<date>/<session-id>/progress.md --root <checkout>` to initialize or refresh only that session's progress view. Session startup and rendering preserve shared assignments; rendering writes only the selected progress file. All linked worktrees share the primary checkout's ignored `.agent-work/state/active-tasks.json`. [`active_task.md`](active_task.md) is the static navigation and read-command page; session progress lives in the selected `.agent-work/<date>/<session-id>/`. `tasks.md` remains the only feature task-status ledger, separate from product runtime state in [state_and_memory.md](state_and_memory.md). Use the primary checkout's helper with `--root <worker-checkout>` when a worker has an older helper version.

Use a distinct owner ID per session or worker and a task ID for each assignment. Before dispatching any member of a ready batch, register the coordinator and every worker in that batch in shared state with explicit session IDs; each worker declares its exact owned paths. Keep paths disjoint within a batch, and record a short dependency or path conflict reason when work must wait. Register only current assignments; later or blocked feature tasks stay in `tasks.md` and do not appear in the session progress view. Assignment, task status, and dependency readiness report progress; they do not grant authorization. Worker assignments use repeated `--owned-path <repo-relative-path>` options. Legacy records without a session remain unknown and are handled conservatively:

```powershell
node scripts/agents/active-task.mjs start --owner <owner-id> --task <task-id> --session <date/session-id> --summary "<assignment>" --next "<next action>"
node scripts/agents/active-task.mjs start --owner <worker-id> --task <task-id> --role worker --session <date/session-id> --owned-path <repo-relative-path> --summary "<assignment>" --next "<next action>"
node scripts/agents/active-task.mjs update --owner <owner-id> --task <task-id> --next "<next action>" --verification "<verification evidence>"
node scripts/agents/active-task.mjs update --owner <owner-id> --task <task-id> --status blocked --next "<blocker or resume action>"
node scripts/agents/active-task.mjs handoff --owner <worker-id> --task <task-id> --result "<worker result for integration>"
node scripts/agents/active-task.mjs verify-handoff --owner <worker-id> --task <task-id>
node scripts/agents/active-task.mjs reassign --owner <old-id> --task <task-id> --new-owner <new-id> --session <date/session-id> --reason "<recovery reason>"
node scripts/agents/active-task.mjs retire-reassigned --owner <id> --task <id> --reason "<recorded transfer confirmed>"
node scripts/agents/recovery-report.mjs [--owner <id>] [--task <id>] [--root <checkout>]
node scripts/agents/active-task.mjs finish --owner <owner-id> --task <task-id> --result "<completed work and evidence>"
New-Item -ItemType Directory -Force docs/verification | Out-Null
node scripts/agents/active-task.mjs archive --owner <owner-id> --task <task-id> --output docs/verification/<unique-name>.json
node scripts/agents/active-task.mjs archive --owner <owner-id> --task <task-id> --output docs/verification/<unique-name>.json --apply
node scripts/agents/active-task.mjs list --compact [--owner <owner-id>] [--task <task-id>] [--status <status>]
node scripts/agents/active-task.mjs render
```

Update the next action at meaningful progress and pause points; include verification when it changes. Mark blocked or interrupted work `blocked` and keep its entry. Set it back to `active` when resuming. Register workers with `start --role worker --session <date/session-id>` and declare each owned file with repeated `--owned-path <repo-relative-path>` options; the default role is coordinator and cannot use worker handoff. Worker `handoff` captures separate Git-index and worktree hashes for those exact paths. Legacy handoffs without declared paths remain unverified, with no paths or hashes inferred. Before integration or publication, the coordinator runs `verify-handoff`; changed owned content, checkout, or branch fails verification and requires a fresh handoff. Workers include owner/task IDs; their state is `handed-off`, not contributor completion. Coordinators publish the current clean revision, link the PR in the app, save/import the app list receipt with `pr-workflow.mjs record-app-state --receipt <file>`, then run `finish`. Finish checks the live PR head, retained local gates and app link, all four passing CI jobs and no GitHub merge blocker before marking completed. Unresolved review comments remain visible and advisory for the human merge decision. With `publication-targets.json` configured, [paired publication](../docs/agents/paired-publication.md) also requires the submission PR to match the source snapshot and the app receipt to contain both PR links. Public current-head CI remains the contributor review gate; submission CI is reported separately when inspected. Pending CI remains active under the app watcher; failed or unpublished work stays active/blocked. Contributor completion and final reports require this gate; human merge remains separate. After integrating the result and recording durable evidence and task status, the coordinator runs `archive` in preview mode, reviews the selected completed, handed-off, or reassigned entry and unique output path, then repeats with `--apply`. The helper saves and verifies the record before clearing only that matching terminal assignment. Per the user's local-only evidence preference, keep `docs/verification/` and its archive records ignored; do not force-add them. Create that directory before archiving on a fresh checkout. Track task status in tasks.md and context updates as usual. Tracked documentation may link to immutable historical GitHub evidence or label current local paths as code; it must not require ignored evidence files to exist for CI. Retain active/blocked entries. If interrupted after archive creation, rerun the same command and output; a different or changed entry is refused. Handoff archival is separate from worktree retirement and never deletes a worktree or its evidence. Coordinators follow the same lifecycle for their own entry and leave other owners' entries untouched. Only completed, handed-off, or reassigned entries can be cleared; clearing removes the one matching managed entry while preserving the file's permanent instructions and data markers. The helper does not commit or push.

Use `active-task.mjs list --compact` to inspect current owner/task/status/next summaries; filter with `--owner`, `--task`, or `--status`. After an interruption, `recovery-report.mjs` joins active assignments with live Git worktree state, checkpoints, staged/modified/untracked paths, and any existing ownership receipt. It reports agent status as `unknown` because local records do not prove that an agent is running or stopped. Use `active-task.mjs reassign` only for an explicit recovery decision; it marks the predecessor `reassigned`, retains its assignment and evidence, and creates a linked active successor without completing work or reclaiming locks. For a legacy `blocked` predecessor that already has a recorded transfer, use `retire-reassigned --reason` to record the explicit migration; this preserves transfer history and does not synthesize a completion result. Plain `list` keeps its full JSON output for existing automation. Use `agent-work.mjs list` for managed session summaries and `agent-context.mjs resume` only when task candidates, dependencies, or detailed evidence pointers are needed. `render` without `--output` prints a compact list and writes no files, including `context/active_task.md`. Keep rendered assignments out of unrelated PRs and retain durable handoff evidence locally through the archive workflow. Workers do not write another checkout's Markdown file. Legacy migration is explicit: `active-task.mjs migrate-legacy` saves exact snapshots of marker-based views before import, retains canonical rows on collisions, and reports owner/task conflicts for reconciliation. Shared writes use one lock across worktrees; retry a busy lock after the writer finishes. Use `--root <checkout>` to select the invoking view and `--help` for syntax.

## Workflow pipeline

```text
planning loop (plan, tasks, P0/P1 audit) -> build-spec (task graph and TDD) -> speckit-converge -> code-review (unless the user explicitly opts out) -> context refresh -> contributor PR/CI
```

`/build-spec` owns implementation and convergence; post-implementation code review follows the user's instruction. The contributor PR pilot has standing limited authorization for coordinator commits, feature-branch pushes, and draft PR creation/updates; workers have no remote authority. Follow the [PR and CI workflow](../docs/agents/pr-workflow.md). The pilot uses `development` as the base for both public and private PRs. Follow the [branch and PR conventions](../docs/agents/pr-conventions.md) before creating a new work branch or preparing PR metadata; new names omit numeric prefixes, remain unique across both repositories and historical PRs, and prefix their paired PR titles exactly. A human decides each merge; coordinator execution requires an explicit instruction for that PR and passing required checks. Remote issue changes and deployment remain separately authorized.

## Agent coordination

The coordinator does one bounded preflight, then dispatches one concise brief for each authorized, ready assignment. Workers keep changes within registered task IDs and owned paths and update shared state at meaningful checkpoints. The coordinator waits for a concrete blocker or final handoff, refreshes assignment state, integrates one result at a time, and recomputes the ready frontier. Keep routine progress in the shared assignment rather than chat.

Use the task helper to derive context from the canonical ledger:

```powershell
node scripts/agents/agent-context.mjs handoff --tasks specs/<feature>/tasks.md [--root <checkout>]
node scripts/agents/agent-context.mjs task --tasks specs/<feature>/tasks.md --task T001 --plan specs/<feature>/plan.md [--root <checkout>]
```

These commands report task context only; they never change task status.

**Resume from compact evidence:**

Use the compact assignment list first; run the detailed ledger report when task context is needed:

```powershell
node scripts/agents/agent-context.mjs resume [--tasks <tasks.md>] [--authorization <repo-relative-path> ...] [--root <checkout>]
```

Use `active-task.mjs list --compact` first for owner/task/status/next; filter with `--owner`, `--task`, or `--status`. After interruption, inspect `recovery-report.mjs` before treating an active record as live or stale; the report marks agent liveness `unknown` without host-level evidence. Run `agent-context.mjs resume` only when the task frontier, dependencies, authorization pointers, or detailed verification context is needed. The resume report is read-only; its paths are pointers, not authorization. Check current user direction and the governing decision record before acting, then read only sources needed for the next action. If a read fails, inspect the error and retry once with a bounded supported read of that named source; if it fails again, record the blocker and stop.

Create a managed session directory before coordinated work:

```powershell
node scripts/agents/agent-work.mjs start --session <session-id> [--date YYYY-MM-DD] [--root <checkout>]
node scripts/agents/agent-work.mjs list [--root <checkout>]
node scripts/agents/agent-work.mjs finish --session <date>/<session-id> [--root <checkout>]
```

Keep drafts, worker notes, raw logs, and review snapshots in `.agent-work/<date>/<session-id>/`. Before creating task worktrees or cleaning a run, follow [the dump workspace guide](../docs/agents/workspace.md): worktrees live separately under `.agent-work/worktrees/`, with machine-readable ownership receipts. Keep approved specs, task ledgers, and concise verification records at their canonical paths. Leave a session active while work may resume. Session finish blocks active or blocked assignments whose explicit session matches; reassigned entries are terminal and no longer block the source session. Legacy assignments with unknown sessions block conservatively when their checkout resolves to the active checkout or is unknown; on Windows this includes short-name aliases. Worktree retirement remains checkout-wide: any active or blocked assignment for that checkout blocks deletion, even when it belongs to another session; reassigned predecessors do not block retirement. Cleanup previews by default; only explicitly authorized human action may apply cleanup.

### Task briefs and handoffs

A concise worker brief names the intended outcome, owned paths, acceptance checks, exclusions, and where to record completion evidence; include registered owner/task IDs, checkout/branch, and links to the relevant plan or contract. Avoid copying repository rules already available by pointer. Workers record progress in active-task state and message only for a concrete blocker or final handoff. The final handoff lists the revision, changed paths, focused commands and results, remaining gaps, and evidence pointers. Workers run focused acceptance checks; the coordinator/publisher integrates one result at a time and runs the full required local gates once on the integrated tree.

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

Honor an explicit user request to skip post-implementation review; do not dispatch review agents for that task. This choice does not waive required task tests, acceptance checks, context refresh, or contributor gates. Follow [testing guidance](testing.md) when reporting verification.

When the user has not opted out, review the pinned integrated revision against [backend code standards](code_standard.md), other applicable repository conventions, and the originating specification. Resolve blocking findings within the authorized task scope and rerun affected checks, convergence, and review for the changed revision.

## Context refresh

After implementation and verification, update affected context documents from inspected code and test evidence, preserving their existing format. Follow [context maintenance](../docs/agents/context-maintenance.md) for the update-plan format, preview/apply commands, and failure handling. Review semantic consistency and report validation before finishing the active task.

## Step 4: PR and CI (`/pr-feedback-loop`)

While waiting for a resolving PR review, assess each scoped paired ticket against all acceptance criteria, prepare evidence and preview [paired ticket completion](../docs/agents/paired-publication.md#complete-paired-tickets). Apply only after both resolving PRs merge, their source snapshots match and the public exact-head CI passes. CodeRabbit approval is advisory. Keep partial-close accounting and retry the same stable key; never infer completion from labels, age or CI alone. This issue lifecycle is separate from contributor handoff and human merge authority.

After implementation, refresh affected context before publishing. The approved contributor PR pilot authorizes the coordinator to run the [PR workflow](../docs/agents/pr-workflow.md) for draft creation and updates on `development`; workers do not write remotely. Only `READY_FOR_HUMAN` permits the `ready` command. A human decides each merge; the coordinator may execute it only when explicitly instructed for that PR, after required checks pass, following the linked workflow. Report missing or stale evidence as waiting or blocked, never as ready.

