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
