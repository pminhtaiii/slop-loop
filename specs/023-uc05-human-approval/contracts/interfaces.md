# Interfaces and Execution Protocol: UC-05

**Status**: Logical companion version `uc05-approval/0.1-draft` agreed through T001; see [decisions](decisions.md). T001–T018 and T023–T027 corrections supply validators, mocks, policy/service/control/binding, bounded history/presentation/CLI and canonical-consumer checks. Phase 7 is separately authorized on 2026-10-22 (Asia/Saigon). Canonical UC-03 0.1.0 remains unchanged; Phase 8 T019–T022 is separately authorized on 2026-10-22; T020–T022 retain external dependencies, and real adapters, production composition, durability and actual restart remain unverified.

## Canonical ApprovalPort compatibility

Reuse [canonical contracts](../../../src/contracts/foundation/uc03.ts) and [shared interfaces](../../001-verified-code-repair/contracts/interfaces.md). The real task-scoped implementation supplies `classify(action)`, `requestDecision(binding)`, `validateBinding(binding)`, `resolve(decisionId)` and `provenance: real` only when its real dependencies are admitted. It never constructs real provenance around mock dependencies.

- **classify** validates action and combines it with a fresh host-owned policy/admission context; returns the canonical three permission classes. Invalid/incomplete inputs produce a typed safe input/prerequisite error translated by the shared guard into zero-dispatch denial, not a fourth permission or permissive fallback. Pure classification grants no execution authority.
- **requestDecision** accepts only a validated pending binding for a registered trusted action/continuation; caller-supplied approved/rejected status cannot insert consent. It atomically creates/resolves an idempotent pending slot through UC-04 and returns its current canonical projection without blocking a process awaiting terminal input. Only the operator channel supplies terminal decisions.
- **validateBinding** loads the authoritative journal, matches the stored human resolution/request identity and companion repository mapping, obtains complete current trusted freshness context, then calls canonical approval admission. Return true only for a current approved decision in an eligible task. Parsing alone, pending/rejected/stale status, a fake operator reference or a caller-supplied context never suffice.
- **resolve** reads the current projection by decisionId; foreign/unknown IDs return a typed safe error. Reading an approval does not continue the workflow, reserve a budget or execute an action.

Method signatures lack explicit context parameters: inject task-scoped trusted providers that load current state per operation; never freeze a constructor snapshot or trust model-supplied policy/workspace facts. Reads/list/search stay under Tai's existing guard; tests use run_command. No new canonical action variants are added.

## Companion ports (proposed)

| Port / owner | Operation | Required outcome |
|---|---|---|
| TrustedApprovalContext / Tai with UC-04 state | loadForAction(taskId, actionId), loadForDecision(decisionId) | Exact registered action, repository/workspace mapping, current revision/worktree digest, policy/config, role, required limits, admitted safety facts, plan context, control version/epoch |
| ApprovalStorePort / UC-04 | loadTaskControl(taskId), readRequest(decisionId), readEvents(taskId, bounded cursor) | Strongly consistent validated records; missing state is not runnable |
| ApprovalStorePort / UC-04 | createPendingAndPause(expectedControlVersion, submissionKey, request, event) | Atomic request + waiting barrier + continuation + journal/outbox; identical retry returns same identity, concurrent/conflicting request conflicts |
| ApprovalStorePort / UC-04 | resolvePending(expectedControlVersion, expectedRequestVersion, responseKey, trustedResponse, event) | Atomic immutable terminal resolution + task hold transition + event/outbox; duplicate identical response returns original result; conflicting response denied |
| ApprovalStorePort / UC-04 | replaceStalePending(expected versions, assessment, replacement, event) | Retire old pending identity, retain stale assessment and atomically replace while task remains waiting; no runnable gap |
| ApprovalStorePort / UC-04 | recordDirection(expectedControlVersion, direction, event) | Explicit resume/revise/end only; preserve rejected history and all recovery/claim holds |
| Execution coordination / Tai + UC-04 | claimDispatch(expected control epoch/version, action/bindings, current repo/policy, reservation receipts) | Atomic durable fencing/claim and complete reservation admission before effect; no claim authorizes two attempts |
| Execution coordination / Tai + UC-04 | recordOutcome(claimId, observed/uncertain refs), reconcile(claimId, trusted evidence) | Retain uncertain charges/effects until reconciled; never release a claim merely on elapsed time or restart |
| OperatorChannel / UC-05 host composition | submitDecision, submitDirection | Host-only capability unavailable to models/repository containers; inputs validated by CLI contract |
| ActivityControl / Tai | fenceTask(taskId, epoch), requestCancellation(taskId), inspectOutstanding(taskId) | All coder/reviewer/provider/tool/background admission observes barrier; cancellation/outcome reporting remain possible |

