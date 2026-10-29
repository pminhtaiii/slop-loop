# Contributor CI Rollout Checklist

This document owns the staged rollout record for the split contributor CI described in
[`specs/006-ci-test-quality`](../../specs/006-ci-test-quality/spec.md). It records an inventory and
prepared steps. It does not change live settings, and a recorded step is not evidence that its
external action occurred until that evidence is pasted here.

Feature authorization: [decisions](../../specs/006-ci-test-quality/contracts/decisions.md).
Check names and identity rules: [CI contract](../../specs/006-ci-test-quality/contracts/ci-checks.md).

## Inventory

Recorded 2026-10-29 (Asia/Bangkok) at source revision `6d823b152ed72e2b7ef0335f7e1e53d8bb120ee2`
on `feat/tooling-claude-skills-entrypoint`. Local env files were not read;
`git ls-files` and live read-only API reads only.

### Workflows and jobs

| File | Job | Produces | State |
| --- | --- | --- | --- |
| `contributor-checks.yml` | `contributor-checks` (matrix ubuntu/windows) | `contributor-checks (ubuntu-latest)`, `contributor-checks (windows-latest)` | transitional old job |
| `runtime-checks.yml` | `runtime-checks` (matrix ubuntu/windows) | `runtime-checks (ubuntu-latest)`, `runtime-checks (windows-latest)` | transitional old job |
| `contributor-checks.yml` | `static-lint` | `static-lint` | staged, not required |
| `contributor-checks.yml` | `static-types` | `static-types` | staged, not required |
| `contributor-checks.yml` | `repository-policy` | `repository-policy` | staged, not required |
| `contributor-checks.yml` | `contributor-tooling-tests` (matrix ubuntu/windows) | `contributor-tooling-tests (ubuntu-latest)`, `contributor-tooling-tests (windows-latest)` | staged, not required |
| `runtime-checks.yml` | `build` (matrix ubuntu/windows) | `build (ubuntu-latest)`, `build (windows-latest)` | staged, not required |
| `runtime-checks.yml` | `runtime-tests` (matrix ubuntu/windows) | `runtime-tests (ubuntu-latest)`, `runtime-tests (windows-latest)` | staged, not required |

Both workflows trigger on `push` to `main`/`development`, every `pull_request`, and
`workflow_dispatch`, with `fail-fast: false`, finite `timeout-minutes`, `contents: read`, and
`persist-credentials: false`. Each duplicate `pnpm run lint`; the contributor job also runs context,
tracked-file and contributor-test steps, and the runtime job runs the full clean runtime gate.
Staged candidate jobs add `ref: ${{ env.HEAD_SHA }}` with a `git rev-parse HEAD` equality check and
echo the distinct base and merge SHAs to the step summary; the transitional jobs keep their original
default checkout. `build` compiles with `--clean-build-only` and uploads
`artifact-identity.json` plus `tests/runtime` and `dist/tests/runtime`; `runtime-tests` downloads only
its own OS artifact and runs `scripts/ci/artifact-identity.mjs verify` before the emitted inventory.

### Remote protection observation (read-only, 2026-10-28)

Development protection required only `contributor-checks (ubuntu-latest)` and
`contributor-checks (windows-latest)`, app ID 15368, `strict: true`, admin enforcement on.
`.github/branch-protection.json` mirrors those two names. There is no `runtime-checks` remote
requirement, while every helper requires all four exact-head checks. Re-observe before Stage B;
this row is a point-in-time observation, not a promise.

### Retained evidence inventories

| Inventory | Value | Command |
| --- | --- | --- |
| All test files | 99 | `node -e "…glob tests/**/*.test.*"` |
| Contributor helper tests (`.test.mjs`, non-runtime) | 41 | `contributorTestFiles(root)` |
| Runtime source tests (`.test.ts`) | 58 | `runtimeTestFiles` inputs |
| Merged PRs into `development` | 67 | `gh pr list --state merged --limit 200` |
| Public repository ID | 1419608901 | `gh api repos/pminhtaiii/slop-loop` |

`scripts/ci/test-selection.mjs` discovers both inventories; counts above are observations at that
revision and are deliberately not asserted by tests.

### Historical identity bindings

`config/legacy-ci-heads.json` admits a historical `ci-v1` policy only for a live `MERGED` public PR
matching every recorded field. Entries are populated only from inspected public identities — never
guessed, never branch-prefix matches, never the private submission repository.

Audit method for a retained entry: read the public PR with `gh api repos/pminhtaiii/slop-loop/pulls/<n>`,
require `state: closed`, `merged_at` non-null, then record `repositoryId`, `number`, `head`,
`head.repo.id`, and the source tree from `gh api repos/pminhtaiii/slop-loop/git/commits/<head>`.
Bindings needed for paired-ticket completion are those whose resolving PRs are merged while their
paired tickets remain open. At this revision no open public issue body references a resolving PR URL
and no retained completion record binds an open pair, so the audited binding list starts empty.
Populate it when a specific merged resolving head is claimed, using the method above.

## Stage A1 — preparation (this batch)

- Shared policy module, historical binding config and focused regressions exist.
- `ci-v1` stays the sole active current policy; all four old names remain required and unchanged.
- New jobs are staged and must appear with runnable commands; they are not yet required.
- Cross-file tests require runnable counterparts only for the active policy and inventory every
  staged non-required job by name.
- Publishable under unchanged existing requirements. It does **not** complete the US1 story.
- Temporary duplication accounting: during A1 the old jobs still run the complete contributor and
  runtime suites. Count those separately from any new lane; exactly-once applies only inside a new
  canonical lane.

## Stage A2 — atomic activation

