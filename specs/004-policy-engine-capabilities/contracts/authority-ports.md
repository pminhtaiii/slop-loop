# Authority Port Contracts

## Closed registry definition

Phase 2's fixed nine-name catalog remains the source of runtime input validation and provider-neutral input schemas. Phase 3 adds trusted required-capability, risk/effect, and mutation/execution metadata for those same entries; no parallel name map may be created in policy. Before a real adapter is enabled, its catalog entry also requires a concrete output schema, timeout/runtime limits, and maximum output size. Test-only fake results use explicit fixture contracts without making the nine production tools executable.

## `PolicyEngine`

`evaluate(validatedCall, decisionContext)` is deterministic and side-effect-free. `decisionContext` carries task/session/workspace identity and sealed ceiling, fixed mode and current state, current budget view, path and grant facts when needed, network/profile policy, and invocation identity. It is newly assembled for one call; no caching of allow decisions or path facts across calls. The engine returns `ALLOW`, `NEEDS_FILE_PERMISSION`, or `DENY` with bounded reason. Exceptions and absent or invalid required trusted facts fail closed and become terminal `FAILED / POLICY_FAILURE` at the gateway/runner boundary.

## Trusted workspace and grant providers

The gateway asks a workspace provider for canonical repository-relative path facts scoped to the requested operation and current workspace identity. Phase 3 provides a fake; Phase 4 supplies real resolution and containment. A grant provider supplies exact session/path/`update` or `create` facts and observed state. Phase 3 provides a fake; Phase 7 owns real prompts, revocation, and mutation-point rechecks. Model arguments never include an `authorized`, `canonical`, or `grant` field that policy trusts.

## `AuditSink.appendIfAbsent`

An append request has a stable `event_id`, canonical bounded payload, session/task/invocation correlation, and a payload identity. The sink serializes canonical writes, returns the committed event ID/hash, treats a retry of the identical ID/payload as the existing commit, and rejects the same ID with a different payload. Result-event retry never invokes the executor. Phase 3 fake implements these semantics for ordering tests; Phase 12 owns the actual JSONL hash chain and manifest.

## Budget and cancellation providers

The runner is the one owner of mutable usage. It charges a model turn on a model request and a tool attempt on individual gateway dispatch, records the reason for every shared recovery retry, and excludes developer-input waiting from active-work time. The gateway reads the current trusted view and serializes one in-flight call per task; it never allows the model to supply counters. Admission seals the initial shared retry ceiling and trusted work-capacity promotion schedule. Cancellation supplies a task-scoped signal/generation; late results cannot advance a stopped task.
