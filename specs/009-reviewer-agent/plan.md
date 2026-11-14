# Implementation Plan: UC-06 — Reviewer Agent

**Branch**: `feat/uc06-reviewer-planning` | **Date**: 2026-11-12 (Asia/Saigon) | **Spec**: [spec.md](spec.md)
**Input**: specs/009-reviewer-agent/spec.md
**Status**: [Decisions](contracts/decisions.md) own release/owner gates; T002 and Phase 3 T003–T006 have separate source/controlled releases. Dependency and acceptance gates remain mandatory.

## Summary

Reuse existing createRuntimeReviewer and UC-03 post-verification route. Add a versioned context/observation companion, stronger opt-in evidence/location/output validation, trusted reviewer-role prompting in existing transport, and matching graph context mint/dispatch/completion. Extend existing evaluation registration; preserve external accounting/approval/recovery ownership.

## Technical Context

**Language/Version**: Existing strict TypeScript 6, Node.js 24 LTS, pnpm 12.5.1; exact versions pinned in repo.
**Primary Dependencies**: Existing LangGraph, Node built-ins, canonical contracts. No new packages/SDK/services.
**Storage**: UC-04 task/control/journal/evidence capabilities; no new database/checkpointer/ledger.
**Testing**: Node source/emitted behavioral tests, actual reviewer/model ingress with controlled transports, then separately gated Python/pytest real workflow, independent quality and subprocess restart.
**Target Platform**: Existing trusted host/prepared isolated task workspace; actual image/engine/profile approval remains external.
**Project Type**: Internal product library used by UC-03; no new CLI/HTTP/UI.
**Performance Goals**: One provider request per admitted review, finite time/input/output/finding/token bounds, no automatic retry or invented SLA.
**Constraints**: Read-only approved context, exact identity/fencing, no secrets/private grader/raw trace, task-wide waits, cumulative owner accounting.
**Scale/Scope**: Bounded textual modify/add/delete; unsupported diff kinds fail closed.

## Constitution Check

Constitution remains unratified template. Existing AGENTS/context/accepted ADRs govern pre-research and post-design; no fabricated constitution pass.

| Gate | Design assessment | Release condition |
|---|---|---|
| Scope | US1–US3, one reviewer, UC-03 trigger | Explicit G-AUTH and UC-06 assignment |
| Seams | Unchanged canonical v01/v02; additive companion/host parameters | G-OWNER exact API/path agreement |
| Security | Immutable data/model only; no tool authority | Controlled zero-effect attacks; real G-DELIVERY/G-SECURITY |
| Finite spend/control | HostModelPortV02 + UC-04/UC-05 reused | Explicit finite profile/atomic receipts; no production defaults |
| Evidence | Actual reviewer/scripted and controlled/real/quality/restart separate | Contract matrix, independently judged candidate evidence |
| Recovery | One owner, reconciliation before retry | G-RESTART actual process-kill witnesses |

Post-design: no policy waiver. External approvals have precise opening evidence; they are not unresolved technical placeholders.

## Project Structure

### Documentation (this feature)

spec.md, plan.md, tasks.md, research.md, data-model.md, quickstart.md, contracts/{decisions,review-context,evaluation}.md, checklists/.

### Source Code (planned after release)

| Change class | Exact paths | Ownership / purpose |
|---|---|---|
| New | src/contracts/review.ts; src/uc06/validation.ts | Trọng Tấn, UC-06; T002 pure source/controlled prerequisite accepted; no owner authority |
| New | src/uc06/context.ts | Trọng Tấn consumes host records, builds immutable projection; no IO/storage authority; T003 source/controlled release only |
| Extension | src/foundation/reviewer.ts | Tai; opt-in resolver, shared snapshot/digest companion and stricter output/evidence validation |
| Approved T004 extension | src/foundation/model.ts; tests/runtime/unit/model.test.ts | User-relayed Tai agreement on 2026-11-13; token-boundary correction only, preserve actual credential refusal |
| Extension | src/foundation/deepseek-transport.ts | Tai; trusted role prompt/schema branch; retain coder/transport/accounting |
| Extension | src/uc03/graph.ts; src/uc03/graph-types.ts; src/uc03/graph-types-v02.ts; src/uc03/graph-v02.ts; src/uc03/graph-state.ts; src/uc03/graph-review.ts; src/uc03/graph-completion.ts; src/uc03/verification-types.ts; src/uc03/verification-review.ts | Tai; v0.2 propagation, context resolution/admission, both Review/Deliver completion calls |
| Extension of existing evaluation system | eval/uc06/catalog.ts; eval/uc06/grade.ts; eval/uc06/registration.ts; eval/shared.ts; eval/shared-types.ts | Tai evaluation + independent labels; additive capability-aware v2, retain v1 real refusal |
| Reuse unchanged | src/foundation/model-v02.ts; src/foundation/provider-admission.ts; src/contracts/foundation/uc03.ts; src/persistence/; src/approvals/ | Existing owners; no parallel implementation or ownership transfer |

