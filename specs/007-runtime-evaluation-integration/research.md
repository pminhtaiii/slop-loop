# Research: Observable Python Repair Evaluation

## Inspected Baseline

Planning base: development `ab8d1421491252d659e6e2054f1153cac831be0d`. Earlier read-only exploration used merged `2a9ad7e21576276be257dc15dd1080bcebf67d9b`; affected sources are reread on the planning base. This is inspection, not fresh runtime verification.

| Observation | Source | Consequence |
|---|---|---|
| Graph/final report exist | `src/uc03/graph.ts`, `graph-types.ts`, `report.ts` | Reuse workflow identity/evidence |
| Plan/patch supplied by caller; no coder propose under UC-03 | `graph-nodes.ts`, `investigation-plan.ts` | Driver alone cannot assess model repair |
| Evaluation drivers found only in tests | `tests/runtime/unit/uc03-evaluation.test.ts` | Add actual graph-backed driver/grader |
| Both runner paths refuse real execution | `eval/uc03/runner.ts`, `eval/shared.ts` | Scoped admitted extension, not global flag removal |
| Report explicitly non-real, shared usage null | `eval/uc03/types.ts`, `eval/shared-types.ts` | Version new observation semantics |
| Comparator requires identical config | `eval/uc03/compare.ts` | Explicit compatibility for changed configuration |
| V0.2 model and durable approval adapter marked mock | `src/foundation/model-v02.ts`, `src/persistence/adapters/approval-store-adapter.ts` | Presence is not real delivery |
| Transport/controller injected, reviewer interface only | `src/foundation/model.ts`, `docker-workspace-types.ts`, `src/uc03/graph-types.ts` | Concrete adapters/conformance required |
| Python calculator exists locally, unshipped | `fixtures/uc03/success/`, UC-03 decisions | Explicit catalog/digests; missing input is not-run |

## Decisions

### Reuse and generation

**Decision**: One graph-backed driver/host grader through existing `runEvaluation`; add bounded coder generation and distinct read-only reviewer.
**Rationale**: Existing evidence structures are useful, but injected answers cannot assess model diagnosis. Target repairs must be done by our runtime, not delegated to a contributor coding product.
**Alternatives considered**: New benchmark runner duplicates machinery; CLI subprocess loses trusted composition/continuation; precomputed solutions remain controlled evidence only.

### Provider Compatibility

