# Feature Specification: Offline Verification Sandbox

**Feature Branch**: `feat/006-offline-verification-sandbox`

**Created**: 2026-10-02

**Status**: Design specified; implementation not started.

**Input**: Phase 5 grilling decisions Q1–Q23 in [ADR 0011](../../docs/adr/0011-disposable-offline-verification-containers.md). Repository content supplies data and code; trusted application state supplies authority and execution policy.

## User Scenarios & Testing

### User Story 1 — Verify the actual edited repository offline (Priority: P1)

As a developer, I want checks to execute against the same identified copy of my current work without executing repository code on my host or altering my checkout.

**Why this priority**: Verification is the sandbox's primary product value and security boundary.

**Independent Test**: Supply a previously prepared valid environment, admit an Edit task, capture a permitted fixture checkout, and run checks against disposable copies. Assert result identity, confinement, limits, and an unchanged developer checkout.

**Acceptance Scenarios**:

1. **Given** a valid prepared environment and edited checkout, **when** verification runs, **then** all checks in the verdict use fresh isolated copies of one content-identified snapshot, including eligible untracked files and approved edits.
2. **Given** denied secrets, repository metadata, another repository, host dependencies, and stale generated files, **when** capture runs, **then** none enters the snapshot; an eligible input exceeding a trusted limit blocks capture instead of silently disappearing.
3. **Given** a relevant observed change while copying, **when** the post-copy comparison disagrees, **then** capture retries only within its finite allowance and stops if no stable copy is obtained.
4. **Given** repository-owned native source, **when** a check needs the native component, **then** it is rebuilt from that snapshot in the isolated environment using existing offline prerequisites, never copied from the host.
5. **Given** an Ask task, an unapproved profile, expired authority, or an arbitrary executable request, **when** execution is requested, **then** no isolated repository process starts.

### User Story 2 — Prepare a dependency environment under developer authority (Priority: P1)

As a developer, I want an explicit preparation action that obtains only supported locked dependencies and produces an environment whose identity can be checked before verification.

**Why this priority**: Offline verification requires a reproducible prepared environment without granting the agent installation or network authority.

**Independent Test**: Trigger the helper with a trusted developer action and a supported fixture dependency set; verify permitted downloads, blocked sources, offline script execution, image publication, and fingerprint invalidation.

**Acceptance Scenarios**:

1. **Given** explicit developer confirmation, **when** preparation runs, **then** the application-owned recipe fetches only exact locked artifacts from approved public sources, checks integrity, and executes no installation scripts during download.
2. **Given** fetched artifacts, **when** installation or dependency builds execute, **then** networking is disabled and only scripts explicitly allowed for exact locked dependency identities can run.
3. **Given** a private registry, Git/SSH dependency, arbitrary artifact URL, unapproved redirect, integrity mismatch, unsupported hook, or missing prerequisite, **when** preparation encounters it, **then** it fails without publishing a valid prepared environment.
4. **Given** repository-controlled preparation instructions or model-generated confirmation, **when** preparation is requested, **then** neither can authorize it or choose privileges, mounts, networking, or the recipe.
5. **Given** preparation, **when** untrusted package code executes, **then** it cannot access developer secrets, sensitive host directories, the runtime control socket, or a writable real checkout.

### User Story 3 — Recognize stale preparation and stale verification (Priority: P1)

As a developer, I want a clear distinction between passing evidence for a tested snapshot and a verified current checkout, and a safe path when preparation is required.

**Why this priority**: A passing check against the wrong dependency environment or an older checkout must not complete an edited task.

**Independent Test**: Exercise unchanged sources, source-only edits, dependency changes, post-verification edits, and developer-confirmed preparation followed by a new task.

**Acceptance Scenarios**:

1. **Given** a changed manifest, lockfile, trusted dependency policy, toolchain, architecture, recipe, or image identity, **when** verification is needed, **then** the task ends in terminal BLOCKED, preserving edits and explaining that preparation is required.
2. **Given** that blocked task, **when** the developer confirms preparation, **then** the trusted helper runs outside the ended task; a new admitted task reevaluates repository state and captures a new snapshot. The blocked task never resumes and its task authority is not restored.
3. **Given** source-only edits with unchanged preparation inputs, **when** verification runs, **then** preparation remains valid and no dependency installation occurs.
4. **Given** a valid preliminary environment check but different dependency inputs in the captured snapshot, **when** execution would start, **then** verification blocks before launching code.
5. **Given** passing checks but a different checkout at final comparison, **when** results are reported, **then** the pass remains evidence for its snapshot but is stale for the current checkout and cannot satisfy changed-task completion.

