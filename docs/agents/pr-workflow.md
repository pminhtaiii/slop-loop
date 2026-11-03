# Contributor PR Workflow

This workflow covers the repository's approved contributor PR pilot. It governs contributor coordination, not the slop-loop product runtime. The target runtime policy remains in [tools and permissions](../../context/tools_permissions.md).

[Paired publication](paired-publication.md) is enabled by [publication-targets.json](../../publication-targets.json): `origin` remains the public review repository against `development`, and a private `submission` partner receives the same tracked source tree against `development`. The publish command handles both. Private repository identity stays out of public bodies; both returned PRs must be linked in the app before completion.

## Authority and merge

The coordinator has standing limited authorization to commit scoped contributor changes, push feature branches, and create or update their PRs through the pilot workflow. Workers can return local changes to the coordinator; they do not write to GitHub or push. The helper uses Git and the signed-in human's `gh` account; this pilot does not provision a separate GitHub bot identity.

Every public review PR targets `development`; its configured submission partner targets `development`. Never push directly to `main` or `development`. The helper does not merge. A human decides each merge. The coordinator may execute a merge only when explicitly instructed for that PR, after exact-head CI passes and GitHub reports no merge blocker. Authorization to open or merge another PR does not carry over; never bypass branch protections. Bot approval is optional, GitHub review approval is not a branch requirement, and there is no auto-merge.

## Documentation eligibility preview

Run `node scripts/agents/paired-merge-eligibility.mjs --root <checkout>` on a clean, already published feature checkout to inspect its retained pair. This standalone command reads both live PRs, their development bases and matching source trees, and the latest exact-head public required checks. It reobserves those inputs before returning eligibility. It creates no records, fetches no missing objects, changes no PR readiness, and has no merge or apply mode.

The initial `docs-v1` policy admits added or modified non-executable regular Markdown files only at `README.md`, `docs/user/`, and `docs/guides/`. It excludes governance paths and names, deletes/renames/mode changes, binary or oversized content, fenced/indented examples and raw HTML. It is a lexical policy, not a claim that prose is correct or harmless.

Read JSON `status`, `eligible`, `reasons`, and `snapshot`; exit 0 alone is not eligibility. `ELIGIBLE_PREVIEW` always has `mergeEnabled: false`. `MANUAL_REVIEW` identifies unsupported changes, `WAITING_EVIDENCE` identifies missing/pending evidence, and `BLOCKED` identifies invalid, failed or changed observations. Reports include short explanations and keep private repository names/URLs out of output. Missing immutable public base/head objects require normal preparation outside this read-only command.

The [feature contract](../../specs/005-paired-merge-eligibility/contracts/eligibility.md) defines exact limits and prerequisites. Controlled tests use `node --test tests/agents/paired-merge-eligibility.test.mjs`; they establish exercised local behavior only. Automatic merge execution, partial-merge recovery, refactoring/module-graph analysis, coverage and mutation comparisons remain outside this first scope. The human merge rule above still applies, and a saved preview grants no future action authority.

## Branch and size

Before editing an assigned feature checkout, run `node scripts/agents/pr-workflow.mjs preflight`. It fetches `origin/development`, reports ahead/behind counts, branch naming, dirty paths, and committed diff size, and returns `READY_TO_WORK` or `BLOCKED`. Exit 0 means the report succeeded; read its status. Fetch failure stops the report rather than trusting stale refs. It never switches branches, resets files, rebases, pushes, or opens a PR. Resolve a stale base or invalid branch deliberately; inspect dirty files and retain work. When resuming the same assignment, dirty paths may be expected and require review rather than discarding them. A clean preflight is not a CI or merge-readiness result.

