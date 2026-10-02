# Implementation Plan: Offline Verification Sandbox

**Branch**: `feat/006-offline-verification-sandbox` | **Date**: 2026-10-02 | **Spec**: [spec.md](spec.md)

**Input**: ADR 0011 Q1–Q23, authoritative tool policy, Phase 3 gateway/task contracts, Phase 4 workspace contract, and [research.md](research.md).

## Summary

Implement Phase 5 as a host-owned sandbox module, a developer-only preparation helper, and one hardened offline Linux container per check. One verdict shares a content-identified snapshot across all checks. A stale image ends a task in terminal `BLOCKED` with edits preserved; explicit developer confirmation starts preparation, followed by a newly admitted task. No model-visible preparation tool, resumable task state, supporting database, Compose application, or host fallback is introduced.

## Technical Context

- **Language/Version**: Existing strict TypeScript 5.8, native ESM, Node.js 24; pnpm 12.5.1 for the reference target.
- **Primary Dependencies**: Existing Zod/Pino/Vitest and native workspace addon; Node `child_process`, `crypto`, `https` and filesystem streams. Add maintained direct YAML and archive parsers for bounded schema-validated inputs and safe transfer streams. Docker CLI/Engine and pnpm are trusted prerequisites, not agent tools.
- **Storage**: Bounded application-owned host staging/preparation cache; immutable Docker image IDs/digests and private preparation/ownership records; in-memory verdict identities; sized tmpfs. No database or session restoration.
- **Testing**: Vitest contract/unit/adversarial suites, real Docker integration and E2E on Ubuntu and Windows Docker Desktop Linux mode, existing pinned quality gate.
- **Target Platform**: Trusted local Linux Docker Engine or Windows Docker Desktop Linux containers. Windows containers, remote daemons and VM management are deferred. Repository/model environment cannot choose the Docker endpoint.
- **Project Type**: Private single-package modular monolith; temporary preparation egress infrastructure is allowed, but verification has no supporting services.
- **Performance Goals**: No new latency SLO; one in-flight check and finite byte/time/resource ceilings. Validate against the reference repo before tuning.
- **Constraints**: Non-root, no network, read-only root/toolchain, no host secrets/socket/home or writable checkout, finite task budgets, fresh gateway facts and audit-first dispatch.
- **Scale/Scope**: One checkout, one verdict snapshot, TypeScript/pnpm including its native addon. Narrow public-registry dependency grammar; unsupported local/workspace/exotic sources rejected.

## Constitution Check

`.specify/memory/constitution.md` is an unratified template with no operative gates. Apply project authority: `CONTEXT.md`, tool policy, workflow/TDD, testing/progress, ADR 0001/0003/0007–0011. The application remains a single process/package; sandbox code contains no model logic. Every boundary requires negative, fail-closed, cancellation, real integration and E2E evidence. Planning does not change implementation status. Recheck these gates after design.

## Authority, Prerequisites and Phase Ownership

- Phase 3 provides gateway/policy/runner and fake-port proofs. Phase 4 is incomplete. Unit/fake sandbox work may proceed; safe snapshot integration and the Phase 5 exit gate require the full Phase 4 boundary gate on both hosts.
- Reuse selected workspace identity, Git membership, safe opened handles and held-root enumeration. Point-of-copy access must use safe primitives again; a preflight fact never authorizes a plain path open.
- Snapshot reads have separate trusted bounds from model reads. Extend native enumeration/copy contracts as necessary without increasing the 64 KiB model-read limit.
- Supply `ExecutionFactsPort` and `ToolExecutor` through the existing gateway; the gateway alone dispatches model-visible executors under current Edit authority, budget/fence and successful canonical pre-execution evidence.
- Freeze trusted profile argv, flags, limits, environments, native preludes, generated exclusions and logical-target mappings at session/admission. Model names select approved profiles, never arbitrary commands. Validate existing test targets and audit requested/validated identities.
- Phase 7 owns host grant/patch adapters, Phase 8 interactive CLI, Phase 9 Git evidence, Phase 12 durable JSONL. Use existing ports/fixtures and do not claim those adapters exist. Session file grants keep their existing lifecycle; ended task authority is never restored.

