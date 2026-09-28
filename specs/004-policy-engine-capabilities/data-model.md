# Data Model: Policy Engine and Capabilities

These are conceptual contracts for Phase 3, not persistent tables or runnable adapters. A value labeled trusted is constructed by application code or an injected trusted port, never parsed from model arguments.

## Task authority

| Entity | Fields | Invariants |
| --- | --- | --- |
| `TaskCapabilityCeiling` | task ID, session ID, workspace ID, fixed Ask/Edit mode, eligible registered names/capability classes, resource limits, initial budget profile, permitted promotion edges and triggers, Large maximum, shared retry ceiling | Immutable after admission. No file grant, model proposal, or repository content can expand it. |
| `TaskBudgetState` | active profile, model turns used, dispatched tool attempts used, shared retries used with reason history, active-work elapsed, pending developer-wait start | Usage is cumulative across promotion. Shared retry ceiling is fixed from initial profile. Developer wait is excluded from active-work elapsed. |
| `TaskRuntimeState` | task state/outcome, checkout slot identity, cancellation generation/signal, at-most-one in-flight invocation | Fixed mode until terminal. Late completions with an old generation cannot transition or mutate. Slot releases only after mutation is impossible and cleanup is terminal. |

The initial profiles remain ADR 0006's Small 30 turns/60 calls/3 retries, Medium 60/120/5, and Large 120/240/8; each uses 30 active-work minutes. A later profile raises only model-turn and tool-attempt limits. At a threshold, the current permitted operation can finish; the next attempted work-capacity charge invokes trusted promotion or terminal exhaustion before execution. Retry and active-work exhaustion never promote.

## One dispatched tool call

| Entity | Fields | Invariants |
| --- | --- | --- |
| `DispatchedToolCall` | invocation ID, task ID, response ID/ordinal, raw proposed name and arguments retained only transiently | One attempt is charged on individual gateway receipt, not on model-response proposal. Invalid/unknown calls still count. |
| `ValidatedToolCall` | registered name and parsed arguments | Registry validation confers no authority. Unknown or malformed calls have bounded error details without raw argument echo. |
| `PolicyDecisionContext` | current task identity/state, ceiling, budget view, session grant facts, workspace path facts, trusted profile/network/readiness facts as relevant, invocation ID | Constructed afresh for this call, immutable during pure evaluation, and discarded afterward. It cannot be supplied by model text or reused. |
| `PolicyDecision` | `ALLOW`, `NEEDS_FILE_PERMISSION`, or `DENY`; bounded reason and evaluated invocation ID | Every dispatched call proceeds to bounded decision-evidence append, including validation denial. Only `ALLOW` with confirmed pre-evidence and a live cancellation generation may reach the executor. A policy exception is not an `ALLOW` decision; it terminates as `FAILED / POLICY_FAILURE`. |

## Filesystem authority facts

| Entity | Fields | Invariants |
| --- | --- | --- |
| `TrustedPathFacts` | workspace ID, canonical repository-relative path, requested read/update/create operation, resolution validity, observed target identity/content state as needed | Created by the workspace port for one request. Phase 3 fake facts prove policy behavior; Phase 4 supplies real resolution and containment. Validly forbidden paths are `DENY`; absent/untrustworthy required facts are terminal policy failure. |
| `FileGrantView` | session ID, workspace/branch context, canonical path, exact update/create operation, observed target state, valid/invalidated marker | A grant is within, never above, the task ceiling. Agent-owned authorized writes advance observation; external changes invalidate irreversibly until new authorization. Phase 3 uses a fake view; Phase 7 owns real grants. |

## Evidence and result contracts

| Entity | Fields | Invariants |
| --- | --- | --- |
| `AuditEventRequest` | stable event ID, session/task/invocation IDs, bounded tool identity, event kind, validation or policy decision, bounded metadata | No raw arguments, source content, credentials, or unbounded output. Request/decision commit precedes executor invocation. |
| `AuditAppendResult` | committed event ID and canonical hash or typed unavailable/integrity failure | `appendIfAbsent` with identical ID and payload is idempotent; same ID with different payload fails integrity. Phase 3 fake; Phase 12 real hash-chained JSONL. |
| `ToolResultEnvelope` | execution/effect status, captured payload or typed error, bounded metadata | Output is untrusted until schema, size, normalization, sanitization, and redaction checks pass. Effect status survives output/audit failures; no retry re-executes an effectful tool. |
| `BudgetHandoff` | budget resource, configured limit, observed usage, task objective, completed work, changed paths, verification state, unresolved state/blockers, stop reason, remaining steps | Developer-facing material for a new task, never a capability or restorable session. Audit contains only bounded evidence metadata. |

## Outcome distinctions

| Condition | Task outcome | Execution |
| --- | --- | --- |
| Validly forbidden or ineligible call | ordinary `DENY`, optionally bounded runner recovery | None |
| Eligible write missing exact permission | `NEEDS_FILE_PERMISSION` and developer wait | None |
| Internal policy exception or untrustworthy required authority facts | `FAILED / POLICY_FAILURE` | None |
| Required canonical pre-execution append unavailable | `BLOCKED / AUDIT_UNAVAILABLE` | None |
| Result append still unconfirmed after bounded idempotent retries | `BLOCKED / AUDIT_INCOMPLETE`, with effect status | No replay |
| Invalid executor output after possible effect | typed `TOOL_CONTRACT_FAILURE`, with separate effect status | No replay |
| Shared recovery, active-work, or terminal Large capacity exhaustion | `BUDGET_EXHAUSTED` plus handoff | No further call |
| Developer stop | `CANCELLED` after no more mutation and cleanup | Late results fenced |

## State transitions

The Phase 1 runner is reconciled with ADR 0007: a task retains one mode from admission to terminal. `PAUSED_FOR_MODE` and same-task `MODE_CHANGE` are removed from the accepted target graph. A permission wait keeps the active checkout slot but pauses the active-work clock. `CANCEL` fences new work immediately, attempts abort, and reaches `CANCELLED` only after safe cleanup. Terminal outcomes reject later events. The detailed legal state graph remains owned by `src/orchestration/transitions.ts`.
