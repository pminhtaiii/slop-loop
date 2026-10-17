# Decisions and Authorization: UC-01

**Status**: DRAFT, revised 2026-10-17 (Asia/Bangkok). The current user reports leader agreement to evaluation-first -> incremental implementation -> continuous verification -> evidence collection -> shared evaluation integration. This records the reported direction and this documentation/Issue-publication authorization, not approval of detailed schemas or runtime implementation.

## Accepted basis

[ADR-0005](../../../docs/adr/0005-uc01-triage-boundary-and-assessment.md) records accepted assessment/ownership/severity/clarification/recommendation boundaries. Existing UC-03 [decision record](../../001-verified-code-repair/contracts/decisions.md) and shared contract v0.1/schema 0.1.0 remain unchanged. UC-03 Phase 2 authorization does not authorize UC-01 implementation.

## Proposed decisions and explicit gates

| Gate | Decision required / evidence | Owner | Blocks |
|---|---|---|---|
| A-ARTIFACTS | Review/approve UC-01 spec, plan, contracts and ledger; explicit implementation scope | Project owner with Thai | All implementation; planning/publication is authorized only |
| X-FOUNDATION-AGREEMENT | Versioned triage model request/result seam, read/search envelope, SourceEvidence projection, finite fixture profile and owned paths | Thai + Tai; Thanh Tan/Trong Tan for accounting/policy bindings | T001 exit; mocks may start only after this agreement |
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
