# Implementation Plan: UC-01 Evidence-backed Issue Triage

**Branch**: `feat/011-uc01-issue-triage-specs` | **Date**: 2026-10-17 | **Spec**: [spec.md](spec.md)

**Input**: Draft specification in `specs/002-uc01-issue-triage/`.
**Status**: DRAFT proposal. Planning/publication only; no runtime implementation authorization.

## Summary

Thai owns an assessment boundary for one issue/repository. Validate input and trusted catalogs; collect bounded evidence through Tai's shared read/search tools; ask the model for a structured assessment; validate provenance and values; return an assessment or material questions. Preserve original report. Recommend without dispatching. No dedicated rewrite call.

## Technical Context

**Language/Version**: Proposed consumer uses approved TypeScript 6.0.3, Node.js 24 LTS, strict NodeNext ESM.
**Primary Dependencies**: Existing LangGraph and Node built-ins; no new package proposed. Graph wiring consumes shared ports rather than new tools.
**Storage**: No UC-01 store. UC-04 supplies durable task accounting and continuation storage; fixtures are explicitly in-memory.
**Testing**: Node test runner, controlled port spies, contract vectors and held-out evaluation; [acceptance](contracts/acceptance.md).
**Target Platform**: Host harness; approved target repository read boundary owned by Tai. Deployment/API transport remains open.
**Project Type**: Internal runtime assessment module, with no CLI/service framework selected.
**Performance Goals**: Finite configured invocation deadline and call ceilings; numeric production values and measured quality thresholds require approval, not invented defaults.
**Constraints**: No writes, commands, reproduction, debugging, recovery engine, approval engine or dispatch in UC-01.
**Scale/Scope**: One issue, one repository per invocation; initial repository scope follows [overview](../../context/project_overview.md).

## Constitution Check

The [constitution](../../.specify/memory/constitution.md) remains an unratified template. Apply AGENTS.md, accepted ADR-0005 and repository policy instead of treating placeholder principles as ratified. Pre-research and post-design gates: scope limited to planning (PASS); shared owners preserved (PASS); production choices explicitly gated (PASS); no UC-03 contract mutation (PASS). Runtime readiness is BLOCKED pending [decisions](contracts/decisions.md), regardless of draft completeness.

## Project Structure

### Documentation (this feature)

`specs/002-uc01-issue-triage/` owns spec, plan, research, data-model, quickstart, checklists, contracts and the sole implementation ledger `tasks.md`. `.specify/feature.json` selects this feature without renaming UC-03. Local reviews/ticket proposals stay ignored in `.agent-work/2026-10-17/uc01-sdd/`.

### Source Code (repository root)

Proposed paths only; none created in this planning change:

```text
src/uc01/
  contracts.ts          # assessment-specific parsing and validation
  intake.ts             # original issue/config/continuation binding
  assess.ts             # assessment use case through injected ports
  clarify.ts            # question and answer projection
  recommend.ts          # catalog-constrained destination recommendation
  compose.ts            # shared-port consumer wiring; production admission
tests/runtime/uc01/
  contract.test.ts, intake.test.ts, assess.test.ts
  clarify.test.ts, recommend.test.ts, integration.test.ts, safety.test.ts
tests/runtime/support/uc01/
  fixtures.ts, ports.ts
```

**Structure Decision**: Thai owns only UC-01-specific modules/tests. Tai owns `src/contracts/uc03.ts`, `src/foundation/` and shared evaluation infrastructure; Thanh Tan owns `src/persistence/`; Trong Tan owns `src/approvals/`. Proposed path allocation requires agreement before implementation; no shared-file edits are hidden inside Thai's tasks.

## Architecture and module boundaries

```mermaid
flowchart LR
  C[Caller and trusted context] --> I[Validate intake and continuation]
  I --> A[Bounded assessment controller]
  A --> F[Tai: guarded read/search and model boundary]
  F --> S[UC-04 accounting and UC-05 policy]
  A --> V[Validate assessment and evidence registry]
  V --> O[Assessment or material questions]
```

UC-01 receives only narrowed read/search capabilities, not a full RepositoryPort with patch/execute methods. Model tool requests are data checked against that narrow capability set; the controller invokes only validated read/search requests. All operation guards and durable reservations are shared. No UC-03 bug workflow is required to run UC-01 fixtures.

The existing executable ModelPort requires UC-03 TaskState/ModelProposal, and RepositoryPort does not expose the full contextual denial envelope UC-01 needs. These cannot be assumed triage-compatible. [Shared interfaces](contracts/interfaces.md) specifies a proposed consumer seam; X-FOUNDATION-AGREEMENT must resolve versioned adapter signatures before any UC-01 mock/runtime implementation. Do not fake a bug TaskState or copy the provider budget implementation. Reuse canonical SourceEvidence where compatible and transform only at an agreed boundary.

## Implementation strategy and execution

1. Approve the draft and agree consumer contracts/path ownership with shared owners (T001). No implementation starts from this PR.
2. Validate assessment contracts and build controlled fixtures/spies (T002–T004), distinct from real adapters. This makes independent progress possible after contract agreement.
3. Implement US1 through mocked shared ports (T005–T006); demo classified issue plus evidence-linked severity with zero side effects. This is the first vertical slice and includes setup/foundation prerequisites.
4. Extend US1 to later-answer clarification (T007–T008), then catalog recommendation cases (T009–T010); retain independently runnable story tests.
5. Integrate real shared foundation/policy/accounting only when delivered and approved (T011–T012); do not replace unavailable ports with production mocks. Receiving-workflow compatibility is validated without dispatch (T013).
6. Evaluate safety and real-provider quality separately (T014–T015); authorize any paid/provider run separately with finite approved config. T016 records evidence and leaves unmet runtime checks unverified.

## Verification strategy

- Trace each FR to acceptance cases and implementation tasks; validate schema shapes, citation membership, severity dimensions and question/answer binding.
- Unit/contract tests use disjoint owned paths and deterministic fixtures; no live GitHub issue fetching, network, provider access, commands or actual recovery is implied.
- Attack tests cover injected tools, path escape, protected content, stale continuation, malformed citations, absent/exhausted budgets and uncertain provider usage. Shared guards must prevent effects before denial.
- Integration consumes versioned shared adapters with `real` provenance and records immutable revisions/config identities; perform actual UC-04 restart and UC-05 pause/resume acceptance jointly. Clarification itself is a needs-info result, not a durable wait implementation.
- Compare two held-out evaluation runs with machine-readable metrics, hidden labels outside model/tool context, and owner-approved numeric thresholds. Deterministic schema passes never prove model judgment quality.
- Planning gates: context checker, runtime baseline validator and full Node suite. Those checks validate existing repository integration only; no UC-01 runtime exists in this change.

## Dependencies and release gates

See [tasks.md](tasks.md) for internal DAG and [decisions](contracts/decisions.md) for owner gates. X-FOUNDATION-AGREEMENT gates agreed mocks; X-READ-MODEL and X04-STATE/X05-GATE gate real integration; X-RECEIVER gates recommendation compatibility only. UC-03 repair implementation is not a prerequisite. All are external deliveries, not duplicated UC-01 tasks.

## Complexity Tracking

No governance exception proposed. Narrow consumer seams are necessary because existing bug-specific types are incompatible with triage; shared adapters remain owned by their current owners.
