# Implementation Plan: UC-04 — Multi-step Feature with Resume

**Branch**: `feat/037-uc04-recovery-spec` | **Date**: 2026-10-21 (Asia/Saigon) | **Spec**: [spec.md](spec.md)

**Input**: `specs/037-uc04-recovery/spec.md`

**Status**: Proposed staged design only. All implementation tasks remain unchecked and unauthorized. [Decisions](contracts/decisions.md) distinguishes inherited agreement, authoring delegation, new proposals and unresolved release gates.

## Summary

Build a durable pause/recovery foundation for a scripted multi-step task before integrating the feature workflow. One UC-04 state authority owns checkpoints, task/step transitions, accounting and reconciliation. Reuse canonical foundation contracts and UC-05 control/journal transactions. Separate intentional pause from approval/rejection holds and from uncertainty. Prove storage with actual process termination; external controlled seams never establish integrated runtime capability.

## Technical Context

**Language/Version**: Approved TypeScript 6.0.3, strict NodeNext ESM; Node.js 24 LTS and pnpm 12.5.1. No toolchain change.

**Primary Dependencies**: Existing canonical 0.1.0 contracts and UC-05 companion validators, Node test runner; official `@langchain/langgraph` remains shared orchestration. No new library/service selected.

**Storage**: UC-04-selected durable backend/checkpointer at G-STORE; currently unselected. [Interfaces](contracts/interfaces.md) specifies required observable transactions, independent of technology. LangGraph presence alone supplies no durability guarantee.

**Testing**: Contract/behavior/concurrency tests against actual UC-04 exports; controlled external seams; subprocess kill/restore with a real selected durable adapter; later shared-executor/UC-05 integration. Every result declares evidence level.

**Target Platform**: Trusted local host, support/storage crash model to be agreed at G-STORE. Contributor Windows/Ubuntu CI is not a product-host certification. Docker repository operations stay owned by Tai.

**Project Type**: Internal persistence/recovery boundary plus scripted validation driver; no second approval service, executor, production CLI or generic planning system.

**Performance Goals**: Finite configured operation/input/output limits, no invented latency/SLA/throughput target. Recovery scans and status/history reads must be bounded under the selected profile.

**Constraints**: Reserve durably before effects; retain unresolved charge/claims; stable task identity; fresh repository/approval admission; structured state inaccessible to repository code; no raw protected evidence in history. Storage failure closes admission.

**Scale/Scope**: One scripted task with several steps plus an unrelated task for isolation. Foundation actual process restart first; integrated feature workflow and cross-task memory separately gated later.

## Constitution Check

The constitution is a placeholder, not ratified policy. Apply AGENTS/context/ADRs. Pre-design and post-design assessment:

| Gate | Design assessment | Implementation release |
|---|---|---|
| Scope | Foundation follows ADR-0007; integration/memory separated | G-AUTH for each phase |
| Ownership | UC-04 persistence; UC-05 validity; Tai shared tools/verification | G-EXTENSION confirms proposed paths and pause representation |
| Durable control | CAS, coherent checkpoint, atomic reservations/claims; fail closed | G-STORE and actual crash/concurrency evidence |
| Security | Host-only state, bounded metadata, no approval bypass | G-PROFILE and actual shared executor before real repository effects |
| Evidence | Mock, durable foundation and integrated restart distinct | All required cases for each claimed level |
| Open decisions | Explicit external release gates, no technology default | Implementation readiness remains closed |

The planning quality audit may pass for this conditional design; it does not resolve these release gates. No implementation handoff is authorized.

## Project Structure

### Documentation (this feature)

`spec.md`, `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, `tasks.md`, `contracts/{interfaces,acceptance,decisions}.md`, `checklists/{requirements,planning-validation}.md`.

### Source Code (repository root)

Proposed future paths only, subject to G-EXTENSION; none is created by planning:

```text
src/persistence/
  contracts.ts       # recovery-specific validated extension, reusing canonical records
  store.ts           # backend-independent transaction facade; selected adapter behind it
  accounting.ts      # atomic reservation/settlement and configuration history
  task-control.ts    # independent deliberate pause plus inherited approval transactions
  recovery.ts        # validation, reconciliation and safe continuation
  inspection.ts     # safe status/history and advisory compaction
tests/runtime/uc04/
  contracts.test.ts  store.test.ts  accounting.test.ts  control.test.ts
  recovery.test.ts   inspection.test.ts  restart.test.ts  integration.test.ts
tests/runtime/support/uc04/
  scenarios.ts  controlled-ports.ts  restart-child.ts
```

**Structure Decision**: Thanh Tan owns `src/persistence/` and UC-04 tests. Tai retains canonical foundation contracts, model/repository tools, workflow/verification/evaluation; Trong Tan retains approval contracts/service/control/CLI and UC-05 tests. No UC-04 task writes foreign files. Backend-specific paths/migrations must be added to the approved plan/ledger after selection, before adapter implementation.

## Design and Integration Strategy

1. Agree exact extension/paths and later phase release first (T001). Preserve executable canonical signatures and `uc05-approval/0.1-draft`; never append a `paused` mode to existing approval records without joint versioned agreement.
2. Define recovery extensions/cases and controlled external seams (T002–T003). Actual store facade/selected adapter (T004) is gated on G-STORE and plan amendment with exact adapter paths; no in-memory fallback can satisfy it.
3. Build US1 recovery with saved-state fixtures; US2 task control and US3 accounting use disjoint source paths. State store remains the only transactional authority. Safety admission depends on all required modules, regardless of story ordering.
4. US4 adds inspectable state and summary validation without implementing deletion. T012 actually kills/restores the scripted runtime with the real durable store and every foundation mechanism; external policy/tools remain controlled. This is a foundation durability milestone only.
5. T013 integrates actual UC-05 and Tai admission/verification when their owner releases/adapters arrive. T014 records scoped evidence/handoff. Integrated feature workflow and memory require new approved design/tasks at G-FEATURE/G-MEMORY; this ledger does not fabricate those contracts.

## External Deliverables (not local task IDs)

| Reference | Owner / needed evidence | Consumed by |
|---|---|---|
| X05-GATE | Trong Tan: actual decision/freshness/task control adapter, compatible schema/config/source revision, retained holds and immutable history | T013; scripted approval seam only before it |
| X03-ADMISSION | Tai: actual shared task-wide admission, repo/view inspector, executor effect reconciliation, verification and finite profiles | T013; no alternate UC-04 tool runner |
| X04-STATE | Thanh Tan output: accepted durable state/accounting/checkpoint/recovery revision and conformance/restart evidence | UC-03 T028/T032 only after their own release |
| X04-APPROVAL-STORE | Thanh Tan output: UC-05 companion transactions, journal/epoch/claims and restart evidence | UC-05 T020/T021 after their release |
| X04-X05-RESTART | Joint output: actual integrated pending/decision/claim/effect restoration evidence | T013 and foreign acceptance; foundation seam results cannot substitute |

External names are delivery references, not invented foreign task numbers. Record actual owner ledger/adapter/config revisions at consumption. Their agreement is not their availability. Partial preparation can proceed after its own authorization while real integration remains pending.

## Complexity Tracking

Independent deliberate pause is needed because existing approval modes do not encode ADR-0007 behavior. A proposed sidecar record composes with unchanged approval modes; it requires G-EXTENSION agreement. Duplicating control/accounting or choosing storage implicitly would be simpler to write but violate shared authority. No runtime-policy exception is proposed.
