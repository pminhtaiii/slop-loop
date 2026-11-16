/**
 * T050 — task-independent real-tier component set (real-tier contract §(a), §(i); host contract §1
 * first stage).
 *
 * Every row builds the set with injected doubles and a temp state root, so the whole file proves the
 * static stage makes zero fetches, zero spawns and zero task writes. The refusal rows each change one
 * input and assert the bounded reason and that nothing was built. A complete real set is a
 * prerequisite, never G-OWNERS evidence: the result says so itself.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { StructuredSpawn, StructuredSpawnResult } from '../../../src/foundation/docker-controller.ts';
import { REAL_TIER_COMPONENTS, createHostAssembly, resolveRealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import type { RealTierDependencies, RealTierResolution } from '../../../src/runtime/real-tier-assembly.ts';
import type { RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { createScanFixture, type ScanFixture } from '../unit/real-tier-scan-fixtures.ts';
import { prepareAssembly } from '../../../src/cli/evaluate-host.ts';

const fixture: ScanFixture = createScanFixture('t050-assembly-', 't050-assembly-digest-key');

/** The two dispatch double counts: a fetch or spawn here would be a real effect the static stage forbids. */
interface Effects {
  fetch: number;
  spawn: number;
}

function tempRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `t050-${label}-`));
}

/** Every accumulated entry under a directory: a task write shows up as a file or directory here. */
function entriesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true }).map(entry => String(entry));
}

function dependencies(
  overrides: Partial<RealTierDependencies> = {},
  env: RealTierEnvironment = fixture.envOf(),
): { readonly deps: RealTierDependencies; readonly effects: Effects; readonly stateRoot: string } {
  const effects: Effects = { fetch: 0, spawn: 0 };
  const stateRoot = tempRoot('state');
  const spawn: StructuredSpawn = async (): Promise<StructuredSpawnResult> => {
    effects.spawn += 1;
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
  const fetchDouble: typeof globalThis.fetch = async () => {
    effects.fetch += 1;
    throw new Error('the static assembly stage must never fetch');
  };
  return { effects, stateRoot, deps: { env, fetch: fetchDouble, spawn, stateRoot, revision: 'a'.repeat(40), ...overrides } };
}

/** Asserts the refusal shape and that the profile, the endpoint and the key never appear in it. */
function reasonOf(resolution: RealTierResolution): string {
  assert.equal(resolution.status, 'unavailable', 'this input must refuse the assembly');
  return resolution.status === 'unavailable' ? resolution.reasonCode : '';
}

function assertNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const needle of [fixture.KEY, fixture.HREF, '192.0.2.10', '54321', '/v1/messages', fixture.DIGEST_KEY]) {
    assert.ok(!serialized.includes(needle), `serialized output must not carry ${needle === fixture.DIGEST_KEY ? 'the digest key' : 'a sentinel'}`);
  }
}

test('a complete real component set builds with zero fetches, zero spawns and zero task writes', () => {
  const { deps, effects, stateRoot } = dependencies();
  const resolved = resolveRealTierAssembly(deps);

  assert.equal(resolved.status, 'assembly-ready');
  if (resolved.status !== 'assembly-ready') return;
  for (const component of REAL_TIER_COMPONENTS) {
    assert.equal(resolved.components[component].provenance, 'real', `${component} must declare real provenance`);
  }
  assert.equal(resolved.reviewer.provenance, 'real', 'the reviewer ingress derives provenance from the branded transport');
  assert.equal(resolved.metadata.endpointScheme, 'http');
  assert.equal(resolved.metadata.insecureHttpAcknowledged, true);
  assert.equal(resolved.metadata.model, fixture.MODEL);
  assert.equal(resolved.metadata.imageId.startsWith('sha256:'), true);
  // The real T043 journal brand is what UC-05 control/continuation accepts (contract §(b)5).
  assert.equal(resolved.owners.productionJournal, true);
  assert.deepEqual(
    resolved.owners.deliveries.map(delivery => [delivery.component, delivery.provenance, delivery.contractVersion]),
    ['statePort', 'approvalPort', 'baselineEvidence', 'replanPort'].map(component => [component, 'real', 'uc03-host-composition/2']),
  );
  // Delegated-attestation attribution only; no personal owner name may appear in a delivery identity.
  for (const delivery of resolved.owners.deliveries) assert.match(delivery.id, /delegated-attestation/u);

  assert.deepEqual(effects, { fetch: 0, spawn: 0 });
  assert.deepEqual(entriesUnder(stateRoot), [], 'the static stage writes no task, store or approval file');
  rmSync(stateRoot, { recursive: true, force: true });
});