## Bounded Initial Defaults

Planning defaults are finite and must pass real fixtures; only trusted developer configuration can change them.

| Resource | Initial limit | Enforcement |
| --- | --- | --- |
| Verification CPU/memory/swap/PIDs | 2 CPUs; 4 GiB including tmpfs; no additional swap; 256 PIDs | Inspected Docker/cgroup settings; missing enforcement blocks |
| Check wall time | 300 seconds including copy-in/native prelude | Minimum of profile limit and remaining task deadline; independent host watchdog |
| Writable workspace/tmp | `/workspace` 2 GiB; `/tmp` 256 MiB | Sized tmpfs, `nosuid,nodev`; tmp `noexec`; workspace permits native execution |
| Snapshot | 50,000 entries; 256 MiB total; 16 MiB/file | Bounded safe enumeration/copy; oversized eligible input blocks instead of skipping |
| Output | 1 MiB retained combined streams; 32 KiB total model-result envelope | Stop on capture overflow, retain bounded prefix with explicit truncation, drain/discard during cleanup; no unlimited daemon logs |
| Capture/cleanup | 3 total attempts each | Capture inside task deadline; cleanup attempts at most 10 seconds each, separately bounded safety obligation |
| Preparation parsing/download | 16 MiB manifest/config input; 32 MiB lock; 10,000 artifacts; 128 MiB/artifact; 2 GiB compressed aggregate | Strict parser/source graph and broker byte accounting |
| Preparation time | 15 minutes overall; 60 seconds/artifact; 3 total attempts/artifact | Developer-action budget, no restoration of ended task budgets |
| Offline preparation | 2 CPUs, 4 GiB, 256 PIDs; writable tmpfs 2 GiB + 256 MiB | Same hardening baseline; missing space/tools blocks rather than enlarges |
| Host staging/cache | 1 GiB snapshot staging; 4 GiB preparation cache/action; one prep action/workspace | Accounted bounded files, expansion limits and partial-failure cleanup |

Preparation archive expansion/store/image publication must also be bounded. Set a 4 GiB maximum managed exported image artifact and reject overrun; enforce offline package-store limits before publication. Docker daemon storage quota is engine/driver-dependent, so require an externally configured bounded builder/storage boundary for preparation or block. Stream-accounted exports alone do not establish a hard daemon-storage cap. Base-toolchain provisioning is an explicit developer prerequisite, not an unbounded dependency-download loophole.

Accepted storage admission is either Docker Desktop's configured finite disk-image usage limit, or a dedicated Linux builder/daemon data root under an independently enforced filesystem/volume quota. Read the effective configuration through a trusted developer/platform adapter, bind the engine/data-root identity, and record a quota-exhaustion fixture for that exact platform. Linux `overlay2.size` alone covers applicable writable containers only (XFS/pquota prerequisite), not all builder/cache/image storage. `buildx du`, current free space or a user-entered size is not enforcement evidence. If effective whole-boundary limits cannot be verified, preparation stays blocked; no automatic resizing. Reassess identity/configuration and available bounded capacity per developer action.

## Research Decisions and Design

### Preparation authority and network

Use the application-owned recipe and a separately provisioned digest-pinned Linux Node/toolchain base with pnpm, Git, Python, make/compiler and matching Node headers. Verify prerequisites and base identity; no automatic pull, `apt`, package-manager installation or header download during verification. Model/repository inputs cannot set Docker privileges, mounts, network or recipe.

Parse bounded pnpm lock/manifests with a maintained YAML parser and strict Zod schema. Validate pinned grammar/version, every locked source/name/version/integrity and supported platform variant. Reject executable pnpm hooks, config dependencies, credentials and unsupported source forms. Generate sanitized package-manager settings from trusted state, including public registry and exact script policy; do not import repository `.npmrc`/workspace authorization.

