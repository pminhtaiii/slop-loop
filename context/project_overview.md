# Project Overview

## Purpose

**slop-loop** is an intended TypeScript coding-agent system for small Python repositories. It combines model reasoning with a controlled harness that owns repository access, workflow state, verification, and task completion. The goal is to make coding work inspectable, bounded, verifiable, and resumable. The approved stack and choices still open are recorded in [tech_stack.md](tech_stack.md).

The product runtime is a target design. The code and tests in the current repository define what exists today; [progress_checker.md](progress_checker.md) summarizes the evidence inspected so far.

## Initial scope

The first target repositories are Python projects of roughly 1,000–10,000 lines with an existing `pytest` suite and source, tests, and project guidance in an approved workspace. Intended tasks include repository questions, localized bug fixes, bounded multi-file features, test generation, CI or test failure analysis, behavior-preserving refactors, and code review.

The primary user is a developer who provides an issue or coding request, can inspect progress and approve or reject sensitive actions, and receives the resulting diff with verification evidence. End-to-end use cases and evaluation criteria remain candidates until scope is selected; see the [target verification matrices](../docs/progress-checker-matrices.md).

## Design boundary

The model interprets tasks, forms plans, diagnoses evidence, and proposes changes. The harness controls workflow transitions, tool permissions, execution, approvals, repair limits, checkpoints, and completion. Tools operate on the target repository. Tests and other required checks provide completion evidence; model judgment alone does not establish that work is complete.

Detailed runtime component boundaries are in [architecture.md](architecture.md). Tool and role policy is in [tools_permissions.md](tools_permissions.md), and persisted state and recovery rules are in [state_and_memory.md](state_and_memory.md).

## Non-goals and safety boundaries

The initial project does not target production operation, direct production merges or deployment, unrestricted shell execution, access outside the approved workspace, secret access, large monorepos, or architecture-wide rewrites. It does not replace deterministic verification with model judgment.

For target repository tasks, the slop-loop runtime must use its own coding-agent workflow; an existing coding-agent product must not act as its delegated implementation agent. This restriction applies to the product runtime, not to assistants contributors may use while developing the project. LLM APIs and workflow libraries may be used as building blocks.

Repair loops and expensive actions must be bounded. Risky operations require human approval or are forbidden; existing tests must not be weakened to make a change pass. [tools_permissions.md](tools_permissions.md) defines permissions, [runtime_policy.md](runtime_policy.md) defines cross-cutting enforcement, and the [target verification matrices](../docs/progress-checker-matrices.md) define required evidence.

## Sources of truth

| Question | Authority |
|---|---|
| What is the requested task? | Active user request or accepted GitHub issue |
| What terms and design choices are established? | `GLOSSARY.md` and relevant ADRs under `docs/adr/`, when present |
| What behavior is implemented? | Current repository code and tests |
| Where is an active workflow now? | Structured runtime state and checkpoints, when implemented |
| What is implemented and verified in this project? | [progress_checker.md](progress_checker.md), with identifiable evidence |
| What evidence will target capabilities require? | [docs/progress-checker-matrices.md](../docs/progress-checker-matrices.md) |

For selective context loading, start at [context/README.md](README.md). GitHub issue, label, and domain-document conventions are in [`docs/agents/`](../docs/agents/).
