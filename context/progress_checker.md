# Progress Checker

This file records **implemented reality** for slop-loop.

Do not mark a capability complete because it appears in a specification, architecture document, ADR, plan, issue, or context file.

A capability is considered complete only when:

1. the implementation exists,
2. the required verification has been executed,
3. the verification evidence is identifiable,
4. no known blocker invalidates the result.

---

## Status Definitions

Use only the following states.

| Status | Meaning |
|---|---|
| `NOT_STARTED` | No implementation work has been verified |
| `IN_PROGRESS` | Implementation is actively being developed |
| `BLOCKED` | Progress cannot continue without resolving a known blocker |
| `IMPLEMENTED_UNVERIFIED` | Implementation exists, but required verification is incomplete |
| `VERIFIED` | Implementation exists and required verification has passed |

`IMPLEMENTED_UNVERIFIED` must never be treated as completion.

Planning work, documentation, ADRs, or design approval alone do not qualify as implementation.

---

# Current Project Status

```text
FOUNDATION / GOVERNANCE: IN_PROGRESS
CODING-AGENT RUNTIME: NOT YET VERIFIED
END-TO-END TASK EXECUTION: NOT YET VERIFIED
EVALUATION: NOT YET VERIFIED
```

The repository currently contains project-governance and agent-development surfaces, including:

- agent instructions,
- issue-tracker guidance,
- triage conventions,
- domain documentation conventions,
- agent skills,
- specification material,
- CI-related scripts,
- CI-related tests,
- project context.

Their presence does not by itself prove that the coding-agent runtime or the required use cases are complete.

---

# 1. Project Foundation

| Capability | Status | Evidence / Notes |
|---|---|---|
| Repository-level agent instructions | `VERIFIED` | `AGENTS.md` exists |
| GitHub Issue workflow guidance | `VERIFIED` | `docs/agents/issue-tracker.md` |
| Canonical triage labels | `VERIFIED` | `docs/agents/triage-labels.md` |
| Domain documentation convention | `VERIFIED` | `docs/agents/domain.md` |
| Agent skills directory | `IMPLEMENTED_UNVERIFIED` | `.agents/skills/` exists; individual skill contracts must still be checked before considering the skill system verified |
| Specification workspace | `IMPLEMENTED_UNVERIFIED` | `.specify/` exists; specification presence is not runtime verification |
| Project context directory | `IN_PROGRESS` | `context/` exists and is being established |
| CI support surface | `IMPLEMENTED_UNVERIFIED` | `scripts/ci/` and `tests/ci/` exist; required gates must be verified separately |

---

# 2. Context System

| Capability | Status | Evidence / Notes |
|---|---|---|
| Project overview | `IN_PROGRESS` | `context/project-overview.md` |
| Progress tracking | `IN_PROGRESS` | This file |
| Context routing | `NOT_STARTED` | Intended location: `context/README.md` |
| Architecture context | `NOT_STARTED` | Intended location: `context/architecture.md` |
| Workflow context | `NOT_STARTED` | Intended location: `context/workflow.md` |
| Tool and permission policy | `NOT_STARTED` | Intended location: `context/tools-and-permissions.md` |
| State and memory context | `NOT_STARTED` | Intended location: `context/state-and-memory.md` |
| Verification policy | `NOT_STARTED` | Intended location: `context/verification.md` |
| Active task handoff | `NOT_STARTED` | Intended location: `context/active-task.md` |

Context documents describe the system but are **not evidence that the described runtime capability exists**.

For example:

```text
state-and-memory.md says checkpointing is required
```

does not mean:

```text
checkpoint/resume = VERIFIED
```

Verification requires working implementation and evidence.

---

# 3. Core Harness

## 3.1 Repository Tools

| Capability | Status | Required Evidence |
|---|---|---|
| `list_dir` | `NOT_STARTED` | Workspace-bounded tests |
| `read_file` | `NOT_STARTED` | Workspace and denylist tests |
| `search_code` | `NOT_STARTED` | Real repository search tests |
| `apply_patch` | `NOT_STARTED` | Unified-diff application tests |
| Existing-test modification guard | `NOT_STARTED` | Attack / rejection tests |
| `run_tests` | `NOT_STARTED` | pytest execution + timeout evidence |
| `run_command` allowlist | `NOT_STARTED` | Allowed and rejected command tests |
| Git operations | `NOT_STARTED` | Permission / approval evidence |

A tool is not `VERIFIED` until its safety constraints have been tested, not merely its successful path.

---

## 3.2 Workspace and Security Boundary

| Capability | Status | Required Evidence |
|---|---|---|
| Workspace path containment | `NOT_STARTED` | Path traversal tests |
| Secret-file denylist | `NOT_STARTED` | `.env`, PEM, SSH access rejection |
| Network isolation during tests | `NOT_STARTED` | Network attempt is blocked |
| Command allowlist | `NOT_STARTED` | Unsafe command rejected |
| Prompt-injection resistance | `NOT_STARTED` | Attack eval cases |
| Audit logging | `NOT_STARTED` | Structured records for controlled actions |

