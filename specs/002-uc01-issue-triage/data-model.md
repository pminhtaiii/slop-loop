# Data Model: UC-01

**Status**: Product record shapes approved at T001; shared evaluation registration remains separately gated. Normative shapes are in [contracts/schema.md](contracts/schema.md).

| Entity | Identity / fields | Relationships and invariants |
|---|---|---|
| Invocation | schemaVersion, invocationId, taskId, runId, issue, repositoryId, suppliedEvidence, answers, continuationRef | One issue/repository; immutable original report digest; selected workspace is trusted, never an input host path |
| TrustedContext | workspace/revision, config/policy identities, catalog, limits, accounting and evidence registry | Host-supplied separately from untrusted invocation; version mismatch fails before constrained calls |
| Assessment | classification, severity, destination, assertions, uncertainties, evidenceIds, questions | Values belong to trusted catalogs or undetermined; refs resolve within current invocation evidence |
| Assertion | id, text, basis, evidenceIds | Fact requires evidence; inference labeled; unknown is explicit and has no invented citation |
| Evidence | id, kind, sourceRef, digest, repository snapshot when applicable, safe excerpt ref | Reporter/answer/repository origins distinct; harness registers only actual admitted data; mocks visibly marked |
| Question | id, text, affects, reason | Material missing fact; IDs unique within immutable prior assessment |
| Answer | questionId, text | Trusted continuation resolves original question; text remains reporter data, never approval |
| Continuation | opaque ref to issue/report/repository/task, prior questions, config and snapshot | Caller/UC-04 owns retention; UC-01 validates supplied binding, stores no durable wait |
| Catalog | id, version, classifications, destinations | Unique entry IDs; responsibility text may overlap; undetermined reserved; UC-04/05 capability IDs excluded. Ambiguous destination matches return undetermined with material questions when needed |
| Outcome | status plus assessment or safe error fields | Discriminated union; errors cannot carry an accepted assessment |
| Evaluation case | UC-scoped stable caseId, dataset/version/digest, input, prerequisites, rule/version, requirements/tasks | Proposed [evaluation contract](contracts/evaluation.md); separate public inputs from grader-only expected outcomes/labels |
| Case result | run/attempt/UC/case/level, status, provenance, source/config identities, metrics and safe evidence refs | pass/fail/error/not-run distinct from product Outcome; no overwrite, mock promotion or hidden-label disclosure |
| Registration / run manifest | UC, supported versions/levels, case/oracle refs, required capabilities and required-case gate policy | Tai approves shared seam; selected UC scope and required-project coverage validated before dispatch; not implemented |

## State transitions

Invocation-local phases: validate -> admitted bounded research -> model assessment -> validate -> assessed/needs-info. Any phase may return a typed incomplete result; no implicit retry transition. The model can request only guarded read/search between bounded calls. needs-info requires at least one material question; assessed has none. Supported fields can remain determined while unrelated material unknowns trigger needs-info.

A later invocation resolves a trusted continuation reference, validates same task/issue/report/repository, revalidates configuration and repository snapshot, incorporates referenced answers and obtains a fresh assessment. Stale continuation returns conflict; caller may deliberately start a fresh intake using current context rather than silently reusing stale evidence. UC-04 owns persistence/restart/accounting; UC-05 owns pending action decisions. A clarification answer never transitions an approval record.

## Retention and privacy

Preserve the original issue in the caller's authorized record; expose only admitted bounded excerpts to the model. Full raw issue/answer/source/model bodies are not telemetry. Evidence references must not expose private repository identities or secrets in public contributor publication. Retention backend and durations remain external owner decisions.
