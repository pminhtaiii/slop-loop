# Data model and state ownership

All boundary inputs validated from unknown, copied/frozen; safe bounded IDs and canonical digest forms. No persistence backend selected. Ownership below is process-local; serialized clones cannot mint authority.

| Entity | Fields / invariants | Owner / story |
|---|---|---|
| RepositoryBinding | repositoryId, workspaceId, revisionDigest, policyDigest; selected by host, exact equality | repository adapter; US1/US3 |
| SourceSnapshot | snapshotId, immutable original-byte manifest/digest, admitted revision, stable-acquisition evidence, bounded admission work profile; separate from current-workspace freshness | trusted host admission; US1/US3 |
| ProductSession | sessionId, active task ID, bounded labeled conversation/summary, selected binding, closed flag, in-flight turn guard | session module; US3 |
| QuestionTask | taskId, sessionId, explicit user goal, config/profile digest, status, cumulative ledger, pending clarification ID/rounds | graph/session; US1–3 |
| QuestionRun | runId, questionId, taskId, immutable examined binding, current node, start/active elapsed, result | graph; US1–3 |
| BudgetProfile | finite integers from runtime/repository contracts; no model edits | host configuration; all stories |
| BudgetLedger | consumed/reserved tool/model/scan/byte/token/cost/active-time totals; reservation IDs and unsettled status; no reset during continuation | budget module/authoritative accounting port; all stories |
| AdmittedSpan | evidenceId, run/task binding, snapshot/manifest identity, canonical path, actual line range, excerpt/file digests, approved excerpt, truncation; host issuance after matching expected bytes | private evidence registry; US1 |
| SearchPage | issued spans, matching-line positions, bounded omissions, query/binding cursor, coverage | repository adapter; US1 |
| Claim/Citation | claimId, bounded text, observation/inference kind, issued evidence refs and contained actual line ranges | model proposal, validated by evidence/presentation; US1 |
| Clarification | task/run/turn ID, bounded question, unresolved intent, round counter; user answer is data | graph/session; US2/US3 |
| QuestionResult | schema, identities/binding, terminal kind, valid claims/citations or clarification, limitations/reason codes, usage completeness | presentation; all stories |
| EvaluationCase | ID/version/split/size, public input/repo refs, private rubric facts/spans, required flags | evaluator only; US4 |
| Observation | bound case/runtime/profile/model IDs, task/run IDs, metadata/evidence refs, sanitized result artifact ref, durations, usage, not-run reasons | evaluator driver; US4 |
| Grade/Adjudication | observation/case/rubric digests, dimension results, evaluator identity and rationale, disposition | independent evaluator/human; US4 |

## Relationships and lifecycle

Session contains many tasks; task contains many runs and one cumulative ledger; run contains admitted evidence and one typed result. Clarification continuation stays in task, new run. Explicit new task has a new ledger; model cannot choose this. Switching repositories ends current activity before new task binding. Drift ends run stale; no automatic restart. Rebind retains task budget and discards old evidence authority.

Session summary contains source references labeled with original repository/revision but is advisory; reuse requires recheck/re-admission. Authoritative ledger, registry and pending clarification are never reconstructed from summary. Closing session invalidates active capabilities; restart has no recoverable session in v1. Cancellation ignores late replies and preserves unresolved accounting reservations.

Directory/search cursor is host-issued bounded state tied to immutable binding/query/options, expires with session or changed revision. It cannot grant broader scope or fresh budget. Evidence IDs are never accepted merely because strings match a digest; registry issuance/current run checks are mandatory.

EvaluationCase public projection is the only case content sent to runtime. Private facts/grades/held-out inventory are never repository files. Observation and grade immutable; changed source/config/rubric yields a new observation/grade rather than relabeling old results.
