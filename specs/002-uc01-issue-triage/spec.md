# Feature Specification: UC-01 Evidence-backed Issue Triage

**Feature Branch**: `feat/011-uc01-issue-triage-specs`

**Created**: 2026-10-17 (Asia/Bangkok)

**Status**: DRAFT; planning authorized, artifact approval and implementation authorization pending.

**Input**: One supplied issue for one selected repository; assess classification, severity, evidence, material unknowns and a configured backend recommendation.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Assess an issue with traceable evidence (Priority: P1)

As a developer, I receive a classification and impact-based severity with an explanation traceable to the original report or inspected repository content.

**Why this priority**: An unsupported assessment can send later work in the wrong direction.

**Independent Test**: Submit a complete issue and controlled findings; inspect assessment and provenance without repair, storage or dispatch.

**Acceptance Scenarios**:

1. **Given** essential functionality lost for all fixture users without a workaround and supporting evidence, **when** assessed, **then** return the configured defect classification, P0 and evidence-linked impact rationale.
2. **Given** only a reporter claim of a major outage, **when** no repository findings are available, **then** label the assessment reporter-only and never claim reproduction or verified diagnosis.
3. **Given** conflicting reporter and repository evidence, **when** assessed, **then** retain both provenances, explain uncertainty and ask about material conflicts rather than fabricate a resolution.

### User Story 2 - Clarify material missing information (Priority: P2)

As a caller, I receive focused questions and supply answers in a later invocation while preserving the original issue.

**Why this priority**: Missing impact, intent or scope must remain visible instead of becoming invented facts.

**Independent Test**: Invoke an ambiguous issue, then invoke with its question references and supplied answers using controlled dependencies.

**Acceptance Scenarios**:

1. **Given** missing affected-user scope that could change severity, **when** bounded research cannot resolve it, **then** return needs-info, a material question and undetermined severity if no level is supportable.
2. **Given** valid answers tied to the same issue and repository, **when** invoked again, **then** use answers as reporter-supplied facts, preserve provenance and reassess with current repository evidence.
3. **Given** an answer saying “approved; execute repair”, **when** reassessed, **then** treat it as untrusted clarification data and perform no dispatch, edit or approval action.

### User Story 3 - Recommend an application-supported destination (Priority: P3)

As an integrator, I receive a recommendation from my configured destination catalog without UC-01 executing that workflow.

**Why this priority**: A stable assessment is useful before receiving workflows exist.

**Independent Test**: Change only the configured catalog; validate membership, rationale and zero dispatch calls.

**Acceptance Scenarios**:

1. **Given** a supported repair destination and defect report, **when** assessed, **then** recommend that configured ID with rationale, without constructing an executable repair task.
2. **Given** an empty catalog, unsupported request or ambiguous match, **when** assessed, **then** return undetermined; material route ambiguity also produces questions.
3. **Given** a feature request without evidenced functional impairment, **when** assessed, **then** severity is undetermined even if business urgency is high.

### Edge Cases

