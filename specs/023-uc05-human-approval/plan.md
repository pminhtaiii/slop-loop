# Implementation Plan: UC-05 — Bound Human Approval and Safe Continuation

**Branch**: `feat/023-uc05-human-approval-spec` | **Date**: 2026-10-19 (Asia/Saigon) | **Spec**: [spec.md](spec.md)

**Status**: Separately authorized T001–T007 and the T023 correction of T007 are complete locally through integration commit `2b80b76` on 2026-10-19 (Asia/Saigon). Phase 3 uses four user-confirmed TDD seams with explicit mock store/context and test-only CLI composition. Later story/delivery tasks T008–T022, production profiles and real runtime integration remain gated. See [decisions](contracts/decisions.md) and the [task ledger](tasks.md).

## Summary

Build a task-scoped deterministic approval service and trusted local operator CLI. Reuse canonical UC-03 action/binding validators and the existing ApprovalPort interface. UC-04 supplies durable approval/control transactions; Tai's scheduler, model boundaries and execution guard enforce the task-wide admission barrier. UC-05 never executes repository commands or owns storage. Preserve immutable human decisions, exact-state approval, separate plan/action gates, and uncertain-effect reconciliation.

## Technical Context

**Language/Version**: Existing TypeScript 6.0.3, strict NodeNext ESM, Node.js 24 LTS.

**Primary Dependencies**: Existing Node built-ins and canonical UC-03 contracts; propose no new CLI/schema dependency. LangGraph remains the host workflow library; UC-05 adds no second graph.

**Storage**: Injected UC-04 companion ApprovalStorePort, described in [interfaces](contracts/interfaces.md); no backend selected by UC-05. Test doubles remain explicitly mock.

**Testing**: Node built-in runner, test-first behavioral slices, canonical conformance, subprocess CLI checks and later real restart/integration checks. [Acceptance](contracts/acceptance.md) owns the finite case catalog.

**Target Platform**: Local trusted host CLI; unit/CLI validation targets existing contributor Windows and Ubuntu jobs. Real Docker and durable restart support is conditional on the host profile delivered by Tai/UC-04, with unsupported platform cases explicitly not run.

**Project Type**: Internal approval module plus host CLI adapter; no HTTP service, web app, provider selection or new persistence engine.

**Performance Goals**: No LLM call, child process, network request or whole-repository scan per policy classification. Compile stable policy once; re-read mutable trusted context before admission. Numeric production latency goals/benchmark workloads remain outside this version, as ADR-0006 deferred them; no unapproved performance value is invented.

**Constraints**: Fail closed on incomplete policy/context/storage, protect source/secret boundaries, preserve exact canonical digests and decisions, serialize pending approvals per task, bound inputs/output/attempts under explicit configuration.

**Scale/Scope**: One trusted local developer; multiple isolated task identities, at most one pending approval per task. Five stories; UC-05 policy/decisions only, with external real-execution/recovery gates.

## Constitution Check

The constitution remains an unratified placeholder. Governance comes from [AGENTS.md](../../AGENTS.md), [planning workflow](../../context/planning.md), accepted ADR-0004/0006 and current runtime context. This table is a design check, not ratification or implementation approval.

| Gate | Design result | Release condition |
|---|---|---|
| Scope/ownership | UC-05 classification/decision validity and companion ownership agreed through T001 confirmation | Preserve Tai/Thanh Tan boundaries in later implementation |
| Security | Forbidden wins; operator input is not executor authority | Policy fixtures and real containment evidence before production |
| Shared contracts | Canonical schema 0.1.0 unchanged; companion logical contract agreed; T002 validators and test-only T004 ports are implemented | Real store, production composition and runtime conformance remain gated |
| Durable control | Proposed UC-04 transactions and shared admission epochs | Real store, scheduler/model/executor composition before integration |
| Evidence | Local mocks, CLI, real tools and restart have distinct levels | Required cases observed; unrun cases prevent VERIFIED claims |
| Authorization | T001–T007 authorized in separate phases; shared agreement and Phase 3 test seams confirmed | T008 onward needs separate authorization; production execution remains separately gated |

Recheck these gates after design changes; a clean planning audit does not satisfy external delivery or authorization gates.

## Project Structure

### Documentation (this feature)

