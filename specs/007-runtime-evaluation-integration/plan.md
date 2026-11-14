# Implementation Plan: Observable Python Repair Evaluation

**Branch**: `feat/uc03-evaluation-integration-plan` | **Date**: 2026-11-01 | **Spec**: [spec.md](spec.md)
**Status**: Original controlled release remains scoped to T001–T011. Host-composition remediation T019–T034 completed its planning step and was then separately released for source/controlled-tier implementation on 2026-11-04; [decisions](contracts/decisions.md) govern release and supersede the planning-only status this plan was authored under.

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

Use explicit versioned production graph/coder entry types and migrate production consumers to v0.2. Retain the existing v0.1 controlled entry and tests until the new route has conformance coverage. No dual-surface production object, optional-context overload, cast to v0.1, fallback `reserve`/`settle`, or provenance relabel closes a gap. The proposed additive host supplement in [host-composition](contracts/host-composition.md) required owner review before implementation and received the recorded T019 agreement plus the separate source/controlled release; canonical owner APIs are not amended by this planning request.

The host bootstrap consumes pinned owner deliveries and constructs only Tai-owned foundation/host components. UC-04 supplies durable baseline evidence, current task/control/accounting authority and atomic replan acceptance. UC-05 supplies real policy/approval presentation, decision, control and continuation capability. Existing local durable adapters/recovery helpers are candidates, never proof of these deliveries. The approval controls' non-mock refusal remains intact until UC-05 separately releases a conforming real path.

### Execution order

1. **T019 contract prerequisite**: obtain review/signoff of the exact supplemental capabilities, owner revisions and migration boundaries — recorded in [decisions](contracts/decisions.md) as one delegated attestation covering the three lanes, with pinned owner revisions still absent. This was a pre-implementation prerequisite, not signoff claimed by independent contributor review. A changed public owner contract receives targeted owner amendment/review first. The 2026-11-07 clarification and isolation-binding amendments ([host contract](contracts/host-composition.md) §8–9) are both of that kind: they arrive through targeted review before T025/T026 change code.
2. **T020–T025 foundations**: typed versioned production seams; read mediation; trusted snapshot producer; durable evidence consumer; observed action context; coherent command-view identity. Controlled test deliveries are permitted only after explicit implementation release and stay labeled controlled. Owner adapters remain external prerequisites. Amendment §9 finishes the command-view identity by issuing the owner-measured isolation record instead of accepting a caller reference.
3. **T026/T034/T027 consumer migration**: coder forwards full provider context and loops through bounded inspect observations into freshly admitted next turns; clarification/stop have explicit outcomes. Amendment §8 supplies the persisted clarification record, the two guarded transitions and the answer-bound continuation input those outcomes need. Reviewer T034 uses the canonical model ingress instead of raw transport. Only HostModelPortV02 claims/begins/settles each coder/reviewer provider attempt; graph nodes do not preclaim. Coder run-check obtains per-check repository admission. Repair retains exact current receipts. Material replan uses an explicit owner transaction, never legacy reserve mapped to a provider/repository claim.
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

## Source/controlled completion — 2026-11-12

Follow [completion](contracts/completion.md) for targeted coder/replan/loop/host/evidence/control corrections and their acceptance seams. Execute T026, then T027, T028, T029, the integrated T030/T014 controlled matrix, and T031. Preserve original real acceptance tasks and gates. Existing approved artifacts govern all unaffected behavior.

## Real-tier prerequisite plan — 2026-11-14

**Branch/base**: `feat/uc03-real-tier-prerequisites` at `c1eba127` (`origin/development` `6c9ee150` plus the release entry). **Authority**: the [decisions](contracts/decisions.md) entries "Real-tier prerequisite release — 2026-11-14" and "Real-tier operator decisions — 2026-11-14". Planning is released now; T040–T060 are released for implementation only after automated validation and both independent planning lanes pass. Contract: [real-tier](contracts/real-tier.md).

### Design choices and boundaries

