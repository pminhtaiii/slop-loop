# Acceptance and Evidence Contract: UC-04

Design obligations only; every runtime case is currently **not run**. [Spec](../spec.md) defines outcomes, [tasks](../tasks.md) owns future completion, and the [matrix](../../../docs/progress-checker-matrices.md) owns target capability rows. Fixture/profile/oracle values require approval; no default production values are embedded here.

## Required cases

| Case | Scenario / observable oracle | FR / SC | Local task; evidence gate |
|---|---|---|---|
| R01 | Input missing goal/criteria/workspace/check refs or cyclic/invalid steps denies registration; complete input retains exact fields | 001–002 / 001,004 | T002–T004; actual store at T012 |
| R02 | Valid/invalid step transitions, stale CAS, concurrent completion, identical retry/conflicting key; one outcome/state version, no partial checkpoint. Before and after actual restore, vary predecessor `todo/doing/failed/missing` and `done` with invalidated required evidence: zero dependent claim/dispatch/effect. All predecessors `done` with valid proof permits one eligible attempt; ready independent step still progresses | 002–003 / 001,004 | T002,T004–T006; actual concurrent store/restore T012 |
| R03 | Kill after committed step/checkpoint; restore new process/run and unchanged task/workspace/goal/constraints/criteria/steps/evidence/next action; completed-step attempt count stays one | 003–004 / 001 | T005–T006 preparation; T012 durable restart |
| R04 | Kill after durable reserve before claim, after claim before dispatch and after dispatch before settlement; charge retained, reconcile original request/config/pricing/role; zero blind duplicate | 008–010 / 003 | T009–T010; T012 restart for coder and reviewer vectors |
| R05 | Kill after observable non-idempotent effect before stored result; independent effect ledger/repository witness proves count; completion settled once or uncertainty stays held | 004,009–010 / 001,003 | T006,T010 preparation; T012 restart |
| R06 | Actual restart while pending approval, after rejection and after approval-before-claim; retain immutable request/history/hold, fresh binding needed, zero paused agent admission | 006–007 / 002 | T007–T008 seam preparation; T012 controlled seam; T013 actual UC-05 |
| R07 | Deliberate pause shows paused, no new coder/reviewer/model/tool/background work; bounded started read/test/write may finish; early resume declines; later result does not auto-resume; B progresses | 006 / 002 | T007–T008; T012 pause restart, T013 actual admission |
| R08 | Concurrent deliberate pause/UC-05 hold versus claim, concurrent resume/decision, lost commit response: one serialized winner, no runnable gap, no duplicate claim, no hold erased | 006–010 / 002–003 | T004,T008,T010; T012 durable multi-process race; T013 actual executor |
| R09 | Stale revision/worktree/expected files/hash/view: re-inspect, no overwrite, invalidate affected checks/approval; apparently complete task uses current verification or reports unavailable | 004–005,007 / 001,004 | T006; T012 controlled inspector; T013 actual inspector/verification/UC-05 |
| R10 | Individually missing/invalid/exhausted repair/reviewer/token/cost and applicable run scopes; partial reservation denied with zero dispatch; no new-run/role/config-reload reset; authorized increase retains prior history | 008–009 / 003–004 | T009–T010; T012 durable accounting |
| R11 | UC-03 initial plan and three unique material replan charges/reservations survive new run/restart; fourth refused; no UC-04 strategy/materiality invention | 011 / 003 | T010; T012 scripted canonical semantics, T013 actual consumer only if released |
| R12 | Long history compaction retains six fields; independently omit each, inject conflicting completed step/budget/approval/next action; state/repo inspection prevails with zero authority mutation | 012 / 005 | T011; T012 compact then actual restart |
| R13 | Missing/corrupt/incompatible checkpoint/control/ledger, lost acknowledgment, storage failure/uncertain receipt: deny unsafe continuation, no favorable old-state fallback, concise safe next action | 003–004,008,014 / 004 | T002,T004,T006,T010; T012 real-store corruption/failure |
| R14 | Requested status includes goal/completed/hold/outstanding/next action; successful recovery has no separate narration; completed history inspectable; unresolved records cannot be removed | 013 / 004–005 | T011–T012; deletion unavailable until G-RETENTION |
| R15 | Protected-marker/raw-prompt/stream injection into restored records/summary/history/receipt; reject/sanitize safely before use/display; repository code never receives state authority | 014 / 005 | T002,T011–T012; real containment T013 via Tai |
| R16 | Mock/missing adapter provenance cannot enter production path; absent host/profile/adapters cause explicit not-run/denial; two comparable runs account all required cases | 015 / 006 | T012–T014; no missing-as-pass |

