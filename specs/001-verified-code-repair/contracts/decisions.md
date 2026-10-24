# Contract and Architecture Decisions: UC-03 Verified Code Repair

## Metadata and Provenance
- **Date**: 2026-10-16 (Asia/Saigon, UTC+07:00)
- **Feature**: UC-03 — Verified Code Repair (`specs/001-verified-code-repair/`)
- **User Confirmation Provenance**: Confirmed directly by the user on 2026-10-16 in Asia/Saigon. The user confirmed that shared use-case owners (UC-04, UC-05) agreed to the current contract v0.1 definitions, and explicitly approved the bootstrap stack while confirming the scope amendment to defer finite production configuration choices until before real execution.
- **Scope**: Phase 1 setup (T001 / T002 release). This document satisfies T001. Later implementation phases and real execution remain gated.

## PR99 CodeRabbit Repair Authorization - 2026-10-24

The user requested ongoing CodeRabbit monitoring and Luna repair subagents for PR99. Round 1 is reserved for the three verified inline findings (v0.2 target-path constraints, action-bound stale-revision test contexts, and configured binding authority) plus the ignored binding/freshness presentation-field nitpick. Workers use GPT-6-Luna with max reasoning and ponytail. The three planned merger/review subagents failed at the provider usage limit; the user then explicitly instructed "no need, just push the fixes". This skips those reruns and authorizes updating the paired drafts with focused worker evidence and known failures disclosed. The paired drafts retain known failed gates. T022, T057 onward, real adapters, production, restart and merge authority remain unchanged.

Round 1 worker handoffs verified exact owned-path hashes. Source/emitted CLI checks pass 33/33 and fixture checks 121/121; typecheck, focused lint and build pass. Context refresh uses the repository updater. No fresh integrated merger, independent review or full runtime/contributor gate is claimed for the repair. T022 REDs and all real/restart/production gates remain intact. Evidence remains local under `.agent-work/2026-10-24/uc03-pr99-coderabbit-r1/`.

## Scoped Fixture and Presentation Continuation — 2026-10-24

The user requested the next five Phase 5 tasks beginning at T052. T052 is already complete and is preserved; this run releases T053–T056 only, following their recorded dependencies. The user confirmed retaining paired RED/GREEN worker assignments after briefly requesting one task per worker. Gemini 3.8 Flash High implements the two disjoint pairs, GPT-6.1-Sol subagents independently review the integrated candidate, and GPT-6-Luna with max reasoning addresses review findings. Every subagent applies ponytail. These contributor model choices do not select production providers. T057 onward, T022, real adapters, production configuration, actual containment/restart, full Phase 5 acceptance and Phase 6 remain gated. Task completion requires integrated verification; contributor publication remains subject to its separate gates.

After R2 review left four P1 findings, the coordinator stopped under build-spec's repeated-finding rule. The user explicitly approved one additional bounded Luna max-reasoning repair round for SPEC-005 (actual journal usage), SPEC-006 (control collection validation), STD-005 (safe rejection diagnostics), and STD-006 (provider receipt authority). Independent GPT-6.1-Sol re-review follows. This continuation does not release successors, erase historical RED limitations, waive publication gates, or authorize production execution.

T053-T056 are complete locally after combined verification at HEAD 8007bbbb09ca1b424a619b155507dcc80b68dd6c plus the ten inputs in `review-r3-snapshot.json`. Source and emitted fixture/conformance/CLI suites each pass 154/154 (121 fixture and 33 CLI); typecheck, focused lint and build pass. Independent Standards R3 and Spec R3 report no unresolved P0/P1/P2 findings and scope-limited convergence. Exact commands, exit statuses and hashes are retained locally under `.agent-work/2026-10-24/uc03-t052-t056/merger-r3/` and `reviews/`. Separate pinned neutral replays record assertion-only source/emitted failures, passing typecheck/build and byte-exact GREEN restoration; historical T053/T055 RED limitations remain explicit. T052 was already complete and preserved. T057 onward and T022 remain incomplete and unreleased by this run; real adapters, production configuration, actual containment/restart, full Phase 5 acceptance and Phase 6 remain gated. Contributor publication and full runtime/contributor/CI gates are separate.

