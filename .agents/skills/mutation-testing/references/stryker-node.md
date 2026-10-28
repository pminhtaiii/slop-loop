# StrykerJS with Node's built-in test runner

Use an existing pinned installation/configuration when available. If setup is needed, keep it within the authorized scope, use the project's package manager and dependency policy, and isolate experimental installation from the repository manifest/lockfile. Read the installed CLI help/schema for version-specific options.

## Select the code actually executed

- With Node supporting the repository's TypeScript syntax directly, the command can run the source `.test.ts` files importing instrumented `.ts` source.
- With emitted JavaScript tests, use Stryker's `buildCommand` to build instrumented source before tests. Confirm output/import paths. Avoid rebuilding the entire lint/typecheck/publication pipeline per mutant: compiler and harness failures are not assertion evidence.
- Mutate implementation files, retaining the relevant tests and runtime dependencies in the sandbox. Enumerate required files explicitly when an ignored scratch directory would otherwise be omitted by discovery.

## Example: a scoped telemetry experiment

This configuration is an adaptation of an exercised Node 24/TypeScript pilot. Use it only where the named source and test paths exist; select paths from the current assignment in another project. The line range is a focused comparison example, not whole-module coverage.

```json
{
  "mutate": ["src/foundation/telemetry.ts:127-127"],
  "ignorePatterns": ["**", "!src/**/*.ts", "!tests/runtime/unit/telemetry.test.ts", "!package.json"],
  "testRunner": "command",
  "commandRunner": { "command": "node --test tests/runtime/unit/telemetry.test.ts" },
  "coverageAnalysis": "off",
  "concurrency": 1,
  "timeoutMS": 10000,
  "timeoutFactor": 3,
  "incremental": false,
  "reporters": ["clear-text", "html", "json"],
  "thresholds": { "high": 80, "low": 60, "break": 0 }
}
```

From that workspace, using its installed Stryker and the example saved as `stryker.config.json`:

```powershell
node --test tests/runtime/unit/telemetry.test.ts
pnpm exec stryker run stryker.config.json --dryRunOnly
pnpm exec stryker run stryker.config.json
```

Worker count and timeout values are starting settings, not universal requirements. A measured dry run and unchanged-test retries determine suitable allowances. The `high`/`low` values color the report; `break: 0` makes this experiment report-only. Retain separate before/after reports rather than overwrite the baseline.

## Interpret the command runner accurately

The command runner treats command success/failure as its test result. One synthetic test may represent many `node:test` cases. It lacks per-test coverage/selection and cannot distinguish assertion failures from startup failures by exit status alone; inspect failure output for claimed kills. Zero `NoCoverage` or error counts does not prove coverage or absence of harness errors. Avoid incremental reuse when test or imported-dependency changes cannot be tracked reliably.

Stryker's reported score is `(killed + timeout) / (killed + timeout + survived + noCoverage) * 100`, excluding invalid/ignored mutants. Record each category separately: an aggressive timeout can falsely count a survivor as detected. Explain the remaining limitations even after calibration.

For an exact-limit truncation contract, assert that a fitting input is preserved and reports `truncated: false`; merely asserting `byteCount <= limit` also accepts needless data loss. Derive expected values from the public contract, not the mutant's shape.

Primary references: [configuration](https://stryker-mutator.io/docs/stryker-js/configuration/), [states and metrics](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/), and [incremental limitations](https://stryker-mutator.io/docs/stryker-js/incremental/).
