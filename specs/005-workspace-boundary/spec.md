# Feature Specification: Workspace Boundary

**Feature Branch**: `feat/005-workspace-boundary`
**Created**: 2026-09-30
**Status**: Implemented and verified for available fixtures; T088 remains an accepted, unchecked MVP verification gap.
**Input**: Phase 4 progress tracker, ADR 0009/0010, tool policy, and workspace-boundary grilling decisions.

## User Scenarios & Testing

### User Story 1 - Work across one selected checkout (Priority: P1)

A developer starts Slop Loop from any subdirectory of the intended Git checkout. The agent can inspect the whole selected checkout, but cannot use that authority for sibling or nested repositories.

**Why this priority**: The selected checkout is the authority boundary for all repository tools.

**Independent Test**: Launch from the root and a nested directory of a fixture checkout, then test sibling repositories, nested repositories, submodules, and non-repository launch directories without enabling real file adapters.

**Acceptance Scenarios**:

1. **Given** a valid checkout and a launch directory below its root, **when** a task is admitted, **then** eligible files throughout that checkout are in scope and the physical root is fixed for the task.
2. **Given** a launch directory outside a valid checkout, **when** a task is admitted, **then** admission fails rather than choosing an arbitrary folder.
3. **Given** a sibling or nested repository, including a submodule, **when** its path is requested under the selected workspace, **then** access is denied.
4. **Given** a replacement checkout with a different repository identity, **when** an existing task resumes, **then** its sealed workspace authority is not rebound.

---

### User Story 2 - Deny unsafe repository paths (Priority: P1)

The agent requests a repository file or proposes a change. Slop Loop evaluates the current target, path aliases, and file type before producing trusted eligibility facts. A request cannot reach host files outside the workspace or excluded content inside it.

**Why this priority**: The Phase 4 exit gate is repository confinement.

**Independent Test**: Use adversarial filesystem fixtures with a fake caller. Evaluated forbidden requests produce `FORBIDDEN`, never `ALLOWED`, path facts and no external content; unavailable authority produces no usable facts.

**Acceptance Scenarios**:

1. **Given** traversal, an absolute escape, or a malformed path, **when** requested, **then** access is denied.
2. **Given** a symlink to an eligible regular file in the same repository, **when** read, **then** it is permitted; directory traversal stops cycles and duplicates.
3. **Given** a symlink to an external, nested-repository, ignored, or secret-denied target, **when** requested, **then** it is denied.
4. **Given** a mutation target or parent that is a symlink, **when** eligibility is checked, **then** the mutation is denied even if the resolved target is within the checkout.
5. **Given** a hard link, nested mount, Windows junction, other reparse boundary, pipe, device, socket, ignored path, `.git` internal, or denied secret path, **when** content access is requested, **then** it is denied.
6. **Given** a changed target after an earlier check, **when** mutation is about to occur, **then** current path and target identity are checked again.

---

### User Story 3 - Retrieval is bounded and unambiguous (Priority: P2)

The agent reads or searches eligible repository content. A small file is delivered complete; an oversized file yields an explicit limit result. Search may omit matches only when the result clearly says so.

**Why this priority**: The agent must not mistake partial source for a complete file, and repository content must not flood its context.

**Independent Test**: Exercise text, binary, oversized, long-line, and many-match fixtures against Phase 4's boundary-level result builders and gateway contracts. Phase 6 connects them to model-visible read and search executors.

**Acceptance Scenarios**:

1. **Given** an eligible text file at most 64 KiB whose encoded result fits the contract, **when** the boundary-level read result is formed, **then** it is complete.
2. **Given** a file above 64 KiB or a result that would exceed 64 KiB, **when** the boundary-level read result is formed, **then** no partial content is returned and the result identifies the limit.
3. **Given** more than 200 search matches, 32 KiB total output, or a line above 4 KiB, **when** the boundary-level search result is formed, **then** omitted matches and shortened lines are marked distinctly.
4. **Given** a file above 4 MiB or binary content, **when** the boundary-level search result is formed, **then** it is skipped with bounded metadata.

### Edge Cases

- The launch path or target changes after admission or between validation and use.
- Relative `..`, absolute, drive-qualified, UNC, NUL-containing, case-variant, Unicode-variant, and platform-separator paths.
- Allowed symlink aliases to denied targets, directory cycles, and duplicate aliases.
- A mount introduced below a checkout root that itself resides on a mounted volume.
- A branch switch detected during an active task; later phases own grant invalidation, Git evidence, and resume UI.
- A prompt references an OS-temp handoff; repository tools still deny that path.

