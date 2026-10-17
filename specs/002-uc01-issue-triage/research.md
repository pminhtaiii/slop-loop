# Research: UC-01

**Status**: DRAFT design research, 2026-10-17. Accepted boundaries come from [ADR-0005](../../docs/adr/0005-uc01-triage-boundary-and-assessment.md); detailed choices below await approval.

## Assessment boundary

**Decision**: Propose one structured assessment path preserving original report and evidence registry, with later invocations supplying answers. No separate rewrite call.
**Rationale**: ADR-0005 explicitly rejects rewrite latency and distinguishes claims from findings.
**Alternatives considered**: Rewrite-first pipeline adds interpretation and cost; autonomous repair/dispatch exceeds scope.

## Shared contracts and independent development

**Decision**: Propose a narrow UC-01 consumer seam over shared repository/model/policy/accounting capabilities; agree it before fixtures/mocks. Thai implements no replacement repository, provider transport, ledger or policy engine.
**Rationale**: Existing [canonical contracts](../../src/contracts/uc03.ts) expose `ModelPort.propose(TaskState, SourceEvidence[], ProviderRequest)` and bug-specific proposals. RepositoryPort exposes more powers than triage needs and its signatures omit explicit per-call policy/budget context. Existing approved [interfaces](../001-verified-code-repair/contracts/interfaces.md) require guards and durable provider reservations; type compatibility cannot be assumed.
**Alternatives considered**: Fabricating a bug task corrupts semantics; copying ports creates competing foundations; waiting for all real adapters unnecessarily blocks contract-agreed mocks.

## Validation and provenance

**Decision**: Specify closed structured records with semantic validation and a trusted evidence registry; proposed parsing uses existing Node/TypeScript conventions without choosing a new schema package.
**Rationale**: Catalog membership, citation existence, snapshot identity and protected-data admission require deterministic checks beyond shape validation.
**Alternatives considered**: Free text cannot enforce citation membership; a JSON-only shape check cannot prove source provenance; model confidence is not evidence.

## Configuration and severity

**Decision**: Classification/destination catalogs are application configuration, with undetermined always permitted. Severity meanings remain the accepted ADR definitions; qualitative examples make fixtures testable without inventing numeric population thresholds.
**Rationale**: Severity is impact, not scheduling; an application-specific destination does not imply a runnable backend.
**Alternatives considered**: Hardcoded contributor labels confuse product and GitHub workflows; universal percentage cutoffs lack approval/evidence.

## Budgets and recovery

**Decision**: Require a finite trusted profile and cumulative UC-04 accounting, including provider reservation/settlement and uncertain usage; use explicit finite fixture profiles only in tests.
**Rationale**: [Runtime policy](../../context/runtime_policy.md) leaves production numeric limits open and forbids missing/unlimited bounds. New invocations cannot reset task allowances.
**Alternatives considered**: UC-01 in-memory production counters lose spending across restart; automatic provider retry risks duplicated billable calls.

## Open production decisions

Provider/model, transport, numeric budgets, catalog defaults, real adapter versions and evaluation thresholds remain release gates in [decisions](contracts/decisions.md). Research resolves a planning approach, not those approvals. The constitution is an unratified template. No external technology recommendation or new dependency is needed for this documentation scope.

## Incremental evaluation and source inspection

**Decision**: Follow the leader direction reported by the user: design cases/rubrics first, implement authorized slices, execute available checks immediately, accumulate failure/regression evidence, then integrate Tai's shared evaluation. Propose versioned reusable case/result/registration records in [evaluation](contracts/evaluation.md); keep T001–T016 and the six existing Issue identities.
**Rationale**: On 2026-10-17 at 2763d4a, package.json and both CI workflows expose build/type/lint/runtime/helper tests; tests/runtime contains bootstrap and UC-03 contracts/mocks. No evals/ directory, UC-01 runtime or shared runner exists. Early Node tests can verify local contracts/behavior without a competing runner; shared/project acceptance requires a real delivery and versioned agreement.
**Alternatives considered**: Deferring all case design/safety until T015 prevents incremental acceptance; building a UC-01 orchestrator duplicates Tai's ownership; pretending mock accuracy is model quality misstates evidence. A hard 100% gate on all classification samples would also obscure the user-supplied 80% floor, so hard security/contract gates, scored quality and execution completeness remain distinct.

The two original course Markdown sources are unavailable in this session/tracked inventory. Only the user's supplied minima are relied on. IssueTicket fields, retry wording and full-project counts are pending source reconciliation in [decisions](contracts/decisions.md); ADR-0005 is unchanged.
