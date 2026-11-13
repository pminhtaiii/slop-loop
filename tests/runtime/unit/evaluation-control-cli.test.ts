import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvaluateCli } from '../../../src/cli/evaluate.ts';
import { createEvaluationService } from '../../../src/runtime/evaluation-service.ts';
import { admitEvaluationProfile } from '../../../src/runtime/evaluation-profile.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
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

  const calls = { graph: 0, status: 0, statusIds: [] as string[], direction: 0, directionInputs: [] as unknown[], decision: [] as unknown[] };
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
  const controlService = {
    ...service,
    getExperiment: (id: string) => {
      calls.status += 1;
      calls.statusIds.push(id);
      return service.getExperiment(id);
    },
    issueDirection: (input: Parameters<typeof service.issueDirection>[0]) => {
      calls.directionInputs.push(input);
      return service.issueDirection(input);
    },
  };
  const started = await service.startExperiment({ profileId: 'uc03-runtime-evaluation-v1', source: { kind: 'catalog', caseIds: ['case-1'] }, idempotencyKey: 'start-1' });
  assert.equal(started.ok, true);
  const options = {
    profileDigest: digest,
    configDigest: digest,
    pricingDigest: digest,
    adapterVersions: ['controlled/1'],
    requestedModel: 'controlled',
    control: {
      service: controlService,
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

function hostFileForAssembly(assemblySource: string) {
  const directory = mkdtempSync(join(tmpdir(), 'evaluation-control-host-'));
  const assemblyPath = join(directory, 'assembly.mjs');
  const configPath = join(directory, 'host.json');
  const revision = 'a'.repeat(40);
  const hostDigest = `sha256:${'b'.repeat(64)}`;
  writeFileSync(assemblyPath, assemblySource, 'utf8');
  writeFileSync(
    configPath,
    JSON.stringify({
      profileId: 'profile-001',
      profileDigest: hostDigest,
      configDigest: hostDigest,
      pricingDigest: hostDigest,
      requestedModel: 'controlled-model',
      adapterVersions: ['controlled/1'],
      contractVersion: 'uc03-owner-delivery/1',
      revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, revision])),
      assembly: assemblyPath,
    }),
    'utf8',
  );
  return { directory, assemblyPath, configPath };
}

test('a changing host control getter refuses safely before invoking the owner', async () => {
  const { options, calls } = await fixture();
  const bindingKey = `feature007-changing-control-${Math.random()}`;
  const host = hostFileForAssembly(`export function createHostAssembly() { return { host: {}, control: Reflect.get(globalThis, ${JSON.stringify(bindingKey)}) }; }`);
  let approvalReads = 0;
  const changingControl = {
    service: options.control.service,
    get approval() {
      approvalReads += 1;
      if (approvalReads >= 3) throw new Error('private-changing-approval-getter');
      return options.control.approval;
    },
  };
  const args = ['decision', '--experiment', 'exp-1', '--presentation', presentation, '--version', '1', '--choice', 'approve', '--idempotency-key', 'changing-getter-key', '--host', host.configPath];
  Reflect.set(globalThis, bindingKey, changingControl);
  try {
    let result: Awaited<ReturnType<typeof runEvaluateCli>> | undefined;
    await assert.doesNotReject(async () => { result = await runEvaluateCli(args); });
    assert.ok(result);
    assert.equal(result.exitCode, 4);
    assert.deepEqual(JSON.parse(result.output), { error: 'OPERATOR_CONTROL_UNAVAILABLE' });
    assert.equal(result.output.includes('private-changing-approval-getter'), false);
    assert.equal(result.output.includes(host.configPath), false);
    assert.equal(result.output.includes(host.assemblyPath), false);
    assert.equal(approvalReads, 3);
    assert.deepEqual(calls.decision, []);
    assert.equal(calls.direction, 0);
    assert.equal(calls.status, 0);
    assert.equal(calls.graph, 1);

    const approval = {
      decide(input: unknown) {
        assert.equal(this, approval, 'the selected owner retains its method receiver');
        calls.decision.push(input);
        return { ok: true as const, value: { decisionRef: 'decision-after-getter-recovery' } };
      },
    };
    Reflect.set(globalThis, bindingKey, { service: options.control.service, approval });
    const recovered = await runEvaluateCli(args);
    assert.equal(recovered.exitCode, 0);
    assert.deepEqual(calls.decision, [{ experimentId: 'exp-1', presentationDigest: presentation, expectedVersion: 1, decision: 'approve', idempotencyKey: 'changing-getter-key' }]);
    assert.equal(calls.graph, 1);
  } finally {
    Reflect.deleteProperty(globalThis, bindingKey);
  }
});

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

