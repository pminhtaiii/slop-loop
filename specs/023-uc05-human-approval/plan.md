# Implementation Plan: UC-05 — Bound Human Approval and Safe Continuation

**Branch**: `feat/023-uc05-human-approval-spec` | **Date**: 2026-10-19 (Asia/Saigon) | **Spec**: [spec.md](spec.md)

**Status**: Separately authorized T001–T013 and T023–T027 corrections are integrated locally through `84be181` on 2026-10-20 (Asia/Saigon). All three Phase 5 seams and user-relayed X03-PLAN-CONTEXT agreement are confirmed. Source/emitted approval suites each pass 142/142; runtime typecheck/full lint/build and 896 compiled tests pass. T014–T022, production profiles, real runtime integration and actual restart remain gated. See [decisions](contracts/decisions.md) and the [task ledger](tasks.md).

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
| Authorization | T001–T013 authorized in separate phases; shared agreement and Phase 3/4/5 seams confirmed; T023–T027 are scoped corrections | T014–T022 need separate authorization; production execution remains separately gated |

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

## Phase 4 refinement — T008–T010 (planning only)

The original 2026-10-20 request asked for Phase 4 specifications. This section refines US2 / FR-006–009,019–021 and SC-002–003,007 under the existing companion contract; planning alone granted no implementation or TDD seam approval. The user subsequently authorized implementation/push and confirmed all three seams; see [authorization provenance](contracts/decisions.md#phase-4-implementation-authorization). Task IDs, dependencies and completion remain solely in [tasks](tasks.md).

### Inspected starting point and ownership

The starting development revision is `694adc35d5f17468e9d23b0975f9d307844ddf83`, after public Phase 3 PR #73 merged. `service.ts` already commits pending-plus-pause and terminal decisions, reloads control, and closes local admission on failed/uncertain receipts. It has no activity-control dependency or direction method. `cli.ts` supports list/show/inspect/decide only. `control.ts` and its test do not exist yet.

`tests/runtime/support/uc05/mock-context.ts` supplies mock fencing, cancellation and outcome observation. `mock-store.ts` supplies control/epoch, pending/decision transactions and `recordDirection`, but the latter currently rejects retries after the original version changes instead of confirming an identical accepted direction. Phase 4 must make that test double conform to the existing idempotency contract; a UC-05 in-memory response cache would mask the missing store guarantee. This is a test-support extension, not delivery of X04-APPROVAL-STORE.

T008/T009 own the real UC-05 control coordinator and service wiring, plus the explicitly listed test-support changes in tasks.md. Tai retains scheduler/provider/tool callers, canonical contracts and execution; UC-04 retains production transactions, claims and accounting. No foreign production module is edited. The coordinator consumes injected activity/store capabilities and reports typed safe outcomes; it does not create a scheduler, execute effects or implement recovery reconciliation.

### Observable control behavior

| Current control / event | Required result |
|---|---|
| Runnable → pending creation | Close local admission before mutation; request, waiting control, epoch and event commit atomically through the store; fence affected activity before reporting the pending request usable. |
| Waiting → matching approval | Only its waiting hold may clear. Unresolved claims, failed fencing, local uncertainty or another current hold still deny admission; approval never dispatches work. |
| Waiting → matching rejection | Preserve immutable rejection, fence the whole task, request cancellation where possible, and remain rejected. |
| Rejected → resume/revise | Trusted explicit direction and current version/epoch required; release rejection only when no other hold/outstanding claim exists. Preserve rejected decision; approval-required work still needs a fresh request. |
| Waiting/recovery-blocked/ended → resume/revise | Refuse without changing control. Neither direction replaces an approval nor performs reconciliation. |
| Any non-ended → end | Commit ended control, fence new admissions and request cancellation; preserve request/resolution history, outstanding claims, accounting and observed outcomes. |
| Same accepted response retried | Confirm the original direction/event once, even when the original version is now stale; inspect current control independently and preserve any later pause/end. Changed content under that response key conflicts. |
| New response with stale version/epoch | Conflict with zero mutation, no automatic CAS retry and no work admission. |
| Missing/invalid store state, failed/uncertain commit or activity failure | Close local admission, return sanitized unavailable/uncertain status and retain any already committed control. Never invent a durable recovery-blocked record, rollback, successful cancellation or permission. |

Fencing is task-wide, including coder/reviewer, model calls, tools, reads/tests and background investigation. Test drivers representing these callers must invoke the actual public control admission path for every attempted dispatch; a detached mock that fences itself is insufficient. Re-read authoritative control and compare the observed epoch/version at admission. Serializing real dispatch versus pause remains the external UC-04/Tai transaction described in [interfaces](contracts/interfaces.md); local mocks do not prove distributed race freedom. Unrelated task identities keep their own admission state.

Only the harness may record outcomes, request cancellation and preserve state while paused. An in-flight attempt remains completed/cancelled/uncertain according to observed evidence; cancellation requested is not cancellation confirmed. Ending a task or an outcome callback cannot remove an unresolved claim or restore runnable state. Alternate IDs/tools/spellings remain barred by the task hold without a semantic-equivalence solver.

### Direction identity and CLI translation

Use the existing `DeveloperDirection`, `DecisionEvent`, `SafeResult` and `TrustedOperatorIdentity` validators. Add a host-only direction operation on the UC-05 service/control surface; keep the four canonical ApprovalPort methods unchanged. Validate host authority and explicit command selectors, then look up an accepted direction by task plus response key through authoritative store history before constructing a new direction. For an accepted retry, compare the submitted direction and task-version with the original record, and reuse its original epoch, scope, identity, event and timestamp; do not derive them from current task context. Missing, ambiguous or invalid history grants no retry confirmation. Load current control separately and never restore the original control snapshot.

For a new response key only, load the task's current trusted scope and control, derive safeScopeRef from its registered interrupted/revision scope, and bind the submitted task-version to the loaded epoch for store CAS. Missing/mismatched scope denies the operation; do not accept caller-supplied scope or fabricate an action. The store performs its own accepted-key/content check before new-response CAS validation, confirming an identical retry once and conflicting on changed original version/epoch, direction or scope. This remains correct if another caller commits the response between lookup and submission. A retry receipt never overwrites newer control, repeats cancellation or reopens local admission. Conflicting body/key and foreign operator/task inputs grant no authority. Use the explicit finite profile and one mutation attempt, retaining the existing per-operation expiry fence before every late mutation. Freshness/plan expansion remains T011–T013.

T010 implements the already agreed [control command](contracts/cli.md): `control --task TASK --task-version V --direction resume|revise|end --response-key KEY`. All selectors are explicit. No new interactive stdin grammar, implicit active task, approval alias or production driver is added. Recorded end may return paused while exiting 0 with `approval-cli-recorded`; an unrecorded pause exits 3. Invalid input exits 2, denied authority 4, unavailable/uncertain 5. Existing decide/rejection exits and safe output remain unchanged.

Empty/malformed input, EOF and terminal interruption cannot create a direction/decision. If interruption occurs after a valid command committed, retain that commit and re-read status; do not assert rollback or automatically resubmit. Subprocess signal tests must report actual host termination behavior rather than promise a JSON envelope after forced termination. A parent-owned test driver may retain mock state to observe child interruption; it cannot become a production composition selector or durable-store substitute.

### Phase 4 TDD seams — subsequently confirmed by the user

| Seam | Observes | Does not establish |
|---|---|---|
| Public control coordinator wired into the actual service, with injected store/activity/context and host operator | Pending/rejection fencing, admission by representative caller classes, cancellation observations, directions, retries, failed receipts and unrelated-task isolation | Real scheduler/provider integration, production isolation, durable control or atomic real pause/dispatch |
| Public mock-store direction transaction/history with companion validators | Store-owned CAS, original direction/event identity, identical retry and conflict, preserving newer holds | Production database atomicity, persistence or restart |
| Actual CLI subprocess calling the real service/control through an explicit test-only host driver | Control arguments, bounded output/exits, empty/invalid input and observable EOF/signal/terminal-loss paths with retained mock pause | OS-wide operator isolation, production store, effects or real runtime restart |

The user confirmed all three seams on 2026-10-20 (Asia/Saigon) before test writing, per the [TDD skill](../../.agents/skills/tdd/SKILL.md). T008 established one loadable behavioral RED; T009 completed that tracer and proceeded in vertical RED/GREEN slices. T010 followed accepted T009 and retained a real subprocess behavioral RED before its control parser route. Missing imports, invalid fixtures and tests of a mocked coordinator do not count as behavioral RED. Additional seams still require their own confirmation.

Completion evidence must map C05–C08,C10–C11 and the Phase 4 subset of C20 to actual observations as detailed in [acceptance](contracts/acceptance.md#phase-4-local-evidence-boundary). Run focused control/CLI/mock-port tests, prior approval regressions and the runtime gate after implementation. Real C20 claim serialization, C17–C19 restart, full history/acceptance and T011–T022 remain outside Phase 4; no all-UC verification claim follows.

## Phase 5 authorized local slice — T011–T013

The user authorized T011–T012 and confirmed the public binding-evaluator and actual-service/mock-port seams on 2026-10-20 (Asia/Saigon); see [decisions](contracts/decisions.md#phase-5-implementation-authorization-and-seams). Execute one neutral loadable behavioral RED, then minimal GREEN and successive vertical slices. Reuse canonical approval admission and existing companion store transactions; do not add a schema, budget engine, executor or storage implementation. Task paths and acceptance remain in tasks.md.

The evaluator explains exact action/plan freshness and rejects incomplete trusted context without mutating input consent. The service consumes current trusted context and immutable request/resolution history, projects staleness separately, and requires fresh identities/decisions for renewed approval. Repository drift does not silently rebind a decision or automatically consume a material replan. Tests exercise these public exports with explicit mock store/context/operator dependencies and retain prior refusal/uncertainty, pause and presentation regressions. They do not establish real admission, durability, effects or restart.

The user subsequently confirmed Tai/X03-PLAN-CONTEXT agreement and authorized T013's third seam: actual service binding consumed by canonical `validateStateTransition` into `Patch`, with mock context/accounting. T013 is a separate frontier after accepted T012 and owns only `tests/runtime/approvals/plan-context.test.ts`. It checks exact plan approval, new regression baseline binding, retained three-slot material replan admission/fourth refusal, original baseline preservation during nonmaterial current-state renewal, no path-only prompt and separate risky-action permission. This is user-relayed agreement, not adapter delivery or direct colleague contact; mock availability and review success supply neither. No canonical or UC-03 workflow edit is included; T014–T022 and G-PROFILE/G-REAL/G-RESTART remain gated.

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
