# Decisions and Authorization: UC-01

**Status**: T001 artifact and consumer-contract agreement approved on 2026-10-18 (Asia/Bangkok). T002–T010 completed under separate authorization at the controlled local level. On 2026-10-19 (Asia/Bangkok), the user authorized Phase 5, T009–T010, for configured recommendation through controlled shared ports. T011 onward and real execution remain separately gated.

## T001 approval provenance and approved agreement

On 2026-10-18 (Asia/Bangkok), the user requested implementation of T001 and independent subagent review. In response to the question asking for artifact approval and agreement with Tai, Thanh Tan and Trong Tan over model/read-search/evidence, accounting/policy/continuation, fixture profile and paths, the user replied **“Tôi xác nhận phê duyệt”**. This is the user's confirmation of the existing baseline and reported agreement, not separate messages from those owners. The approved baseline is repository commit `5cf4d14e9af770142fafe75894dfb172fd9fd663`: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, `tasks.md`, and `contracts/{schema,interfaces,acceptance,evaluation,decisions}.md` in this feature directory. Approval of the proposed evaluation design does not satisfy the separate shared runner/corpus/real-run gates.

The original T001 instruction authorized documentation and review only. Subsequent task authorization is recorded below; technical readiness alone grants no permission. The user reviewed and approved the T001 commit message `docs(uc01): record T001 artifact and consumer-contract agreement`.

Independent review of the baseline found that its required exact consumer signatures and numeric fixture profile were absent, and that `SourceEvidence.boundedExcerpt` was incorrectly called `excerpt`. Those details were then supplied and independently reviewed as `uc01-consumer-v1-candidate` and `uc01-fixture-v1-candidate`. After the additions and their ADR/context alignment were explained, the user stated: **“Tôi và các thành viên khác đã phê duyệt, message commit cũng đã được phê duyệt. Hãy hoàn thành phần còn lại để kết thúc T001.”** This records member approval as reported by the user, without inventing individual messages. The reviewed candidate content is adopted unchanged as **`uc01-consumer-v1`**, with **`uc01-fixture-v1`**; the product wire discriminator remains `uc01-draft-v1` and no executable UC-03 type is changed. The exact approved signature/profile definitions are retained in this revision of interfaces.md and schema.md.