The commit size gate required a behavior-preserving split: `presentation.ts` retains builders and reexports `presentation-v02-validation.ts`. Independent Standards R4 and Spec R4 verified identical moved logic, preserved API, acyclic dependencies and all 11 pinned inputs; no unresolved findings remain. The split rerun passes source/emitted CLI 33/33, typecheck, lint and build. Context evidence was deduplicated within the existing document format. Final candidate hashes are in local `review-r4-snapshot.json`; R3 combined 154/154 evidence is retained for unchanged behavior.

Publication at 9a47420 on fresh `feat/uc03-versioned-fixtures-presentation` (base 524c368, including UC-04 foundation) passed context/typecheck/full lint/build. Runtime reported 1,669 tests: 1,660 passed, five failed and four skipped. The stale approval catalog count was separately repaired from 267 to 273 with source/emitted acceptance 2/2; all 104 real/restart vectors remain not-run. Four intentional T022 guard REDs remain outside this scope and block normal publication. No PR was created, contributor checks/remote CI were not run, and no passing final full-gate claim is made. Source transfer preserves the scoped Git blobs; newline/HEAD changes and one mixed-newline test hash limitation are recorded in local `publication-source-transfer.json`. Full gate logs and focused catalog repair evidence remain under the local session.

Independent catalog Standards and Spec reviews accepted the exact 267-to-273 inventory correction, confirmed the six added CLI entries and unchanged comparison/case/vector safeguards. Source/emitted acceptance checks pass 2/2, typecheck/build and focused lint pass; all 104 required real/restart vectors remain not-run. Catalog review reports and pinned hash are retained locally under the session. This focused repair does not establish a passing final full runtime/contributor gate or authorize bypassing the four intentional T022 REDs.

## PR97 CodeRabbit Round2 Authorization — 2026-10-24

The user explicitly requested another Luna repair subagent for the remaining issues. Round2 addresses historical evidence labeling, exact-request cache eviction after proven pre-claim denial, and reachable trusted recovery for ambiguous repository attempt starts. Earlier open closure/outcome threads were rechecked against existing regressions. Ponytail and max reasoning apply; no additional review is requested. Prior paired manual-draft publication authority continues with failed gates disclosed. Intentional T022 guard REDs and all real/restart/production, successor and merge gates remain unchanged. Evidence: `.agent-work/2026-10-24/uc03-pr97-coderabbit-r2/worker/finding-ledger.md`.

## PR97 CodeRabbit Repair Authorization — 2026-10-24

The user explicitly delegated CodeRabbit's reported PR97 issues to Luna. Repair round1 covers six inline findings plus the shared secret-policy nit, including task ownership metadata, queued-reader progress, pre-claim retry caching, trusted patch claim/attempt recovery, command/test outcome recording and the budget-exhaustion test actor. Luna uses max reasoning and ponytail. The prior instruction to skip additional reviews and update the paired manual drafts with known failures disclosed remains in force. No guard RED case is weakened and no T022/successor, real-adapter, production or merge authority is released. Scoped evidence is retained under `.agent-work/2026-10-24/uc03-pr97-coderabbit-r1/`; contributor completion remains subject to required checks.

## Publication Repair and Manual Draft Authorization — 2026-10-24

After the full runtime gate reported seven failures, the user explicitly instructed a Luna subagent to fix the three unintended failures (approval catalog comparison, legacy production-provenance admission, and CLI decision selectors), skip reviews, and open a PR manually. This authorizes those bounded repairs and manual draft publication despite the four intentional execution-guard RED cases. It does not release T022 implementation, successor tasks, weakened tests, production execution, real adapters, merges or a passing full-gate claim. Luna used max reasoning and ponytail; no independent repair review or review request is authorized. Manual publication is an explicit exception to the helper-only publishing path for this run; normal paired-source, naming, truthful evidence and app-link requirements remain. Contributor completion still cannot be claimed while required checks fail.

## Scoped Receiver and Provider Continuation — 2026-10-23

