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

### Atomic Admission Amendment Integration (Approved Design / Task Preparation Only)

On 2026-10-22 (Asia/Saigon), the user confirmed user-relayed agreement from Thanh Tan (UC-04) and Trong Tan (UC-05), and approved the amendment design plus preparation of scoped implementation tasks, as recorded in contracts/decisions.md#atomic-admission-amendment-approval-and-task-preparation. The task decomposition remains a draft pending two fresh independent planning reviews. This staging clarification does not redesign the approved protocol.

#### Versioned migration and checkpoint order

- UC-03 v0.2.0 and UC-05 uc05-approval/0.2-draft are introduced additively beside v0.1. Put new v0.2 port shapes in `src/contracts/foundation/uc03/ports-v02.ts`; leave the current v0.1 `ports.ts` interfaces and callers source-compatible throughout staged migration. Do not add required methods or optional-context overloads to a v0.1 port.
- Migrate validators, journal mock, UC-05 records and services, effect receivers, provider ingress, all forwarding fixtures, and UC-03 consumers in the task order in tasks.md. Each RED checkpoint has real neutral SUT exports and remains typecheck/build clean; source and emitted tests must reach behavioral assertions rather than fail at import/type/collection time. Each immediate GREEN successor passes the same focused source/emitted tests.
- The exact task pair, source command, emitted command, and expected RED/GREEN state are listed in the task ledger's Checkpoint matrix. Full typecheck and build remain green at every checkpoint.
- Keep legacy v0.1 interfaces source-compatible until migration is complete. A compatibility path, if retained, is separately versioned and test-only; it is fail-closed and cannot confer effect authority or satisfy v0.2 acceptance. No implicit production fallback is permitted.
- Only the explicit cutover task, after all migrated producers, receivers, fixtures and consumers pass, selects the v0.2 mock composition. This task preparation does not activate real effects, adapters, production profiles, or Phase 6.

#### Authority and invocation ownership

- UC-04 owns the only durable task/control journal, claim lifecycle, reservations, durable attempt consumption, outcome journal, and recovery. The repository MemoryStatePort addition is a deterministic test mock only; actual X04-STATE adapter paths remain external and must be named by that owner before real adapter work.
- UC-05 retains policy evaluation, approval decisions, and provider admission authority. Its policy/config publication request uses the UC-04 journal boundary; no second journal is added under src/approvals. UC-05 companion records and mock fixtures do not prove an external adapter exists.
- UC-03/shared foundation owns workspace leases, immutable command views, and the trusted receiver. In repository-tools.ts, applyPatch, runCommand, and runTests call UC-04 beginAttempt once and pass the exact attempt identity forward. StructuredCommandExecutor.execute authenticates the adapter incarnation/fencing generation and consumes the local serialized one-shot immediately before the Docker controller invocation at docker-workspace.ts:1174. It must not call beginAttempt a second time.
- ModelPortV02 remains a separate provider path: model.ts obtains its own provider-branch claim/attempt and one pre-network reservation, then applies its local receiver gate before transport. Provider work never routes through RepositoryPortV02; the v0.1 ModelPort signature remains source-compatible until cutover.
- execution-guard.ts composes these boundaries; it does not repeat the durable beginAttempt or receiver-local consume. Read/list/search operations in ControlledRepositoryTools (listDir at line 299, readFile at 353, searchCode at 398) check current task-control admission and produce zero filesystem reads while paused or while any claim is open.
- UC-03 consumers include both current direct runTests callers in investigation.ts:886 and verification.ts:741. The repair test-only forwardPublicStatePort at uc03-repair.test.ts:262 must transparently forward the v0.2 journal operations and exact results.

#### Scoped task lanes

1. T037-T040 add v0.2 admission and attempt/outcome validators through separate behavioral RED/GREEN slices.
2. T041-T042 add only the controlled UC-04 journal mock. T043-T044 add the UC-05 v0.2 receipt types and validators. T045-T048 migrate UC-05 policy/service and control/recovery; T055-T058 migrate presentation/CLI and UC-05 mock fixtures.
3. T049 -> T050 is the repository receiver slice, including lease lifetime, all three effect paths, and the read/list/search hold checks. T051 -> T052 is the separate model/provider ingress slice.
4. T053-T054 migrate every UC-03 test wrapper and fixture, including provider-mocks.test.ts and the existing uc03-port-conformance.test.ts. Positive forwarding preserves attempt identity/outcome; missing context has zero effects.
5. T059 -> T022 owns the behavioral guard RED/GREEN handoff. T022 explicitly owns execution-guard.test.ts after T021 -> T059, composes the ports without double consumption, and stays unchecked until the amendment predecessors pass.
6. T060-T061 migrate repair and its forwarding test wrapper. T062-T063 migrate baseline investigation and verification.
7. T064 -> T065 is the explicit v0.2 cutover and legacy-rejection checkpoint. T066 runs the integrated 21-case deterministic matrix after each focused case has its own assigned owner and test path.

#### Release and evidence boundaries

- Every task in this amendment remains unchecked and unreleased. Task ownership and completed mock checks report progress only.
- T022 remains incomplete. The approved amendment and this decomposition do not authorize runtime implementation; a separate scoped release is required.
- Real X04-STATE/X05-GATE adapters, concrete production configuration, actual container isolation/containment (T024), real restart, and Phase 6 execution (T026+) remain gated.
- Do not fabricate foreign task IDs, owner delivery, adapter paths, production choices, or real acceptance evidence. Mock-only results establish only the exercised local behavior.

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
