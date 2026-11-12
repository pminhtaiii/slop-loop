# Research: Existing Reviewer and UC-06 Gaps

Inspected 2026-11-12 (Asia/Saigon), baseline `540a185011365f7ef68741a1e26abf1d2eb4cdb9`; no runtime edits.

## Public API and reuse survey

| Source | Reuse | Limits / gaps |
|---|---|---|
| src/foundation/reviewer.ts: createRuntimeReviewer, RuntimeReviewer | UC03ReviewerPort.review(task,diff,evidence,request,ProviderAdmissionContextV02), role/purpose/task/request/reservation/caps, one ModelPortV02 call, frozen canonical result | No mandatory finding evidence resolution, explicit base/head companion or profile finding/message/byte bounds |
| Same: parseUnifiedDiff | Real changed old/new lines, additions/deletions, CRLF | Empty/non-unified refused; rename shortcut keys both sides under new path, so first UC-06 scope refuses cross-path cases |
| Same: buildReviewerSnapshot/reviewerContextDigest | Same projection for mint/dispatch; task criteria + supplied evidence + review/diff.patch | Synthetic workspace/plan/replan values are not owner state; full context/verification/conventions must be supplied |
| Same: usesCanonicalReviewerIngress | WeakMap binds actual closure to unmodified HostModelPortV02/prototype and derived real transport | Clone/replaced method/provenance string insufficient; branding still proves no actual provider/delivery |
| src/foundation/model.ts, model-v02.ts, provider-admission.ts | Protected current-revision evidence, owner claim/beginAttempt, one-shot, exact outcome/settlement/uncertainty and request replay | Process Sets/Maps do not establish durability; lastObservedUsage is diagnostic, not ledger |
| src/foundation/deepseek-transport.ts: SYSTEM_PROMPT/promptFor/requestBody | Existing host transport, bounded context, no tools/automatic retry | Prompt is code-repair planner for all roles; lacks reviewer-specific schema/instructions; add trusted role branch here |
| src/uc03/graph-review.ts | Baseline/check presence, current owner, original D0/current D1, admission/reloads, Repair/completion | Both digest and review currently use [] evidence: checks/conventions are not shown to model |
| src/uc03/verification-review.ts, graph-completion.ts | Current digest/check/role/reservation review and independent trustedReviewRecord required | Add companion freshness; accepted alone cannot certify checks/fix |
| src/contracts/foundation/uc03.ts | Stable v01 review and explicit v02 ports/admission/attempt/verification-authority exports | Do not modify strict owner records for UC-06 metadata |

Following public exports located v02/ports.ts, admission.ts, admission/provider.ts, admission/trusted-provider.ts, attempt.ts, attempt-receipts.ts and verification-authority.ts. They distinguish provider/repository subjects, approved-plan/pre-plan-diagnostic, exact current task/control/epoch/generation and receipt/digest identity.

## Evidence tiers

Ran `node --test tests/runtime/unit/runtime-reviewer.test.ts tests/runtime/unit/reviewer-v02-accounting.test.ts tests/runtime/contract/uc03-review-regressions.test.ts`: **25 passed, 0 failed, exit 0**. First suite uses actual reviewer with fake model/transport; second uses actual HostModelPortV02 with MemoryStatePortV02/counting fake transport. Its “real durable owner journal” comment does not change the imported in-memory double's tier. Third covers path/task/action validators, not reviewer quality.

ScriptedReviewerPort in tests/runtime/support/uc03/scripted-reviewer.ts queues supplied verdicts and simulates accounting. Its imported port/state fixtures and conformance tests establish handling only. Feature 007 T005/T034 checked states are source/controlled evidence; T011 real first-repair remains unmet. No real provider, container, integrated target review, model quality or restart acceptance is claimed.

## Decisions, rationale, alternatives