Fetch via a fixed trusted pinned pnpm operation with installation scripts and pnpmfile hooks disabled. Its only egress is a temporary app-owned Node CONNECT broker permitting approved public registry hosts on port 443 and public resolved addresses pinned at connection time; prevent direct bypass, DNS rebinding/private/loopback/link-local access and off-allowlist redirects. Exact-artifact enforcement is the validated frozen graph plus trusted fetch semantics plus checked integrity, not merely host allowlisting. A TLS CONNECT broker cannot claim to inspect encrypted paths; fixtures must prove observed artifacts match the allowed graph. An unavailable enforcement mechanism blocks preparation.

The fetch container joins a private internal Docker preparation network. Before pnpm starts, a short-lived application-owned network-setup container shares only its network namespace, installs deny-by-default egress rules allowing the fixed broker address/port, and exits. Only that trusted setup process has `NET_ADMIN`; the fetch process always runs non-root with all capabilities dropped and no-new-privileges, and never receives network administration or the Docker socket. Broker infrastructure is trusted code with no target source/scripts, with a separately connected approved external route. Pin the broker address in generated config so fetch needs no general DNS route. Reject unsupported engine/namespace/firewall behavior unless the no-bypass fixture passes. These temporary resources are owned/cleaned by the preparation helper and are not verification supporting services.

After fetching, terminate network access and install/build from the bounded store offline with frozen lock and no hooks. Generate pnpm's allow map only when every locked identity corresponding to an allowed package name is explicitly authorized; pnpm name-level controls alone are insufficient. Unsupported/unreviewed scripts block rather than silently omit required builds. Root package lifecycle scripts never run automatically. The exact identity script policy is fingerprinted.

Publish only after offline installation, integrity, prerequisite and image smoke checks pass. Resolve friendly tags to immutable local image IDs, verify architecture/base/recipe/preparation records, and execute by immutable ID. Labels or repository-supplied records alone cannot establish trust. Untrusted installation code has no Docker socket, secrets or real checkout mount. Cancellation or failed publication never marks a partial image ready. Record external metadata atomically outside model-visible paths.

### Safe package-store and image-context transfer

Both fetched store bytes and post-install dependency output are untrusted, including files written by an approved script. Never use `docker cp` to extract them onto the host or pass a raw container tar stream directly into a Docker build context. Confirm the producer's child processes are terminated, then freeze its cgroup/container for export while preserving tmpfs; verify freeze support and block if stable bounded export cannot be obtained. Cleanup unfreezes only to terminate/remove, not to continue untrusted code.

Use a maintained tar parser as a direct dependency when needed, with a versioned bounded transfer grammar; parse streams without host extraction. Before any target write reject absolute/drive/UNC paths, `..`/ambiguous separators, malformed or oversized headers/PAX metadata, duplicate/case-colliding paths, hard links, devices/FIFOs/sockets, and entries beyond 50,000 files, 16 MiB metadata, 128 MiB/file or 4 GiB expanded total. Count declared and actual bytes before/while importing, including sparse/extended records; reject unsupported sparse/extension forms rather than trusting their sizes. Fetched store transfer accepts only regular files and directories. The offline install recipient is a no-network non-root read-only-root container with bounded tmpfs and no host bind mount; a trusted importer creates files exclusively beneath its private import root, refuses symlink parents and validates a canonical entry/content manifest. The host may relay bounded opaque bytes, never unpack them.

Final dependency layouts may contain pnpm-generated relative symlinks only after regular content is imported. Resolve every link against the sealed dependency root, require an existing in-root regular/directory target, reject cycles/escapes, and install links last; never follow them during writes. External/absolute/special/hard links block publication. Hash/export from the frozen producer, validate the completed dependency tree again, and let the trusted publisher create a new sanitized context from those checked entries only. That publisher has no repository/package code execution and no raw hostile archive extraction. Image metadata is published only after the bounded output manifest, prerequisite and immutable-image checks pass. Host staging, container imports, builder storage and cancellation share the action's finite accounting; failure destroys only owned partial output and preserves the previous good image.

### Content-identified snapshots

