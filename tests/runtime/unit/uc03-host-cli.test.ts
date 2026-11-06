/**
 * T029 witness: the host-only loader and the preflight path, at CLI level only.
 *
 * Every assembly here is a declared-real shell with no behaviour, so a `ready` result proves
 * assembly and nothing else. No task, approval, provider or command effect is created by these
 * tests, and no real owner is claimed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadHostConfiguration, readinessReport, runEvaluateCli, type HostAssembly, type EvaluateCliOptions } from '../../../src/cli/evaluate.ts';
import type { OwnerDelivery } from '../../../src/runtime/evaluation-composition.ts';
import { REQUIRED_PORTS_V02_METHODS, UC03_PRODUCTION_COMPONENTS_V02, type UC03GraphConfigV02 } from '../../../src/uc03/graph-types-v02.ts';

const CONTRACT = 'uc03-owner-delivery/1';
const REV = 'a'.repeat(40);
const DIGEST = 'sha256:' + 'b'.repeat(64);
const HOST_COMPONENTS = ['guardedRead', 'baselineEvidence', 'hostAuthority', 'contextSource'] as const;
const OWNER_COMPONENTS = UC03_PRODUCTION_COMPONENTS_V02.filter(component => !(HOST_COMPONENTS as readonly string[]).includes(component));

function shell(component: OwnerDelivery['component']): OwnerDelivery {
  return {
    component,
    id: `${component}-id`,
    contractVersion: CONTRACT,
    revision: REV,
    provenance: 'real',
    adapter: { provenance: 'real', ...Object.fromEntries(REQUIRED_PORTS_V02_METHODS[component].map(method => [method, () => undefined])) },
  } as OwnerDelivery;
}

const CONFIG: UC03GraphConfigV02 = {
  trustedExpectedContext: {
    taskId: 'task-calc-001',
    workspaceId: 'workspace-001',
    repositoryId: 'repo-calc',
    revisionDigest: DIGEST,
    criteriaDigest: DIGEST,
    checkSetDigest: DIGEST,
    expectedTestFiles: ['tests/test_calculator.py'],
  },
};

const ASSEMBLY: HostAssembly = {
  owner: OWNER_COMPONENTS.map(shell),
  producers: {
    guardedRead: { provenance: 'real', mediateRead: () => undefined } as never,
    baselineEvidence: { provenance: 'real', persistBaselineEvidence: () => undefined, loadBaselineEvidence: () => undefined } as never,
    hostAuthority: { loadSnapshot: () => undefined } as never,
    contextSource: { provenance: 'real', observe: () => undefined } as never,
  },
  config: CONFIG,
};

function hostFile(overrides: Record<string, unknown> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'uc03-host-cli-'));
  const path = join(directory, 'host.json');
  writeFileSync(
    path,
    JSON.stringify({
      profileId: 'profile-001',
      profileDigest: DIGEST,
      configDigest: DIGEST,
      pricingDigest: DIGEST,
      requestedModel: 'deepseek-v4.1',
      adapterVersions: ['uc03-adapter-1'],
      contractVersion: CONTRACT,
      revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, REV])),
      ...overrides,
    }),
    'utf8',
  );
  return path;
}

function options(overrides: Partial<EvaluateCliOptions> = {}): EvaluateCliOptions {
  return { profileDigest: DIGEST, configDigest: DIGEST, pricingDigest: DIGEST, adapterVersions: ['uc03-adapter-1'], requestedModel: 'deepseek-v4.1', ...overrides };
}

test('direct evaluation preflight parses the host file and reports unavailable assembly', () => {
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const entry = fileURLToPath(new URL(`../../../src/cli/evaluate${extension}`, import.meta.url));
  const result = spawnSync(process.execPath, [entry, 'preflight', '--host', hostFile()], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 4, result.stderr);
  assert.equal(JSON.parse(result.stdout).error, 'HOST_ASSEMBLY_UNAVAILABLE');
  assert.equal(result.stderr, '');

  const invalid = spawnSync(process.execPath, [entry, 'preflight', '--host', hostFile({ apiKey: 'secret-shell-value' })], { encoding: 'utf8', windowsHide: true });
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).error, 'HOST_CONFIG_UNSUPPORTED_FIELD');
  assert.equal(invalid.stdout.includes('secret-shell-value'), false);
});

test('a complete host file loads without carrying ports, policy facts or credentials', () => {
  const loaded = loadHostConfiguration(hostFile());
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.value.identity.profileId, 'profile-001');
  assert.equal(loaded.value.pins.contractVersion, CONTRACT);
  assert.equal(Object.keys(loaded.value.pins.revisions).length, UC03_PRODUCTION_COMPONENTS_V02.length);
});

test('a port, a policy fact or a credential field is refused and no value is echoed', () => {
  const secret = 'sk-live-9f2';
  for (const overrides of [{ ports: { statePort: {} } }, { approvalFacts: [] }, { apiKey: secret }, { note: `token=${secret}` }]) {
    const loaded = loadHostConfiguration(hostFile(overrides));
    assert.equal(loaded.ok, false);
    if (loaded.ok) continue;
    assert.equal(loaded.error.exitCode, 2);
    assert.equal(loaded.error.output.includes(secret), false);
    assert.equal(loaded.error.output.includes('statePort'), false);
  }
});

test('adapter metadata refuses credential-shaped values and an unbounded list', () => {
  for (const adapterVersions of [['credential:private-value'], Array.from({ length: 65 }, () => 'adapter-v1')]) {
    const loaded = loadHostConfiguration(hostFile({ adapterVersions }));
    assert.equal(loaded.ok, false);
    if (loaded.ok) continue;
    assert.equal(loaded.error.exitCode, 2);
    assert.equal(loaded.error.output.includes('private-value'), false);
  }
});

test('an incomplete host file is refused rather than half-assembled', () => {
  for (const overrides of [{ profileId: '' }, { revisions: { statePort: 'not-a-revision' } }, { revisions: { notAComponent: REV } }, { adapterVersions: [] }]) {
    const loaded = loadHostConfiguration(hostFile(overrides));
    assert.equal(loaded.ok, false, JSON.stringify(overrides));
    if (!loaded.ok) assert.equal(loaded.error.exitCode, 2);
  }
});

test('preflight reaches the bootstrap and reports readiness without dispatch', async () => {
  const result = await runEvaluateCli(['preflight', '--host', hostFile()], options({ host: ASSEMBLY }));
  assert.equal(result.exitCode, 0, result.output);
  const report = JSON.parse(result.output) as { readonly outcome: string; readonly components: readonly string[]; readonly identity: unknown };
  assert.equal(report.outcome, 'ready');
  assert.deepEqual(report.components, [...UC03_PRODUCTION_COMPONENTS_V02]);
  assert.equal(result.output.includes(REV), false, 'no revision value reaches the readiness output');
});

test('preflight without a host file or an assembly is a named prerequisite gap at exit 4', async () => {
  const noFile = await runEvaluateCli(['preflight'], options({ host: ASSEMBLY }));
  assert.equal(noFile.exitCode, 2);

  const missingAssembly = await runEvaluateCli(['preflight', '--host', hostFile()], options());
  assert.equal(missingAssembly.exitCode, 4);
  assert.equal(JSON.parse(missingAssembly.output).error, 'HOST_ASSEMBLY_UNAVAILABLE');
});

test('an unavailable assembly names each bounded reason at exit 4', async () => {
  const pins = { contractVersion: CONTRACT, revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.filter(component => component !== 'replanPort').map(component => [component, REV])) };
  const path = hostFile({ revisions: pins.revisions });
  const result = await runEvaluateCli(['preflight', '--host', path], options({ host: ASSEMBLY }));
  assert.equal(result.exitCode, 4);
  assert.deepEqual(JSON.parse(result.output), { outcome: 'unavailable', reasons: [{ kind: 'component', component: 'replanPort', reasonCode: 'stale-revision' }] });
});

test('a missing prerequisite is exit 4 and never a mock fallback', async () => {
  const result = await runEvaluateCli(['run', '--host', hostFile(), '--cases', 'C01'], options({ host: ASSEMBLY }));
  assert.equal(result.exitCode, 4);
  assert.equal(JSON.parse(result.output).error, 'HOST_ROUTE_UNAVAILABLE');
  assert.equal(/mock fallback/iu.test(result.output), false);
});

test('the controlled programmatic path is unchanged when no host file is given', async () => {
  const result = await runEvaluateCli(['--mode', 'mock', '--cases', 'C01'], options());
  assert.equal(result.exitCode, 1);
  const report = JSON.parse(result.output.slice(0, result.output.indexOf('\nUC-03 Workflow Evaluation'))) as { readonly cases: readonly { readonly gradeReason: string }[] };
  assert.equal(report.cases[0]?.gradeReason, 'driver-unavailable');
});

test('readiness reporting keeps reason codes and identity but no delivered value', () => {
  const ready = readinessReport({ status: 'ready', ports: {} as never, config: CONFIG, identity: { profileId: 'p' } });
  assert.equal(ready.includes('"p"'), true);
  assert.equal(ready.includes(REV), false);

  const unavailable = readinessReport({ status: 'unavailable', reasons: [{ kind: 'identity', reasonCode: 'unsafe-identity' }] });
  assert.deepEqual(JSON.parse(unavailable), { outcome: 'unavailable', reasons: [{ kind: 'identity', reasonCode: 'unsafe-identity' }] });
});

test('the legacy uc03 CLI shares the host loader and keeps exit 5 for unavailable configuration', async () => {
  const { runUC03Cli } = await import('../../../src/cli/uc03.ts');
  const { createFixtureBugTask } = await import('../support/uc03/port-fixtures.ts');
  const directory = mkdtempSync(join(tmpdir(), 'uc03-legacy-cli-'));
  const taskFile = join(directory, 'task.json');
  writeFileSync(taskFile, JSON.stringify(createFixtureBugTask()), 'utf8');

  // A valid task and host file but no host assembly: the legacy unavailable-configuration exit.
  const noAssembly = await runUC03Cli(['--task', taskFile, '--config', hostFile(), '--host', hostFile()]);
  assert.equal(noAssembly.exitCode, 5);
  assert.equal(noAssembly.output.includes('HOST_ASSEMBLY_UNAVAILABLE'), true);

  // A credential-shaped host file is refused by the shared loader, at the loader's own exit.
  const refused = await runUC03Cli(['--task', taskFile, '--config', hostFile(), '--host', hostFile({ apiKey: 'sk-live-9f2' })]);
  assert.equal(refused.exitCode, 2);
  assert.equal(refused.output.includes('sk-live-9f2'), false);
});
