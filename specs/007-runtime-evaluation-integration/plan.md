# Implementation Plan: Observable Python Repair Evaluation

**Branch**: `feat/uc03-evaluation-integration-plan` | **Date**: 2026-11-01 | **Spec**: [spec.md](spec.md)
**Status**: Original controlled release remains scoped to T001–T011. Host-composition remediation T019–T034 is proposed/planning only; [decisions](contracts/decisions.md) govern release.

## Summary

Add a graph-backed evaluation driver, missing coder generation, real component composition and a local operator console. Gate delivery as controlled evidence, real isolated repair, then interactive operation/comparison. Reuse validators/completion predicates; mock success never establishes real acceptance.

## Technical Context

**Language/Version**: Existing TypeScript/Node/pnpm [stack](../../context/tech_stack.md); target Python/pytest.
**Primary Dependencies**: Existing LangGraph, native fetch for nonstreaming messages, structured spawn for Docker, Node HTTP for loopback console. No new framework/SDK initially.
**Storage**: UC-04 production-compatible state/checkpoint/accounting/evidence delivery; UC-05 decision/policy authority. Existing file-backed candidates are not assumed accepted.
**Testing**: Existing Node source/emitted tests, essential browser journey, real pytest in admitted disposable Linux containers.
**Target Platform**: Trusted local host with Docker Linux engine; Windows/Docker Desktop first candidate. Pin actual engine/platform/image/isolation profile at operator preflight.
**Project Type**: Existing library with CLI and loopback console.
**Performance Goals**: One active experiment, bounded polling/artifacts; no latency SLA or spend optimization.
**Constraints**: [Runtime policy](../../context/runtime_policy.md), [permissions](../../context/tools_permissions.md), [state](../../context/state_and_memory.md), protected-content-excluded read-only command views, no container network/credentials/socket, explicit approval.
**Scale/Scope**: One seeded bug, controlled fault matrix, two compatible attempts, one operator. Full restart/broad acceptance remains separate.

## Constitution Check

Constitution is an unratified placeholder; AGENTS/context/accepted ADRs govern. No artificial constitution pass.

| Gate | Design resolution | Required execution evidence |
|---|---|---|
| Scope | Package, local selector and managed AGENTS pointer only | Separate implementation release |
| Ownership | UC-04 owns state/accounting, UC-05 approval | G-OWNERS exact adapter conformance |
| Spend preference | Derived technical exposure, no user economic cap | G-PROFILE pricing/bounds and ledger compatibility |
| Security | T024/T025 before real mutation; admission before provider dispatch | G-ISOLATION/G-APPROVAL |
| Evidence | Separate controlled/real observations and grading | Same-snapshot evidence and honest coverage |
| Console | Consumer of same service | Bound mutations and protected artifacts |

Post-design: no policy waived. Operator configuration and external deliveries are explicit preconditions, not invented readiness.

## Project Structure

### Documentation (this feature)