Pause application writes, validate the held checkout identity, enumerate eligible tracked/nonignored untracked inputs through Phase 4, and recheck safe opened handles at copy time. Deny secret aliases, nested repositories/mounts/reparse boundaries, hard links, special files, and unsafe identity changes. Materialize allowed in-repository symlink content into regular snapshot entries with alias/resolved provenance; do not preserve symlinks/hard links or cycles. Reject Linux path/case collisions.

Copy exclusively into private staging and hash the actual copied bytes; record logical path, size, executable mode and content digest. Sort entries and hash a versioned canonical manifest for snapshot identity; bind trusted exclusion policy. Exclude `.git`, denied secrets, nested repos, every host `node_modules`, and trusted reference outputs `dist`, coverage, `native/**/build`. Do not use a broad exclusion that could hide real source. Oversize eligible inputs fail, never silently disappear.

Rescan/hash the checkout's eligible path set/content/metadata; observed differences discard the copy and retry finitely. Root/fact unavailability fails closed. This is non-atomic copy-and-compare; watchers are advisory and rapid edit-and-restore between observations is outside the guarantee. Derive preparation inputs from captured bytes and recheck fingerprint before execution. Keep staging immutable for the entire verdict; never recapture between contributing checks.

### Docker backend and check execution

Use Node `spawn` with fixed runtime argv, trusted executable/local endpoint and sanitized environment, never shell interpolation. Inspect Linux engine, cgroups, security settings and immutable image identity. Mount only private snapshot staging read-only at `/snapshot`, never the actual checkout. Fixed non-root UID/GID, no network, read-only root, drop capabilities, no-new-privileges, default seccomp, sized tmpfs `/workspace` and `/tmp`, bounded shared memory/runtime writable mounts, CPU/memory/swap/PIDs, and disabled/unlimited-log-free capture are mandatory.

A trusted bootstrap copies manifest-approved regular entries to tmpfs and wires image-provided read-only dependencies. No install occurs. Each check starts from the same snapshot in a fresh container. Compile repo-owned native code from that copy using the pinned node-gyp executable with fixed arguments and the prepared local header directory only when the trusted profile requires it; a failed prelude stops the consuming check. Reference tests/lint/typecheck/build map to trusted pnpm argv, treating the package scripts as untrusted code inside isolation.

Exclude host-owned Docker/security integration suites from the nested reference verification profile through trusted explicit Vitest selection, not repository-supplied skips. The outer host/CI harness runs real sandbox fixtures; never mount a socket or recursively start Docker inside repository verification. The full quality/security gate remains separate and mandatory.

### Verdict, gateway, stale task and cleanup

Before each call refresh profile/readiness facts, authority, budget and cancellation fence, and append required canonical request/decision evidence. Recheck snapshot-bound fingerprint and immutable image at executor point of use; readiness cannot be cached as permission. Bounded sanitized results carry identities, exit/termination, truncation, freshness and cleanup, not raw secrets/host paths.

The current `TrustedExecutionFacts` only contains `approvedProfiles` and `executorReady`; false currently yields `DENY / EXECUTOR_NOT_READY`, and the gateway's `BLOCKED` union only covers audit failures. Phase 5 must explicitly extend the trusted execution-fact/port and gateway result contracts with a bounded external readiness assessment such as `READY` or `EXTERNAL_BLOCKER` with `PREPARATION_REQUIRED`, `IMAGE_STALE`, `RUNTIME_UNAVAILABLE` or `CLEANUP_UNCONFIRMED`. Check tool/mode/state/capability/profile/target eligibility independently before exposing this external blocker. Only a healthy trusted readiness provider may produce it; missing/malformed facts still policy-fail. Preserve legacy boolean-only ordinary denial behavior rather than converting every `EXECUTOR_NOT_READY` into preparation. Append canonical decision/blocker evidence before returning; stale/preparation results are typed gateway blockers with zero executor calls, mapped by the existing runner to terminal `BLOCKED`. This is a minimal authority/result contract extension in `src/policy/engine.ts`, `src/tools/gateway.ts` and the sandbox adapter, not a new task state or an adapter pretending to dispatch through a denied call.