test('host-file control routes status, decision, explicit direction, and continuation through the existing service', async () => {
  const { options, calls } = await fixture();
  const bindingKey = `feature007-t029-control-${Math.random()}`;
  const host = hostFileForAssembly(`export function createHostAssembly() { return { host: {}, control: Reflect.get(globalThis, ${JSON.stringify(bindingKey)}) }; }`);
  assert.equal(Reflect.set(globalThis, bindingKey, options.control), true);
  try {
    const hostArgs = ['--host', host.configPath];
    const status = await runEvaluateCli(['status', '--experiment', 'exp-1', ...hostArgs]);
    assert.equal(status.exitCode, 0, status.output);
    const statusResult = JSON.parse(status.output) as { readonly ok: boolean; readonly result: { readonly id: string } };
    assert.equal(statusResult.ok, true);
    assert.equal(statusResult.result.id, 'exp-1');
    assert.deepEqual(calls.statusIds, ['exp-1'], 'the host path is not passed to the service');

    const decision = await runEvaluateCli(['decision', '--experiment', 'exp-1', '--presentation', presentation, '--version', '1', '--choice', 'approve', '--idempotency-key', 'host-decision-key', ...hostArgs]);
    assert.equal(decision.exitCode, 0, decision.output);
    assert.deepEqual(calls.decision, [{ experimentId: 'exp-1', presentationDigest: presentation, expectedVersion: 1, decision: 'approve', idempotencyKey: 'host-decision-key' }]);
    assert.equal(calls.graph, 1, 'recording a decision does not continue the graph');

    const directionArgs = ['direction', '--experiment', 'exp-1', '--kind', 'resume', '--task-version', '1', '--control-version', '1', '--decision', 'decision-1', '--idempotency-key', 'host-direction-key', ...hostArgs];
    const directed = await runEvaluateCli(directionArgs);
    assert.equal(directed.exitCode, 0, directed.output);
    assert.deepEqual(calls.directionInputs, [{ id: 'exp-1', kind: 'resume', expectedTaskVersion: 1, expectedControlVersion: 1, idempotencyKey: 'host-direction-key', decisionRef: 'decision-1' }]);
    assert.equal(calls.graph, 1, 'a direction alone does not continue the graph');
    const directionReplay = await runEvaluateCli(directionArgs);
    assert.equal(directionReplay.exitCode, 0, directionReplay.output);
    assert.equal(calls.direction, 1, 'the service owns same-key replay');

    const continuationVersion = String(JSON.parse(directed.output).result.experiment.version);
    const continuationArgs = ['continue', '--experiment', 'exp-1', '--version', continuationVersion, '--direction', 'ctrl-1', '--idempotency-key', 'host-continue-key', ...hostArgs];
    const continued = await runEvaluateCli(continuationArgs);
    assert.equal(continued.exitCode, 0, continued.output);
    assert.equal(calls.graph, 2, 'only explicit continuation invokes the graph');
    const continuationReplay = await runEvaluateCli(continuationArgs);
    assert.equal(continuationReplay.exitCode, 0, continuationReplay.output);
    assert.equal(calls.graph, 2, 'same-key continuation replay has no second graph effect');
    const stale = await runEvaluateCli(['continue', '--experiment', 'exp-1', '--version', continuationVersion, '--direction', 'ctrl-1', '--idempotency-key', 'host-stale-key', ...hostArgs]);
    assert.equal(stale.exitCode, 3);
    assert.equal(calls.graph, 2, 'a stale continuation does not invoke the graph');
  } finally {
    assert.equal(Reflect.deleteProperty(globalThis, bindingKey), true);
  }
});

test('invalid host-file control arguments refuse before import or service calls', async () => {
  const { calls } = await fixture();
  const directory = mkdtempSync(join(tmpdir(), 'evaluation-control-invalid-'));
  const marker = join(directory, 'imported.txt');
  const host = hostFileForAssembly(`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported'); export function createHostAssembly() { return { host: {}, control: Reflect.get(globalThis, 'unused') }; }`);
  const beforeGraphCalls = calls.graph;
  const response = await runEvaluateCli(['status', '--experiment', 'exp-1', '--host', host.configPath, '--host', host.configPath]);
  assert.equal(response.exitCode, 2);
  assert.deepEqual(JSON.parse(response.output), { error: 'INVALID_ARGUMENTS' });
  assert.equal(existsSync(marker), false, 'argument validation must precede module import');
  assert.equal(calls.status, 0);
  assert.equal(calls.graph, beforeGraphCalls);
});

test('an explicit control binding wins without importing the host assembly', async () => {
  const { options } = await fixture();
  const directory = mkdtempSync(join(tmpdir(), 'evaluation-control-precedence-'));
  const marker = join(directory, 'imported.txt');
  const host = hostFileForAssembly(`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported'); export function createHostAssembly() { return { host: {}, control: {} }; }`);
  const response = await runEvaluateCli(['status', '--experiment', 'exp-1', '--host', host.configPath], options);
  assert.equal(response.exitCode, 0, response.output);
  assert.equal(existsSync(marker), false, 'the unused host module must not be imported');
});

test('missing, malformed, and throwing host control deliveries are bounded and redacted', async () => {
  const { calls } = await fixture();
  const secret = 'C:\\private\\operator-token-sentinel';
  const cases = [
    { source: 'export function createHostAssembly() { return { host: {} }; }', privateText: undefined },
    { source: "export function createHostAssembly() { return { host: {}, control: { service: { getExperiment() { return { ok: true, value: {} }; } } } }; }", privateText: undefined },
    { source: `export function createHostAssembly() { const result = { host: {} }; Object.defineProperty(result, 'control', { get() { throw new Error(${JSON.stringify(secret)}); } }); return result; }`, privateText: secret },
  ] as const;
  for (const item of cases) {
    const host = hostFileForAssembly(item.source);
    const response = await runEvaluateCli(['status', '--experiment', 'exp-1', '--host', host.configPath]);
    assert.equal(response.exitCode, 4);
    assert.deepEqual(JSON.parse(response.output), { error: 'OPERATOR_CONTROL_UNAVAILABLE' });
    assert.equal(response.output.includes(host.configPath), false);
    if (item.privateText) assert.equal(response.output.includes(item.privateText), false);
  }
  assert.equal(calls.status, 0);
});
