# Research: UC-03

Date: 2026-10-16. Draft design research against local authoritative sources; no dependency installation or runtime experiment. Sequentially follows the behavioral spec. Read-only research/compatibility agent contributed a source audit; research conclusions below distinguish approved decisions from proposals.

## Workflow and completion

**Decision**: Enforce high-level gates with adaptive investigation, persisted pre-fix baseline, minimal authorized patch, focused/regression verification and distinct read-only review. Proposed state machine in data-model.md defines invalidation and repair routes.
**Rationale**: ADR-0001 and architecture require evidence-backed completion; current context and ADR-0004 specify plan approval, feedback wait and at most three material replans.
**Alternatives considered**: Fixed per-tool scripts suppress adaptation; ungated model-led completion violates harness authority. Generic planning/triage is outside UC-03.
**Authority**: [ADR-0001](../../docs/adr/0001-uc03-scope-and-completion.md), [ADR-0004](../../docs/adr/0004-uc03-adaptive-workflow-and-replan-limit.md), [architecture](../../context/architecture.md). ADR-0004 now records accepted approval-gate decisions and closure on 2026-10-16 (UTC+07:00), integrated from development commit 5a81b3a. Feature artifacts and exact shared bindings still require T001 signoff.

## Execution boundary

**Decision**: Approved host TypeScript/LangGraph, host model credentials/policy/controller, Docker Linux task container with prepared Python/pytest, fresh repo/scratch per new task, retained task identity on resume, network disabled. Structured host-authorized Docker execution; no service.
**Rationale**: ADR-0003. Isolation must be enforced and tested before real execution, including malicious pytest code.
**Alternatives considered**: Podman is not selected; direct host execution, arbitrary shell, runtime package downloads and Docker socket mounts violate accepted boundaries.
**Proposed concrete profile**: Non-root UID, read-only container root, immutable permitted command-view repository and runtime resources, task-specific scratch as the only command-writable mount, no host bind mounts, no socket, dropped capabilities, no-new-privileges, network none, explicit CPU/memory/PID/time/output limits. The canonical repository is writable only through trusted controlled patches without executing repository code. Canonical path checks run inside the same execution boundary and recheck parents/links immediately before access. T001/T006/T024 must select and validate exact Docker flags/image digest/platform enforcement; unsupported hosts refuse execution. The interfaces contract defines protected-path/content exclusion before snapshot admission, byte-identical allowed source, per-command view digests and fail-closed required-file handling; forbidden bytes never enter command views or caches. Malicious pytest must fail to mutate source/tests or read protected data, not merely leave host sentinels intact. This is a design proposal, not isolation evidence.
**Lifecycle proposal**: Host registry maps task ID to container/volume/image identity. Keep canonical workspace identity through UC-04 resume, validate digests/revision and regenerate immutable command views before use, and never reuse writable state for a different task. Retention/cleanup require explicit configured policy selected at T001; unresolved outcomes retain evidence until reconciled.

## Shared contracts and reviewer ownership

**Decision**: Use one versioned port contract for real adapters and deterministic mocks. Tai owns canonical schemas, model/tools/reviewer/evaluation; Thanh Tan persistence/recovery; Trong Tan approval. The reviewer assignment is proposed to close the delegation map's explicit ownership gap; T001 confirms it.
**Rationale**: ADR-0002 allows mocks but requires shared owner agreement and real integration. Copying persistence or policy into UC-03 creates competing authority.
**Alternatives considered**: Fake command success as acceptance, an in-memory production checkpoint store, UC-03-local approval policy and contributor CodeRabbit as runtime review are rejected.
**Approval proposal**: Shared UC-05 action kind `approve_fix_plan` binds the human decision to task, plan version/strategy digest, criteria/check-set, baseline, repo state and policy. This gates edits but does not authorize any tool action. The exact binding must be accepted by Trong Tan at T001; no independent UC-03 decision store.

## Open stack choices resolved for drafting

**Decision**: Keep open choices as explicit selection outputs of T001, behind injected ports. Draft candidate: supported Node LTS, npm lockfile, strict tsc, mechanically enforced lint, runtime behavioral tests plus pytest fixtures, provider adapter with configured model, durable UC-04 checkpoint backend, local JSON adapter and machine-readable evaluation JSON. Candidates are not approved values or installed packages.
**Rationale**: [tech_stack.md](../../context/tech_stack.md) deliberately leaves versions, package/build/lint/test tools, provider, checkpoint backend, isolation configuration, deployment/host support and evaluation format open. Existing helper Node requirements establish none of them. A planning draft can specify checks and ports without asserting approval.
**Alternatives considered**: Silently infer npm/test framework from helpers; select a database on UC-04's behalf; add a web/service framework. All are unnecessary or overstep ownership.
**Decision owners and exit**: Tai selects runtime toolchain/provider/evaluation/platform/profile; Thanh Tan selects storage/checkpointer; Trong Tan agrees action/plan schema. T001 records exact choices and accepted artifact revisions. The user approved Phase 1 bootstrap on 2026-10-16 (Asia/Saigon), with Node 24/npm, strict TypeScript, LangGraph, ESLint and Node tests. Production-only choices remain required before real execution; see [decisions](contracts/decisions.md).

## Budget accounting

**Decision**: Require finite trusted configuration for timeout, output, CPU, memory, process, repair, reviewer, tokens and cost. No production defaults; three material replans is the only established numeric cap. Test fixtures explicitly declare all finite values. Both coder and reviewer host provider requests require stable IDs, conservative token/cost ceilings, atomic durable pre-network reservation through UC-04, observed-usage settlement and retained uncertain charges; telemetry estimates do not authorize spending. T008/T009 own consumer enforcement, with C10/C15 provider-dispatch/restart assertions.
**Rationale**: [runtime policy](../../context/runtime_policy.md) and [state contract](../../context/state_and_memory.md) require fail-closed configuration, durable reservation before effects and no reset on restart. Replan consumption is per material strategy proposal, not per read or wording change.
**Alternatives considered**: Per-run reset, refund unresolved reservations on restart, unlimited fallback and replan resetting repair budgets violate policy. Exact atomic transitions are proposed in contracts/interfaces.md and require UC-04 signoff.

## Constitution and readiness

**Decision**: Report unratified placeholders and retain a T001 governance gate; do not edit/ratify the constitution as part of this request. Draft artifacts are reviewable and complete as proposals, not finalized approved implementation plans.
**Rationale**: Placeholder example principles are not binding law; ADR-0002 explicitly separates specification order and implementation authorization. Requested planning work is authorized now.
**Alternatives considered**: Fabricated constitution pass, invented ADR acceptance dates or halting all mock-capable decomposition would misrepresent evidence.

## Evaluation scope

**Decision**: Public seeded Python bugs and attack repositories; host-private hidden checks; separate agent-visible and grading authority; structured case results and two-run regression comparison. See contracts/acceptance.md.
**Rationale**: Target matrices require actual execution and reproducible outcomes. Contributor helper skills do not establish K2 runtime skill loading, and these UCs do not establish K6 MCP coverage.
**Alternatives considered**: Expanding into runtime skill loading/MCP to claim complete knowledge coverage is outside UC-03. Record these wider-project gaps rather than add unselected use cases.
