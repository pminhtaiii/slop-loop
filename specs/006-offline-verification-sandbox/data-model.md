# Data Model: Offline Verification Sandbox

All authority objects originate in trusted application state. Repository-derived values are validated data; identities and audit records do not themselves grant permission. These are design contracts, not implemented types.

## TrustedSandboxConfiguration

- Fixed local Docker executable/endpoint and Linux architecture, pinned base digest, Node/pnpm versions and recipe version/hash.
- Approved public registry destinations, source grammar, TLS/public-address policy and exact locked dependency script allowlist.
- Named profile set: fixed argv, environment, logical-target mapping, generated-output rules, native prelude and per-check limits; include a canonical `profileSetId`.
- Resource, download, snapshot, output and retry ceilings from plan; schema rejects unknown fields, credentials, raw model argv, unbounded values and unsupported policy.
- Captured at trusted helper/session admission; changed trusted configuration requires fresh admission/preparation where fingerprint-relevant.

## PreparationInputs and PreparationFingerprint

`PreparationInputs` holds canonical dependency manifest/lockfile hashes, sanitized manager-config identity, exact script policy identity, Node/pnpm versions, Linux architecture, base digest and recipe hash. Parsing is bounded and complete; unsupported source/hook/config fields cannot become authority.

`PreparationFingerprint` is SHA-256 of a versioned canonical representation of those inputs. Keep raw input bytes out of diagnostics. Source-only changes do not affect this identity. Dependency data taken from a verification snapshot must produce the same fingerprint before code starts.

## LockedArtifact and ExactScriptGrant

- `LockedArtifact`: canonical name, exact version, source registry, allowed artifact identity, integrity algorithm/digest, platform constraints and bounded expected download metadata. No embedded credential, executable hook, arbitrary protocol or unsupported URL.
- `ExactScriptGrant`: trusted name/version/integrity and permitted lifecycle stage(s). A package-name-only match is insufficient. If pnpm controls are name keyed, every locked occurrence for that name must be approved before generated name-level permission is enabled.
- Fetch status: `PLANNED → FETCHING → INTEGRITY_VERIFIED`; any redirect/source/integrity/size failure is terminal for that artifact/action after applicable finite transport retries. Integrity/policy failures are not retried as network success candidates.

## DeveloperPreparationAction

- Opaque action ID, trusted confirmation identity, selected workspace identity, requested fingerprint, recipe/config identity, confirmation time, abort signal and finite preparation budget.
- Confirmation is produced only by the developer-facing trusted entry point. Model/repository strings cannot construct it; changed relevant inputs invalidate the pending action.
- States: `CONFIRMED → FETCHING → INSTALLING_OFFLINE → VALIDATING → PUBLISHING → READY`; terminal alternatives `FAILED`, `CANCELLED`, `BLOCKED`. These are helper-local states, not new task states.
- One active action per workspace; partial images/stores never become ready. An ended coding task owns neither this action nor its budgets.

## TransferManifest

Versioned canonically sorted entries describe regular store/output bytes, type, size, content hash and any separately validated final-layout relative link. A producer is quiesced/frozen before export; streaming grammar, metadata/entry/per-file/expanded-byte caps apply before writes. Store imports allow no links or special files; final layout links are installed last only for existing in-root targets. Import happens inside bounded offline isolation with no host extraction, then a sealed validated manifest drives trusted image-context publication. Invalid or incomplete transfer never yields a ready image.

## PreparedImageRecord

- Fingerprint, immutable local image ID, base digest, Linux architecture, toolchain versions, recipe/script-policy identities, prerequisite-check result, preparation action identity and format version.
- Written atomically to application-owned storage after successful publication; no repository-owned record or label alone is trusted.
- `READY`, `STALE`, `MISSING`, `UNHEALTHY` are current assessments, not permanent authority. Reassess at invocation point of use. Friendly tags are diagnostic only.
- Image retention is separate from ephemeral container lifetime; delete only positively owned partial images or explicitly managed records, never unrelated/shared bases.

## SnapshotEntry and VerificationSnapshot