A trusted task-attempt coordinator owns one verdict across the existing four tool names. The first eligible call captures and seals its snapshot/image/profile-set and required check set; the reference set is full tests, lint, typecheck and build. Calls execute only their approved check in a fresh container and accumulate evidence in that coordinator. A targeted test subset is diagnostic and cannot satisfy full-tests coverage. Duplicate calls cannot replace a failure or count twice; a retry starts a new bounded verdict with a fresh snapshot and no evidence carried across attempts. An observed checkout change before another call invalidates the active verdict rather than recapturing within it. Incomplete calls report partial evidence and never passing task verification.

After every required check succeeds with settled cleanup and canonical result evidence, the coordinator performs final checkout comparison and issues trusted completion evidence bound to task/attempt/verdict and all identities. Extend the runner's current bare `VERIFICATION_RESULT {passed:boolean}` seam for sandbox-backed tasks: accept success only from validated complete coordinator evidence for the active attempt; reject model/repository-supplied booleans, stale/replayed identities and a single successful subset. The trusted event adapter is the sole producer; existing fake-port tests must construct equivalent complete evidence. Historical `PASS + STALE` cannot complete an edited task. Missing final comparison produces no fresh pass. Reverification stays within task/retry budgets; no infinite loop or automatic image rebuild.

Stale/missing prep or unhealthy external execution maps to terminal `BLOCKED`; invalid authorization/path authority maps to the existing policy-failure contract. Approved edits remain. Developer confirmation binds workspace, fingerprint, recipe and action identity and is invalidated by relevant drift. Helper preparation is outside the ended task; a newly admitted task reevaluates current repository state and captures again. No new task state or restored task authority.

Cancellation immediately fences late output/new commands. Stop/remove with bounded retries; retain the execution slot while local effects remain possible. If cleanup stays uncertain, report owned resource identity, block verification and persist minimal private reconciliation state. Startup cleanup requires both a valid ownership record and matching immutable IDs/labels for the instance/workspace; never global prune, arbitrary name matching or deleting unrelated resources. Cleanup/audit failure never replays repository execution.

Explicitly extend `TaskRunner.process`, cancellation/`settleToolAttempt` and `TaskCheckoutSlot` in `src/orchestration/runner.ts`: today's terminal/cancelled paths release the slot, so add a trusted outstanding-effect/cleanup hold that prevents those releases while removal/stop is uncertain. Trusted effect/settlement state must reach the runner before any terminal release path; missing or uncertain settlement retains the hold. Terminal task state remains terminal; the retained lease grants no task execution authority. Only a trusted cleanup/reconciliation acknowledgement matching the owned resource/task/generation can settle the hold and release once. New task admission for that checkout fails while held, including after restart until private reconciliation reconstructs and settles the workspace hold. Late/wrong-generation successes cannot release it. Ordinary stale-image BLOCKED with no effects and confirmed clean completion release normally. Prove these paths in runner integration fixtures, not only a sandbox-local mutex.

The coordinator owns snapshot staging and partial imports through private ownership records. Retain the sealed snapshot across contributing calls only; after pass/fail/stale/cancel/abandoned verdict, first settle consumers then delete owned staging with the same finite cleanup allowance. Partial capture removes its staging before retry. Failed deletion reports `CLEANUP_UNCONFIRMED`, keeps byte accounting/reservation and blocks new capture/verification until trusted reconciliation confirms removal. Startup reconciles recorded staging under the fixed private staging root using safe handles, never repository-supplied paths or broad deletion. No passing task completion precedes required staging cleanup confirmation.

## Threat Review

