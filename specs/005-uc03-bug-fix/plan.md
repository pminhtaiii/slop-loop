# Implementation Plan: UC-03 — End-to-end Bug Fix

**Branch**: `feat/007-uc03-sdd-review` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: `/specs/005-uc03-bug-fix/spec.md`
**Status**: Draft proposal for owner review. No runtime implementation is authorized or claimed. ADR-0002 requires contract agreement before finalizing this plan/task ledger; this artifact deliberately exposes that gate.

## Summary

Implement a localized bug-fix route through validation, adaptive investigation/reproduction, persisted baseline/plan, human plan approval, controlled patch, focused/regression verification, separate read-only review and delivery. Repair and material replan routes return through the same gates. TypeScript/LangGraph orchestrates on the trusted host; shared tools act through Docker into a disposable Python/pytest task workspace. Shared persistence and approval remain owned by UC-04/UC-05.

## Technical Context

**Language/Version**: TypeScript (approved), strict mode; runtime Node version selected at T001, not inferred from contributor Node helpers.
**Primary Dependencies**: Official `@langchain/langgraph` and Docker approved; exact versions, package manager/lockfile, provider/model, schema/build/lint tools remain T001 decisions. No dependencies installed by this planning change.
**Storage**: UC-04 durable task/checkpoint/budget port; backend selected by Thanh Tan, not a UC-03 local database.
**Testing**: Python/pytest inside prepared task image; runtime test/build tools selected at T001. Contract, behavioral, isolation and real integration suites required. Existing contributor `node --test` remains distinct.
**Target Platform**: Trusted host with Docker Linux task containers; concrete host support and escape/resource configurations must be selected and verified before real execution.
**Project Type**: Local agent library/use-case with a thin JSON-file command adapter; adapter choice proposed here, not a new service.
**Performance Goals**: Bounded configurable operation time/resources and bounded evidence output; no invented latency/service SLA.
**Constraints**: No task-container network, no host/agent/credential/grading mounts, protected-content-excluded command views mounted read-only with only scratch writable, trusted-only canonical patch writes, prepared dependencies, structured executable/argv, finite trusted limits with no production defaults, three task-scoped material replans after initial plan.
**Scale/Scope**: One localized seeded bug first; full UC-03 repair/security/review acceptance follows. Initial target repositories roughly 1,000–10,000 lines. No deployment, generic planning system, issue triage, UC-04 feature route or UC-05 duplicate gate.

## Constitution Check

Pre-research inspection: `.specify/memory/constitution.md` is an unratified placeholder template. A constitution pass cannot be asserted. Repository instructions, accepted ADR-0001/0002/0003 and current security/state contracts govern this draft. ADR-0004 now records accepted approval/replan decisions and closure; exact shared approval binding and accounting details remain T001 signoff items. Feature implementation is still not authorized by an accepted ADR alone.

| Gate | Draft design assessment | Implementation release condition |
|---|---|---|
| Scope and source authority | PASS: only UC-03 plus explicitly assigned shared foundation | T001 records feature approval and resolves constitution governance; no implicit ratification |
| Security before real execution | PASS as design: fail closed, real boundary required | T024/T025 prove policy, gate and isolation before executing real workflow |
| Shared ownership | PASS as proposal: Tai foundation; Thanh Tan UC-04; Trong Tan UC-05 | T001 owner agreement on contract v0.1, paths and UC-05 plan binding |
| Completion evidence | PASS as design: baseline, final checks and reviewer bound to final state | T028–T033 real integration evidence |
| Open choices | Drafting can proceed; implementation readiness NOT PASSED | T001 records decisions, finite configurations consistent with accepted ADR-0004; approvals are not inferred from this request |

Post-design recheck: same conditions remain; no unresolved behavioral clarification was hidden. Draft plan/tasks are complete for review, not finalized approved implementation instructions. Conditional choices have named decision owners and tasks instead of invented approvals.

## Project Structure

### Documentation (this feature)

`specs/005-uc03-bug-fix/`: spec.md, plan.md, research.md, data-model.md, quickstart.md, contracts/interfaces.md, contracts/acceptance.md, tasks.md, checklists/requirements.md, checklists/planning-validation.md. See the [requirements checklist](checklists/requirements.md), [planning validation checklist](checklists/planning-validation.md) and [source/verification record](../../docs/verification/2026-10-16-uc03-planning.md).

### Source Code (repository root)

All paths below are proposed future ownership; this change creates none of them.