Prerequisite: every one of the ten ci-v2 counterparts and both validators exist
(`static-lint`, `static-types`, `repository-policy`, `pr-metadata`, and the ubuntu/windows pairs of
`build`, `contributor-tooling-tests`, `runtime-tests`).

1. Switch `ACTIVE_POLICY_ID` in `scripts/ci/required-checks.mjs` to `ci-v2` in the same reviewed change
   that adds the last missing counterpart.
2. Cross-file tests must then require every ci-v2 counterpart and reject an absent `pr-metadata`.
3. Keep all four old jobs running. There is no old-or-new acceptance: current candidates must satisfy
   ci-v2 locally and the old remote requirements independently.
4. Record both old and new executions and their intentional duplicate suite cost here.

## Stage B — operator protection migration (external gate)

Requires explicit authorization for that specific remote change. Not authorized by this document.

- Add all ten ci-v2 names with the GitHub Actions app binding; keep `strict`, admin enforcement and
  existing merge policy.
- Read back the resulting settings and observe one fresh candidate's checks.
- If a read or observation is unavailable, pause; do not weaken or partially apply.

## Stage C — cleanup (separate reviewed batch)

Only after Stage B read-back proves none of the four old names is remotely required: remove the
transitional jobs, update `tests/ci/workflow-contracts.test.mjs`, and keep the historical `ci-v1`
binding selection so immutable merged heads stay assessable.

## Manual mutation workflow availability (separate gate)

`mutation-report.yml` is not required and runs no job on PR/push events. Dispatch is available only
after the file exists on the repository default branch through ordinary approved promotion. A file on
a feature branch is not availability evidence.

## Evidence log

| Date | Stage | Observation | Evidence |
| --- | --- | --- | --- |
| 2026-10-28 | inventory | four old helper-required checks; two remote-required on development; no rulesets; no open public PRs | recording session, read-only API |
| 2026-10-29 | A1 | shared policy, bindings and staged jobs implemented locally at ci-v1 current; no live setting changed | batch session notes |
| 2026-10-29 | A1 | `scripts/ci/required-checks.mjs` + empty audited `config/legacy-ci-heads.json` implemented; `node --test tests/ci/required-checks.test.mjs` 10/10 | local gate |
| 2026-10-29 | A1 | `--clean-build-only` added to the runtime gate; default full sequence unchanged; `node --test tests/ci/runtime-gate.test.mjs` 6/6 | local gate |
| 2026-10-29 | A1 | four consumers read the shared policy at `ACTIVE_POLICY_ID='ci-v1'`; targeted suites 11/11, 39/39 (+1 env skip), 18/18, 11/11 | local gate: `node --test tests/agents/pr-workflow-readiness.test.mjs`, `tests/agents/paired-merge-eligibility.test.mjs`, `tests/agents/complete-paired-issues.test.mjs`, `tests/agents/paired-issue-followup.test.mjs` |
| 2026-10-29 | A1 | six new jobs staged in the two workflows (static-lint, static-types, repository-policy, contributor-tooling-tests ×2, build ×2, runtime-tests ×2) while the four old jobs stay unchanged; `tests/ci/workflow-contracts.test.mjs` 9/9 | local gate |
| 2026-10-29 | A1 | `scripts/ci/artifact-identity.mjs` binds artifacts to repository/run/attempt/H/OS + hash manifest; `tests/ci/artifact-identity.test.mjs` 6/6 | local gate |
| 2026-10-29 | A1 | lane runners emit JUnit results and elapsed diagnostics; `tests/ci/test-partition.test.mjs` 5/5 (+1 env symlink skip); all `tests/ci/*.test.mjs` 74/74 (+1 skip) | local gate |
| 2026-10-29 | A1 | independent Standards/Spec review of T001–T006 found the build artifact omitted `dist/src` (emitted tests import it), head verification ran after install in four staged jobs, and historical binding comparison was case-sensitive; all corrected with RED/GREEN regressions. The correction batch then shared one `selectLatest` selector across the four consumers, made retained `checkPolicy` readable and refused when unknown, and fixed two stale fixtures/tests that the stricter head validation and the always-on JUnit reporter exposed. `node --test tests/ci/*.test.mjs` 76 pass +1 env skip; `node --test tests/agents/*.test.mjs` 303 pass +3 env skips; eslint `.`, `tsc --noEmit`, `check-context.mjs` and `check-tracked-files.mjs` exit 0 | review: `.agent-work/2026-10-29/ci-stage-a1/reviews/` |

| 2026-10-29 | A1 | re-cut onto fresh `feat/tooling-contributor-ci-split` from `origin/development`: `tests/ci/workflow-contracts.test.mjs` failed because its line scanner split on `\n` while `core.autocrlf` writes the workflow files as CRLF; now `/\r?\n/` like the other scanners. `tests/ci/*.test.mjs` 76 pass +1 env skip | local gate |

| 2026-10-29 | A1 | first CI run of PR #122 failed `Test contributor helpers` on both ubuntu jobs. Cause: T006 made the JUnit reporter unconditional but left it the *only* reporter when `WORKFLOW_GATE_PROGRESS` was unset, so the lane wrote no human-readable output to stdout. The `contributor runner executes through a symlink` regression asserts on that text and silently skips on Windows (`File symlinks unavailable`), so the local pass could not see it. `contributorTestArgs` now pairs `spec`→stdout unconditionally with `junit`→file, matching `run-runtime-tests.mjs`; regression asserts the `spec` destination. `tests/ci/*.test.mjs` 76 pass +1 env skip | CI run 40816365325; local gate |

Not yet observed, and not claimed by any row above: real CI execution of the staged jobs, any branch-protection change, ci-v2 activation, or removal of the transitional jobs.