This companion contract extends capabilities, not canonical StatePort fields. UC-04 chooses backend/transaction mechanics. T001 must agree method schemas, atomicity, ownership and recovery receipts before real integration; UC-05 does not implement UC-04 transactions in `src/approvals/`.

## Safe result envelope

Companion operations return a discriminated outcome: `ok`, `pending`, `paused`, `denied`, `invalid`, `conflict`, `stale`, `unavailable`, or `uncertain`, plus task/request/control versions, reasonCode and safe next action where applicable. Expected failures never contain raw input/artifacts. Shared consumers translate these to existing envelope outcomes (`pending-approval`, `denied`, `conflict`, `error`, `uncertain-effect`, etc.); canonical result unions are not changed. Unexpected infrastructure exceptions stop the route safely at the host boundary.

## Ordered admission and pause protocol

1. Shared composition validates real provenance and loads current task control before every agent dispatch, including host coder/reviewer provider calls. Non-runnable state admits only trusted operator interaction, cancellation, outcome recording and recovery. This adds control checks to provider dispatch without replacing its token/cost reservation protocol.
2. Tai validates registered action, canonical paths/parents/links, protected content, test protection, finite limits and isolation. UC-05 consumes trusted admitted facts and policy; it does not scan the repository, execute code or infer safe content from paths alone.
3. Apply [policy precedence](policy.md). Forbidden/invalid/unsupported input denies effects. Missing fix-plan approval interrupts before production patch; plan and separate action approvals use distinct slots/decisions. Ordinary allowed reads never need a fabricated NormalizedAction.
4. For required approval, UC-04 commits pending request and closes the dispatch barrier atomically before a prompt is usable. The shared activity owner fences new work and cancels or records already-started work where possible. Storage failure/uncertainty closes the local host admission path and enters recovery-blocked; other host workers must fail closed on unconfirmed control-store state.
5. Operator decisions compare task/request versions and presentation digest. Approval can release only its own waiting hold after durable commit. Rejection fences all task work until a separate explicit direction. An accepted terminal decision is immutable.
6. Before effect, shared execution holds the repository mutation/view lock, revalidates state/bindings/policy and task epoch, and atomically obtains complete budget reservations and a durable dispatch claim through UC-04. Snapshot validation without the lock/fence is insufficient. Repository drift, a concurrent pause or a failed/partial reservation produces zero new dispatch.
7. One claimed attempt executes through the real isolated executor only. Persist observed effect/usage and settlement; after an interruption retain claim and charge as uncertain until UC-04/executor reconciliation. Only verified non-dispatch or explicit supported idempotency can justify a further attempt, with separately retained admission/attempt accounting.

The linearization point between a dispatch and a new pause is UC-04's serialized epoch/claim transaction. A claim committed first is already in flight and must be cancelled/reconciled; a pause committed first rejects the claim. Report effects that cannot be cancelled rather than promise rollback.

## Rejection, freshness and plan rules

- Rejection holds the whole task independently of action hash/ID, blocking equivalent-command retries without an arbitrary semantic-equivalence solver. Resume/revise directions release only that hold, not the rejected action's approval or an uncertain claim.
- Stale approved decisions retain their original resolution and gain an assessment; a fresh required request gets a new identity. Replacing a stale pending request is deterministic harness revalidation only, not permission for a paused agent to investigate or replan.
- Fix-plan approval uses canonical trusted freshness fields and the current repository digest. Digest drift requires fresh approval even for a nonmaterial follow-up patch; no extra replan charge if strategy/material fields are unchanged. Material changes require trusted UC-03 determination and a charged UC-04 replan slot before renewed approval. No edits under an old strategy binding.
- Input/control deadlines are finite configuration for each bounded operation, not automatic expiry of the human pause. A CLI invocation may exit pending while the durable task remains waiting indefinitely for explicit human input.