---

# 4. Task Workflow

Expected high-level workflow:

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
repair
  ↓
review
  ↓
delivery
```

Current implementation status:

| Stage | Status | Evidence |
|---|---|---|
| Issue intake | `NOT_STARTED` | — |
| Structured triage | `NOT_STARTED` | — |
| Task planning | `NOT_STARTED` | — |
| Baseline establishment | `NOT_STARTED` | — |
| Repository modification | `NOT_STARTED` | — |
| Focused verification | `NOT_STARTED` | — |
| Regression verification | `NOT_STARTED` | — |
| Repair loop | `NOT_STARTED` | — |
| Reviewer stage | `NOT_STARTED` | — |
| Final delivery report | `NOT_STARTED` | — |

The workflow should not be considered implemented until one task can traverse the required stages end-to-end.

---

# 5. Verification and Repair

| Capability | Status | Required Evidence |
|---|---|---|
| Pre-edit baseline | `NOT_STARTED` | Baseline test result persisted |
| Focused post-edit tests | `NOT_STARTED` | Relevant tests executed |
| Regression test gate | `NOT_STARTED` | Previously passing tests remain green |
| Verification state model | `NOT_STARTED` | Explicit state transitions |
| Failed-patch handling | `NOT_STARTED` | Controlled retry evidence |
| Bounded repair cycles | `NOT_STARTED` | Retry limit enforced |
| Repair evidence propagation | `NOT_STARTED` | Failed result influences next repair |
| Controlled task termination | `NOT_STARTED` | Budget/repair exhaustion case |

A patch that has been applied but has not passed required verification must remain:

```text
IMPLEMENTED_UNVERIFIED
```

and must not be reported as complete.

---

# 6. Human Approval

| Capability | Status | Required Evidence |
|---|---|---|
| Approval classification | `NOT_STARTED` | Risky actions correctly identified |
| Workflow pause | `NOT_STARTED` | Execution stops before action |
| Approve and resume | `NOT_STARTED` | Resume occurs at interrupted point |
| Reject and adapt | `NOT_STARTED` | Rejected action is not retried indirectly |
| Modify then approve | `NOT_STARTED` | Revised action executed only after approval |
| Forbidden-action handling | `NOT_STARTED` | Forbidden action cannot be approved |
| Approval audit trail | `NOT_STARTED` | Decision recorded with action and outcome |

---

# 7. State, Checkpoint, and Resume

| Capability | Status | Required Evidence |
|---|---|---|
| Structured task state | `NOT_STARTED` | Persisted task state |
| Step states (`todo/doing/done/failed`) | `NOT_STARTED` | State transition tests |
| Checkpoint after task steps | `NOT_STARTED` | Checkpoint persisted |
| Process restart recovery | `NOT_STARTED` | Kill + restart test |
| Resume without duplicate work | `NOT_STARTED` | Completed step not rerun |
| Goal preservation | `NOT_STARTED` | Goal survives restart |
| Constraint preservation | `NOT_STARTED` | Constraints survive restart |
| Acceptance-criteria preservation | `NOT_STARTED` | Criteria survive restart |
| Context compaction | `NOT_STARTED` | Long-context test |
| Compaction summary validation | `NOT_STARTED` | Required fields retained |
| Long-term repository memory | `NOT_STARTED` | New session consumes stored convention |

Resume must be validated by terminating the running process and restoring from persisted state.

Continuing within the same Python process is not sufficient evidence.

---

# 8. Reviewer Agent

| Capability | Status | Required Evidence |
|---|---|---|
| Separate reviewer role | `NOT_STARTED` | Distinct reviewer configuration |
| Read-only reviewer permissions | `NOT_STARTED` | Write/execute attempt rejected |
| Structured review output | `NOT_STARTED` | Schema validation |
| File/line validation | `NOT_STARTED` | Findings reference actual diff lines |
| Logic finding detection | `NOT_STARTED` | Seeded review cases |
| Security smell detection | `NOT_STARTED` | Seeded review cases |
| Missing-test detection | `NOT_STARTED` | Seeded review cases |
| Bounded coder-reviewer loop | `NOT_STARTED` | Iteration limit enforced |

Reviewer completion requires evaluation against known-good and known-bad diffs.

---

# 9. Observability

| Capability | Status | Required Evidence |
|---|---|---|
| Run ID | `NOT_STARTED` | Unique run identifier |
| Node-level trace | `NOT_STARTED` | Workflow node records |
| Tool-call trace | `NOT_STARTED` | Arguments/results/timing |
| Skill-call trace | `NOT_STARTED` | Skill invocation records |
| Error trace | `NOT_STARTED` | Structured error records |
| Approval trace | `NOT_STARTED` | Human decision records |
| Verification trace | `NOT_STARTED` | Test/evaluation evidence |
| Token usage | `NOT_STARTED` | Per-run accounting |
| Cost estimate | `NOT_STARTED` | Per-run estimate |

Trace records should be sufficient to explain how the final task state was reached.

---

# 10. Skills

A skill should only become `VERIFIED` when:

1. its contract exists,
2. the runtime can select/load it,
3. required constraints are enforced,
4. at least one representative task uses it successfully.

| Skill | Contract | Runtime Integration | Eval | Overall |
|---|---|---|---|---|
| Bug fixing | TBD | TBD | TBD | `NOT_STARTED` |
| Unit-test generation | TBD | TBD | TBD | `NOT_STARTED` |
| Bug triage | TBD | TBD | TBD | `NOT_STARTED` |
| Code review | TBD | TBD | TBD | `NOT_STARTED` |
| Release-note generation | TBD | TBD | TBD | `NOT_STARTED` |

Only skills actually selected for implementation need to be tracked here.

---

# 11. Use-Case Verification

This section tracks rubric-level completion.

Do not mark a use case `VERIFIED` from implementation alone.

A use case requires:

```text
functionality
+ harness requirements
+ required eval cases
+ recorded evidence
```

| Use Case | Implementation | Eval | Status |
|---|---|---|---|
| UC-01 Issue Triage | — | — | `NOT_STARTED` |
| UC-02 Codebase Q&A | — | — | `NOT_STARTED` |
| UC-03 End-to-End Bug Fix | — | — | `NOT_STARTED` |
| UC-04 Multi-Step Feature + Resume | — | — | `NOT_STARTED` |
| UC-05 Human Approval | — | — | `NOT_STARTED` |
| UC-06 Reviewer Agent | — | — | `NOT_STARTED` |
| UC-07 Unit-Test Generation | — | — | `NOT_STARTED` |
| UC-08 CI/Test Log Analysis | — | — | `NOT_STARTED` |
| UC-09 PR / Release Notes | — | — | `NOT_STARTED` |
| UC-10 Behavior-Preserving Refactor | — | — | `NOT_STARTED` |
| UC-11 MCP Repository Tools | — | — | `NOT_STARTED` |

Once the final UC set is selected, non-selected use cases should be marked:

```text
OUT_OF_SCOPE
```

rather than `NOT_STARTED`.

---

# 12. Knowledge-Area Coverage

Track this only against the final submitted use-case set.

| Area | Required Capability | Covered By | Status |
|---|---|---|---|
| K1 | Model / structured output / agent loop | TBD | `NOT_STARTED` |
| K2 | Tool use / skills | TBD | `NOT_STARTED` |
| K3 | RAG | TBD | `NOT_STARTED` |
| K4 | Memory / state / context | TBD | `NOT_STARTED` |
| K5 | Workflow / HITL | TBD | `NOT_STARTED` |
| K6 | Multi-agent / MCP | TBD | `NOT_STARTED` |
| K7 | Verification / evaluation | TBD | `NOT_STARTED` |
| K8 | Security / observability | TBD | `NOT_STARTED` |

The final submitted use cases must cover all required knowledge areas.

---

# 13. Evaluation Infrastructure

| Capability | Status | Required Evidence |
|---|---|---|
| Seeded bug dataset | `NOT_STARTED` | Required bug cases exist |
| Feature acceptance cases | `NOT_STARTED` | Required feature cases exist |
| Hidden grading tests | `NOT_STARTED` | Agent cannot inspect during execution |
| Security attack cases | `NOT_STARTED` | Required attack cases |
| One-command eval runner | `NOT_STARTED` | Complete eval invocation |
| Structured eval output | `NOT_STARTED` | Machine-readable result |
| Regression comparison | `NOT_STARTED` | At least two evaluation runs |
| Metrics reporting | `NOT_STARTED` | UC-specific metrics |

---

# 14. Current Verified Milestone

At the time of this document's creation, the project is best described as:

```text
PROJECT FOUNDATION / GOVERNANCE IN PROGRESS
```

Repository-level conventions and supporting development structure are present.

The coding-agent runtime, end-to-end workflow, safety enforcement, resume behavior, reviewer coordination, and rubric-level use cases must not be declared complete until their implementation and verification evidence are inspected.

---

# 15. Next Verification Target

The next milestone should establish the smallest executable vertical slice:

```text
issue
  ↓
read repository
  ↓
run baseline test
  ↓
apply controlled patch
  ↓
run focused test
  ↓
run regression test
  ↓
produce evidence-backed report
```

Recommended exit gate:

- repository reads remain inside workspace,
- patch is applied through the controlled patch mechanism,
- existing tests cannot be weakened,
- focused verification passes,
- regression verification passes,
- tool actions are traceable,
- final report distinguishes implementation from verification.

Once this vertical slice is working and evidenced, the corresponding rows above should be updated from `NOT_STARTED` / `IMPLEMENT