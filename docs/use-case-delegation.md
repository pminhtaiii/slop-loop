# Use-case Delegation Map

First implementation batch selected by the project owner: **UC-03, UC-04, and UC-05**. UC-01 is deferred for this batch. Use the canonical zero-padded IDs from [the verification matrices](progress-checker-matrices.md#candidate-use-cases-and-knowledge-coverage).

This page owns colleague assignments, delivery boundaries, and dependencies. The matrices own target evidence; [implementation status](../context/progress_checker.md) owns observed capability status. Approved feature `tasks.md` files remain the only implementation task ledgers. An assignment or merged PR alone does not establish that a UC is verified.

## Assignments

Assignments use the colleague names supplied by the project owner. These rows are planning briefs; implementation starts after the relevant contracts and feature artifacts are approved.

| UC | Delivery | Owner | Start condition | Feature artifacts |
|---|---|---|---|---|
| UC-03 | Evidence-backed end-to-end bug fix | Tai | Validated bug-task input contract; shared tools, verification, and UC-05 action gate integrated | Not created; link approved spec, plan, and task ledger here |
| UC-04 | Multi-step feature with restart/resume | Thanh Tan | Shared persisted task/step contracts and budget ownership agreed; UC-05 binding contract agreed | Not created; link approved spec, plan, and task ledger here |
| UC-05 | Bound human approval and safe continuation | Trong Tan | Shared action/policy identity and persisted decision contracts agreed | Not created; link approved spec, plan, and task ledger here |

Other UCs remain unselected for this batch. This is not a permanent `OUT_OF_SCOPE` decision for the final project.

## Delivery order and shared work

1. **Agree contracts and bootstrap.** The coordinator assigns a shared-foundation owner before runtime implementation. Record the open stack choices from [tech_stack.md](../context/tech_stack.md#open-decisions), then approve the feature artifacts. Agree validated bug-task input, task/step state, normalized action identity, policy version, verification result, and cumulative budget accounting. Assign shared files to one owner.
2. **Build independent boundaries.** Thanh Tan's UC-04 persistence/recovery and Trong Tan's UC-05 approval can proceed in parallel against those contracts using controlled fixtures. Tai can prepare UC-03 seeded bug fixtures and acceptance tests while its tool and approval dependencies are being built.
3. **Integrate the bug-fix slice.** Integrate bounded repository tools, baseline/focused/regression verification, repair limits, and the approval gate before UC-03 executes real repository changes. Its ordinary path may use allowed actions; approval-required actions must pause through UC-05.
4. **Prove restart and approval together.** UC-04 integrates the feature workflow and UC-05 decisions, then demonstrates real process restart, retained budgets, and no duplicate side effects. Run each selected UC's evaluation cases and record evidence before updating capability status.

Shared foundation includes the model adapter and structured-output validation, LangGraph wiring, controlled repository tools, policy enforcement, state/checkpoint storage, finite budgets, sanitized traces, and evaluation fixtures. These are dependencies shared by the three UCs. The coordinator assigns their code ownership in the approved plans; suggested module boundaries below do not prescribe paths before that decision.

## UC-03: End-to-end bug fix

**Owns:** the bug-fix workflow from a validated bug task through evidence-backed delivery, composing the shared tools and verification/repair boundaries. For this batch, use directly supplied structured tasks or fixtures containing reproduction details and acceptance criteria; reject or request missing required information. Automated issue triage is deferred with UC-01.

**Deliver:** a seeded Python/`pytest` repository case processed by the TypeScript runtime: inspect, establish and persist baseline, apply a controlled patch, run focused and regression checks, handle failure within the persisted repair budget, and report the actual outcome. Follow the [initial vertical-slice criteria](progress-checker-matrices.md#initial-vertical-slice-target) and the fuller **Verification and repair** criteria. Runtime implementation remains TypeScript; Python is the initial target repository language.

**Acceptance handoff:** successful fix, repairable failed patch, exhausted repair budget, previously passing regression failure, attempted existing-test weakening, workspace escape, secret access, forbidden/injected command, and missing required execution limit. Repository-command isolation must be enforced before real command execution; mocked command results alone do not verify this UC. Incomplete required verification remains `IMPLEMENTED_UNVERIFIED`.

**Boundary:** use the shared bug-task input contract and UC-05's action gate; UC-01 is not a prerequisite for this batch. Own the bug-fix route, not independent copies of policy, persistence, or command execution. The target workflow's read-only reviewer requirements still need an assigned shared owner; contributor CodeRabbit is not the runtime reviewer.

## UC-04: Multi-step feature with resume

**Owns:** durable task/step transitions, checkpoints, restart reconciliation, and feature-workflow continuation, under [state and memory](../context/state_and_memory.md).

**Deliver:** a representative multi-step feature whose goal, constraints, acceptance criteria, completed steps, and cumulative allowances survive process termination. Validate saved repository assumptions before continuing and reconcile uncertain non-idempotent outcomes before retrying.

**Acceptance handoff:** terminate and restart after a completed step; during a budget reservation before settlement; while awaiting approval; and after a side effect before its result is persisted. Prove completed work is not unnecessarily repeated, uncertain effects are reconciled, and a new run ID cannot reset task-scoped repair, reviewer, token, or cost allowances. Cover stale repository assumptions, exhausted/missing accounting, and required compaction-summary fields. Map evidence to **State, checkpoint, and recovery**.

**Boundary:** UC-04 owns recovery mechanics; UC-05 owns approval validity and decisions. A checkpoint continuing in the same process is insufficient restart evidence. Select the checkpoint backend explicitly rather than assuming LangGraph's presence supplies the guarantees.

## UC-05: Human approval

**Owns:** action classification, approval pause, decision validation, and continuation at the interrupted action, following [tools and permissions](../context/tools_permissions.md) and [runtime policy](../context/runtime_policy.md).

**Deliver:** deterministic allowed/approval-required/forbidden decisions. Bind approval to the normalized action, repository identity/state, and policy identity/version. Persist the action and decision through UC-04's storage contract. A materially changed action requires reevaluation.

**Acceptance handoff:** allowed action, pause before a risky action, approve/resume, reject/adapt, revise then approve, forbidden action, stale decision, changed repository/policy, and restart while approval is pending. Prove rejection cannot be bypassed via an equivalent command and forbidden actions cannot be approved. Map evidence to every **Human approval** row; retain sanitized decision/outcome records.

**Boundary:** the product runtime approval gate is separate from a colleague approving a contributor PR. Keep approval decisions behind the shared execution boundary so no UC can bypass them.

## Knowledge coverage to validate

| Area | Candidate evidence owner in this batch | Remaining planning check |
|---|---|---|
| K1: Model, structured output, agent loop | UC-03 | Validated model results and bounded workflow execution |
| K2: Tool use and skills | UC-03 plus shared foundation | Assign and evaluate any selected runtime skill; repository helper skills do not prove runtime loading |
| K3: Retrieval-augmented generation | UC-03 repository evidence path | Define retrieval, provenance, and evidence reaching the model; a file-search demo alone does not establish coverage |
| K4: Memory, state, context | UC-04 | Include compaction and repository-memory evidence, beyond basic checkpoints |
| K5: Workflow and human-in-the-loop | UC-04 and UC-05 | Integrated pause/restart/resume cases |
| K6: Multi-agent coordination and MCP | Owner and scope decision pending | Three selected UCs do not by themselves demonstrate this area; assign explicit coordination/MCP evidence or select another UC later |
| K7: Verification and evaluation | Each UC owner; coordinator integrates runner | Identify cases, grading isolation, machine-readable results, metrics, and repeatable regression comparison |
| K8: Security and observability | Shared foundation and UC-05; exercised by UC-03 | Include isolation, injection resistance, protected-data handling, limits, and sanitized traces |

These are proposed evidence mappings, not claims of coverage. The matrices require every knowledge area in the final submitted set; resolve gaps before final scope approval.

## Assign and hand off

For each UC, fill its owner and link the approved feature artifacts. In those artifacts, assign one owner for shared code, identify dependencies and owned paths, and define executable acceptance checks. Use `UC-*` for use-case identity and the feature's own `T*` IDs for implementation tasks; maintain task completion only in that feature's `tasks.md`.

Colleagues follow the [contributor workflow](../context/workflow.md) for isolated worktrees, active-task registration, integration, and context refresh. A completion handoff includes the UC/task IDs, branch and revision, changed paths, focused/regression/evaluation commands and outcomes, evidence links, and remaining blockers. The coordinator updates observed implementation status only after reviewing integrated evidence.
