# Implementation Plan: UC-03 — Verified Code Repair

**Branch**: `feat/001-verified-code-repair` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: `/specs/001-verified-code-repair/spec.md`
**Status**: User-recorded authorizations and remaining scope gates are in [decisions](contracts/decisions.md); task status reports implementation progress only and does not confer permission.

## Summary

Implement a localized bug-fix route through validation, adaptive investigation/reproduction, persisted baseline/plan, human plan approval, controlled patch, focused/regression verification, separate read-only review and delivery. Repair and material replan routes return through the same gates. TypeScript/LangGraph orchestrates on the trusted host; shared tools act through Docker into a disposable Python/pytest task workspace. Shared persistence and approval remain owned by UC-04/UC-05.

## Technical Context

**Language/Version**: TypeScript, strict mode; Node.js 24 LTS selected explicitly for Phase 1. Exact compiler version is pinned in package.json.
**Primary Dependencies**: Official `@langchain/langgraph`, pnpm/pnpm-lock, strict tsc, ESLint/typescript-eslint and Node tests selected for Phase 1. Exact direct versions are pinned in package.json. Provider/model and schema tooling remain future choices; Docker remains the approved target execution boundary.
**Storage**: UC-04 durable task/checkpoint/budget port; backend selected by Thanh Tan, not a UC-03 local database.
**Testing**: Built-in Node tests on compiled TypeScript for the runtime bootstrap; Python/pytest inside a prepared image for later target-repository checks. Contract, behavioral, isolation and real integration suites remain required in their later tasks. Existing contributor `node --test` remains distinct.
**Target Platform**: Trusted host with Docker Linux task containers; concrete host support and escape/resource configurations must be selected and verified before real execution.
**Project Type**: Local agent library/use-case with a thin JSON-file command adapter; adapter choice proposed here, not a new service.
**Performance Goals**: Bounded configurable operation time/resources and bounded evidence output; no invented latency/service SLA.
**Constraints**: No task-container network, no host/agent/credential/grading mounts, protected-content-excluded command views mounted read-only with only scratch writable, trusted-only canonical patch writes, prepared dependencies, structured executable/argv, finite trusted limits with no production defaults, three task-scoped material replans after initial plan.
**Scale/Scope**: One localized seeded bug first; full UC-03 repair/security/review acceptance follows. Initial target repositories roughly 1,000–10,000 lines. No deployment, generic planning system, issue triage, UC-04 feature route or UC-05 duplicate gate.

## Constitution Check

Governance: .specify/memory/constitution.md remains an unratified placeholder template, not an asserted constitution pass. The decision record applies AGENTS.md, context policy and accepted ADRs without ratifying the placeholder. The table below records the original draft gates; user-recorded authorizations and changes to scope are maintained in [decisions](contracts/decisions.md). Production choices still gate real execution as recorded there. Repository instructions, accepted ADR-0001/0002/0003 and current security/state contracts govern this feature. ADR-0004 records accepted approval/replan decisions and closure; T001 records the exact shared binding/accounting agreement. Accepted ADRs alone do not authorize later implementation phases.

| Gate | Draft design assessment | Implementation release condition |
|---|---|---|
| Scope and source authority | PASS: only UC-03 plus explicitly assigned shared foundation | T001 records feature approval and resolves constitution governance; no implicit ratification |
| Security before real execution | PASS as design: fail closed, real boundary required | T024/T025 prove policy, gate and isolation before executing real workflow |
| Shared ownership | PASS as proposal: Tai foundation; Thanh Tan UC-04; Trong Tan UC-05 | T001 owner agreement on contract v0.1, paths and UC-05 plan binding |
| Completion evidence | PASS as design: baseline, final checks and reviewer bound to final state | T028–T033 real integration evidence |
| Open choices | Drafting can proceed; implementation readiness NOT PASSED | T001 records decisions, finite configurations consistent with accepted ADR-0004; approvals are not inferred from this request |

Current user-recorded authorizations and scope gates are in [decisions](contracts/decisions.md). This plan describes design and dependencies; task checkboxes record implementation progress only and do not authorize work.

## Project Structure

### Documentation (this feature)

