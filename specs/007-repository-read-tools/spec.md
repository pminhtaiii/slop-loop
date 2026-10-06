# Feature Specification: Repository Read Tools

**Feature Branch**: `feat/007-repository-read-tools`

**Created**: 2026-10-06

**Status**: Planned; no Phase 6 implementation or performance evidence yet.

**Input**: Project Phase 6 from the accepted [design checkpoint](../../docs/phase6-design-checkpoint.md): bounded live-checkout listing, literal keyword search and whole-file reads; small automatic context under the same task authority; root `AGENTS.md` only; existing narrow sensitive-content heuristic with performance tests. This change delivers reviewed planning artifacts and GitHub tasks, not product implementation.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Inspect an eligible repository file (Priority: P1)

A developer asks a repository question. The agent reads a known file in the validated checkout and receives faithful, bounded source evidence without gaining host access.

**Why this priority**: Trustworthy reads underpin every context acquisition path.

**Independent Test**: Dispatch real reads through an admitted task/gateway, fixture checkout and fake audit sink; assert complete source, provenance, consumed-byte identity and zero forbidden content.

**Acceptance Scenarios**:

1. **Given** an Ask or Edit task and eligible text, **When** `read_file` succeeds, **Then** complete text, canonical repository-relative path, method and identity of retrieved bytes arrive as untrusted evidence.
2. **Given** excessive file/serialized size or binary/invalid UTF-8, **When** read, **Then** a typed size/binary result replaces partial content.
3. **Given** a denied path or heuristic-recognized sensitive payload, **When** read, **Then** affected content never enters context/audit; path denial and payload contract failure retain distinct meanings.
4. **Given** edits between calls, **When** read again, **Then** current eligible bytes and content identity are returned without claiming a task-wide snapshot.

### User Story 2 - Find relevant code with bounded exploration (Priority: P1)

The agent lists directory entries and searches literal keywords in file/directory scopes, then narrows scope or reads matches within task budgets.

**Why this priority**: Discovery must not require arbitrary commands or an unbounded repository dump.

**Independent Test**: Script list/search/read traces in known fixtures; assert matches, explicit incompleteness and real boundary confinement.

**Acceptance Scenarios**:

1. **Given** a directory, **When** listed, **Then** deterministic immediate eligible file/directory entries are bounded with truthful omission metadata.
2. **Given** regex/shell metacharacters in a keyword, **When** searched, **Then** case-sensitive literal matching occurs without command or regex interpretation.
3. **Given** excessive matches, long lines or work exhaustion, **When** search returns, **Then** omissions, shortening and incomplete traversal are distinct; incomplete empty results are never complete no-match.
4. **Given** aliases/cycles, **When** traversed, **Then** canonical targets are validated at use and duplicate targets/cycles do not create unbounded work.

### User Story 3 - Start with small authorized context (Priority: P2)

The agent starts with a small tree, eligible root `AGENTS.md` and developer-referenced files; it retrieves nested instructions itself when needed.

**Why this priority**: Bootstrap saves initial discovery without another access boundary or unrelated instruction loading.

**Independent Test**: Bootstrap root/nested/denied/reference fixtures; inspect charged attempts, trusted audit origin and bounded untrusted content.

**Acceptance Scenarios**:

1. **Given** root/nested instruction files, **When** bootstrap runs, **Then** only root instruction content is automatically read; nested content remains absent until requested.
2. **Given** external/denied references or missing root instructions, **When** bootstrap runs, **Then** no authority expands; bounded omission metadata exposes no host path/content.
3. **Given** exhausted allowances, unavailable audit or cancellation, **When** another bootstrap retrieval is proposed, **Then** normal dispatch gates stop it without free or separate authority.
4. **Given** repository text claiming system authority, **When** loaded, **Then** untrusted provenance remains and deterministic policy is unchanged.

### User Story 4 - Demonstrate retrieval safety and performance (Priority: P2)

