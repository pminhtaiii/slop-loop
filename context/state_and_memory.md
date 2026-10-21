# State and Memory

This document defines the target state schema and behavior for recovery, compaction, and repository memory. It does not claim these capabilities are implemented; see [progress_checker.md](progress_checker.md) for current repository evidence. [runtime_policy.md](runtime_policy.md) defines cross-cutting execution, approval-binding, and replay constraints. The target runtime retains LangGraph checkpoint integration; the persistence backend remains open in [tech_stack.md](tech_stack.md).

## State ownership

| Record | Purpose | Required contents |
|---|---|---|
| Task state | Authoritative current workflow state | Task and run IDs; task type; goal; acceptance criteria; constraints; plan and current step; changed files; verification, repair, approval, and review state; open risks; next action; overall status |
| Checkpoint | Restore a workflow after interruption | Current workflow node; full task state; pending approval; configured limits and consumed or reserved repair, reviewer-iteration, token, and cost budgets; verification progress |
| Trace | Explain how a run reached its current state | Ordered workflow, tool, approval, verification, error, and result events |
| Long-term memory | Reuse repository knowledge across tasks | Stable conventions, common commands, and durable repository constraints |

Each plan step has one of these states: `todo`, `doing`, `done`, or `failed`. The runtime owns these values; conversation history and compact summaries are not authoritative state. A task has a stable task ID, and each attempt has its own run ID so work can span multiple runs without losing its goal.

For the UC-03 MVP, persisted state must distinguish the current plan, its human approval status, material revisions, and the task-scoped replan allowance. Rejection stops all agents on the task and waits for an explicit developer direction to resume, revise, or end; feedback alone does not resume execution. Pending approval also pauses model calls and background investigation. Preserve this pause across restart; harness outcome recording, cancellation, and recovery-state preservation may continue. A material replan invalidates permission to edit under the revised strategy until renewed human approval. See [ADR-0006](../docs/adr/0006-uc05-cli-and-human-control.md). UC-04 owns persistence/recovery and UC-05 owns approval binding. The accepted logical contract and executable schema version 0.1.0 are recorded in [shared interfaces](../specs/001-verified-code-repair/contracts/interfaces.md) and [canonical contracts](../src/contracts/foundation/uc03.ts). State/approval parsing and trusted admission are implemented; persistence, durable accounting, recovery and policy adapters remain separate work. Preserve workspace identity when resuming a task, while new tasks receive independent fresh Docker workspaces. See [ADR-0003](../docs/adr/0003-docker-task-workspace-boundary.md) and [ADR-0004](../docs/adr/0004-uc03-adaptive-workflow-and-replan-limit.md).

The test-only `MemoryStatePort` simulates CAS, atomic multi-budget reservations, settlement and interrupted-request reconciliation in memory. Scripted approvals require explicit bound decisions and trusted freshness context. These fixtures provide no durable storage or process-restart evidence; real replacements remain T025/T028/T032. The UC-05 Phase 6 continuation fixture composes this canonical in-memory reservation behavior with retained mock claim/control state; rebuilding consumers preserves prior task charges and uncertain reservations. This remains same-process simulation; durable admission, reconciliation and process-restart proof are not supplied.

The UC-03 Phase 4 repair/replan consumers use the injected StatePort for authoritative reloads, reservations and CAS. Material replans require an explicit trusted reservation-admission context; they do not mutate mock internals or implement UC-04 durability. Rejection direction binds to the paused task and current plan/state; feedback text alone cannot restart replanning. Controlled checks retain charged accounting across simulated invocations and return authoritative charged state after failed admission. Confirmed repair-action charges remain reserved when material replanning begins; a reservation lacking a persisted confirmed-action reference requires trusted reconciliation. Outstanding token/cost reservations still prevent replanning. Actual process recovery remains a later integration gate.

## Checkpoint and resume

Write checkpoints at meaningful boundaries: plan creation, baseline completion, implementation steps, patch application, verification, approval request or resolution, and review completion.

Persist each cumulative budget's scope (task or run), configured limit, consumed amount, outstanding reservations, and accounting/configuration identity. Derive remaining allowance from those records. Validate and reserve allowance atomically and durably within its scope before starting a budgeted action, then settle it against the observed result; a crash between execution and checkpointing must not restore spent allowance. An unresolved reservation remains charged until evidence reconciles it. A restart or new run ID within the same task cannot reset a task-scoped budget. Budget increases require an explicit authorized configuration change recorded with its previous accounting; loading configuration alone cannot replenish allowance. UC-03 permits three material replans after the initial plan per task; persist the consumed or reserved replan allowance across runs and restarts. Other numeric limits remain open in [runtime_policy.md](runtime_policy.md).

Resume by loading the task and latest checkpoint, restoring task state, inspecting the current repository, validating saved assumptions, and continuing from the next required action. Do not blindly replay a completed step. Compare the stored Git revision, working-tree state, expected changed files, and relevant file hashes when practical. If the workspace changed unexpectedly, re-evaluate affected assumptions before continuing.

After restart, preserve the goal, constraints, acceptance criteria, completed steps, cumulative budget accounting, approval decisions, and verification evidence. Reconcile pending reservations before the next constrained action. Missing, inconsistent, or exhausted accounting blocks that action until reconciled or explicitly reauthorized; it does not imply a fresh budget. Resume evidence must come from terminating and restoring the runtime process; continuing in the same process does not demonstrate restart recovery.

An active-task handoff may be generated from runtime state for a human or another agent. Include the task, goal, acceptance criteria, constraints, completed work, current state, open risks, next action, and verification evidence. Keep detailed execution history in the trace.

## Context compaction

When a task summary is needed for model reasoning, retain at least the goal, constraints, completed work, current state, open risks, and next action. The summary is a convenience for reasoning, not a checkpoint. If it conflicts with persisted task state, inspect the state and repository before proceeding.

## Long-term memory

Memory is advisory and may be stale. Confirm it against current repository evidence when it affects implementation; current code and configuration take priority. Users and maintainers must be able to inspect, create, update, and delete stored memory so incorrect information does not become hidden permanent context. Store stable conventions and repeated workflows, not temporary task progress, one-time output, speculation, or stale file contents.

## Persistence boundaries

Keep runtime-generated state, checkpoints, traces, and memory separate from human-authored context. Markdown context must not be the primary store for runtime state. State answers “what is true now?”; trace answers “how did we get here?” Resume from state and use traces for explanation, debugging, and evaluation.

Contributor handoffs use one ignored `.agent-work/state/active-tasks.json` store in the primary checkout, shared by linked worktrees. [active_task.md](active_task.md) is an optional local snapshot refreshed only by the explicit `render` command; routine mutations update ignored state without changing tracked Markdown. This store is not the slop-loop product runtime's task state or checkpoint; runtime persistence remains governed by the structured records above.

The target persistence model must guarantee that completed work and budgets survive restart, resume validates the current repository, compaction does not destroy task state, and stored memory cannot override current evidence. See [the verification matrices](../docs/progress-checker-matrices.md) for required evidence.
