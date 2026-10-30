# Contributor CI Rollout Checklist

## Ubuntu-only replacement � 2026-10-30

The user selected Ubuntu-only CI; see the [bounded amendment](../../specs/006-ci-test-quality/contracts/ubuntu-only.md).
The current source policy is `ci-v4` with seven direct, OS-independent check names:
`static-lint`, `static-types`, `repository-policy`, `pr-metadata`, `build`,
`contributor-tooling-tests` and `runtime-tests`. All jobs run on Ubuntu. The two
legacy matrix jobs, including duplicate Ubuntu tests, are removed in the final
cleanup source batch. Complete inventories, validators and revision-bound
artifacts remain; all three earlier policy lists remain immutable for audited
merged identities.

The user explicitly approved the seven-check protection migration and then chose
removal of both old jobs and OS suffixes. Development protection was migrated to
ci-v3 with app ID 15368, strict updates and all other settings unchanged. Read-back
matched the exact names; fresh checks on PR #126 head `fa5dee8` passed after
migration ([contributor attempt 2](https://github.com/pminhtaiii/slop-loop/actions/runs/40997729035/attempts/2),
[runtime attempt 2](https://github.com/pminhtaiii/slop-loop/actions/runs/40997729126/attempts/2)).
This satisfies the prerequisite for legacy cleanup. Detailed before/after JSON
and exact-head evidence are retained locally under
`.agent-work/2026-10-30/ubuntu-only-ci/`.

Live requirements still use the ci-v3 OS-qualified names until all seven renamed
ci-v4 checks pass on the cleanup candidate. The three absent old names deliberately
block merge during that transition. The approved operator then replaces them with
ci-v4, reads back unchanged protections and verifies fresh exact-head checks. No
merge is authorized or performed. The workflow files reach development only through
the ordinary human merge decision; this source cleanup alone does not establish
live branch-wide Ubuntu-only execution.

The stages and observations below describe the earlier ci-v2 rollout and remain
historical evidence; the amendment governs the new replacement.


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
| `contributor-checks.yml` | `static-lint` | `static-lint` | required under `ci-v2` |
| `contributor-checks.yml` | `static-types` | `static-types` | required under `ci-v2` |
| `contributor-checks.yml` | `repository-policy` | `repository-policy` | required under `ci-v2` |
| `pr-metadata.yml` | `pr-metadata` | `pr-metadata` | required under `ci-v2` |
| `contributor-checks.yml` | `contributor-tooling-tests` (matrix ubuntu/windows) | `contributor-tooling-tests (ubuntu-latest)`, `contributor-tooling-tests (windows-latest)` | required under `ci-v2` |
| `runtime-checks.yml` | `build` (matrix ubuntu/windows) | `build (ubuntu-latest)`, `build (windows-latest)` | required under `ci-v2` |
| `runtime-checks.yml` | `runtime-tests` (matrix ubuntu/windows) | `runtime-tests (ubuntu-latest)`, `runtime-tests (windows-latest)` | required under `ci-v2` |

Required state is a **source** statement: `scripts/ci/required-checks.mjs` names these ten under the
active `ci-v2` policy. Whether a given remote branch protection rule enforces them is a separate,
unobserved question — see Stage B.

Both code workflows trigger on `push` to `main`/`development`, every `pull_request`, and
`workflow_dispatch`, with `fail-fast: false`, finite `timeout-minutes`, `contents: read`, and
`persist-credentials: false`. Each duplicate `pnpm run lint`; the contributor job also runs context,
tracked-file, environment-example, secret-scan and contributor-test steps, and the runtime job runs
the full clean runtime gate. Staged candidate jobs add `ref: ${{ env.HEAD_SHA }}` with a
`git rev-parse HEAD` equality check and echo the distinct base and merge SHAs to the step summary; the
transitional jobs keep their original default checkout. `build` compiles with `--clean-build-only` and
uploads `artifact-identity.json` plus `tests/runtime`, `dist/tests/runtime`, `dist/src` and `dist/eval`;
`runtime-tests` downloads only its own OS artifact and runs `scripts/ci/artifact-identity.mjs verify`
before the emitted inventory.

`pr-metadata.yml` observes only `pull_request` events (`opened`, `reopened`, `synchronize`, `edited`,
`ready_for_review`, `converted_to_draft`) in its own concurrency group, so a title or body edit never
cancels a behavioral lane. It validates the event payload as data and checks out both base and candidate
revisions. The base revision's validator and audited binding list are preferred when present, so edits
to the candidate validator do not grade themselves. The introducing PR is a bootstrap exception: when
the base has no validator, the lane executes the candidate copy. Drafts are validated too; draft state
stays a human-readiness question, not a skip.

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

## Stage A1 — preparation (superseded by A2)

- Shared policy module, historical binding config and focused regressions exist.
- `ci-v1` stays the sole active current policy; all four old names remain required and unchanged.
- New jobs are staged and must appear with runnable commands; they are not yet required.
- Cross-file tests require runnable counterparts only for the active policy and inventory every
  staged non-required job by name.
- Publishable under unchanged existing requirements. It does **not** complete the US1 story.
- Temporary duplication accounting: during A1 the old jobs still run the complete contributor and
  runtime suites. Count those separately from any new lane; exactly-once applies only inside a new
  canonical lane.

## Stage A2 — atomic activation (source switch applied)

Prerequisite: every one of the ten ci-v2 counterparts and both validators exist. All ten do.

1. `ACTIVE_POLICY_ID` in `scripts/ci/required-checks.mjs` is now `ci-v2`, in the same reviewed change
   that adds the last missing counterpart (`pr-metadata`).
2. Cross-file tests now require every ci-v2 counterpart and reject an absent `pr-metadata`.
3. All four old jobs keep running. There is no old-or-new acceptance: current candidates must satisfy
   ci-v2 and any still-configured remote requirement independently.
4. Duplicate suite cost during this overlap is intentional and counted separately from a canonical
   lane's exactly-once inventory.

This stage changes source only. It does not change any remote protection rule, so **remote enforcement
of the ten names is not claimed** until Stage B is observed.

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
| 2026-10-29 | A1 | second CI run of PR #122 failed only the staged runtime-tests (windows-latest) job: ERR_MODULE_NOT_FOUND for `dist/eval/uc03/runner.js`. The artifact shipped `dist/src` but not `dist/eval`, and the manifest listed both by hand, so nothing checked for a new emitted root. Both now include `dist/eval`, and `workflow-contracts.test.mjs` derives the required trees from the build output instead of a fixed list (verified RED without the workflow line). | CI run 40819019728 |
| 2026-10-29 | A1 | first CI run of PR #122 failed `Test contributor helpers` on all four contributor jobs (ubuntu and windows). Cause: T006 made the JUnit reporter unconditional but left it the *only* reporter when `WORKFLOW_GATE_PROGRESS` was unset, so the lane wrote no human-readable output to stdout. The `contributor runner executes through a symlink` regression asserts on that text and silently skips on Windows (`File symlinks unavailable`), so the local pass could not see it. `contributorTestArgs` now pairs `spec`→stdout unconditionally with `junit`→file, matching `run-runtime-tests.mjs`; regression asserts the `spec` destination. `tests/ci/*.test.mjs` 76 pass +1 env skip | CI run 40816365325; local gate |
| 2026-10-29 | A2 | `pr-metadata.yml` added (pull_request events only, own concurrency group, event payload as data, base-revision checkout only — later corrected below) and `repository-policy` extended with the environment-example and secret-scan steps; `ACTIVE_POLICY_ID` switched to `ci-v2` in the same change. Cross-file tests now require all ten names and reject an absent metadata workflow. **No remote protection rule was read or changed.** | local gate: `node --test tests/ci/*.test.mjs` 116 pass +1 env skip; `node --test tests/ci/required-checks.test.mjs` 12/12 |
| 2026-10-29 | A2 | independent review of the integrated batch found the following, all repaired with regressions: `workflow-contracts.test.mjs` accepted any non-empty `run:`, so a deleted or `echo skipped` validator still passed — a `REQUIRED_COMMANDS` table now names each required job's exact command(s); `pr-metadata.yml` checked out the default candidate merge commit, so a PR could self-certify by editing `check-pr-metadata.mjs` — the checkout is now `github.event.pull_request.base.sha`, and the `ci-checks.md`/rollout prose that claimed "no candidate checkout" was corrected (a base tree *is* checked out); `check-env-examples.mjs` echoed candidate-controlled paths into diagnostics and allocated a blob's real size — it now substitutes `<unprintable path>` and caps an over-limit blob at `MAX_BYTES + 1`; `pr-conventions.mjs` `validSummary` refused only CR/LF — it now refuses every C0 control character and DEL. Earlier same-batch repairs also confirmed present: deny-by-default `.env` classification in `check-tracked-files.mjs`, binding-free `resolvePolicy` with both-sided identity fields, and the current-convention default in `check-pr-metadata.mjs`. **No remote protection rule was read or changed, and no CI run backs this row.** | local gate: `node --test tests/ci/*.test.mjs` 106 pass +1 env skip |
| 2026-10-29 | A2 | the first real run of PR #123 exposed a deadlock, not a flake: `pr-metadata` pinned its checkout to the base SHA, but that base tree has no `scripts/ci/check-pr-metadata.mjs`, so `Cannot find module` failed every run while ci-v2 requires the job. The fix checks out both base and head and prefers the base copy on presence; only the introducing PR is graded by its own copy. `tests/ci/workflow-contracts.test.mjs` now asserts both checkouts and the presence selection. **Local-gate evidence only: no observed remote CI success, and Stage B is not claimed.** | local gate: `node --test tests/ci/workflow-contracts.test.mjs` 10/10; `node --test tests/ci/*.test.mjs` |

| 2026-10-30 | A2 | PR #123 at `3dffcbf` ran all ten ci-v2 checks: Windows contributor tests failed on a fixture's LF/CRLF assumption; the other nine required checks passed. Pinning the fixture repository's `core.autocrlf=false` preserves its exact-byte assertions. Independent review also identified missing historical-policy selection in merged-ticket completion and stale metadata-bootstrap prose. Completion now selects ci-v1 only from an exact audited binding matched to live public repository/PR/head identities and the source-head tree; unbound heads retain ci-v2. | CI run 40919239719; local `node --test tests/ci/scan-secrets.test.mjs`: 18 pass, 1 host symlink skip; `node --test tests/agents/complete-paired-issues.test.mjs tests/agents/paired-issue-followup.test.mjs`: 38/38; the bound historical preview was RED before integration and GREEN after |

Not yet established by this log: a complete successful exact-head CI result for the repaired revision,
any branch-protection change, remote enforcement of the ci-v2 names, or removal of transitional jobs.