`spec.md`, `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, `tasks.md`, `contracts/decisions.md`, `contracts/integration.md`, and `checklists/`.

### Source Code (planned, not current capability)

| Concern | Principal paths |
|---|---|
| Shared experiment service/profile/composition | `src/runtime/evaluation-service.ts`, `evaluation-profile.ts`, `evaluation-composition.ts` |
| Coder/reviewer | `src/uc03/agent.ts`, `src/foundation/reviewer.ts`, existing `src/uc03/graph-nodes.ts`, `graph-types.ts`, `graph-feedback.ts` |
| Real transport/controller | `src/foundation/deepseek-transport.ts`, `docker-controller.ts` |
| Driver/grading/registration | `eval/uc03/workflow-driver.ts`, `workflow-grade.ts`, `registration.ts` |
| Versioned evidence/comparison | Existing `eval/uc03/types.ts`, `validation.ts`, `results.ts`, `runner.ts`, `compare.ts`, `eval/shared-types.ts`, `eval/shared.ts` |
| Operator surfaces | `src/cli/evaluate.ts`, `src/runtime/console-server.ts`, `console-page.ts` |

No production imports from test support. Operator catalog points to ignored local fixtures/grading. No fixture payloads or generated artifacts are published.

## Design and Integration Strategy

1. **Preflight**: Validate trusted case/profile/grader digests, owner versions, image/platform, operational limits and pricing; pin conformance receipts. Separate provider/workspace/approval/grading readiness and refuse affected effects. Never relabel mock adapters as real.
2. **Experiment service**: Allocate attempt/task/workspace via owner adapters; serialize experiments; invoke driver; persist waiting/final views and safe artifacts. Accept immutable catalog bindings or typed custom public bug submissions against configured repositories/check sets; custom runs stay exploratory/ungraded. Persist incomplete intake without creating an executable task. Record bound clarification answers as reporter data and forward explicit resume/revise/end to UC-05 control to obtain direction receipts; answers/feedback/decision recording do not silently resume. CLI/console share this service. Continuation preserves budgets; a new explicitly requested experiment receives fresh task/workspace.
3. **Coder**: Investigate with admitted evidence/tools and baseline; call the model through v0.2 admission and validate structured plan. After explicit approval, generate patch under that strategy and obtain exact owner-issued patch admission. Repair/replan use the same generator/limits. Supplied solutions remain explicit controlled mode only.
4. **Provider/reviewer**: Host-only user-selected DeepSeek Flash, Anthropic-compatible messages, thinking disabled, strict JSON text proposals, no server tools/streaming/automatic retry. Harness executes allowed actions. Reviewer has fresh read-only context, charged requests and existing finding/line validation. Preserve requested/returned model identity and uncertainty.
5. **Tools**: Implement missing Docker controller behind existing workspace/executor/repository boundaries. Trusted canonical patch writes only; pytest sees admitted read-only view/scratch. Independent grader uses separately isolated final snapshot. T024/T025 remain mandatory proofs.
6. **Evaluation**: Add `uc03-workflow-evaluation/1` via existing `runEvaluation` and registered UC-03 suite; legacy v0.1 stays readable/mock-only. Real capability requires trusted receipt, not a provenance string. Preserve UC-01 behavior; no blanket removal of real refusal. See [contract](contracts/integration.md).
7. **Diagnostics/comparison**: Join authoritative state/effect/accounting receipts and safe milestones; preserve unknown attribution. Separate selection/suite coverage. Compare only under the contract's full compatibility guards, with explicit changed config; do not infer statistical quality from two attempts.
8. **Console**: Node loopback HTTP, one session, exact Origin/Host checks, session token, bound/idempotent mutations, escaped DOM text, bounded polling/artifact IDs. Catalog selection and custom bug forms have distinct provenance; clarification answers and explicit controls have distinct operations. UC-05 safe presentation supplies approval content. Browser never grants authority or edits environment.

## Operational Profile Proposal

Reviewable local profile, not approved production defaults: 24 total coder+reviewer calls; 32,768 input/8,192 output tokens per request; 60s provider timeout; 15 minutes active execution excluding human wait; two repairs; two reviewer iterations; three material replans; 30s commands; 1 MiB output; 2 GiB memory, 2 CPUs, 64 processes. Values are explicit trusted configuration; absent/invalid limits deny corresponding actions. Operator supplies credentials, actual image digest/platform and pricing, without a chat interview.

`spendPolicy = derived-exposure`: no user monetary budget. Compute finite task/run dollar ledger ceilings sufficient for every permitted call from conservative billable bounds and pinned highest applicable input/output/cache/overhead rates. Round upward in integer micro-USD, detect overflow, expose derivation. Retain reservation/settlement/uncertainty; no infinity, arbitrary huge sentinel, low hidden cap or replenishment. Changed configuration creates a new experiment; same-task increases use existing explicit authorization. Unsupported billable bounds/pricing deny real dispatch.

## Existing Task and External Dependency Mapping

| Existing owner/task | Required evidence | This package adds |
|---|---|---|
| UC-03 T026/T066 | Close current workflow/admission gaps on pinned candidate | Driver/generation/evidence projection |
| UC-03 T024 | Actual hostile-pytest/view/network/resource/sentinel containment | Controller/profile consumed by that proof |
| UC-03 T025 | Actual UC-05 decisions with UC-04 backing | Operator continuation through accepted gate |
| UC-03 T028 | Actual C01/C02/C16/provider accounting acceptance | Evaluate that route; criteria in both ledgers remain binding |
| X04-STATE/X05-GATE | Owner-agreed production-compatible deliveries/public seams | Consumption, no duplicate storage/policy |
| T029–T033/restart gates | Later broad repair/security/restart/full acceptance | Outside first-case claim |

## Complexity Tracking

No new workflow engine, storage system, generic provider layer or frontend framework. Versioned report is needed because old reports assert mock-only verification. Shared experiment service prevents duplicate CLI/UI authority/effects.

## Targeted Host-Composition Plan — 2026-11-04

**Planning branch/base**: `feat/uc03-host-composition-plan`, development `d2f953239b658b2b282d9e41523e819d9785fd49`. Sources match the investigated `67646d8` candidate for `src/` and `specs/`; this is source inspection, not fresh runtime acceptance. Template resolution and setup reuse this feature; original task IDs and checked evidence remain intact.

### Design choices and boundaries

Use explicit versioned production graph/coder entry types and migrate production consumers to v0.2. Retain the existing v0.1 controlled entry and tests until the new route has conformance coverage. No dual-surface production object, optional-context overload, cast to v0.1, fallback `reserve`/`settle`, or provenance relabel closes a gap. The proposed additive host supplement in [host-composition](contracts/host-composition.md) requires owner review before implementation; canonical owner APIs are not amended by this planning request.

The host bootstrap consumes pinned owner deliveries and constructs only Tai-owned foundation/host components. UC-04 supplies durable baseline evidence, current task/control/accounting authority and atomic replan acceptance. UC-05 supplies real policy/approval presentation, decision, control and continuation capability. Existing local durable adapters/recovery helpers are candidates, never proof of these deliveries. The approval controls' non-mock refusal remains intact until UC-05 separately releases a conforming real path.

### Execution order

1. **T019 contract prerequisite**: obtain review/signoff of the exact supplemental capabilities, owner revisions and migration boundaries. This is a future release prerequisite, not signoff claimed by independent contributor review. A changed public owner contract receives targeted owner amendment/review first.
2. **T020–T025 foundations**: typed versioned production seams; read mediation; trusted snapshot producer; durable evidence consumer; observed action context; coherent command-view identity. Controlled test deliveries are permitted only after explicit implementation release and stay labeled controlled. Owner adapters remain external prerequisites.
3. **T026/T034/T027 consumer migration**: coder forwards full provider context and loops through bounded inspect observations into freshly admitted next turns; clarification/stop have explicit outcomes. Reviewer T034 uses the canonical model ingress instead of raw transport. Only HostModelPortV02 claims/begins/settles each coder/reviewer provider attempt; graph nodes do not preclaim. Coder run-check obtains per-check repository admission. Repair retains exact current receipts. Material replan uses an explicit owner transaction, never legacy reserve mapped to a provider/repository claim.
4. **T028 bootstrap**: validate pinned identities and every required capability, then construct Foundation ports, explicit graph config/resolvers and a side-effect-free readiness result. Only admitted execution allocates/initializes the workspace via existing service lifecycle; assembly/preflight performs no provider call, command, patch or task mutation.
5. **T029 CLI wiring / T030 controlled proof**: trusted operator bootstrap, actual graph/evaluator, explicit pause/control/continuation, fault matrix and source/emitted conformance. This is the smallest controlled integration milestone; it is not SC-001.
6. **T031 correction handoff**: record exact closure evidence for the new criteria and cross-reference original UC-03 findings; do not change old ledger status without its own acceptance evidence. T011 then requires fresh G-OWNERS/G-PROFILE/G-ISOLATION/G-APPROVAL/G-ROUTE and separately authorized execution before one actual successful repair can satisfy SC-001. Console/restart/full-suite remain separate.

### Planned paths

| Concern | Principal source/test paths |
|---|---|
| Versioned production surface | `src/uc03/graph-types-v02.ts`, `graph-v02.ts`, `agent-types.ts`, `graph-generation.ts`; `tests/runtime/contract/uc03-production-ports.test.ts` |
| Read and snapshot producers | `src/foundation/guarded-read-capability.ts`, `src/runtime/trusted-host-snapshot.ts`; matching unit tests |
| Owner evidence consumption | `src/runtime/baseline-evidence-adapter.ts`; `tests/runtime/contract/baseline-evidence-adapter.test.ts` |
| Observed actions and view identity | `src/runtime/host-action-context.ts`, `src/foundation/docker-view-builder.ts`; matching contract/unit tests; UC-04 supplied view facts |
| Consumer migration | existing `src/uc03/agent.ts`, `graph-generation.ts`, `graph-nodes.ts`, `graph-feedback.ts`, `investigation*.ts`, `verification*.ts`, `replan.ts`, `repair.ts`; focused route tests |
| Assembly and CLI | `src/runtime/uc03-host-bootstrap.ts`, `evaluation-composition.ts`, `src/cli/evaluate.ts`, `src/cli/uc03.ts`; bootstrap, CLI and integration tests |

No new dependency or persistence engine. Exact owned paths and serialization are in tasks.md. Pre/post-design governance check: placeholder constitution stays unratified; owner, production profile and real-execution prerequisites remain gates. Planning quality may pass while runtime readiness remains denied.

T033 binds a retained immutable initial repository tree and its admitted-file manifest, distinct from durable verification evidence. It supplies original source bytes across continuation. T032 uses that source to implement the concrete read-only `inspectDiff` producer currently stubbed in ControlledRepositoryTools. Both join bootstrap T028 through T032; T034 reviewer ingress precedes shared route migration T027. Task numbering preserves the appended ledger history rather than implying execution order. Diff measurement must be current, complete, bounded and protected-content-safe before review/grading can work.