| Threat | Control | Evidence |
| --- | --- | --- |
| Repo recipe/config grants privilege | App recipe, strict generated config, no hooks | Hostile Dockerfile/npmrc/pnpmfile fixtures |
| Artifact/redirect/DNS/bypass abuse | Frozen graph, broker/public-address enforcement, integrity | Exact artifact, off-host/private IP, rebinding and direct-bypass tests |
| Version-confused dependency scripts | Every locked identity checked before name map | Multi-version/integrity-change fixtures |
| Snapshot escape/race/overflow | Safe handles, regular materialization, bounded manifest/rescan | Swaps, secret aliases, mounts/repos, races and overflow |
| Stale image or mixed verdict | Immutable ID, snapshot-bound prep hash, one snapshot | Tag swap, dep edit during capture, mixed identity rejection |
| Host access/writeback | Hardened offline container, only staging read-only | No host/socket mounts, no network/system writes |
| Fork/output/disk/time abuse | Enforced caps, bounded capture/logging, host watchdog | Real exhaustion/flood/timeout fixtures |
| Cancel/cleanup uncertainty | Fence, finite cleanup, slot ownership/reconciliation | Late output, daemon loss and ownership conflict |
| Forged confirmation/audit/stale facts | Developer action, call-scoped gateway/audit ordering | Repo/model confirmation, audit outage, revoked task |

Residual kernel/runtime escape and missed rapid external edit-and-restore races remain explicit limitations, not VM/atomic-snapshot guarantees.

## Project Structure

### Documentation

`specs/006-offline-verification-sandbox/`: spec, plan, research, data model, `contracts/sandbox.md`, quickstart, tasks, requirements checklist and generated issue map.

### Source and tests

```text
src/sandbox/
  types.ts          # narrow SandboxBackend, identities and outcomes
  config.ts         # trusted profiles/source/script policy and limits
  snapshot.ts       # safe capture, manifest and freshness
  preparation.ts    # developer action, fingerprint and publication
  downloads.ts      # validated locked graph and approved-source fetch
  broker.ts         # trusted temporary public-destination tunnel and net setup
  archive.ts        # bounded hostile store/context transfer, never host extraction
  docker.ts         # fixed-argv Linux lifecycle and hardening checks
  verification.ts   # same-snapshot verdict/native prelude
  gateway.ts        # execution facts/executor and runner mapping
  cleanup.ts        # stop/removal and owned-resource reconciliation
scripts/prepare-verification.ts   # developer helper, never a model tool
sandbox/verification.Dockerfile  # application-owned pinned offline recipe
tests/sandbox/                   # contracts/unit/real Docker/security/E2E
```

Change existing workspace/tool/policy/orchestrator seams only as necessary, plus `package.json`, `pnpm-lock.yaml` and CI. The requested `SandboxBackend` is a narrow single-backend port, not a general plugin framework. No second application or general command executor.

## Implementation Sequence

1. Foundational typed contracts, trusted config/fingerprint and tests without executing repository code.
2. US1 safe snapshots and real offline checks of a valid prepared fixture, resource limits/native prelude.
3. US2 developer-only restricted preparation and immutable publication.
4. US3 gateway/runner, freshness and blocked/new-task handoff.
5. US4 cancellation/cleanup/restart ownership and abuse fixtures.
6. Mandatory prerequisite/full quality/security/E2E gate, dual-axis review, context synchronization. Source tests alone do not prove the sandbox exit gate.

## Complexity Tracking

| Choice | Why needed | Simpler alternative rejected |
| --- | --- | --- |
| Temporary prep egress broker | Approved public destinations and no bypass | Registry config alone is not network containment |
| Sized tmpfs | Portable finite writes with no host writeback | Overlay quotas depend on storage driver |
| Manifest/rescan | Tested bytes and checkout freshness | Git status/timestamps cannot prove content identity |
| Separate developer helper | Accepted prep lifecycle without model authority | Automatic installs/task resumption expand authority |

## Post-Design Constitution Check

The design preserves one trusted application, closed tools, no arbitrary shell, offline verification, audit-first gateway, finite task/cleanup bounds and developer-owned Git writes. Research resolves mechanisms/defaults without claiming implementation. Integration remains gated if Phase 4, real platform hardening, exact source/script enforcement, preparation quota accounting or cancellation/cleanup cannot be proved. No unresolved clarification placeholder substitutes for a required security fixture.
