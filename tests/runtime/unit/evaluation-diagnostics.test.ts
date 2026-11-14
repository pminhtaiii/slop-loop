import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  type ApprovalPort,
  type BudgetLedger,
  type FixPlan,
  type ModelPort,
  type RepositoryPort,
  type StatePort,
} from '../../../src/contracts/foundation/uc03.ts';
import { DIAGNOSTIC_ATTRIBUTIONS, DIAGNOSTIC_COMPONENTS, DIAGNOSTIC_STAGES, createEvaluationDiagnostic } from '../../../src/runtime/evaluation-diagnostics.ts';
import { runUC03Graph, type UC03GraphPorts } from '../../../src/uc03/graph.ts';
import { diagnosticForOutcome } from '../../../src/uc03/graph-diagnostics.ts';
import { executeReplan } from '../../../src/uc03/repair.ts';
import { createGraphTaskState } from '../support/uc03/graph-fixtures.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import { createFixtureBugTask, createFixtureTaskState } from '../support/uc03/port-fixtures.ts';

const SECRET = `sk-${'a'.repeat(24)}`;
const ABSOLUTE_PATH = 'C:/Users/taiph/.ssh/id_rsa';

test('Provider failure maps to the provider component without echoing provider text', () => {
  const diagnostic = createEvaluationDiagnostic({
    stage: 'investigate',
    component: 'provider',
    attribution: 'environment',
    attributionConfidence: 'observed',
    reasonCode: 'provider-transport-failure',
  });
  assert.equal(diagnostic.stage, 'investigate');
  assert.equal(diagnostic.component, 'provider');
  assert.equal(diagnostic.attribution, 'environment');
  assert.equal(diagnostic.attributionConfidence, 'observed');
  assert.equal(diagnostic.reasonCode, 'provider-transport-failure');
});

test('Repository tool failure maps to repository-tool, not provider or model', () => {
  const diagnostic = createEvaluationDiagnostic({
    stage: 'patch',
    component: 'repository-tool',
    attribution: 'tool',
    attributionConfidence: 'observed',
    reasonCode: 'repository-tool-failure',
  });
  assert.equal(diagnostic.component, 'repository-tool');
  assert.equal(diagnostic.attribution, 'tool');
  assert.notEqual(diagnostic.component, 'provider');
  assert.notEqual(diagnostic.attribution, 'model');
});

test('State-accounting failure maps to state-accounting', () => {
  const diagnostic = createEvaluationDiagnostic({
    stage: 'patch',
    component: 'state-accounting',
    attribution: 'integration',
    attributionConfidence: 'inferred',
    reasonCode: 'state-accounting-conflict',
  });
  assert.equal(diagnostic.component, 'state-accounting');
  assert.equal(diagnostic.attribution, 'integration');
  assert.equal(diagnostic.attributionConfidence, 'inferred');
});

test('Approval failure maps to the approval component and human attribution', () => {
  const diagnostic = createEvaluationDiagnostic({
    stage: 'approve',
    component: 'approval',
    attribution: 'human',
    attributionConfidence: 'observed',
    reasonCode: 'approval-rejected',
  });
  assert.equal(diagnostic.stage, 'approve');
  assert.equal(diagnostic.component, 'approval');
  assert.equal(diagnostic.attribution, 'human');
});

test('Malformed model output maps to model-output, distinct from the provider transport', () => {
  const malformed = createEvaluationDiagnostic({
    stage: 'investigate',
    component: 'model-output',
    attribution: 'model',
    attributionConfidence: 'observed',
    reasonCode: 'model-output-invalid',
  });
  const transport = createEvaluationDiagnostic({
    stage: 'investigate',
    component: 'provider',
    attribution: 'environment',
    attributionConfidence: 'observed',
    reasonCode: 'provider-transport-failure',
  });
  assert.equal(malformed.component, 'model-output');
  assert.equal(malformed.attribution, 'model');
  assert.notEqual(malformed.component, transport.component);
});

