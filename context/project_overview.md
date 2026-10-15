# Project Overview

## About the Project

**slop-loop** is a coding-agent system designed to work on small Python repositories through a controlled, verifiable agent workflow.

The system accepts software-engineering tasks such as understanding an issue, exploring a codebase, fixing a bug, implementing a bounded feature, running tests, reviewing changes, and reporting the result.

The project is not intended to build another unrestricted autonomous coding assistant. Its primary focus is the **agent harness** around the language model:

- controlled repository tools,
- explicit workflow state,
- verification through tests,
- bounded repair loops,
- human approval for risky actions,
- reviewer separation,
- checkpoint and resume support,
- traceability and evaluation.

The language model proposes decisions and actions. The harness determines what the agent is allowed to do, verifies the effects of those actions, and decides when the task can be considered complete.

---

## The Problem It Solves

Coding agents can generate code quickly, but generation alone is not sufficient for reliable software engineering.

An agent working directly on a repository must also answer questions such as:

- What exactly is the requested task?
- Which files are relevant?
- What evidence shows the bug exists?
- Is an action permitted?
- Did the proposed patch actually fix the problem?
- Did the patch introduce a regression?
- Should the agent retry, ask for approval, or stop?
- Can another session continue the same task without repeating completed work?
- Can the final result be traced back to tests and repository evidence?

slop-loop addresses these problems by treating coding as a **stateful and governed workflow**, rather than as a single model response.

---

## Primary Users

The primary users are developers working with a small software repository.

A user should be able to:

1. provide an issue or coding request,
2. inspect the agent's progress,
3. approve or reject sensitive operations,
4. inspect the resulting diff and verification evidence,
5. receive a clear completion or failure report.

The agent operates on a controlled workspace rather than directly modifying a production repository.

---

## Target Repository

The initial target environment is a small Python repository with:

- approximately 1,000–10,000 lines of code,
- an existing `pytest` test suite,
- source code and documentation available inside the workspace,
- changes generally bounded to a small number of files.

Typical supported tasks include:

- answering questions about the repository,
- fixing localized bugs,
- implementing bounded multi-file features,
- generating tests,
- analyzing test or CI failures,
- performing behavior-preserving refactors,
- reviewing code changes.

Large monorepos, architecture-wide rewrites, production deployment, and unrestricted infrastructure operations are outside the initial scope.

---

## Core Product Capabilities

### 1. Issue Understanding and Triage

The system can receive a free-form issue and turn it into a structured task.

The agent identifies information such as:

- task type,
- priority,
- potentially affected files,
- reproducibility information,
- acceptance criteria,
- missing information,
- appropriate next route.

When required information is missing, the system should ask for clarification instead of silently inventing assumptions.

---

### 2. Repository Exploration

The agent can inspect the target repository using controlled read tools.

Repository knowledge may include:

- source files,
- functions and classes,
- tests,
- `README`,
- `CONTRIBUTING`,
- `AGENTS.md`,
- project documentation,
- repository-specific conventions.

Answers about the codebase should be grounded in repository evidence rather than unsupported model knowledge.

---

### 3. Bug-Fix Workflow

For a bug-fix task, the expected high-level loop is:

```text
Issue
  ↓
Reproduce
  ↓
Locate
  ↓
Plan
  ↓
Patch
  ↓
Verify
  ↓
Repair if necessary
  ↓
Review
  ↓
Deliver
```

A patch is not considered successful merely because code was generated.

Completion requires verification evidence.

---

### 4. Multi-Step Feature Work

A feature may require several coordinated changes across the repository.

The agent therefore maintains explicit task state with steps such as:

```text
todo → doing → done
              ↘ failed
```

The system must be able to checkpoint progress and resume an interrupted task without unnecessarily repeating completed work.

The original goal, constraints, and acceptance criteria must survive interruption and context compaction.

---

### 5. Verification

Tests act as the primary external judge of repository behavior.

Verification may include:

