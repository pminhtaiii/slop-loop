# Contributor PR pilot verification

Base: `323b907541db4ca2817b761ecf4bf3f42ac2660f` (`main` when the pilot began). Feature branch and PR title: `feat/001-pr-automation`; base branch: `development`. This is contributor tooling, not product-runtime completion.

## Local evidence

- `node scripts/ci/check-context.mjs`: exit 0; 14 Markdown files, three canonical facts.
- `node --test`: exit 0; 54 passed, zero failed, one existing Windows file-symlink permission skip.
- The seven PR-helper tests cover current-head CI/review evidence, missing/stale/spoofed results, unresolved threads, no merge command, generated/binary size reporting, repeatable publication, retained three-round repair accounting, and no remote publication after a failed local gate. GitHub and process boundaries are simulated; Git fixtures are real disposable repositories.
- Main's Windows CI failures were traced to `RUNNER~1` temporary paths versus their canonical `runneradmin` path. Three existing fixtures now use `realpath(mkdtemp(...))`; assertions and production helpers are unchanged.

The initial missing-module runs were scaffolding failures, not evidence of a behavioral regression. Passing simulated GitHub tests do not establish that CodeRabbit is installed or has reviewed this PR.

## Repository setup

Created `development` at the base revision. Applied `.github/branch-protection.json` to `development` and `main`: strict current-branch CI from GitHub Actions app 15368, one approving review, dismissal of stale approvals, resolved conversations, enforced administrator rules, and no forced pushes/deletions. Repository auto-merge remains disabled. CodeRabbit configuration enables draft and incremental reviews for development; its live installation and approval must be observed separately.

The coordinator currently uses the owner's signed-in `gh` account. The helper cannot distinguish that account's human and agent activity; the human-only merge boundary is an explicit operating rule, supported by the absence of any merge operation in the helper and disabled auto-merge. GitHub forbids author self-approval; CodeRabbit may supply the required review, while the human still decides whether to merge.

## Remote evidence

The live pilot's CI, CodeRabbit findings, and readiness outcome are reported on its PR. Local checks alone do not establish remote readiness. Stacked PR operations remain outside this milestone.
