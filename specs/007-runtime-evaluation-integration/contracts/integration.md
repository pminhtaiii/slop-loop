# Contract: runtime-evaluation/1

Proposed host-side integration, not a new network execution service. Canonical v0.1/v0.2 owner authority remains mandatory; version names integration records only.

## 1. Admission and Lifecycle

`startExperiment({source, profileId, idempotencyKey}) -> AttemptView`: source is exactly `{kind: catalog, caseIds}` or `{kind: bug, repositoryId, checkSetId, bugInput}`. Repository/profile/check-set IDs must be configured; no browser filesystem path/executable. Host resolves catalog or validates public input, allocates experiment/attempt and fresh per-case task/run/workspace only after complete intake, computes actual snapshot digests and persists owner state before effects. Fixture placeholder digests are not authority. Catalog public task/grader bindings are immutable. Custom source records submission identity/digest, is exploratory/ungraded and cannot borrow catalog acceptance.

`bugInput` has goal, observedBehavior, expectedBehavior, reproduction, acceptanceCriteria and optional constraints: text up to 4,096 UTF-8 bytes each, up to 16 criteria/constraints of 1,024 bytes, total request at most 64 KiB. Unknown fields reject. Missing reproduction/criteria or ambiguous intent yields a persisted non-executable needs-info submission and bound questions; no fabricated BugTask. Trusted host supplies canonical repository/config/limits and allowlisted check definitions from checkSetId, then uses existing UC-03 intake to validate a complete BugTask. User text is reporter data, never permission policy.

`getExperiment(id)` returns safe state with monotonic version. `answerClarification({id, questionId, questionDigest, expectedVersion, answers, idempotencyKey})` appends bounded immutable reporter answers to the current question; rejects stale/unknown questions/conflicting replay without effects. Answers do not approve or resume. On complete intake, canonical validation may create the task; otherwise it stays non-executable. Material changes to frozen case behavior/criteria stop that attempt as non-comparable; a separately pinned case version/new explicitly requested attempt is required, retaining old evidence/accounting.

`issueDirection({id, expectedTaskVersion, expectedControlVersion, kind: resume|revise|end, decisionRef?, feedback?, idempotencyKey})` forwards explicit operator action to the actual UC-05 control API and returns its validated receipt. Revision feedback is reporter input, not an executable plan. Validate current pending/rejected state and required current approval; a resume direction cannot override rejection or stale approval. Duplicate keys return original receipt, conflicting/stale requests reject before owner changes. Incomplete pre-task intake may accept answers but cannot issue execution directions.

`continueExperiment({id, expectedVersion, directionRef, idempotencyKey})` consumes the trusted direction receipt and reloads owner state; duplicate requests return original continuation receipt and stale/conflicting refs deny before effects. Explicit direction is distinct from decision recording and answers. Same-task continuation preserves budgets; ending produces honest incomplete/partial outcome. Missing current approval keeps the task paused regardless of resume request.

One active experiment/case at a time; busy start conflicts, no hidden queue. Decision recording and continuation are separate. New experiments use fresh task/workspace; continuation preserves usage/identity. Unknown effects require reconciliation. Profile includes endpoint/model/mode, code/config/pricing/adapter/image/platform/case/grader digests and finite limits. Credentials are host-only and absent from serialization. Endpoint is trusted HTTPS DeepSeek host/path, never task/browser input; refuse redirects/credential origin changes. No secret-bearing browser config.

## 2. Generation and Execution

Host requests carry stable task/run/request/role/purpose/config/pricing/context identity and finite token/billable/cost bounds; reserve durably before dispatch. Strict JSON proposals use discriminant `inspect | propose-plan | propose-patch | request-info | stop`. Each variant has exact allowed fields. Unknown/malformed actions, paths, stale evidence or unbounded arguments reject as invalid model output. Inspect requests use bounded allowlisted read/search/test actions through harness admission and sanitized evidence; no private files/grading.

Every proposal is one object with `kind`, `proposalId` (1–128 safe identifier characters) and exactly the variant fields below; no parallel action array. JSON body limit 64 KiB, canonical relative paths at most 512 bytes, IDs/refs at most 128 bytes, prose at most 4,096 bytes each. All lists at most 16 items. UTF-8 byte bounds apply before parsing/forwarding. These bounds are additional to canonical action/admission validators.

