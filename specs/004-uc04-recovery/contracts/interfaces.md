# Interfaces and Recovery Protocol: UC-04

**Status**: Proposed `uc04-recovery/0.1-draft` extension. Existing canonical 0.1.0 and accepted UC-05 companion behavior remain baseline; new pause/receipt/mapping details require G-EXTENSION. No runtime port, backend or migration is created by this document.

## Boundary compatibility

| Boundary | Contract / owner | UC-04 responsibility |
|---|---|---|
| StatePort | [UC-03 interfaces](../../001-verified-code-repair/contracts/interfaces.md); Thanh Tan | Existing load/CAS/reserve/settle/checkpoint/recover operations, exact canonical schemas and conformance. Adapter maps extension records without changing canonical fields |
| ApprovalStorePort | [UC-05 interfaces](../../003-uc05-human-approval/contracts/interfaces.md); storage Thanh Tan, decisions Trong Tan | loadTaskControl/readRequest/readEvents; atomic createPendingAndPause, resolvePending, replaceStalePending, recordDirection; immutable journal/outbox and hold preservation |
| Dispatch coordination | Tai + Thanh Tan; same UC-05 companion claim protocol | Atomic admission against current epoch/control/repository/policy and complete reservations, durable claim, outcome and reconciliation |
| ApprovalPort | Trong Tan | UC-04 calls valid decision/freshness capability; it never decides stale validity itself or rewrites approved/rejected history |
| Repository/verification/model | Tai | Consume trusted snapshots/effects/usage/verification; persist refs and charges. No second command runner/provider or bug-fix strategy |

Production provenance must reject mock/missing adapters. A real storage adapter paired with controlled tool/approval seams is a foundation-test composition, never a production runtime. Safe traces use references/metadata, not raw operation payloads.

## Proposed extension surface

All commands carry schema version, task/workspace identity, unique stable request identity, expected state/control versions and trusted configuration references as applicable. Exact TypeScript names/schema mapping require owner confirmation; the table specifies required outcomes, not a replacement canonical signature.

| Operation | Inputs and atomic result | Failure/retry behavior |
|---|---|---|
| registerTask | Validated scripted task input with acyclic, same-task predecessor refs and trusted workspace/config -> initial task/steps/control/ledger identity | Missing/foreign step refs or input/config cannot register runnable authority; never mint new budget for an existing task |
| transitionAndCheckpoint | expected versions, proposed valid transition, evidence refs, coherent control/ledger snapshot -> state and checkpoint receipt | CAS conflict has zero partial writes; lost acknowledgment reloaded by original request key |
| reserveAll | request/action/provider ID, original role/run, applicable task/run budget lines, config/pricing -> one complete durable receipt | Any line failure grants no dispatch; identical retries reuse original charge; mismatched content conflicts |
| claimDispatch | expected shared epoch/state, every predecessor done with valid required evidence, fresh repo/policy/approval facts and complete reservation refs -> one attempt claim | Serialized with deliberate pause and all UC-05 holds; unfinished/missing/invalidated predecessor or losing claim has zero dependent dispatch |
| recordAndSettle | claim/request ID, trusted observed outcome/usage and evidence -> atomic outcome, settlement, ledger and progress receipt | Duplicate identical result does not double-charge/complete; conflicting receipt denied; unknown usage remains charged |
| pauseTask | trusted operator task selector, expected revision, pause key -> deliberate pause plus shared fence/epoch receipt | No new agent work after accepted boundary; uncertain commit closes local admission, inspect durable identity before retry |
| resumeTask | trusted explicit resume, expected revision, response key -> clear only deliberate pause | Outstanding/uncertain work declines with safe reason; no queued future resume; stale/new conflicting request conflicts |
| recoverTask | task selector/new run identity, durable state/claim/ledger, fresh trusted repo/outcome evidence -> held or validated continuation | Never create fresh accounting/consent; preserve holds and unresolved charge; no blind non-idempotent retry |
| inspect/compact | explicit task selector, bounded cursor/summary limits, source state version -> safe status/history or six-field summary | No mutation of authority; stale/invalid summary rejected as reasoning input; deletion unavailable until G-RETENTION |

