# Feature Specification: Contributor CI and Mutation-Guided Test Quality

Current OS scope: the [2026-10-30 Ubuntu-only amendment](contracts/ubuntu-only.md) supersedes the dual-OS design below for the bounded replacement. Earlier task evidence remains historical.


**Feature Branch**: Planning in the existing checkout; implementation branches follow repository naming rules.
**Created**: 2026-10-28 (Asia/Saigon)
**Status**: Planning quality gate passed; implementation approval pending.
**Input**: Separate CI responsibilities so failures are easy to trace, retain required verification, add a manual mutation report, and strengthen meaningful surviving-mutant tests without chasing every survivor.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Understand and trust required checks (Priority: P1)

A contributor can identify whether a failure concerns lint, types, policy, build, contributor tooling or product-runtime behavior. A maintainer sees directly required named checks rather than a single aggregate result.

**Why this priority**: Clear diagnostics must preserve existing verification and merge safety.
**Independent Test**: A controlled candidate runs the same complete behavioral test inventories on both supported platforms; failing each check independently yields a non-ready result and identifies its responsibility.
**Acceptance Scenarios**:
1. **Given** a candidate revision, **when** CI runs, **then** static, policy, build, contributor-tooling and runtime results are separately visible, with Linux/Windows behavioral coverage retained.
2. **Given** a missing, pending, failed, skipped, cancelled, stale-head, foreign-application or superseded successful check, **when** readiness is assessed, **then** it remains non-ready under the applicable policy.
3. **Given** a historical merged resolving revision, **when** paired-ticket completion is assessed, **then** its explicitly bound historical check policy remains usable, while a new revision cannot select that policy.

### User Story 2 - Keep repository and PR inputs reviewable (Priority: P1)

A maintainer receives useful failures for prohibited environment files, unsafe examples, secret findings and invalid PR metadata, without exposing credential values.

**Why this priority**: A green test suite is insufficient when repository contents or review metadata violate contributor rules.
**Independent Test**: Synthetic tracked-file and PR-event fixtures exercise filename/content rules and metadata changes without reading local env files or writing to GitHub.
**Acceptance Scenarios**:
1. **Given** a prohibited environment file at any depth, including an ignored file force-added to a candidate, **when** policy runs, **then** it fails without logging the file's values; only the exact example basename `.env.example` may qualify.
2. **Given** an example with an unsupported value or a detected credential elsewhere in the candidate, **when** checks run, **then** the result fails with redacted diagnostics; approved placeholder examples pass.
3. **Given** a draft or review-ready PR with invalid target, branch, title or required description sections, **when** it is opened or edited, **then** metadata validation fails. A newly-invalid body also blocks fresh readiness before its edited-event CI starts.

### User Story 3 - Run an interpretable mutation experiment (Priority: P2)

A maintainer manually requests a bounded telemetry mutation report tied to the selected revision, with useful artifacts and distinct failure categories.

**Why this priority**: The exercised pilot demonstrates value, but scores and timeout settings need interpretation before enforcement.
**Independent Test**: A manual experiment records source/test/config identity and outcomes, verifies actual mutated code execution, and cannot become a required merge check.
**Acceptance Scenarios**:
1. **Given** a normal push or PR, **when** required CI runs, **then** it does not start mutation testing or enforce a mutation threshold.
2. **Given** a manual telemetry run, **when** the baseline passes, **then** the report identifies scope, counts, elapsed time and artifacts. Surviving mutants alone do not fail the workflow.
3. **Given** baseline, instrumentation, worker, timeout-budget or artifact failure, **when** the experiment cannot complete, **then** it reports incomplete/failed execution rather than a successful quality result.

### User Story 4 - Strengthen tests for meaningful survivors (Priority: P2)

A contributor uses mutation evidence to improve public-boundary assertions, documenting equivalent or unresolved changes instead of forcing all mutants to die.

**Why this priority**: Test improvements should detect incorrect behavior while preserving intended behavior and maintainable assertions.
**Independent Test**: The exact-byte-limit telemetry test passes on the original implementation and fails by assertion against its previously surviving boundary mutation.
**Acceptance Scenarios**:
1. **Given** a fitting diagnostic and its exact byte limit, **when** sanitization runs, **then** content and byte count are preserved and truncation is false; changing the boundary comparison is detected.
2. **Given** a selected survivor, **when** it is reviewed, **then** its disposition is meaningful, equivalent/redundant, harness-related, or explicitly unresolved/out of scope, with evidence.
3. **Given** equivalent changes or unreviewed survivors outside the selected batch, **when** work is handed off, **then** they remain visible and no whole-suite correctness or 100% score claim is made.