- Entry: canonical logical relative path, regular materialized type, size, executable mode, SHA-256 content hash, permitted alias/resolved provenance. Snapshot contains no links, special files or unsafe/colliding paths.
- Snapshot: format version, selected workspace identity, trusted exclusion-policy ID, canonically sorted entries, total bytes/count, snapshot ID and private staging handle.
- ID hashes canonical entry data/exclusion identity; actual copied bytes define the digest, not reread paths or mutable Git status.
- Lifecycle: `CAPTURING → RESCAN → SEALED`; observed mismatch discards and retries within 3 total attempts; unavailability/bound violation blocks or policy-fails as appropriate. Sealed staging is immutable until the verdict settles.
- This is observational copy-and-compare. It does not prove absence of every rapid change-and-restore or provide an atomic filesystem snapshot.

## VerificationInvocation

The gateway consumes a separate current trusted readiness assessment: `READY` or `EXTERNAL_BLOCKER` with a bounded external reason. This explicitly extends today's boolean readiness contract; it is not a reusable permission, ordinary denial override, or repository-supplied state. Missing/malformed authority still policy-fails. Check mode/tool/state/capability/profile/target eligibility before mapping an external blocker; append required decision evidence and execute zero repository processes.

- Invocation/task/session/workspace identities, sealed snapshot ID, prepared-image ID/fingerprint, profile-set/profile/validated-target identities, current task fence and remaining time.
- Fixed resources and trusted argv/native prelude selected internally; no raw model command field.
- One fresh hardened container, one writable clone, one check. Native prelude executes in that clone under the same time limit, never from a newer checkout.
- Status: `CREATED → HARDENING_VALIDATED → COPYING → NATIVE_PRELUDE → CHECKING → CLEANING → SETTLED`. No further code starts after abort, ended authority or unsafe cleanup.

## CheckEvidence and VerificationVerdict

- Evidence: snapshot/image/fingerprint/profile/target IDs, exit code or bounded termination reason, native-prelude outcome, elapsed time, sanitized capped output, truncation flags and cleanup confirmation.
- Verdict: expected check set, matching evidence list, aggregate `PASS | FAIL | INCOMPLETE`, and separate freshness `CURRENT | STALE | UNCONFIRMED` from final manifest comparison.
- A trusted task-attempt coordinator retains the sealed snapshot and required full-check coverage across tool calls. Completion evidence binds active task/attempt/verdict and canonical results; only its trusted adapter can issue it to the runner. Partial/targeted/duplicate calls and bare booleans cannot complete verification; a retry discards earlier coverage.
- Reject duplicate/unexpected checks and mixed snapshot/image/profile-set results. `PASS + CURRENT` alone can map to current-attempt passing verification evidence; `PASS + STALE` is historical evidence and cannot complete an edited task.
- `UNCONFIRMED` freshness, uncertain cleanup or missing canonical result evidence stops unsafe continuation. Audit retries never re-execute the check.

## OwnedResourceRecord and CleanupResult

- Opaque resource ID, application instance/workspace/action/invocation identity, immutable engine identity, expected labels and creation record in private application storage.
- Result: `CONFIRMED_REMOVED`, `CONFIRMED_STOPPED_REMOVAL_PENDING`, `UNCERTAIN`, with bounded diagnostic identity and attempt count. Unconfirmed stop/removal blocks further verification; possible live effects retain the execution fence/slot.
- At restart, matching labels plus the private record and IDs are required; conflicts are reported for developer action. Never global prune or broad prefix deletion.
- Verdict coordinator records own sealed/partial host staging as well as containers. Remove staging on every settled verdict exit; uncertain deletion retains byte reservations and blocks next capture/verification and passing completion until safe owned-resource reconciliation succeeds.

## Existing Task Lifecycle

Missing/stale image is an external preparation blocker: the task enters existing terminal `BLOCKED`, keeps approved edits, and reports required preparation. Developer confirmation runs the helper independently. A new task undergoes normal admission and repository reevaluation; no blocked task resumes or regains task authority. Valid session-scoped grants remain subject to existing session/grant rules, not carried by preparation evidence.
