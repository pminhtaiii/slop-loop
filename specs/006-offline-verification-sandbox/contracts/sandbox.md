# Contract: Offline Verification and Developer Preparation

These internal/developer-helper contracts connect Phase 5 to existing workspace, gateway, task and audit boundaries. They add no model-visible tool name. The source of authority remains `coding-agent-context/context/tool-policy.md`.

## Trusted helper entry point

`prepareVerification(confirmedDeveloperAction, trustedConfiguration, abortSignal)` returns a typed ready-image record or bounded failure/block/cancellation result. The Phase 5 helper at `scripts/prepare-verification.ts` can expose this to a developer; future CLI prompting belongs to Phase 8.

Required action binding: trusted confirmation, current workspace identity, validated input fingerprint, application recipe identity and preparation policy. Reevaluate before fetching; a changed binding requires a new confirmation. No public boolean/string such as `approved: true` from model/repository content can manufacture authority. The helper is outside all model tool executors and an ended task cannot invoke it.

Preflight rejects unknown source/protocol/config/hooks, credential requirements, unsupported lock/tool versions, absent integrity, unreviewed exact dependency scripts and missing pinned toolchain. Downloading executes no project/dependency code; the broker proves approved public destinations and no direct bypass. Fetch observed artifacts must match the supported validated locked graph and pass integrity/size checks. Later install/build is offline and non-root; pnpm hooks and root lifecycle scripts remain disabled, with exact approved dependency scripts only.

Publish a trusted record only after fully successful offline validation and immutable image resolution. Failed/cancelled/blocked preparation has no ready record; preserve bounded diagnostics and cleanup owned partial artifacts. Verification never pulls/installs/prepares automatically.

## Untrusted store/output transfer

Fetched stores and post-install output remain untrusted. Freeze a quiesced producer for stable export; never extract raw `docker cp` tar output on the host or feed it unchecked to a builder. Stream-parse with a maintained parser and strict bounded grammar, rejecting absolute/drive/UNC/traversal paths, ambiguous separators, duplicate/case collisions, malformed/oversized metadata, hard links, special files and unsupported sparse/extensions before writes. Enforce 50,000 entries, 16 MiB metadata, 128 MiB/file and 4 GiB expanded aggregate plus action/staging/tmpfs limits against actual bytes, not compressed size alone.

Fetched stores contain only regular files/directories. Import into a no-network non-root bounded tmpfs container without host mounts; use private exclusive creation and never follow symlink parents. Host relay is opaque bounded bytes without extraction. For final pnpm dependency layouts, allow only validated relative links to existing in-root regular/directory targets; check cycles and install links last after regular content. Freeze/export/hash and revalidate the sealed tree before a trusted no-code publisher generates a sanitized context. Any unsafe entry, expansion/freeze/import failure or unknown ownership blocks publication and cleans only owned partial resources. No unchecked archive or executable dependency input enters host filesystem extraction/build actions.

## SandboxBackend

The narrow port accepts only trusted runtime construction. It does not accept arbitrary model argv, mounts, images, networking or permissions.

| Operation | Trusted input | Outcome |
| --- | --- | --- |
| `readiness` | Selected local engine, prepared record, configuration/profile identity | Current immutable Linux image and enforced-limit readiness or explicit external blocker |
| `executeCheck` | Sealed snapshot, prepared record, validated trusted profile/target, current task fence/deadline | Check evidence plus cleanup status; no host mutation output |
| `stopAndRemove` | Positively owned resource record and bounded cleanup allowance | Confirmed cleanup or uncertainty; never executes repository code |
| `reconcileOwned` | Private ownership records, trusted engine/instance/workspace identity | Bounded reconciliation report, conflicts preserved for developer action |

`executeCheck` has non-root/no-network/read-only root/drop-capabilities/no-new-privileges/default-seccomp invariant, fixed local daemon, sized tmpfs, finite CPU/memory/swap/PID/time/output limits and sanitized environment. Mount only application-owned snapshot staging read-only, not the real checkout. Prevent daemon log growth. Bootstrap copies regular manifest entries into `/workspace`; `/tmp` is writable, system/toolchain are read-only. Stage/image metadata cannot request additional writable paths.

