# Paired PR and ticket publication

The public `origin` repository is the review source of truth, including CodeRabbit. The private `submission` repository receives the same approved source for coursework. [publication-targets.json](../../publication-targets.json) enables this pairing with remote aliases; private repository identity stays in local Git configuration and ignored publication records.

## Pull requests

Follow the [branch and PR conventions](pr-conventions.md) for the shared feature branch, identical titles and PR descriptions. Use the existing publication command from the public checkout:

```powershell
node scripts/agents/pr-workflow.mjs publish --base development --body-file <body.md> --summary "<short summary>"
```

The helper validates both targets before publishing, runs the normal local gates, publishes the public feature PR against `development`, then creates or updates its submission partner against `development`. Both repositories receive feature branches, never direct writes to their default branches. Both PRs remain subject to human merge decisions.

The submission repository has separate Git history. Its feature commit has submission ancestry and an exact copy of the public source commit's tracked tree. This includes the project README at the repository root, replacing the initial submission README as approved. Ignored dependencies, local evidence and agent state are excluded. The source SHA and tree are retained as provenance; the two PR heads are intentionally different commits.

Two GitHub operations cannot be atomic. If publication stops after one target succeeds, retain `.agent-work/pr-workflow/` and `.agent-work/paired-prs/`, then rerun the same publish command. Recovery identifies the existing pair and resumes it; unexpected external branch/PR changes or changed target identities require inspection instead of overwriting remote work. A partial pair is not contributor completion.

After CodeRabbit or another contributor commits fixes to the public feature branch, pull those changes into the public checkout, verify them, and rerun publication to update the submission snapshot. This is explicit command-driven synchronization; opening a PR directly in GitHub does not run the helper.

Link both returned PR URLs in the app and import a receipt containing both through `record-app-state`. The completion gate uses public current-head CI as the readiness authority and checks both published PR identities. Submission identity, branch/tree synchronization, and merge state are still required for paired-ticket completion; submission CI is informational and does not drive public readiness, repair, or watch. The gate does not claim submission CI passed without inspecting it. Public review comments remain advisory under the [PR workflow](pr-workflow.md).

## Target transition

New pairs use public `origin/development` and private `submission/development`. Repository default branches may remain `main`; this does not change PR bases. The first mirror commit is parented by the inspected submission base SHA; subsequent mirror commits advance the same feature branch by fast-forward. Schema-v1 records retain the historical field name `mainBase` for that configured base SHA.

Configuration and retained pair targets must agree. Historical `submission/main` configuration remains readable for recovery and verification; records and PRs are never automatically retargeted. A changed configuration on an active pair blocks publication, verification and contributor completion before remote writes. Keep the record and repair budget intact. Finish or inspect that pair in a separate checkout with its original configuration, then use a fresh unique branch for development-targeted work. Do not rewrite the private history, reset records, or force-update a branch to bypass the refusal. Historical paired-ticket completion likewise requires the original base configuration and exact recorded resolving PR identity; preview before applying.

An existing private feature branch or PR without retained accounting also blocks adoption. Retain both workflow and pair stores across partial publication. No transition writes to either base branch or to submission/main.

## Tickets

Create or update the same pair with a stable key:

```powershell
node scripts/agents/paired-issues.mjs publish --key localized-bug --title "Repair localized bug" --body-file <ticket.md>
```

Use the same key for later title/body updates. The default label is `needs-triage`; `--label` accepts the [canonical triage labels](triage-labels.md). Missing requested labels may be created, while existing label metadata is preserved. Issue numbers can differ between repositories; use the returned URLs rather than assuming a shared number.

The ticket helper validates both repository roles, write access and issue availability before writes. Opaque identity markers and ignored `.agent-work/paired-issues/` receipts support retries after partial writes or lost create responses. Duplicate markers or mismatched identities stop publication for inspection. With `issue-project.json`, publication assigns both issues to the authenticated human and adds the configured side to the exact Project; updating membership preserves its status. Closed tickets remain closed; comments and issue state are not automatically synchronized by publication. GitHub operations use `gh` only.

### Complete paired tickets

During review of a resolving PR, verify every acceptance criterion on both issues for the stable key and prepare an evidence file. Put the stable key, public resolving-PR URL, evidence path, and preview status in the completion handoff. An open PR is still waiting: apply only after both resolving PRs are merged with matching source trees and the public PR's exact-head CI passes. Submission identity/tree/sync/merge remain required; its CI is informational. No label, age, merge, closing keyword, or CI result establishes acceptance, and CodeRabbit approval is not required.

The evidence file has this shape:

```json
{
  "schemaVersion": 1,
  "summary": "Verified repair evidence",
  "acceptance": [
    { "criterion": "<acceptance criterion>", "evidence": "<verification evidence>" }
  ]
}
```