**Decision**: User-selected `deepseek-flash`, Anthropic-compatible base `https://api.deepseek.com/anthropic`, POST `/v1/messages`, host-only operator credentials, native fetch. First profile uses thinking disabled, nonstreaming JSON text proposals and no provider tools. Validate content/model/usage and reserve before dispatch.
**Rationale**: Avoid reasoning/tool-history persistence while retaining harness control. Validate actual selected mode's token/billing behavior; do not assume requested output limit applies to every compatibility mode. Preserve unknown billing and cache accounting honestly.
**Alternatives considered**: SDK unnecessary initially; thinking/streaming/tool modes add compatibility obligations before first route.
**Sources checked 2026-11-01**: [Official compatibility guide](https://api-docs.deepseek.com/guides/anthropic_api/) and [endpoint/model guide](https://api-docs.deepseek.com/quick_start/agent_integrations/). Rolling alias is not immutable weights; record requested/returned identity and date. Runtime pricing must be supplied/pinned, not copied as a permanent figure here.

### Spending Preference

**Decision**: No user economic cap; finite accounting exposure derived from operational profile and conservative pricing, preserving atomic reservation/settlement.
**Rationale**: User wants pipeline evidence before optimization. Existing contracts still require finite technical limits; derivation avoids arbitrary dollar questions and hidden low caps.
**Alternatives considered**: Infinity, huge sentinels, auto-refill or ledger bypass violate existing guards. Owner compatibility remains required; incompatible deliveries require targeted amendment, not casts/provenance changes.

### Prepared Case and Interface

**Decision**: Operator catalog supplies local-only Python task/private grader. CLI and loopback console share one service; console acceptance follows first real route.
**Rationale**: Preserves fixture preference and interactive goal without adding GitHub/import/hosting dependencies.
**Alternatives considered**: New UI framework, arbitrary repository import and multi-user service do not help first-route diagnosis.

### Prerequisites

**Decision**: Explicit profile proposal in plan; require exact actual image/platform, pricing and accepted owner adapters at real preflight.
**Rationale**: Design can be complete without inventing external delivery or environment readiness. Missing prerequisites yield blocked evidence, not a mock real pass.

## Host-composition remediation research — 2026-11-04

Fresh planning base `d2f953239b658b2b282d9e41523e819d9785fd49`; source/spec comparison against investigation HEAD `67646d80568064caf7d3eced043e92557df20d28` showed no changes in those trees. The earlier baseline table is historical, not today's capability inventory. No provider/container/tests were run to infer real readiness.

| Verified current gap | Source | Design disposition / task |
|---|---|---|
| Composition helper accepts injected deliveries; no source caller | `src/runtime/evaluation-composition.ts`, `src/cli/evaluate.ts`, `src/cli/uc03.ts` | T028/T029 host assembly and trusted operator loader |
| Concrete repository diff throws NOT_IMPLEMENTED | `src/foundation/repository-tools.ts` | T032 read-only bounded diff producer before bootstrap/review |
| Existing snapshot/evidence types do not retain initial source bytes | `src/uc03/investigation-types.ts`, canonical Baseline, `src/foundation/host-filesystem-port.ts` | T033 configured retained immutable initial tree/manifest, separate from UC-04 verification evidence |
| Production read/host/baseline/context producers absent; test fakes exist | `src/foundation/repository-types.ts`, `src/uc03/investigation-types.ts`, `src/approvals/real-context-provider.ts` | T021–T024, owner writer remains external |
| Graph/coder typed v0.1; v0.1 model actually exists | `src/uc03/graph-types.ts`, `agent-types.ts`, `src/foundation/model.ts` | Explicit production successors T020/T026/T027; no claim only v0.2 exists |
| Graph preclaims provider; model boundary also calls claim | `src/uc03/graph-generation.ts`, `src/foundation/model-v02.ts` | One owner chain at model ingress; T026 tests exact call/charge counts |
| Coder run-check currently lacks v0.2 admission argument | `src/uc03/agent.ts`, canonical `RepositoryPortV02` | T026 fresh per-check owner admission |
| Generation drops tool observation; node expects immediate plan/patch | `src/uc03/graph-generation.ts`, `graph-nodes.ts`, `graph-patch.ts`, `graph-feedback.ts` | T026/T027 bounded inspect/evidence/fresh-admission loop plus explicit clarification/stop; T030 must traverse it |
| Reviewer raw transport lacks canonical durable attempt/outcome chain | `src/foundation/reviewer.ts`, `src/uc03/graph-review.ts` | T034 canonical reviewer model ingress, no graph preclaim, exact once/uncertainty tests |
| Repair reserve is legacy fallback, replan reserve is reachable; no UC03 settle call | `src/uc03/repair.ts`, `replan.ts`, `graph-feedback.ts` | Migrate actual consumers; replan has distinct owner transaction, not a reserve/settle shim |
| Canonical v0.2 state exposes no material-replan transaction | `src/contracts/foundation/uc03/v02/ports.ts` | Proposed explicit supplement in host contract section 4; T019 owner agreement gates T027 implementation |
| Retained isolation notes list view-content mismatch, absent guard-composed proof and real approval control refusal | Local `docs/verification/uc03-isolation.md`; `src/persistence/adapters/state-port-v02-admission.ts`, `src/foundation/docker-view-builder.ts`, `src/approvals/control-v02.ts` | T025 coherent view consumption; owner producer/control delivery and original proofs remain external gates |

**Decision**: Amend feature 007, retaining old ledgers and checked controlled evidence. **Rationale**: These are missing US1 integration contracts, not a new product feature. **Alternatives considered**: A separate feature ledger duplicates T011/SC-001 ownership; reopening completed checkboxes erases historical evidence.

**Decision**: Version production graph/agent consumers explicitly and keep legacy entry controlled. **Rationale**: Optional context overloads/duck-typed dual state objects violate the existing migration boundary and do not transport trusted provider context. **Alternatives considered**: A dual-surface reserve wrapper loses atomic owner semantics; reusing the real-provenance v0.1 model avoids rather than meets production admission.

**Decision**: Treat evidence writer/replan/fenced read authority as exact public owner deliveries; build only host observations/adapters. **Rationale**: Missing owner seams are contract/delivery gates, not permission to add a second journal or approval control. **Alternatives considered**: Direct DurableStore/internal journal manipulation, fabricated acknowledgements and opening mock-only approval control would cross ownership or weaken safeguards.

**Decision**: Add no dependencies or production default profile values. **Rationale**: Existing toolchain/contracts suffice for design and controlled tests; pricing/engine/profile/operator setup remains pinned runtime input. This amendment does not revisit provider selection or make current API/pricing claims.
