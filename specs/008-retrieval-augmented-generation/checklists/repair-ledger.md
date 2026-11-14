# R2 delta and finding ledger

R1 source HEAD: 208224f6c366276aa2c50455e38c2f62b33e11d7. R2 declared file SHA values: candidate-r2.json. Branch unchanged; file snapshots do not assert whole-worktree cleanliness. Verify R2 before/after review. Both lanes' planning inputs changed, so neither R1 verdict is reused for current candidate.

| Finding | Trigger / criterion | Coordinator disposition and coverage | Changed sections |
| --- | --- | --- | --- |
| QSTD-R1-001 | A -> B -> A during mutable reads; FR-001/005, SC-001 | Repaired: trusted immutable snapshot/manifest acquired stably, validate every file's original bytes; separate current-workspace freshness. Controlled ABA/acquisition/corrupt manifest tests; live owner admission still gated. | repository-tools Binding/Line semantics/Compatibility, data model snapshot/span, plan storage/steps/gates, decisions G-LIVE, research; T003/T006/T012; quickstart scenario 5 |
| QSTD-R1-002 | Exhausted scan cannot perform final binding IO; FR-007 | Repaired: source-bearing results require admitted remaining final work; closed budgets/deadlines/cancel/stale/unknown accounting use fixed claim-free metadata-only results and zero further IO. | question-runtime Budgets/Evidence, plan step 5; T005/T006/T009; quickstart scenario 6 |
| QSTD-R1-003 | Accumulated evidence exceeds per-call tokens; FR-007 | Repaired: deterministic complete-request compiler; exact/certified upper bound includes system/tool serialization before reserve/transport; mandatory overflow -> claim-free context-limit, output cap required. | question-runtime Model/accounting, plan step 5/gates, decisions G-LIVE, research; T007; quickstart scenario 6 |
| QTEST-R1-001 | Same terminal-boundary advisory as QSTD-R1-002 | Repaired by same rule and zero post-limit IO tests. | Same sections above |
| QTEST-R1-002 | T017 source/emitted promise vs emitted-only guide | Repaired: Node 24 direct source test commands plus emitted equivalents and foundation regression in both forms. | quickstart focused checks |

Reviewers own only their R2 report paths. No plan edits. Review delta plus connected references needed to judge. Return stable findings or no-findings declaration and run evaluate-review. Coordinator remains sole author/repairer.
