# Feature Specification: UC-06 — Reviewer Agent

**Feature Branch**: `feat/uc06-reviewer-planning`
**Created**: 2026-11-12 (Asia/Saigon)
**Status**: Planning/review only; [decisions](contracts/decisions.md) govern release. No runtime implementation authorized.
**Input**: Product reviewer checks a diff against requirements, acceptance criteria, repository conventions and verification evidence, returning located, reasoned findings under shared read-only authority and finite accounting.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Inspect an evidence-backed review (Priority: P1)

As a developer receiving a proposed repair, I see a review of the verified candidate or a precise reason review could not finish, with findings I can locate and assess.

**Why this priority**: A judgment must refer to the actual change and agreed behavior.
**Independent Test**: Supply independently labeled clean and faulty textual changes with current passing verification; observe structured results, exact candidate binding and no repository effects. Deterministic responses test handling; actual model detection is evaluated separately.

**Acceptance Scenarios**:

1. **Given** a verified candidate, requirements, conventions and admitted reviewer, **When** review starts, **Then** inspect that bounded context and return accepted, findings, or invalid/incomplete with safe reasons.
2. **Given** a finding, **When** delivered, **Then** identify file, changed line, old/new side, corresponding revision, severity, supporting evidence and rationale explaining a behavioral consequence or violated criterion/convention.
3. **Given** no actionable findings, **When** accepted, **Then** acceptance describes only the inspected candidate; it does not certify the repository or itself complete the repair.
4. **Given** missing/failed verification or stale repository, diff, criteria, check set, conventions, context or approval, **When** review starts, **Then** refuse before model dispatch and identify the gap.
5. **Given** wrong file/line/side/revision, absent/unresolvable evidence, malformed/contradictory or oversized output, **When** validated, **Then** reject the whole review, retaining actual provider charges.
6. **Given** candidate/authority changes during review, **When** a response arrives, **Then** retain charged observation but withhold current review/completion evidence.

### User Story 2 - Keep review read-only and bounded (Priority: P1)

As a developer, I trust review cannot mutate my repository or turn hostile content into permissions.

**Why this priority**: Authority and finite spend are prerequisites for every review.
**Independent Test**: Inject instructions/forbidden proposals through the actual reviewer and shared model ingress with explicit finite profiles, effect spies and owner accounting doubles.

**Acceptance Scenarios**:

1. **Given** source/diff/conventions/log instructions to patch, install, execute, disclose secrets or inspect private judging, **When** reviewed, **Then** treat them as data, expose no such capability and reject forbidden proposals without effects/disclosure.
2. **Given** missing/exhausted bounds/accounting, stale admission, pause/rejection or unresolved usage, **When** another review starts, **Then** make zero new constrained provider/tool calls.
3. **Given** invalid response, timeout or uncertain settlement after possible dispatch, **When** stopped, **Then** retain consumption/reservations and safe reasons without automatic retry/refund/acceptance.
4. **Given** duplicate/conflicting requests or another run for the task, **When** admitted/recovered, **Then** retain one logical request chain and cumulative reviewer/token/cost limits; task-wide waits stop reviewer background work.

### User Story 3 - Repair findings and evaluate quality honestly (Priority: P2)

As a developer, I see findings inform bounded repair and distinguish verified handling from measured reviewer quality.

**Why this priority**: Closing findings requires a newly verified candidate; quality needs an independent oracle.
**Independent Test**: Drive review → repair → verify → review through controlled graph ports, and grade against independently labeled cases. Real-provider and restart witnesses have separate gates.

**Acceptance Scenarios**:

1. **Given** actionable findings and remaining authority, **When** repaired, **Then** consume findings as evidence, obtain fresh action/plan authority when needed, invalidate affected checks/review and verify before a new admitted review.
2. **Given** exhausted repair/review allowances or stale/rejected authority, **When** another cycle is proposed, **Then** stop incomplete with no extra effect; old acceptance cannot close a changed candidate.
3. **Given** interruption around reservation, dispatch, settlement or result persistence, **When** restored, **Then** preserve reviewer iterations, task tokens/costs and original pricing, reconciling uncertainty before retry.
4. **Given** clean/faulty independent labels, **When** graded, **Then** report true/false findings and missed faults against frozen criteria with model/configuration/tier identity and explicit not-run cases.

### Edge Cases