Maintainers evaluate fixture retrieval and confirm narrow-heuristic latency without adding a broad scanner or requiring a live provider.

**Why this priority**: Safety, useful evidence and latency need reproducible proof before enabling adapters.

**Independent Test**: Provider-neutral traces and dedicated performance suites on Ubuntu/Windows record all metrics and benchmark environment.

**Acceptance Scenarios**:

1. **Given** required/helpful/forbidden fixture files, **When** traces run, **Then** recall, precision, irrelevant volume, denied attempts, bytes and calls use declared denominators.
2. **Given** answer-property/verification expectations without a provider, **When** evaluated, **Then** scripted checks are labeled separately from unavailable live-model answer correctness.
3. **Given** maximum-size ordinary/adversarial payloads, **When** benchmarked, **Then** warmed latency distributions and end-to-end overhead are recorded and baseline-derived gates precede enablement.

### Edge Cases

- Checkout replacement, disappearance, path swaps, symlink cycles/aliases, hard links, nested repos and mount/reparse boundaries.
- Native enumeration beyond 1,023 children, huge/sparse files, exact size boundaries, growth during read, long lines, Unicode and invalid encoding.
- No-match versus truncated/incomplete search; newline queries and leading hyphens/metacharacters.
- Heuristic matches in content or path metadata; false positives fail closed without rewriting source.
- Pre/result audit append failure, cancellation mid-traversal, stale generations and late delivery.
- Many/repeated explicit references, missing root instructions and malicious/nested instruction text.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Enable only existing `list_files`, `search_code`, `read_file` retrieval names; preserve closed strict inputs and trusted Ask/Edit selection.
- **FR-002**: All retrieval, including bootstrap, MUST use admitted task authority, policy, workspace boundary, shared task allowances, cancellation fencing and mandatory pre-execution audit.
- **FR-003**: Content MUST remain untrusted with canonical source-path/method provenance. Trusted runtime origin distinguishes bootstrap/agent calls without adding authority.
- **FR-004**: Access MUST remain confined to eligible tracked/untracked nonignored content in the sealed checkout; secret paths, `.git`, nested repos, hard links and existing mount/symlink/reparse restrictions remain enforced at use.
- **FR-005**: Reads MUST return complete UTF-8 text or typed size/binary outcomes; whole-file and serialized caps each remain 64 KiB. Chunk reads are excluded.
- **FR-006**: Content reads and searched-file matches MUST bind evidence to consumed safe-open bytes. Live per-call evidence grants no later authority or inter-call immutability guarantee.
- **FR-007**: Listing MUST return deterministic immediate eligible children with limit 1–100 and 16 KiB serialized cap. Incompleteness is explicit or the existing boundary authority-failure contract fails closed.
- **FR-008**: Search MUST preserve query/scope/count inputs, query length 1–512 and count 1–200; matching is case-sensitive literal text in a file or recursively scoped directory.
- **FR-009**: Search MUST skip files above 4 MiB and binary/invalid UTF-8 with bounded notices; maxima remain 200 matches, 32 KiB serialized total and 4 KiB per returned line, including metadata overhead.
- **FR-010**: Search MUST distinguish omitted matches, shortened lines, omitted-file notices and incomplete traversal. Trusted finite scan/depth/byte/deadline limits never turn partial emptiness into complete no-match.
- **FR-011**: Traversal MUST validate every accessed child, stop cycles and avoid duplicate canonical content. Known forbidden paths remain ordinary denials; unavailable/changed trusted authority fails closed.
- **FR-012**: Retain the existing narrow gateway heuristic and fail-closed read/search contract. Payload changes yield the existing tool-contract failure without original or rewritten affected content. No broad scanner, secret allowlisting or model bypass is added.
- **FR-013**: Validate/sanitize/bound before context or audit. Audit excludes raw queries, contents, arguments and host paths; retain bounded identities, decisions, origin and safe counts/bytes only.
- **FR-014**: Close held handles on all exits; fence late results; evidence-persistence failure never replays an executor.
- **FR-015**: Automatic context MUST contain only a bounded small tree, eligible root `AGENTS.md` and explicit developer references. Nested instruction content is never automatically discovered, including on descendant access; a nested instruction file explicitly referenced by the developer is ordinary referenced content.
- **FR-016**: References MUST come from structured trusted developer input, not repository/model text inference. Deduplicate, enforce path policy and report bounded omissions; external import stays unavailable.
- **FR-017**: Each automatic retrieval consumes the same tool-attempt allowance and output contract as an explicit call; aggregate bootstrap caps create no extra allowance.
- **FR-018**: Check cancellation/deadlines during bounded exploration. Synchronous primitives retain finite internal limits; do not claim preemptive interruption of an active native call.
- **FR-019**: Fixtures MUST declare required/helpful/forbidden files, expected source/answer properties and verification selection. Distinguish path discovery from delivered content and denied attempts from forbidden deliveries.
- **FR-020**: Metrics MUST document formulas for recall, precision, irrelevant volume, denied attempts, bytes, calls, property checks and verification selection, using finite empty-denominator values. Scripted checks are not live-model correctness.
- **FR-021**: Performance tests MUST isolate heuristic/sanitization and measure end-to-end overhead for maximum-size ordinary/no-match/adversarial repeated/long candidates; record host/runtime, warmed p50/p95/p99 and repeat counts. Freeze measured gates before executor enablement.
- **FR-022**: Require RED/GREEN unit, gateway integration, native security and scripted E2E evidence on Ubuntu/Windows. Unavailable fixtures remain explicit rather than passing.
- **FR-023**: Phase 6's gate MUST prove scripted retrieval understands fixture evidence without host escape; it does not claim real provider, mutation, verification-tool, CLI or durable audit completion.
- **FR-024**: Planning/context sync MUST preserve implemented/planned status and the open Phase 5 Windows Docker gate; Phase 6 closes no earlier gap.

