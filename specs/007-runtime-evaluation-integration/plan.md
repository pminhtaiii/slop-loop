# Implementation Plan: Observable Python Repair Evaluation

**Branch**: `feat/uc03-evaluation-integration-plan` | **Date**: 2026-11-01 | **Spec**: [spec.md](spec.md)
**Status**: Planning only; [decisions](contracts/decisions.md) govern release.

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