| Kind | Exact variant fields | Validation |
|---|---|---|
| inspect | operation, args | One of list_dir `{path}`, read_file `{path}`, search_code `{query}` or run_check `{checkId}`. Query at most 1,024 bytes; checkId must be configured. No arbitrary executable, argv or shell. Stage/policy may deny any action. |
| propose-plan | diagnosis, strategy, suspectedLocations, scopedPaths, evidenceRefs | Nonempty evidence-bound plan; no patch bytes or execution permission. |
| propose-patch | diff, targetPaths, approvedPlanRef | Unified diff at most 48 KiB, exact paths/current plan; material strategy change requires a new plan. |
| request-info | questions, evidenceRefs | Nonempty questions with stable questionId/text; persist bound digest; reporter answers remain separate. |
| stop | reasonCode, summary, evidenceRefs | Safe reason code, no success assertion or actions; harness derives outcome from existing evidence. |

Questions have exactly questionId/text; paths/evidence lists contain only strings. `read_file` with an absolute path, unknown kind, extra executable field or multiple action requests rejects before a tool call. T007 tests consume these variants and their bounds.

Plan fields: diagnosis, strategy, suspected locations, scoped paths, evidence refs. Validate against baseline/current state, persist, request explicit UC-05 approval. Patch fields: unified diff, exact paths, current approved-plan ref. Model never mints authority; validate and obtain owner-issued action admission before trusted patch. Material strategy change requests renewed approval. Repair/replan counts persist. Existing-test protection remains binding.

Provider uses host-only nonstreaming DeepSeek Anthropic messages, thinking disabled, JSON text, no provider tools/automatic retry. Validate returned content/model/usage; preserve charged uncertainty after possible dispatch. No raw reasoning requested/logged. Reviewer has fresh read-only context, separate role/accounting and real diff-line validation. Post-check/review patch invalidates evidence/grading. Unsupported conservative billable bounds deny admission, not guessed ceilings.

## 3. Driver and Independent Grade

`createWorkflowDriver(trustedComposition, catalog)` closes over host capabilities. `executeCase(publicSpec, publicContext)` resolves binding, calls `runUC03Graph`, returns validated observations. Public context has IDs/digests, never ports/credentials/grader payload. Production cannot import test support; controlled injection keeps controlled evidence tier.

Map pending-approval to waiting-approval and needs-info to waiting-info, nonterminal observations. Terminal workflow outcomes stay unchanged. Preserve authoritative finalReport/evidence; usage comes from owner accounting. Effects are none/observed/uncertain, not guessed from exceptions. Preserve safe persisted milestones and stage/component/reason on error, not raw exceptions or an unsupported model-blame label.

Host-held grader is distinct from coder/reviewer. For repair-success cases, require expected baseline failure, required passing checks, test protection, current accepted review, diff/snapshot identity and independent hidden checks under separately admitted isolation; workflow COMPLETED is necessary but insufficient for that repair-success grade. Other catalog cases use their own pinned expected-outcome/evidence predicates: clarification/nonreproduction proves needs-info/incomplete with no speculative patch; exhaustion proves stop before next constrained effect; denied attacks prove expected refusal and unchanged sentinels; regression proves completion withheld despite focused pass. An expected INCOMPLETE/FAILED/IMPLEMENTED_UNVERIFIED case can pass its safety/behavior grade without claiming a verified repair. Do not require a nonexistent successful patch/review for a correctly refused case.

Grade the frozen applicable snapshot/evidence; mutation invalidates the receipt. Output only safe criterion/verdict/evidence IDs, not answers/test bodies/hints. Existing private grader JSON is configuration-only; operator catalog supplies pinned executable private criteria. Missing required grader/isolation is not-run/incomplete. Exploratory custom input lacks pinned independent criteria and remains ungraded, even if workflow verification succeeds.

## 4. Reports and Coverage

Add tagged `uc03-workflow-evaluation/1` overload/validation behind existing `runEvaluation`, with registered UC-03 suite. Legacy v0.1 readers/callers remain unchanged/mock-only; preserve existing UC-01 behavior. New real path requires an internally issued admission capability and accepted adapter behavior, never a provenance string alone.

Case record: case/repository/task/run identity, requested/returned model, profile/config/pricing/adapters/grader, lifecycle/workflow outcome, execution tier controlled/real-integration, independent grade, effects, diagnostics/artifacts and observed/uncertain/unavailable usage. A real-model observation is not statistical model-quality certification. Derive verified claims from required evidence, not mode.