test('Pytest and review failures map to verification and review, separate from provider and tool', () => {
  const verify = createEvaluationDiagnostic({ stage: 'verify', component: 'repository-tool', attribution: 'verification', attributionConfidence: 'observed', reasonCode: 'check-failed' });
  const review = createEvaluationDiagnostic({ stage: 'review', component: 'grader', attribution: 'review', attributionConfidence: 'observed', reasonCode: 'review-findings' });
  assert.equal(verify.stage, 'verify');
  assert.equal(verify.attribution, 'verification');
  assert.equal(review.stage, 'review');
  assert.equal(review.attribution, 'review');
  assert.notEqual(review.attribution, verify.attribution);
});

test('Unproven component degrades to unknown attribution and confidence without a root cause', () => {
  const diagnostic = createEvaluationDiagnostic({ stage: 'patch', component: 'something-else', attribution: 'model', attributionConfidence: 'observed', reasonCode: 'looks-like-the-model' });
  assert.equal(diagnostic.component, 'unknown');
  assert.equal(diagnostic.attribution, 'unknown');
  assert.equal(diagnostic.attributionConfidence, 'unknown');
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, /"attribution":"(?:model|provider|tool)"/u);
  assert.equal(serialized.includes('something-else'), false);
});

test('Secrets and absolute paths never appear in a serialized diagnostic', () => {
  const thrown = new Error(`provider rejected ${SECRET} while reading ${ABSOLUTE_PATH}`);
  const diagnostic = createEvaluationDiagnostic({
    stage: 'investigate',
    component: 'provider',
    attribution: 'environment',
    attributionConfidence: 'observed',
    reasonCode: thrown.message,
    evidenceRefs: [SECRET, ABSOLUTE_PATH, 'evidence-ok-001'],
  });
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, /sk-a{24}/u);
  assert.equal(serialized.includes(ABSOLUTE_PATH), false);
  assert.deepEqual(diagnostic.evidenceRefs, ['evidence-ok-001']);
  assert.equal(diagnostic.reasonCode, 'unattributed-failure');
});

test('Non-identifier and over-long reason codes are replaced by the generic code', () => {
  assert.equal(createEvaluationDiagnostic({ reasonCode: 'has spaces and\nnewlines' }).reasonCode, 'unattributed-failure');
  assert.equal(createEvaluationDiagnostic({ reasonCode: `a${'b'.repeat(200)}` }).reasonCode, 'unattributed-failure');
  assert.equal(createEvaluationDiagnostic({ reasonCode: 'safe.code:1-2' }).reasonCode, 'safe.code:1-2');
});

test('Unknown usage and effects stay unknown unless observed', () => {
  const unknown = createEvaluationDiagnostic({ stage: 'verify', component: 'container' });
  assert.equal(unknown.usage, 'unknown');
  assert.equal(unknown.effects, 'unknown');
  const observed = createEvaluationDiagnostic({ stage: 'verify', component: 'container', usage: 'observed', effects: 'observed' });
  assert.equal(observed.usage, 'observed');
  assert.equal(observed.effects, 'observed');
});

test('Vocabularies stay bounded and free of duplicates', () => {
  for (const vocabulary of [DIAGNOSTIC_STAGES, DIAGNOSTIC_COMPONENTS, DIAGNOSTIC_ATTRIBUTIONS]) {
    assert.equal(new Set(vocabulary).size, vocabulary.length);
  }
});

test('A protected path in milestone or limitation text is dropped, neighbouring text survives', () => {
  const diagnostic = createEvaluationDiagnostic({
    stage: 'verify',
    component: 'container',
    milestones: [ABSOLUTE_PATH, 'container started'],
    limitations: [`could not read ${ABSOLUTE_PATH}`, 'container exit status unavailable'],
  });
  assert.deepEqual(diagnostic.milestones, ['container started']);
  assert.deepEqual(diagnostic.limitations, ['container exit status unavailable']);
  const serialized = JSON.stringify(diagnostic);
  assert.equal(serialized.includes(ABSOLUTE_PATH), false);
});