test('the assembly is labelled a prerequisite, not G-OWNERS evidence, and makes no ready claim', () => {
  const { deps } = dependencies();
  const resolved = resolveRealTierAssembly(deps);
  assert.equal(resolved.status === 'assembly-ready' ? resolved.evidenceTier : '', 'controlled-prerequisite');
  assert.ok(!JSON.stringify(resolved).includes('"status":"ready"'), 'assembly-ready is not host readiness');

  const created = createHostAssembly(deps);
  assert.ok('host' in created, 'a complete set resolves through the CLI factory name');
  const serialized = JSON.stringify(created);
  assert.ok(!serialized.includes('"ready"'), 'the factory claims no prepareUC03Host readiness');
  // T061 adds the four task-bound producers unbound; real-tier-task-binding.test.ts row (b) proves they refuse.
});

test('the serialized output never contains the sentinel key, the endpoint URL or the digest key', () => {
  const { deps } = dependencies();
  const resolved = resolveRealTierAssembly(deps);
  assert.equal(resolved.status, 'assembly-ready');
  if (resolved.status !== 'assembly-ready') return;
  assertNoSecrets({ metadata: resolved.metadata, deliveries: resolved.owners.deliveries, evidenceTier: resolved.evidenceTier });
  assertNoSecrets(createHostAssembly(deps));
});

test('a missing credential refuses with no effect', () => {
  const { deps, effects, stateRoot } = dependencies({}, fixture.envOf({}, { ANTHROPIC_API_KEY: undefined }));
  assert.equal(reasonOf(resolveRealTierAssembly(deps)), 'credential-missing');
  assert.deepEqual(effects, { fetch: 0, spawn: 0 });
  assert.deepEqual(entriesUnder(stateRoot), []);
});

test('a missing profile refuses with no effect', () => {
  const { deps, effects, stateRoot } = dependencies({}, { ANTHROPIC_API_KEY: fixture.KEY });
  assert.equal(reasonOf(resolveRealTierAssembly(deps)), 'profile-path-missing');
  assert.deepEqual(effects, { fetch: 0, spawn: 0 });
  assert.deepEqual(entriesUnder(stateRoot), []);
});

test('an ambiguous endpoint or an ambiguous model each refuse with the contract reason', () => {
  const base = fixture.envOf();
  const endpoint = dependencies({}, { ...base, ANTHROPIC_BASE_URL: 'http://192.0.2.11:54321/v1' });
  assert.equal(reasonOf(resolveRealTierAssembly(endpoint.deps)), 'endpoint-ambiguous');

  const model = dependencies({}, { ...base, ANTHROPIC_MODEL: 'po/deepseek-ai/other-model' });
  assert.equal(reasonOf(resolveRealTierAssembly(model.deps)), 'model-ambiguous');

  for (const row of [endpoint, model]) {
    assert.deepEqual(row.effects, { fetch: 0, spawn: 0 });
    assert.deepEqual(entriesUnder(row.stateRoot), []);
  }
});

test('an unacknowledged http endpoint refuses; the acknowledged one is flagged', () => {
  const unacknowledged = dependencies({}, fixture.envOf({ provider: { ...fixture.PROVIDER, allowInsecureHttp: false } }));
  assert.equal(reasonOf(resolveRealTierAssembly(unacknowledged.deps)), 'insecure-endpoint-unacknowledged');
  assert.deepEqual(unacknowledged.effects, { fetch: 0, spawn: 0 });

  const acknowledged = resolveRealTierAssembly(dependencies().deps);
  assert.equal(acknowledged.status === 'assembly-ready' ? acknowledged.profile.transport : '', 'insecure-http-acknowledged');
});