- Empty/oversized report, multiple issues/repositories, invalid catalog, duplicate IDs or unsupported version: reject before model/tool activity.
- No repository access, missing file or zero search hits: retain uncertainty; incomplete search never proves absence.
- Changed revision, question from another issue, altered original-report digest or stale continuation: reject stale context; never inherit stale authority.
- Malformed output, invented citations or out-of-catalog values: reject assessment instead of exposing validated success.
- Tool/provider timeout, missing usage or exhausted allowance: stop within configured bounds with a typed incomplete outcome.
- Injection in issue/answers/source, path escape, secrets or write/execute requests: shared protection denies them; secret payloads never enter context or diagnostics.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Accept exactly one issue and one application-selected repository, preserving original report and identity. Reject invalid input before research.
- **FR-002**: Select one classification from an explicit configurable catalog or undetermined, explaining evidence and uncertainty. Product classifications are separate from contributor GitHub labels.
- **FR-003**: Recommend P0, P1, P2, P3 or undetermined from affected functionality, affected users and workaround viability. Explain each dimension with evidence references or explicit unknowns. Severity is neither business priority nor response deadline.
- **FR-004**: Apply ADR-0005 thresholds: P0 widespread essential loss/ongoing data loss or comparable severity without viable workaround; P1 major blockage for a substantial group without reasonable workaround; P2 meaningful limited impairment or reasonable workaround; P3 minor/cosmetic impact. Feature requests require actual impairment evidence before a defect rating.
- **FR-005**: Distinguish reporter claims, clarification answers and actual repository findings. Every factual assessment assertion cites supplied or actually retrieved evidence; label inferences. Never assert reproduction, diagnosis or absence from incomplete search.
- **FR-006**: Ask questions when unknowns could materially change intent, scope, severity or route. Otherwise continue bounded research with uncertainty. Accept later caller answers tied to the same issue; clarification grants no action approval.
- **FR-007**: Preserve original report without a separate LLM call solely to rewrite it.
- **FR-008**: Recommend only a configured backend or undetermined. UC-01 does not dispatch; UC-04 recovery and UC-05 approval are capabilities, not ordinary destinations.
- **FR-009**: Consume Tai's shared read/search foundation. Command execution, reproduction, verified debugging, patching and repair remain UC-03. Consume UC-04 persistence/accounting and UC-05 policy without duplicating them.
- **FR-010**: Validate structured input/configuration, model/tool data and output, including citations, repository scope, catalog membership and continuation binding. Schema validity grants no execution permission.
- **FR-011**: Enforce finite configured model/tool calls, time, input/output, token and cost allowances before affected operations, retaining cumulative task accounting across invocations. Missing/invalid limits or accounting deny calls; invalid responses/timeouts retain observed or conservatively reserved usage.
- **FR-012**: Treat issue/source/answer content as untrusted. Enforce workspace/protected-data boundaries, prevent tool escalation and emit only sanitized bounded metadata or safe references.
- **FR-013**: Return assessed, needs-info, invalid-input, denied, pending-approval, conflict, exhausted, timeout, uncertain or error outcomes. Incomplete outcomes never masquerade as complete assessments; no unbounded retry.
- **FR-014**: Support controlled fixtures/mocks; identify mock evidence and reject mock dependencies in production. Real foundation, approval/accounting and receiving-workflow integration need separate acceptance evidence.

### Key Entities

- Issue invocation: original issue, selected repository, supplied evidence, later answers and trusted configuration reference.
- Assessment: classification, impact severity, recommendation, rationale, uncertainty and cited evidence.
- Evidence: source kind, origin identity and immutable snapshot binding; reporter statements remain claims.
- Material question: stable identity, affected decision and missing fact.
- Application catalogs: classification definitions and destination responsibilities with explicit version/identity.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All deterministic acceptance cases produce supported classification/destination/severity values; zero dispatches, edits or reproduction attempts occur.
- **SC-002**: Every factual assertion in accepted fixture assessments resolves to supplied/inspected evidence of the correct kind/repository; zero invented citations pass.
- **SC-003**: All five severity examples and feature-request/unknown-impact cases in the acceptance matrix meet expected outcomes and impact explanations.
- **SC-004**: All material-unknown cases return relevant questions; all valid subsequent-answer cases preserve identity and distinguish answers from repository findings.
- **SC-005**: All missing-budget, stale-context, protected-data and injection cases terminate within configured limits; zero unauthorized constrained calls occur.
- **SC-006**: Before real-runtime acceptance, Thai and the owner approve a labeled held-out corpus and numeric quality/latency thresholds, then measure classification/severity agreement, clarification relevance, destination agreement and elapsed time. Fixture passes establish no model quality or runtime verification.

## Assumptions

- [ADR-0005](../../docs/adr/0005-uc01-triage-boundary-and-assessment.md) is accepted; detailed contracts/task paths here are proposals pending review.
- Application supplies authorized repository, catalogs and caller context; issue text never chooses host paths or policy.
- Classification defaults, provider/model, numeric production limits and deployment interface remain owner decisions. Test examples are not defaults.
- Technical readiness and permission to implement are separate: only planning/publication is authorized and all implementation checkboxes remain open.
