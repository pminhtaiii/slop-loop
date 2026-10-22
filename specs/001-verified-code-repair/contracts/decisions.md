# Contract and Architecture Decisions: UC-03 Verified Code Repair

## Metadata and Provenance
- **Date**: 2026-10-16 (Asia/Saigon, UTC+07:00)
- **Feature**: UC-03 — Verified Code Repair (`specs/001-verified-code-repair/`)
- **User Confirmation Provenance**: Confirmed directly by the user on 2026-10-16 in Asia/Saigon. The user confirmed that shared use-case owners (UC-04, UC-05) agreed to the current contract v0.1 definitions, and explicitly approved the bootstrap stack while confirming the scope amendment to defer finite production configuration choices until before real execution.
- **Scope**: Phase 1 setup (T001 / T002 release). This document satisfies T001. Later implementation phases and real execution remain gated.

## Phase 2 Authorization

On 2026-10-16 (Asia/Saigon), the user authorized the next phase of the first specification: Phase 2, T003 canonical contract validators/conformance vectors and T004 controlled test-only port mocks. The integration branch is `feat/001-verified-code-repair-phase2`, created from the latest `origin/development`. The user approved using Gemini 3.8 Flash High with scoped repository content for small implementation assignments and requested independent GPT-6.1-Sol low-reasoning reviews. This contributor model selection does not select a production runtime provider. Phase 3 onward, real repository execution, and the deferred production choices remain separately gated. Existing accepted contract semantics and external ownership are unchanged.

## Phase 3 Authorization

On 2026-10-18 (Asia/Saigon), the user authorized the next phase of the first specification, Phase 3 (T005–T014), and confirmed creating a fresh branch after pulling current changes. Integration uses `feat/015-uc03-success-boundaries`, based on `origin/development` at `dba1e4cce38d1ee782872aaa08444e9e43e3b9cc`. Implementation uses small Gemini 3.8 Flash High assignments, independent GPT-6.1-Sol low-reasoning review, and Gemini follow-up repairs. This authorizes the specified injected boundaries and fixtures, not real repository execution, production provider selection, or Phase 4 onward. T024/T025/T028 and deferred production choices remain gates before real execution.

## Phase 5 Authorization

On 2026-10-22 (Asia/Saigon), the user authorized Phase 5 (T019–T025) of the first specification and selected a fresh feature branch from fetched `origin/development`, preserving existing local work. Integration uses `feat/uc03-controlled-execution-phase5` from `1c154c2b87694501b47c7013839dfe20c890ce2b`. Implementation uses Gemini 3.8 Flash High, independent GPT-6.1-Sol reviews, and GPT-6-Luna with max reasoning for review corrections. These are contributor models, not production provider selections. T019–T023 can proceed against the accepted controlled contracts. T024–T025 remain dependent on actual X04-STATE/X05-GATE adapters and explicit concrete isolation/platform configuration; this authorization does not fabricate their delivery or waive real-only acceptance. Phase 6 and deferred production choices remain separately gated.

## Atomic Admission Amendment Approval and Task Preparation

On 2026-10-22 (Asia/Saigon), after independent standards and testability reviews found no blocking issues in `612cadd` (integrated as `5af410d`), the user confirmed that Thanh Tan (UC-04) and Trong Tan (UC-05) had agreed to the reviewed [atomic admission amendment](atomic-admission-amendment.md). The user then explicitly approved the design and preparation of scoped implementation tasks. This records user-relayed owner agreement, not direct owner messages or delivered adapters. The approved design assigns durable journal/claims/accounting to UC-04, current policy and approval authority to UC-05, and one admitted effect attempt to the shared guard/executor boundary. Task preparation must preserve the amendment's versioned migration, branch-specific receipts, observed-unsettled recovery and fail-closed requirements. Canonical implementation release remains a separate scoped step after task decomposition and planning review; T022 remains incomplete. Real adapters, production choices, real containment and Phase 6 execution are not released by this approval.

## Contract v0.1 Baseline Hashes
The contract v0.1 baseline is commit `04f3747`, consisting of the core specification, shared data model, and shared interfaces. The hashes below identify that baseline, not later authorization-wording amendments in spec.md. All mocks (T004) and future real adapters (T025, T028, T030, T032) must conform strictly to these accepted schemas and interfaces:
- `specs/001-verified-code-repair/spec.md`:
  - **Git Object ID**: `46e85eb34ed9a5db32174db43564b8116a05ec24`
  - **SHA-256**: `674F63855D393C71C481BFFA46F321C5D70291DC458FA113CB8FCA900E7F4F23`