test('Graph route failure keeps the existing reason and preserves reloaded owner evidence', async () => {
  const task = createFixtureBugTask();
  const state = createGraphTaskState(task, { node: 'Validate', evidenceRefs: ['evidence-baseline-777'] });
  const ports = {
    statePort: {
      loadTask: async () => state,
      transition: async () => {
        throw new Error(`transition failed with ${SECRET} at ${ABSOLUTE_PATH}`);
      },
    } as unknown as StatePort,
    approvalPort: {} as ApprovalPort,
    repositoryPort: {} as RepositoryPort,
    modelPort: {} as ModelPort,
  } as unknown as UC03GraphPorts;

  const result = await runUC03Graph(task, ports, { mode: 'development' });
  assert.deepEqual(result.reasons, ['UC-03 route stopped after an unconfirmed owner transition']);
  assert.ok(result.diagnostic);
  assert.equal(result.diagnostic.stage, 'preflight');
  assert.equal(result.diagnostic.component, 'workflow');
  assert.equal(result.diagnostic.attribution, 'unknown');
  assert.equal(result.diagnostic.attributionConfidence, 'unknown');
  assert.equal(result.diagnostic.usage, 'unknown');
  assert.equal(result.diagnostic.effects, 'unknown');
  assert.deepEqual(result.diagnostic.evidenceRefs, ['evidence-baseline-777']);
  assert.ok(result.diagnostic.limitations.some(limitation => limitation.includes('unproven')));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(ABSOLUTE_PATH), false);
});

/* T038: coder-boundary refusal mapping at the result boundary. */
const refused = (...reasons: string[]) => diagnosticForOutcome({ reasons, state: { node: 'Investigate' }, milestones: [] } as never).diagnostic;

test('recognized coder refusal codes become observed components, labelling only the category', () => {
  for (const [reason, component, attribution, code] of [
    ['PROPOSAL_INVALID:MALFORMED_JSON', 'model-output', 'model', 'coder-proposal-invalid'],
    ['TOOL_ERROR', 'repository-tool', 'tool', 'coder-tool-refused'],
    ['MODEL_ERROR', 'provider', 'environment', 'coder-dispatch-failed'],
    ['MODEL_UNCERTAIN:TIMEOUT', 'provider', 'environment', 'coder-dispatch-failed'],
  ] as const) {
    const diagnostic = refused('Incomplete verification', `REAL_PROFILE_GENERATION_INVALID: ${reason}`);
    assert.deepEqual(
      [diagnostic?.stage, diagnostic?.component, diagnostic?.attribution, diagnostic?.attributionConfidence, diagnostic?.reasonCode],
      ['investigate', component, attribution, 'observed', code],
    );
    assert.equal(JSON.stringify(diagnostic).includes(reason), false);
  }
});

test('unrecognized or unprefixed coder reasons stay workflow/unknown/route-incomplete', () => {
  for (const reasons of [
    ['REAL_PROFILE_GENERATION_INVALID: SOMETHING_ELSE'],
    ['REAL_PROFILE_GENERATION_INVALID: TOOL_ERROR at C:/secret/x.ts'],
    ['TOOL_ERROR'],
    ['REAL_PROFILE_GENERATION_INVALID: PROPOSAL_INVALID:lower'],
    [],
  ]) {
    const diagnostic = refused(...reasons);
    assert.deepEqual([diagnostic?.component, diagnostic?.attribution, diagnostic?.attributionConfidence, diagnostic?.reasonCode], ['workflow', 'unknown', 'unknown', 'route-incomplete']);
  }
});

/* MCR3-01: the opaque operationRef behind `replan-owner-outcome-uncertain` is never a coder refusal. */

