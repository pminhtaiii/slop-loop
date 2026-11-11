import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvaluateCli } from '../../../src/cli/evaluate.ts';
import { createEvaluationService } from '../../../src/runtime/evaluation-service.ts';
import { admitEvaluationProfile } from '../../../src/runtime/evaluation-profile.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';

const digest = sha256Text('controlled-cli');
const presentation = `sha256:${digest}`;

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'evaluation-control-'));
  const fixturePath = join(directory, 'case.json');
  const graderPath = join(directory, 'grader.json');
  writeFileSync(fixturePath, '{}');
  writeFileSync(graderPath, '{}');
  const catalog = [
    {
      catalogEntryId: 'entry-1',
      caseId: 'case-1',
      version: '1',
      caseDigest: digest,
      publicTaskDigest: digest,
      initialRepositoryDigest: digest,
      fixturePath,
      fixtureDigest: digest,
      grader: { version: '1', digest, path: graderPath },
    },
  ];
  const profile = admitEvaluationProfile({
    endpoint: 'https://api.deepseek.com/v1/messages',
    model: 'controlled',
    mode: 'nonstreaming',
    credentialRef: 'host-only',
    codeDigest: digest,
    configDigest: digest,
    imageDigest: presentation,
    platform: 'linux/amd64',
    adapterVersions: ['controlled/1'],
    pricing: { pricingId: 'test-pricing', inputRate: 270, outputRate: 1100, cacheRate: 27, overheadRate: 10, denominator: 1 },
    limits: {
      totalModelCalls: 24,
      inputTokensPerRequest: 32768,
      outputTokensPerRequest: 8192,
      providerTimeoutMs: 60000,
      activeExecutionMs: 900000,
      repairs: 2,
      reviewerIterations: 2,
      materialReplans: 3,
      commandTimeoutMs: 30000,
      outputBytes: 1048576,
      memoryBytes: 2147483648,
      cpus: 2,
      processes: 64,
    },
    catalog,
  });
  assert.equal(profile.ok, true);

  const calls = { graph: 0, direction: 0, decision: [] as unknown[] };
  const service = createEvaluationService({
    profile: profile.value,
    catalog,
    repositoryIds: ['repo-1'],
    checkSetIds: ['checks-1'],
    ids: () => 'exp-1',
    control: {
      issue: input => {
        calls.direction += 1;
        return { receiptRef: 'ctrl-1', taskId: 'task-1', kind: input.kind, controlVersion: 2 };
      },
    },
    graph: {
      portsFor: () => ({}),
      run: async () => {
        calls.graph += 1;
        return { outcome: calls.graph === 1 ? 'pending-approval' : 'COMPLETED', state: { taskId: 'task-1', runId: 'run-1', workspaceId: 'ws-1' } };
      },
    },
  });
  const started = await service.startExperiment({ profileId: 'uc03-runtime-evaluation-v1', source: { kind: 'catalog', caseIds: ['case-1'] }, idempotencyKey: 'start-1' });
  assert.equal(started.ok, true);
  const options = {
    profileDigest: digest,
    configDigest: digest,
    pricingDigest: digest,
    adapterVersions: ['controlled/1'],
    requestedModel: 'controlled',
    control: {
      service,
      approval: {
        decide: async (input: unknown) => {
          calls.decision.push(input);
          return { ok: true as const, value: { decisionRef: 'decision-1' } };
        },
      },
    },
  };
  return { options, service, calls };
}

test('decision records a choice; explicit direction and continuation use the same service', async () => {
  const { options, calls } = await fixture();
  const decision = await runEvaluateCli(['decision', '--experiment', 'exp-1', '--presentation', presentation, '--version', '1', '--choice', 'approve', '--idempotency-key', 'decision-key'], options);
  assert.equal(decision.exitCode, 0, decision.output);
  assert.deepEqual(calls.decision, [{ experimentId: 'exp-1', presentationDigest: presentation, expectedVersion: 1, decision: 'approve', idempotencyKey: 'decision-key' }]);
  assert.equal(calls.graph, 1);
  const directionArgs = ['direction', '--experiment', 'exp-1', '--kind', 'resume', '--task-version', '1', '--control-version', '1', '--decision', 'decision-1', '--idempotency-key', 'direction-key'];
  const directed = await runEvaluateCli(directionArgs, options);
  assert.equal(directed.exitCode, 0, directed.output);
  const replay = await runEvaluateCli(directionArgs, options);
  assert.equal(replay.exitCode, 0);
  assert.equal(calls.direction, 1);
  assert.equal(calls.graph, 1);
  const continuationVersion = String(JSON.parse(directed.output).result.experiment.version);
  const continued = await runEvaluateCli(['continue', '--experiment', 'exp-1', '--version', continuationVersion, '--direction', 'ctrl-1', '--idempotency-key', 'continue-key'], options);
  assert.equal(continued.exitCode, 0, continued.output);
  assert.equal(calls.graph, 2);
  const repeated = await runEvaluateCli(['continue', '--experiment', 'exp-1', '--version', continuationVersion, '--direction', 'ctrl-1', '--idempotency-key', 'continue-key'], options);
  assert.equal(repeated.exitCode, 0);
  assert.equal(calls.graph, 2);
  const stale = await runEvaluateCli(['continue', '--experiment', 'exp-1', '--version', continuationVersion, '--direction', 'ctrl-1', '--idempotency-key', 'stale-key'], options);
  assert.equal(stale.exitCode, 3);
  assert.equal(calls.graph, 2);
});

test('invalid operator claims and absent control bindings cause no downstream calls', async () => {
  const { options, calls } = await fixture();
  const invalid = await runEvaluateCli(['decision', '--experiment', 'exp-1', '--presentation', presentation, '--version', '-1', '--choice', 'approve', '--idempotency-key', 'bad'], options);
  assert.equal(invalid.exitCode, 2);
  assert.deepEqual(calls.decision, []);
  const missing = await runEvaluateCli(['continue', '--experiment', 'exp-1', '--version', '1', '--direction', 'ctrl-1', '--idempotency-key', 'missing']);
  assert.equal(missing.exitCode, 4);
  assert.equal(calls.graph, 1);
});

test('owner refusal and uncertain exceptions are preserved without automatic continuation', async () => {
  const { options, calls } = await fixture();
  const args = ['decision', '--experiment', 'exp-1', '--presentation', presentation, '--version', '1', '--choice', 'reject', '--idempotency-key', 'reject-key'];
  const refused = await runEvaluateCli(args, {
    ...options,
    control: { ...options.control, approval: { decide: async () => ({ ok: false as const, status: 'conflict' as const, reasonCode: 'STALE_PRESENTATION' }) } },
  });
  assert.equal(refused.exitCode, 3);
  assert.equal(JSON.parse(refused.output).error, 'STALE_PRESENTATION');
  const uncertain = await runEvaluateCli(args, {
    ...options,
    control: {
      ...options.control,
      approval: {
        decide: async () => {
          throw new Error('api_key=private-value');
        },
      },
    },
  });
  assert.equal(uncertain.exitCode, 4);
  assert.equal(JSON.parse(uncertain.output).effects, 'uncertain');
  assert.equal(uncertain.output.includes('private-value'), false);
  assert.equal(calls.graph, 1);
});