- `specs/001-verified-code-repair/data-model.md`:
  - **Git Object ID**: `93bbe7c60bd22e64e3daaf69c98173232b5f9b4f`
  - **SHA-256**: `897FB6E80AAD39A7176A31430A55B074BDEE9EF4C6E2AAE7A209FCE2EDFE9E86`
- `specs/001-verified-code-repair/contracts/interfaces.md`:
  - **Git Object ID**: `460437757d3cb439d7b83365ae10bc8a6b7ca726`
  - **SHA-256**: `E2523F48E0ED72A0215B5DE54F2E0CB83B738824D84C7E4A324B4B29370F5602`

## Shared Ownership and Responsibilities
Shared path and capability ownership is agreed across the three cooperating use cases:
1. **Tai (UC-03 Lead & Shared Foundation)**:
   - Responsible for UC-03 repair orchestrator, intake, investigation, repair, verification, and reporting (`src/uc03/`).
   - Responsible for shared foundation ports and implementations: canonical contracts and runtime validators (`src/contracts/foundation/uc03.ts`), model boundary (`src/foundation/model.ts`), Docker workspace lifecycle and command executor (`src/foundation/docker-workspace.ts`), controlled repository tools (`src/foundation/repository-tools.ts`), execution guard composition (`src/foundation/execution-guard.ts`), and sanitized telemetry (`src/foundation/telemetry.ts`).
   - **Reviewer Responsibility**: Tai formally accepts ownership of the shared runtime read-only reviewer component (`src/foundation/reviewer.ts`), resolving the ownership gap identified in the delegation map. The runtime reviewer is an automated, read-only evaluation agent running against diffs and bounded evidence, completely distinct from repository PR review tools (e.g., CodeRabbit).
2. **Thanh Tan (UC-04 Lead — Persistence & State)**:
   - External dependency providing durable state, checkpoints, and budget ledger (`src/persistence/`).
   - Owns `StatePort` contract compliance, atomic multi-budget reservation and settlement, uncertain-effect/usage reconciliation, and preservation of canonical workspace identity across process resumes.
3. **Trong Tan (UC-05 Lead — Approvals & Policy Gate)**:
   - External dependency providing policy classification and human approval gating (`src/approvals/`).
   - Owns `ApprovalPort` contract compliance, action classification (allowed, approval-required, forbidden), durable pending approval tracking, and fix-plan approval binding.

## Governance and Constitutional Status
- Governance of this feature is anchored in authoritative repository instructions (`AGENTS.md`), project context documents (`context/`), and accepted Architectural Decision Records:
  - [ADR-0001](../../../docs/adr/0001-uc03-scope-and-completion.md): UC-03 Scope and Completion Evidence.
  - [ADR-0002](../../../docs/adr/0002-uc03-specification-order-and-shared-dependencies.md): Specification Order and Shared Dependencies.
  - [ADR-0003](../../../docs/adr/0003-docker-task-workspace-boundary.md): Docker Task Workspace Boundary.
  - [ADR-0004](../../../docs/adr/0004-uc03-adaptive-workflow-and-replan-limit.md): UC-03 High-Level Gates with Adaptive Execution and Replan Limit (initial discussion accepted October 15; approval-gate decisions and closure confirmed October 16, Asia/Saigon).
- **Constitutional Status**: `.specify/memory/constitution.md` remains an unratified placeholder template. In accordance with ADR-0002 and repository policy, this feature does NOT assert an artificial constitution pass or claim ratification of placeholder text. Governance strictly adheres to AGENTS.md, context rules, and accepted ADRs.

## Exact Fix-Plan Approval Binding and Material Replan Semantics
Preserving the decisions in ADR-0004 and `contracts/interfaces.md`:
1. **Pre-Edit Gate & Human Plan Approval**:
   - Investigation is bounded to permitted reads, search, reproduction commands and policy-compliant new regression tests.
   - Before applying any production code edits, the agent must persist baseline evidence, acceptance criteria, required checks, diagnosis, and a proposed fix plan.
   - The diagnosis and fix plan must receive explicit human approval through UC-05 (`approve_fix_plan` action kind). Automatic plan approval is prohibited.
   - Approval binds: task ID, workspace/repository revision digest, planVersion, strategy digest, diagnosis/baseline evidence references, criteria/check-set digest, and policy version.
   - Adding a new regression test during investigation to demonstrate pre-fix failure is permitted under test-protection policy; if it alters repository state, the plan binds to that updated baseline.