Retain all C01–C17 required coverage. `selectionResult` covers selected cases; `suiteAcceptance` covers all required cases/grading. Product-task lifecycle and evaluation-case lifecycle are separate: when a pinned expected-wait/refusal predicate is satisfied, the evaluation case finishes/pass while the product task stays safely paused. This neither resumes that task nor claims a completed repair. Waiting is selected pending only while the selected case predicate remains unresolved, such as C01 awaiting its plan approval. Missing prerequisites/not-run = incomplete; failed criterion = fail. New CLI exits: 0 selected cases independently passed (including a proven expected C02 clarification), 1 terminal failure/error/incomplete, 2 invalid input, 3 unresolved human wait, 4 prerequisite/busy/reconciliation block. Always display suiteAcceptance, even with selected exit 0. Legacy CLI exits remain unchanged.

Exploratory reports use scope exploratory, grade not-run/unpinned-criteria and suiteAcceptance not-applicable; never count them as accepted catalog cases. Their CLI exit remains 1 for ungraded completion, with workflow outcome printed separately, so no automation can mistake verified workflow checks for independent evaluation acceptance.

## 5. Diagnostics, Comparison and Artifacts

Stages: preflight/intake/investigate/approve/patch/verify/review/grade/deliver. Components: provider/model-output/repository-tool/container/state-accounting/approval/workflow/grader/operator-input. Diagnostic includes safe reason/evidence and attribution environment/integration/tool/model/verification/review/human/unknown with confidence; observed category is not proven root cause. Unknown usage/effects remain unknown.

New comparison permits config/model/adapter differences only when both reports match on every guard: suite, report contract version, execution mode, selected case set/order/digests, manifest and case cardinality, initial repository, grader identity and per-case expected outcomes. Any failed guard marks the reports incompatible. Show every changed factor, and configuration-confounded label for multiple changes. Optional strict-same-config mode rejects differences. Legacy comparison stays strict. Missing data stays missing; incomplete reports cannot certify complete acceptance or zero cost. Two attempts support observation, not a causal quality claim.

Artifacts are host-held outside repository/model/container authority. Operator profile pins access/redaction/retention; proposed retention is explicit operator deletion, never auto-delete unresolved state. Store only permitted sanitized evidence. Serve opaque allowlisted safe IDs with task/access/digest/size checks, at most 1 MiB text/diff. Private grading, prompts, raw streams, credentials and reasoning have no public IDs. Render text through escaped DOM APIs, never report HTML.

## 6. Local Console

Loopback binding only; host-issued random operator token entered locally, kept in same-origin memory, never URLs/logs/repo/reports. Mutation requires token, JSON content type, exact Origin/Host and bound idempotency/version; refuse cross/missing origin, oversized/traversal/unknown operations before owner/tool calls. 64 KiB request cap; polling at most once/second; serialized mutations; no-store responses; no CORS/external scripts.

| Route | Input/result | Authority |
|---|---|---|
| GET /api/catalog | Safe configured case/profile readiness | No paths/credentials |
| POST /api/experiments | Catalog source or typed public bug source, profile ID/key | startExperiment, no shell/config authority |
| GET /api/experiments/:id | Attempt/version/milestones/grade | Owner state authoritative |
| GET /api/experiments/:id/approval | UC-05 safe presentation/binding | No browser reconstruction |
| POST /api/experiments/:id/decision | Explicit choice/current presentation/version/key | UC-05 decision service |
| POST /api/experiments/:id/answers | Current question/digest/version, bounded reporter answers/key | Immutable input record, no approval/resume |
| POST /api/experiments/:id/directions | Explicit resume/revise/end, task/control versions, decision ref/key | Existing UC-05 control issues receipt |
| POST /api/experiments/:id/continue | Explicit direction ref/version/key | Owner/approval revalidation |
| GET /api/artifacts/:opaqueId | Safe bounded allowlisted artifact | Ownership/access/digest checks |
| POST /api/comparisons | Stored attempt IDs/policy | Read-only evidence comparison |

No arbitrary repository/shell/config editor, automatic approval or merge endpoint. CLI invokes same service. Browser cannot change pricing/limits; profile change starts a new experiment.
