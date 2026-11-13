# Isolated planning PR validation

Date: 2026-11-12 (Asia/Saigon). User explicitly requested a scoped PR while another agent works in the original checkout.

## Scope and source binding

Branch `feat/questions-readonly-qa-planning` was created in an isolated worktree from fetched `origin/development` at `94a7ed3658326c5599d2c8726353cfbb90d66018`. The original branch/index and runtime/Feature 007 edits are untouched. Only AGENTS.md navigation, the GLOSSARY.md product-session entry, ADR-0008 and specs/008-repository-questions are included.

The original [planning validation](planning-validation.md) and [snapshot](planning-snapshot.json) are historical records from the authoring checkout, not claims that the relocated checkout matches its root/HEAD. The [publication snapshot](publication-snapshot.json) binds all 31 reviewed inputs in this isolated checkout. It intentionally excludes later evidence-only report/checklist additions to avoid self-referential hashes.

Compared with the original R2 input hashes, only spec.md/plan.md branch metadata, research.md publication provenance, contracts/decisions.md publication authorization and context/runtime_policy.md differ. The policy difference is development's absence of the other agent's uncommitted UC-03 clarification-cap wording; this PR does not include that edit. Q&A independently requires a finite configured cap and marks fixture value 3 as experimental, so no uncommitted policy dependency is required.

## Independent delta reviews

- `/root/question_plan_standards`: [publication report](standards-publication.md), no P0/P1/P2 findings; checked policy/authority compatibility and unchanged contracts.
- `/root/question_plan_testability`: [publication report](testability-publication.md), no P0/P1/P2 findings; checked acceptance/evaluation and source-tier claims after relocation.

Both reviewers used the coordinator's inherited model/settings, verified 31/31 publication inputs unchanged before/after, and returned substantive passes. Report-format checks also passed. Source contracts, task ledger, data model and quickstart are byte-identical to the accepted R2 candidate. No code or acceptance criterion was changed to obtain publication.

The historical R1 testability report's extra terminal blank line was removed from its published copy for staged whitespace validation; its findings are unchanged and its original local artifact is retained. Current R2 and publication-review reports remain byte-for-byte copies.

## Checks and limits

- Automated planning validation: passed.
- Publication snapshot verification: 31/31 unchanged; HEAD/branch relocation recorded above, not suppressed.
- Scoped Prettier and whitespace checks: passed.
- Context refresh helper with reviewed empty updates: context checks passed, no context files changed.
- Runtime tests/model experiments: not run for documentation-only publication; full regression/CI belongs to the PR-first workflow.

G-PLAN remains passed for the publication candidate. User release covers draft PR publication only; G-IMPLEMENT, G-LIVE, G-QUALITY, production defaults, runtime changes and merge remain unreleased. Review/publication evidence is distinct from implementation-merger acceptance and contributor completion.