### User Story 4 — Contain failures and clean up execution (Priority: P1)

As a developer, I want failures, resource abuse, cancellation, and runtime outages to stop execution within finite bounds and leave recoverable diagnostics rather than continuing unsafely.

**Why this priority**: The sandbox is meaningful only if failure and cleanup preserve containment.

**Independent Test**: Run network attempts, output floods, process creation, writable-storage exhaustion, timeouts, and cancellation; simulate control-plane failure and restart reconciliation.

**Acceptance Scenarios**:

1. **Given** an executing check, **when** it exceeds time, memory, processes, writable storage, or output retention limits, **then** enforcement remains bounded and results explicitly identify failure or truncation.
2. **Given** success, failure, or cancellation, **when** an invocation finishes, **then** its process and disposable resources are stopped and removed within bounded cleanup attempts.
3. **Given** unconfirmed stop/removal, **when** cleanup retries end, **then** further verification is blocked, identity and uncertainty are reported, and the checkout execution slot is not released while local effects remain possible.
4. **Given** a restart, **when** leftover resources are reconciled, **then** only positively identified application-owned resources are eligible for cleanup.
5. **Given** unavailable or insufficiently hardened execution infrastructure, **when** verification is attempted, **then** it blocks without host execution, automatic installation, resource expansion, or networking.

### Edge Cases

- A checkout is replaced at the same path, a symlink changes after enumeration, or a permitted alias resolves to denied content.
- New/deleted files or executable-bit changes occur during capture or after tests.
- A rapid external edit-and-restore falls between observations; the documented non-atomic guarantee does not claim to detect every such race.
- A package script or native build tries to download additional binaries or headers offline.
- A mutable image tag points to different bytes after the initial check.
- A check fills its temporary workspace, continues emitting output after retained output is full, forks children, or ignores termination.
- Stop occurs during capture, preparation, execution, or cleanup; a late success result cannot complete a cancelled/ended task.
- Cleanup ownership metadata conflicts, disappears, or names another application's container.
- A developer changes the checkout after preparation or between checks contributing to one verdict.

## Requirements

### Functional Requirements

- **FR-001**: Verification MUST execute repository code only in bounded disposable isolation; the trusted coding-agent application remains on the host.
- **FR-002**: The MVP MUST support Linux verification for TypeScript targets, initially Slop Loop and its trusted pnpm checks; Windows-specific checks remain separate developer/CI work.
- **FR-003**: Verification MUST disable network, run unprivileged, restrict system files to read-only, and expose only bounded writable workspace and temporary locations. No host home, secrets, control socket, or writable developer-checkout mount is allowed.
- **FR-004**: Each verdict MUST use one immutable captured snapshot and a fresh execution copy for each check; native compilation and its consuming check MUST use source from that same snapshot. A trusted task-attempt coordinator MUST retain required-check coverage across tool calls; the reference set is full tests, lint, typecheck and build. Partial, targeted, duplicate or cross-attempt results and model-supplied success booleans MUST NOT complete task verification.
- **FR-005**: Capture MUST use the trusted workspace boundary and hash copied bytes and relevant metadata, include eligible working-tree/untracked inputs, and exclude denied paths, repository internals, other repositories, host dependency trees, and trusted declared generated outputs.
- **FR-006**: Capture MUST rescan eligible paths and contents, reject observed differences, and retry finitely. Unavailable path authority fails closed. Watchers are signals only.
- **FR-007**: Preparation MUST be explicitly developer-triggered, separate from model-accessible tools, using an application-owned recipe. Repository Dockerfiles/configuration cannot grant authority.
- **FR-008**: Downloads MUST be limited to exact locked supported artifacts at approved public destinations; redirects outside approved destinations and mismatched/missing required integrity evidence are rejected.
- **FR-009**: Downloading MUST execute no dependency or repository installation/build scripts; subsequent allowed code execution MUST be offline and isolated without sensitive host access.
- **FR-010**: Dependency scripts MUST require trusted allowlisting for the exact locked identity. Unsupported scripts and sources block preparation; policy changes invalidate the prepared environment.
- **FR-011**: Preparation validity MUST bind manifests, lockfile, approved manager configuration, script allowlist, toolchain versions, Linux architecture, base-image digest, and application recipe. Ordinary source-only changes do not invalidate it.
- **FR-012**: The prepared environment MUST supply offline dependencies, build tools, and matching native prerequisites; missing prerequisites block rather than install automatically.
- **FR-013**: The captured dependency inputs and immutable prepared-image identity MUST be revalidated before code starts; a preliminary live-checkout comparison is insufficient.
- **FR-014**: Stale/missing preparation MUST end the active task in terminal BLOCKED with approved edits preserved. Developer-confirmed preparation is followed by a new admitted task, not resumption or restored task authority.
- **FR-015**: Final comparison MUST retain passing snapshot evidence while marking drift stale for the current checkout. Stale or incomplete evidence cannot satisfy edited-task verification completion.
- **FR-016**: Invocation CPU, memory, process, time, writable storage, snapshot size/count, retained output, preparation download size/time, and retry allowances MUST be finite and trusted-runtime owned. Time is bounded by remaining task/profile limits; resource enlargement is never model-controlled.
- **FR-017**: Cleanup MUST run after every exit path, use bounded attempts, and block continuation when stop/removal is unconfirmed. The task execution slot remains fenced until effects are settled.
- **FR-018**: Restart recovery MUST reconcile only resources whose application ownership can be validated, without deleting unrelated resources or enabling host fallback.
- **FR-019**: Every model-visible verification attempt MUST pass the existing gateway, fresh policy checks, cancellation fence, and canonical pre-execution evidence gate. Preparation uses separate trusted developer-action evidence, never a model tool.
- **FR-020**: Results MUST include snapshot/preparation/profile identities, bounded sanitized output, exit/termination/truncation state, freshness, and cleanup outcome; secrets and unnecessary physical host paths never enter model/audit payloads.
- **FR-021**: Supporting databases/cache services, browser/network tools, repository-owned image recipes, private/Git/SSH/arbitrary-URL dependency sources, automatic dependency installation, writable host verification, new resumable task states, and dedicated VM management MUST remain outside this phase.
- **FR-022**: Tests MUST precede implementation and prove authorization, confinement, negative cases, limits, cancellation, preparation, stale lifecycle, and real execution end to end. Missing required real fixtures keep the integration exit gate open.

