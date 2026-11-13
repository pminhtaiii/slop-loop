# Decisions and Release Gates: UC-06

## Authorization and provenance

On 2026-11-12 (Asia/Saigon), user authorized this planning package, validation and two independent planning lanes in C:/SE373. Runtime implementation, real provider/container calls, issue closure, push and merge require a subsequent request. Planning quality is not implementation authority or owner agreement.

Baseline: fetched `origin/development` `540a185011365f7ef68741a1e26abf1d2eb4cdb9`. Clean merged predecessor `feat/uc05-gate-readiness-review` `a092c385ca3d4ff44947b63f6dbbb67d69a1543f` (public PR 175) preserved. `prepare-next` checked both remotes' live heads/full PR history and created unused `feat/uc06-reviewer-planning`. No remote writes. Spec Kit allocated sequential `009-reviewer-agent`; UC ID does not determine feature number.

## T001 owner agreement — 2026-11-12

The user explicitly selected Phase 1 of tasks.md (T001 only), then responded to the prepared T001 agreement packet: “tôi tên Trọng Tấn, tất cả đã đồng ý” (my name is Trọng Tấn; everyone has agreed). Record **Trọng Tấn as UC-06 owner**. Agreement provenance is one user's direct self-identification and **user-relayed confirmation** that all named owners accepted the exact packet; no independent Tai, Thanh Tan or Trong Tan signature/message was supplied, and no delegated signing authority is asserted. Preserve the existing UC-05 owner spelling/assignment; similar names do not establish that UC-06 Trọng Tấn and UC-05 Trong Tan are the same person.

The accepted baseline is review-context.md sections 1–6, evaluation.md including milestone coverage/evaluator v2, and tasks.md exact Owned Paths at source commit 43fcc528ea9a5c6c6ad7ad2817dfad682c501f02 (unchanged on current development d436e8f). The session packet is retained locally as `.agent-work/2026-11-12/uc06-reviewer-planning/T001-agreement.md`; the current user reply is the source of consent, not the packet itself.

| Accountable party | Agreement recorded from the user's confirmation |
|---|---|
| Trọng Tấn, UC-06 | Own UC-06 context/validation concern and coordinate its task/evidence delivery; shared implementation ownership below remains with existing owners |
| Tai, foundation | Reuse createRuntimeReviewer; accept additive context/observation, opt-in snapshot/resolver and graph-v0.2/completion seams, trusted role/prompt and response/content byte bounds, evaluator v2 preserving v1 refusal, and exact T004/T005/T006/T010 path allocations |
| Thanh Tan, UC-04 | Accept uc06-review-evidence/1 persist/load/recover/ACK supplement, atomic observation/discovery index, no-locator lost-ACK recovery, latest-request/no-older-fallback and conservative uncertainty; actual durable delivery remains external |
| Trong Tan, UC-05 | Accept consumption of existing current admission/control/approval generation and task-wide waits; no duplicate approval service, wire change or reviewer write authority |

G-OWNER's assignment/contract agreement is now recorded on that user-relayed basis. G-AUTH releases **T001 administrative/documentation work only**; its evidence tier is documentation, with no runtime/model/provider/container execution. T002–T014 remain unreleased. Agreement on task allocations is not a dispatch of those tasks. Test-only finite profiles and the proposed 12-case quality rubric are accepted as planning proposals only; actual independent labels/rubric approval and production profile choices remain G-QUALITY/G-PROFILE. No actual owner adapter delivery, real integration, isolation or restart evidence is supplied.

The earlier request to push both repositories separately authorized publication of the planning package, now merged as public PR 177; that publication did not release runtime work. Earlier planning-only/local-only passages below describe the original stage; this entry supersedes only owner-unassigned/unconfirmed wording and T001 authorization, not successor gates or acceptance claims.

## Phase 2 implementation release — 2026-11-12

After T001 the user requested “code phase 2 rồi push đi” and, following an intentional interruption, “làm tiếp đi”. This releases exactly **T002**, including types/runtime validators and tests in its three owned paths, source/controlled verification, independent merger/review, context refresh and paired publication. The public validation seams are those in review-context.md sections 2/3/5/6 and T002 acceptance; apply TDD through exported validation APIs with assertion RED before GREEN. No missing-import RED, actual owner storage implementation, reviewer/transport/graph wiring, T003 onward, real provider/container call, production profile, quality/restart acceptance or merge is released.

## Selected design proposals

