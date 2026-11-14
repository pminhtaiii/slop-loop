# Independent Testability & Edge Cases Review — round 1


## Findings

| Severity | Code | Title | Description | Recommendation |
| --- | --- | --- | --- | --- |
| P2 | QTEST-R1-001 | Specify exhausted-finalization fallback | `contracts/question-runtime.md` Budgets and Evidence and delivery require stopping constrained activity on exhaustion, allow already validated claims in an exhausted result, and require a fresh `checkBinding` immediately before delivery. `contracts/repository-tools.md` Work limits charges digest traversal to the same task budget. If scanning consumes the last bytes/time, a final binding check may itself be unaffordable. The safe behavior can be inferred (no source-bearing delivery without revalidation), but a test currently has no explicit expected choice between reserved finalization work and a metadata-only exhausted outcome. | Specify either a reserved bounded final-binding allowance or an explicit no-source-claims exhausted fallback when revalidation cannot be admitted. Add a budget-boundary integration vector asserting zero over-budget IO and no stale/unchecked source claims. |
| P2 | QTEST-R1-002 | List source-level verification commands | `tasks.md` T017 explicitly requires source/emitted focused suites, but `quickstart.md` Planned focused checks lists only compiled `dist` invocations plus typecheck/build. An implementer following the guide can omit the source-level run while believing the published sequence completes T017. This is a verification-guide completeness issue rather than a design blocker. | Add the corresponding supported source test command(s), or state how the existing runtime wrapper covers both source and emitted checks and name that command. Keep future/not-run labeling. |

## Substantive assessment
