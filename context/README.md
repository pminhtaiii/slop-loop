# Project Context

Start here, then load only the documents triggered by the task. These pages describe the intended slop-loop runtime and the evidence found in this repository; they do not prove that a planned capability exists.

| Task | Read |
|---|---|
| Understand project scope or plan a runtime change | [Project overview](project_overview.md), [technology stack](tech_stack.md), and [architecture](architecture.md). Then load the policy and state documents for the boundaries involved. |
| Interpret task, run, session, or recovery terminology | Use the canonical definitions in the [glossary](../GLOSSARY.md). |
| Review TypeScript runtime code | [Backend code standards](code_standard.md) is the primary standards reference. For a feature review, also read its originating `spec.md`. Add [architecture](architecture.md) or the relevant policy document when a finding depends on that design. |
| Implement or change a runtime boundary | [Architecture](architecture.md), [backend code standards](code_standard.md), and the relevant [runtime policy](runtime_policy.md), [tools and permissions](tools_permissions.md), or [state and memory](state_and_memory.md). For implementation, use [testing guidance](testing.md) and the relevant [target verification matrix](../docs/progress-checker-matrices.md) rows as validation criteria. |
| Change tool access, approvals, command execution, secrets, or sandboxing | [Tools and permissions](tools_permissions.md) is authoritative for permission classes and role access; [runtime policy](runtime_policy.md) defines cross-cutting enforcement requirements. Add [state and memory](state_and_memory.md) when approval or recovery records change. |
| Change checkpoints, resume, compaction, or repository memory | [State and memory](state_and_memory.md). Add [runtime policy](runtime_policy.md) when replay, approval binding, or execution limits are affected. |
| Author, plan, or audit a feature spec | [Planning workflow](planning.md) defines the deterministic loop for specification, planning, task decomposition, and P0/P1 review. |
| Implement an approved local Spec Kit feature | [Contributor workflow](workflow.md) and [testing guidance](testing.md), then the feature's `spec.md`, `plan.md`, and `tasks.md`. |
| Publish or update a contributor PR, inspect its head-specific CI/review status, or respond to CI/CodeRabbit findings | [PR workflow](../docs/agents/pr-workflow.md), [paired PR/ticket publication](../docs/agents/paired-publication.md), and the [PR feedback loop skill](../.agents/skills/pr-feedback-loop/SKILL.md). |
| Prepare solved paired tickets during PR review, or close them after both resolving PRs merge | [Paired ticket completion](../docs/agents/paired-publication.md#complete-paired-tickets) defines preview/apply, acceptance evidence and interrupted-close recovery. |
| Start, update, or hand off contributor work | Follow [input readiness](workflow.md#input-readiness) for preflight and UC assignment reports, then the [active-task handoff](workflow.md#active-task-handoff) for registration and verified archive-before-clear. Use [active_task.md](active_task.md) for stable navigation and read commands; use the selected session's generated `.agent-work/` progress view for current assignments. |
| Create task worktrees or clean completed runs | [Dump workspace guide](../docs/agents/workspace.md) covers registered ownership, evidence retention, and preview-first retirement. |
| Complete an explicitly authorized helper, documentation, or maintenance task without an approved feature | Follow the user's stated scope and the relevant source documents. Do not invent Spec Kit task IDs or planning artifacts. |
| Delegate selected use cases to colleagues | [Use-case delegation map](../docs/use-case-delegation.md) records owners, dependencies, and delivery briefs for UC-03, UC-04, and UC-05. |
| Check current implementation status | [Implementation status](progress_checker.md) reports repository observations. |
| Find target verification criteria | Relevant sections of the [target verification matrices](../docs/progress-checker-matrices.md) define evidence for planned capabilities. |
| Change runtime implementation choices | [Technology stack](tech_stack.md) records approved choices and open decisions. |
| Edit project context or its contract | Read [testing guidance](testing.md) for the context consistency check, [the context contract](contract.json), and the document that owns the affected fact or rule. |
| Finish implementation and refresh context | Follow [context refresh](workflow.md#context-refresh) to update affected documents in their existing format and validate the edits. |

Issue tracking, triage labels, and domain-document conventions are documented in [issue tracker guidance](../docs/agents/issue-tracker.md), [triage labels](../docs/agents/triage-labels.md), and [domain documentation guidance](../docs/agents/domain.md).
