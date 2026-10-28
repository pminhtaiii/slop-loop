# Shared Consumer Interfaces: UC-01

**Status**: `uc01-consumer-v1` approved at T001 on 2026-10-18 through user-confirmed member agreement in [decisions](decisions.md); implementation and real adapter deliveries remain separate gates. Accepted UC-03 [interfaces](../../001-verified-code-repair/contracts/interfaces.md) and [canonical types](../../../src/contracts/foundation/uc03.ts) remain unchanged.

## Operations and ownership

| Consumer operation | Proposed request / response | Owner / requirements |
|---|---|---|
| assessIssue | Invocation + separate TrustedContext -> Outcome ([schema](schema.md)) | Thai; validates, composes narrow shared capabilities and returns results; no transport selected |
| readEvidence | `{path:Text}` + bound shared operation context -> safe result containing canonical SourceEvidence or typed failure | Tai; workspace-selected read only, protection, finite output/time, revision binding, policy/accounting; no filesystem implementation in UC-01 |
| searchEvidence | `{query:Text}` + same context -> bounded SourceEvidence[] or typed failure | Tai; approved repository only, bounded results and uncertainty for truncated/empty searches |
| proposeAssessment | validated intake + admitted bounded evidence + request/reservation identity -> proposal, read/search request, or safe failure with usage/uncertainty | Tai model transport and accounting, Thai assessment validator. Triage-compatible input/output/role is agreed below; existing coder/reviewer-only ProviderRequest is not silently extended |
| bindContinuation | validated prior assessment identity/question set -> opaque reference; resolve reference on later invocation | Trusted caller, durable implementation UC-04; Thai validates projection, never builds a durable store |
| guard/reserve/settle | shared operation identity/config/state -> admitted action or typed pause/denial/conflict/exhaustion/uncertainty | Tai composes UC-05 policy and UC-04 accounting. No local alternative ledger/approval engine |
| emitSafeEvent | event IDs/type/outcome/duration/counts/config refs -> eventRef | Tai telemetry; no raw report/source/prompt/answer/model body |

Shared operation context binds task/run/workspace/repository/snapshot, operation/request IDs, policy/config versions and finite limits/accounting receipts. The versioned signatures below define the approved consumer requirements, not already implemented shared adapters. A safe shared failure maps to the Outcome failure union without copying raw exception messages.

Model tool request proposed shape: `{kind:'read', path:Text}` or `{kind:'search', query:Text}`; one request per response and no other operations. Model response variants are `{kind:'assessment', proposal:Proposal}` or `{kind:'tool-request', request:...}` plus shared usage/outcome envelope. Tool requests consume model allowance too. Harness rejects unknown variants/extra keys and never executes arbitrary action arrays. No separate report rewrite purpose is admitted.

## Evidence projection

Current SourceEvidence carries path/revisionDigest/boundedExcerpt/resultCount/truncated, not trusted line spans or file digests. Preserve its original fields in the shared record; do not invent locator metadata. Proposed UC-01 repository evidence requires shared delivery to supply independently verified file digest/line span/snapshot. User-confirmed member agreement at T001 adopts the additive seam below; real tooling must deliver it before real integration. Pure fixture metadata is marked mock. Reporter-supplied snippets are never promoted to repository findings.

## Versioned consumer signatures

`uc01-consumer-v1` records the reviewed consumer agreement approved at T001; it is documentation, not a shared implementation or a UC-03 type extension. Types below refer to the closed records in [schema](schema.md). All promises may return only the stated closed variants. Unknown keys/variants fail validation. Text and collections obey the selected finite profile.

```text
OperationContext = {
  taskId, runId, invocationId, repositoryId, workspaceId,
  repositorySnapshotDigest, configId, configVersion, policyId, policyVersion,
  operationId, requestId, accountingRef, deadlineEpochMs, limits
}
SharedFailure = {kind: 'failure', status: Failure, reasonCode, eventRef}
Admission = {kind: 'admitted', admissionRef, requestId, contextDigest}
Usage = {inputTokens, outputTokens, totalTokens, costUnits,
         state: 'settled'|'uncertain', reservationRef}
RepositoryFinding = {source: SourceEvidence, location: RepositoryLocation,
                     safeExcerptRef, provenance: 'mock'|'real'}
ModelEvidence = {evidence: Evidence, boundedExcerpt: Text}

guard(context: OperationContext,
      action: {kind: 'model'|'read'|'search', inputDigest: Digest})
  -> Promise<Admission | SharedFailure>
reserve(context: OperationContext, admission: Admission,
        ceiling: {inputTokens, outputTokens, totalTokens, costUnits, pricingId})
  -> Promise<{kind: 'reserved', reservationRef, requestId} | SharedFailure>
settle(context: OperationContext, reservationRef: Id, usage: Usage)
  -> Promise<{kind: 'settled', accountingRef} | SharedFailure>
readEvidence(context: OperationContext, admission: Admission, path: Text)
  -> Promise<{kind: 'read', finding: RepositoryFinding} | SharedFailure>
searchEvidence(context: OperationContext, admission: Admission, query: Text)
  -> Promise<{kind: 'search', findings: RepositoryFinding[], truncated: boolean}
             | SharedFailure>
proposeAssessment(context: OperationContext, admission: Admission,
  request: {role: 'triage', invocation: Invocation, evidence: ModelEvidence[],
            priorQuestions: Question[], catalog: Catalog, reservationRef: Id})
  -> Promise<{kind: 'assessment', proposal: Proposal, usage: Usage}
             | {kind: 'tool-request', request: ReadOrSearch, usage: Usage}
             | (SharedFailure & {usage: Usage}))
bindContinuation(context: OperationContext, assessment: Assessment)
  -> Promise<{kind: 'bound', continuationRef: Id} | SharedFailure>
resolveContinuation(context: OperationContext, continuationRef: Id)
  -> Promise<{kind: 'resolved', continuation: Continuation} | SharedFailure>
emitSafeEvent(event: {eventId, type, outcome, durationMs, counts, configRef})
  -> Promise<{eventRef: Id}>
```