## Phase 6 local continuation consumer

`createApprovalContinuation` is exported from `src/approvals/control.ts`, with implementation in `recovery.ts`. It composes the actual mock-backed approval service with an injected mock-only recovery owner; the four canonical ApprovalPort signatures and companion record versions remain unchanged. Its `admit(decisionId)` method does not execute or grant a generic activity/executor capability.

The owner declares finite `reservationRequirements` (scope, kind, amount), supplies `load(decisionId)` with the retained control/request/action/run/claim journal, and implements `claimDispatch` for the exact approved binding, action, run and expected control version/epoch. UC-05 validates plain data and identities, resolves and validates the current approval through the actual service, reloads before the claim, and verifies the claim/control/reservation receipt plus the retained journal afterward. The receipt must name exactly the required reservations with the admitted run/configuration, one new claim and the expected control transition. Unresolved claims must agree with control references; historical same-action/decision claims deny blind replay across all recorded lifecycle phases.

The owner remains responsible for serialized task control, locked repository/policy freshness and complete accounting at claim admission. The test adapter uses the existing mock store and canonical in-memory reservation port; it conservatively retains charge on a claim race or lost response. Neither the consumer nor this adapter delivers durable atomicity, reconciliation or repository effects. Caller timeouts close local admission and fence later continuation work; an owner call already started can still commit and must remain represented in owner state.

Results remain the minimal `claimed`, `blocked` or `unavailable`, with only an admitted claim ID on success. Phase 7 adds safe history/CLI inspection of available control, request, binding, claim and owner outcome evidence; absent execution/cancellation/accounting observations stay unknown. No granular accounting cause is inferred from missing owner evidence. These results do not establish full US4/SC-006 or real/restart acceptance. The current composition rejects real/unknown provenance rather than silently supplying a mock replacement.

## Phase 7 read-only history consumer

The authorized T016–T018 slice may expose `ApprovalService.history(taskId, page)` behind explicit CLI task/page selection. It consumes existing `readHistory`, `readEvents` and request metadata from the injected owner, validates their schema and cross-record identity before display, and bounds pages in UTF-8 under the explicit fixture profile. History remains readable independently of current exact-action inspection: immutable human resolution, current binding assessment, continuation/claim and observed outcome are distinct evidence. Derived observations are labelled separately from committed journal events. Missing execution/cancellation evidence remains unknown; no approval-only completion claim is permitted.

Ordinary pending creation and decision success must match authoritative journal evidence as well as their mutation receipts. Lost, malformed or missing journal evidence cannot grant new execution authority; committed consent must not be rewritten to pretend that an uncertain response did not commit. Retrying an accepted response preserves its original event identity. These are consumer checks against mock contract behavior, not proof of durable outbox delivery or storage atomicity. Tai's telemetry implementation, UC-04 persistence and canonical record versions remain unchanged.

An optional injected read-only owner callback may supply terminal activity observations because the current outstanding-activity port does not retain completed/cancelled/failed attempts. Admit only a closed, bounded metadata vocabulary with stable observation/task/run/attempt/claim references and timestamps; reject unsafe, foreign or contradictory records. Missing callback/evidence remains unknown. This capability reads owner evidence without storing it, granting authority, modifying Tai's activity owner or creating a telemetry implementation. A completed attempt is distinct from verified action/task success; confirmed cancellation does not establish rollback of earlier effects.

## Mock replacement and delivery

T004 provides mock store/context/activity ports only under `tests/runtime/support/uc05/`; they use the same companion validators, explicit finite profiles and scripted human input. The existing ScriptedApprovalPort remains a UC-03 consumer fixture, not the UC-05 service under test. T020 replaces mocks with X04-APPROVAL-STORE and X03-ADMISSION; T021 proves actual process restart. Real composition rejects mock dependencies and unavailable durable adapters; no silent production mock fallback.
