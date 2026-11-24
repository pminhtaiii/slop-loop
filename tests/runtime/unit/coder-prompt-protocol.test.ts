import assert from 'node:assert/strict';
import test from 'node:test';
import type { FixPlan } from '../../../src/contracts/foundation/uc03.ts';
import { admit, type DeepSeekPricing } from '../../../src/foundation/deepseek-transport-request.ts';
import { DEEPSEEK_REVIEW_PROMPT, REVIEW_SYSTEM_TEXT, type DeepSeekReviewPrompt } from '../../../src/foundation/deepseek-review-profile.ts';
import { VARIANT_FIELDS } from '../../../src/uc03/agent-proposal.ts';
import { buildTransportPayload } from '../../../src/foundation/model.ts';
import { createFixtureProviderRequest, createFixtureTaskState } from '../support/uc03/port-fixtures.ts';

const TARGET_ENDPOINT = 'https://host.invalid/messages';
const PRICING: DeepSeekPricing = { inputRate: 1, outputRate: 1, cacheRate: 1, overheadRate: 0, denominator: 1 };
const INSPECT_OPERATIONS = ['list_dir', 'read_file', 'search_code', 'run_check'] as const;

function assertCoderSystemProtocol(text: string): void {
  assert.equal(text.includes('proposalId'), true, 'missing proposalId in system text');
  for (const kind of Object.keys(VARIANT_FIELDS)) {
    assert.equal(text.includes(kind), true, `missing kind ${kind} in system text`);
  }
  for (const [kind, fields] of Object.entries(VARIANT_FIELDS)) {
    for (const field of fields) {
      assert.equal(text.includes(field), true, `missing field ${field} for kind ${kind} in system text`);
    }
  }
  for (const op of INSPECT_OPERATIONS) {
    assert.equal(text.includes(op), true, `missing inspect operation ${op} in system text`);
  }
  // The real model dropped proposalId when it was stated once instead of in each schema.
  for (const kind of Object.keys(VARIANT_FIELDS)) {
    assert.equal(text.includes(`{"kind":"${kind}","proposalId":string,`), true, `schema for ${kind} must carry proposalId`);
  }
  assert.equal(text.includes('reply with an inspect first'), true, 'missing inspect-first instruction in system text');
  assert.equal(text.includes('must exactly equal the path of an item in untrustedEvidence or an entry of task.evidenceRefs'), true, 'missing evidenceRefs-equals-path rule in system text');
  assert.equal(text.includes('Never list the root'), true, 'missing root-listing prohibition in system text');
  assert.equal(text.includes('canonical repository-relative paths'), true, 'missing relative-path rule in system text');
  assert.equal(text.includes('For request.purpose propose-plan/propose-replan, reply with inspect, propose-plan, request-info or stop.'), true, 'missing propose-plan purpose-mapping in system text');
  assert.equal(text.includes('For propose-patch/propose-repair, reply with inspect or propose-patch'), true, 'missing propose-patch purpose-mapping in system text');
  assert.equal(text.includes('approvedPlanRef = task.plan.decisionRef'), true, 'missing approvedPlanRef phrase in system text');
  assert.equal(text.includes('only task.plan.scopedChanges paths'), true, 'missing scopedChanges rule in system text');
  assert.equal(text.includes('Read a file before patching it.'), true, 'missing read-before-patch rule in system text');
  assert.equal(text.includes('--- a/path'), true, 'missing diff header --- a/path in system text');
  assert.equal(text.includes('+++ b/path'), true, 'missing diff header +++ b/path in system text');
  assert.equal(text.includes('@@'), true, 'missing diff hunk marker in system text');
}

