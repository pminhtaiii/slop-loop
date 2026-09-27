# Feature Specification: Closed Tool Registry

- **Feature Branch**: `feat/003-closed-tool-registry`
- **Created**: 2026-09-27
- **Status**: Draft for review
- **Input**: Phase 2 registry accepted in ADR 0005.

## User Scenarios & Testing

### User Story 1 — Validate proposed tool calls (P1)

The trusted application checks a proposed name and arguments against a fixed catalog before policy or an adapter sees the call.

**Independent Test**: Call the registry with each known name, an unknown name, valid input, and malformed input; no operation occurs.

**Acceptance Scenarios**:

1. Given one of the nine MVP names and valid arguments, validation returns the recognized name and parsed arguments.
2. Given an unregistered name, validation rejects it.
3. Given a registered name and an unknown key, wrong type, or missing field, validation rejects it.
4. Model and repository content cannot add or overwrite a tool definition.

### User Story 2 — Present selected tools (P1)

A trusted task composer obtains provider-neutral schemas for names selected from the developer's task mode without granting authority to invoke them.

**Independent Test**: Request schemas for Ask and Edit and compare exact names with ADR 0005.

**Acceptance Scenarios**:

1. Ask exposes only `list_files`, `search_code`, `read_file`, and `git_diff`.
2. Edit exposes those four plus `apply_patch`, `run_tests`, `run_build`, `run_linter`, and `run_typecheck`.
3. An unknown selected name fails closed instead of advertising a partial set.
4. Every advertised argument contract agrees with runtime validation from the same strict input schema.

### Edge Cases

- The outer proposed call must be a strict object containing exactly `name` and `arguments`; missing or extra top-level keys fail. Empty or non-object arguments, arrays, null, unknown argument keys, and invalid numeric ranges fail.
- No tool accepts an executable, shell flags, raw command, timeout, environment map, budget change, mode, or permission grant.
- A structurally valid path or profile still requires later trusted authorization, canonicalization, and configuration checks.

## Requirements

### Functional Requirements

- **FR-001**: The catalog MUST contain exactly ADR 0005's nine MVP names. Unknown names MUST be rejected; model and repository content MUST NOT change definitions.
- **FR-002**: Every entry MUST have one strict input schema for runtime argument validation; unknown fields MUST fail.
- **FR-003**: The registry MUST derive provider-neutral model-visible arguments from that runtime schema, without a second handwritten argument contract.
- **FR-004**: A trusted composition function outside the registry MUST map Ask and Edit to the exact ADR 0005 candidate name sets. The registry MUST reject unknown selected names and expose schemas only for registered candidates. Selection controls visibility only.
- **FR-005**: Validation and schema generation MUST have no file, Git, process, network, sandbox, permission, or audit side effect.
- **FR-006**: Schemas MUST expose bounded structural inputs only. `search_code` takes text, optional scope and result limit; `run_tests` takes profile and optional logical target; verification tools take profile; `apply_patch` takes patch text. No raw command or execution controls.
- **FR-007**: Tests MUST prove unknown-name denial, strict input rejection, Ask/Edit selection, and advertised/runtime schema parity for all nine tools.
- **FR-008**: Proposed calls MUST pass a strict outer `{ name, arguments }` contract before name-specific argument validation. Unknown top-level fields MUST fail; provider-specific envelopes are later adapter work.
- **FR-009**: Registry entries MUST remain non-executable definitions. Before any later phase exposes executable tools, their full contracts MUST add the output schema, risk level, mutation flag, required capability, timeout, and maximum output size required by `code-standards.md`.

### Key Entities

- **Registry entry**: Fixed name, description, and strict input contract; no executable capability.
- **Validated call**: Recognized name and parsed structural arguments awaiting policy authorization.
- **Model-visible schema**: Provider-neutral description and arguments derived from the definition.
- **Trusted selection**: Candidate names chosen outside the registry from developer-selected task mode.

## Success Criteria

- **SC-001**: Every unknown-name and malformed-argument fixture is rejected in focused tests.
- **SC-002**: Ask exposes exactly four and Edit exactly nine names.
- **SC-003**: Parity checks cover required, optional, type, range, and unknown-key behavior for each tool, plus strict outer call validation.
- **SC-004**: The module has no execution or authorization path, and the combined quality gate passes before implementation is marked complete.

## Assumptions and Boundaries

- Phase 0 and Phase 1 source are present. Phase 1 integration readiness still depends on its pinned pnpm gate.
- ADR 0006 budget counters and ADR 0007 task-bound mode/stop are separate future refinements; this feature does not implement them.
- Phase 3 authorizes invocations; Phases 4–9 validate paths and perform operations; Phase 10 converts schemas for a provider.
- Proposed structural bounds in [contracts/registry.md](./contracts/registry.md) are not path safety, profile allowlisting, or execution limits.