- establishing a pre-edit baseline,
- reproducing the reported failure,
- running focused tests,
- running broader regression tests,
- checking public API compatibility where relevant,
- validating the final diff,
- recording verification evidence.

The system distinguishes between:

```text
implemented
```

and:

```text
verified
```

A change that exists in the working tree but has not passed the required verification is not complete.

---

### 6. Controlled Repair

Failure does not permit unlimited autonomous retries.

Repair attempts are bounded by workflow policy.

A repair cycle should be based on new evidence from:

- failed tests,
- patch failures,
- reviewer findings,
- validation failures,
- other tool results.

When the retry budget is exhausted or the task cannot safely proceed, the agent stops and reports the blocker rather than continuing indefinitely.

---

### 7. Human Approval

Some operations require explicit human approval before execution.

Examples include:

- commands outside the normal allowlist,
- dependency installation or upgrade,
- deleting or renaming files,
- sensitive configuration changes,
- unusually broad modifications,
- Git operations that publish or finalize changes.

Some operations are forbidden entirely, even with approval, such as unauthorized access outside the workspace or access to protected secrets.

Approval is part of the workflow state. After approval, the agent should continue from the interrupted point rather than restart the task.

---

### 8. Reviewer Separation

Before a code change is delivered, a separate reviewer role may inspect the proposed diff.

The reviewer focuses on:

- logic errors,
- edge cases,
- repository conventions,
- security smells,
- missing tests,
- unsupported changes.

The reviewer is intentionally more restricted than the coding role and does not receive unrestricted write authority.

Coder–reviewer iteration is bounded.

---

### 9. Resume and Context Management

Long-running coding tasks must not depend entirely on the model's conversation history.

The system separates:

- **stable project context**,
- **current task context**,
- **structured runtime state**,
- **checkpoint state**,
- **long-term repository memory**,
- **execution traces**.

When the active conversation becomes too large, context may be compacted while preserving at minimum:

- task goal,
- constraints,
- completed work,
- current state,
- open risks,
- next action.

Structured state remains the source for deterministic resume behavior.

---

### 10. Observability and Evaluation

Every agent run should be inspectable.

The system records enough information to reconstruct important decisions, including:

- run identity,
- workflow nodes,
- tool calls,
- tool results,
- errors,
- approval decisions,
- verification results,
- repair attempts,
- reviewer outcomes.

The project is evaluated through repeatable task cases rather than subjective demonstrations alone.

---

## Agent and Harness Boundary

The project follows this conceptual model:

```text
Coding Agent = Model + Harness
```

The **model** is responsible for reasoning tasks such as:

- interpreting issues,
- proposing plans,
- selecting relevant information,
- proposing code changes,
- explaining failures.

The **harness** is responsible for enforcement and execution, including:

- workspace boundaries,
- tool permissions,
- patch application,
- command restrictions,
- timeout handling,
- test execution,
- approval gates,
- checkpoints,
- repair limits,
- review coordination,
- tracing,
- evaluation.

Security and correctness requirements must not rely only on prompt instructions when they can be enforced programmatically.

---

## Project Coordination Model

GitHub Issues are the primary task and specification surface for the repository.

The project uses the following canonical triage states:

| Label | Meaning |
|---|---|
| `needs-triage` | Maintainer evaluation is required |
| `needs-info` | More information is required |
| `ready-for-agent` | Task is sufficiently specified for agent execution |
| `ready-for-human` | Task should be handled by a human |
| `wontfix` | Task will not be actioned |

Repository terminology and architectural decisions are maintained separately from transient task context:

```text
GLOSSARY.md
    → canonical domain terminology

docs/adr/
    → durable architectural decisions

context/
    → operational context for understanding and executing the project
```

Agents should use repository terminology consistently and must surface conflicts with existing architectural decisions rather than silently overriding them.

---

## Context Model

The `context/` directory is intended to provide selective operational knowledge to agents.

It should not become a duplicate of the entire repository documentation.

