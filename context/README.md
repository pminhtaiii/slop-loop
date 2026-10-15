# Project Context

Use this page to find the context needed for a task. Load only the relevant documents. These files describe the project and its intended runtime; `progress_checker.md` records the implementation evidence found in the repository.

## Project and stack

- [Project overview](project_overview.md): purpose, scope, users, and non-goals.
- [Technology stack](tech_stack.md): approved choices and decisions still open.

## Runtime design

- [Architecture](architecture.md): target runtime components and their boundaries.
- [Tools and permissions](tools_permissions.md): target tool, approval, safety, and role policy.
- [State and memory](state_and_memory.md): target task state, checkpoints, recovery, compaction, and memory behavior.

## Contributor workflow and current state

- [Contributor workflow](workflow.md): how contributors implement an approved local Spec Kit feature. It describes repository work, not the slop-loop runtime flow.
- [Testing guidance](testing.md): current contributor testing commands and reporting rules. It is not the complete verification specification for the target runtime.
- [Implementation status](progress_checker.md): concise, evidence-based observations about this repository.
- [Target verification matrices](../docs/progress-checker-matrices.md): detailed evidence criteria for planned runtime and evaluation capabilities; these are targets, not claims of implementation.

Issue tracking, triage labels, and domain-document conventions are maintained in [`docs/agents/`](../docs/agents/).