For a new worker worktree, follow [the recorded-base rule](../../context/workflow.md#agent-coordination) and the authoritative [workspace guide](workspace.md) for reservation, readiness and bind operations. Reservation owns the fresh fetch, exact SHA checks and fail-closed dispatch; never select a local `development`, feature, or integration ref as the default base. A later remote advance does not rewrite the creation base.

Follow the [branch and PR conventions](pr-conventions.md) for unnumbered scoped branch names, matching PR titles, action summaries and the three-section body. The pilot base is `development`; parent-branch stacking is outside this pilot. Historical identities remain readable as described there.

Keep the change near 1,000 added plus deleted lines against the immediate base (`origin/development`). This is an advisory target. Report reviewable line changes and generated lockfile changes separately, along with their sum and binary file count. If the total is over target, explain why and split the work when it can stand alone. The pilot uses this repository's Node context and test gates; other native project stacks need explicit plan metadata before they are added.

## Publish a draft

Before each publish, review the current scoped revision, refresh affected context, and prepare a PR body from the current diff and verified evidence using the [PR body skill](../../.agents/skills/pr/SKILL.md). The coordinator commits that revision to a clean feature branch; `publish` refuses a dirty checkout. It checks recorded PR identity/state before expensive gates and rechecks the PR number and head before pushing, so a concurrent merge or external commit stops publication.

Call `publish` as soon as the first coherent, scoped revision is ready. It selects local gates from the changed paths as described below and always enforces tracked-artifact and publication identity policies. Full mode additionally runs `node scripts/ci/check-context.mjs`, `node scripts/ci/check-runtime.mjs` and `pnpm run test:contributors`. This command is the sole local full runtime/contributor gate runner for the publication candidate; do not run the same full suite separately beforehand. Worker, merger, and reviewer checks stay focused. Full-mode gate results are not cached. Automatic contributor-only skips are recorded explicitly, and CI remains independent. It measures the diff against `origin/development`, pushes the feature branch with its matching remote feature branch as upstream, then creates a draft PR or updates the existing open PR. In full mode, runtime validation removes stale dist output, then runs typecheck, lint, build and compiled runtime tests through the same command used by runtime CI. The runtime test selector checks source-to-emission parity and runs only emitted runtime tests; the contributor command covers helper tests without collecting runtime sources again. When package manifests, pnpm lock/workspace settings, .npmrc or pnpm hooks differ from the last locally verified head (or development when no locally verified head exists), publish first runs `node scripts/ci/check-dependency-install.mjs`: a frozen install with a unique metadata cache and explicit lockfile policy verification. This leaves the release-age policy enabled and removes only its own temporary cache. Documentation-only subsequent revisions skip this install check. The tracked-file guard also runs in CI as `node scripts/ci/check-tracked-files.mjs`; ignored local dependencies and tracked dependency lockfiles are permitted. `publish` combines the branch and required `--summary` as the PR title and rejects a base other than `development`.

```powershell
node scripts/agents/pr-workflow.mjs publish --base development --body-file <file> --summary "<short summary>" [--skip-review-request] [--root <checkout>]
```

Automatic path selection records its version, exact base/candidate, changed paths and reason: push-only for known documentation/contributor-only paths, full gates for runtime, dependency, build/CI configuration, mixed or unknown paths. Classification errors block publication. Use `--mode full` to force full local verification; explicit `--mode push-only --reason "<caller rationale>"` retains its caller-selection requirement. Renames consider both endpoints. Push-only preserves `localVerifiedHead` separately from `publishedHead` and reports `localGateStatus: "skipped"`, never a fresh full-gate pass. Only a matching, revalidated automatic contributor-only policy can use independent current-head CI in place of local suites at completion; legacy/explicit skips retain their existing restrictions. Required remote CI, app links, paired identity, clean current revision and human merge authority remain unchanged.

Refresh the body after each repair so its summary and evidence describe the latest head. `publish` is the authorized remote-write path for this pilot.

After publishing a new head, the helper requests CodeRabbit with `@coderabbitai review`. Pass `--skip-review-request` when the user requests publication without an automatic review request; this does not change the gates, paired draft PRs, or readiness requirements. By default, a head-specific marker and retained accounting prevent duplicate requests when the same publication is resumed. This also works when CodeRabbit skips automatic reviews for the repository. Review service rate limits or missing bot approval do not block readiness.

The GitHub Actions workflow named **Contributor checks** runs context consistency, dependency install and `pnpm run test:contributors` on Ubuntu. Runtime CI runs `pnpm run validate:runtime`, which checks that every runtime source test has one emitted counterpart before executing the compiled suite. These jobs validate contributor tooling and documentation; they do not establish that the planned product runtime is implemented.

## Check readiness

`status` compares local HEAD with the public open PR head and inspects checks and review data for that SHA. Read the returned JSON `status` field; exit code 0 means the observation ran, not that CI or review passed. Readiness requires the four current-head public `ci-v5` checks (`static-lint`, `static-types`, `repository-policy`, `pr-metadata`) and no non-draft GitHub merge blocker. The `build`, `contributor-tooling-tests` and `runtime-tests` lanes still run but do not gate a merge. The required names come from `scripts/ci/required-checks.mjs`; a `ci-v1`–`ci-v4` head is assessable only through an audited merged binding in `config/legacy-ci-heads.json`. That is a source-required statement — remote branch protection enforcing the same names is a separate, unobserved question (see `ci-rollout.md`). Unresolved conversations remain visible in `unresolved` for human assessment; they do not alone change readiness to `NEEDS_FIX`. CodeRabbit review decisions are advisory; missing or stale public CI stays waiting or blocked. In paired publication, submission PR identity, source-tree synchronization, and merge state are checked separately; submission CI is informational and does not drive public readiness or automatic repair/watch behavior.

```powershell
node scripts/agents/pr-workflow.mjs status [--root <checkout>]
node scripts/agents/pr-workflow.mjs watch [--root <checkout>]
```

`watch` observes the public PR every 15 seconds for at most ten minutes, then returns `TIMED_OUT` with state retained. It is not a submission-CI watcher. The compatibility command `node .agents/skills/pr-feedback-loop/scripts/inspect-ci.mjs` delegates to `status`; it has no repository-specific or latest-run fallback.

Use `ready` when status is `READY_FOR_HUMAN`. That command rechecks the PR and moves a draft to ready for review, recording `AWAITING_HUMAN_MERGE`; it never merges. Repeating it for an already eligible non-draft PR is safe; subsequent status reports retain `AWAITING_HUMAN_MERGE`. The state name records the human decision boundary; it does not prohibit coordinator execution of a merge explicitly authorized for this PR. The helper itself has no merge command. When authorized, use `gh pr merge <number> --squash --match-head-commit <verified-sha>` after rechecking readiness; otherwise stop for the human decision. Keep auto-merge disabled.

```powershell
node scripts/agents/pr-workflow.mjs ready [--root <checkout>]
```

## Enforce completion

`active-task.mjs finish` calls `pr-workflow.mjs complete` before changing the assignment to completed. Completion requires a clean checkout, current publication evidence with full local verification or a revalidated automatic contributor-only skip, a live matching open PR against development, an app-link receipt, a two-axis review receipt for the current head, all four current-head public `ci-v5` checks passing and no GitHub merge blocker. Advisory comments remain part of the human merge decision. Unpublished, dirty, stale, unlinked or failing work stays active/blocked. Pending CI also stays active; hand monitoring to the app watcher and finish after checks pass. A final status report is not contributor completion, and merging is not required. If the user selects local-only work or no push, use the worker handoff and report local evidence without claiming this PR completion gate passed.

After linking the PR, save the app's `list_thread_pull_requests` result as ignored local JSON. Import that result rather than a handwritten link claim:

```powershell
node scripts/agents/pr-workflow.mjs record-app-state --receipt .agent-work/<date>/<session>/app-state.json
node scripts/agents/active-task.mjs finish --owner <owner> --task <task> --result "Published PR and passing checks"
```

The receipt is local workflow accounting, not a signed security credential. The helper verifies publication and CI live through GitHub; repository tools cannot intercept an arbitrary assistant final response. AGENTS and the build workflow route completion through this gate. Register new existing-checkout workers through `contributor-prepare.mjs --register --session <date/session-id>` and declare their exact files with `--owned-path`; they return `handed-off` results with `handoff`, without completing the coordinator's assignment or gaining remote authority. Coordinators run `verify-handoff` before integrating or publishing worker changes; legacy handoffs without owned paths remain unverified. Coordinator roles cannot use worker handoff. Archive/retirement accepts reviewed worker handoffs separately from published contributor completion. Session finish checks active/blocked assignments for the matching session, while legacy unknown-session records block conservatively when their checkout matches or is unknown. Worktree retirement remains checkout-wide, so assignments in other sessions still prevent deletion.

Record the end-of-batch two-axis review once the implementation batch is integrated. The receipt is JSON naming `base` and `head` as full commit SHAs, an `axes` array of exactly two entries (each with a non-empty `name` and its `findings` as an array of strings), and a `reports` array naming the two axis report files. `base` must be a real ancestor of `head`, must differ from it, and must differ in content; each report must be a distinct, non-empty regular file. The receipt's `head` must equal the current checkout HEAD, and completion requires a stored receipt for that same head. Like the app-link receipt, this is local workflow accounting rather than a signed security credential.

When the user explicitly opts out of post-implementation review, record that instead of inventing a review. The receipt is `{"head": "<sha>", "optedOut": true, "reason": "<the user request>"}`; the reason is required, because an unrecorded opt-out is indistinguishable from a skipped review.

```powershell
node scripts/agents/pr-workflow.mjs record-review --receipt .agent-work/<date>/<session>/review.json
```

## Yield and resume

Use the [background publication runner](publication-jobs.md) to apply the automatic publication policy, retain a job ID and yield the agent turn. Resume from its durable result; waiting keeps the assignment active and does not imply contributor completion.

## Repair, logs and release

Fixing findings on a published head, the gate log layout, and preparing the next branch after a merge are in [repair and release](pr-repair-and-release.md).