### Edge Cases

- Body-only edits at an unchanged commit; late reruns and stale artifacts; unavailable checks or remote protection reads.
- Source/emission mismatches, orphan or duplicate tests, failed builds and OS-specific artifacts.
- Mixed-case and nested env names, symlinked examples, malformed/binary/oversized examples, scanner unavailability and synthetic credential fixtures.
- Old merged PRs, reopened historical identities, same commit under a different PR, and missing policy bindings.
- Timeouts that become survivors under unchanged-test retries; stale report IDs; scope changes between before/after runs; equivalent mutants.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: CI MUST expose directly named static, policy, build and behavioral checks, retaining complete Linux/Windows behavioral inventories and source/emission parity.
- **FR-002**: Required-check identities MUST have one shared definition; every readiness consumer MUST preserve exact-revision, trusted-application, latest-rerun and completed-success requirements.
- **FR-003**: Check-name rollout MUST preserve existing requirements until externally verified replacement, retain explicitly bound historical merged-head evidence, and refuse arbitrary old-or-new fallback.
- **FR-004**: Repository policy MUST reject prohibited tracked environment files, admit only qualified `.env.example` files, scan candidate content for known secret patterns, and redact findings.
- **FR-005**: Metadata checks MUST enforce the existing contributor conventions on drafts and ready PRs, revalidate edits, and preserve explicitly identified historical convention compatibility.
- **FR-006**: Local readiness MUST validate current live metadata in addition to check results, including body changes at the same revision.
- **FR-007**: Mutation testing MUST be manual and report-only, bounded to a named telemetry profile, with revision-bound artifacts and distinct setup/execution/outcome reporting.
- **FR-008**: Mutation-guided test work MUST show original-pass/exact-mutant-assertion-failure evidence for claimed improvements and explain each reviewed survivor's disposition.
- **FR-009**: The first test-improvement slice MUST cover exact-byte-limit preservation; later slices MUST stay at the agreed sanitizer/truncation boundaries and use an explicit selected batch.
- **FR-010**: The work MUST preserve human merge decisions, paired-publication privacy, current production-runtime authorization gates and the existing sole local full publication-gate runner.
- **FR-011**: Reports MUST identify scope and comparability limits; timing noise, invalid execution and equivalent mutants MUST NOT be presented as proof of test adequacy.
- **FR-012**: Planning and implementation MUST leave the user's local env files unread; policy tests use synthetic fixtures, and future CI inspects candidate tracked content only.

### Key Entities

- **Check policy**: A named set of directly required check identities and its permitted use.
- **Candidate observation**: Revision, current metadata, check results and verification time used for readiness.
- **Historical binding**: Explicit public PR/revision/tree identity permitting a historical evidence policy.
- **Mutation experiment**: Bounded scope, input identity, settings, results and artifact completeness.
- **Survivor disposition**: A reviewed mutation's behavior, classification, evidence and follow-up.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every required responsibility has an individually visible result; each independently injected failure produces a non-ready assessment.
- **SC-002**: All selected behavioral test files execute exactly once inside each new canonical platform lane, with no lost/orphan emission admitted; durations and artifacts are retained. Transitional old lanes deliberately duplicate complete suites and are accounted separately until verified cleanup removes them.
- **SC-003**: All synthetic prohibited-file, unsafe-example, detected-secret and invalid-metadata cases fail without credential values in output.
- **SC-004**: New revisions cannot qualify using historical checks; explicitly bound historical merged revisions remain assessable; migration evidence preserves existing strict/admin controls.
- **SC-005**: A manual mutation run produces a complete revision-bound report or an explicit failure, and normal PR/push events launch zero mutation runs.
- **SC-006**: The exact-limit gap is detected by a behavioral assertion; every reviewed mutation in the chosen remediation batch has an evidence-backed disposition. No minimum score or requirement to adjudicate every survivor is imposed.

## Assumptions

- This is contributor-quality work for this repository, not a new capability for the product runtime's target repositories.
- Existing test selection and contributor conventions remain authoritative. Shard counts are deferred until timing evidence justifies a separate change; the initial split uses responsibility and OS boundaries.
- The first mutation CI profile covers the telemetry module; the earlier 61.71% result covers only an excerpt and is not a directly comparable whole-module baseline.
- Changing live protections, publishing workflows to the default branch, implementation and merging require their applicable subsequent authorization. This request authorizes planning and independent planning review only.
- The placeholder constitution is not ratified policy; current repository instructions govern this design.
