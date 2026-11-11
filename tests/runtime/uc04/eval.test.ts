import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('UC-04: Standalone Benchmark & Evaluation Runner', async t => {
  await t.test('executes 20 scenarios with 100% success rate and zero budget leakage', async () => {
    const scriptPath = resolve(process.cwd(), 'scripts/eval/uc04-eval.mjs');
    const { runBenchmark } = (await import(pathToFileURL(scriptPath).href)) as {
      runBenchmark: () => Promise<{
        metrics: {
          totalScenarios: number;
          successfulRecoveries: number;
          recoverySuccessRate: string;
          totalBudgetLoss: number;
          budgetLeakageRate: string;
          contextCompaction: {
            tokensSaved: number;
          };
        };
        scenarios: unknown[];
      }>;
    };

    const report = await runBenchmark();

    assert.equal(report.metrics.totalScenarios, 20);
    assert.equal(report.metrics.successfulRecoveries, 20);
    assert.equal(report.metrics.recoverySuccessRate, '100.0%');
    assert.equal(report.metrics.totalBudgetLoss, 0);
    assert.equal(report.metrics.budgetLeakageRate, '0.00%');
    assert.ok(report.metrics.contextCompaction.tokensSaved > 0);
    assert.ok(report.scenarios.length === 20);

    // Verify written report file
    const fileContent = await readFile('docs/verification/uc04-benchmark-results.json', 'utf8');
    const parsed = JSON.parse(fileContent);
    assert.equal(parsed.metrics.recoverySuccessRate, '100.0%');
  });
});
