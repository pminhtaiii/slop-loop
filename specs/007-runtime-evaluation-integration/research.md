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

## Real-tier prerequisite research — 2026-11-14

Inspection at `c1eba127`; the evidence-backed gap inventory is in [real-tier contract](contracts/real-tier.md) §(a). No test, container or provider call was run for this research, and no web source was fetched. The pricing and model statements below are therefore planning defaults for the operator to confirm, not observations.

### Image base

**Decision**: Keep `python:3.12-alpine`, pinned by digest through a required `ARG PYTHON_BASE`, and install pinned `pytest==8.3.4` and its dependencies at build time. The run-time identity is the built image ID, referenced with `--pull=never`.
**Rationale**: The existing Dockerfile and probe already target this base and the `1000:1000` user, and pure-Python pytest has no musl concern. The built image digest pins every installed byte, so per-package hashes add little. Docker's `name@digest` form needs a registry RepoDigest, which a locally built image does not have; the content-addressed image ID needs no registry.
**Alternatives considered**: `python:3.12-slim` (glibc, larger; adopt only if a case needs compiled wheels). Hash-pinned `--require-hashes` requirements (rejected: the final image ID is the identity that runs). Pushing to a loopback `registry:2` to obtain a RepoDigest so the current `${image}@${digest}` form works unchanged (adds a second unpinned image and a running service; kept as the fallback if referencing by image ID is rejected).

### Pricing source and table

**Decision**: The profile carries integer micro-USD rates per 1,000,000 tokens with a mandatory `source` (DeepSeek's official pricing page) and `retrievedOn`. The default is a conservative placeholder: 2 USD/1M input, 2 USD/1M cache-hit (no discount assumed), 8 USD/1M output, zero overhead.
**Rationale**: The 2026-11-01 research forbade copying a permanent price (`research.md:32`), and nothing can be fetched in this planning session. A placeholder believed to be above the published rates keeps the guard conservative. The operator may replace a rate only with an official figure that is not lower than the published one.
**Alternatives considered**: Hard-coding current published prices (stale by design); a multiplier over official prices (adds a knob without improving safety).

### Budget default

**Decision**: Campaign total 10.00 USD; per run 2.50 USD and 400,000 input / 80,000 output tokens; per call 32,768/8,192 tokens; 24 calls per run.
**Rationale**: T024, T025 and T026/T066 need no paid calls. T028 needs one conformance call, at most two C01 attempts and one C02 attempt. At placeholder rates, one full-bound call reserves 0.197 USD, so the 2.50 USD per-run cap always leaves room for the next call while observed spend stays small. The 10.00 USD total covers the planned runs, with headroom for one failed C01 attempt. The user can change any value; the coordinator records the final numbers in the decision record before T054.
**Alternatives considered**: No cap (contradicts the 2026-11-14 release); per-run caps only (cannot bound repeated runs); a much lower total such as 2.00 USD (risks stopping C01 mid-run at placeholder rates).

### How paid calls are counted

**Decision**: One paid call is one `fetch` to the pinned endpoint. A durable `reserve` record precedes it and a `settle` record follows: `observed` only for a validated 2xx response with usage, otherwise `uncertain` at the full bound. A reservation that is never settled stays charged. A missing or unreadable ledger refuses dispatch.
**Rationale**: This follows the existing reservation/uncertainty accounting (`specs/001-verified-code-repair/contracts/decisions.md:135`), and unknown cost is never zero. Error responses may be free in practice, but nothing in our evidence proves it.
**Alternatives considered**: Settling from provider-side billing (unavailable to the harness); releasing reservations after a timeout (could undercount real spend).

### Other decisions

- **Profile location**: outside the repository (`%USERPROFILE%\.slop-loop\uc03-real-tier\`), named by `UC03_REAL_TIER_PROFILE`; in-repo paths are refused. An ignored directory such as `.agent-work/` was rejected because agent-dump cleanup could delete the budget ledger and silently reset spend.
- **T028 runner, not the evaluation CLI**: running `evaluate run` for C01 is the T011 path, which is not released. The runner drives `runUC03GraphV02` and the independent snapshot grader directly; T011 can later consume or rerun this evidence under its own release.
- **Real-tier runners outside CI**: `scripts/ci/run-runtime-tests.mjs:20-21` globs `*.test.*`, so Docker and paid runs use `*-probe.ts`/`*-run.ts`/`*-evidence.ts` names. T025's `.test.ts` file stays CI-safe, with no Docker or provider.
- **UC-05 profile id literal**: `PolicyProfile.profileId` is typed `'uc05-local-v1'`. The real-tier policy keeps that literal and differs by `profileVersion`, which avoids a UC-05 contract amendment.
- **Model id**: `deepseek-flash`, as recorded (`contracts/decisions.md:7,50`). The T054 conformance call verifies it; if the endpoint refuses it, the campaign stops for user direction.
- **Docker CLI environment**: `structuredSpawn` currently inherits the full host environment (`src/foundation/docker-spawn.ts:37`). T048 adds an allowlist, so the credential never reaches the Docker CLI process.
