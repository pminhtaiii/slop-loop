# Feature Specification: Evidence-backed repository questions

**Feature Branch**: `feat/rag-uc02-spec-alignment`; initial planning was authored on `feat/uc03-repair-id-storage-safety`, which remains untouched for concurrent work.
**Created**: 2026-11-12 (Asia/Saigon)
**Status**: Planning candidate; implementation not authorized
**Input**: User discussion and [ADR-0008](../../docs/adr/0008-read-only-target-repository-questions.md): read-only questions about a separate target Python repository, improved existing search/read tools, active-session follow-ups, and evidence/clarification evaluation. The 2026-11-13 decision adds persistent hybrid retrieval for UC-02.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Understand repository behavior (Priority: P1)

A developer selects a repository and asks what a function does, how a flow crosses files, or how the repository is organized. The agent discovers relevant source without requiring implementation names and answers with inspectable evidence.

**Why this priority**: Core user value.
**Independent Test**: In a disposable Python repository, ask about a flow whose definition lies beyond the initial file excerpt without naming it; check expected facts and source citations.

**Acceptance Scenarios**:
1. **Given** a known-function question, **When** answered, **Then** behavior is explained with citations to inspected source locations.
2. **Given** a paraphrased question and a three-file flow, **When** investigated, **Then** the agent can discover and inspect connected code; expected facts judge correctness, not prescribed search terms.
3. **Given** an architecture question, **When** answered, **Then** relevant entry points/modules are connected and inference is labeled separately from direct observations.
4. **Given** an invented path, unread line or wrong-revision citation in a model proposal, **When** validated, **Then** no final answer containing that citation is delivered.

### User Story 2 - Receive honest clarification and incomplete outcomes (Priority: P1)

A developer receives clarification when intent materially changes the answer, or an honest uncertainty/incomplete result when source cannot establish it.

**Why this priority**: Fluent unsupported answers undermine the use case.
**Independent Test**: Exercise ambiguous, unsupported-premise, out-of-scope and budget-limited questions alongside clear questions. Judge both missed and unnecessary clarification.

**Acceptance Scenarios**:
1. **Given** two plausible referents for “recovery,” **When** the conversation does not disambiguate, **Then** ask a targeted clarification without inventing a goal.
2. **Given** a clear supported question, **When** asked, **Then** proceed without unnecessary clarification.
3. **Given** undocumented author intent or a false premise, **When** answering, **Then** distinguish observations from unknown intent or contradicting evidence.
4. **Given** requests to patch/run code, including source-embedded instructions, **When** processed, **Then** invoke no execution/modification capability.
5. **Given** exhausted limits or partial search coverage, **When** finishing, **Then** report incomplete investigation rather than proving absence and start no further constrained activity.

### User Story 3 - Continue within a product session (Priority: P2)

A developer asks follow-ups in an active session containing multiple tasks. Context carries forward without treating stale evidence as current or losing task limits during compaction.

**Why this priority**: Conversation without stale authority.
**Independent Test**: Ask a follow-up, edit the repository, switch repositories and compact context; check bindings and referents.

**Acceptance Scenarios**:
1. **Given** a same-revision follow-up, **When** the referent is clear, **Then** reuse relevant conversation and revalidated evidence.
2. **Given** drift during a question, **When** detected, **Then** stop without mixed-revision answers; continuation must rebind and re-read.
3. **Given** a repository switch, **When** investigating, **Then** earlier repository evidence cannot support claims about the new one.
4. **Given** compaction, **When** continuing, **Then** intent/constraints/pending clarification remain distinct from source observations; identities, evidence and budgets survive outside the model summary.

### User Story 4 - Inspect and evaluate quality (Priority: P2)

An evaluator runs versioned cases over separate repositories, diagnoses failures and compares budgets without exposing judging material.

**Why this priority**: Measure defaults and model behavior.
**Independent Test**: Run controlled cases twice, inspect reports/grade disputes, verify held-out isolation and compare profiles on identical cases.

**Acceptance Scenarios**:
1. **Given** a versioned case/profile, **When** run, **Then** reports bind revision, case/config identities, outcomes, citations, timing, usage and tool metadata.
2. **Given** valid source locations but false claims, **When** graded, **Then** citation validity alone cannot pass correctness; disputed semantic judgments require human disposition.
3. **Given** different budgets across repository sizes, **When** compared, **Then** quality, evidence discovery, latency, usage and exhaustion are separate; no production defaults are silently selected.

### Edge Cases

