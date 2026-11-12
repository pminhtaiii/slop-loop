# Decisions and Release Gates: UC-06

## Authorization and provenance

On 2026-11-12 (Asia/Saigon), user authorized this planning package, validation and two independent planning lanes in C:/SE373. Runtime implementation, real provider/container calls, issue closure, push and merge require a subsequent request. Planning quality is not implementation authority or owner agreement.

Baseline: fetched `origin/development` `540a185011365f7ef68741a1e26abf1d2eb4cdb9`. Clean merged predecessor `feat/uc05-gate-readiness-review` `a092c385ca3d4ff44947b63f6dbbb67d69a1543f` (public PR 175) preserved. `prepare-next` checked both remotes' live heads/full PR history and created unused `feat/uc06-reviewer-planning`. No remote writes. Spec Kit allocated sequential `009-reviewer-agent`; UC ID does not determine feature number.

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

These are planning proposals, not claimed shared-owner acceptance. External approvals are explicit release conditions, not unresolved design placeholders.

## Gates and handoff evidence

| Gate | Accountable owner / opening condition | Evidence required | Affected tasks |
|---|---|---|---|
| G-PLAN | Coordinator: validation + both independent lanes, no unresolved P0/P1 | Verified file snapshot, lane identities/reports, dispositions | Planning quality only |
| G-AUTH | User: release exact tasks and tier | Dated scope decision; no inherited successor release | Every implementation/evaluation task |
| G-OWNER | User assigns UC-06 owner; Tai accepts shared paths/companion/transport byte caps; Thanh Tan accepts new uc06-review-evidence/1 supplement; Trong Tan accepts current capability consumption/fencing | Exact contracts/paths/tier and direct or explicitly delegated signoff provenance; public capability versions, no inferred delivery | T001 onward |
| G-DELIVERY | Tai + Thanh Tan + Trong Tan deliver compatible current v0.2 host/read/state/policy and ReviewEvidencePortV1 | Pinned revisions, persist/load/recover/content ACK and atomic candidate-index conformance, lost-ACK discovery without graph locator, immutable snapshot/read fencing, current authority/result lookup; compatible store/issuer behavior | Real T011–T013 |
| G-ROUTE | Tai closes relevant UC-03 T026/T066 and Feature 007 route gaps in their own ledgers | Actual Verify → Review → Repair → Verify → Review binding, current D1/original D0 ancestry and completion evidence | Real T011 |
| G-PROFILE | Operator + Tai approve provider/model/prompt/pricing/limits/artifacts | Host-only credentials, conservative billable exposure, finite task/run/output bounds, image/platform/config pins, redaction/retention | T011–T013 |
| G-SECURITY | Tai consumes original UC-03 T024/T025 and Feature 007 isolation/approval gates | Exact real containment and owner-backed decisions, unchanged sentinels, separate private grading isolation | Integrated T011/T012; actual target checks |
| G-QUALITY | Independent evaluator + user approve labels/rubric before candidate outputs | Independent author/provenance, hidden expected locations/rationale, frozen model/prompt/config, explicit approval | T012 |
| G-RESTART | Thanh Tan + Trong Tan deliver compatible durable journal/control/reconciliation | Atomic reservation/settlement, exact predecessors, reviewer high-water mark, no cross-task contamination, subprocess PIDs/journals | T013 |

No production spend default/cap is invented. Reuse finite shared accounting and any separately approved derived-exposure profile; config/model changes replenish no task allowance.

## Boundaries and current gaps

UC-06 context/validation ownership needs assignment. Tai retains shared reviewer, transport, graph, evaluation; UC-04 owns durable state/evidence/accounting and UC-05 classification/consent/provider admission. Tasks do not own src/persistence/, src/approvals/ or canonical uc03/v02/ edits.

UC-05's 2026-11-12 audit finds service/store receipt and initial repository/workspace mapping incompatibility; T020–T022/all 104 real/restart vectors remain unaccepted. UC-04 checked local/file-lock tasks and limited process fixture are candidate evidence, not joined reviewer/provider/approval restart delivery. Feature 007 T005/T034 controlled evidence and single delegated T019 attestation do not approve UC-06 shared changes. Any missing owner wire/capability requires targeted versioned amendment and independent review before implementation.

## Local-only handoff

Managed session: `.agent-work/2026-11-12/uc06-reviewer-planning/`. Retain planning evidence and active coordinator entry; no published contributor completion claim under no-push scope. Preserve other sessions/worktrees.
