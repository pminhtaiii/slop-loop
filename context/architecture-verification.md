# Runtime Verification, Review, and Limits

For changes, establish a pre-edit baseline, apply a controlled patch, run focused and regression checks, check public API compatibility where relevant, and validate the final diff. Review begins only after required verification passes. An applied patch without required passing evidence is incomplete.

The reviewer examines the diff against acceptance criteria and repository conventions for logic errors, edge cases, security concerns, missing tests, and unsupported changes. The reviewer has read-only authority. Reviewer iteration, repair cycles, and expensive actions must have explicit limits; repair uses new tool, test, or review evidence and returns through verification before delivery. When a budget is exhausted or no safe next action exists, stop and report the blocker.

Each run should have traceable workflow-node, tool-call, skill-invocation, result, error, approval, verification, repair, and review records. Record metadata and only sanitized, bounded approved command details under [runtime_policy.md](runtime_policy.md); never include raw prompts, raw tool output, or protected payloads. Record per-run token usage and cost estimates so evaluation can explain how the final state was reached. Target acceptance evidence is listed in [the verification matrices](../docs/progress-checker-matrices.md).
