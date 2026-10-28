# Quickstart: Paired PR Eligibility Preview

## Prerequisites

Use the repository-pinned Node runtime, Git, authenticated `gh` read access to both configured repositories, a clean published checkout, retained workflow/pair records and the exact live public base/head objects. Both PRs must target development. The integrated focused suite passed 13/13 on 2026-10-28; the task ledger records commands and evidence limits.

## Focused validation

```powershell
node --test tests/agents/paired-merge-eligibility.test.mjs
node scripts/agents/planning-workflow.mjs validate --dir specs/038-paired-merge-eligibility
```

The suite must exercise an eligible prose-only pair, unsupported/governance/content changes, every pair/readiness refusal, changed final observations, missing or malformed records/objects, subprocess failures, and unchanged files/mutation counters. Observe actual exit statuses; fixtures are not proof of live pair eligibility.

Pagination fixtures must put a required check only on a later page, put a newer failed run on a later page after an earlier success, and refuse malformed/incomplete pagination. Confirm these results explicitly rather than relying on a single-page success case.

## Read-only live preview

```powershell
node scripts/agents/paired-merge-eligibility.mjs --root 'C:/path/to/published-checkout'
```

Read `status`, `eligible`, reasons and the snapshot. An eligible result has `ELIGIBLE_PREVIEW`, policy `docs-v1`, and `mergeEnabled: false`. Policy exclusions produce `MANUAL_REVIEW`; incomplete readiness produces `WAITING_EVIDENCE`; known failures or changed evidence produce `BLOCKED`. Never treat exit 0 or a saved report as permission to merge.

The feature implementation PR itself changes tooling and policy documentation, so it must be ineligible under its own documentation allowlist. No live eligible-pair result is required to claim fixture completion; report unrun live validation explicitly.

Live eligibility validation has not been run. The passing disposable fixtures do not establish any real PR's eligibility or authorize merging.