- Empty, binary, rename/copy, mode-only, malformed/ambiguous-path/hunk or unsupported-dialect diffs return unsupported/incomplete in this first scope.
- Add/delete findings use real changed new/old lines. Unchanged context lines cannot anchor findings; revision comes from trusted binding.
- Oversized or materially truncated required evidence blocks review; optional omissions are identified. No silently partial candidate.
- Info-only findings may accompany accepted; error/warning findings block it. Invalid output is not clean.
- Late responses after drift/pause/cancellation stay non-authoritative; observed and unknown usage remain distinct.
- Same-process reconstruction/scripted acceptance proves neither restart nor real-model quality.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Trigger only from existing post-verification UC-03 review. Bind task/run/repository/workspace, measured base/head, exact diff, criteria, check set/results, conventions, context, reviewer profile and current owner authority.
- **FR-002**: Supply bounded approved requirements, criteria, conventions, diff and verification with source/revision/content provenance; missing/stale/unsafe/incomplete required context prevents dispatch.
- **FR-003**: Produce bounded structured findings with file/changed line/side/revision, `error|warning|info`, rationale and resolvable evidence; validate locations against actual changed lines.
- **FR-004**: Reject unsupported input, unknown output fields, actions, unsupported evidence, invalid locations, contradictions and bound violations without partial acceptance.
- **FR-005**: Reuse existing reviewer/provider/accounting. No parallel reviewer, model adapter, approval service, ledger, persistence or evaluation runner.
- **FR-006**: Enforce read-only review: no patch/write/delete, arbitrary command/test execution, install, commit/push, external messaging, credentials/hidden grading or model-controlled tool dispatch.
- **FR-007**: Require current admission/control/approval and finite review/time/input/output/token/cost limits. Task pauses/rejections stop reviewer work; consent cannot grant forbidden writes.
- **FR-008**: Preserve one owner claim/attempt/outcome chain per logical call, charge malformed/invalid/uncertain outcomes correctly, and reset no task allowance on retry/run/repair/recovery.
- **FR-009**: Revalidate mutable bindings before dispatch and result/completion acceptance. Drift invalidates use without erasing usage; fencing/immutable snapshots close races beyond post-checking.
- **FR-010**: Feed actionable findings into existing bounded repair, verify/review again after changes and leave completion to the harness.
- **FR-011**: Evaluate clean/faulty/attack/failure/recovery cases using independent labels and false-positive/false-negative measures; separate unit, controlled graph, real provider, integrated workflow, model quality and process-restart evidence.
- **FR-012**: Record bounded sanitized metadata, binding/evidence refs and observed/uncertain usage; exclude prompts, source bodies, raw streams, credentials, hidden reasoning and private labels from traces/reports.
- **FR-013**: Preserve predecessor acceptance ownership and canonical compatibility; version additions, obtain shared-owner agreement before changes and leave implementation unchecked until its own evidence passes.

### Key Entities

- **Review context**: Immutable candidate, requirements, conventions, verification and approved evidence identities.
- **Finding**: Changed location/side, severity, rationale and supporting evidence.
- **Observation**: Bound judgment, tier, provider/accounting refs, current/stale disposition and safe failure.
- **Independent label/grade**: External expected defects/clean status, inaccessible to reviewer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every delivered review identifies the exact candidate/required inputs; every stale/missing vector withholds dispatch or current acceptance as appropriate.
- **SC-002**: All specified invalid-location/evidence/output and attack cases prevent accepted review and unauthorized effects; every delivered finding resolves to changed line/evidence.
- **SC-003**: Every timeout, invalid-response, duplicate and exhaustion case retains correct accounting with zero unapproved retries/resets.
- **SC-004**: A controlled findings journey reaches new verification/review or stops under remaining authority; no stale acceptance completes a changed candidate.
- **SC-005**: Every required labeled case has an independent grade or not-run reason and explicit tier. Real quality uses the frozen [rubric](contracts/evaluation.md); scripted passes establish no model quality.
- **SC-006**: Actual process-termination witnesses preserve reviewer/token/cost charges and uncertainty with no duplicate dispatch; missing prerequisites leave this criterion not-run.

## Assumptions

First proposed scope is UC-03 only: no standalone review, PR bot, GitHub integration, new CLI/UI or autonomous reviewer exploration. UC-06 owner is unassigned; Tai retains foundation/reviewer/evaluation, Thanh Tan accounting/recovery, Trong Tan approval. Numeric production profiles remain explicit external approvals. Constitution is an unratified template; existing repo policy/ADRs govern.