2. **Material Replan Limit and Semantics**:
   - A task is capped at **at most three material replans** after the initial plan.
   - A material replan is defined as a substantial shift in the recorded fix strategy or root-cause diagnosis in response to new evidence or failed repair verification.
   - Minor implementation adjustments, additional code reads, searches, or wording clarifications within the approved strategy do not consume a replan slot. Changed repository state still requires action-binding reevaluation and invalidates affected verification/review evidence; only unchanged material fields preserve the relevant binding.
   - Each material replan creates a new proposal ID, consumes one of the three task-scoped replan allowances, invalidates prior edit authorization, and requires renewed human approval via UC-05.
   - Human approval or run restart does not reset or replenish the replan allowance.
   - Upon encountering a fourth required material replan, the agent must halt execution, fail closed, and report an incomplete outcome and blocker.
3. **Plan Rejection**:
   - If the human rejects a proposed plan, the agent must enter an `await-feedback` state and pause. Autonomous generation of alternate unsolicited plans is strictly prohibited.
   - The human may provide guidance/clarification or terminate the task. If the human directs a material strategy change, that revised plan consumes one of the task replan allowances.

## Atomic Provider Budget Reservation and Uncertain Usage Accounting
In accordance with the host-provider budget protocol defined in `contracts/interfaces.md`:
1. **Scope and Budget Protocol**:
   - Applies to all host-side LLM calls made by both the coder (`ModelPort` via T008) and the reviewer (`ReviewerPort` via T009).
   - Neither coder nor reviewer models execute within the untrusted Docker task container; credentials and provider calls remain host-contained.
2. **Request Envelope and Ceilings**:
   - Every provider request is assigned a stable internal `providerRequestId` bound to task ID, run ID, role (`coder` or `reviewer`), call purpose, provider/model identity, pricing-policy identity, and an approved-context digest. This does not imply provider-side idempotency; that requires separate supported and evidenced behavior.
   - Each call requires finite, conservative ceilings for input tokens, output tokens, and maximum billable cost (accounting for provider-specific overhead, reasoning tokens, and cache fees). Reviewer calls also require an iteration allowance.
   - Missing, exhausted, or unbounded allowances result in **zero network dispatch** (immediate fail-closed denial).
3. **Atomic Pre-Dispatch Reservation**:
   - Before initiating any network dispatch to an LLM provider, all applicable token and cost bounds (plus reviewer iteration) must be durably and atomically reserved in UC-04's ledger via `StatePort`.
   - Partial reservation is treated as an atomic failure: no provider call is made.
   - Telemetry estimates or client-side projections cannot authorize spending; the durable ledger is authoritative.
4. **Usage Settlement and Interrupted Calls**:
   - Upon response arrival, observed billable usage is validated and settled atomically with `StatePort` against the recorded pricing configuration, even if the model output is malformed, schema-invalid, or rejected.
   - In the event of network timeout, crash, process interruption, or unverified response status, the request outcome is marked `uncertain`.
   - The conservative reserved allowance remains charged against the task ledger. It is **never** refunded automatically, released blindly, or replayed without explicit reconciliation by UC-04's recovery protocol (`X04-STATE`).
   - If reconciliation cannot verify that the request failed prior to provider billing, the conservative charge is retained. Unknown accounting halts further constrained dispatches.

## Scope Amendment and Bootstrap Stack Selection
Per user confirmation on 2026-10-16 (Asia/Saigon), a scope amendment is in effect for Phase 1:
1. **Bootstrap Stack Selection (Authorized for T001/T002)**:
   - **Runtime**: Node.js 24 LTS.
   - **Package Manager**: pnpm 12.5.1 with frozen lockfile (`pnpm-lock.yaml`), per the user's package-manager amendment after initial Phase 1 publication.
   - **Language**: TypeScript with strict mode compilation (`tsc`).
   - **Orchestration**: `@langchain/langgraph` (official package).
   - **Linter**: ESLint with `typescript-eslint` (strictly enforced mechanical linting); no formatter is selected.
   - **Test Runner**: Built-in Node test runner (`node --test`) for runtime unit, contract, and smoke testing.
   - T002 now pins pnpm 12.5.1, TypeScript 6.0.3, ESLint 10.12.0, typescript-eslint 8.71.2, @types/node 24.19.2, @langchain/langgraph 1.5.0 and its @langchain/core peer 1.2.17 in package.json/pnpm-lock.yaml. TypeScript 6.0.3 satisfies the linter peer range (<6.1); latest TypeScript 7 was not selected. CI reads the pinned pnpm version from package.json. Runtime tests execute compiled JavaScript after the build.
   - **Declaration-check limitation**: `skipLibCheck: true` avoids verified third-party declaration errors under `exactOptionalPropertyTypes` in LangChain/LangGraph/langsmith. Repository TypeScript retains strict checking, including implicit-any rejection. Reevaluate this exception when those dependencies change.
