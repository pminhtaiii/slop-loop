# Contributor Workflow

This workflow governs contributors implementing an approved local Spec Kit feature. The feature's `spec.md`, `plan.md`, and `tasks.md` are the source of truth for that feature's scope. For an explicitly authorized helper, documentation, or maintenance task without an approved feature, follow the user's stated scope and do not invent Spec Kit task IDs or planning artifacts. This describes repository work, not the slop-loop product runtime; see [architecture.md](architecture.md) for the target runtime flow.

## Input readiness

Before implementation, confirm the selected feature has `spec.md`, `plan.md`, and `tasks.md`, and resolve inconsistencies that block safe execution. Do not regenerate planning artifacts unless the user asks or a concrete gap requires it. `tasks.md` is the only task-status ledger.

## Workflow pipeline

```text
build-spec (task graph and TDD) → speckit-converge → code-review → PR/CI (separately authorized)
```

`/build-spec` owns implementation, convergence, and code review for the integrated revision. PR creation, remote issue changes, CI publishing, and deployment require separate authorization.

## Agent coordination

Keep worker changes scoped to assigned task IDs and owned files. Implementers do not change task checkboxes; only the coordinator marks a task complete after integration and applicable checks pass. Recompute dependencies and the ready task frontier after each accepted integration.

Use the task helper to derive context from the canonical ledger:

```powershell
node scripts/ci/agent-context.mjs handoff --tasks specs/<feature>/tasks.md [--root <checkout>]
node scripts/ci/agent-context.mjs task --tasks specs/<feature>/tasks.md --task T001 --plan specs/<feature>/plan.md [--root <checkout>]
```

These commands report task context only; they never change task status.

Create a managed session directory before coordinated work:

```powershell
node scripts/ci/agent-work.mjs start --session <session-id> [--date YYYY-MM-DD] [--root <checkout>]
node scripts/ci/agent-work.mjs list [--root <checkout>]
node scripts/ci/agent-work.mjs finish --session <date>/<session-id> [--root <checkout>]
```

Keep drafts, worker notes, raw logs, and review snapshots in `.agent-work/<date>/<session-id>/`. Keep approved specs, task ledgers, and concise verification records at their canonical paths. Leave a session active while work may resume. Cleanup previews by default; only explicitly authorized human action may apply cleanup.

### Task briefs and handoffs

Give each worker one or two ready task IDs (or name the approved maintenance goal), the relevant plan section, owned paths, required outputs, dependencies, observable acceptance criteria, and focused verification commands. Share only the contract and context needed for that assignment.

Record a concise handoff with checkout, branch/revision, ledger and next candidate, authorized next step, blockers and verification status, path ownership, worker states, and evidence locations. Refresh worker state before acting on it; a sent message alone does not mean a worker resumed.

### Review snapshots

Pin the review to a base/target revision or create a file snapshot:

```powershell
node scripts/ci/agent-context.mjs snapshot --files <repo-relative-path>... [--root <checkout>]
node scripts/ci/agent-context.mjs verify --snapshot <snapshot.json> [--root <checkout>]
```

Verify the snapshot against the same checkout before relying on review findings. Recheck findings against current source before acting.

## Step 1: Implement with TDD (`/build-spec`)

Implement each ready task in a test-first vertical slice, following [testing.md](testing.md) and the existing-test protections in [tools_permissions.md](tools_permissions.md). Resolve unrelated harness failures before claiming a behavioral RED. Report actual commands and exit statuses, and leave failed or unintegrated tasks unchecked.

Integrate one worker at a time. Confirm its base is current, changes stay within owned paths, and acceptance checks pass on the integration branch before recording task completion.

## Step 2: Converge (`/speckit-converge`)

Assess the integrated implementation against the approved spec, plan, and task ledger. If actionable gaps are added as tasks, implement them through the same dependency and verification process, then rerun convergence until no actionable gaps remain.

## Step 3: Code review (`/code-review`)

Review the pinned integrated revision against [backend code standards](code_standard.md), other applicable repository conventions, and the originating specification. Resolve blocking findings within the authorized task scope and rerun affected checks, convergence, and review for the changed revision.

## Step 4: PR and CI (`/pr-feedback-loop`)

This stage is separate from local feature completion and requires explicit user authorization. Run the repository's applicable local gates before publishing changes; report remote CI outcomes and any unrun gates accurately.