| Agreement item | Approved agreement / owner |
|---|---|
| Model role and request/result | `triage` on a separate consumer seam, with signatures and closed variants in [interfaces](interfaces.md#versioned-consumer-signatures); Thai validates proposals, Tai owns transport. Existing coder/reviewer UC-03 types remain unchanged. |
| Read/search and evidence | Guarded operation context and results in interfaces; canonical SourceEvidence is preserved under `source`, independently verified RepositoryLocation under `location`. No inferred line spans/digests. |
| Accounting/policy | Stable request/reservation identities, bound guard context, settlement and uncertainty rules in interfaces; Tai composes, Thanh Tan owns accounting, Trong Tan owns policy. |
| Continuation | Caller/UC-04 resolves the schema's immutable issue/task/report/repository/config/question binding; no local persistence or approval interpretation. |
| Finite fixture profile | `uc01-fixture-v1` in [schema](schema.md#finite-controlled-fixture-profile), synthetic units, cumulative task/run bounds, no provider access. |
| Owned paths | Thai: `src/uc01/`, `tests/runtime/uc01/`, `tests/runtime/support/uc01/`; coordinator: agreement amendments, canonical ledger and context. Tai: `src/contracts/foundation/uc03.ts`, `src/foundation/`, shared evaluation infrastructure; Thanh Tan: `src/persistence/`; Trong Tan: `src/approvals/`. No foreign-path runtime edits in T001. |

T001 exit records approval of the artifact baseline plus the reviewed signature/profile amendments, finite mock-only execution and path ownership. The coordinator closes only T001 after the final current-artifact reviews and local checks pass. This is a contract agreement gate, not a requirement for real adapter availability. Production numeric choices, real deliveries, receiver agreement, shared evaluation agreement/runner and scored runs remain separately gated below.

## Subsequent implementation authorization

T002–T004 were separately authorized on 2026-10-18 and completed as the contract/mock/fixture slice recorded in [tasks](../tasks.md). On 2026-10-18 (Asia/Bangkok), the user requested: **“Thực hiện Implement Phase 3: User Story 1 - Evidence-backed assessment (Priority: P1), bao gồm T005-T006 trong specs/002-uc01-issue-triage/tasks.md.”** This authorizes validated intake and bounded initial assessment through injected controlled ports, plus their tests, review, context refresh and contributor publication. It does not authorize T007–T016, real adapters, provider runs, production configuration, dispatch or repair. Initial material questions may obtain a trusted continuation binding; later-answer reassessment remains T007–T008. Only the minimal undetermined destination is in this slice; configured recommendation remains T009–T010.

On 2026-10-19 (Asia/Bangkok), the user requested: **“Thực hiện Implement Phase 4: User Story 2 - Clarification across invocations (Priority: P2). Tương ứng với T007-T008 trong specs/002-uc01-issue-triage/tasks.md”** and noted the local CodeRabbit CLI is available if needed. This separately authorizes question/answer binding and later-invocation reassessment through the approved controlled consumer seams, with tests, independent review, context refresh and contributor publication. It preserves the agreed original-report, evidence-provenance, continuation and cumulative-accounting contracts. It does not authorize T009–T016, real adapters, provider runs, production choices, dispatch, repair or action approval from clarification answers.

On 2026-10-19 (Asia/Bangkok), the user requested: **“Thực hiện Implement Phase 5: User Story 3 - Configured recommendation (Priority: P3). Tương ứng với T009, T010 trong specs/002-uc01-issue-triage/tasks.md”** and noted the local CodeRabbit CLI is available if needed. This separately authorizes catalog-constrained recommendation and its composition with assessment through the approved controlled consumer seams, with tests, independent review, context refresh and contributor publication. Existing catalog, evidence, severity, clarification and cumulative-accounting contracts remain in force. T011–T016, real adapters, paid/provider runs, production choices, dispatch, repair and action approval remain outside this authorization.

## Accepted basis

[ADR-0005](../../../docs/adr/0005-uc01-triage-boundary-and-assessment.md) records accepted assessment/ownership/severity/clarification/recommendation boundaries. Existing UC-03 [decision record](../../001-verified-code-repair/contracts/decisions.md) and shared contract v0.1/schema 0.1.0 remain unchanged. UC-03 Phase 2 authorization does not authorize UC-01 implementation.

## Proposed decisions and explicit gates

| Gate | Decision required / evidence | Owner | Blocks |
|---|---|---|---|
| A-ARTIFACTS | SATISFIED for the approved baseline and reviewed amendments; subsequent implementation authority extends through T009–T010 as recorded above | Project owner with Thai | T011 onward requires separate implementation authorization |
| X-FOUNDATION-AGREEMENT | SATISFIED by user-reported member approval of `uc01-consumer-v1`, `uc01-fixture-v1`, evidence projection and path ownership above | Thai + Tai; Thanh Tan/Trong Tan for accounting/policy bindings | T001 agreement exit met; mocks still require explicit task implementation authorization |
| X-READ-MODEL | Real shared read/search and model adapters with guards and actual revisions; no forced bug TaskState | Tai | T011, T012 |
| X04-STATE | Durable task budgets/reservations/uncertain-use reconciliation and continuation binding; real restart evidence | Thanh Tan | T011, T012 |
| X05-GATE | Policy classification, bound pause/resume/denial for shared actions | Trong Tan | T011, T012 |
| X-RECEIVER | Receiving owner agrees assessment projection and admission requirements; no dispatch from UC-01 | Receiving workflow owner + Thai | T013 only; not fixture recommendation |
| A-PRODUCTION | Provider/model, catalog defaults, finite numeric limits/pricing, deployment and isolation config approved | Project owner + shared owners | Any real constrained operation |
| A-EVALUATION | Approve frozen held-out corpus/labels/rules, isolation, comparability plan, remaining quality/latency thresholds and real-run authorization; retain user-supplied >=80% classification floor | Thai + project owner; Tai harness | T015 exit / runtime acceptance, not early local case design |
| X-EVAL-AGREEMENT | Approve versioned case/result/registration/grading/aggregation and isolation seam from evaluation.md; reconcile other UC versions and project manifest ownership | Tai + Thai; leader for project scope | T015 shared registration; not earlier authorized local contract/mock checks |
| X-EVAL-RUNNER | Implemented shared runner/adapter/grader revisions, scoped/project selection and safe evidence delivery | Tai, with required UC owners | T015 actual shared conformance/project run; no UC-01 replacement runner |
| A-TICKETS | Existing six-slice breakdown approved in the prior user exchange; current task authorizes updating the same six pairs/stable keys without closing/promoting them | User | No new issues or material re-decomposition without separate approval |

No gate is satisfied by this file's existence. Record actual approval provenance/version and external delivery ledger/revision/checks before promoting readiness. Do not invent foreign task IDs or mark proposed schemas shared-approved. Agreed mocks may replace delivery availability, never agreement, production admission or implementation permission.

## Coursework sources and reconciliation

The two original Markdown course documents about SE373 assessment and Coding Agent requirements were not attached in the current context and were not found in the inspected tracked Markdown inventory. Their exact text, IssueTicket fields, wrong-output retry requirements and project-wide case/attack counts have **not** been independently verified. The current user's explicit minima are the planning basis: >=5 UC-01 examples including boundary/error cases and defect/feature/ambiguous/irrelevant/malicious coverage, >=80% classification accuracy, case outcomes/traces/failure analysis, two comparable runs, actual latency/tokens/cost and future one-command project integration. No successful evaluation is claimed.

| Topic / potential difference | ADR-preserving proposal | Pending confirmation |
|---|---|---|
| IssueTicket vs Assessment | Reuse one original issue plus the existing Assessment/Outcome; evaluation input wraps that contract. No separate LLM rewriting stage or executable ticket is introduced | Leader/Thai verify original IssueTicket requirements before any new transport/field mapping; Tai agrees any shared projection |
| Invalid structured model output | C14 verifies typed invalid-model-output failure and correct usage accounting; evaluation records failure instead of inventing corrected output | Any course-required repair/retry loop must be checked against the original source and approved with finite shared budget/retry rules; no automatic retry authorized here |
| Routing | Configured destination recommendation or undetermined; receiver validation at T013, no UC-01 dispatch | Any request for automatic routing execution requires a separate design/authority decision, not a silent ADR change |
| Accuracy / sample count | The user-supplied >=80% classification floor and >=5-case minimum apply to actual held-out model-quality evaluation, not mock enums | Thai/leader approve corpus, labels and remaining metrics; confirm original wording when sources become available |
| One-command overall evaluation | Tai owns the shared entry point and required-UC/case/attack manifest; UC-01 supplies reusable cases and conformance evidence | Exact global counts, selected UCs, command/API, paths and serialization require original-source review and Tai/leader agreement; no existing runner assumed |

## Existing Issue identities

The six public Issues retain mappings and native blockers: [#39](https://github.com/pminhtaiii/slop-loop/issues/39) T001–T006; [#40](https://github.com/pminhtaiii/slop-loop/issues/40) T007–T008 blocked by #39; [#41](https://github.com/pminhtaiii/slop-loop/issues/41) T009/T010/T014 blocked by #40; [#42](https://github.com/pminhtaiii/slop-loop/issues/42) T011–T012 blocked by #41; [#43](https://github.com/pminhtaiii/slop-loop/issues/43) T013 blocked by #41; [#44](https://github.com/pminhtaiii/slop-loop/issues/44) T015–T016 blocked by #42/#43. Stable keys, in that order: uc01-evidence-assessment, uc01-later-clarification, uc01-safe-destination, uc01-real-shared-integration, uc01-receiver-compatibility, uc01-evaluation-acceptance. Private identities stay in ignored paired-publication receipts. Revise acceptance/evidence obligations in place on both sides; keep needs-triage and all implementation criteria unchecked. No shared-owner work is duplicated as a new Issue.