Native prelude and the consuming check execute in the same fresh clone and budget. A native failure prevents the requested check from starting. Dependency store is image-provided and read-only; no offline reinstall workaround may execute unexpected scripts at verification time. Execute by immutable image ID, never a tag.

The internal combined stdout/stderr retention cap is 1 MiB. Crossing it stops the check with an explicit output-limit failure, retains only a bounded sanitized prefix, and drains/discards during bounded cleanup; it cannot count as a passing truncated check. The entire model/audit verification envelope remains within 32 KiB including identity fields, not 32 KiB per stream.

## Snapshot boundary

`captureSnapshot(selectedWorkspace, trustedExclusionPolicy, captureLimits, abortSignal)` uses safe opened handles/traversal, not raw repository `fs.readFile(path)` after preflight. Copy eligible working-tree/untracked inputs into private staging with exclusive creation and no links. Use permitted alias/resolved provenance and reject source identity replacement, unsafe mount/reparse/hard-link/special-file or path collisions. Existing in-repository readable symlinks may be materialized as regular copied bytes when boundary policy permits.

Hash actual copied bytes and executable metadata; canonicalize a versioned sorted manifest. Full rescan must match eligible paths/content/metadata; observed drift discards and retries at most 3 total attempts. Bound count/total/per-file bytes and stop on overflow. Held-root/fact failure is policy failure, not a retry that bypasses the boundary. No result claims atomic capture or authorizes access merely because its manifest hashes match.

`compareCurrent(snapshot, currentWorkspaceFacts)` returns `CURRENT`, `STALE`, or `UNCONFIRMED`; it uses fresh safe traversal/hashes and never relies solely on Git status, timestamps or watchers. Staging remains immutable for the whole verdict. All contributing checks clone that same snapshot, never capture independently.

## Preparation and profile identity

Canonical preparation fingerprint covers dependency manifests/lock, approved generated manager configuration, exact script allowlist, Node/pnpm versions, Linux architecture, base digest and trusted recipe. Use a format-versioned SHA-256 representation. The recorded immutable prepared-image ID and prerequisite evidence are validated separately from input fingerprint.

Compute preparation input identity from captured bytes and compare it immediately before starting code; a preliminary live-checkout check is not sufficient. A profile-set ID additionally seals trusted command/target mapping/native preludes/exclusions and limit policy for the verdict. Relevant profile changes cannot be introduced mid-verdict. No `.npmrc`, workspace field, Dockerfile, package script or model call changes the authority objects.

## Model-visible gateway seam

Use existing `run_tests`, `run_linter`, `run_typecheck`, `run_build` names with their closed schemas. Trusted `ExecutionFactsPort` supplies fresh approved profile/readiness facts; exact name/target maps to fixed argv without executable/flag injection. Current Edit capability ceiling, task state, budget and abort fence are rechecked by the existing policy/gateway.

The current boolean `executorReady` does not encode an external blocker. Extend the trusted execution assessment with `READY` or `EXTERNAL_BLOCKER` plus a bounded known reason, and extend the gateway's typed `BLOCKED` result beyond audit failures. Independently evaluate name/mode/state/capability/profile/target eligibility first. Only a schema-valid trusted external readiness result yields a zero-executor blocker; absent/invalid authority remains policy failure and unapproved profiles remain ordinary denial. Boolean-only `EXECUTOR_NOT_READY` is not automatically reclassified. Canonical request/decision/blocker evidence precedes return; the runner maps the explicit gateway blocker to its existing terminal `BLOCKED` outcome.

Canonical request/decision append must succeed before dispatch. Result sanitization, schema/byte validation and secret removal precede model context and canonical result evidence. Use existing fake sink until Phase 12 supplies durable JSONL; operational preparation diagnostics are not permission or canonical tool evidence.

