# State and Memory

This document defines the target state schema and behavior for recovery, compaction, and repository memory. It does not claim these capabilities are implemented; see [progress_checker.md](progress_checker.md) for current repository evidence. [runtime_policy.md](runtime_policy.md) defines cross-cutting execution, approval-binding, and replay constraints. The target runtime retains LangGraph checkpoint integration; the persistence backend remains open in [tech_stack.md](tech_stack.md).

## State ownership

| Record | Purpose | Required contents |
|---|---|---|
| Task state | Authoritative current workflow state | Task and run IDs; task type; goal; acceptance criteria; constraints; plan and current step; changed files; verification, repair, approval, and review state; open risks; next action; overall status |
| Checkpoint | Restore a workflow after interruption | Current workflow node; full task state; pending approval; remaining repair budget; verification progress |
| Trace | Explain how a run reached its current state | Ordered workflow, tool, approval, verification, error, and result events |
| Long-term memory | Reuse repository knowledge across tasks | Stable conventions, common commands, and durable repository constraints |

Each plan step has one of these states: `todo`, `doing`, `done`, or `failed`. The runtime owns these values; conversation history and compact summaries are not authoritative state. A task has a stable task ID, and each attempt has its own run ID so work can span multiple runs without losing its goal.

## Checkpoint and resume

Write checkpoints at meaningful boundaries: plan creation, baseline completion, implementation steps, patch application, verification, approval request or resolution, and review completion.

Resume by loading the task and latest checkpoint, restoring task state, inspecting the current repository, validating saved assumptions, and continuing from the next required action. Do not blindly replay a completed step. Compare the stored Git revision, working-tree state, expected changed files, and relevant file hashes when practical. If the workspace changed unexpectedly, re-evaluate affected assumptions before continuing.

After restart, preserve the goal, constraints, acceptance criteria, completed steps, repair count, approval decisions, and verification evidence. Resume evidence must come from terminating and restoring the runtime process; continuing in the same process does not demonstrate restart recovery.

An active-task handoff may be generated from runtime state for a human or another agent. Include the task, goal, acceptance criteria, constraints, completed work, current state, open risks, next action, and verification evidence. Keep detailed execution history in the trace.

## Context compaction

When a task summary is needed for model reasoning, retain at least the goal, constraints, completed work, current state, open risks, and next action. The summary is a convenience for reasoning, not a checkpoint. If it conflicts with persisted task state, inspect the state and repository before proceeding.

## Long-term memory

Memory is advisory and may be stale. Confirm it against current repository evidence when it affects implementation; current code and configuration take priority. Users and maintainers must be able to inspect, create, update, and delete stored memory so incorrect information does not become hidden permanent context. Store stable conventions and repeated workflows, not temporary task progress, one-time output, speculation, or stale file contents.

## Persistence boundaries

Keep runtime-generated state, checkpoints, traces, and memory separate from human-authored context. Markdown context must not be the primary store for runtime state. State answers “what is true now?”; trace answers “how did we get here?” Resume from state and use traces for explanation, debugging, and evaluation.

The target persistence model must guarantee that completed work and budgets survive restart, resume validates the current repository, compaction does not destroy task state, and stored memory cannot override current evidence. See [the verification matrices](../docs/progress-checker-matrices.md) for required evidence.
