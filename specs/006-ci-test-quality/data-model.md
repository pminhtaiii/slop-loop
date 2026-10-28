# Data Model

These are contributor-tooling records, not product-runtime entities or new persistence services.

| Entity | Fields and invariants | Lifecycle |
| --- | --- | --- |
| CheckPolicy | ID, immutable required-name list; one active current policy, ci-v1 before Stage A2 and ci-v2 afterward | Defined in one pure module; reviewed atomic activation, no environment/PR-controlled choice, network or writes on import |
| HistoricalMergedHead | Public repository ID, PR number, exact head SHA, source tree, ci-v1; no wildcard/private identity | Audited before staging; admitted only for matching live MERGED identity |
| HistoricalConvention | Public repository ID, PR number, head ref, retained convention version | Explicit identity only; does not grant historical CI policy to an open PR |
| CandidateObservation | Head SHA, PR metadata, convention binding, latest check results, application identity, observation time | Freshly fetched; invalid/missing fields yield non-ready, never cached success |
| BuildArtifactIdentity | Repository ID, run ID, run attempt, canonical H, OS, emitted-file inventory/hashes; distinct B/M provenance for PRs | Created after clean build; matching attempt/source/OS and integrity before runtime tests |
| PolicyFinding | Rule ID, path, optional line/commit; no values/matches/secrets | Sanitized from bounded synthetic/scanner input; raw scanner payload is not retained |
| MutationManifest | Revision/tree and source/test/config/lock hashes, profile, tool versions, settings, commands/statuses, duration, counts, artifact hashes, status | Setup -> running -> completed or failed/incomplete; only completed has an interpretable final report |
| SurvivorDisposition | Source fingerprint, location, operator, replacement, intended behavior, classification, witness/rationale, follow-up | Reviewed meaningful/equivalent/harness/unresolved; no implicit resolved state |

## Validation and state boundaries

- A check name alone is insufficient: candidate head, trusted app, latest run and completed-success all bind readiness.
- After Stage A2, historical binding must match every identity field and live MERGED state. Missing binding is not a fallback; current/open candidates always use ci-v2. Stage A1 has only the unchanged current ci-v1 policy.
- Metadata changes can invalidate readiness without changing SHA; validation consumes live body/title/base/head ref each observation.
- An artifact without matching repository/source/run/attempt/OS identity is unavailable evidence. Distinct PR H/B/M values must not be conflated. Missing or modified emission fails before test execution; old-attempt artifacts do not satisfy reruns.
- A mutation dry run is setup evidence only; a partial manifest cannot transition to completed because the process exited 0. Completion requires fresh identity-matching JSON/HTML, unchanged inputs, zero pending outcomes and consistent totals.
- Detailed local ledgers use the managed implementing session. Tracked task notes point to evidence without requiring ignored reports to exist in clean CI.
