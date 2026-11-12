# Data Model: UC-06

No new persistence or allowance owner. Closed fields are defined once in [review contract](contracts/review-context.md); canonical records remain imported unchanged.

| Entity | Story | Identity / relationships | Validation and lifecycle |
|---|---|---|---|
| ReviewProfileV1 | US1/US2 | Trusted profile/version + prompt/schema identity + finite content/output limits | Immutable, digest-bound; missing bounds refuse; production approval separate from fixture values |
| ReviewContextV1 | US1 | task/run/repository/workspace, measured base/head/diff; criteria/check/verification/convention/evidence/profile digests; current authority | Immutable prepared input, safe content and current acknowledged evidence; model cannot populate authority |
| Evidence index | US1 | Bounded approved SourceEvidence and content-addressed owner refs tied to context | Every finding resolves; source/log data untrusted; baseline origin retained; private labels absent |
| ReviewFinding / ReviewResult | US1 | Existing canonical shape/severity/status and review/reservation identity | UC-06 adds mandatory resolvable evidence, byte/count/rationale checks without changing legacy schema |
| ReviewObservationV1 | US1/US2/US3 | Context + provider request/result + exact accounting refs + tier/disposition | Owner retains acknowledgment; current/stale/uncertain separate, accepted never bypasses completion |
| ReviewEvidencePortV1 / ACK | US1/US3 | UC-04 supplement; immutable observation/context/provider/task identity, record version, committed receipt and atomic candidate discovery index | Explicit persist/load/recover unions, current authority checks, lost-ACK discovery with no graph locator, no fallback to older accepted; controlled double is not storage delivery |
| Evaluation case/label/grade | US3 | Frozen case/public diff and separate independently authored expected faults/rubric; candidate/model/profile pins | Labels host-private, grade independent of output generation; not-run is not pass; match by file/side/revision/line range/defect meaning |

## State transitions

Prepared context → refused (zero new constrained calls) or admitted request → observed/invalid/uncertain provider outcome → validated current finding/acceptance or stale/blocked observation. Observation persistence uncertainty blocks completion; reconciliation stays with owner.

Actionable current findings → existing Repair → Patch → Verify → new Review. New head invalidates prior checks/review. Accepted current review plus required current verification/ancestry/harness predicate → Deliver. A stale/invalid/uncertain review never implies acceptance.

Owner settlement may advance control/accounting versions while repository/plan remain unchanged; post-review comparison permits only exact documented chain deltas. Paused/rejected state or unrelated generation changes invalidate continued authority.

## Recovery and retention

UC-04 stores task/control/journal/evidence/checkpoints, including consumed/reserved reviewer iteration/token/cost and original pricing. UC-05 owns immutable consent/current validity. Host context/observation are references to those facts, never replacement journal or durable proof from a process-local map. Restart revalidates repository and owner state, resolves exact uncertain predecessor and retains original task identity. New run ID cannot reset allowance. Artifact retention/redaction is approved operator policy; this plan selects no backend or auto-deletion.
