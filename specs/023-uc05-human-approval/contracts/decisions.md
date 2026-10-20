# Decisions, Provenance and Release Gates: UC-05

## Authorization history

- On 2026-10-19 (Asia/Saigon), the current user stated they own UC-05 and asked for its specs. They selected `spec.md` and checklist first; the initial draft was written on `feat/023-uc05-human-approval-spec`.
- The user then said "ok rồi viết full specs đi", authorizing this complete planning package. This accepts moving on from the requirements draft; it does not establish approval of newly proposed shared APIs, production configuration, runtime implementation, commits, remote publication or merge.
- On 2026-10-19 (Asia/Saigon), the user instructed "bạn hãy code phase 1 cho UC05 đi". This explicitly authorizes Phase 1 / T001 setup and agreement work. Phase 1 contains no runtime implementation task. It does not release Phase 2 T002–T004, later phases, or real execution, and it does not attest that Tai or Thanh Tan accepted the proposed companion contract.
- In the subsequent explicit confirmation on 2026-10-19 (Asia/Saigon), the user answered "Đã thống nhất cả ba người với bản hiện tại" to the question identifying the UC-04 durable pause/decision/atomic-claim contract, Tai's task-wide dispatch barrier, immutable approval and fresh approval after repository-digest drift. This is user-relayed agreement by Trong Tan, Tai and Thanh Tan on the current contract/ownership set, not a claim that the assistant contacted them or obtained separate signatures.
- On 2026-10-19 (Asia/Saigon), the user explicitly said "hãy code phase 2 luôn đi". This authorizes only Phase 2 T002–T004: companion validators, the C01–C24 fixture registry and test-only mock ports. T004 follows integrated T002 and T003. T005 onward, production configuration/adapters, actual restart, remote issue changes, publication and merge remain outside this authorization.
- Accepted product behavior comes from ADR-0004 and ADR-0006; their original dates/ownership remain unchanged. Historical agreement on UC-03 contract v0.1 does not approve this new companion store/control design.

## Agreed design register

| ID | Proposal | Scope / approval state |
|---|---|---|
| D01 | Reuse canonical UC-03 schema and ApprovalPort signatures | Agreed via user confirmation; no canonical edits |
| D02 | UC-04 companion durable control/journal/claim contract; one pending request/task | Shared contract agreed via user confirmation; real adapter still required |
| D03 | Immutable human resolution and separate stale/effect assessments | Agreed via user confirmation; executable conformance remains future work |
| D04 | Strict exact-digest plan approval, fresh request after drift without charging unchanged strategy | Initial compatibility restriction agreed with all three owners via user confirmation |
| D05 | Built-in host CLI with explicit task/request/version/presentation identity | UC-05 protocol agreed via user confirmation; no new project-wide framework selected |
| D06 | Explicit configurable limits; test-only uc05-local-v1 numbers | Test-only contract agreed; no production defaults or latency target approved |

## Implementation and real-execution gates

1. **G-AUTH**: Phase 1 / T001, Phase 2 / T002–T004 and Phase 3 / T005–T007 are authorized by the explicit user instructions recorded here. T008 onward requires separate authorization. Contract agreement alone does not release additional work.
2. **G-CONTRACT**: Satisfied for the current logical contract/ownership set by the explicit user-relayed agreement above. Companion records, transactions, claim/fence timing, host operator authority, strict plan compatibility and owned paths are agreed; actual adapters and execution evidence are not implied.
3. **G-PROFILE**: Trusted finite policy/execution/diagnostic/retention and supported-host profiles selected by their owners. Test vector values cannot stand in for production configuration.
4. **G-REAL**: Real UC-04 store, task-wide provider/scheduler/tool admission, executor containment and claim/reconciliation are delivered with owner ledger/revision evidence. Mock provenance is rejected by production composition.
5. **G-RESTART**: Actual runtime process termination and restoration proves pause, rejection, decision, claim/effect accounting and no blind duplication on the supported host.

Independent planning reviews assess design quality; they are not owner agreement, runtime verification or phase authorization. Local review reports/source hashes stay under ignored `.agent-work/`; current runtime evidence under ignored `docs/verification/` is not force-added. Later approved design amendments must identify changed contract/version and affected consumers before integration.

## Phase 1 / T001 readiness record

**Status**: Phase 1 / T001 completed: authorization, explicit user-relayed shared-owner agreement and documentation validation recorded. Its canonical checkbox is maintained in tasks.md. This phase adds no runtime code, dependency or production configuration.

The existing UC-03 v0.1 owner agreement remains the compatibility baseline. The new `uc05-approval/0.1-draft` logical companion contract is accepted through the separate confirmation recorded above; its identifier is preserved without claiming an executable schema release. The confirmed decision set is:

