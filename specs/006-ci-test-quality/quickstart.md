# Validation Quickstart

This describes **future implementation validation**. None of the new commands, workflows or tests below is claimed implemented by this planning change. Read [authorization](contracts/decisions.md), [CI contract](contracts/ci-checks.md), [policy](contracts/repository-policy.md) and [mutation contract](contracts/mutation.md) first. Local env files remain unread.

## Planning gate (runnable now)

```powershell
node scripts/agents/planning-workflow.mjs validate --dir specs/006-ci-test-quality
node scripts/agents/planning-workflow.mjs status --dir specs/006-ci-test-quality
```

A clean automated status still awaits independent reviews; it does not authorize implementation. Evaluate both current-artifact review reports independently and retain their snapshot identity.

## Required CI and identity fixtures (after release/implementation)

```powershell
node --test tests/ci/required-checks.test.mjs tests/ci/runtime-gate.test.mjs tests/ci/workflow-contracts.test.mjs tests/ci/test-partition.test.mjs
node --test tests/agents/pr-workflow-readiness.test.mjs tests/agents/paired-merge-eligibility.test.mjs tests/agents/complete-paired-issues.test.mjs tests/agents/paired-issue-followup.test.mjs
```

Expected: Stage A1 uses only the unchanged current ci-v1 names while future jobs are staged. After atomic Stage A2, all ten ci-v2 names have executable counterparts and are individually required; current/open heads cannot select historical ci-v1, while explicitly matching merged historical heads can. Wrong app/head/tree/PR, stale rerun, missing, skipped/cancelled/failed results remain non-ready. Distinct H/B/M fixtures prove explicit-H checkout; artifacts bind repository/run/attempt/H/OS, and tampering, old attempts and missing/orphan/duplicate emission fail. Observe real Linux/Windows inventories and durations after authorized publication; count old compatibility-lane duplication separately from exactly-once canonical lanes.

## Content and metadata fixtures

```powershell
node --test tests/ci/check-tracked-files.test.mjs tests/ci/env-examples.test.mjs tests/ci/scan-secrets.test.mjs tests/ci/pr-metadata.test.mjs
```

Use disposable Git/event/scanner fixtures only. Confirm force-added prohibited env names fail; exact qualifying examples pass; malformed/oversized/link examples and scanner failures fail; diagnostics contain no values. An unchanged H-tree credential and an add-then-delete range credential must both fail; absent ranges retain complete-tree scanning with an explicit limitation. Body-only invalid edits must block live readiness even while an older same-head metadata check is green. Neither valid drafts nor unknown historical identities bypass policy.

## Manual mutation pilot

After pinned dependency installation and focused runner fixtures:

```powershell
node --test tests/ci/mutation-profile.test.mjs tests/ci/mutation-runner.test.mjs
node scripts/ci/run-mutation.mjs --profile telemetry
```

Expected: fixed whole-module source execution, passing baseline, finite execution and a fresh revision-bound JSON/HTML/summary manifest with unchanged input hashes, zero pending mutants and consistent status totals. Reject stale pairs, unknown statuses and incomplete artifacts. Survivors do not fail a completed reporting run. Setup/worker/job-timeout/artifact failures are nonzero and partial, not a passing score. Check normal PR/push events start zero mutation jobs and no publication gate invokes this runner. Read-only workflow inspection must show `workflow_dispatch` only.

Default-branch promotion and live dispatch require separate authorization and observation; a development-only workflow file is not proof that dispatch is available. Keep the whole-module baseline distinct from the historical excerpt's 61.71%.

## Survivor-remediation witness

```powershell
node --test tests/runtime/unit/telemetry.test.ts
pnpm run build
node --test dist/tests/runtime/unit/telemetry.test.js
```

Verify the exact-16-byte suffix boundary added to `bounded redacted diagnostics enforces byte bounds INCLUDING suffix and safe UTF-8 split`: at `maxBytes: 16` the marker stands alone as `... [TRUNCATED]` with `byteCount: 15`. In an isolated workspace, exercise one of the mutations that boundary pins (197 or 199): the new assertion must fail, then the original candidate must pass after restoration. Re-run only the chosen mutation slice first; record fingerprints and settings. Record every reviewed disposition and remaining unreviewed scope. A mutant the 1,139-input differential grid shows equivalent — 193, for instance — is disposed of by that evidence, not by an artificial assertion.

## Rollout acceptance

1. Stage A1 stages support/new jobs under sole current ci-v1. Stage A2 activates ci-v2 only once all ten executable counterparts exist, observes both old and new checks, and preserves audited historical bindings.
2. An explicitly authorized operator changes protections and records read-back. Preserve strict/admin controls and human merge decisions; verify all ten names/app bindings on a fresh candidate.
3. Only then remove transitional jobs in another reviewed batch. Default-branch promotion and a manual run have their own evidence gate.
4. Refresh actual affected context through the updater. Publication alone runs full local gates; CI and real operator evidence remain independent. Leave any external rollout or selected-survivor gaps unchecked.
