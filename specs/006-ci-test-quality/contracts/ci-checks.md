# CI Check and Migration Contract

## Current policy

The planned current policy ID is `ci-v2`. Its exact direct check names are:

| Job | Check names |
| --- | --- |
| Static | `static-lint`, `static-types` |
| Policy and metadata | `repository-policy`, `pr-metadata` |
| Build | `build (ubuntu-latest)`, `build (windows-latest)` |
| Contributor tooling | `contributor-tooling-tests (ubuntu-latest)`, `contributor-tooling-tests (windows-latest)` |
| Product runtime | `runtime-tests (ubuntu-latest)`, `runtime-tests (windows-latest)` |

`scripts/ci/required-checks.mjs` is the single pure definition consumed by workflow-contract tests, PR readiness, paired-issue state and paired eligibility. After the explicit Stage A2 activation below, all ten are required; `mutation-report` is explicitly absent. During Stage A1 preparation only the single active ci-v1 policy remains current. Activation is a reviewed source change, never an environment, PR-input or missing-check fallback. There is no aggregate required gate.

For each name, retain the latest check-run ID for the exact candidate SHA from GitHub Actions. Every required result must be completed/success. Missing/pending results wait; failures, cancellation, skips and invalid identity remain non-ready according to the consumer's existing vocabulary. Preserve public/submission identity and source-tree checks, human merge decisions and privacy. This feature changes evidence names, not eligibility categories or runtime authority.

## Historical identity

The policy `ci-v1` contains the four old contributor/runtime matrix names. After Stage A2 activates ci-v2, ci-v1 is historical-only: usable only for a live MERGED public PR whose repository ID, PR number, exact head SHA and source tree match an audited entry in `config/legacy-ci-heads.json`. Reject wildcard entries, unknown policy IDs, ambiguous/duplicate keys and identity substitution. After activation, new/open heads always require ci-v2, even when their source matches an old commit or their receipt recorded ci-v1 before activation. Historical checks still require latest exact-head GitHub Actions completed/success results; an allowlist entry is not a check pass. Before activation, current ci-v1 preserves the existing four-check rule exactly, not an optional choice between policies.

The same configuration may identify retained historical convention versions by public repository ID, PR number and immutable head-ref identity. Such a convention binding does not select an old CI policy for an open PR. Default new PR metadata uses current conventions; unknown historical identities require manual resolution rather than permissive fallback. Populate entries only from inspected retained publication identities/live public metadata, never a guessed timestamp or branch-prefix exception. Keep private partner identity out of this file.

## Workflow behavior

Required code/policy workflows run on every PR revision, main/development pushes and existing manual triggers without path-based omission. Lint/typecheck/policy run on Ubuntu. Behavioral matrices retain fail-fast:false and both OS lanes. Static checks may run independently for diagnostics.

Build uses a clean-build-only mode of the existing runtime gate, retaining its default full mode unchanged. It uploads emitted tests/source as an artifact bound to repository ID, workflow run ID, run attempt, source SHA, OS and manifest hashes. Runtime tests download only the matching artifact, verify identity/integrity and run the complete current emitted inventory through the existing selector. Contributor tests retain their current complete selector independently of build. Exactly-once inventory applies inside each new canonical lane; old transition jobs deliberately repeat complete suites and are counted separately. Missing/orphan/duplicate emission inside a canonical lane fails. No downloaded cache may satisfy a build without current identity checks. Retain machine-readable test results and job durations on success/failure; artifact absence after an allegedly complete run is visible. Job timeouts remain finite.

### Canonical source identity

For a PR event define H=`pull_request.head.sha`, B=`pull_request.base.sha`, and M=`github.sha` (the event's generated merge SHA). Every new candidate-code job checks out H explicitly and verifies `git rev-parse HEAD == H`; metadata validation consumes its event data separately. Record B and M as provenance without assuming either equals H. Native check runs must still be associated with current H; that association alone does not prove the executed checkout. A historical observed run demonstrated checks on H while default checkout executed M, so this distinction is mandatory.

For a push use H=`github.sha`, with the verified before SHA as range provenance. For manual dispatch H is the resolved selected ref commit and must equal the verified checkout SHA. The emitted artifact identity is `(repositoryId, runId, runAttempt, H, OS)` plus file hashes; B/M remain distinct optional event provenance. A failed-jobs-only rerun without a matching current-attempt build artifact fails closed and requires rerunning the dependent build/test set, rather than silently using the preceding attempt. Fixtures must use distinct H/B/M and attempts, and reject a checkout/artifact of M when H was selected. Strict up-to-date branch protection and live merge-readiness checks remain necessary: these jobs establish H behavior, not an unobserved future merge result.

The metadata workflow uses `pull_request` events opened/reopened/synchronize/edited/ready_for_review/converted_to_draft, read-only permissions and non-persisted checkout credentials. Event JSON is data, never interpolated shell code. It checks drafts too; draft status remains a separate human-readiness state, not a reason to skip validation. Its concurrency group is separate so metadata edits do not cancel behavioral jobs. Do not use privileged target-event execution of candidate code.

Readiness fetches current title, body, base, head ref/SHA and applicable convention identity and validates them live, including while same-head edited-event checks queue. Malformed, missing or failed metadata reads remain non-ready. Reuse the established title/description rules rather than introducing a new naming scheme. Existing bounded pagination and latest-rerun rules remain enforced.

## Staged rollout

Observed on 2026-10-28: GitHub development protection requires only the two contributor matrix checks (GitHub Actions app ID 15368), strict update checking and admin enforcement. Helpers require four checks. No rulesets or open public PRs were returned by the read-only inspection. These are observations, not a promise about future state.

Stage A1 introduces shared policies, historical bindings and available new jobs while leaving ci-v1 as the sole active current policy. Such a preparatory PR is publishable under unchanged existing requirements, but does not claim the completed ci-v2 story. Cross-file tests require executable counterparts only for the active policy and explicitly inventory non-required staged jobs.

Stage A2, only after every new workflow and validator exists, atomically selects ci-v2 for all current-policy consumers and its cross-file tests. Keep all four old jobs running temporarily. There is no old-or-new acceptance for a new candidate; current ci-v2 and old remote requirements must each be satisfied independently. Record both old/new executions and their intentional duplicate suite cost.

Stage B is an explicitly authorized operator change to all ten new protection names/app bindings with strict/admin and existing merge policies preserved; record before/after observations and verify a fresh candidate. Stage C removes the four old jobs only after read-back proof that none is remotely required. Failure or unavailable evidence pauses activation/cleanup rather than weakening checks. Plan separate reviewable PRs for preparation, activation and cleanup; no direct pushes or unapproved merges.

The manual workflow must exist on the repository default branch before dispatch can be claimed available. Promotion uses ordinary authorized PR/merge paths. No default-branch promotion or remote setting mutation is performed by planning or by a local passing test.