Extension results discriminate `ok`, `held`, `invalid`, `denied`, `conflict`, `exhausted`, `unavailable`, `uncertain`, with stable safe reason/next action and validated original request/state/epoch/evidence receipts. Translate to the existing consumer result union at adapters; do not add a permission class. Precommit definite refusal can report no mutation only with validated evidence. Failed/malformed/unknown receipts confer no authority and cannot assert rollback.

## Durable admission and recovery sequence

1. Load validated task/control/ledger plus latest coherent checkpoint and authoritative newer journal entries. Confirm schema/reference integrity and stable workspace ownership. Reject corrupt/incompatible/missing authority rather than restore an older favorable balance.
2. Close new admission while recovery runs. Preserve deliberate pause, UC-05 waiting/rejection/ended modes and unresolved claims independently. Harness outcome recording/cancellation/reconciliation is allowed; paused agents do no new investigation.
3. Inspect canonical repo revision/worktree, expected changes and relevant digests through Tai's trusted inspector. Reassess drift without overwriting; invalidate affected command views/check evidence. UC-05 independently reevaluates binding, obtains fresh identity/decision when needed, retaining original baseline/consent. Unchanged strategy is not automatically a replan.
4. Reconcile outstanding reservations/claims using trusted outcome evidence. Confirmed completion settles once and preserves completed progress. Verified non-dispatch may release the original reservation and permit separately admitted work. Missing usage/effect remains conservatively charged and held. No timer/reset releases claims.
5. For every next step/action, revalidate dependency readiness: each declared predecessor must be `done` with valid required evidence. Missing, unfinished or drift-invalidated prerequisite proof blocks the dependent step without replaying unaffected completions. For constrained actions validate finite profile/remaining allowance and acquire all reservations plus a single claim under the shared serialized epoch/repo-view fence. Deliberate pause and approval transactions must use that same authority: pause-first denies; claim-first counts as in flight. Duplicate keys return receipts, never a second effect capability.
6. Tai executes under its controlled boundary. Atomically record observed outcome/usage and settlement/progress in UC-04; checkpoint the coherent result. Non-atomic external effect versus storage is explicitly reconciled, never claimed as universal exactly-once execution.
7. Continue automatically only if the task was not deliberately paused and all holds/prerequisites are satisfied. Explicit resume only clears deliberate pause after outstanding results settle; it cannot approve, fund or reconcile an operation. Report recovery blockers concisely; successful restoration emits no extra narration.

## Reconciliation outcomes

| Trusted observation | Allowed behavior |
|---|---|
| Definitely not dispatched | Record non-dispatch, release only evidenced unspent reservation, then freshly admit if eligible |
| Effect/usage definitely occurred | Record once, settle actual accounted usage under original identity; continue from next required action after fresh admission |
| Supported idempotency / duplicate prevention | Record the concrete guarantee/evidence; separately admit any safe retry retaining all original attempt/accounting history |
| Unknown non-idempotent effect or billable usage | Retain claim/charge and recovery hold; explain needed evidence; zero blind retry |
| Observed usage exceeds reserved/configured maximum or evidence conflicts | Record safe discrepancy, close constrained admission, require reconciliation/authorized config action without erasing prior spending |

Actual provider reconciliation capability is external; internal request IDs alone prove no provider idempotency. A conservative retained charge is not evidence that the effect completed. Recovery may report incomplete indefinitely when safe reconciliation is unavailable.

## Transactions and test seams

Strong consistency is required for current authority; CAS conflicts do not silently retry against a later version. Task/step/checkpoint coherence, reservation sets, outcome/settlement and approval-control/journal changes are atomic in the selected storage design. Multi-process tests must prove the same task cannot spend/claim twice. Partial acknowledgments must be recoverable by immutable identity.

Proposed test seams: actual UC-04 facade/modules with controlled repository/approval/usage observers; actual selected durable adapter in kill/restore children; later actual UC-05/shared-executor composition. T001 confirms them before test writing. Mocks may model external effects and count attempts but never replace the storage/recovery SUT or establish real containment/provider behavior. Each contract operation maps to tests/implementation in [tasks](../tasks.md) and cases in [acceptance](acceptance.md).
