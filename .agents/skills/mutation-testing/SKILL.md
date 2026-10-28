---
name: mutation-testing
description: Use when evaluating JavaScript or TypeScript test-suite fault detection with Stryker, reviewing surviving mutants, or strengthening tests from a mutation report.
---

# Mutation testing

Strengthen tests for observable behavior that meaningful mutations break. **Do not chase every survivor or force a 100% score.** A killed mutant is already detected; an equivalent survivor needs an explanation, not an artificial assertion.

## Workflow

1. **Bind the scope.** Identify the authorized source, public behavior, related tests, current revision and existing Stryker configuration. Record source/test/configuration hashes. Match historical findings by source fingerprint, location, operator and replacement; IDs alone are report-local. Use an isolated workspace for injected mutations. Keep credentials out of inspection and reports.
2. **Establish a working baseline.** Run the relevant unmodified tests and Stryker dry run. Resolve collection, environment and build failures before interpreting mutants. Confirm mutations reach the executed code: source instrumentation paired with stale `dist` tests proves nothing. For Node's built-in runner or compiled TypeScript, read [the runner reference](references/stryker-node.md).
3. **Calibrate execution.** Exercise a known observable mutation and inspect its assertion failure. Recheck suspicious timeouts with unchanged tests, fewer workers and a justified larger allowance; retain both observations. A dry-run pass is setup evidence. A full run's exit 0 with a reporting-only threshold is not a quality-gate pass.
4. **Classify the selected survivors.** Inspect the exact replacement against intended behavior before editing tests. Prioritize security, refusal/zero-effect guarantees, boundaries and persisted outcomes within the authorized batch. Keep every reviewed finding in a disposition ledger.

| Disposition | Next action |
| --- | --- |
| Meaningful behavior change | Add a public-boundary test with independently justified expected values. |
| Equivalent or redundant within the contract | Explain unchanged observable behavior for that exact mutation; retain the evidence. |
| Runner, build or timeout problem | Repair or calibrate execution, then rerun before judging test adequacy. |
| Unclear or outside scope | Record the question, reason and follow-up; leave it unresolved explicitly. |

5. **Verify one improvement at a time.** Show the new assertion fails against the intended mutant and passes against the original candidate. Preserve existing assertions and intended runtime behavior. Restore any injected mutation; test the actual candidate, not an old scratch copy. If the contract is unclear or an implementation defect emerges, establish the applicable scope before broadening the change.
6. **Report comparable evidence.** Record revision/hashes, source range, selected tests, tool/configuration, commands, exit statuses, elapsed time and outcome counts. Separate assertion kills, survivors, timeouts and invalid runs. Explain exclusions specifically; score pressure is not a reason to suppress a mutant. Compare scores only for matching scope/operators/settings, and label focused reruns as focused.

## Completion

Every finding reviewed in the selected batch has a disposition. Each claimed test improvement passes on the original candidate and detects its exact mutation through an assertion. Relevant regressions pass; unresolved and unreviewed survivors remain visible. This establishes scoped fault-detection evidence, not whole-repository correctness.

Use existing contributor publication rules. Invoking this skill does not add a pre-PR hook, CI workflow or numeric merge threshold; those are separate scope decisions.
