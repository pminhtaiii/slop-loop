# Proposed Structured Contract: UC-01 draft-v1

**Status**: DRAFT consumer schema; X-FOUNDATION-AGREEMENT pending. This does not modify executable UC-03 0.1.0.

## Notation and common validation

Objects below are closed: only listed fields are permitted; all required unless marked `?`. Arrays have finite host-configured cardinality/byte bounds. `Id` is nonempty bounded text; `Digest` is lowercase 64-hex SHA-256; `Text` is bounded admitted text, never a secret. Integers are finite nonnegative safe integers; required limit maxima are positive. All numeric values must be finite. Optional means omitted, never null. Reject duplicate IDs, unknown enums, malformed digests, unsupported schemaVersion, NaN and Infinity. Contract-specific validators are planned, not implemented.

## Invocation (untrusted caller data)

| Field | Type / rule |
|---|---|
| schemaVersion | literal `uc01-draft-v1` |
| invocationId, taskId, runId | Id; trusted caller binds task/run, untrusted fields cannot reset accounting |
| repositoryId | Id; must match host-selected repository |
| issue | `{id: Id, title: Text, originalReport: Text, reportDigest: Digest}`; digest computed/checked by harness over exact UTF-8 originalReport |
| suppliedEvidence | `SuppliedEvidence[]`; shape below; application admission required before use |
| answers | `{questionId: Id, text: Text}[]`; empty on first invocation |
| continuationRef? | opaque Id; required when answers nonempty; resolved from trusted caller/UC-04 record |

`SuppliedEvidence = {id: Id, sourceRef: Id, content: Text, digest: Digest}`. Supplied evidence is always reporter-origin, even if its text claims to quote a repository. Only actual shared-tool retrieval can create repository-origin evidence. Protected-data checks precede admission; computed digest must match content. Original report and accepted answers also enter the evidence registry with distinct harness IDs.

## Trusted context (host-supplied, never model authority)

`{taskId, runId, repositoryId, workspaceId, repositorySnapshotDigest, configId, configVersion, policyId, policyVersion, catalog, limits, accountingRef, evidenceRegistry, continuation?}`.
All identities are Id; repositorySnapshotDigest is Digest. `accountingRef` resolves authoritative UC-04 records. `evidenceRegistry` contains admitted Evidence records. `continuation` when resolved binds taskId, issueId, reportDigest, repositoryId, repositorySnapshotDigest, configId/configVersion, priorAssessmentId and prior Question[]; identities and digests use common types. Any binding drift returns conflict before constrained activity. Initial intake has no continuation; dangling/duplicate/foreign question IDs are invalid-input. Answers may cover a subset; remaining material questions stay open in a fresh assessment.

`Catalog = {id: Id, version: Id, classifications: Classification[], destinations: Destination[]}`.
`Classification = {id: Id, definition: Text, impairmentAssessment: boolean}`. This flag permits consideration of defect severity; it never proves impairment.
`Destination = {id: Id, responsibility: Text, acceptsClassificationIds: Id[]}`. Membership must reference catalog classifications; a recommendation requires responsibility fit, not merely matching classification. Entry IDs must be unique within their catalog list; responsibility text need not be unique and may overlap. Repeated responsibility text alone is valid configuration. If available evidence cannot distinguish compatible destinations, return undetermined and ask clarification when the ambiguity materially changes the route. Empty catalogs are allowed and lead to undetermined. The reserved `undetermined` is not a configurable ID. UC-04 recovery/UC-05 approval capabilities cannot be ordinary destinations; host admission rejects those semantic entries even if relabeled. Allowed destination catalog identity is trusted application configuration, never a model-generated catalog.

`Limits` requires positive finite maxima for invocation wall time, modelCalls, toolCalls, per-call timeout, inputBytes, outputBytes, evidenceItems, searchResults, questions, inputTokens, outputTokens, totalTokens and cost (fixed pricing unit). Config has explicit task/run scope, currency/pricing identity, remaining-accounting refs and conservative per-request billable ceilings. No default numeric values. Reject inconsistent totals or unsupported provider caps; shared guards enforce operation-specific resource bounds. Controller and provider reservations consume the same authoritative budget, not parallel independent counters.

## Evidence registry