```text
src/contracts/uc03.ts              # Tai: canonical ports and runtime validators
src/foundation/model.ts            # Tai: model/provider boundary
src/foundation/docker-workspace.ts # Tai: container lifecycle and executor
src/foundation/repository-tools.ts # Tai: controlled tools
src/foundation/execution-guard.ts  # Tai: isolation/limits and UC-05 gate composition
src/foundation/reviewer.ts         # Tai: shared read-only runtime reviewer (proposed assignment)
src/foundation/telemetry.ts        # Tai: sanitized events/accounting projection
src/uc03/input.ts                  # Tai: intake
src/uc03/investigation.ts          # Tai: baseline and plan
src/uc03/verification.ts           # Tai: verification/completion gate
src/uc03/repair.ts                 # Tai: repair/replan semantics
src/uc03/graph.ts                  # Tai: LangGraph wiring
src/uc03/report.ts                 # Tai: activity and final delivery
src/cli/uc03.ts                    # Tai: thin local entry point
src/persistence/                   # UC-04 / Thanh Tan; external dependency
src/approvals/                     # UC-05 / Trong Tan; external dependency
tests/runtime/{contract,unit,integration,security}/
tests/runtime/support/uc03/        # Tai: controlled mocks, never production imports
eval/uc03/                        # Tai: manifest, runner and grader
fixtures/uc03/                    # Tai: public prepared Python bug/attack repos
eval/uc03/private/                # Host-only grading, excluded from agent authority
```

**Structure Decision**: Capability modules with injected ports and acyclic dependencies. UC-03 uses contracts; composition wires the real ports only after gates pass. One ready task owns each file; workers receive disjoint paths. T011/T016/T021 own minimal runnable SUT skeletons with their behavioral RED tests, then transfer source ownership to dependent implementation tasks; the skeletons provide signatures and neutral incomplete behavior, not the real implementation. No separate HTTP/gRPC executor. The runtime reviewer is Tai's proposed shared-foundation responsibility, requiring acceptance at T001 rather than treating CodeRabbit as runtime review.

## Design and Integration Strategy

1. Review behavioral spec before technical design. [Research](research.md) records evidence and choices. [Data model](data-model.md) and [interfaces](contracts/interfaces.md) define a single proposed v0.1 contract consumed by both mocks and later real adapters.
2. T001 agrees contracts/governance/stack and external deliverables. T002/T003 prepare runtime bootstrap and validators; T004 creates controlled mock ports. These are the minimal development prerequisites; real tools, UC-04 and UC-05 do not serialize mock-backed story development.
3. Build success, repair, security fixtures, tool boundary, reviewer and telemetry on disjoint paths. US2 and US3 can use scenario-state fixtures without depending on completed US1 implementation. Phase order in tasks.md groups stories; the DAG controls readiness.
4. T024/T025 verify real Docker security and compose the real action gate before any real UC-03 mutation. T028 replaces all workflow mocks with UC-04/UC-05 adapters and proves a seeded fix. T029/T030/T031 cover real repair/review/attacks; T032 proves process restart and approval together. T033 evaluates/compares two complete runs.
5. Command execution uses the read-only, protected-content-excluded views defined in contracts/interfaces.md; a writable task repository is never exposed to pytest. T006/T007/T022 implement the boundary, and T024/T031 prove malicious process reads/writes are denied. T008 and T009 reserve/settle token/cost allowances through UC-04 before every host provider dispatch; T028/T030/T032 cover missing/exhausted budgets and interrupted calls.
6. Evidence is bound to workspace revision/diff digest and configured checks; production changes make prior verification/review stale. Only a harness completion predicate can emit verified delivery.

## External Deliverables (not local task IDs)

| ID | Owner | Required contract/evidence | Consumer and mock |
|---|---|---|---|
| X04-STATE | Thanh Tan, UC-04 | Durable task/step/checkpoint storage, atomic multi-budget reservation/settlement including coder/reviewer provider requests, canonical workspace/view identity, drift validation, uncertain-effect/usage reconciliation and restart | T028/T032; T004 MemoryStatePort is deterministic test-only, has no durability claim |
| X05-GATE | Trong Tan, UC-05 | Action classification/binding, durable pending decision, exact continuation, forbidden/rejected equivalence handling and plan-version approval | T025/T028/T032; T004 ScriptedApprovalPort queues explicit decisions only |
| X04-X05-RESTART | Thanh Tan + Trong Tan | Pending approval/reservation and post-effect crash recover without reset/duplication | T032; test restart simulation is insufficient for final evidence |

IDs are delivery references, not fabricated UC-04/UC-05 task numbers. Link their actual approved ledgers/revisions when available. Missing real adapters delays only affected integration; it does not mark mock-capable work BLOCKED. A required real-only test is BLOCKED only after checking whether any remaining local setup/scenario work can proceed, with owner and missing evidence recorded.

## Complexity Tracking

No justified policy exception or additional service. Placeholder constitution and pending decisions are readiness gaps, not waived violations. Keep numeric budgets configurable and fail closed; a finite test profile is not a production default.

Publication only: [Post-SDD handoff](../../docs/verification/2026-10-16-uc03-post-sdd.md) records transfer to review branch 007 while preserving feature directory 005 and all T001–T034 IDs. No Specify, Plan or Tasks generation was rerun; approval remains pending.