test('invalid run limits refuse with a bounded reason and no effect', () => {
  for (const runLimits of [
    { perRunInputTokens: 0, perRunOutputTokens: 80_000 },
    { perRunInputTokens: 400_000, perRunOutputTokens: -1 },
    { perRunInputTokens: 1.5, perRunOutputTokens: 80_000 },
  ]) {
    const { deps, effects, stateRoot } = dependencies({}, fixture.envOf({ runLimits }));
    assert.equal(reasonOf(resolveRealTierAssembly(deps)), 'run-limits-invalid');
    assert.deepEqual(effects, { fetch: 0, spawn: 0 });
    assert.deepEqual(entriesUnder(stateRoot), []);
  }
});

test('each single component swapped for a mock delivery refuses that component', () => {
  // One row per component: the first mock in the set is the one named, so each row passes exactly one.
  for (const component of REAL_TIER_COMPONENTS) {
    const { deps, effects, stateRoot } = dependencies({
      components: { [component]: { provenance: 'mock' } } as unknown as RealTierDependencies['components'],
    });
    const resolved = resolveRealTierAssembly(deps);
    assert.equal(resolved.status, 'unavailable', `${component} must refuse`);
    if (resolved.status !== 'unavailable') continue;
    assert.equal(resolved.reasonCode, 'mock-delivery');
    assert.equal(resolved.path, `$.components.${component}`);
    assert.deepEqual(effects, { fetch: 0, spawn: 0 });
    assert.deepEqual(entriesUnder(stateRoot), []);
  }
});

test('(T061 a) the no-argument default revision is the template HEAD pin, so the printed template is assembly-ready', async () => {
  // The template pins `git rev-parse HEAD`; the factory's default must be the same value, or the host
  // file the operator prints can never be assembled against the factory that reads it.
  const { deps } = dependencies({ revision: undefined });
  const resolved = resolveRealTierAssembly(deps);
  assert.equal(resolved.status, 'assembly-ready', JSON.stringify(resolved));
  if (resolved.status !== 'assembly-ready') return;

  const { runRealTierScanCli } = await import('../../../src/cli/real-tier-scan.ts');
  const { execFileSync } = await import('node:child_process');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(resolved.revision, head, 'the default revision is the commit the template pins');

  // The printed template is a host file: build one from it and run the unchanged bootstrap over it.
  const env = fixture.envOf();
  const printed = await runRealTierScanCli(['--print-host-template'], { env, repositoryRoot: fixture.REPO });
  assert.equal(printed.exitCode, 0, printed.output);
  const template = JSON.parse(printed.output) as {
    readonly profileDigest: string;
    readonly configDigest: string;
    readonly pricingDigest: string;
    readonly requestedModel: string;
    readonly adapterVersions: readonly string[];
    readonly contractVersion: string;
    readonly revisions: Readonly<Record<string, string>>;
  };
  const created = createHostAssembly(deps);
  assert.ok('host' in created, JSON.stringify(created));
  if (!('host' in created)) return;
  const readiness = prepareAssembly(created.host, {
    identity: { profileId: 'uc03-runtime-evaluation-v1', profileDigest: template.profileDigest, configDigest: template.configDigest, pricingDigest: template.pricingDigest },
    pins: { contractVersion: template.contractVersion, revisions: template.revisions },
    profileDigest: template.profileDigest,
    configDigest: template.configDigest,
    pricingDigest: template.pricingDigest,
    requestedModel: template.requestedModel,
    adapterVersions: template.adapterVersions,
  });
  assert.equal(readiness?.status, 'ready', JSON.stringify(readiness));
  assert.equal(template.contractVersion, 'uc03-host-composition/2');
});
