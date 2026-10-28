# Implementation Plan: Paired PR Eligibility Preview

**Branch**: `feat/tooling-paired-merge-eligibility` | **Date**: 2026-10-28 | **Spec**: [spec.md](spec.md)

## Summary

Add a standalone read-only contributor CLI that evaluates a retained pair against one narrow documentation policy. It reads immutable local Git objects and live GitHub evidence, returns a bounded JSON report, and has no merge or apply mode. [The contract](contracts/eligibility.md) owns the exact admission rules.

## Technical Context

**Language/Version**: Existing Node.js ESM contributor tooling, with the repository-pinned runtime.
**Primary Dependencies**: Node standard library, Git and authenticated `gh`; no new package.
**Storage**: Read existing records only; report goes to stdout.
**Testing**: `node:test` with temporary Git repositories, injected structured command executor, file-state snapshots and mutation-denying fixtures.
**Target Platform**: Existing Windows and Ubuntu contributor checks.
**Project Type**: Trusted local contributor CLI; this is outside the product runtime and its adapter claims.
**Performance Goals**: One bounded observation and one final reobservation; no polling or retry loop.
**Constraints**: Every subprocess has a 60-second maximum and 2 MiB output maximum; content is bounded as specified in the contract. Commands use executable/argument arrays with shell disabled. Every Git child, including discovery, receives `GIT_NO_LAZY_FETCH=1` and `GIT_OPTIONAL_LOCKS=0` to prevent lazy object downloads and optional writes.
**Scale/Scope**: One retained published pair per invocation, at most 100 changed paths.

## Constitution Check

The constitution is an unratified placeholder, not an approved source of new rules. Before and after design, apply existing repository policies: preserve human merge authority, existing-test protections, public/private privacy, finite command bounds, and exact evidence binding. This design adds no runtime boundary, remote authority, dependencies, or persistence. Independent standards and testability reviews and automated planning validation are required before implementation; [decisions](contracts/decisions.md) records the user scope separately.

## Project Structure

### Documentation (this feature)

`specs/038-paired-merge-eligibility/` contains this plan, specification, research, data model, quickstart, task ledger, requirement checklist and contracts.

### Source Code (repository root)

- `scripts/agents/paired-merge-eligibility.mjs`: CLI parsing, bounded structured executor, read-only gathering, evaluation and report. Split a cohesive helper only if the repository source-size rule requires it, recording added ownership before edits.
- `tests/agents/paired-merge-eligibility.test.mjs`: focused contract and integration fixtures.
- `docs/agents/pr-workflow.md`: explain the preview and its lack of merge authority.
- `context/workflow.md`: navigation to the preview after implementation evidence exists; update with the context helper.

**Structure Decision**: Keep the preview separate from `pr-workflow status`, which saves observations. Reuse pure branch/target parsing and check assessment where safe. Do not invoke `verifySubmission` or `dataDirectory`: their record-reading path creates directories. Do not call imported `repository()`, whose direct Git executor bypasses the required environment; locate root/primary through read-only inventory using this CLI's bounded executor. Read existing records through validated regular, unlinked paths under the primary checkout. Preserve read-only command construction across all reuse.

## Implementation Sequence

1. Write one failing CLI JSON/no-write tracer-bullet fixture, then implement the evaluator through vertical RED/GREEN slices extending focused policy, readiness and race coverage.
2. Pin live metadata and check evidence before immutable diff inspection; repeat all bound observations and local accounting before eligibility, including normalized effective remote identities and repository visibility. Keep private identities internal. Added files have a valid zero-byte absent preimage.
3. Review the integrated batch, resolve findings, refresh context, and publish through normal paired contributor gates. Publication remains the coordinator's work.

## Complexity Tracking

No policy exception or new framework is required. The preview cannot certify semantic equivalence or authorize a merge.