Different context files serve different purposes:

```text
project-overview.md
    What is this project and what problem does it solve?

architecture.md
    How is the system structured?

workflow.md
    How does a coding task move through the system?

tools-and-permissions.md
    What may each role/tool do?

state-and-memory.md
    How are task state, checkpoints, resume, and memory handled?

verification.md
    What evidence is required before declaring success?

active-task.md
    What task is currently being worked on?

progress-checker.md
    What has actually been implemented and verified?
```

Agents should load only the context relevant to the current task.

---

## Sources of Truth

Different information has different authoritative sources.

### Task intent

The active user request or accepted GitHub issue defines what needs to be accomplished.

### Domain language

`GLOSSARY.md` defines canonical project terminology.

### Architectural decisions

Existing ADRs under `docs/adr/` define accepted durable design decisions.

### Repository behavior

The current code and tests define implemented behavior.

### Runtime progress

Structured task state and checkpoints define where an active workflow currently is.

### Implementation status

`progress-checker.md` records project capabilities that have been implemented and verified.

Planning or architecture documents alone must not be treated as proof that a capability exists.

---

## Safety Principles

slop-loop follows several project-wide principles.

### Least privilege

A role or tool receives only the capabilities required for its responsibility.

### Workspace isolation

Repository tools operate only inside the approved workspace.

### Evidence before completion

The system must not claim success without the verification required by the task.

### Bounded autonomy

Retries, repairs, review loops, and expensive actions have explicit limits.

### Human control over risky actions

Potentially destructive or irreversible operations require approval or are prohibited entirely.

### No test manipulation

The agent must not make an implementation appear correct by weakening existing tests.

### Traceable decisions

Important actions and state transitions should leave inspectable evidence.

---

## Non-Goals

The initial project is not intended to:

- autonomously operate production repositories,
- merge directly into a production main branch,
- perform unrestricted shell execution,
- access arbitrary files outside the workspace,
- access secrets such as `.env` or SSH credentials,
- redesign large software architectures autonomously,
- support arbitrary large monorepos,
- replace deterministic verification with model judgment,
- delegate implementation to an existing coding agent.

In particular, the project must build its own coding-agent workflow. Existing products such as Claude Code, Codex CLI, Gemini CLI, Copilot Agent, Aider, OpenHands, SWE-agent, Cursor Agent, or equivalent coding agents must not be used as the implementation agent itself.

LLM APIs and agent/workflow libraries may be used as building blocks.

---

## High-Level System View

```text
                    User / GitHub Issue
                            │
                            ▼
                     Issue / Task Input
                            │
                            ▼
                     Coding Workflow
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
   Repository           Task State         Project Context
     Tools              Checkpoints           Memory
        │                   │                   │
        └──────────────┬────┴───────────────────┘
                       ▼
                 Model Reasoning
                       │
                       ▼
                 Proposed Action
                       │
              ┌────────┴────────┐
              ▼                 ▼
        Policy / Approval    Tool Execution
              │                 │
              └────────┬────────┘
                       ▼
                   Verification
                       │
              ┌────────┴─────────┐
              │                  │
            failure            success
              │                  │
              ▼                  ▼
       bounded repair          Review
                                 │
                                 ▼
                              Report
```

---

## Success Criteria

The project is successful when the coding agent can perform repository tasks while remaining controlled, resumable, and verifiable.

At a high level:

- the agent can understand and route repository tasks,
- repository claims are grounded in real code,
- code modifications are applied through controlled tools,
- tests and validators determine completion,
- regressions are detected rather than ignored,
- repair loops terminate predictably,
- risky actions are intercepted,
- interrupted tasks can resume from saved state,
- reviewer responsibilities remain separated,
- important decisions are traceable,
- evaluation can be reproduced across multiple runs.

The objective is not to maximize how much code the model can generate.

The objective is to build a coding agent whose actions can be **controlled, inspected, verified, and resumed**.