### Key Entities

- **Retrieval evidence**: Bounded untrusted repository content/metadata with canonical source, method and consumed-byte identity where applicable.
- **Retrieval origin**: Trusted bootstrap/agent distinction that adds no authority.
- **Bootstrap context**: Bounded initial tree, root instruction content and explicit developer-reference evidence.
- **Retrieval fixture**: Repository with declared relevant/forbidden evidence and expected properties.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All eligible fixture reads are faithful complete text or declared typed outcomes; zero forbidden-content deliveries occur in adversarial traces.
- **SC-002**: Scoped keyword searches yield expected literal matches or explicit incompleteness; every per-item/serialized cap is respected.
- **SC-003**: Bootstrap delivers zero automatically discovered nested instruction contents and zero external reference contents; every actual retrieval is charged/evidenced before access.
- **SC-004**: Reference traces meet declared recall/precision/evidence expectations and emit every required metric without non-finite or fabricated live-model values.
- **SC-005**: Maximum-size sanitizer benchmarks pass frozen baseline-derived latency gates on Ubuntu/Windows before enablement; cancellation/work limits prevent late context delivery and release resources.
- **SC-006**: Required quality/security checks pass on available hosts with named unavailable fixtures and preserved earlier open gates.

## Assumptions

- Current `development` is authoritative: Phase 4 complete under T088; Phase 5 Linux evidence exists but Windows Docker gate remains open. Host retrieval uses Phase 4 directly and does not execute sandbox code.
- Literal search/root-only instructions reflect accepted decisions. Executable grep/ripgrep, regex, semantic indexes, retrieval snapshots, chunk reads, mutation adapters and real providers are excluded.
- Existing admitted-task and fake-audit ports suffice for Phase 6 proof; durable audit remains Phase 12 and model integration Phase 10.
- Performance calibration is an explicit implementation task, not evidence that the heuristic is already fast enough. Bootstrap/scan caps are trusted defaults in the plan.