`specs/001-verified-code-repair/`: spec.md, plan.md, research.md, data-model.md, quickstart.md, contracts/interfaces.md, contracts/acceptance.md, tasks.md, checklists/requirements.md, checklists/planning-validation.md. See the [requirements checklist](checklists/requirements.md), [planning validation checklist](checklists/planning-validation.md) and [source/verification record](https://github.com/pminhtaiii/slop-loop/blob/2e6455fa77d6849c0711174cecca441d78a2f5c3/docs/verification/2026-10-16-uc03-planning.md).

### Source Code (repository root)

The paths below remain the future product-runtime layout. Phase 1 adds build/lint/CI configuration and a dependency smoke test, rather than these product modules.

```text
src/contracts/foundation/uc03.ts              # Tai: canonical ports and runtime validators
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

### Atomic Admission Amendment Integration (Approved Design / Not Implemented)

On 2026-10-22 (Asia/Saigon), following independent reviews, the user confirmed that Thanh Tan (UC-04) and Trong Tan (UC-05) agreed to the reviewed [atomic admission amendment](contracts/atomic-admission-amendment.md), and explicitly approved the design and preparation of scoped implementation tasks (recorded in [contracts/decisions.md](contracts/decisions.md#atomic-admission-amendment-approval-and-task-preparation)).

- **Contract Version Migration**:
  - UC-03 canonical contracts and task-state schema migrate from `0.1.0` to `0.2.0` (`src/contracts/foundation/uc03.ts` and related modules).
  - UC-05 companion contracts migrate from `uc05-approval/0.1-draft` to `uc05-approval/0.2-draft` (`src/contracts/approvals/contracts.ts`).
  - Producers, validators, consumers, CLI and mock fixtures migrate together; legacy `0.1` continuation receipts or raw claim IDs are rejected as executor authority.
- **Architectural Seams and Authority**:
  - **UC-04**: Owns the single durable task/control journal, claim lifecycle (`claimed -> attempting -> dispatched -> outcome-recorded -> settled`), reservations, single-use attempt consumption at `beginAttempt`, outcome journal, and recovery operations (`reconcileObservedOutcome`, `reconcileUncertain`, `closeUnattemptedClaim`). Where actual adapter paths are absent in this repository, canonical contracts and test-only controlled mocks (`MemoryStatePort`) are used; real persistence remains an external dependency (`X04-STATE`).
  - **UC-05**: Owns policy evaluation, immutable decision validity, and provider admission. Stages immutable policy/config and decision records, then publishes active refs/generations into the UC-04 journal before `beginAttempt`. Issues `PolicyEvaluationReceipt`, `ActionDecisionReceipt`, and distinct `ProviderAdmissionReceipt` (for coder and reviewer roles, with explicit plan applicability).
  - **UC-03 / Shared Foundation**: Owns the workspace gate (read lease for immutable command views, exclusive writer lease for patches spanning invoke through outcome settlement), authenticated executor incarnation validation, process-local one-shot gate backed by UC-04's durable attempt record, and single-owner repair accounting.
- **Work Sequence (Decomposed into T037–T050)**:
  1. **W1 (T037–T040)**: Canonical types, ports, validators, and contract conformance vectors (contract v0.2.0).
  2. **W2 (T041–T044)**: UC-04 StatePort journal contracts / memory-state mock and UC-05 policy/service/continuation mock migration (`uc05-approval/0.2-draft`).
  3. **W3 (T045–T046)**: Workspace gate, command-view bounds, and host provider model boundary with receiver one-shot gate.
  4. **Guard Composition (T022)**: Compose authoritative execution checks in `src/foundation/execution-guard.ts` over the amended contracts.
  5. **W4 (T047–T048)**: UC-03 consumer migration: single-owner repair accounting and guarded `runTests` in investigation and verification.
  6. **W5 (T049–T050)**: Mock fixture infrastructure migration and full deterministic barrier/race/recovery test suite (`tests/runtime/contract/atomic-admission.test.ts`).
- **Release and Authorization Boundaries**:
  - Task decomposition in `tasks.md` defines scoped worker assignments; task IDs confer no implementation permission.
  - T022 remains unchecked and incomplete until predecessor contract and executor tasks are implemented and verified.
  - Phase 6 (`T026+`), real adapters (`X04-STATE`, `X05-GATE`), real container isolation (`T024`), production choices, and real execution remain strictly gated.

## External Deliverables (not local task IDs)

| ID | Owner | Required contract/evidence | Consumer and mock |
|---|---|---|---|
| X04-STATE | Thanh Tan, UC-04 | Durable task/step/checkpoint storage, atomic multi-budget reservation/settlement including coder/reviewer provider requests, canonical workspace/view identity, drift validation, uncertain-effect/usage reconciliation and restart | T028/T032; T004 MemoryStatePort is deterministic test-only, has no durability claim |
| X05-GATE | Trong Tan, UC-05 | Action classification/binding, durable pending decision, exact continuation, forbidden/rejected equivalence handling and plan-version approval | T025/T028/T032; T004 ScriptedApprovalPort queues explicit decisions only |
| X04-X05-RESTART | Thanh Tan + Trong Tan | Pending approval/reservation and post-effect crash recover without reset/duplication | T032; test restart simulation is insufficient for final evidence |

IDs are delivery references, not fabricated UC-04/UC-05 task numbers. Link their actual approved ledgers/revisions when available. Missing real adapters delays only affected integration; it does not mark mock-capable work BLOCKED. A required real-only test is BLOCKED only after checking whether any remaining local setup/scenario work can proceed, with owner and missing evidence recorded.

## Complexity Tracking

No additional service or runtime-policy exception. The user-approved amendment permits bootstrap while production choices remain release gates; the placeholder constitution is not implicitly ratified. Keep numeric budgets configurable and fail closed; a finite test profile is not a production default.

Publication only: [Post-SDD handoff](https://github.com/pminhtaiii/slop-loop/blob/ee5be9b147efb44511b8e65ece375fc904c5f062/docs/verification/2026-10-16-uc03-post-sdd.md) records transfer to review branch 007 while preserving feature directory 005 and all T001–T034 IDs. No Specify, Plan or Tasks generation was rerun. This historical handoff predates the user-requested rename to feature 001 and Phase 1 authorization recorded above.