test('coder prompt protocol includes all kinds, variant fields, proposalId, and inspect operations', () => {
  const coderPayload = buildTransportPayload(
    createFixtureTaskState(),
    [],
    createFixtureProviderRequest({
      role: 'coder',
      purpose: 'investigate-and-propose',
      maxInputTokens: 50000,
      maxBillableTokens: 60000,
      maxCostUsd: 1.0,
    }),
  );

  const admission = admit(coderPayload, PRICING, TARGET_ENDPOINT);
  assert.equal(admission.ok, true, 'coder admission should succeed');
  if (!admission.ok) return;

  const parsedBody = JSON.parse(admission.body) as {
    system: string;
    messages: readonly [{ role: string; content: string }];
  };
  const systemText = parsedBody.system;

  assertCoderSystemProtocol(systemText);

  const promptContent = JSON.parse(parsedBody.messages[0].content) as {
    task: { evidenceRefs?: readonly string[] };
  };
  assert.deepEqual(promptContent.task.evidenceRefs, coderPayload.state.evidenceRefs);

  const requiredSymbols = new Set<string>([
    'proposalId',
    ...Object.keys(VARIANT_FIELDS),
    ...Object.values(VARIANT_FIELDS).flat(),
    ...INSPECT_OPERATIONS,
    'reply with an inspect first',
    'must exactly equal the path of an item in untrustedEvidence or an entry of task.evidenceRefs',
    'canonical repository-relative paths',
    'Never list the root',
    'For request.purpose propose-plan/propose-replan, reply with inspect, propose-plan, request-info or stop.',
    'For propose-patch/propose-repair, reply with inspect or propose-patch',
    'approvedPlanRef = task.plan.decisionRef',
    'only task.plan.scopedChanges paths',
    'Read a file before patching it.',
    '--- a/path',
    '+++ b/path',
  ]);

  for (const symbol of requiredSymbols) {
    const stripped = systemText.replaceAll(symbol, '');
    assert.throws(
      () => assertCoderSystemProtocol(stripped),
      (err: unknown) => err instanceof assert.AssertionError,
      `removing ${symbol} must cause protocol verification to fail`,
    );
  }
});

test('reviewer request body system text remains unchanged', () => {
  const reviewPromptConfig: DeepSeekReviewPrompt = {
    ...DEEPSEEK_REVIEW_PROMPT,
    maxOutputBytes: 16384,
    maxResponseBytes: 131072,
  };

  const reviewerPayload = buildTransportPayload(
    createFixtureTaskState(),
    [],
    createFixtureProviderRequest({
      role: 'reviewer',
      purpose: 'final-review',
      maxInputTokens: 50000,
      maxBillableTokens: 60000,
      maxCostUsd: 1.0,
    }),
  );

  const admission = admit(reviewerPayload, PRICING, TARGET_ENDPOINT, reviewPromptConfig);
  assert.equal(admission.ok, true, 'reviewer admission should succeed');
  if (!admission.ok) return;

  const parsedBody = JSON.parse(admission.body) as {
    system: string;
    messages: readonly [{ role: string; content: string }];
  };
  assert.equal(parsedBody.system, REVIEW_SYSTEM_TEXT);

  const promptContent = JSON.parse(parsedBody.messages[0].content) as {
    task: Record<string, unknown>;
  };
  assert.equal('evidenceRefs' in promptContent.task, false);
});

test('coder prompt task.plan carries exactly five fields when plan is defined in state', () => {
  const samplePlan: FixPlan = {
    planVersion: 1,
    diagnosis: 'Zero division occurred',
    suspectedCauseLocations: ['src/calculator.py:3'],
    evidenceRefs: ['src/calculator.py'],
    strategy: 'Add check for zero divisor',
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: 'sha256:checkset-001',
    baselineRef: 'sha256:baseline-001',
    strategyDigest: 'sha256:strategy-digest-001',
    decisionRef: 'dec-plan-001',
  };

  const coderPayload = buildTransportPayload(
    createFixtureTaskState({ plan: samplePlan }),
    [],
    createFixtureProviderRequest({
      role: 'coder',
      purpose: 'propose-patch',
      maxInputTokens: 50000,
      maxBillableTokens: 60000,
      maxCostUsd: 1.0,
    }),
  );

  const admission = admit(coderPayload, PRICING, TARGET_ENDPOINT);
  assert.equal(admission.ok, true, 'coder admission should succeed');
  if (!admission.ok) return;

  const parsedBody = JSON.parse(admission.body) as {
    messages: readonly [{ role: string; content: string }];
  };
  const promptContent = JSON.parse(parsedBody.messages[0].content) as {
    task: { plan?: Record<string, unknown> };
  };

  assert.equal('plan' in promptContent.task, true, 'task.plan must be present');
  assert.deepEqual(Object.keys(promptContent.task.plan ?? {}), ['decisionRef', 'strategyDigest', 'diagnosis', 'strategy', 'scopedChanges']);
  assert.deepEqual(promptContent.task.plan, {
    decisionRef: 'dec-plan-001',
    strategyDigest: 'sha256:strategy-digest-001',
    diagnosis: 'Zero division occurred',
    strategy: 'Add check for zero divisor',
    scopedChanges: ['src/calculator.py'],
  });
});