The user requested the next five Phase 5 tasks beginning at T048 on `feat/uc03-atomic-admission-journal`. T048 was already complete, so this run preserves it and releases T049–T052 only, superseding the earlier stop-before-T049 instruction for this range. T053 onward and T022 are not released by this request. Gemini 3.8 Flash High implemented the receiver/provider pairs; GPT-6.1-Sol performed independent final reviews. The user requested ponytail for every subagent, end-only code review, GPT-6-Luna with max reasoning for fixes and mechanical merger work, then GPT-6.1-Sol subagents for the final provider fixes. The user separately approved one additional targeted rejection-normalization repair after the required stop for a repeated finding. These contributor choices do not select production providers.

T049–T052 are complete locally after integrated focused verification. Source and emitted repository/Docker/model suites each pass 261/261; typecheck, scoped lint and build pass. Independent final Standards R5 and Spec R5 report zero P0/P1/P2 findings. The 19-file snapshot pins HEAD 4cb41234c02fb7fd968905c8341ffba1c0ce7ba3 plus the reviewed working tree. The separately labelled new T051 neutral replay has clean typecheck/build, two positive assertion failures in source/emitted tests, and byte-exact GREEN restoration; it does not rewrite the original compile-deficient historical checkpoint. Evidence remains local under `.agent-work/2026-10-23/uc03-t048-t052/`; final review reports and the source manifest identify the accepted candidate. The earlier deficient T051 RED record and absent historical settlement/size evidence folders are preserved as limitations; the new neutral replay is separate evidence. Local task completion grants no successor authority. Real X04-STATE/X05-GATE adapters, production profiles, real provider/container execution, durable or actual restart evidence, full Phase 5 acceptance and Phase 6 remain gated. Contributor publication and its full runtime/contributor/CI gates are separate.

## Phase 5 Continuation Authorization — 2026-10-23

On 2026-10-23 (Asia/Saigon), the user requested implementation of Phase 5 of specification 001 beginning from T041. T041 is already complete as an intentional behavioral RED checkpoint. This instruction releases the remaining mock-backed atomic-admission work T042–T066 and T022 on `feat/uc03-controlled-execution-phase5`, following the canonical dependency graph. It supersedes earlier unreleased wording for those tasks only; task completion still requires integrated verification. Implementation uses Gemini 3.8 Flash High, independent reviews use GPT-6.1-Sol, and review repairs use GPT-6-Luna with max reasoning. These contributor model choices do not select production providers. Real-only T024/T025 prerequisites, external adapter delivery, production configuration, actual containment/restart evidence, and Phase 6 remain gated. The existing approved contract and task acceptance criteria define the test seams.

The user subsequently clarified that code review is to run only at the end of the authorized implementation, and authorized GPT-6-Luna with max reasoning for mechanical merger assignments. Intermediate integration uses ownership/handoff verification and focused checks; independent code review remains an end-of-implementation gate.

The user then narrowed this run: complete T047–T048, perform the final reviews and fixes for this run's T042–T048 changes, and stop before T049. Do not start successor implementation in this run. This stopping point does not claim full Phase 5 completion; later mock-backed tasks remain unfinished, and real-execution gates remain intact.

For these final review repairs, the user explicitly limited fixes to P0 and P1 findings and directed that P2 findings be skipped. Record lower-priority findings as deferred rather than expanding this run. Required mechanical commit gates remain applicable.

After the reviewed local stopping point, the user requested a PR. Publication uses the fresh `feat/uc03-atomic-admission-journal` branch from fetched `origin/development`, preserving the prior branch and the reviewed source content. This releases publication of T042–T048 only, not successor implementation. Full publication gates and paired PR/CI accounting remain separate from the focused mock evidence.

## Phase 2 Authorization

