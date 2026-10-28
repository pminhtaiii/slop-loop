# Feature Specification: Paired PR Eligibility Preview

**Feature Branch**: `feat/tooling-paired-merge-eligibility`
**Created**: 2026-10-28 (Asia/Saigon)
**Status**: Planning reviewed; bounded dry-run implementation authorized
**Input**: Build a system for eligible paired PRs, beginning with a dry-run documentation-only evaluator. The user approved this first scope on 2026-10-28.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Explain documentation eligibility (Priority: P1)

As the coordinator, I want one read-only report explaining whether a published pair meets the initial documentation policy, so I can evaluate that policy before enabling any automatic merging.

**Why this priority**: The first useful result is a reproducible decision with concrete reasons; merging requires a later authorized scope.
**Independent Test**: A controlled eligible pair produces an eligible preview; changing one eligibility condition produces a refusal with a reason, while local and remote state remain unchanged.

**Acceptance Scenarios**:

1. **Given** a synchronized, open, non-draft pair against the current development bases, passing required public checks, and only ordinary prose changes in the initial documentation allowlist, **When** preview runs, **Then** it reports documentation eligibility, the observed revisions, and automatic merging disabled.
2. **Given** a changed script, test, dependency, governance document, fenced example, or unsupported file operation, **When** preview runs, **Then** it reports manual review with the failed policy reason.
3. **Given** missing publication accounting, failed checks, incomplete evidence, a stale base, or mismatched source trees, **When** preview runs, **Then** it cannot report eligible.
4. **Given** either PR, a required check, publication accounting, or the checkout changes during inspection, **When** the final comparison runs, **Then** preview reports changed evidence and requests a fresh evaluation.

### Edge Cases

- Empty diffs, renamed/deleted/type-changed files, symlinks, executable files, binary or invalid text, and oversized inputs receive manual review.
- Historical submission/main pairs remain readable by existing workflows but are outside this initial eligibility policy.
- A draft, closed, cross-repository, conflicted, behind, blocked, or unknown-mergeability PR is ineligible, including on the submission side.
- Missing local immutable objects or unavailable remote reads yield an incomplete-evidence report without fetching or changing records.
- Public and submission commits have different ancestry; eligibility compares their source trees and classifies only the public change.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Preview MUST inspect only the pair already identified by retained publication accounting for the current checkout and branch, checking both repository identities and configured development targets.
- **FR-002**: Preview MUST bind its result to both PR identities, heads, bases, matching source trees, policy version, and required public check observations. The checkout head must equal the retained and live public head.
- **FR-003**: Preview MUST require all four existing public required checks to pass for that exact public head; submission checks remain informational and are not a substitute.
- **FR-004**: Preview MUST apply the narrow path, operation, text, and content rules in [the eligibility contract](contracts/eligibility.md). Unknown classifications require manual review.
- **FR-005**: Preview MUST reobserve its inputs before returning eligible and refuse changed or unavailable evidence.
- **FR-006**: Preview MUST return a bounded explanation and observable snapshot, distinguish manual review from incomplete readiness, and always state that merging is disabled.
- **FR-007**: Preview MUST perform no local writes, record creation, fetch, remote writes, readiness changes, or merges. It MUST leave existing publication and human merge policy intact.
- **FR-008**: Controlled tests MUST cover positive, negative, stale/racing evidence and zero-write behavior; a passing fixture establishes only its exercised behavior.

### Key Entities *(include if feature involves data)*

- **Published pair**: The retained identities and source provenance linking the public and submission PRs.
- **Observation snapshot**: The revisions and check evidence inspected during one preview.
- **Eligibility report**: The category, decision, reasons, and snapshot; it supplies no action authority.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every listed acceptance and edge-case fixture has an explicit eligible or ineligible result and a reason.
- **SC-002**: Every eligible report identifies both observed PR revisions and their base revisions; changing any bound input during inspection prevents eligibility.
- **SC-003**: All preview fixtures leave retained files, checkout contents and remote mutation counters unchanged.
- **SC-004**: The coordinator can distinguish a documentation policy rejection from missing or pending evidence without reading raw command output.

## Assumptions

- Existing authenticated read access and retained paired publication records are prerequisites.
- The initial allowlist is deliberately smaller than all Markdown files; governance and agent instructions remain human-reviewed.
- Text filtering is a conservative lexical boundary, not a proof that prose is correct or harmless.
- Mechanical refactors, module graph analysis, coverage comparison, mutation testing, automatic merge execution, and partial-merge recovery are future separately authorized work.