Run from the public review checkout, naming the stable key and public resolving PR explicitly:

```powershell
node scripts/agents/complete-paired-issues.mjs --key <stable-key> --pr <public-PR-URL> --evidence-file <evidence.json> [--apply] [--root <checkout>]
```

Without `--apply`, the command previews and makes no remote changes. The explicit `--pr` URL and evidence file record the agent's assertion that every criterion is satisfied. Applying adds an idempotent audit comment to each exact paired issue, linking it to that repository's resolving PR, then closes both issues. If one close succeeds and the other fails, retain ignored `.agent-work/paired-issue-completion/` and `.agent-work/paired-issues/` records and retry the same command. Completion targets only the exact stable-key pair; it does not delete or reopen issues or promote labels. This explicit cleanup is separate from ticket publication, which preserves closed state and does not synchronize issue state.

Read the JSON `status`, not just the exit code: `READY_TO_COMPLETE` is an eligible preview, `COMPLETED` confirms both issues are closed, and `WAITING_*` or `BLOCKED` leaves cleanup pending. Evidence may be revised before apply begins; retain the same evidence when recovering an interrupted apply.

With `issue-project.json`, `COMPLETED` also requires the configured item to have the configured Done status. Apply repairs a missing membership or pending project status after both issues close. A lost response or project failure leaves cleanup pending; rerun with the same key, PR and evidence. Preview makes no project writes. Project identity and the status field/option are checked before issue closure; issue acceptance, paired merge and public CI gates remain unchanged.

### Automatic completion

After the implementing agent verifies every acceptance criterion, start a retained local completion job during PR review:

```powershell
node scripts/agents/issue-completion-job.mjs start --key <stable-key> --pr <public-PR-URL> --evidence-file <evidence.json>
node scripts/agents/issue-completion-job.mjs status --key <stable-key>
```

Starting explicitly attests acceptance and authorizes apply for that exact pair once the existing merge/tree/CI gates pass. The job copies and hashes the evidence, binds both issue bodies and project configuration, and checks once per minute. It never merges PRs. Changed acceptance, evidence, project configuration, refusals or command errors stop it as `BLOCKED`; it retries only waiting PR/CI states. Retain `.agent-work/issue-completion-jobs/` and the existing completion/publication receipts. Handoffs include the key, PR, evidence path, job record and status.

The detached process runs on the local machine; it survives a finished chat but needs the checkout, GitHub credentials and machine to remain available. After interruption inspect status/logs and any retained locks before `resume --key <stable-key>`. Resume keeps the original evidence and bindings; it does not authorize revised acceptance. Repeating start for the same key/PR/evidence returns the existing job rather than creating a duplicate. Automatic completion is separate from human merge authority and contributor PR handoff.

### Post-merge follow-up

After a merge, use the read-only follow-up command to inspect local paired-issue records and the public resolving PR:

```powershell
node scripts/agents/paired-issue-followup.mjs --pr <public-PR-URL> [--key <stable-key> ...] [--evidence-file <JSON>] [--root <checkout>]
```

Pass `--key` to associate that stable key with this PR for the probe; the association is a caller assertion to verify, not proof of acceptance. Without keys, the helper lists locally recorded pairs and does not infer resolution from `Closes` references. `--evidence-file` requires exactly one explicit key and runs a preview only; the report may offer an `applyCommand` only when the completion helper reports `READY_TO_COMPLETE`. The follow-up never closes issues. Verify every criterion yourself, then run the exact previewed completion command with explicit `--apply` for that key; never apply across all candidates or infer acceptance from merge, CI, labels, or issue association alone.

Changed acceptance criteria, resolving PR identity or evidence after an apply begins requires inspection and reconciliation. Preserve the records instead of deleting them to force a new attempt.

Audit comments publish only the resolving PR link, the number of attested criteria and the evidence digest. Detailed summary and criterion evidence stay in the local evidence file; they are never copied into GitHub comments. Admission is rechecked before each comment and each close.

## Privacy and configuration

Configure `origin` as the public review repository and `submission` as the private coursework repository. The helper refuses reversed visibility or identical repositories. Configuration without this file retains the original single-repository behavior for other checkouts and helper fixtures.

On a new clone, sign in with `gh auth login` and add the private remote with `git remote add submission <private-repository-url>`. The signed-in account needs write access to both repositories. Keep the submission URL in local Git configuration; do not add it to the tracked configuration file.

Public PR and ticket bodies contain no generated private repository URLs or names. Submission bodies may link back to the public review object. Both links are returned locally for the user and app. Never put credentials in repository configuration; `gh` uses the signed-in account.