On 2026-10-16 (Asia/Saigon), the user authorized the next phase of the first specification: Phase 2, T003 canonical contract validators/conformance vectors and T004 controlled test-only port mocks. The integration branch is `feat/001-verified-code-repair-phase2`, created from the latest `origin/development`. The user approved using Gemini 3.8 Flash High with scoped repository content for small implementation assignments and requested independent GPT-6.1-Sol low-reasoning reviews. This contributor model selection does not select a production runtime provider. Phase 3 onward, real repository execution, and the deferred production choices remain separately gated. Existing accepted contract semantics and external ownership are unchanged.

## Phase 3 Authorization

On 2026-10-18 (Asia/Saigon), the user authorized the next phase of the first specification, Phase 3 (T005–T014), and confirmed creating a fresh branch after pulling current changes. Integration uses `feat/015-uc03-success-boundaries`, based on `origin/development` at `dba1e4cce38d1ee782872aaa08444e9e43e3b9cc`. Implementation uses small Gemini 3.8 Flash High assignments, independent GPT-6.1-Sol low-reasoning review, and Gemini follow-up repairs. This authorizes the specified injected boundaries and fixtures, not real repository execution, production provider selection, or Phase 4 onward. T024/T025/T028 and deferred production choices remain gates before real execution.

## Phase 5 Authorization

On 2026-10-22 (Asia/Saigon), the user authorized Phase 5 (T019–T025) of the first specification and selected a fresh feature branch from fetched `origin/development`, preserving existing local work. Integration uses `feat/uc03-controlled-execution-phase5` from `1c154c2b87694501b47c7013839dfe20c890ce2b`. Implementation uses Gemini 3.8 Flash High, independent GPT-6.1-Sol reviews, and GPT-6-Luna with max reasoning for review corrections. These are contributor models, not production provider selections. T019–T023 can proceed against the accepted controlled contracts. T024–T025 remain dependent on actual X04-STATE/X05-GATE adapters and explicit concrete isolation/platform configuration; this authorization does not fabricate their delivery or waive real-only acceptance. Phase 6 and deferred production choices remain separately gated.

## Atomic Admission Amendment Approval and Task Preparation

On 2026-10-22 (Asia/Saigon), after independent standards and testability reviews found no blocking issues in `612cadd` (integrated as `5af410d`), the user confirmed that Thanh Tan (UC-04) and Trong Tan (UC-05) had agreed to the reviewed [atomic admission amendment](atomic-admission-amendment.md). The user then explicitly approved the design and preparation of scoped implementation tasks. This records user-relayed owner agreement, not direct owner messages or delivered adapters. The approved design assigns durable journal/claims/accounting to UC-04, current policy and approval authority to UC-05, and one admitted effect attempt to the shared guard/executor boundary. Task preparation must preserve the amendment's versioned migration, branch-specific receipts, observed-unsettled recovery and fail-closed requirements. Canonical implementation release remains a separate scoped step after task decomposition and planning review; T022 remains incomplete. Real adapters, production choices, real containment and Phase 6 execution are not released by this approval.

## Admission Implementation Remains Unreleased

After the reviewed task decomposition was integrated at `df03e0a`, the user explicitly selected “Keep this as an approved plan only” when asked to release mock-backed T037–T066 plus T022. The design and task plan remain approved at the planning level; these implementation tasks are not authorized to execute. T022 stays incomplete. Preserve completed T019–T021 and T023, and do not infer an implementation release from the earlier Phase 5 request or owner agreement. Real adapters, Docker acceptance and Phase 6 remain gated.

## Limited Admission Implementation Release: T037–T041

The user subsequently instructed implementation of the first five amendment tasks. This supersedes the plan-only restriction for T037–T041 only: additive admission scaffolding/validators (T037–T038), attempt/outcome scaffolding/validators (T039–T040), and the test-only StatePortV02 neutral journal scaffold with behavioral RED checks (T041). T042 and later tasks, T022, real adapters, Docker acceptance and Phase 6 remain unreleased. T041 intentionally stops at its valid behavioral RED checkpoint; this is not implementation of the T042 journal. Use Gemini 3.8 Flash High implementation, independent GPT-6.1-Sol review and GPT-6-Luna max reasoning repairs as previously requested. Integration first merged current origin/development at `4e39836`, preserving Phase 5 evidence and incoming UC-05 updates.

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
