# Decisions and Authorization: UC-01

**Status**: DRAFT, 2026-10-17 (Asia/Bangkok). No new owner approval is recorded here.

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
| A-EVALUATION | Held-out corpus, labels, grading isolation, numeric agreement/latency thresholds and run authorization | Thai + project owner; Tai harness | T015 exit / runtime acceptance |
| A-TICKETS | Approve proposed vertical-slice breakdown and blocking edges | User | GitHub Issue publication only |

No gate is satisfied by this file's existence. Record actual approval provenance/version and external delivery ledger/revision/checks before promoting readiness. Do not invent foreign task IDs or mark proposed schemas shared-approved. Agreed mocks may replace delivery availability, never agreement, production admission or implementation permission.
