# Implementation Plan: Evidence-backed repository questions

**Branch**: `feat/rag-uc02-spec-alignment` | **Date**: 2026-11-12 | **Spec**: [spec.md](spec.md)
**Input**: [ADR-0008](../../docs/adr/0008-read-only-target-repository-questions.md).

## Summary

Read-only repository Q&A with an adaptive search/read loop, span citations, honest clarification/incomplete outcomes, active-session follow-ups and inspectable evaluation. Reuse controlled repository access; add match-centered search/ranged reads through a narrow additive interface, preserving repair signatures/behavior. UC-02 adds persistent semantic retrieval with an exact-symbol lane. Planning does not release implementation.

## Technical Context

**Language/Version**: Existing strict TypeScript 6.0.3, Node.js 24, pnpm 12.5.1.
**Primary Dependencies**: Existing `@langchain/langgraph`, Node built-ins; planned Tree-sitter WASM/Python grammar, sqlite-vec and local Transformers.js/ONNX candidate.
**Storage**: Host-memory session/evidence/budget state and host-admitted immutable source snapshot; evaluator metadata artifacts outside target workspace; durable host-owned SQLite retrieval index; question session recovery remains in-memory only.
**Testing**: Node runner over compiled TypeScript, controlled model/filesystem/clock/accounting ports and disposable filesystem fixtures; Python never imported/executed.
**Target Platform**: Local host toolchain; Windows junction tests; canonical relative evidence paths.
**Project Type**: Internal runtime library and evaluation module; no new service or delegated coding-agent product.
**Performance Goals**: Measure quality/cost/latency under finite profiles; no invented production SLO.
**Constraints**: Preserve owner fences, deny protected content/execution, keep judging private; controlled results do not establish real-model/owner readiness.
**Scale/Scope**: One repo/question, sequential session tasks; synthetic ~1k/~10k/~30k LOC bands.

## Constitution Check

Constitution is an unratified placeholder, not policy. Apply AGENTS.md and architecture/code/tools/runtime/state documents before and after design. Deterministic authority, bounded ports/loops and versioned evidence preserved; no waiver inferred. Independent reviews and implementation release are separate gates in [decisions](contracts/decisions.md).

## Project Structure

### Documentation (this feature)

