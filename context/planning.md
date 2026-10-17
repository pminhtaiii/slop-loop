# Planning and Specification Workflow

This document governs the deterministic workflow for authoring, decomposing, and auditing specifications and implementation plans before implementation begins. It complements the contributor implementation workflow in [workflow.md](workflow.md) and testing standards in [testing.md](testing.md).

Planning artifacts are the source of truth for feature scope. Rushing into implementation with ambiguous, conflicting, or unverified specifications creates compounding rework. This workflow enforces a deterministic creation and review loop that validates planning artifacts and eliminates P0 and P1 defects before implementation is authorized.

## Deterministic Planning Pipeline

```text
/speckit-plan  ──>  /speckit-tasks  ──>  Audit & Subagent Review Loop  ──>  Plan Approved Gate
  (plan.md)           (tasks.md)             (P0/P1 quality gate)           (Ready for Implementation)
```

The pipeline starts when an agent is instructed to plan or when `/speckit-plan` is invoked, building on the feature requirements. It executes through three core stages:

1. **Implementation Planning (`/speckit-plan`)**: Authors `specs/<feature>/plan.md`, `research.md`, `data-model.md`, `contracts/`, and `quickstart.md`. Resolves all technical unknowns; zero `NEEDS CLARIFICATION` markers may remain.
2. **Task Decomposition (`/speckit-tasks`)**: Authors `specs/<feature>/tasks.md` with strict checklist task syntax, user story phase mappings, file path targets, and an acyclic dependency graph.
3. **Planning Audit & Review Loop**: Validates artifacts using automated checks and independent review subagents to catch and resolve P0 and P1 issues before implementation handoff.

---

## Artifact Standards

Every feature directory under `specs/<feature>/` must contain the following core planning artifacts before implementation:

| Artifact | Path | Purpose | Critical Requirements |
|---|---|---|---|
| Feature Specification | `spec.md` | Problem statement and user stories | Must define prioritized stories (P1, P2...), testable acceptance criteria, and explicit edge cases. |
| Implementation Plan | `plan.md` | Architecture and technical context | Must comply with [architecture.md](architecture.md), [runtime_policy.md](runtime_policy.md), and [tools_permissions.md](tools_permissions.md). |
| Technical Research | `research.md` | Technical decisions and rationale | Must resolve all unknowns; no unresolved `NEEDS CLARIFICATION`. |
| Data Model | `data-model.md` | Entities and relationships | Maps entities to user stories and persistence schemas. |
| Interface Contracts | `contracts/` | Boundary and API contracts | Defines request/response schemas, events, or port signatures. |
| Quickstart Guide | `quickstart.md` | End-to-end validation scenarios | Runnable validation steps proving feature completion. |
| Task Ledger | `tasks.md` | Actionable work units | Strictly formatted checklist tasks ordered by dependency. |

### Task Ledger Syntax Rules

Every task in `tasks.md` must adhere to the canonical checklist format:

```text
- [ ] [TaskID] [P?] [Story?] Description with exact file path
```

- **TaskID**: Canonical sequential identifier (`T001`, `T002`, `T003`...).
- **[P] marker**: Present *only* if the task is parallelizable (no shared unmerged files or uncompleted dependencies).
- **[Story?] tag**: Mandatory for user story phase tasks (`[US1]`, `[US2]`...), omitted for setup and foundational phases.
- **File path**: Must name explicit repository-relative file paths for owned implementation and test files.

---

## Planning Audit and Review Loop

Before declaring planning complete or starting implementation, run the planning audit and dispatch review subagents.

```text
┌────────────────────────────────────────────────────────┐
│               Run Automated Validation                 │
│    node scripts/agents/planning-workflow.mjs validate  │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│               Dispatch Review Subagents                │
│  - Subagent 1: Standards & Architecture                │
│  - Subagent 2: Testability & Edge Cases                │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│               Evaluate Issue Severities                │
│  P0 (Blocker) / P1 (Major) / P2 (Advisory)             │
└──────────────────────────┬─────────────────────────────┘
                           │
            ┌──────────────┴──────────────┐
            ▼                             ▼
   [P0 or P1 issues exist]       [0 P0 and 0 P1 issues]
            │                             │
            ▼                             ▼
┌───────────────────────┐   ┌───────────────────────────┐
│ Refine Artifacts Loop │   │ Pass Planning Gate        │
│ (update spec/plan/    │   │(Ready for Implementation) │
│  tasks and re-audit)  │   └───────────────────────────┘
└───────────────────────┘
```

### Issue Severity Definitions

| Severity | Definition | Action |
|---|---|---|
| **P0 (Critical / Blocker)** | Defect that makes implementation impossible, inconsistent, or hazardous. Examples: missing required planning artifacts, malformed task lines, cyclic task dependencies, missing file paths, contradictory acceptance criteria, security or permission violations against [tools_permissions.md](tools_permissions.md), or unresolved architectural conflicts. | **Blocks implementation.** Must be fixed before any contributor code is written. |
| **P1 (Major)** | Gaps or ambiguities that risk incorrect implementation or test failures. Examples: unresolved `NEEDS CLARIFICATION` markers, underspecified error handling or recovery paths, missing edge-case criteria, orphan contracts with no implementation task, parallel `[P]` markers with conflicting file ownership, or untestable acceptance criteria. | **Blocks implementation.** Must be resolved or explicitly downgraded by the coordinator with documented rationale. |
| **P2 (Advisory / Minor)** | Non-blocking polish, stylistic improvements, documentation enhancements, or non-critical refactor suggestions. | Advisory. Documented for later cleanup; does not block implementation handoff. |

---

## Subagent Review Dispatch

The coordinator spawns two independent review subagents using briefs generated by the planning helper:

```powershell
node scripts/agents/planning-workflow.mjs review-brief --dir specs/<feature> --role standards
node scripts/agents/planning-workflow.mjs review-brief --dir specs/<feature> --role testability
```

### 1. Standards and Architecture Reviewer
- Verifies alignment with repository principles in `.specify/memory/constitution.md` and [architecture.md](architecture.md).
- Validates tool and permission boundaries in [tools_permissions.md](tools_permissions.md) and state policies in [runtime_policy.md](runtime_policy.md).
- Confirms deep module seams and interface locality.

### 2. Testability and Edge Cases Reviewer
- Inspects user stories for unambiguous, verifiable acceptance criteria.
- Checks coverage of failure modes, network timeouts, edge cases, and unexpected inputs.
- Verifies that every interface contract in `contracts/` has matching test tasks and implementation tasks in `tasks.md`.

Subagents report their findings using structured markdown tables categorizing every finding as P0, P1, or P2.

---

## Commands and Automation

The planning workflow helper provides deterministic validation and review management:

```powershell
# Run automated validation against planning artifacts in a feature directory
node scripts/agents/planning-workflow.mjs validate --dir specs/<feature>

# Generate review brief for subagents
node scripts/agents/planning-workflow.mjs review-brief --dir specs/<feature> --role <standards|testability>

# Evaluate findings from a subagent review report
node scripts/agents/planning-workflow.mjs evaluate-review --review <review-output.md>

# Check combined planning readiness status
node scripts/agents/planning-workflow.mjs status --dir specs/<feature>
```

When all automated checks pass and review subagents report zero unresolved P0 and P1 issues, the coordinator marks the planning gate as `PASSED` and the plan is approved for implementation handoff in [workflow.md](workflow.md).
