# Data Model: UC-05

**Status**: Logical companion contract version `uc05-approval/0.1-draft` agreed through the T001 confirmation in [decisions](contracts/decisions.md). T002 supplies validators, T004 test-only in-memory state, and T007/T009/T010 mock-backed service/control/CLI consumers; no schema migration, database or durable runtime state is implemented. Canonical UC-03 binding version remains 0.1.0. [Interfaces](contracts/interfaces.md) owns transaction semantics.

## Records and ownership

All external/persisted input is unknown until validated. Reject unknown execution-affecting fields, non-finite bounds, invalid IDs/digests, missing version/context and incompatible schema versions. Records below are logical fields; T002 implemented their companion TypeScript validators after agreement.

| Record | Required fields | Invariants / owner |
|---|---|---|
| ApprovalTaskControl | schemaVersion, taskId, repositoryId, workspaceId, version, epoch, mode, pendingDecisionId or null, continuationRef or null, reasonCode, outstandingClaimRefs | UC-04 authoritative; mode runnable/waiting/rejected/recovery-blocked/ended; version/epoch monotone; one pending request; initial control created by trusted task bootstrap |
| ApprovalRequestRecord | decisionId, canonical pending binding, taskId, repositoryId, workspaceId, createdRunId, continuationRef, requestVersion, policy/config identities, actionRef/digest, presentationDigest, createdAt, submissionKey | Immutable request identity; action stored only in a protected approved artifact via Tai/UC-04, not raw trace data; binding must agree with all companion identities |
| HumanResolution | decisionId, responseKey, expectedRequestVersion, operatorChannelRef, approved or rejected, safeReasonCode, decidedAt, eventId | At most one terminal resolution per slot; same key/body idempotent; conflicting body or different terminal response conflicts; channel comes from trusted host composition |
| BindingAssessment | assessmentId, decisionId, checkedTaskVersion/epoch, trustedContextDigest, valid or stale or denied, reasonCodes, checkedAt | Append-only; never rewrites the original resolution; complete fresh canonical context required |
| DeveloperDirection | directionId, taskId, expectedVersion/epoch, resume or revise or end, safeScopeRef, responseKey, createdAt | Trusted CLI only; facts/comments are not directions; no direction is approval or allowance reset |
| DispatchClaim | claimId, actionId, taskId, expectedControlVersion/epoch, repositoryStateDigest, policyIdentity, decisionRefs, reservationRefs, phase, resultRef | UC-04/executor-owned; phase claimed/dispatched/observed/uncertain/reconciled; no timer-based permission renewal or blind retry |
| PolicyProfile | policyId/version, configId/version, supported action/command rules, sensitive paths, breadth caps, input/presentation bounds, diagnostic rules | Trusted immutable compiled policy; no protected bodies/credentials; rule precedence in policy contract; all required values explicit |
| SafePresentation | decisionId, requestVersion, bindingFingerprint, five decision elements, inspectionRef, presentationDigest, truncation/page metadata | UC-05 projection from admitted artifacts; bounded UTF-8 bytes; strip/escape terminal controls; if necessary details cannot be safely inspected, no approval request |
| DecisionEvent | eventId, taskId/runId, decisionId/directionId/claimId refs as applicable, type, outcome, policyRef, safeReasonCode, timestamp | Atomic durable event/outbox with control change; telemetry uses only safe metadata; retries deduplicate event IDs |

Canonical ApprovalBinding includes action/task/workspace/repository digest and policy; companion repositoryId verifies the trusted workspace-to-repository mapping. For fix_plan, retain planVersion, strategyDigest, baselineRef, evidenceRefs, criteriaDigest and checkSetDigest as required by canonical admission. Arrays retain canonical order and patch bytes remain exact.

## State transitions

| Prior | Trigger / preconditions | Next | Atomic durable changes |
|---|---|---|---|
| runnable | create a new valid required request | waiting | Store pending request, continuation, pause reason, event; increment version/epoch |
| waiting | matching explicit approval, versions current, no other holds | runnable | Append terminal approval, clear pending pointer, increment version/epoch; execution still needs fresh admission/claim |
| waiting | matching rejection | rejected | Append terminal rejection and pause reason, clear pending pointer, increment version/epoch; cancel active work where possible |
| waiting | deterministic binding drift revalidation | waiting | Append stale assessment, retire pending slot and create fresh pending identity/presentation atomically; no agent investigation |
| rejected | explicit resume/revise direction, records healthy | runnable | Preserve rejection, append scoped direction, clear rejection hold, increment version/epoch; fresh request required to retry approval-required work |
| any non-ended | explicit end | ended | Preserve decisions/uncertainty, fence new admissions, request cancellation, increment version/epoch |
| any | missing/conflicting durable control or uncertain reconciliation | recovery-blocked | Fail closed, retain charge/claim and safe reason; never synthesize control from conversation |
| recovery-blocked | trusted UC-04 reconciliation | restored prior safe mode | Revalidate repository/policy, preserve prior pending/rejected holds; no automatic release by restart |

`waiting` or `rejected` bars all agent dispatch, not just the awaiting repository action. Safe cancellation/outcome recording and operator commands remain possible. One approval cannot clear unrelated recovery holds; approval with an unresolved hold remains non-runnable and returns a blocked outcome. The simplified waiting→runnable row requires none.

## Lifecycle and concurrency

- decisionId is the canonical request-slot identity, distinct from actionId, responseKey, eventId and claimId. A retry of identical pending creation returns the same slot; reuse of a key with changed contents conflicts. Changed action/approval after rejection uses a new slot.
- Request identity and human resolutions are immutable. Derive canonical pending/approved/rejected/stale projections from the journal and current assessments; never mutate stored consent into a new binding.
- Every mutation validates task/request versions and the task's repository/workspace identity in one UC-04 transaction. Concurrent pending creation admits one request, the loser returns conflict. There is no unbounded CAS retry.
- Approval/control commits and durable audit/outbox entries succeed together; failed or uncertain commit cannot authorize dispatch. Ordinary telemetry sink failure does not undo a committed journal; replay the outbox idempotently.
- Budget ledgers remain UC-04's existing authority. No request, operator direction, epoch change or new run replenishes spending/reservations.

## Plan and action identity

The canonical action digest includes actionId; it is an exact binding, not proof of semantic command equivalence. Rejection prevention relies on the durable task-wide hold and forbidden policy. No blind command-string normalization merges distinct actions.

The initial slice retains strict current-repository fix-plan binding. A new patch after digest drift needs a fresh immutable plan decision; unchanged strategy does not consume a replan. Material replans use UC-03's trusted evidence plus UC-04 reserved allowance, capped at three. No covered-evolution approval ledger is introduced.

## Evidence and retention

Raw source/patch details remain outside decision traces under shared admitted-artifact rules. Inspect only bounded protected-data-checked details; protected payloads are never collected for approval. Retention configuration is a real-integration prerequisite agreed with UC-04, and must preserve unresolved decisions/claims/accounting needed for recovery; no time-based purge or secret-bearing archive is defined here.
