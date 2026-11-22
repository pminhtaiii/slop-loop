import assert from 'node:assert/strict';
import test from 'node:test';
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

  const parsedBody = JSON.parse(admission.body) as { system: string };
  const systemText = parsedBody.system;

  assertCoderSystemProtocol(systemText);

  const requiredSymbols = new Set<string>(['proposalId', ...Object.keys(VARIANT_FIELDS), ...Object.values(VARIANT_FIELDS).flat(), ...INSPECT_OPERATIONS]);

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

  const parsedBody = JSON.parse(admission.body) as { system: string };
  assert.equal(parsedBody.system, REVIEW_SYSTEM_TEXT);
});
