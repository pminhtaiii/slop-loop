# Contributor PR pilot verification

Base: `323b907541db4ca2817b761ecf4bf3f42ac2660f` (`main` when the pilot began). Feature branch and PR title: `feat/001-pr-automation`; base branch: `development`. This is contributor tooling, not product-runtime completion.

## Local evidence

- `node scripts/ci/check-context.mjs`: exit 0; 14 Markdown files, three canonical facts.
- Initial `node --test` at `6a5bb8d`: exit 0; 54 passed, zero failed, one existing Windows file-symlink permission skip. The publisher reruns context consistency and the full suite before each new head is pushed, retaining their output summaries with that head in its local workflow record.
- The hardened PR-helper tests cover current-head CI/review evidence, aggregate review decisions, missing/stale/spoofed results, unresolved threads, no merge command, generated/binary size reporting, repeatable publication and review requests, retained three-round repair accounting, missing-state refusal, bounded watch deadlines, and no remote publication after a failed local gate. GitHub/process/clock boundaries are simulated; Git fixtures are real disposable repositories.
- Main's Windows CI failures were traced to `RUNNER~1` temporary paths versus their canonical `runneradmin` path. Three existing fixtures now use `realpath(mkdtemp(...))`; assertions and production helpers are unchanged.

The initial missing-module runs were scaffolding failures, not evidence of a behavioral regression. Passing simulated GitHub tests do not establish that CodeRabbit is installed or has reviewed this PR.

Local review of `6a5bb8d` found one Standards finding and three Spec findings (one overlaps): missing aggregate-review gating, missing-state retry resets, and watch deadline overruns. The aggregate-review regression test failed with `READY_FOR_HUMAN` instead of `WAITING_REVIEW` before the fix. After hardening, `node --test tests/agents/pr-workflow.test.mjs` exited 0 with ten passing tests. A subsequent small deadline-initialization adjustment is revalidated by the mandatory publication gate. Read-only skill pressure scenarios and their exact source snapshots are retained in the originating session; they evaluated the initial skill revision, not later helper changes.

## Repository setup

Created `development` at the base revision. Applied `.github/branch-protection.json` to `development` and `main`: strict current-branch CI from GitHub Actions app 15368, one approving review, dismissal of stale approvals, resolved conversations, enforced administrator rules, and no forced pushes/deletions. Repository auto-merge remains disabled. CodeRabbit configuration enables draft and incremental reviews for development; its live installation and approval must be observed separately.

The coordinator currently uses the owner's signed-in `gh` account. The helper cannot distinguish that account's human and agent activity; the human-only merge boundary is an explicit operating rule, supported by the absence of any merge operation in the helper and disabled auto-merge. GitHub forbids author self-approval; CodeRabbit may supply the required review, while the human still decides whether to merge.

## Remote evidence

Both GitHub Actions matrix jobs passed for the initial `6a5bb8d` pilot. CodeRabbit was then enabled and reported that automatic reviews were skipped because the repository had fewer than ten stars. The user explicitly requested `@coderabbitai review`; that command was posted, and the publisher now requests one review per new head automatically. Review results and readiness for later heads are reported on the PR; initial-head green checks do not prove a later head is ready. Stacked PR operations remain outside this milestone.

CodeRabbit's review of `b06e2e2` raised one actionable finding: repeated same-head `repair` calls could consume multiple rounds without a published fix. The public API regression reproduced the missing rejection. Repair round 1 was reserved for that head before fixing it; reservations now require a distinct head for each new round. The budget test publishes distinct fixture commits between genuine rounds and retains the three-round bound. The final source hashes are in [the pilot snapshot](pr-automation.snapshot.json); the snapshot's HEAD is the inspection base, with local changes identified by those hashes.
