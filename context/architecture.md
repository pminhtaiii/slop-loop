# Architecture

## Purpose

This document describes the stable runtime architecture of slop-loop.

It defines:

- major system components,
- responsibility boundaries,
- authority boundaries,
- state ownership,
- high-level data and control flow.

It does not describe implementation progress.

Use `progress-checker.md` for verified implementation status.

---

## Core Model

slop-loop follows the principle:

```text
Coding Agent = Model + Harness
```

The model is responsible for reasoning.

The harness is responsible for control, execution, verification, and safety.

The model may propose an action, but it does not directly authorize or execute that action.

---

## High-Level Architecture

```text
User / GitHub Issue
        │
        ▼
     Task Intake
        │
        ▼
┌──────────────────────────┐
│   Workflow Orchestrator  │
│        LangGraph         │
│                          │
│ triage                   │
│   ↓                      │
│ plan                     │
│   ↓                      │
│ baseline                 │
│   ↓                      │
│ edit                     │
│   ↓                      │
│ verify ──────► repair    │
│   ↓             │        │
│ review ◄────────┘        │
│   ↓                      │
│ delivery                 │
└────────────┬─────────────┘
             │
      ┌──────┼──────┐
      ▼      ▼      ▼
    State  Policy  Context
      │      │      │
      └──────┼──────┘
             ▼
      Repository Tools
             │
             ▼
      Target Workspace
```

Cross-cutting services include:

- checkpointing,
- tracing,
- approval,
- memory,
- skills,
- evaluation.

---

## Architectural Planes

### Reasoning Plane

Owned primarily by the language model.

Responsibilities:

- interpret tasks,
- form hypotheses,
- propose plans,
- inspect relevant context,
- diagnose failures,
- propose patches,
- explain results.

Model output is treated as a proposal rather than execution authority.

---

### Control Plane

Owned by deterministic application code.

Responsibilities:

- workflow transitions,
- task state,
- tool authorization,
- repair limits,
- approval gates,
- checkpointing,
- completion rules,
- reviewer coordination.

The control plane decides whether a proposed action may proceed.

---

### Execution Plane

Owned by tools and external processes.

Responsibilities:

- read repository files,
- search code,
- apply controlled patches,
- run tests,
- execute allowlisted commands,
- inspect or modify Git state when permitted.

The model cannot directly access the operating system or repository outside these tools.

---

## Main Components

### Workflow Orchestrator

Coordinates the coding task as an explicit graph.

Typical coding flow:

```text
issue
  ↓
triage
  ↓
plan
  ↓
baseline
  ↓
edit
  ↓
verify
  ↓
review
  ↓
delivery
```

Failure may enter a bounded repair loop:

```text
verify
  │
 fail
  ▼
diagnose
  ↓
repair
  ↓
verify
```

Not every task must visit every node.

For example, a codebase question may only require:

```text
triage → search → answer
```

---

### Task State

Important workflow information must live outside model conversation history.

Task state includes concepts such as:

```text
task ID
run ID
goal
acceptance criteria
constraints
plan
completed steps
current step
verification state
repair count
approval state
review result
next action
```

Conversation history may be compacted without losing this state.

---

### Repository Tool Layer

Repository access occurs through narrow tools such as:

```text
list_dir
read_file
search_code
apply_patch
run_tests
run_command
git operations
```

Tool calls pass through validation and policy before execution.

The model never receives unrestricted filesystem or shell access.

---

### Policy and Approval

Every proposed action belongs to one of three categories:

```text
ALLOWED
APPROVAL_REQUIRED
FORBIDDEN
```

Examples of approval-required operations include:

- dependency changes,
- file deletion or rename,
- sensitive configuration changes,
- broad modifications,
- Git commit or push.

Forbidden actions cannot become allowed simply because the model requests them differently.

Approval pauses the workflow and resumes from the same state after a decision.

---

### Verification

Verification determines whether a change is complete.

Typical verification stages are:

```text
baseline
  ↓
patch
  ↓
focused tests
  ↓
regression tests
  ↓
review
```

Therefore:

```text
patch applied ≠ task complete
```

A task reaches completion only after the required verification gates pass.

---

### Reviewer

The reviewer is a separate, read-only reasoning role.

It inspects:

- the final diff,
- acceptance criteria,
- repository conventions,
- verification evidence.

The reviewer may approve or request changes.

Coder–reviewer iteration must remain bounded.

---

## Checkpoint and Resume

Long-running tasks use persisted state and checkpoints.

Conceptually:

```text
execute step
    ↓
persist TaskState
    ↓
checkpoint
```

After restart:

```text
restore checkpoint
    ↓
load TaskState
    ↓
validate repository state
    ↓
continue current step
```

Completed work should not be repeated unnecessarily.

---

## Context Architecture

Context should be loaded selectively.

```text
project-overview.md
    project purpose and scope

architecture.md
    components and boundaries

workflow.md
    task transitions and repair rules

tools-and-permissions.md
    execution permissions

state-and-memory.md
    checkpoint, resume, compaction, memory

verification.md
    completion evidence

active-task.md
    current task handoff

progress-checker.md
    verified implementation reality
```

Architecture defines **who owns what**.

Detailed operational rules belong in the specialized context files.

---

## Architectural Invariants

The following properties should remain true regardless of model behavior:

1. The model cannot directly execute arbitrary system commands.
2. Repository operations remain inside the approved workspace.
3. Sensitive files remain protected.
4. Risky actions pass through deterministic approval policy.
5. Repair loops are bounded.
6. Reviewer authority remains read-only.
7. Existing tests cannot be weakened merely to make a patch pass.
8. Completion requires verification evidence.
9. Important actions are traceable.
10. Runtime state exists independently of model conversation history.

---

## Architectural Summary

The system can be reduced to the following loop:

```text
Model
  │
  │ proposes
  ▼
Control Plane
  │
  │ authorizes
  ▼
Tools
  │
  │ execute
  ▼
Verification
  │
  ├── fail → bounded repair
  │
  └── pass → review → delivery
```

The core principle is:

> **The model proposes. The runtime controls. Tools execute. Verification decides.**