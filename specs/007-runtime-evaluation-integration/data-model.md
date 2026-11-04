# Data Model: runtime-evaluation/1

Integration records reference authoritative canonical task/state/approval/accounting; no second mutable ledger. Existing v0.1/v0.2 schemas stay authoritative unless an owner-agreed amendment is separately released.

| Entity | Required fields | Invariants / stories |
|---|---|---|
| CaseBinding | case/version/digest, publicTaskDigest, initialRepositoryDigest, catalogEntryId, grader/version/digest | Host resolves local paths; no private criteria/solution in public data. US1/US2 |
| BugSubmission | submissionId/version/digest, configured repository/checkSet IDs, public goal/behaviors/reproduction/criteria/constraints, intake status, taskId or null | Reporter data grants no execution authority; incomplete intake creates no runnable task; exploratory input cannot reuse frozen catalog grading. US1/US3 |
| ClarificationAnswer | submission/task ref, questionId/digest, expected version, answer digest/content, idempotency receipt | Immutable answer is not approval or direction; material criterion changes cannot overwrite frozen case identity. US3 |
| OperatorDirection | task/control versions, kind resume/revise/end, decision ref where applicable, request key and owner receipt | Issued by existing UC-05 control service after validation; continuation consumes it and cannot invent authority. US1/US3 |
| RuntimeProfile | profile/digest, endpoint/model/mode, pricing identity, image/platform, adapter versions, finite limits, derived-exposure policy | Credentials host-only, excluded from serialized reports/digests. US1 |
| CapabilityReceipt | receiptId, profile/case digests, owner versions, admitted operations, prerequisite evidence | Trusted composition issuance; JSON/provenance flags cannot mint authority. US1 |
| ExperimentAttempt | experiment/attempt IDs, selection, profile/code identity, timestamps/active duration, task/run refs | Immutable attempt, idempotent allocation, one active experiment. US1–US3 |
| CaseObservation | case/task/run refs, workflow outcome/lifecycle, executionTier, timing, artifacts, effects, usage, diagnostics | Grade distinct; waiting nonterminal; unknown is not zero/false. US1/US2 |
| CaseGrade | case/grader digests, finalSnapshotDigest, criterion results, status/reason, grading receipt | Exact same snapshot and independent isolated grader. US1/US2 |
| Diagnostic | ID, stage/component/reason, safe summary/evidence, attribution/confidence | Observed category is not unproven root cause; bounded/sanitized. US2/US3 |
| ArtifactRef | opaque ID/kind/digest/size, access class, task/run/snapshot | Host-controlled allowlist, never caller filesystem path. US2/US3 |
| Comparison | attempt refs, compatibility/reasons, config differences, case deltas/coverage | Matching cases/repositories/graders; explicitly expose confounders. US2 |

## Lifecycle and Validation

`created -> preflight -> running -> waiting-approval | waiting-info -> running -> finished`. Preflight may become blocked; uncertain effects require reconciliation. A terminal failed repair can finish the experiment while failing its grade. Waiting never certifies completion.

Evaluation-case lifecycle is separate from product-task lifecycle: an expected clarification/refusal case finishes with a passing safe-outcome grade once its pinned predicate is observed, while its product task remains paused. An unresolved repair-success approval wait remains evaluation pending. Neither outcome implies repair completion; the case evaluator cannot issue a resume direction.

Persist attempts/references through UC-04; reload canonical state on continuation with CAS/current UC-05 binding. Human wait is excluded from active deadline; spent active time persists across continuations. Same-process continuation is not crash/restart proof.

Usage records coder/reviewer input/output/cache/billable tokens, observed/conservatively charged cost, pricing identity and `observed | uncertain | unavailable`, with owner ledger references. Aggregate only known compatible units; unknown components do not become zero.

Coverage retains every required manifest case. Selected pass with omitted required cases means selected pass/suite incomplete. Historical reports retain their original evidence tier and contract.

Exploratory custom runs have no catalog acceptance coverage: caseGrade is not-run/unpinned-criteria, suiteAcceptance is not-applicable, workflow verification remains separately visible. A catalog attempt cannot be relabeled exploratory to obtain an acceptance pass. Answers that materially change frozen public criteria stop that attempt as non-comparable; operator must explicitly register a new case version/experiment. Original evidence and task accounting remain retained; no automatic retry as a new task.

## Proposed host-composition supplement

These records are immutable identity/observation references, not another task ledger. Exact public owner signatures require T019 agreement; [host contract](contracts/host-composition.md) specifies behavior.

| Record | Required binding | Validation / lifecycle |
|---|---|---|
| HostDelivery | capability kind, explicit contract version, revision, profile/config digest, owner conformance refs, adapter | Trusted host resolves; duplicates, stale bindings, missing methods or controlled delivery deny real readiness |
| HostReadiness | controlled/production tier, component statuses/reason codes, delivery/profile identities | Side-effect-free assembly; only complete accepted production delivery may enable execution admission; no credential payload |
| GuardedReadBinding | capability/task/workspace/run/repository identity, current control generation, policy, finite bounds | Fresh owner-fenced read authorization before one closure; pause/fence revokes subsequent reads |
| MeasuredHostSnapshot | existing TrustedHostSnapshot plus configured expected inventory | Actual revision/check/test measurements; partial/stale observation invalid, never fabricated from task input |
| BaselineDelivery | canonical content/digest, durable acknowledgement, load capability | UC-04-owned immutable evidence; uncertain write blocks until owner lookup; same identity/content on restore |
| RegisteredActionObservation | task/run/action digest, measured facts/elements refs, revision/profile, authority generation | Host-only registration; unknown/changed/expired lookup unavailable; fresh observation on continuation |
| RetainedRepositoryBaseline | configured immutable source/manifest identity, admitted file paths/digests/byte bounds, task/workspace/repository/base revision | Host-owned original source content separate from UC-04 verification evidence; present before edits, revalidated on lookup/continuation, complete diff requires retained bytes |
| MaterialReplanOperation | full request identity, canonical candidate FixPlan payload/digest, prior task/control/plan/count, explicit direction, owner receipt/result state | UC-04 transaction, UC-05 direction validation; payload/schema/digest checked before mutation, accepted advances once, same replay same committed state/receipts, conflicting ID denies, uncertain blocks |

Provider lifecycle stays canonical `admission -> claim -> beginAttempt -> outcome/uncertainty`, owned at model ingress. Graph generation forwards authority without another claim. Material replan is a separate owner transaction, not a provider/repository admission. Its accepted transition invalidates prior approval/review/edit authority and enters renewed plan approval; at most three material replans, with no count reset on continuation. Command-view facts come from one measured snapshot shared by owner admission and executor, with mismatches denied before attempts.

Coder inspection observations are bounded sanitized evidence/check-result references used to construct the next owner-bound request; each new model turn gets a distinct current admission. Explicit clarification persists bound questions and waits; stop/exhaustion cannot complete a repair. Reviewer uses the same canonical provider lifecycle with a distinct reviewer request/role; raw transport without durable attempt/outcome is unavailable on the production route.