`Evidence = {id: Id, kind: 'reporter'|'answer'|'repository', sourceRef: Id, contentDigest: Digest, safeExcerptRef: Id, provenance: 'mock'|'real', repository?: RepositoryLocation, questionId?: Id}`.
`RepositoryLocation = {repositoryId: Id, snapshotDigest: Digest, path: Text, fileDigest: Digest, startLine: positive integer, endLine: positive integer}`.
Repository kind requires repository and forbids questionId; path is canonical workspace-relative, lines must exist with end >= start, snapshot/file digest must match actual guarded result. Answer requires questionId and forbids repository; reporter forbids both. Non-repository sourceRef resolves admitted report/supplied evidence/answer record; no arbitrary URL is evidence authority. Mock findings are explicit and cannot become real by model assertion.

## Model proposal and accepted assessment

`Proposal = {classification, severity, destination, assertions, uncertainties, evidenceIds, questions}`; only these keys. No raw host context, dispatch instruction, rewritten report or new Evidence objects are accepted. A model tool request is a separate bounded response variant defined at the shared seam in [interfaces](interfaces.md), never an assessment field.

`Decision = {value: Id|'undetermined', assertionIds: Id[]}` for classification/destination. Values must be configured members; non-undetermined destination additionally respects classification compatibility and stated responsibility. Undetermined classification permits only undetermined destination in this draft.

`Severity = {value: 'P0'|'P1'|'P2'|'P3'|'undetermined', functionality: Dimension, affectedUsers: Dimension, workaround: Dimension, assertionIds: Id[]}`.
`Dimension = {summary: Text, known: boolean, evidenceIds: Id[]}`. Known requires evidence; unknown requires empty evidenceIds and explicit missing fact. A determined level requires evidence sufficient for its ADR threshold; unresolved material impact dimensions force undetermined. If classification is undetermined or impairmentAssessment=false, severity must be undetermined. impairmentAssessment=true only permits considering severity: P0–P2 require evidenced impact meeting their functional-impairment thresholds, while P3 permits evidenced minor inconvenience or cosmetic defects with little or no functional effect. Feature requests without an evidenced existing defect remain undetermined; business urgency never supplies defect evidence.

`Assertion = {id: Id, text: Text, basis: 'fact'|'inference'|'unknown', evidenceIds: Id[]}`. Fact requires at least one valid reference; inference requires supporting refs and explicit inference wording, not a fabricated observed fact; unknown requires none. Decision assertionIds are nonempty and resolve into assertions, including for undetermined decisions. Harness checks that all references are admitted and compatible; semantic support is additionally graded by acceptance/evaluation, not established by citation existence alone.

`Question = {id: Id, text: Text, affects: ('intent'|'scope'|'severity'|'destination')[], reason: Text}`; affects nonempty. `uncertainties` is Text[] and `evidenceIds` is the union of referenced evidence IDs, without duplicates. Questions must concern material missing facts; configured bounds cannot silently truncate material questions into assessed success: return incomplete/exhausted if the full necessary set cannot fit.

`Assessment = Proposal + {assessmentId: Id, issueId: Id, reportDigest: Digest, repositoryId: Id, repositorySnapshotDigest: Digest, catalogId: Id, catalogVersion: Id, provenance: 'mock'|'real'}`. Harness adds identities after validation; model cannot mint them. No structured result implies verified diagnosis or actionable authority.

## Outcome union

- `{status:'assessed', assessment: Assessment, eventRef: Id}` requires zero material questions; undetermined fields may remain for non-material unavailable facts, with reasons.
- `{status:'needs-info', assessment: Assessment, continuationRef: Id, eventRef: Id}` requires nonempty material questions and trusted caller/UC-04 binding. It does not persist waiting or approve an action inside UC-01.
- `{status:Failure, reasonCode:Id, safeMessage:Text, nextAction:Text, eventRef:Id}` has no assessment. `Failure = 'invalid-input'|'denied'|'pending-approval'|'conflict'|'exhausted'|'timeout'|'uncertain'|'error'`. Pending-approval references a shared action event, never a clarification decision.

An invalid provider proposal maps to error with reasonCode `invalid-model-output`, not invalid caller input. Tool denial/pause, stale state and provider uncertainty retain their corresponding failure. Stable codes and safe diagnostics must exclude raw prompts/output/secrets. A model timeout with uncertain billable usage returns uncertain; confirmed canceled/non-dispatched timeouts may return timeout. All outcomes carry safe event references through the shared telemetry boundary.
