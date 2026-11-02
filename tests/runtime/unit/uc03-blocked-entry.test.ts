/**
 * A blocked observation must be gradeable: `not-run`, exit 4, and surviving the report's own validator.
 * Before the fix `judgeObservation` graded a block `fail` while the driver reports `not-observed`,
 * which `parseWorkflowCase` rejects — so the report never validated and exit 4 was unreachable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkflowEvaluationReport, workflowCaseResult } from '../../../eval/uc03/results.ts';
import { DEFAULT_MANIFEST_DIGEST, validateWorkflowEvaluationReport } from '../../../eval/uc03/validation.ts';
import type { EvaluationCaseSpec, WorkflowBinding, WorkflowObservation } from '../../../eval/uc03/types.ts';

const HEX = (seed: string): string => seed.repeat(64).slice(0, 64);

const SPEC: EvaluationCaseSpec = {
  caseId: 'C01',
  name: 'Seeded localized bug repair',
  description: 'case',
  category: 'success',
  required: true,
  expectedOutcome: 'COMPLETED',
  requirements: ['FR-001'],
};

const BINDING: WorkflowBinding = {
  tier: 'controlled',
  profileDigest: HEX('a'),
  configDigest: HEX('b'),
  pricingDigest: HEX('c'),
  adapterVersions: ['uc03-adapter-1'],
  requestedModel: 'deepseek-v4.1',
};

/** Exactly the shape `blockedObservation` (eval/uc03/workflow-driver.ts:57) produces. */
const BLOCKED: WorkflowObservation = {
  repositoryId: 'repo-1',
  taskId: null,
  runId: null,
  returnedModel: null,
  graderDigest: null,
  workflowOutcome: 'not-observed',
  expectedWait: null,
  blocked: 'prerequisite-unavailable',
  effects: 'none',
  usage: 'unavailable',
  diagnostic: 'Preflight block C01: missing-digest',
  artifacts: [],
  limitations: ['Preflight block missing-digest; no graph dispatch occurred.'],
};

function blockedReport() {
  return createWorkflowEvaluationReport({
    mode: 'mock',
    binding: BINDING,
    scope: 'catalog',
    manifestDigest: DEFAULT_MANIFEST_DIGEST,
    timestamp: '2026-11-02T00:00:00.000Z',
    cases: [workflowCaseResult(SPEC, BLOCKED, BINDING)],
    limitations: ['Controlled-tier observations exercise the harness only; they do not establish workflow evidence.'],
  });
}

test('a blocked observation grades not-run, exits 4 and survives its own validator', () => {
  const report = blockedReport();
  const [entry] = report.cases;
  assert.ok(entry);

  // The missing assertion: a blocked case used to fail the report's own validator.
  assert.doesNotThrow(() => validateWorkflowEvaluationReport(report));
  assert.equal(entry.grade, 'not-run');
  assert.equal(entry.gradeReason, 'prerequisite-unavailable');
  assert.equal(report.selectionResult.outcome, 'incomplete');
  assert.equal(report.exitCode, 4);
  assert.equal(report.suiteAcceptance.outcome, 'incomplete');
});
