# Shared Consumer Interfaces: UC-01

**Status**: DRAFT proposal; signatures and bindings require X-FOUNDATION-AGREEMENT. Accepted UC-03 [interfaces](../../001-verified-code-repair/contracts/interfaces.md) and [canonical types](../../../src/contracts/uc03.ts) remain unchanged.

## Operations and ownership

| Consumer operation | Proposed request / response | Owner / requirements |
|---|---|---|
| assessIssue | Invocation + separate TrustedContext -> Outcome ([schema](schema.md)) | Thai; validates, composes narrow shared capabilities and returns results; no transport selected |
| readEvidence | `{path:Text}` + bound shared operation context -> safe result containing canonical SourceEvidence or typed failure | Tai; workspace-selected read only, protection, finite output/time, revision binding, policy/accounting; no filesystem implementation in UC-01 |
| searchEvidence | `{query:Text}` + same context -> bounded SourceEvidence[] or typed failure | Tai; approved repository only, bounded results and uncertainty for truncated/empty searches |
| proposeAssessment | validated intake + admitted bounded evidence + request/reservation identity -> proposal, read/search request, or safe failure with usage/uncertainty | Tai model transport and accounting, Thai assessment validator. Triage-compatible input/output/role is pending; existing coder/reviewer-only ProviderRequest is not silently extended |
| bindContinuation | validated prior assessment identity/question set -> opaque reference; resolve reference on later invocation | Trusted caller, durable implementation UC-04; Thai validates projection, never builds a durable store |
| guard/reserve/settle | shared operation identity/config/state -> admitted action or typed pause/denial/conflict/exhaustion/uncertainty | Tai composes UC-05 policy and UC-04 accounting. No local alternative ledger/approval engine |
| emitSafeEvent | event IDs/type/outcome/duration/counts/config refs -> eventRef | Tai telemetry; no raw report/source/prompt/answer/model body |

Shared operation context binds task/run/workspace/repository/snapshot, operation/request IDs, policy/config versions and finite limits/accounting receipts. Exact adapter signatures are an explicit agreement gate; this document specifies requirements, not already implemented interfaces. A safe shared failure maps to the Outcome failure union without copying raw exception messages.

Model tool request proposed shape: `{kind:'read', path:Text}` or `{kind:'search', query:Text}`; one request per response and no other operations. Model response variants are `{kind:'assessment', proposal:Proposal}` or `{kind:'tool-request', request:...}` plus shared usage/outcome envelope. Tool requests consume model allowance too. Harness rejects unknown variants/extra keys and never executes arbitrary action arrays. No separate report rewrite purpose is admitted.

## Evidence projection

Current SourceEvidence carries path/revisionDigest/excerpt/resultCount/truncated, not trusted line spans or file digests. Preserve its original fields in the shared record; do not invent locator metadata. Proposed UC-01 repository evidence requires shared delivery to supply independently verified file digest/line span/snapshot. Tai must agree that additive seam or explicitly revise this draft before T001 can exit. Pure fixture metadata is marked mock. Reporter-supplied snippets are never promoted to repository findings.

## Bounded protocol

1. Validate invocation, trusted identity/catalogs/limits, evidence admission and continuation before constrained calls. Content is data; configured capabilities come only from trusted composition.
2. For every shared model/read/search request, check invocation deadline and call/output bounds, current revision and UC-05 policy. Approval-required actions return pending-approval through the shared boundary; forbidden actions remain forbidden.
3. Before provider dispatch, use UC-04 atomic durable multi-budget reservation for task/run token and cost ceilings tied to stable provider request ID and pricing/config/context digest. No partial reservation authorizes a call. Existing host-provider protocol remains authoritative; triage role/signature extension needs agreement.
4. Dispatch through shared adapter with enforced caps/deadline. Validate each result, register actual admitted evidence and settle usage even for invalid responses. Keep uncertain reservations charged; do not blindly retry. Tool activity and all model turns consume applicable cumulative allowances.
5. Return only validated assessment or typed incomplete outcome. needs-info obtains a trusted continuation ref; inability to bind returns error, not fictitious persistence. Reinvocation rechecks task budgets, identity and evidence snapshot before any further activity.

Model/tool retry ceiling is finite trusted configuration; this draft proposes no automatic retry. Any future retry requires separate request identity, reconciled prior outcome, remaining allowance and owner-approved policy.

## Mock and real delivery

| Mode | Allowed evidence | Admission / replacement |
|---|---|---|
| Controlled fixtures | Explicit mock model proposals, read/search results, bound continuation records, budget/policy responses and usage spy | Created after agreed contract; no network, files, commands or durable recovery; production rejects mock provenance |
| Real shared adapters | Actual shared evidence, guarded model calls and durable policy/accounting | T011/T012 require X-READ-MODEL, X04-STATE, X05-GATE and A-PRODUCTION; record version/revision/checks |
| Receiver compatibility | Validate assessment projection against receiving owner's versioned input, including missing reproduction/criteria for UC-03 | T013; no dispatch. Recommendation never bypasses receiver intake/approval |

UC-01 does not depend on UC-03 repair execution. A real adapter cannot be admitted merely by setting `provenance='real'`; composition verifies delivery/version and policy/accounting configuration, with tests asserting zero dispatch on failed admission.