`spec.md`, `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, `tasks.md`, `contracts/{decisions,repository-tools,question-runtime,evaluation,retrieval}.md`, `checklists/`.

### Source Code (repository root)

```text
src/contracts/questions/{contracts,validation}.ts
src/foundation/{repository-read,repository-tools,repository-types}.ts
src/questions/{repository,budget,evidence,model,session,graph,presentation,chunks,index,embedding,retrieval}.ts
eval/questions/{types,cases,runner,grade,compare,recall}.ts
tests/runtime/contract/questions.test.ts
tests/runtime/unit/{question-repository,question-budget,question-evidence,question-session,question-grade,question-chunks,question-embedding,question-retrieval,question-recall}.test.ts
tests/runtime/integration/{question-runtime,question-evaluation,question-index,question-index-platform}.test.ts
tests/runtime/support/questions/{fixtures,scripted-model}.ts
```

**Structure Decision**: Q&A contracts/orchestration separate from repair state. Foundation owns safe additive span access; questions modules own budgets/evidence/sessions; evaluator owns judgments. No generic retrieval framework.

## Existing evidence and seams

- `repository-read.ts` currently does case-sensitive substring scanning and prefix evidence; no match locations/ranges/ranking.
- `repository-tools.ts`/`repository-types.ts` supply guarded filesystem and explicit bounds. Add span methods sharing containment/protection/revision helpers, never a separate unguarded filesystem path.
- `guarded-read-capability.ts` observe/fence belongs to supplied owner. Q&A consumes it, never mints owner receipts.
- Preserve `RepositoryPort` and `SourceEvidence`. New `QuestionRepositoryPort` exposes only list/read/search/binding checks; adapter wraps additive span operations, not fabricated coordinates on prefix results.
- `foundation/model.ts` consumes repair state. Use a validated Q&A model port with supplied host transport/accounting, never fake a BugTask/approval. Live composition remains gated; scripted responses prove loop behavior only.
- Leave `eval/shared.ts` and UC-03 runner unchanged. Q&A reports are independently versioned; later shared registration requires a separate compatibility release.

## Implementation sequence

1. Freeze contracts; baseline existing foundation tests before additive shared changes.
2. Add line-span reads, deterministic literal search and paged listings with finite scanned-work limits and explicit partial coverage; preserve legacy behavior. Q&A admits a trusted immutable source snapshot/manifest under stable owner lease, validates expected file bytes, and separately checks selected-workspace freshness. A mutable-tree before/after hash cannot establish source-byte identity.
3. Private question/run/repo/revision-bound evidence registry admits tool-issued spans. Citation validation checks issuance and fully exposed line coverage; content checked before final display. Provenance is not semantic entailment.
4. Sequential LangGraph: admit -> model decision -> validate -> tool -> evidence admission -> decision -> final validation. Terminal outcomes include clarification, insufficient evidence, exhausted, stale, cancelled, blocked and failed. Every costly loop consumes domain budgets; recursion limit is secondary.
5. A deterministic compiler selects fitting mandatory context then conversation/evidence; trusted token counting covers the full serialized request/system/tool overhead before reservation/transport. Model gets question, bounded session context and untrusted admitted excerpts. It proposes a tool decision, claim/citation answer, clarification or insufficient evidence. No shell/patch tool. Invalid output ends safely. Exhausted/cancelled/stale/unknown-accounting results are claim-free and perform no final source scan; source-bearing answers require separately admitted final validation within remaining budget.
6. Serialized memory sessions with task/run, pending clarification, source bindings and summary. User explicitly selects continuation/new task; model cannot renew budget. Switching repository starts a new task. Re-admit reused spans into current run after revision check.
7. Evaluator provides inventory, controlled driver, provenance checks, separate semantic judgment, compliant diagnostics and comparison; held-out material stays evaluator-side.
8. Focused/regression checks and existing context-refresh helper before eventual implementation handoff. No scripted result passes real-model acceptance.

Normative contracts define exact semantics; [data model](data-model.md) defines fields/ownership.

## Validation and delivery gates

See [quickstart](quickstart.md). After a separate release, first slice is controlled/source-tier US1+US2; sessions/evaluation follow. Real-model experiments additionally require approved provider/model/pricing, trusted token-bound/output-cap enforcement, authoritative accounting and guarded-read owner composition, stable immutable snapshot admission, artifact-access/retention policy and private grading admission. Missing prerequisites are not-run, not locally bypassed with mocks.

Full feature acceptance requires human-reviewed semantic cases, all mandatory safety/provenance passes and pinned evidence. Manage contributor PR size in coherent batches rather than splitting incompatible shared contracts.

## Complexity Tracking

The local vector index is a derived cache of a guarded immutable snapshot. Keep its dependency and resource surface confined to a host-owned retrieval adapter. Additive spans are needed because prefix reads cannot access late definitions; private evidence issuance prevents invented coordinates. No implementation authority granted.

## UC-02 retrieval integration

Freeze the retrieval contract with existing question contracts. Validate SQLite/extension compatibility on Windows and CI, then integrate a guarded corpus builder, bounded Python chunker, persistent index and hybrid ranking through the same Q&A graph. Use the guarded source reader to re-admit ranked spans before model context, then allow the existing bounded investigation loop. Use a trusted coverage receipt for scoped absence. Exercise physical restart and failed publication with a disposable on-disk database, and evaluate the pinned local embedding candidate independently of scripted answer quality. See [retrieval contract](contracts/retrieval.md) and T019–T026.