- **Owner lanes.** Coordinator workers build the missing UC-04 surfaces on the existing `DurableStatePortV02` and durable store: read fencing, exact-operation lookup, baseline evidence store, approval-store interop fixes, authority publication/recovery admission, and the material replan transaction. They also build the missing UC-05 pieces, reusing `src/approvals/`: real-journal acceptance for control/continuation and a production `ConsoleApprovalPort`. They implement the T019-agreed surfaces unchanged. They are not Thanh Tan's or Trong Tan's deliveries, and G-OWNERS stays single-attested. By the user's decision, they count toward X04-STATE/X05-GATE for these evidence runs only, and every UC-03 acceptance entry must say so.
- **Real provenance by construction, not declaration.** A component counts as real only when a module-private brand proves that the production factory built it (`isDeepSeekTransport`; the new dependency-neutral `src/foundation/production-journal-registry.ts`, registered only by the `DurableStatePortV02` constructor, so `src/approvals/` never imports persistence and the module graph stays acyclic). A declared `provenance: 'real'` string is not enough.
- **G-PROFILE.** The operator profile lives outside every checkout and is named by `UC03_REAL_TIER_PROFILE`; the credential comes only from `ANTHROPIC_API_KEY`. The image is built from a digest-pinned base, and runs reference it by content-addressed image ID with `--pull=never`. The Docker CLI child gets a minimal environment.
- **Operator-pinned endpoint.** The user's model is self-hosted behind an Anthropic-compatible endpoint (`ANTHROPIC_BASE_URL`, an `http://<host>:<port>/v1` base) with model `po/deepseek-ai/deepseek-v4.1-flash-1017`. The transport's hard-coded endpoint and the profile's `endpointOf` both become operator-pinned. That means an exact `<base>/messages` URL plus model id, read from the profile or the environment at assembly, validated, frozen and compared exactly on every call. `api.deepseek.com` stays the default when no endpoint is set. A non-`https` endpoint loads only with the explicit `allowInsecureHttp: true` acknowledgement; the contract recommends TLS or an SSH tunnel. No tracked file may contain the real host, port or URL; evidence records only `endpointDigest` and the scheme.
- **No economic cap.** FR-006 stands. T049 adds only a runaway stop (per-run call and token limits enforced before dispatch, failing closed) and reports cost as an `estimate-unverified` (or `unknown`) figure from a placeholder table, never as zero.
- **Assembly.** `src/runtime/real-tier-assembly.ts` exports the `createHostAssembly()` factory that the existing CLI loader imports, so `prepareUC03Host` can return `ready` from real deliveries. T060 adds a validated `metadata` projection and an operational Docker `preflight` member to the resolution, both integrated into `evaluate preflight/run` after `src/cli/evaluate.ts` is split into `evaluate-host.ts` (contract §(i)).
- **Evidence runs.** T024 and T025 make zero model calls, and T026/T066 run at controlled tier. T028 drives `runUC03GraphV02` plus the independent snapshot grader, not the evaluation service, so no T011 run happens. It runs as one guarded `--campaign` invocation (preflight → conformance → cases) whose conformance receipt binds any later `--case` (T059). Real-tier runners use non-`.test` file names, so CI never runs Docker or live calls.

### Execution order

1. Phase 14 owner lanes: T040, T041 and T042 in parallel, then T043 and T044, then T045 and T046.
2. Phase 15 profile, image, endpoint and runaway stop: T047, T048 and T049, in parallel with Phase 14.
3. Phase 16 assembly: T058 (uncertainty gate, after T040/T041/T044), then T050, then T060 (CLI metadata and Docker preflight). T057 (endpoint scanner) follows T047.
4. Phase 17 evidence, serialized: T051 (T024), T052 (T025), T053 (T026) and T056 (T066), both controlled and able to start after T044/T040; T059 (T028 runner and gate, controlled); then T054 (T028, live calls).
5. Phase 18 context refresh: T055.
6. Later and separately released: T011 (G-REAL/SC-001), T014's real half, T017, G-RESTART, merge and T039.

### Planned paths

| Concern | Principal paths |
|---|---|
| UC-04 owner lane | `src/persistence/adapters/state-port-v02-read-fence.ts`, `state-port-v02-operation-lookup.ts`, `baseline-evidence-store.ts`, `approval-store-adapter.ts`, `state-port-v02-authority.ts`, `material-replan-port.ts`; `tests/runtime/uc04/*` |
| UC-05 owner lane | `src/approvals/journal-acceptance-v02.ts`, `control-v02.ts`, `recovery-v02.ts`; `src/runtime/console-approval-port.ts` |
| Profile, image, endpoint, runaway stop | `src/runtime/real-tier-profile.ts`, `docker/uc03/Dockerfile`, `src/foundation/docker-controller-argv.ts`, `docker-spawn.ts`, `deepseek-transport.ts`, `src/runtime/evaluation-profile-primitives.ts`, `src/foundation/run-usage-limit.ts` |
| Assembly, recovery, CLI | `src/runtime/real-tier-assembly.ts`, `real-tier-owners.ts`, `real-tier-recovery.ts`; `src/cli/evaluate.ts`, `evaluate-host.ts`; `src/foundation/docker-readiness.ts`, `production-journal-registry.ts` |
| Privacy scanner | `src/runtime/real-tier-endpoint-scan.ts`, `src/cli/real-tier-scan.ts` |
| Evidence | `tests/runtime/security/uc03-real-containment-probe.ts`, `tests/runtime/integration/uc03-approvals*.ts`, `uc03-success-real-*.ts`, `uc03-success-real-run-gate.test.ts`, `real-tier-uncertainty.test.ts`; new focused `tests/runtime/unit/uc03-graph-gaps.test.ts` and `tests/runtime/contract/atomic-admission-matrix-gaps.test.ts` (the oversized legacy files are read-only) |

No new dependency, framework, persistence engine or spend ledger. Governance check: no policy is waived. The cleartext-endpoint risk is an explicit operator acknowledgement, not a waiver, and the constitution remains a placeholder.