test('task.plan is absent when state has no plan, and absent for reviewer role even with plan', () => {
  const samplePlan: FixPlan = {
    planVersion: 1,
    diagnosis: 'Zero division occurred',
    suspectedCauseLocations: ['src/calculator.py:3'],
    evidenceRefs: ['src/calculator.py'],
    strategy: 'Add check for zero divisor',
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: 'sha256:checkset-001',
    baselineRef: 'sha256:baseline-001',
    strategyDigest: 'sha256:strategy-digest-001',
    decisionRef: 'dec-plan-001',
  };

  // Coder without plan: task.plan must be absent
  const coderWithoutPlan = buildTransportPayload(
    createFixtureTaskState({ plan: undefined }),
    [],
    createFixtureProviderRequest({
      role: 'coder',
      purpose: 'investigate-and-propose',
      maxInputTokens: 50000,
      maxBillableTokens: 60000,
      maxCostUsd: 1.0,
    }),
  );
  const coderAdmission = admit(coderWithoutPlan, PRICING, TARGET_ENDPOINT);
  assert.equal(coderAdmission.ok, true);
  if (!coderAdmission.ok) return;
  const coderContent = JSON.parse(JSON.parse(coderAdmission.body).messages[0].content) as {
    task: Record<string, unknown>;
  };
  assert.equal('plan' in coderContent.task, false, 'task.plan must be absent for coder without plan');

  // Reviewer with plan: task.plan must be absent
  const reviewPromptConfig: DeepSeekReviewPrompt = {
    ...DEEPSEEK_REVIEW_PROMPT,
    maxOutputBytes: 16384,
    maxResponseBytes: 131072,
  };
  const reviewerWithPlan = buildTransportPayload(
    createFixtureTaskState({ plan: samplePlan }),
    [],
    createFixtureProviderRequest({
      role: 'reviewer',
      purpose: 'final-review',
      maxInputTokens: 50000,
      maxBillableTokens: 60000,
      maxCostUsd: 1.0,
    }),
  );
  const reviewerAdmission = admit(reviewerWithPlan, PRICING, TARGET_ENDPOINT, reviewPromptConfig);
  assert.equal(reviewerAdmission.ok, true);
  if (!reviewerAdmission.ok) return;
  const reviewerContent = JSON.parse(JSON.parse(reviewerAdmission.body).messages[0].content) as {
    task: Record<string, unknown>;
  };
  assert.equal('plan' in reviewerContent.task, false, 'task.plan must be absent for reviewer even when state has plan');
});

test('coder prompt protocol instructs request-info when clarification or user confirmation is required', () => {
  const coderPayload = buildTransportPayload(
    createFixtureTaskState(),
    [],
    createFixtureProviderRequest({
      role: 'coder',
      purpose: 'investigate-and-propose',
      maxInputTokens: 50000,
      maxBillableTokens: 60000,
      maxCostUsd: 1.0,
    }),
  );

  const admission = admit(coderPayload, PRICING, TARGET_ENDPOINT);
  assert.equal(admission.ok, true, 'coder admission should succeed');
  if (!admission.ok) return;

  const parsedBody = JSON.parse(admission.body) as {
    system: string;
    messages: readonly [{ role: string; content: string }];
  };
  const systemText = parsedBody.system;

  const expectedSentence =
    "When the task's acceptance criteria or constraints require confirming the intended behavior with the user, or the expected behavior leaves a choice between alternatives open, reply with request-info (after the required inspect) asking which behavior is wanted, instead of propose-plan.";

  assert.equal(systemText.includes(expectedSentence), true, 'missing clarification rule directing request-info when behavior confirmation is required');
  assert.equal(
    systemText.includes(`For request.purpose propose-plan/propose-replan, reply with inspect, propose-plan, request-info or stop. ${expectedSentence}`),
    true,
    'clarification rule must immediately follow purpose-mapping sentence',
  );
});
