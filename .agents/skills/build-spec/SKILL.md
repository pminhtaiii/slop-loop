---
name: build-spec
description: "Implement and complete an approved local Spec Kit feature from its spec.md, plan.md, and tasks.md. Use for end-to-end feature work driven by the local task graph."
metadata:
  short-description: Build local spec tasks with worker agents
---

# Build a local spec

Use this skill when the user asks to implement an existing local Spec Kit feature. The source of truth is the feature folder's `spec.md`, `plan.md`, and `tasks.md`. Build the whole authorized feature through implementation, convergence, and final code review on its existing feature branch.

This workflow is local. Do not read, create, update, or close GitHub issues or other tracker tickets. The user supplies the approved design as `spec.md`, `plan.md`, and `tasks.md`; execute that design without automatically rerunning planning, brainstorming, plan review, task generation, or a design-approval ceremony. If a required artifact is missing or materially inconsistent, report the concrete gap and ask a targeted clarification. Planning skills remain available when explicitly requested or when that specific gap calls for targeted work. Keep `tasks.md` as the only task-status ledger; it does not expand authorized scope or bypass the implementation gates in `context/workflow.md`.

## Resolve the feature and gates

1. Consider `$ARGUMENTS` and the user's current instruction. Preserve their scope and any explicit checklist override.
2. If `.specify/extensions.yml` exists, read [references/extension-hooks.md](references/extension-hooks.md) and identify applicable hooks. Defer hook execution until the feature, checklist, and governance gates below pass.
3. From the repository root, run:

   ```powershell
   .\.specify\scripts\powershell\check-prerequisites.ps1 -Json -RequireTasks -IncludeTasks
   ```

   Parse `FEATURE_DIR` and `AVAILABLE_DOCS`. Resolve `FEATURE_DIR` to an absolute path for direct reads and worker briefs. Confirm that `spec.md`, `plan.md`, and `tasks.md` exist. If the user explicitly targets a different feature folder, use the supported `SPECIFY_FEATURE_DIRECTORY` environment override with that absolute path for the prerequisite command; do not invent a command-line flag. The script records the selected folder in `.specify/feature.json`.
4. If `FEATURE_DIR/checklists/` exists, count `- [ ]`, `- [X]`, and `- [x]` lines in every checklist and show a status table. If any item is incomplete, stop before dispatch unless the user has already explicitly said to proceed. Otherwise ask whether to proceed, and wait. A refusal or no answer leaves implementation paused.
5. Read the complete `spec.md`, `plan.md`, and `tasks.md`. If `.specify/memory/constitution.md` exists, read it for governance constraints. Read optional documents listed in `AVAILABLE_DOCS` when a selected task depends on them: `data-model.md`, `contracts/`, `research.md`, and `quickstart.md`. Keep task briefs limited to their relevant sections and contracts. Check `context/active-feature.md` for its feature path; if it names `FEATURE_DIR`, read it for immediate checkpoints and scope constraints, plus only the verification record it points to for current evidence and resume context. Keep `tasks.md` as the sole task-status ledger.
6. Read `AGENTS.md` and apply its implementer guardrails. For code tasks, use the repository's `tdd` skill and the applicable commands in `context/testing.md`. Do not add broad setup or ignore-file changes unless a canonical task requires them. After the prerequisites, checklist, and governance gates pass, execute mandatory `before_implement` hooks and wait for their results before creating task worktrees or dispatching workers.

## Build the task graph

Read task IDs, phase gates, dependencies, file ownership, and generated outputs from the canonical ledger. A task enters the ready frontier when its prerequisites and phase gates have passed. Run `[P]` tasks together only when their source and generated outputs are disjoint; serialize tasks that share ownership. Reserve source and generated-output paths owned by a dispatched task until the merger accepts that task; worker completion alone does not release those paths. Give each implementer one or two original task IDs. A ready RED test task may be paired with its immediate implementation task while their internal dependency is open, only after all external dependencies and phase gates pass; the worker satisfies that edge in RED-then-GREEN order, and both IDs stay unchecked until the integrated pair passes. Reserve paths produced by both tasks through accepted integration, never dispatch a blocked task alone, and report a plan ambiguity if resolving gates would require more than two IDs in one brief. Recompute the frontier after each accepted merge.