test('uncertain replan operation references are never classified as coder refusals', () => {
  for (const code of ['PROPOSAL_INVALID:MALFORMED_JSON', 'TOOL_ERROR', 'MODEL_ERROR']) {
    const diagnostic = refused('replan-owner-outcome-uncertain', `REAL_PROFILE_GENERATION_INVALID: ${code}`);
    assert.deepEqual([diagnostic?.component, diagnostic?.attribution, diagnostic?.attributionConfidence, diagnostic?.reasonCode], ['workflow', 'unknown', 'unknown', 'route-incomplete'], code);
    assert.equal(JSON.stringify(diagnostic).includes('coder-'), false, code);
  }
});

test('a real coder refusal without the uncertainty marker still maps to its category', () => {
  const diagnostic = refused('replan-owner-outcome-uncertain-but-different', 'Incomplete verification', 'REAL_PROFILE_GENERATION_INVALID: MODEL_ERROR');
  assert.deepEqual([diagnostic?.component, diagnostic?.attribution, diagnostic?.reasonCode], ['provider', 'environment', 'coder-dispatch-failed']);
});

test('an uncertain replan driven through the real producer yields a workflow/unknown diagnostic', async () => {
  const task = createFixtureBugTask();
  const strategy = 'Check divisor == 0 before division';
  const plan: FixPlan = {
    planVersion: 1,
    diagnosis: 'Calculator.divide does not check the divisor',
    suspectedCauseLocations: ['src/calculator.py:3'],
    evidenceRefs: ['evi-repro-001'],
    strategy,
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    baselineRef: task.initialRevisionDigest,
    strategyDigest: computeCanonicalSha256(strategy),
    decisionRef: 'dec-plan-001',
  };
  const ledger = (kind: string, limit: number, unit: string): BudgetLedger => ({ scope: 'task', kind, limit, consumed: 0, reservations: [], unit, configurationId: 'config-v1', version: 1 });
  const state = createFixtureTaskState({
    stateVersion: 2,
    node: 'Repair',
    plan,
    activeDecisionId: plan.decisionRef,
    taskContext: task,
    budgetLedgers: [ledger('replan', 3, 'count'), ledger('repair', 2, 'count'), ledger('tokens', 100_000, 'count'), ledger('cost', 5, 'usd')],
  });
  const changed = 'Check divisor == 0 and raise CalculationError';
  const operationRef = 'REAL_PROFILE_GENERATION_INVALID: MODEL_ERROR';
  const result = await executeReplan(
    { taskId: state.taskId, candidatePlan: { ...plan, strategy: changed, strategyDigest: computeCanonicalSha256(changed) }, proposalId: 'prop-mcr3-01' },
    {
      statePort: new MemoryStatePortV02({ initialTaskState: state }),
      trustedDirection: {
        directive: 'revise',
        taskId: state.taskId,
        workspaceId: state.workspaceId,
        repositoryRevisionDigest: state.repositoryRevisionDigest,
        stateVersion: state.stateVersion,
        planVersion: state.planVersion,
        rejectedDecisionId: plan.decisionRef ?? '',
        strategyDigest: plan.strategyDigest,
      },
      replanPort: { provenance: 'mock', accept: async () => ({ outcome: 'uncertain' as const, operationRef }) },
    },
  );
  assert.equal(result.outcome, 'INCOMPLETE');
  assert.deepEqual(result.reasons, ['replan-owner-outcome-uncertain', operationRef]);
  const diagnostic = diagnosticForOutcome({ terminalOutcome: 'INCOMPLETE', reasons: result.reasons, state } as never).diagnostic;
  assert.deepEqual([diagnostic?.component, diagnostic?.attribution, diagnostic?.attributionConfidence, diagnostic?.reasonCode], ['workflow', 'unknown', 'unknown', 'route-incomplete']);
  assert.equal(diagnostic?.effects, 'unknown');
  assert.ok(diagnostic?.limitations.some(limitation => limitation.includes('was not observed')));
});
