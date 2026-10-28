# Data Model: Paired PR Eligibility Preview

All entities serve US1. No new persisted schema or state transition is introduced.

| Entity | Fields and validation | Relationship |
|---|---|---|
| PublishedPair | Configured public origin/private submission repository identities and development bases; branch; public workflow record and complete submission pair record; exact retained PR numbers/URLs and source/mirror hashes | Existing records identify the only pair the preview may inspect |
| PRObservation | Side, number, branch, state, draft/fork flags, head/base OIDs, mergeability/status, source tree; validated against PublishedPair | Two observations form one snapshot |
| CheckObservation | Required name, run ID, head, app identity, status/conclusion; latest exact-head run per existing required name | Four successful public observations required |
| DocumentationChange | Canonical path, raw diff status/modes, immutable before/after blobs; policy exclusions | Derived only from the public immutable base/head |
| EligibilityReport | schemaVersion 1; policy `docs-v1`; status; eligible; mergeEnabled false; bounded reason codes; snapshot containing heads, bases, shared tree and check signatures | An observation only, never an execution token |

Statuses are `ELIGIBLE_PREVIEW`, `MANUAL_REVIEW`, `WAITING_EVIDENCE`, and `BLOCKED`. Only the first has `eligible: true`; all have `mergeEnabled: false`. A completed observation can be eligible or manual; unavailable/pending inputs wait; known identity, failure, stale/raced or malformed evidence blocks. An unexpected command failure is reduced to a bounded sanitized reason, without dumping credentials, private repository identities, or raw source.

Record bytes and configuration bytes are compared across the observation. Snapshot fields are immutable observations within one report; they have no validity after inputs change and are not consumed by an executor in this phase.
