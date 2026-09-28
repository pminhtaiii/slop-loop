# Tool Gateway Contract

This is an internal TypeScript boundary, not a model-facing API or a production executor. The only application-facing invocation is `ToolGateway.invoke(task, proposedCall, responsePosition)`. The gateway owns its executor mapping privately. Callers cannot supply an executor, audit sink, workspace facts, grant facts, policy result, or budget values in model-controlled arguments.

## Input and decision flow

1. Admit only a nonterminal task with a sealed capability ceiling and current checkout slot. A task has at most one in-flight invocation.
2. On individual dispatch, allocate an invocation ID and charge one tool attempt. Later undispatched proposals in the same model response are not charged.
3. Revalidate the outer name/arguments contract against the closed registry. The fixed definition supplies capability/effect metadata; visibility is not authorization.
4. Gather fresh task, budget, grant, workspace, network, approved-profile, and executor-readiness facts from trusted providers. A model cannot supply or reuse these facts.
5. Run the pure `PolicyEngine` against that invocation-scoped context. A validly forbidden request is `DENY`, an eligible exact write lacking permission is `NEEDS_FILE_PERMISSION`, and only `ALLOW` can continue. Unsafe missing facts or an engine exception cause terminal `FAILED / POLICY_FAILURE`.
6. Append bounded canonical request identity and validation/policy-decision evidence. Unknown or malformed individually dispatched calls are recorded without raw argument text. Every real executor invocation, including read-only work, requires confirmed pre-execution evidence.
7. On `ALLOW` with successful append, atomically recheck the task cancellation generation and active state at the executor-start gate. If stop won while the gateway awaited facts or the append, skip execution and return cancellation. Otherwise invoke exactly one internal executor. An unavailable audit sink produces `BLOCKED / AUDIT_UNAVAILABLE` and zero executor calls.
8. Validate, bound, normalize, sanitize, and redact the executor result before model context or bounded audit representation. A real adapter must enforce a hard capture cap before materializing unbounded output; Phase 3's fake executor tests the gateway's post-capture contract.
9. Append bounded result evidence using the idempotent audit contract. If an effect may have happened and append fails, notify the developer, stop further dispatch, and retry persistence a small finite number of times with the same event ID and payload; never replay the executor. Unconfirmed evidence is `BLOCKED / AUDIT_INCOMPLETE` with effect status.

## Response families

| Family | Meaning | Executor calls |
| --- | --- | ---: |
| `EXECUTED` | Allowed, pre-evidence committed, executor result processed | Exactly one |
| `NEEDS_FILE_PERMISSION` | Eligible exact write lacks grant; runner may ask developer | Zero |
| `DENY` | Healthy policy/validation rejects call; runner may spend one shared recovery retry | Zero |
| `FAILED / POLICY_FAILURE` | Required trusted authorization cannot be evaluated | Zero |
| `BLOCKED / AUDIT_UNAVAILABLE` | Required pre-execution evidence cannot be committed | Zero |
| `BLOCKED / AUDIT_INCOMPLETE` | Effect may have occurred but result evidence remains unconfirmed | At most one; never replayed |
| `TOOL_CONTRACT_FAILURE` | Executor returned invalid output; report actual/possible effect independently | At most one; never replayed |
| `CANCELLED` | Stop fenced late completion and cleanup is safe | No later calls |

## Batch and stop rules

- The runner sends proposed calls serially. On first ordinary `DENY`, it discards remaining proposals from that model response and decides whether bounded recovery is available.
- A developer stop prevents new dispatch immediately, wins against any executor start that has not passed the cancellation fence, signals an executor that already started, and rejects late result-driven transitions. The checkout slot remains occupied until local mutation is impossible and cleanup reaches terminal `CANCELLED`.
- A result contract failure or audit-incomplete result never proves an effect was absent. Final evidence must reconcile the checkout before reporting it as unchanged.

## Fake-boundary proof in Phase 3

The fake executor records invocation count and selected name; the fake workspace/grant providers return controlled trusted facts; the fake audit sink records call order and simulates unavailable, committed-but-unacknowledged, and failed result append cases. Tests prove zero executor calls on every non-allow path and that `ALLOW` without committed pre-evidence never executes. This does not claim actual file, process, sandbox, or JSONL behavior.