Confirm the authorized feature branch and its tip. Reuse that branch as the integration branch. If the intended branch cannot be identified from the user's instruction and checkout, finish read-only analysis and ask for direction before switching branches or creating an integration branch.

Create one task worktree and branch from the current integration tip for each disjoint ready task. Verify each base before work starts. Preserve existing user changes and unowned files. If a worktree is stale, safely recreate it from the latest tip or merge the latest integration tip into it; do not discard or reset files. Implementers commit only assigned source and generated artifacts, then merge the latest integration tip into their task branch before handing it to the merger.

Reserve tool capacity for the coordinator and one merger agent. Run no more implementers than the remaining available slots. Use an implementer subagent for each task or tightly coupled pair and a separate merger subagent for integration.

Use [Agent Coordination](../../../context/workflow.md#agent-coordination-task-briefs-handoffs-and-reviews) for the existing `agent:context` and `agent:work` helpers, session reuse, task briefs, worker-state refresh, handoffs, and review snapshots. The context helper takes repo-relative task and plan paths; keep the absolute feature directory for direct reads and worker briefs, and pass the absolute checkout through its root option.

Use the helper-generated brief and add only the selected task's relevant contract and acceptance details. The implementer applies TDD in vertical slices, follows the repository's type, constructor-injection, ports-and-adapters, lint, and test rules, and reports actual commands with exit statuses. A worker never changes task status in `tasks.md`. Keep worker artifacts in their session subfolders and accepted specs, `tasks.md`, and concise verification records at canonical paths.

## Integrate and record work

The merger checks that the worker's base is current, its commit changes only owned paths, and its acceptance checks pass on the integrated feature branch. Merge one worker at a time. Only after the change is landed and its applicable checks pass may the merger mark its original task IDs `[X]` in `tasks.md` and record verification evidence. Failed or unmerged tasks remain unchecked. Recompute the ready frontier after each accepted integration.

After an initial task failure, send one corrective prompt to the responsible worker. If the same problem persists after that prompt, stop and ask the user for guidance, following `AGENTS.md`. Continue independent ready work only when its prerequisites remain valid. Never mark downstream tasks complete while a prerequisite is unfinished.

## Converge and review the integrated revision

Before final convergence, complete any relevant `context/` documentation sync required by `AGENTS.md`, including the active-feature checkpoint when applicable; record required edits in the canonical task graph and run their checks. After all current tasks are integrated, run `/speckit-converge` against the feature branch. If it appends traceable tasks to `tasks.md`, treat them as new graph nodes and complete them through this same worker and merger flow. Re-run convergence after those changes until it reports no actionable gaps.

Then run `/code-review` with the local `FEATURE_DIR/spec.md` and `FEATURE_DIR/plan.md`, pinned to the feature branch base and integrated `HEAD` (or a captured and verified source snapshot). If the review finds blocking work, add traceable tasks to the canonical `tasks.md`, run them through the graph, merge and verify them, then repeat only gates affected by those changes. Review each changed integrated revision once; do not repeat a review when the reviewed revision has not changed. Keep the reviewer independent from implementation.

After tasks, convergence, and review pass, complete the mandatory post-hooks from the extension reference. Report completed task IDs, the integrated branch and revision, actual check results, convergence and review outcomes, hook results, and evidence paths. Feature completion requires all canonical tasks checked, applicable checks passed, convergence clean, and no blocking review findings. PR creation, remote issue closure, CI publishing, and deployment belong to a separately authorized workflow such as `pr-feedback-loop`. After all workers stop, their work is integrated, and evidence is retained, clean up only task worktrees created by this run; preserve the integration checkout, active `agent:work` session, and human-owned artifacts.