Exact tests and serialized path handoffs are in [tasks](tasks.md).

## Design and Integration Strategy

1. T001 records UC-06 assignment, shared-owner acceptance, permitted tiers and public capability use. Missing owner seam requires targeted amendment, never a cast/forged receipt.
2. T002 adds strict companion types/validation using canonical digests/path/review validators, leaving ReviewResult/ProviderRequest/owner wire schemas unchanged.
3. T003 assembles trusted measured base/head manifests, acknowledged baseline/checks, criteria/conventions and current owner authority from existing resolvers. Model/task-provided digests are comparison claims, never authority. T002 also defines the exact UC-04-owned ReviewEvidencePortV1 supplement; T006 consumes its persist/load/ACK contract with controlled doubles, and actual owner storage remains G-DELIVERY.
4. T004/T005 extend disjoint reviewer/transport files after T003. Mint/dispatch use identical context; trusted role/purpose selects schema/instructions. Credential/accounting behavior remains in existing adapter.
5. T006 resolves context before admission, replaces [] consistently, and requires current observation before Repair/Deliver. Both completion calls use fresh owner lookup. TaskState-only/lost-ACK continuation with no graph locator calls the supplement's recoverObservation by current measured candidate, then exact load; owner commits observation/ACK/discovery index atomically before acknowledging. Missing latest evidence or uncertainty stops safely without replay/older acceptance. No model-copied acknowledgment.
6. T007 exercises actual reviewer/HostModelPortV02 with hostile/failure vectors; T008 drives real graph transitions using controlled ports/fresh authority/new candidate evidence. No graph-side second reservation.
7. T009/T010 add frozen independent-label catalog/grade and registration through existing runner, preserving not-run coverage. Controlled handling is separate from quality.
8. T011 consumes predecessor route/owner/security proofs for one real integrated review; T012 evaluates the frozen quality set; T013 kills/restores process with actual durable owners. They remain unchecked/unreleased; no fabricated real success blocks useful controlled work.
9. T014 refreshes affected context and records criterion evidence for the explicitly released batch. Original ledgers retain acceptance ownership.

## Contract evolution and compatibility

[Contract](contracts/review-context.md) defines uc06-review-context/1 and uc06-review-observation/1, optional snapshot companion and opt-in host resolver. Existing five-argument review, canonical ReviewResult/ProviderRequest, v0.2 claims/receipts/digests and legacy consumers stay unchanged. Opted-in UC-06 refuses missing context; legacy controlled review cannot satisfy UC-06 and is never fallback for a failed bound review.

New owner wire requirements block the consumer until targeted versioned owner amendment/review/release. G-OWNER establishes agreement, not delivery. Serialize same-task reviews or use request-local observations because existing lastObservedUsage/lastFailureReason are mutable last-call diagnostics; never derive authoritative observations from a raced global getter.

## Verification and implementation strategy

Behavioral tests first; meaningful assertion RED requires existing neutral exports, not missing-file/import failure. Run focused source/emitted tests and typecheck/build at implementation checkpoints. [Evaluation](contracts/evaluation.md) maps all requirements/failures to task ownership.

MVP T001–T006 establishes US1 with authority/read-only invariants mandatory. T004/T005 can run in parallel only after prerequisites/paths are accepted; other shared files serialize. Add US2 attacks and US3 graph/evaluation next. Real/model-quality/restart need separate explicit releases and owner proofs, not completion of every other UC.

## Complexity Tracking

No policy exception or new service/provider/approval/ledger/persistence/runner. Three small new concerns (companion, assembler, validator) make existing inputs explicit; generation remains in existing reviewer/transport. Labels are evaluator-owned and outside model authority.
