# Data Model: UC-04

Logical recovery extension proposal `uc04-recovery/0.1-draft`, not an executable schema release or database design. G-EXTENSION must approve new fields/receipts and G-STORE must select concrete schemas/transactions before implementation. Reuse [canonical UC-03](../001-verified-code-repair/data-model.md) and [UC-05 companion](../003-uc05-human-approval/data-model.md) records without incompatible additions.

## Records and validation

| Record / stories | Logical contents | Invariant |
|---|---|---|
| TaskInput / US1 | taskId, repositoryId, registered workspaceId, task type, goal, criteria, constraints, ordered step IDs/descriptions/dependencies, required-check refs, trusted config refs | Nonempty required content; valid acyclic steps and registered identity; no model-chosen host path. Generic feature strategy remains G-FEATURE |
| TaskState / US1 | canonical schema/state versions, task/current-run/workspace IDs, node, plan/step state, changed paths, verification/repair/approval/review refs, risks, next action, outcome | Harness-owned state; CAS; new run changes no task identity/allowance. Use canonical records where representable; do not forge a BugTask to represent scripted input |
| PlanStep / US1 | stepId, status `todo/doing/done/failed`, action/attempt IDs, evidence refs, predecessor refs | Completion needs recorded outcome/evidence; `done` is never reset merely by restoration. Admission requires all declared predecessors `done` with valid required completion evidence; missing/foreign refs reject input, invalidated prerequisite evidence blocks dependent work |
| RepositoryAssumptions / US1 | repository/workspace identity, revision, worktree digest, expected changes, relevant file digests, canonical/view refs, policy/config identities | Current trusted inspection, not cached summary, validates reuse; drift invalidates affected evidence/views/approval authority |
| Checkpoint / US1,US3 | checkpointId/version, task/state version, current node, full coherent state or immutable snapshot ref/digest, control/decision refs, ledger versions/config/limits/consumed/reserved refs, verification progress | Snapshot and authoritative records share one coherent committed boundary; never trust an older checkpoint over newer state/journal |
| Run / all | runId, taskId, start/end, outcome, trace/usage projection refs | Separate attempt; telemetry never authorizes spend |
| DeliberatePause / US2 | proposed taskId, active flag, control revision/epoch, pause request identity, accepted time, explicit resume identity or null, outstanding attempt refs | New sidecar proposal only; pause survives restart, no auto-resume after outstanding work settles; scope one task |
| ApprovalTaskControl and journal / US2 | Existing UC-05 modes, versions/epochs, pending/continuation refs, immutable requests/resolutions/directions, event/outbox, outstanding claims | UC-04 persists, UC-05 evaluates. `paused` is a user presentation, not an unapproved addition to UC-05's mode enum |
| Ledger / US3 | scope task/run, scopeId, kind/unit, finite limit, consumed, outstanding reservations, config/pricing identity, version, authorized configuration history | Remaining = limit − consumed − outstanding; no NaN/unbounded/negative values. Exhaustion can yield no usable remainder; never clamp to new authority |
| ReservationSet / US3 | stable request/action/provider/proposal ID, task/original run/role, all budget lines/amounts, config/pricing refs, version, state, settlement ref | All-or-nothing reservation; identical request retry returns original, changed content conflicts; no partial admission |
| DispatchClaim / US2,US3 | Existing companion claim fields: claim/action/task identity, expected epoch/version, repository/policy binding, reservation refs, phase/result ref | One attempt authority; claimed/dispatched/observed/uncertain/reconciled phases; process death/clock expiry cannot release it |
| Settlement/Reconciliation / US3 | attempt/request ID, original charge refs, observed effect/usage or unknown, evidence digests, recorded config/pricing, version, safe reason | Idempotent exact receipt; changed settlement conflicts. Original charge retained unless trusted evidence establishes non-dispatch or accounted usage |
| CompactSummary / US4 | taskId, source stateVersion, goal, constraints, completed work, current state, open risks, next action | All six semantic fields required; empty risks may be explicit empty list. Advisory only; mismatch requires state/repository inspection |
| Status/History / US4 | bounded cursor, task goal, completed steps, current holds/outstanding operation, next safe action, sanitized result/evidence refs | No raw prompts/tool streams/protected payloads; completed history retained; deletion gate protects unresolved records |

All persisted/external input begins as unknown. Validate plain data, supported versions, explicit fields, finite numbers, identity mappings and reference integrity before reads that confer authority. Missing/corrupt records close admission; no constructor snapshot or empty-default ledger is trusted. Backend encoding, migration and corruption-repair procedure remain G-STORE decisions, not automatic migration on load.

## State transitions and composed admission

| Prior / trigger | Result and required retained facts |
|---|---|
| `todo` → claimed attempt | `doing` only when every predecessor is `done` with valid required evidence, plus durable admission/reservations/claim before constrained dispatch |
| `doing` → confirmed successful outcome | `done` with evidence/checkpoint; incomplete owning checks cannot mark task complete |
| `doing` → confirmed failure | `failed` with evidence; any retry is separately admitted within remaining allowance, not automatic reset |
| `doing` → interrupted/unknown | Retain step plus claim uncertainty; reconcile before retry or completion |
| `failed` → authorized retry | `doing` under fresh attempt, retaining failed evidence and prior charges |
| any active task → deliberate pause | Close admission, persist pause/epoch; retain outstanding bounded attempts for recording |
| deliberate pause → explicit resume | Clear only deliberate pause after no outstanding/uncertain attempt; other holds remain effective |
| approval transition | Apply unchanged UC-05 transaction semantics, preserving deliberate pause and recovery holds |
| restart → restore | Validate coherent versions, repo assumptions, accounting and outcomes; deliberate pause/pending/rejection survives |

Proposed eligibility predicate: valid current state AND no deliberate pause AND UC-05 control eligible AND no recovery hold/outstanding unresolved claim AND valid remaining applicable accounting AND current policy/workspace/verification prerequisites. It is checked at the shared serialized epoch/claim boundary, not calculated by a model. G-EXTENSION must agree how sidecar revisions join the shared epoch atomically; two independent checks with a race are insufficient.

Step readiness is an additional admission predicate: every declared predecessor is present in this task and `done` with evidence still valid for that dependency. Recompute after restore and drift; a summary or stale dependent completion cannot supply missing prerequisite proof. Retain historical completion facts while marking affected evidence unusable; do not rerun unaffected completed steps merely to traverse the graph again. Missing/invalid prerequisites permit zero dependent dispatch.

Checkpoint persistence failure cannot turn a durable observed effect into permission to replay. Recovery loads authoritative journal/ledger/action history and reconciles; if coherence cannot be proved it remains blocked. Summaries and traces never fill missing authority.
