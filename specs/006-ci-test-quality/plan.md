# Implementation Plan: Contributor CI and Mutation-Guided Test Quality

**Branch**: Existing checkout, preserved | **Date**: 2026-10-28 (Asia/Saigon) | **Spec**: [spec.md](spec.md)
**Input**: [Feature specification](spec.md). Planning-only authorization: [decisions](contracts/decisions.md).

## Summary

Split required CI by responsibility and preserve both OS behavioral lanes. Centralize versioned check names, migrate all consumers together, validate live PR metadata, and retain narrow historical merged-head bindings. Add a separate workflow-dispatch-only Stryker telemetry report. Strengthen sanitizer/truncation tests through selected survivor dispositions rather than a score target. Ship in bounded batches; remote protection activation is an external gate.

## Technical Context

**Language/Version**: Existing JavaScript ES modules, TypeScript 6.0.3, Node 24, pnpm 12.5.1.
**Primary Dependencies**: Existing toolchain; planned exact dev dependency `@stryker-mutator/core@10.1.1`; Gitleaks CLI v8.30.1 in Linux policy CI, verified from its pinned release checksums. Follow the current dependency release-age/frozen-install policy.
**Storage**: Tracked configurations and small public historical bindings; detailed snapshots/reports/dispositions remain ignored local artifacts or bounded CI artifacts.
**Testing**: Node built-in runner; synthetic Git/event/check/scanner fixtures; source/emitted telemetry tests; Stryker assertion-level witnesses.
**Target Platform**: Ubuntu and Windows behavioral jobs; portable static/policy/metadata jobs on Ubuntu; mutation pilot on Ubuntu.
**Project Type**: Contributor tooling/workflows and test-only improvements; no runtime-policy behavior changes.
**Performance Goals**: Preserve current finite 10-minute required-job limits initially; record timings before sharding. Manual mutation job has a 20-minute workflow limit and bounded child execution; incomplete runs fail visibly.
**Constraints**: No pre-PR hook, numeric mutation gate, automatic mutation event, aggregate required job, real provider invocation, env-file inspection during this work or unapproved remote setting changes.
**Scale/Scope**: Ten new required check names, four legacy names during rollout; current runtime/helper selectors remain exhaustive.

## Constitution Check

The constitution contains unfilled placeholders and is not ratified. Apply `AGENTS.md`, contributor/testing rules, naming and privacy requirements. Before design: scope is planning only; after design: the same scope holds. All implementation tasks remain unchecked and require explicit release after both planning reviews. External activation does not follow from planning approval.

## Project Structure

### Documentation (this feature)

`specs/006-ci-test-quality/` contains specification, research, data model, quickstart, tasks, requirement checklist and contracts. Contracts own exact CI/policy/mutation behavior and authorization.

### Source Code (repository root)

- `.github/workflows/contributor-checks.yml`, `runtime-checks.yml`: separated jobs, temporary old jobs for staged rollout.
- `.github/workflows/pr-metadata.yml`, `mutation-report.yml`: new metadata and manual experiment workflows.
- `scripts/ci/required-checks.mjs`, `config/legacy-ci-heads.json`: pure shared policies and narrowly bound historical identities.
- `scripts/ci/check-runtime.mjs`, `run-runtime-tests.mjs`, `run-contributor-tests.mjs`, `test-selection.mjs`: retain complete inventories, clean-build-only CI mode and optional result artifacts.
- `scripts/ci/check-tracked-files.mjs`, `check-env-examples.mjs`, `scan-secrets.mjs`: tracked path policy, strict placeholder examples, pinned/redacted scanner adapter.
- `scripts/ci/check-pr-metadata.mjs`, existing PR conventions and readiness/publication consumers: data-only metadata validation and fresh live checks.
- `scripts/ci/run-mutation.mjs`, `stryker.config.json`, `package.json`, `pnpm-lock.yaml`, `.gitignore`: fixed-profile bounded reporting; installed dependencies/reports remain untracked.
- `tests/ci/`, existing `tests/agents/` fixtures and `tests/runtime/unit/telemetry.test.ts`: focused behavioral regressions.

**Structure Decision**: Reuse current selectors, validators and assessment logic. Centralize policy identity, not every consumer's different result semantics. Add no mutation service, scheduler, custom runner plugin or whole-repository mutation framework.

## Delivery and Migration

1. Inventory the current candidate and live settings without reading local env files. Record all retained historical public PR/head/tree bindings needed for merged-ticket completion; new/open heads always use the current policy.
2. Build pure shared policies and focused regressions. Stage A1 preserves ci-v1 as the sole current policy while available new jobs are added; early preparation is not ci-v2 acceptance. Stage A2 atomically activates ci-v2 only after all ten workflows/validators exist. New checks must then pass before local readiness succeeds, while old remote requirements remain satisfied. Count temporary duplicate old jobs separately from exactly-once new-lane inventories.
3. Implement policy and fresh metadata validation. Keep the metadata workflow independent so body edits do not cancel behavioral runs. Existing full local publication gates retain their default command/order; no mutation command joins them.
4. Add pinned manual Stryker tooling and bounded artifacts; improve selected telemetry tests independently. The whole-module manual profile gets its own baseline, distinct from historical excerpt scores.
5. After authorized publication and observed CI, an explicitly authorized operator updates remote required names/app bindings, preserving strict/admin/human-merge constraints. Read back settings and observe a new candidate. Only then may a cleanup batch remove old jobs. Manual-dispatch availability also requires the workflow on the repository default branch through ordinary approved promotion.

## Verification Strategy

Each implementation task uses a focused RED/GREEN behavioral slice. Exercise policy selectors with foreign heads/apps, old successful reruns followed by failures, unexpected skips and historical identity substitution. Use distinct PR head H, event base B and generated merge M fixtures: new jobs explicitly check out/verify H, and artifacts bind repository/run/attempt/H/OS plus hashes. Failed-only reruns lacking current-attempt builds fail closed. Check complete source/emission inventories. Use synthetic env/scanner fixtures including unchanged-tree and add-then-delete secrets, with redacted-output assertions. Verify metadata edited-event behavior plus fresh live readiness before CI queues. Mutation improvements need exact-mutant assertion failure and original pass; runner fixtures reject pending/count/stale-pair failures. Publication alone runs the full local gate; CI remains independent.

## Complexity Tracking

Historical policy bindings and temporary duplicate jobs are migration costs required to avoid stranding immutable merged revisions or weakening protection. They are exact-identity compatibility, not a permissive old-or-new fallback. Numerical test sharding, incremental mutation reuse and automatic repair of every survivor are deferred.
