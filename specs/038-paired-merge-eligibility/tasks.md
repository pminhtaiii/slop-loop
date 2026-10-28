# Tasks: Paired PR Eligibility Preview

**Input**: [spec.md](spec.md), [plan.md](plan.md), [contracts](contracts/eligibility.md).
**Authorization**: [decisions](contracts/decisions.md); all work waits for the current-artifact planning quality gate.
**Tests**: Required by FR-008; write meaningful failing fixtures before implementation.

## Phase 1: Setup

No package, framework, migration or new infrastructure is needed. Planning validation and independent reviews are external gates, not implementation task status.

## Phase 2: Foundational

The existing paired publication records and four public CI job names are prerequisites. Preserve their schemas and merge authority.

## Phase 3: User Story 1 - Explain documentation eligibility (Priority: P1)

**Goal**: Return a read-only, revision-bound documentation eligibility report.
**Independent Test**: An eligible controlled pair passes; each policy/readiness/race failure refuses; retained files and mutation counters remain unchanged.

- [x] T001 [US1] Add one failing tracer-bullet CLI JSON and no-write fixture in `tests/agents/paired-merge-eligibility.test.mjs`.
  - **Owned Paths**: `tests/agents/paired-merge-eligibility.test.mjs`
- [x] T002 [US1] Implement the bounded read-only CLI and `docs-v1` contract in `scripts/agents/paired-merge-eligibility.mjs` through vertical RED/GREEN slices extending `tests/agents/paired-merge-eligibility.test.mjs` for policy, pair/readiness and race refusals, including later-page required checks, later-page newer failures and malformed/incomplete pagination; record focused results in `specs/038-paired-merge-eligibility/tasks.md`.
  - **Owned Paths**: `scripts/agents/paired-merge-eligibility.mjs`, `tests/agents/paired-merge-eligibility.test.mjs`, `specs/038-paired-merge-eligibility/tasks.md`
  - **Dependencies**: T001

## Phase 4: Polish & Cross-Cutting Concerns

- [x] T003 Document preview usage and evidence limits in `docs/agents/pr-workflow.md`, refresh navigation in `context/workflow.md` through the context helper, and validate the quickstart in `specs/038-paired-merge-eligibility/quickstart.md`.
  - **Owned Paths**: `docs/agents/pr-workflow.md`, `context/workflow.md`, `specs/038-paired-merge-eligibility/quickstart.md`
  - **Dependencies**: T002

## Dependencies & Execution Order

T002 follows T001
T003 follows T002

All implementation tasks are serialized; no parallel file ownership is claimed. Independent planning reviewers and the final standards/spec reviewers may run concurrently as read-only work against a pinned snapshot.

## Implementation Strategy

US1 is the MVP and the entire authorized implementation scope. Use one vertical test/implementation slice, review the integrated batch, refresh context, then let the coordinator publish through normal paired PR gates. A passing task or preview releases neither merge execution nor additional eligibility categories.

## Implementation Verification

On 2026-10-28 (Asia/Saigon), the merger verified the worker's owned-path handoff at base `17f2fbb5b3e78cae2def4f837bd7efd6c2fd26b4`; source and test hashes matched, with no source changes needed in the shared checkout. The worker retained tracer-bullet and eligibility RED/GREEN evidence, a 12/12 suite pass, and a final 4/4 affected-case pass. Merger replay of `node --test tests/agents/paired-merge-eligibility.test.mjs` exited 0: 13/13 tests passed, no skips or failures. `git diff --check` exited 0. Worker scoped ESLint and both `node --check` commands also exited 0. These controlled fixtures establish only exercised dry-run behavior; live GitHub eligibility, full publication gates and final independent review are separate.
