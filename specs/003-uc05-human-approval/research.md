# Research and Design Rationale: UC-05

**Status**: Design rationale for the logical baseline agreed by all three owners through the user confirmation recorded at T001 on 2026-10-19 (Asia/Saigon). Accepted behavioral constraints remain sourced from ADRs. Repository inspection and independent contract analysis informed this design; no runtime implementation or live adapter test is claimed.

## R1 — Reuse the canonical approval schema

**Decision**: Retain `PermissionClass`, `NormalizedAction`, `ApprovalBinding`, `ApprovalBindingContext`, `computeActionDigest`, parse/admission validators and ApprovalPort from canonical UC-03 version 0.1.0. UC-05 companion records wrap these types rather than redefining them.

**Rationale**: The module already distinguishes parsing from trusted current-state admission. Its action digest hashes the entire normalized action, including actionId, and preserves patch bytes. A schema-valid approved object alone is not evidence of an authoritative human decision.

**Alternatives considered**: New approval schema or unversioned union variants would split conformance. List/read/search remain shared guarded read operations, tests map to configured run_command actions, and future union expansion needs shared-owner migration.

## R2 — Durable task control through UC-04

**Decision**: Propose an additive ApprovalStorePort owned by UC-04 with transactional pending/pause, terminal decision, explicit direction and fenced dispatch capabilities. One pending request per task; unrelated tasks have independent versions/epochs.

**Rationale**: Existing StatePort has no approval journal or task-wide admission barrier. Graph nodes alone do not stop reviewer/model/background work. All dispatch owners must consult the same durable control record; cached state cannot grant permission.

**Alternatives considered**: In-memory pause flags fail restart; a UC-05 database duplicates UC-04; polling a CLI result without a shared barrier leaves race windows. Backend selection and atomic storage implementation remain UC-04-owned delivery, not unknown UC-05 implementation choices.

## R3 — Immutable resolution, separate validity/effect

**Decision**: Treat canonical decisionId as the stable request-slot ID. Record a pending binding and at most one terminal human response; append stale assessments and effects separately. Fresh approval after rejection or drift gets a new decisionId. Requests use independent idempotency keys for transport retries.

**Rationale**: The scripted test fixture can replace a decision, but production history must not rewrite rejection into approval. Stale status can be returned as a derived canonical projection without mutating original human consent.

**Alternatives considered**: Reusing a rejected slot or overwriting approved bindings loses evidence. A second competing request-ID field in the canonical binding is unnecessary; companion metadata supplies event/attempt IDs.

## R4 — Strict plan binding for the first slice

**Decision**: Preserve exact canonical repository binding; any digest change before the next production patch requires fresh immutable plan approval. An unchanged material strategy retains its plan version/replan allowance. Combine bounded changes into one patch where appropriate.

**Rationale**: Current Patch admission requires plan approval at the exact current digest. Automatically updating its digest for expected edits would falsify consent. This conservative policy satisfies spec US3.5's valid-binding condition and never adds approval merely for auth/security paths.

**Alternatives considered**: A trusted covered-evolution ledger could reduce later prompts, but requires canonical/consumer changes and separate owner agreement. It is excluded from this initial design. Materiality is still trusted UC-03 input, never a model's boolean.

## R5 — Deterministic bounded classification

**Decision**: In-process policy compilation with explicit configured executable/argv rules, patch breadth and admitted path/content facts. Forbidden facts take precedence; unknown/incomplete facts return typed denial, not permissive fallback. [Policy](contracts/policy.md) defines the decision table.

**Rationale**: ADR-0006 rejects a new script/LLM call per check. No model judgment can prove arbitrary code harmless; actual isolation remains the executor's responsibility. Task-wide rejection blocks alternate forms independently of hash equality.

**Alternatives considered**: Shell-string regex approval, ML risk scoring or automatic safer alternatives after rejection fail the accepted boundary. No arbitrary semantic-equivalence solver is claimed. Numeric latency and production profiles are excluded until separately selected; fixture numbers are explicit test-only inputs.

## R6 — Trusted host CLI without a framework

**Decision**: Propose Node built-in argument/input handling, explicit task/request/version and inspected-presentation digest, bounded escaped output, and separate decide/control commands. The CLI writes decisions through UC-04; it never resumes tools directly.

**Rationale**: One local developer and no web app are accepted constraints. Repository processes cannot reach the host operator composition, state store or decision channel. Host OS/process access is the initial trust boundary, not a user-supplied actor field.

**Alternatives considered**: A web application/new auth service exceeds scope; approve text in repository/model output is not authority. CLI syntax is a proposed UC-05 design, not an already approved project-wide CLI framework.

## R7 — Claims and uncertain outcomes

**Decision**: UC-04/shared executor atomically fence admission by task epoch, current state, binding and budget reservation, then claim one attempt before effects. Crash/timeout after claim is uncertain until reconciled; approval alone never permits another dispatch.

**Rationale**: Exactly-once arbitrary external effects cannot be promised by an approval row. Prove no blind duplicate effects in supported cases. Cancellation is best effort and may not undo an already-started operation.

**Alternatives considered**: Restarting every approved action or expiring claims on a timer can duplicate effects and reset spending. Unsupported reconciliation retains uncertainty and blocks affected work.

## R8 — Evidence and release boundaries

**Decision**: Prepare finite C01–C24 cases before feature implementation. Run local conformance and mock control first, actual CLI subprocesses next, then real UC-04/executor and process restart. Record not-run cases and platform limits explicitly.

**Rationale**: Canonical contracts and helper CI prove only their exercised scope. Existing UC-03 mock acceptance cannot verify UC-05 production control. The constitution remains an unratified template; AGENTS/context/accepted ADRs govern this design.

**Alternatives considered**: Selecting a storage backend, production policy numbers, retention lifetime or Docker profile on another owner's behalf is unnecessary. Those are named delivery/profile gates; no permissive production defaults are proposed.