### Key Entities

- **Verification snapshot**: Content-identified eligible working-tree inputs and relevant metadata used by one verdict.
- **Prepared verification environment**: Immutable dependency/toolchain environment bound to a preparation fingerprint and trusted provenance.
- **Verification profile**: Trusted named checks and their finite limits, selected without arbitrary model-provided commands.
- **Verification verdict**: Aggregate evidence for one snapshot/environment/profile combination, with separate current-checkout freshness.
- **Preparation action**: Explicit developer authority to build a replacement environment under the trusted recipe and policy.
- **Owned execution resource**: Disposable execution object whose ownership is sufficient for bounded cleanup and restart reconciliation.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Every verdict in the acceptance suite names exactly one tested content identity; mixed-snapshot or stale evidence produces zero false current-checkout completion results.
- **SC-002**: Every denied-source, unauthorized-preparation, missing-prerequisite, and stale-environment case produces zero repository-code execution and zero automatic dependency installation.
- **SC-003**: Every isolation fixture preserves the real checkout and denied host inputs while prohibiting verification network traffic.
- **SC-004**: Every successful/failing/cancelled invocation either confirms cleanup within its configured finite allowance or explicitly blocks continuation with resource identity and uncertainty.
- **SC-005**: The reference edited-repository journey passes checks for its captured state, while the stale-image journey preserves edits, requires explicit preparation, and verifies through a new task.
- **SC-006**: Resource and capture abuse fixtures terminate or reject within configured limits with bounded retained diagnostics; none uses host execution as fallback.

## Assumptions and Dependencies

- Phase 3 supplies gateway/task/budget/audit seams; Phase 4 remains incomplete and its real workspace-boundary exit gate is required before integration readiness.
- Existing permission ledger, model provider, complete interactive CLI, durable session/audit adapters, and all read/patch/Git executors remain owned by their later phases. This phase proves its seams with fixtures rather than claiming those products exist.
- This is content-identified copy-and-compare verification, not an atomic filesystem snapshot; rapid external change-and-restore races outside observations remain a documented limitation.
- A local trusted execution engine and developer-maintained pinned base toolchain are prerequisites. Dedicated disposable VMs and broader dependency sources can be separately designed later.
- Numeric operational defaults and enforcement mechanisms are selected in the implementation plan/research as bounded initial values and must be validated before implementation is called ready.