## Requirements

### Functional Requirements

- **FR-001**: Slop Loop MUST validate one current Git checkout at admission and reject admission outside a valid checkout.
- **FR-002**: The workspace MUST include the selected checkout rather than only the launch directory and MUST remain fixed for the task; task admission MUST require a successfully validated workspace identity.
- **FR-003**: Repository authority MUST exclude sibling and nested repositories, including submodules, and reject a replacement checkout identity even if its path is unchanged.
- **FR-004**: Requested repository paths MUST be parsed and normalized as relative paths; traversal and absolute escape MUST be rejected before content access.
- **FR-005**: Eligibility MUST use current, symlink-aware, path-aware containment, never a string-prefix check.
- **FR-006**: Reads MAY follow symlinks only when both alias and resolved target remain eligible within the same repository; directory traversal MUST stop cycles and duplicate content exposure.
- **FR-007**: Mutation eligibility MUST reject a symlink in the target or any parent and MUST be rechecked immediately before a later mutation adapter acts.
- **FR-008**: Repository content access MUST reject hard links, nested mount or reparse crossings, and nonregular targets; a mounted checkout root MAY be selected.
- **FR-009**: Repository tools MUST exclude ignored paths and `.git` internals and MAY access eligible tracked and untracked nonignored files.
- **FR-010**: Default secret-path denials MUST apply to requested aliases and resolved targets and MUST NOT be overridden by prompts or file grants.
- **FR-011**: The boundary MUST provide invocation-scoped requested-alias and canonical repository-relative target facts to the existing policy gateway. The gateway MUST verify exactly one matching fact for every requested path-operation pair, including implicit root scopes; missing, duplicate, extra, or inconsistent facts MUST fail closed.
- **FR-012**: `read_file` MUST reject binary content and files above 64 KiB and MUST return complete content only within a 64 KiB model-visible result; an exceeded limit produces an explicit result, not a partial file.
- **FR-013**: `search_code` MUST cap output at 200 matches, 32 KiB total, and 4 KiB per returned line; it MUST skip files above 4 MiB and binary files and distinguish omitted matches from shortened lines.
- **FR-014**: Output schemas and limits MUST be fixed in the trusted closed tool catalog for the MVP; the model and repository content MUST NOT raise them. Unrelated tools retain smaller output contracts.
- **FR-015**: Content returned to the model MUST retain source-path and retrieval-method provenance and remain untrusted data.
- **FR-016**: Repository tools MUST NOT import an OS-temp handoff, access another host path, or execute arbitrary terminal commands.

### Key Entities

- **Workspace**: The validated selected checkout and its fixed task identity.
- **Repository path request**: A relative path and intended read, update, or create operation.
- **Trusted path facts**: Current canonical relative target, operation, workspace identity, and allow or forbidden status for one request.
- **Retrieval bound**: A trusted maximum with an explicit size-limit or truncation outcome.

## Success Criteria

### Measurable Outcomes

- **SC-001**: 100% of adversarial fixture requests for outside host files, other repositories, ignored or secret paths, hard links, nested mounts, and nonregular content return no content and no `ALLOWED` path facts.
- **SC-002**: Every tested launch subdirectory exposes the same eligible checkout files as the root and no sibling or nested repository files.
- **SC-003**: 100% of tested symlink escapes, traversal forms, and target swaps are denied before content access or mutation eligibility.
- **SC-004**: Every tested boundary-level oversized or binary read result is an explicit limit or content-type result without a partial file.
- **SC-005**: Every tested boundary-level search result respects 200 matches, 32 KiB total, 4 KiB per line, and 4 MiB per searched file, with accurate omission markers.
- **SC-006**: The existing gateway denies calls when real boundary facts are unavailable or invalid.

## Assumptions

- Phase 3 has fake-port policy and gateway contracts. Phase 4 supplies real workspace facts and safe access boundaries; complete read adapters, patch permissions, Git evidence, and CLI resume UI remain Phases 6, 7, 9, and 13.
- Phase 9 supplies trusted branch and `HEAD` checks and bounded status evidence. `git_diff` remains the only model-visible Git tool. Transient branch switches wholly between checkpoints are outside the MVP guarantee.
- The default secret patterns in `coding-agent-context/context/tool-policy.md` remain authoritative.
- Output limits count encoded result bytes; a file below 64 KiB may still receive a limit result if its serialized envelope cannot fit.
- Chunk-based reads, external file imports, agent terminal commands, and agent-managed worktrees are deferred.