The executor result includes invocation/check, snapshot, preparation/image/profile/target identities; exit/termination/native-prelude state; retained output/truncation; freshness; and cleanup status within the registered 32 KiB verification envelope. The 1 MiB internal capture allowance does not enlarge model/audit payload limits. Registry/output contract changes are minimal and name-specific.

## Task/runner mapping

A trusted task-attempt coordinator retains one snapshot/image/profile-set and required check set across the four tool calls. The reference verdict requires full tests, lint, typecheck and build; targeted tests are diagnostic only. Each call contributes one fresh-container check, with partial evidence until all required checks succeed. Duplicate/subset results cannot satisfy coverage or erase failure. Drift invalidates the verdict; retries start a new bounded attempt with no reused evidence. Final comparison follows the complete set. Only the trusted adapter may emit completion evidence bound to the active task/attempt/verdict, complete check identities, canonical evidence and settled cleanup. Extend the runner's bare success-boolean seam for sandbox tasks to validate this evidence; model booleans, missing checks and replayed/stale verdicts cannot authorize `VERIFICATION_RESULT` success.

- Missing/stale image or healthy authority with unavailable Docker/snapshot stability is an external `BLOCKED` outcome. Revoke/fence late execution; preserve approved edits. The explicit external blocker consumes no denial/model recovery retry and triggers no budget promotion; ordinary dispatched-attempt accounting remains unchanged.
- Missing/invalid trusted authorization/path facts or failed security component follows terminal `FAILED / POLICY_FAILURE`; never host fallback.
- Validly denied profile/target/Ask execution remains ordinary deny, with existing bounded runner recovery; do not reclassify every denial as external preparation.
- `PASS + CURRENT` for the current attempt, complete configured check set, same identities, successful canonical result evidence and settled cleanup may produce passing verification evidence. `STALE`, `UNCONFIRMED`, mixed/incomplete result or uncertain cleanup cannot.
- On stale prep, terminal `BLOCKED` cannot resume. Explicit developer preparation then a new admitted task reevaluates state/snapshot/authority; task budgets and authority are not restored. Existing valid session file grants are still governed by their original rules.
- Stop cancels pending work, ignores late successes and retains the checkout slot until effects are fenced/settled. Safety cleanup has its own finite deadline even if normal active-work time expires; indefinite cleanup or premature slot release is forbidden.
- Extend the existing runner terminal/cancel/settle release paths and TaskCheckoutSlot with a trusted outstanding-effect hold. Uncertain cleanup prevents release and new checkout admission; matching trusted reconciliation settles the hold exactly once. Restart reconstructs the workspace hold before admission. Terminal state never regains authority, and stale-image blockers with no effects release normally.

## Failure and recovery

Verdict-owned sealed/partial staging is tracked privately and removed after every verdict exit once consumers settle, including cancellation and abandoned attempts. Finite cleanup retries and safe root-bound handle deletion apply. Unconfirmed removal retains storage accounting, returns cleanup uncertainty and blocks new capture/verification and passing completion; restart reconciles only positively owned staging, never arbitrary paths. Preparation quota readiness verifies effective whole-builder storage configuration and platform exhaustion evidence, not usage reports or a declared number.

Typed bounded reasons distinguish `PREPARATION_REQUIRED`, `IMAGE_STALE`, `DEPENDENCY_SOURCE_DENIED`, `INTEGRITY_FAILURE`, `SCRIPT_NOT_APPROVED`, `PREREQUISITE_MISSING`, `SNAPSHOT_UNSTABLE`, `SNAPSHOT_LIMIT`, `RUNTIME_UNAVAILABLE`, `HARDENING_UNAVAILABLE`, `TIMEOUT`, `RESOURCE_LIMIT`, `CANCELLED`, `CLEANUP_UNCONFIRMED` and existing policy/audit failures. Outcome categories stay aligned with the current task contract; no new task states.

Retry transport errors/capture drift/cleanup only within their specific finite allowance. Never retry a policy/integrity failure as though it could become authorized. Persist minimal owned resource identity for restart reconciliation; match private ownership records and expected IDs/labels, report conflict, never global prune. Cleanup/result audit retries never rerun an executor.
