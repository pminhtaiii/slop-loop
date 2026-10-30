# Feature Specification: UC-01 Evidence-backed Issue Triage

**Feature Branch**: `feat/012-uc01-issue-triage-specs`

**Created**: 2026-10-17 (Asia/Bangkok)

**Status**: Existing artifact baseline and T001 consumer/fixture agreement approved on 2026-10-18; T001–T010 complete at the controlled local level. The user separately authorized Phase 5 T009–T010 on 2026-10-19 (Asia/Bangkok); see [decisions](contracts/decisions.md). T014 safety regression consolidation was separately authorized on 2026-10-20 (Asia/Bangkok) and is complete at the controlled local level. T013 is separately authorized on 2026-10-28 for the versioned UC-03 receiver contract; T011/T012, T015/T016 and real execution remain separately gated.

**Input**: One supplied issue for one selected repository; assess classification, severity, evidence, material unknowns and a configured backend recommendation.

## User Scenarios & Testing *(mandatory)*

The [2026-10-30 delegated decision](contracts/decisions.md#delegated-t011t015-authority--2026-10-30) releases T011/T015 implementation and technical amendments. Earlier status restrictions are historical for those tasks. Implement all available composition and shared-evaluation behavior, preserve fail-closed production admission and frozen evaluation identities, and leave incomplete acceptance unchecked. This scope supplies no fabricated runtime or model-quality result.

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
- **FR-015**: Design versioned cases, expected outcomes and grading rules before each authorized implementation slice. Run applicable contract/behavior/safety checks immediately after that slice, then impacted regression checks; retain results, traceable evidence, limits and failure analysis before task acceptance. Unavailable checks are not-run with an explicit blocker, never passed by omission.
- **FR-016**: Keep contract, mock behavior, real integration, held-out model quality and project evaluation separate. Reuse stable UC-scoped case definitions and isolated results through Tai's future shared evaluation interface; no independent competing runner or claim of implemented shared registration.

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
- **SC-006**: Prepare a labeled held-out corpus before feature implementation, with at least five classification examples covering clear defect, feature request, ambiguity, irrelevant content and malicious instructions. Before real-runtime acceptance, approve corpus/rules and remaining thresholds, then compare at least two equivalent real-model evaluation runs. Classification accuracy must reach at least 80% under the user-supplied SE373 floor, with full required execution, separate safety gates, severity/clarification/destination metrics, latency, tokens and cost. Fixture passes establish no model quality or runtime verification.
- **SC-007**: Every slice retains applicable results and regression evidence before acceptance; every required unrun case has status, reason and an execution condition. The same versioned UC-01 cases must support scoped selection and future shared-project registration without cross-UC execution, ID collision, result overwrite or a false project pass when a required UC fails or is missing.

## Assumptions

- [ADR-0005](../../docs/adr/0005-uc01-triage-boundary-and-assessment.md) is accepted; consumer contracts/task paths are approved at T001; later delivery gates remain separate.
- Application supplies authorized repository, catalogs and caller context; issue text never chooses host paths or policy.
- Classification defaults, provider/model, numeric production limits and deployment interface remain owner decisions. Test examples are not defaults.
- Technical readiness and permission to implement are separate: T001–T010 are complete under their separate user authorizations, and T014 was separately authorized on 2026-10-20; T011–T013 and T015–T016 require separate authorization.
- The current user reports leader agreement to evaluation-first incremental delivery; this approves a direction, not the proposed evaluation schema, new authority or runtime implementation. See [evaluation contract](contracts/evaluation.md) and [decision/source gaps](contracts/decisions.md). The two original coursework Markdown documents were not available for independent verification; supplied minima are used explicitly, not presented as independently checked quotations.

## Scoped receiver amendment — 2026-10-28

On 2026-10-28 (Asia/Bangkok), the user reported Tai had delegated full implementation and technical decisions within UC-03 T011 → T012 → UC-01 T013, including required specification/contract amendments. This releases only that sequential batch, its tests, independent review, context refresh and contributor publication. It supersedes earlier unreleased wording only for these tasks. No real LLM/provider, UC-04/UC-05 implementation, dispatch, automatic repair, production choices or other successor work is authorized.

T013 may exercise the actual delivered UC-03 receiver using the additive [uc01-uc03-receiver-v1 contract](../001-verified-code-repair/contracts/uc01-receiver.md). FR-008/FR-009 boundaries remain: UC-01 recommends only; caller-supplied reproduction/criteria and UC-03 intake decide admissibility. C21 proves receiver compatibility independently of unavailable real shared adapters and without changing frozen model-evaluation cases.