- **One reviewer**: context assembly/validation and opt-in validation profile extend existing factory. Second generation/transport/accounting implementation rejected.
- **UC-03 trigger only**: current BugTask/Review node are repair-specific; standalone review would need a new task/admission/completion contract. Do not forge reproduction/approval or use pre-plan diagnostic as bypass.
- **Versioned companion**: canonical message expresses rationale; evidenceRef is legacy-optional. Stronger uc06-review-context/1 and uc06-review-observation/1 preserve wire versions without weakening new acceptance.
- **Prepared context**: existing guarded host evidence, immutable snapshots and current owner acknowledgements; no reviewer tool loop. Fail on missing required evidence, not silently truncate.
- **Role prompt**: trusted reviewer instructions/schema/constraints in existing transport; fake HTTP body tests cover role branch and unchanged coder behavior without network.
- **Owner gate**: assignment --uc UC-06 reports unassigned. Tai owns shared reviewer/transport/graph/evaluation; UC-04/UC-05 deliveries remain separate, no inferred consent.
- **Governance**: constitution retains principle/ratification placeholders; apply AGENTS/context and accepted ADR-0001/0002/0003/0004/0006/0007. Feature 008 source-span proposals are planning-only, not required here.
- **Evaluator migration**: eval/shared.ts currently refuses real/model-quality selections before callbacks, and SharedExecutionContext provenance is mock-only. Registration alone cannot support real UC-06. T010 therefore proposes a separately tagged capability-aware v2 path in the same shared evaluator, preserving v1 refusal and existing UC-01/UC-03 behavior. No source-wide removal of real guards is acceptable.

## Predecessor contracts and conflicts

UC-03 spec/plan/tasks/decisions/interfaces and linked atomic-admission, patch-attempt-accounting and post-patch-verification-authority amendments require one provider chain, historical D0/current D1, cumulative usage and no implicit successor authorization. Feature 007 spec/plan/tasks/decisions/integration/host-composition require exact context/receipt identity and public owner delivery. Its T019 records a single delegated attestation, not UC-06 agreement.

UC-05 spec/plan/tasks/decisions/interfaces require task-wide waits including reviewer, immutable consent distinct from current assessment/effects, and exact provider authority. Current 2026-11-12 gate audit documents concrete real integration gaps. UC-04 spec/plan/tasks/decisions/interfaces/ADR-0007 retain one durable journal/atomic multi-budget owner, drift validation, original pricing and charged uncertainty. Checked T013 is expressly Level 1 in-process; T012 has limited Level 2 subprocess evidence (four PIDs/exit 137). Later T015–T018 and 2026-11-11 file-lock decisions supersede older storage-unselected/open SPEC-C-006 wording at their bounded scope, but need pinned conformance before joined UC-06 delivery claims.

## Paths and workflow

All requested current sources exist. Old IDE/selector specs/023-uc05-human-approval maps to specs/003-uc05-human-approval; old 023 content was not used. New sequential feature is 009; feature selector is independent from Git branch. Setup reports feature identity 009-reviewer-agent while Git stays feat/uc06-reviewer-planning. Inspected PowerShell scripts ran with process-scoped execution policy; no permanent setting change. No extensions.yml exists, so pre/post hooks are absent.

Raw research and independent review records stay in the managed session; canonical checklists retain concise candidate-bound evidence. Passing source tests refer to unchanged baseline runtime, not new UC-06 implementation.

Independent R1 review traced BaselineEvidenceWriter in src/uc03/investigation-types.ts: it stores only BaselineEvidenceCandidate, not generic observations. The corrected proposal therefore defines a new UC-04-owned uc06-review-evidence/1 supplement with exact consumer/fixture/ACK semantics; no existing implementation is claimed. R1 also confirmed transport currently reads response.text() and parses outer/inner JSON before reviewer validation; corrected trusted profile options distinguish bounded wire bytes from decoded model-content bytes and preserve uncertain/observed accounting. Quality-required tiers now exclude the separately gated real-restart R18 until full-feature aggregation.

The agent-context extension config/script named by speckit-agent-context-update are absent; `rg --files --hidden .specify` found no relocated update-agent-context script. No replacement script/config was fabricated. The speckit-plan skill's explicit managed-marker update was performed directly, preserving every existing feature entry; writing-for-agents guidance applied. Context content otherwise needed no implementation-status change.
