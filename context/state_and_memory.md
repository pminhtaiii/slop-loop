# State and Memory

## Purpose

This document defines how slop-loop preserves task state across long-running workflows, interruptions, and new sessions.

The key principle is:

> **Runtime state must not depend on conversation history alone.**

---

## 1. State Types

slop-loop distinguishes three kinds of state.

### Task State

State belonging to one active coding task.

Examples:

```text
goal
acceptance criteria
constraints
plan
current step
completed steps
repair count
verification status
approval status
review result
open risks
next action
```

Task state is authoritative for workflow execution.

---

### Checkpoint State

A persisted snapshot that allows the workflow to resume after interruption.

A checkpoint should contain enough information to restore:

```text
current workflow node
TaskState
pending approval
repair budget
verification progress
```

Checkpoint persistence should be handled by the workflow runtime, such as a LangGraph checkpointer.

---

### Long-Term Memory

Reusable repository knowledge that may help future tasks.

Examples:

```text
repository uses pytest -q
functions use snake_case
module X must not import module Y
generated files under path Z should not be edited
```

Long-term memory is advisory.

Current repository evidence always has priority over stored memory.

---

# 2. TaskState

The exact implementation may evolve, but the logical state should resemble:

```python
TaskState
├── task_id
├── run_id
├── task_type
│
├── goal
├── acceptance_criteria
├── constraints
│
├── plan
├── current_step
│
├── changed_files
│
├── verification
├── repair
├── approval
├── review
│
├── open_risks
├── next_action
└── status
```

Each plan step should have an explicit status:

```text
todo
doing
done
failed
```

The runtime, not the model conversation, owns these values.

---

# 3. Task Identity

Every task should have a stable identifier.

Each execution attempt should also have a run identifier.

Example:

```text
task_id: ISSUE-042
run_id: run-20261015-003
```

A task may therefore span multiple runs:

```text
ISSUE-042
├── run-001
├── run-002
└── run-003
```

The task retains its goal and state across those runs.

---

# 4. Checkpointing

Checkpoints should be written at meaningful workflow boundaries.

Recommended checkpoint points include:

```text
plan created
baseline completed
implementation step completed
patch applied
verification completed
approval requested
approval resolved
review completed
```

Do not rely only on process memory for task recovery.

---

# 5. Resume

When slop-loop restarts, resume should follow this sequence:

```text
load task
    ↓
restore latest checkpoint
    ↓
restore TaskState
    ↓
inspect current repository state
    ↓
validate assumptions
    ↓
continue from next required action
```

The workflow must not blindly replay the previous step.

Before continuing, it should check that the repository still matches the stored state.

---

## Resume Invariants

After resume:

- completed steps must not be repeated unnecessarily,
- the original goal must remain unchanged,
- constraints must remain available,
- acceptance criteria must remain available,
- repair count must not reset,
- approval decisions must not disappear,
- verification already completed must remain recorded.

Example:

```text
before interruption:

step 1 → done
step 2 → done
step 3 → doing

after resume:

step 1 → done
step 2 → done
step 3 → resume
```

Not:

```text
step 1 → run again
```

---

# 6. Repository Revalidation

Persisted state can become stale.

For example, the user may modify the repository while the agent is stopped.

Therefore resume should compare stored assumptions with the current workspace.

Useful checks include:

```text
Git revision
working-tree changes
expected changed files
relevant file hashes
```

If repository state has changed unexpectedly:

```text
resume
  ↓
detect mismatch
  ↓
re-evaluate affected assumptions
```

The workflow should not continue from stale evidence.

---

# 7. Context Compaction

Long tasks may exceed practical model context limits.

When compaction is required, generate a concise task summary containing at least:

```text
goal
constraints
completed work
current state
open risks
next action
```

Example:

```text
Goal:
Fix duplicate validation.

Constraints:
Do not change public API.
Do not modify existing tests.

Completed:
- reproduced bug
- located validation logic
- applied initial patch

Current State:
Focused test passes.
Regression test not yet executed.

Open Risks:
Potential interaction with middleware.

Next Action:
Run regression tests.
```

---

## Compaction Does Not Replace State

The compact summary exists for model reasoning.

It is not the authoritative runtime state.

```text
TaskState
    = execution truth

compact summary
    = reasoning context
```

If the two disagree, runtime state must be inspected rather than assuming the summary is correct.

---

# 8. Active Task Handoff

A human-readable active-task summary may be generated from runtime state.

It should contain only information needed to continue the current task.

Recommended fields:

```text
task
goal
acceptance criteria
constraints
completed work
current state
open risks
next action
verification evidence
```

Detailed execution history belongs in traces rather than the handoff.

---

# 9. Long-Term Memory

Long-term memory stores repository knowledge useful across tasks.

Good memory candidates are:

```text
stable repository conventions
common test commands
repeated architectural constraints
known repository-specific workflows
```

Poor memory candidates are:

```text
temporary task progress
one-time test output
speculative model conclusions
old file contents
```

---

## Memory Validation

Memory must be treated as potentially stale.

Before relying on a memory item that affects implementation, the agent should confirm it against current repository evidence when practical.

Example:

```text
Memory:
"Tests use pytest -q"

Current pyproject:
test command changed

Result:
current repository wins
```

---

# 10. Memory Lifecycle

Long-term memory should support:

```text
create
read
update
delete
```

Users and maintainers must be able to inspect and remove stored repository memory.

Incorrect memory must not become permanent hidden context.

---

# 11. State vs Trace

State and trace serve different purposes.

### State

Answers:

> What is true now?

Example:

```text
repair_cycles_used = 1
focused_tests = passed
regression_tests = pending
```

### Trace

Answers:

> How did we get here?

Example:

```text
10:31 run focused test
10:32 test failed
10:34 patch applied
10:35 focused test passed
```

The workflow resumes from state.

Trace exists for explanation, debugging, and evaluation.

---

# 12. Persistence Separation

Runtime-generated state should remain separate from human-authored context.

Recommended layout:

```text
.slop-loop/
├── state/
│   └── <task-id>.json
│
├── checkpoints/
│   └── checkpoints.sqlite
│
├── traces/
│   └── <run-id>.jsonl
│
└── memory/
    └── ...
```

Human-authored Markdown files should not become the primary persistence mechanism for runtime state.

---

# 13. Core Invariants

The state system must preserve these guarantees:

1. Task state exists outside model conversation history.
2. Completed steps survive restart.
3. Repair budgets survive restart.
4. Approval state survives restart.
5. Verification evidence survives restart.
6. Resume validates current repository state.
7. Context compaction does not destroy task state.
8. Long-term memory cannot override current repository evidence.
9. Task state and execution trace remain separate.
10. Runtime-generated state is not stored only in Markdown.

---

# Summary

The persistence model is:

```text
TaskState
    │
    ├── checkpoint ──► resume
    │
    ├── compact summary ──► model context
    │
    ├── active-task handoff ──► human/agent handoff
    │
    └── trace ──► execution history

Long-Term Memory
    └── reusable repository knowledge
```

The central rule is:

> **State preserves execution; context supports reasoning; memory supports future tasks.**