Identity fields are schema Ids, snapshot/context/input digests are Digests, timestamps/durations/counters are finite nonnegative safe integers, and deadlines must be future and within configured invocation bounds. `Failure` is the schema failure union; adapters do not return raw exception text. `ReadOrSearch` is exactly the two tool variants above. `Continuation` is exactly the trusted continuation projection in schema, not a UC-03 TaskState. Telemetry failures fail closed to a safe caller error and authorize no extra constrained call.

Admission binds the complete normalized context and action input digest; consumers cannot reuse it for another request/action, policy/config version or snapshot. Hash the logical action payload using SHA-256 over UTF-8 canonical JSON (recursively sorted object keys, preserved array order, compact ECMAScript JSON.stringify values, no BOM/newline): read `{kind:'read', path}`, search `{kind:'search', query}`, model `{kind:'model', role, invocation, evidence, priorQuestions, catalog}`. Exclude later-created admission/reservation receipts, usage and event fields to avoid circular dependencies. Reservation remains bound separately to the same context/requestId/admission and pricing/ceiling. Every read/search is guarded and charged to cumulative tool/time/output bounds. Provider dispatch requires both admission and the same request's atomic task/run reservation. Settled usage must reconcile the reservation, token totals and pricing; invalid output still settles. Missing or uncertain usage retains the full reserved ceiling, with no automatic redispatch. `state: 'uncertain'` never releases allowance. A shared failure before dispatch uses zero observed usage with its reservation reference retained; it never fabricates a provider success. Shared accounting resolves idempotency and restart behavior; the consumer does not build another ledger.

Before constructing a model request, the trusted harness resolves each safeExcerptRef to its admitted bounded text, checks its exact UTF-8 digest against evidence.contentDigest, enforces protected-data/aggregate input bounds and requires membership in the current evidence registry. The same rule applies to reporter and answer evidence. An oversized source is either rejected or admitted as a separately identified bounded excerpt with its own digest; never compare an excerpt digest with an untruncated source digest. The `priorQuestions` projection comes from validated resolved continuation (empty on initial intake); IDs/text/affects/reason match the immutable prior assessment. Provider-visible context contains only admitted invocation content, ModelEvidence, priorQuestions and catalog. Host accounting/policy/admission/reservation identities and continuationRef stay in the adapter control plane; grading labels/oracles and raw trusted context never enter model/tool context. Request payload limits include all model-visible fields, not just the original report.

`source` preserves canonical SourceEvidence exactly, including `boundedExcerpt`, `resultCount` and `truncated`. Its path/revisionDigest must match location.path/location.snapshotDigest. Shared tooling independently verifies the file digest and valid line span at that snapshot, binds the safe excerpt reference to boundedExcerpt, and computes the admitted content digest from its exact UTF-8 bytes. Search results require one independently locatable finding per returned excerpt; omitted/truncated results cannot prove absence. Missing locator verification returns a typed incomplete result rather than repository-origin Evidence. Mock fixtures may synthesize these bindings only with `provenance: 'mock'`. The harness allocates Evidence IDs and source references after admission; the model cannot mint locations, findings or provenance.

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

## Proposed evaluation consumer seam

The [evaluation contract](evaluation.md) defines PublicCase/GradingCase/CaseResult and a versioned registration descriptor. Thai owns domain cases, expected outcomes and local contract/behavior adapters; Tai owns shared selection, orchestration, trusted grading infrastructure and one-command project evaluation. No new platform or executable path/command is selected here.

Proposed capabilities are register versioned UC cases, select one UC/requested level or the required project manifest, execute via authorized SUT adapter, grade through isolated oracle access and aggregate without losing per-case status/evidence. X-EVAL-AGREEMENT must confirm actual signatures, status translation and isolation; X-EVAL-RUNNER must identify an implemented delivery and conformance evidence. Existing UC-03 ModelPort/StatePort types are not repurposed as evaluation schemas.

Standalone Node tests may consume the same versioned case/rule designs before that runner exists; this proves only the exercised local level. T015 must prove real registration without changing case/oracle semantics, correct UC scoping, required-UC coverage, isolated result namespaces, failure propagation and comparable reporting. Missing shared capabilities are not-run with owner/gate reasons, never replaced by a second UC-01 runner or silently mapped to pass.

## Agreed receiver seam — 2026-10-28

The delegated receiving-owner agreement adopts [uc01-uc03-receiver-v1](../../001-verified-code-repair/contracts/uc01-receiver.md) for T013. The caller explicitly passes validated-source outcome/invocation/context and separately supplied BugTask fields to the actual UC-03 receiver. No fields are inferred from classification/severity/prose. The receiver returns accepted, needs-info, invalid-input, conflict or not-applicable; acceptance grants no execution/approval. UC-01 consumer-v1 and wire uc01-draft-v1 remain unchanged.
