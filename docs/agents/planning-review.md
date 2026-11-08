# Planning Review Workflow

Use this reference when auditing a feature's `spec.md`, `plan.md`, `tasks.md`, and contracts. Severity meanings and the two reviewer lanes are defined in [the planning workflow](../../context/planning.md); source snapshot rules are in [review snapshots](../../context/workflow.md#review-snapshots).

## Keep the checks distinct

Planning validation, report-format validation, and substantive review answer different questions:

- `node scripts/agents/planning-workflow.mjs validate --dir specs/<feature>` checks required artifacts, unresolved clarification markers, and task-ledger structure. It does not judge whether the plan is sound.
- `node scripts/agents/planning-workflow.mjs status --dir specs/<feature>` summarizes automated validation only. When clean, it reports `awaiting-independent-reviews`, `automatedValidationPassed: true`, and `readyForImplementation: false`; it does not retain or certify either review.
- `node scripts/agents/planning-workflow.mjs review-template` prints a findings-table skeleton. Fill it with the current review's findings before evaluating it. The skeleton is intentionally incomplete and fails format evaluation until it has a valid finding row.
- `node scripts/agents/planning-workflow.mjs review-template --no-findings` prints the standalone `No blocking issues found.` declaration. Use it only after completing the review and having no findings to report, including P2 advisories; generating it is not evidence that a review occurred.
- `node scripts/agents/planning-workflow.mjs evaluate-review --review <report.md>` checks the report shape and counts the listed P0, P1, and P2 findings. A passing result confirms only that the report is well-formed and lists no P0/P1 findings. It cannot establish that the reviewer covered the artifacts, found every issue, or supported each disposition.

Treat each review report as a semantic judgment by its assigned reviewer. Keep its candidate snapshot, role, and evidence with the report. Never use a template or format-check result as an automatic review pass.

## Review the same candidate in two independent lanes

1. Run automated validation and capture a snapshot of the planning inputs. Include the feature's top-level planning artifacts, every existing file under `contracts/`, and any governing source the reviewers rely on. The review brief generator includes nested contract files; include newly added files in the next snapshot and record removed paths in the delta/inventory, since a file snapshot hashes only existing inputs.
2. Generate separate briefs with `node scripts/agents/planning-workflow.mjs review-brief --dir specs/<feature> --role standards` and `node scripts/agents/planning-workflow.mjs review-brief --dir specs/<feature> --role testability`. Keep each lane's review and report independent.
3. Verify the snapshot before relying on either report and again before handoff. Record HEAD or branch drift separately; a matching file snapshot proves only that its declared inputs are unchanged.
4. Evaluate each report's format, then read its findings against the pinned candidate. Keep the latest report or verified reusable result from each lane with the validation result.

The planning gate requires passing automated validation and both independent lanes to have no unresolved P0/P1 findings on the current candidate. Apply the severity dispositions in [the planning workflow](../../context/planning.md#issue-severity-definitions); retain the coordinator's rationale for any permitted downgrade. The gate records planning quality only. Feature-specific authorization remains governed by its decision record and user approval.

## Repair findings with a verified delta

After a substantive planning change, capture and verify a new snapshot. Keep a finding ledger with each finding's ID, reproducer or acceptance-criterion link, regression coverage, disposition, and current source SHA, as required by [review snapshots](../../context/workflow.md#review-snapshots).

Give each affected lane a compact delta packet containing the new candidate snapshot, changed artifact paths and exact changed sections, and the updated dispositions with their evidence. Include connected contract or task references when a change can affect them. Re-review the changed material and only the related context needed to judge it; unrelated artifacts do not need a full reread.

Rerun every lane whose reviewed inputs changed. Reuse an unaffected lane's result only after verifying that every input it relied on still matches the new candidate. If the prior input set is unclear, refresh that lane's review. Continue until the current-candidate gate conditions pass; the number of rounds follows the findings and affected inputs.