`spec.md`, `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, `tasks.md`, `checklists/requirements.md`, `checklists/planning-validation.md`, and `contracts/{interfaces,policy,cli,acceptance,decisions}.md`.

### Source Code (repository root)

Owned paths across the delivery plan; tasks.md distinguishes implemented local slices from gated future files:

```text
src/contracts/approvals/
  contracts.ts       # companion records, validation and typed safe outcomes
src/approvals/
  policy.ts          # deterministic policy compilation/classification
  service.ts         # canonical ApprovalPort implementation
  control.ts         # pause/decision/continuation coordination through ports
  plan-binding.ts    # exact-state plan/action checks; no schema replacement
  presentation.ts    # bounded protected-data-checked CLI projection
  cli.ts            # explicit operator commands; no repository execution
tests/runtime/approvals/
  contracts.test.ts  policy.test.ts  service.test.ts  control.test.ts
  plan-binding.test.ts  cli.test.ts  audit.test.ts
  integration.test.ts  restart.test.ts  acceptance.test.ts
tests/runtime/support/uc05/
  fixtures.ts  mock-store.ts  mock-context.ts
```

Tai retains `src/contracts/foundation/uc03.ts` and `src/foundation/`; Thanh Tan retains `src/persistence/`. UC-05 tasks do not edit these foreign paths. External owners implement their adapters under their own approved ledgers.

**Structure Decision**: Keep CLI translation, policy and control separate behind small explicit ports; share one authoritative UC-04 control store and one execution guard. [Data model](data-model.md) defines records; [interfaces](contracts/interfaces.md) defines transactions and race behavior.

## Design and Integration Strategy

1. T001 records owner agreement on the proposed companion contract and explicit finite profiles before runtime edits. T002–T004 produce record validators, versioned scenarios and mock ports, without real storage or executor claims.
2. T005–T007 deliver US1 classification/service/CLI against explicit mock dependencies. Every action still checks task control; allowed operations are not a pause bypass. Safe presentation and protected-data rejection ship before the first prompt, rather than wait for US5 polish.
3. T008–T010 deliver US2 task-wide pause/rejection and operator direction; T011–T013 add US3 exact plan/action binding and duplicate/conflict checks. T014–T015 prepare US4 recovery admission with mock-only evidence.
4. T016–T018 add US5 safe audit coverage and full decision/outcome projection. T019 prepares a complete mock-backed acceptance run; T020/T021 separately prove actual integrated execution and restart using real external adapters.
5. T022 refreshes evidence/context and hands off X05-GATE only for the tested scope. Planning does not pre-check any implementation task.

Plan coverage remains conservative: canonical v0.1 requires an approved plan at the current repository digest. A further production patch after any digest change requires a new immutable plan request/decision, even for expected prior edits. An unchanged strategy does not consume a replan; explain the concrete state change. Prefer one coherent bounded patch when practical. Never silently rebind approval, add a covered-evolution ledger, or introduce path-only security prompts. Richer multi-patch coverage would require a separately agreed canonical migration.

## External Deliverables (not UC-05 task IDs)

| Reference | Owner | Required capability | Local consumer |
|---|---|---|---|
| X04-APPROVAL-STORE | Thanh Tan | Durable transactions, immutable decision journal, task control/epoch, claims, accounting and recovery | T020/T021; T004 mock is not replacement evidence |
| X03-ADMISSION | Tai | Scheduler, coder/reviewer model, tools and background admission consult the same control epoch; real isolation, locked current repository state and pre-effect claims | T020/T021 |
| X03-PLAN-CONTEXT | Tai/UC-03 | Trusted baseline/criteria/strategy/materiality and canonical current-state plan admission | T013, real T020 |
| X04-X05-RESTART | Thanh Tan + Trong Tan, Tai integration | Actual kill/restart at decision/claim/effect boundaries and no blind replay/budget reset | T021 |

These are proposed delivery references, not invented foreign tasks or proof of existing adapters. Record owner ledger links, contract/config versions, source revisions and actual evidence before real integration. Missing adapters do not block preparation of local validators/cases/mocks; they block only affected real acceptance. X05-GATE is the UC-05 deliverable consumed by UC-03 T025/T028/T032.

## Complexity Tracking

The companion UC-04 control contract is necessary because current ApprovalPort/StatePort do not express durable task-wide pause, immutable request resolution or dispatch fencing. No schema fork, second storage engine, command runner or automatic retry loop is justified. Detailed rationale and alternatives are in [research](research.md).