2. **Deferred Production Choices (Mandatory Release Gates Before Real Execution)**:
   - The user explicitly approved deferring finite production configurations. These choices are **not** blockers to the Phase 1 build bootstrap (T002), but remain strict prerequisites before any real workflow execution (T024, T028+).
   - Production choices that must not be fabricated and remain deferred:
     - Specific LLM provider and production model IDs (e.g., Anthropic, OpenAI, Google Gemini).
     - Storage and checkpointer backend implementation for UC-04 (selected by Thanh Tan, e.g., PostgreSQL, SQLite, or file-backed store).
     - Concrete Docker task container base image digest, Linux host environment support, and isolation flags/profile.
     - Telemetry, logging, and diagnostic artifact retention/redaction policy in production.
     - Final evaluation dataset, test repository suites, and host-private grading configurations.

## External Deliverables and Delivery References
- Contract v0.1 defines interface boundaries for external dependencies:
  - `X04-STATE`: Durable task/checkpoint persistence, atomic multi-budget ledger, and crash recovery (Thanh Tan / UC-04).
  - `X05-GATE`: Policy classification, human approval tracking, and fix-plan binding (Trong Tan / UC-05).
  - `X04-X05-RESTART`: Integrated crash recovery under pending approvals and active reservations (Thanh Tan & Trong Tan).
- **Disclaimer on External Ledgers and Adapters**:
  - Agreement on contract v0.1 interfaces and acceptance criteria does **not** prove that real production adapters or external services exist today.
  - No foreign task IDs, branch links, or external commit ledgers are currently available for UC-04 or UC-05. Such identifiers are external delivery references and must not be fabricated or invented.
  - Until real adapters are integrated (T025, T028, T032), UC-03 development proceeds safely against controlled, deterministic mocks (`T004`) satisfying the shared contract v0.1 validation suite.

Package-manager amendment: the user explicitly selected pnpm instead of npm and authorized removing the npm-created installation on 2026-10-16 (Asia/Saigon). This supersedes the initial npm selection, not the selected runtime dependencies or production execution gates.

CI release-age repair: pnpm rejected imported @langchain/core 1.2.18 and langsmith 0.11.0 because they were under the default 24-hour minimum release age. Select compatible core 1.2.17 and regenerate the lock under the unchanged 1440-minute policy; no release-age exclusion or trust bypass is permitted.

## Local-Only Fixtures Preference Amendment

On 2026-10-18 (Asia/Saigon), the user explicitly directed: "I don't think we should push the fixtures/ folder". Consequently, test fixtures under `fixtures/` are treated as local-only development artifacts and excluded from the Git index and publication branch via `.gitignore` and index removal (`git rm -r --cached -- fixtures`). Physical fixture files remain preserved in local checkouts for local testing and retained development branches, but are not shipped to upstream repository tracking. Tracked documentation and example references are amended to reflect that fixtures are local-only and not shipped.

## Phase 4 Authorization

On 2026-10-21 (Asia/Saigon), the user authorized the next phase of specification 001 and confirmed a fresh branch from updated origin/development, preserving the original checkout. This releases Phase 4 T015-T018 only on `feat/uc03-bounded-repair`: local-only repair scenarios, runnable behavioral RED checks, bounded repair, and material-replan/feedback transitions using injected controlled ports. Implementation uses Gemini 3.8 Flash High; independent review uses GPT-6.1-Sol; review repairs use GPT-6-Luna with max reasoning. These contributor model choices do not select production providers. Phase 5 onward, real execution, real adapters, production profiles, and actual restart evidence remain gated. Existing Phase 3 task statuses are not changed by this authorization.