R04/R05 must include confirmed non-dispatch, confirmed completion/usage, conflicting evidence, unknown outcome and explicitly supported idempotency cases. Provider seams prove accounting mechanics only; actual provider dispatch/billing/idempotency claims need provider-specific evidence from the owning foundation. R07 uses a controlled side-effect witness for a bounded write; it does not authorize repository commands to modify canonical source/tests.

R02 also rejects unknown/foreign predecessor references and cyclic input at registration. Drift invalidates affected dependency proof before continuation; a completed dependent step or summary cannot retroactively supply it. Observe actual claim/dispatch counters, not only a returned denial. Preserve unaffected completed steps and their history.

## Verification matrix traceability

Use exact row labels under **State, checkpoint, and recovery**:

| Matrix row | Cases / required level |
|---|---|
| Structured task state | R01–R03,R13; durable foundation |
| Step states (`todo`, `doing`, `done`, `failed`) | R02–R03; transitions and durable foundation |
| Checkpoint after task steps | R02–R03,R13; actual persisted checkpoint |
| Process restart recovery | R03–R11,R13; killed old process and separate restored process |
| Resume without duplicate work | R03–R05,R08–R09; actual restart with independent counts |
| Goal, constraints, and acceptance criteria | R01,R03; exact retained fields across restart |
| Cumulative budget recovery | R04,R10–R11; actual ledger restore, no task reset |
| Interrupted budgeted action | R04–R05; kill after reserve and before settlement |
| Context compaction | R12; long history plus actual restore |
| Compaction summary validation | R12; six independent missing-field/conflict cases |
| Long-term repository memory | Deferred G-MEMORY; no foundation pass or cross-task knowledge claim |

Adjacent obligations: **Human approval** Workflow pause/Approval binding/Approve and resume/Reject and adapt/Approval audit trail → R06,R08,R09 with actual UC-05 at T013; **Verification and repair** Controlled termination → R09–R11 with owning verification; **Repository tools and security** Finite execution limits → R04,R10,R16; **Reviewer and observability** Run identity and workflow trace/Token usage and cost → R03,R04,R10,R14–R15. UC-04 does not certify other owners' full matrices.

## Evidence levels and required record

1. **Local controlled behavior**: Actual UC-04 modules with explicit mock external ports, finite test profile and assertions at public seams. Same-process restoration is labeled simulation.
2. **Durable foundation restart**: Actual selected storage/recovery under test with controlled external policy/tool/verification seams. Parent observes acknowledged failpoint, terminates the runtime, confirms old PID exit, starts distinct process, reloads the same durable store/workspace, and records before/after state/ledger/hold/effect witnesses. Parent-held memory or recreating initial fixtures cannot supply recovered authority. This proves only the selected process-crash model, not power-loss durability.
3. **Integrated restart**: Actual UC-05 decision service/store adapter, shared admission/executor/inspector/verification and approved profiles; no mock replacement for those boundaries. Exercise the same kill windows and controls. A scripted foundation task is still not a real integrated feature workflow; G-FEATURE needs its own accepted task/input/check evidence.

Each result records case/fixture/oracle versions and digests, source revision, schema versions, selected backend/adapter revision, platform/toolchain/profile, evidence level, task/original/new run IDs, checkpoint/state/control/epoch/ledger before and after, failpoint acknowledgment, PID/exit or signal/restart observations, expected/actual dispatch/effect/settlement counts, trusted evidence references, safe reason, command/exit and pass/fail/error/not-run. Preserve original request/config/pricing identities and unresolved reservations. Runtime evidence remains ignored under `docs/verification/` or the managed session; no secret-bearing payload may be collected merely as evidence.

For non-dispatch denial, count actual boundary attempts/effects, not only a returned status. Kill windows must be acknowledged by committed state plus an independent effect/dispatch witness where relevant; arbitrary timer sleeps are insufficient. Multi-process races retain each competitor's version/request and one accepted receipt.

Run the full required foundation catalog twice with matching fixture/profile/oracle identities; report added/removed/incomparable cases separately. Foundation gates fail on any required failure/error/not-run. Integrated gates separately require T013 evidence; deferred memory and unapproved later feature workflow stay deferred, never counted as successful foundation cases. A missing required integration cannot be downgraded to a mock pass.