| Item | Proposed agreement | Required confirmation | Current evidence |
|---|---|---|---|
| Authorization | Execute Phase 1 / T001 only | Current user | Explicit instruction recorded above |
| Canonical compatibility | Preserve schema 0.1.0, exact action/plan digests, and the four ApprovalPort signatures | Tai + Trong Tan | Existing canonical baseline accepted; no new canonical edits proposed |
| Durable control | UC-04 owns atomic pending-plus-pause, immutable resolution, explicit direction, monotone task epochs and durable journal/outbox | Thanh Tan + Trong Tan | Agreed in current set via explicit user confirmation |
| Dispatch and cancellation | Shared scheduler/model/tool/background admission checks the same epoch; Tai/UC-04 serialize pause versus claim, reserve before effects and reconcile uncertain outcomes | Tai + Thanh Tan + Trong Tan | Agreed in current set via explicit user confirmation |
| Plan coverage | Any current repository digest drift requires a fresh immutable plan decision; unchanged strategy retains plan version and incurs no material replan charge; preserve original baseline evidence | Tai + Trong Tan | Agreed in current set via explicit user confirmation |
| Operator and presentation | Host-only CLI capability, explicit task/request/version/presentation identity, safely inspectable details, no consent from agent/repository text | Trong Tan, with Tai confirming host isolation | Agreed logical boundary; runtime isolation evidence still required |
| Ownership | Trong Tan owns approvals and UC-scoped tests; Thanh Tan owns persistence/control transactions/accounting; Tai owns canonical contracts, trusted context, all-agent admission and execution | All three owners | Shared companion ownership agreed via user confirmation |
| Finite fixtures | `uc05-local-v1` is an explicit test-only profile; no value authorizes production execution, selects storage or creates a latency SLA | All affected owners | Current test-only contract confirmed; no production approval claimed |

The accepted records are [interfaces](interfaces.md), [policy](policy.md), [CLI](cli.md), [data model](../data-model.md), and the initial-slice strategy in [plan](../plan.md). Their exact pre-status-update bytes and SHA-256 hashes are retained locally under `.agent-work/2026-10-19/uc05-phase1/accepted-baseline/` and `accepted-contract.snapshot.json`. These identify the acknowledged set; subsequent edits in this phase update authorization/status only. No substantive contract amendment or direct colleague contact was performed.

**Current status**: Phase 1 / T001 and separately authorized Phase 2 / T002–T004 are complete locally. T005 onward requires separate authorization; production profile, real-adapter and restart gates remain open.

**Validation**: `node scripts/agents/planning-workflow.mjs validate --dir specs/023-uc05-human-approval`, `node scripts/ci/check-context.mjs` and `git diff --check` exited 0 after recording the agreement. The acknowledged files were retained before status-only updates; no runtime tests, real adapters or actual restart results are claimed. Contributor PR publication and remote Issue lifecycle remain separate from this local T001 ledger completion.

## Phase 2 authorization

**Status**: Authorized on 2026-10-19 (Asia/Saigon) by the user's explicit request to code Phase 2; T002–T004 are now implemented and integrated locally at `dbafa8aef44bb5781c0ae0e075b728fb4398baf9`. The authorized boundary was exactly T002, T003 and dependent T004 in [tasks](../tasks.md).

T002 added companion record/profile validators and public-export tests; T003 added the versioned C01–C24 fixture/oracle registry; T004 added test-only store/context mocks and contract tests after T002 and T003 passed. The accepted logical contract and canonical UC-03 schema remain unchanged. Mock tests establish no persistence, production composition, real execution, or process-restart capability. Keep T005 onward and G-PROFILE/G-REAL/G-RESTART gated. This authorization did not include GitHub Issue updates, remote pushes, PR publication, or merge to a shared branch; task commits and integration remain local.

**Current evidence**: The user explicitly confirmed the public test seams for T002–T004 on 2026-10-19. The seam/preflight notes and worker handoffs are retained in ignored `.agent-work/2026-10-19/uc05-phase2/`. T002 integrated at `d1452b3`, T003 at `ea555f2`, and T004 at `dbafa8a`; the canonical task ledger marks T001–T004 complete and T005–T022 unchecked. Focused checks and the runtime gate passed through T004 (471 runtime tests). The mocks are memory-only and record effect attempts without executing them; production profiles, real adapters and restart behavior remain unverified.

## Phase 3 authorization and seams

On 2026-10-19 (Asia/Saigon), after checking the merged contract-layout commits on both repositories, the user explicitly instructed "rồi giờ code cho phase 3 đi nhé". This releases exactly T005–T007, including the initial CLI and actual CLI subprocess tests with injected test-only dependencies. The user subsequently confirmed "xác nhận cả 4 seam" and requested correction of the old T002 contract path. The four confirmed test seams are:

1. Public compiled-policy classification using an explicit finite profile, canonical action and trusted admission facts; precedence, argv grammar and breadth are observed, not real isolation.
2. The unchanged four canonical ApprovalPort methods with fresh injected context, mock store and host operator capability; request/pause/decision behavior is observed, not durability.
3. Public safe presentation and inspection output; five decision elements, digest identity, byte/page bounds and protected-data/terminal-injection rejection.
4. Actual CLI subprocess list/show/inspect/decide with an explicitly injected test driver; arguments, safe output and exit behavior, without a production store or effect execution.

The source contract locations after merged public PR #71 are `src/contracts/approvals/contracts.ts` and `src/contracts/foundation/uc03.ts`. Runtime modules remain under the T005–T007 owned `src/approvals/` paths. No contract version or accepted companion semantics is changed by the layout correction. T008 onward, production profiles/adapters, durable storage, real effects and restart evidence remain gated. Coordinator publication follows the standing contributor pilot separately; no merge is authorized. Task completion remains exclusively in tasks.md.
