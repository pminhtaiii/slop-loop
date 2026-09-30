# Design Research: Policy Engine and Capabilities

The sources are the Phase 3 progress entry, `CONTEXT.md`, `coding-agent-context/context/tool-policy.md`, ADR 0001/0002/0005/0006/0007/0008, and the implemented Phase 1 runner. These are project decisions, not claims that Phase 2 or Phase 3 source exists.

## R1 — Mandatory invocation boundary

- **Decision**: A pure `PolicyEngine` decides from a fresh trusted call context. A `ToolGateway` is the only exported invocation path and privately owns executor references. It revalidates a call, accounts for budget, evaluates policy, commits pre-execution evidence, invokes at most one executor, validates the result, and commits result evidence.
- **Rationale**: A registry can reject malformed calls but cannot itself grant authority. A separate exposed executor would make gateway use conventional rather than mandatory.
- **Alternatives considered**: Policy checks in every adapter risk inconsistent enforcement; a monolithic policy/executor class hides side effects inside authorization.

## R2 — Tool definition ownership

- **Decision**: The fixed registry is the one source for each name and its input/output contracts, effects, required capability, and limits before the corresponding real adapter becomes executable. Phase 3 adds trusted capability/effect metadata to the nine planned entries. Fake tests use explicit fixture result contracts; real output schemas and runtime limits are completed in each adapter's owning phase.
- **Rationale**: Phase 2 is intentionally non-executable and currently unimplemented. A separate policy name map would drift; inventing real output schemas before adapters exist would be speculative.
- **Alternatives considered**: Full real-tool contracts in Phase 3 would claim behavior that later phases own; independent registry/policy maps would duplicate authority metadata.

## R3 — Admission authority and budget lifecycle

- **Decision**: Admission seals the task/session/workspace identity, fixed mode, eligible tools and resources, initial profile, promotion edges/triggers, cumulative semantics, Large maximum, and one shared recovery ceiling taken from the initial profile. Model turns and dispatched tool attempts are separate work-capacity counters; verification/repair, model, and denial recoveries spend one shared counter. Trusted work-capacity promotion never replenishes retries or resets active-work time. Retry exhaustion and the 30-minute active-work deadline terminate with `BUDGET_EXHAUSTED` and a bounded handoff.
- **Rationale**: The existing runner charges internal events as agent steps, includes developer waits in deadline time, and permits same-task mode switching. These conflict with ADR 0006/0007 and must be reconciled before gateway integration.
- **Alternatives considered**: One step counter couples model capacity to implementation details; mutable budget caps let later grants or model text expand authority; separate retry pools multiply total recovery cost.

## R4 — Call accounting and denied batches

- **Decision**: One tool attempt is charged only when one proposed call is individually dispatched to the gateway, including malformed, unknown, and denied calls. One in-flight call per task is allowed. An ordinary denial discards later undispatched proposals from the same model response; a new response requires a bounded shared recovery retry. No similarity heuristic is used.
- **Rationale**: This prevents a large bad batch from burning capacity or reaching a promotion threshold before denial recovery can stop the task.
- **Alternatives considered**: Charging an entire response batch or classifying repeated calls semantically adds uncertainty and cost.

## R5 — Path and grant phase boundary

- **Decision**: Phase 3 consumes invocation-scoped canonical path facts through a trusted workspace port and exact write-grant facts through a separate port. Its tests use fakes. A validly forbidden path receives ordinary `DENY`; inability to establish trustworthy required facts yields terminal `FAILED / POLICY_FAILURE`. Phase 4 provides actual resolution, and Phase 7 provides actual grant and patch mechanics.
- **Rationale**: Pulling canonicalization into policy would mix filesystem effects and pure authorization; claiming real path enforcement now would be false.
- **Alternatives considered**: Passing model-supplied canonical path flags is forgeable; authorizing unresolved path strings is unsafe.

## R6 — Audit dispatch contract

- **Decision**: Every individually dispatched model tool request receives bounded request identity and validation/policy-decision evidence. Canonical append must succeed before any executor invocation, including reads; failure is `BLOCKED / AUDIT_UNAVAILABLE` with zero executor calls. After a possible effect, failed result append blocks further dispatch and receives a small finite number of synchronous retries through an idempotent `appendIfAbsent` contract with stable event identity. Unconfirmed persistence is `BLOCKED / AUDIT_INCOMPLETE`; the executor is never replayed. Phase 3 proves ordering with a fake sink; Phase 12 writes actual hash-chained JSONL.
- **Rationale**: A readiness probe races with execution. An uncertain append acknowledgment must not duplicate an event in the canonical chain. Audit is an execution prerequisite, not policy authority.
- **Alternatives considered**: Unaudited reads break the release invariant; background in-memory retries can vanish on CLI exit; raw append retries can duplicate hash-chain events.

## R7 — Untrusted executor output

- **Decision**: A real adapter must cap captured bytes while producing a result, before unbounded materialization. The gateway then validates the captured output schema, enforces the registered model-visible output bound, normalizes, sanitizes, and redacts before audit metadata or model context. Phase 3 can test gateway handling with fake bounded results; it does not claim real process-stream limiting. Invalid results after a persistent effect produce a typed contract failure and explicit actual/possible effect status, without executor replay.
- **Rationale**: Validating an unbounded result before a capture cap can itself exhaust memory. Result invalidity is not evidence that the side effect failed.
- **Alternatives considered**: Trusting adapter output or auditing raw output risks secret exposure and flooding.

## R8 — Scope and integration gates

- **Decision**: Phase 3 is a testable authority core with fake executor, workspace, grant, and audit ports. Integration readiness requires Phase 1 runner reconciliation, Phase 2 registry source, and the pinned combined quality gate. Real path, patch, sandbox, verification, Git-state, model, and canonical audit adapters remain their scheduled later phases.
- **Rationale**: The progress tracker marks Phase 2 and Phase 3 unimplemented; planning documents cannot turn fake fixtures into product security claims.
- **Alternatives considered**: Moving later adapters into Phase 3 would obscure phase ownership and create a much larger security review surface.