| ID | Proposal | Rationale / limit |
|---|---|---|
| D1 | UC-03 verified-repair trigger only | No fabricated generic task, pre-plan bypass, standalone trigger/bot/UI |
| D2 | Existing createRuntimeReviewer plus opt-in uc06-review-context/1 | One reviewer, model ingress and accounting owner |
| D3 | Canonical ReviewResult/ProviderRequest/v0.2 wire records unchanged | Stronger binding is a versioned companion, never extra strict-schema keys |
| D4 | Every UC-06 finding needs evidenceRef and reasoned message | Legacy optional evidenceRef remains compatible but cannot satisfy UC-06 |
| D5 | Bounded ordinary textual modify/add/delete only | Refuse unsupported diffs, particularly parser cross-path rename shortcut |
| D6 | Trusted reviewer prompt/schema branch in existing transport | Planner-only prompt is insufficient; no second adapter |
| D7 | Separate controlled, integrated real, quality and restart milestones | Checked predecessor tasks/doubles do not prove broader acceptance |

The T001 entry records user-relayed acceptance of the exact design/ownership baseline. Remaining production/rubric approvals and owner deliveries are explicit release conditions, not unresolved design placeholders.

## Gates and handoff evidence

| Gate | Accountable owner / opening condition | Evidence required | Affected tasks |
|---|---|---|---|
| G-PLAN | Coordinator: validation + both independent lanes, no unresolved P0/P1 | Verified file snapshot, lane identities/reports, dispositions | Planning quality only |
| G-AUTH | User: release exact tasks and tier | Dated scope decision; no inherited successor release | Every implementation/evaluation task |
| G-OWNER | User assigns UC-06 owner; Tai accepts shared paths/companion/transport byte caps; Thanh Tan accepts new uc06-review-evidence/1 supplement; Trong Tan accepts current capability consumption/fencing | Exact contracts/paths/tier and explicitly labeled direct, user-relayed or delegated agreement provenance; T001 records user-relayed confirmation, no separate signatures/delegation or inferred delivery | T001 onward |
| G-DELIVERY | Tai + Thanh Tan + Trong Tan deliver compatible current v0.2 host/read/state/policy and ReviewEvidencePortV1 | Pinned revisions, persist/load/recover/content ACK and atomic candidate-index conformance, lost-ACK discovery without graph locator, immutable snapshot/read fencing, current authority/result lookup; compatible store/issuer behavior | Real T011–T013 |
| G-ROUTE | Tai closes relevant UC-03 T026/T066 and Feature 007 route gaps in their own ledgers | Actual Verify → Review → Repair → Verify → Review binding, current D1/original D0 ancestry and completion evidence | Real T011 |
| G-PROFILE | Operator + Tai approve provider/model/prompt/pricing/limits/artifacts | Host-only credentials, conservative billable exposure, finite task/run/output bounds, image/platform/config pins, redaction/retention | T011–T013 |
| G-SECURITY | Tai consumes original UC-03 T024/T025 and Feature 007 isolation/approval gates | Exact real containment and owner-backed decisions, unchanged sentinels, separate private grading isolation | Integrated T011/T012; actual target checks |
| G-QUALITY | Independent evaluator + user approve labels/rubric before candidate outputs | Independent author/provenance, hidden expected locations/rationale, frozen model/prompt/config, explicit approval | T012 |
| G-RESTART | Thanh Tan + Trong Tan deliver compatible durable journal/control/reconciliation | Atomic reservation/settlement, exact predecessors, reviewer high-water mark, no cross-task contamination, subprocess PIDs/journals | T013 |

No production spend default/cap is invented. Reuse finite shared accounting and any separately approved derived-exposure profile; config/model changes replenish no task allowance.

## Boundaries and current gaps

Trọng Tấn owns UC-06 context/validation as recorded at T001. Tai retains shared reviewer, transport, graph, evaluation; UC-04 owns durable state/evidence/accounting and UC-05 classification/consent/provider admission. Tasks do not own src/persistence/, src/approvals/ or canonical uc03/v02/ edits.

UC-05's 2026-11-12 audit finds service/store receipt and initial repository/workspace mapping incompatibility; T020–T022/all 104 real/restart vectors remain unaccepted. UC-04 checked local/file-lock tasks and limited process fixture are candidate evidence, not joined reviewer/provider/approval restart delivery. Feature 007 T005/T034 controlled evidence and single delegated T019 attestation do not approve UC-06 shared changes. Any missing owner wire/capability requires targeted versioned amendment and independent review before implementation.

## Local-only handoff

Managed session: `.agent-work/2026-11-12/uc06-reviewer-planning/`. Retain planning evidence and active coordinator entry; no published contributor completion claim under no-push scope. Preserve other sessions/worktrees.