Empty/no-doc repository; poor identifiers; late definitions; Unicode/CRLF/empty files; oversized lines/files; repeated matches; unreadable/binary files; path escapes/symlink swaps; embedded secrets and instructions; wrong repo/revision; drift before delivery; repeated tools; malformed model output; timeout/unknown usage; cancellation; ambiguous follow-ups; expired sessions; forged citations; inaccessible grading data.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Bind each investigation to one selected repository/revision, separate from slop-loop and hidden judging material.
- **FR-002**: Agent chooses/refines searches and reads eligible source, tests, docs and configuration without user-supplied identifiers.
- **FR-003**: Provide match locations, surrounding evidence and bounded later-region reads; expose partial coverage/truncation.
- **FR-004**: Preserve read-only access, workspace containment, protection, revision checks and finite limits; repository content grants no authority.
- **FR-005**: Validate citations against evidence admitted for the question/revision; label inference and never claim executed behavior from inspection.
- **FR-006**: Clarify material unresolved ambiguity without invented goals/premises/author intent; evaluate excessive clarification too.
- **FR-007**: Require finite configured limits and stop on exhaustion, cancellation, invalid config, unresolved usage or drift. Follow-ups/compaction cannot reset task budgets.
- **FR-008**: Support active-session follow-ups, explicit new tasks and repository switching with current evidence checks; no restart recovery.
- **FR-009**: Retain compliant inspectable metadata/references and sanitized final results; no raw prompts/source/tool dumps or secrets in logs.
- **FR-010**: Evaluate identifier, paraphrase, cross-file, architecture, clarification, insufficient-evidence and adversarial cases; separate development/regression and held-out sets.
- **FR-011**: Report citation validity, semantic correctness, clarification, evidence discovery, limits, latency and usage separately; humans resolve disputed semantic grades.
- **FR-012**: Separate controlled harness evidence from real-model quality and live-owner integration, which require separate admission and observations.

### Key Entities

Product session; question task/run; repository binding; admitted source span; answer claim/citation; clarification; budget profile/ledger; evaluation case/observation/grade. See [data model](data-model.md).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every controlled delivered source claim has valid inspected references; all forged/unread/wrong-revision citation vectors are rejected.
- **SC-002**: All controlled forbidden-access, execution, mutation, injection, drift, exhaustion and cancellation vectors pass without unauthorized downstream activity.
- **SC-003**: Initial evaluation has at least 36 identified cases across required categories and three repository-size bands; every required case has a grade or explicit not-run/pending reason.
- **SC-004**: Comparisons hold case/repo/model bindings constant apart from declared budgets and report quality/latency/usage without counting disputed or not-run as passes.
- **SC-005**: Controlled session cases preserve budgets/provenance across clarification, follow-ups, compaction and switching.
- **SC-006**: Real-model acceptance needs all mandatory safety/provenance cases and human-reviewed acceptance of each required semantic case in a pinned suite. Scripted responses cannot satisfy it. No accuracy/latency promise before experiments.

## Assumptions

- Initial targets: Python repositories around 1,000–10,000 LOC; a larger synthetic band probes limits without monorepo promises.
- Python syntax-based chunking and a durable local hybrid index are in scope. Web retrieval, BM25, target mutation/execution, a new UI/CLI framework and durable question sessions remain outside the initial scope.
- Planning/reviews only authorized; shared owner/real-provider gates remain. Fixture budget numbers are not production defaults.

## UC-02 retrieval requirements

- **FR-013**: Ingest eligible Python source/tests and bounded documentation/configuration from a host-admitted immutable snapshot. Chunk functions, classes and methods and index bounded non-symbol source regions. Split oversized definitions at logical syntax boundaries when possible and retain links to the original definition for guarded, budgeted expansion. Persist embeddings and chunk metadata including canonical path, symbol name or null, inclusive line range, file type and source digests.
- **FR-014**: Combine semantic retrieval and case-sensitive exact definition names. Return a stable ranked list and use controlled source access to admit evidence before answering.
- **FR-015**: Persist a versioned index across restart. Add or replace only changed/new files and remove deleted paths, preserving unchanged chunks/vectors. Expose a complete compatible generation atomically and require explicit revalidation after interruptions.
- **FR-016**: Validate every delivered citation automatically for current snapshot, canonical file, line bounds and issued evidence authority. Independently judge semantic support for every factual answer claim, including logic that contains no matching keyword.
- **FR-017**: Answer “không tìm thấy trong repo” with checked scope only when trusted coverage supports an explicit absence decision. Return insufficient evidence or clarification when scope or coverage is uncertain.
- **SC-007**: Actual pinned embeddings reach macro Recall@5 ≥ 0.8 under the exact [evaluation rules](contracts/evaluation.md#uc-02-retrieval-acceptance). All five mandatory scenario families pass, all delivered citations are valid and every required factual claim is supported.
- **SC-008**: Restart reuses unchanged vectors, edit/add/delete refresh touches only changed paths, and interruption cannot expose a mixed/stale generation. Edited-file answers reflect current source.
