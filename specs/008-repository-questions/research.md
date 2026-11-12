# Research and resolved choices

## Retrieval

**Decision**: Bounded agentic exploration with literal search/navigation/span reads, no BM25/embeddings.
**Rationale**: Existing guarded scanner returns prefixes, making late code inaccessible. Improve evidence access before ranking. Agentic describes iterative tool selection, not scoring.
**Alternatives**: BM25 adds lexical ranking, embeddings address vocabulary mismatch with indexing/freshness overhead; evaluate later if baseline failures justify them.

Official sources consulted in discussion: [Anthropic](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) describes just-in-time loading and exploration latency; [Cursor](https://cursor.com/learn/understanding-your-codebase) combines exact/semantic search; [Sourcegraph](https://sourcegraph.com/docs/deep-search) describes iterative search and source trails. These vendor descriptions are not slop-loop acceptance evidence.

## Compatibility

**Decision**: Additive span methods behind a narrow Q&A interface; preserve old repair contracts. Separate Q&A model contract.
**Rationale**: Existing RepositoryPort includes commands/patches; ModelPort consumes repair TaskState. Passing those wholesale broadens authority/coupling.
**Alternatives**: Changing shared SourceEvidence/stage enums or duplicating unguarded filesystem access rejected.

## Budget/session choices

**Decision**: Require complete finite profiles, retain cumulative task accounting, compare fixture profiles; no production default. Host-memory sessions, explicit continuation/new task; summaries are advisory.
**Rationale**: Result caps do not bound scanning. Unknown usage stays reserved/charged and blocks further dispatch. Drift stops a run; explicit same-task rebind retains limits. Switching repo starts a new task and excludes old source text from active context.
**Alternatives**: Unlimited search, model budget renewal, automatic unlimited drift restarts and durable restart support rejected for initial scope.

## Evidence/evaluation

**Decision**: Mechanically validate issued spans; human-adjudicate semantic correctness/clarification; retain only compliant metadata/references and sanitized results. Separate development/regression from evaluator-controlled held-out sets.
**Rationale**: Valid coordinates do not prove support; scripted models prove harness behavior only. No raw source/prompt log collection.
**Alternatives**: LLM-only self-grading and unrestricted trace dumps rejected.

## Review-driven boundary corrections

**Decision**: Require admitted immutable source bytes/manifest rather than mutable-tree pre/post hashes; separately check current-workspace freshness. Require exact/certified complete-request token bounds before provider dispatch. Return claim-free fixed outcomes after budget/deadline closure rather than spending additional IO to validate partial answers.
**Rationale**: A -> B -> A mutation can evade before/after hashes; accumulated evidence can exceed input caps; an exhausted scan cannot safely perform a further unreserved final scan. Tests cover each trigger at its boundary.
**Alternatives**: Trusting a filesystem compatibility marker, checking token usage only afterward or performing uncharged terminal reads are rejected. Live snapshot/token/accounting owner prerequisites remain gated.

## Governance

Constitution is a placeholder; repository policies govern. Existing branch and unrelated working-tree edits preserved. `.specify/feature.json` selects Feature 008 for planning commands; setup scripts' logical feature branch is not a claim of actual Git branch creation. No extension-hook configuration existed at preparation. Implementation/live-owner release remains separate, not a hidden unresolved design choice.

For the later user-authorized PR, planning files were copied into an isolated `feat/questions-readonly-qa-planning` checkout based on fetched development. The original authoring checkout remains unchanged. Historical review evidence retains its original source root/HEAD; publication evidence uses a new snapshot and delta review. The only governing source difference from the original review is development's runtime-policy clarification wording; the concurrent uncommitted runtime-policy edit is excluded. Publication is documented in contracts/decisions.md and checklists/publication-validation.md.
