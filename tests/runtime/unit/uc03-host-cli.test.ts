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
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadHostConfiguration, readinessReport, runEvaluateCli, type HostAssembly, type EvaluateCliOptions } from '../../../src/cli/evaluate.ts';
import type { OwnerDelivery } from '../../../src/runtime/evaluation-composition.ts';
import { REQUIRED_PORTS_V02_METHODS, UC03_PRODUCTION_COMPONENTS_V02, portDeclarationsV02, type UC03GraphConfigV02 } from '../../../src/uc03/graph-types-v02.ts';

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
    adapter: { provenance: 'real', ...portDeclarationsV02(component), ...Object.fromEntries(REQUIRED_PORTS_V02_METHODS[component].map(method => [method, () => undefined])) },
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

const errorOf = (stdout: string): unknown => (JSON.parse(stdout) as { error?: unknown }).error;

/** A real-shaped assembly module the direct binary imports; `body` runs inside the factory, before it returns. */
function assemblyModule(body = '', factoryName = 'createHostAssembly'): string {
  const directory = mkdtempSync(join(tmpdir(), 'uc03-assembly-'));
  const path = join(directory, 'assembly.mjs');
  const source = pathToFileURL(fileURLToPath(new URL('../../../src/uc03/graph-types-v02.ts', import.meta.url))).href;
  writeFileSync(
    path,
    `import { REQUIRED_PORTS_V02_METHODS as METHODS, UC03_PRODUCTION_COMPONENTS_V02 as COMPONENTS, portDeclarationsV02 as DECLARATIONS } from ${JSON.stringify(source)};
const CONTRACT = ${JSON.stringify(CONTRACT)};
const REV = ${JSON.stringify(REV)};
const DIGEST = ${JSON.stringify(DIGEST)};
const HOST = ['guardedRead', 'baselineEvidence', 'hostAuthority', 'contextSource'];
const shell = component => ({
  component,
  id: component + '-id',
  contractVersion: CONTRACT,
  revision: REV,
  provenance: 'real',
  adapter: { provenance: 'real', ...DECLARATIONS(component), ...Object.fromEntries(METHODS[component].map(method => [method, () => undefined])) },
});
export function ${factoryName}() {
  const owner = COMPONENTS.filter(component => !HOST.includes(component)).map(shell);
  const result = {
    host: {
      owner,
      producers: {
        guardedRead: { provenance: 'real', mediateRead: () => undefined },
        baselineEvidence: { provenance: 'real', persistBaselineEvidence: () => undefined, loadBaselineEvidence: () => undefined },
        hostAuthority: { loadSnapshot: () => undefined },
        contextSource: { provenance: 'real', observe: () => undefined },
      },
      config: {
        trustedExpectedContext: {
          taskId: 'task-calc-001',
          workspaceId: 'workspace-001',
          repositoryId: 'repo-calc',
          revisionDigest: DIGEST,
          criteriaDigest: DIGEST,
          checkSetDigest: DIGEST,
          expectedTestFiles: ['tests/test_calculator.py'],
        },
      },
    },
  };
  ${body}
  return result;
}
`,
    'utf8',
  );
  return path;
}

/** The fixture route's own observable: a validated C01 observation, so a runner dispatch is visible in the report. */
const ROUTE = `  result.production = () => ({ executeCase: spec => ({
    repositoryId: 'repo-calc',
    taskId: 'task-calc-001',
    runId: 'run-fixture-001',
    returnedModel: 'fixture-model',
    graderDigest: null,
    initialRepositoryDigest: null,
    workflowOutcome: spec.caseId === 'C01' ? 'COMPLETED' : 'not-observed',
    expectedWait: null,
    blocked: null,
    effects: 'observed',
    usage: 'observed',
    diagnostic: null,
    artifacts: [],
    limitations: [],
  }) });`;

/** The fixture route paused in a wait; `expectedWait` alone decides whether that pause is judged. */
function pausedRoute(expectedWait: string | null): string {
  return `  result.production = () => ({ executeCase: () => ({
    repositoryId: 'repo-calc',
    taskId: 'task-calc-001',
    runId: 'run-fixture-001',
    returnedModel: 'fixture-model',
    graderDigest: null,
    initialRepositoryDigest: null,
    workflowOutcome: 'waiting-info',
    expectedWait: ${JSON.stringify(expectedWait)},
    blocked: null,
    effects: 'observed',
    usage: 'observed',
    diagnostic: null,
    artifacts: [],
    limitations: [],
  }) });`;
}

function cliEntry(name: 'evaluate' | 'uc03'): string {
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return fileURLToPath(new URL(`../../../src/cli/${name}${extension}`, import.meta.url));
}

function spawnCli(name: 'evaluate' | 'uc03', args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cliEntry(name), ...args], { encoding: 'utf8', windowsHide: true });
}

test('direct evaluation preflight parses the host file and reports unavailable assembly', () => {
  const result = spawnCli('evaluate', ['preflight', '--host', hostFile()]);
  assert.equal(result.status, 4, result.stderr);
  assert.equal(errorOf(result.stdout), 'HOST_ASSEMBLY_UNAVAILABLE');
  assert.equal(result.stderr, '');

  const invalid = spawnCli('evaluate', ['preflight', '--host', hostFile({ apiKey: 'secret-shell-value' })]);
  assert.equal(invalid.status, 2);
  assert.equal(errorOf(invalid.stdout), 'HOST_CONFIG_UNSUPPORTED_FIELD');
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
  for (const overrides of [{ ports: { statePort: {} } }, { approvalFacts: [] }, { apiKey: secret }, { note: `token=${secret}` }, { assembly: `C:/api-key/${secret}/assembly.mjs` }]) {
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
  for (const overrides of [
    { profileId: '' },
    { revisions: { statePort: 'not-a-revision' } },
    { revisions: { notAComponent: REV } },
    { adapterVersions: [] },
    { assembly: 42 },
    { assembly: '' },
    { assembly: 'a\nb' },
  ]) {
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
  assert.equal(errorOf(missingAssembly.output), 'HOST_ASSEMBLY_UNAVAILABLE');
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
  assert.equal(errorOf(result.output), 'HOST_ROUTE_UNAVAILABLE');
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

test('a direct evaluation preflight assembles from the operator file reference alone', () => {
  // No programmatic options in the spawn: the reference in the file is the whole binding.
  const assembly = assemblyModule('');
  const result = spawnCli('evaluate', ['preflight', '--host', hostFile({ assembly })]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout) as { readonly outcome: string; readonly components: readonly string[] };
  assert.equal(report.outcome, 'ready');
  assert.deepEqual(report.components, [...UC03_PRODUCTION_COMPONENTS_V02]);
  assert.equal(result.stdout.includes(assembly), false, 'the reference is never echoed');
});

test('a mock-provenanced assembly reference cannot buy real readiness', () => {
  const assembly = assemblyModule(`
  for (const delivery of result.host.owner) {
    delivery.provenance = 'mock';
    delivery.adapter.provenance = 'mock';
  }`);
  const result = spawnCli('evaluate', ['preflight', '--host', hostFile({ assembly })]);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  // The composition provenance gate names the first mismatched delivery; `mock-delivery` is a later
  // gate, so the exact pair proves which one refused.
  assert.deepEqual(JSON.parse(result.stdout), {
    outcome: 'unavailable',
    reasons: [{ kind: 'component', component: 'statePort', reasonCode: 'incompatible-delivery' }],
  });
});

test('a direct evaluation run reaches the runner through the fixture route, not the route-unavailable exit', () => {
  const result = spawnCli('evaluate', ['run', '--host', hostFile({ assembly: assemblyModule(ROUTE) }), '--cases', 'C01']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout.slice(0, result.stdout.indexOf('\nUC-03 Workflow Evaluation'))) as {
    readonly cases: readonly { readonly caseId: string; readonly runId: string; readonly gradeReason: string }[];
  };
  assert.deepEqual([report.cases[0]?.caseId, report.cases[0]?.runId, report.cases[0]?.gradeReason], ['C01', 'run-fixture-001', 'criteria-satisfied']);
});

test('a declared pause passes at exit 0 while an unresolved wait stays pending at exit 3', () => {
  // Same observation either way; only `expectedWait` separates "paused as intended" from "still waiting".
  const paused = spawnCli('evaluate', ['run', '--host', hostFile({ assembly: assemblyModule(pausedRoute('waiting-info')) }), '--cases', 'C02']);
  assert.equal(paused.status, 0, paused.stdout + paused.stderr);
  assert.equal(
    (JSON.parse(paused.stdout.slice(0, paused.stdout.indexOf('\nUC-03 Workflow Evaluation'))) as { readonly cases: readonly { readonly gradeReason: string }[] }).cases[0]?.gradeReason,
    'expected-wait-satisfied',
  );

  const unresolved = spawnCli('evaluate', ['run', '--host', hostFile({ assembly: assemblyModule(pausedRoute(null)) }), '--cases', 'C01']);
  assert.equal(unresolved.status, 3, unresolved.stdout + unresolved.stderr);
  const report = JSON.parse(unresolved.stdout.slice(0, unresolved.stdout.indexOf('\nUC-03 Workflow Evaluation'))) as {
    readonly cases: readonly { readonly gradeReason: string }[];
    readonly selectionResult: { readonly pendingWaits: readonly string[] };
  };
  assert.equal(report.cases[0]?.gradeReason, 'unresolved-wait');
  assert.deepEqual(report.selectionResult.pendingWaits, ['C01']);
});

test('an unusable assembly reference fails closed at exit 4 with no path and no exception text', () => {
  const thrown = 'fixture-thrown-detail-9f2';
  const noFactory = assemblyModule('', 'somethingElse');
  const cases: readonly string[] = [
    join(mkdtempSync(join(tmpdir(), 'uc03-assembly-')), 'absent.mjs'),
    noFactory,
    assemblyModule(`  throw new Error(${JSON.stringify(thrown)});`),
    assemblyModule('  result.host = null;'),
    assemblyModule(`  result.production = ${JSON.stringify(thrown)};`),
    assemblyModule('  return undefined;'),
    // Throws after the resolver's guarded region, on the copy `prepareUC03Host` spreads.
    assemblyModule(`  Object.defineProperty(result.host, 'owner', { get() { throw new Error(${JSON.stringify(thrown)}); } });`),
  ];
  for (const assembly of cases) {
    const result = spawnCli('evaluate', ['preflight', '--host', hostFile({ assembly })]);
    assert.equal(result.status, 4, `${assembly}\n${result.stdout}${result.stderr}`);
    assert.equal(errorOf(result.stdout), 'HOST_ASSEMBLY_UNAVAILABLE');
    assert.equal(result.stdout.includes(assembly), false);
    assert.equal(result.stdout.includes(thrown), false);
    assert.equal(result.stderr, '');
  }
});

test('the legacy uc03 direct binary resolves the same reference and keeps the §6 exits', async () => {
  const { createFixtureBugTask } = await import('../support/uc03/port-fixtures.ts');
  const directory = mkdtempSync(join(tmpdir(), 'uc03-legacy-direct-'));
  const taskFile = join(directory, 'task.json');
  writeFileSync(taskFile, JSON.stringify(createFixtureBugTask()), 'utf8');

  // A resolvable reference reaches the v0.2 service itself; the refusal is the graph's own, not the CLI's.
  const reached = spawnCli('uc03', ['--task', taskFile, '--config', hostFile(), '--host', hostFile({ assembly: assemblyModule('') })]);
  assert.equal(reached.status, 1, reached.stdout + reached.stderr);
  assert.equal(reached.stdout.includes('HOST_ASSEMBLY_UNAVAILABLE'), false);
  assert.equal((JSON.parse(reached.stdout) as { diagnostic: { reasonCode: string } }).diagnostic.reasonCode, 'production-admission-refused');

  // No resolvable assembly is still the legacy unavailable-configuration exit.
  const missing = join(directory, 'absent.mjs');
  const unresolved = spawnCli('uc03', ['--task', taskFile, '--config', hostFile(), '--host', hostFile({ assembly: missing })]);
  assert.equal(unresolved.status, 5, unresolved.stdout + unresolved.stderr);
  assert.equal(unresolved.stdout.includes(missing), false);

  // A throwing getter is the same gap here as it is in `evaluate`, not a crash at the tail boundary.
  const thrown = 'legacy-thrown-detail-4c7';
  const getter = assemblyModule(`  Object.defineProperty(result.host, 'owner', { get() { throw new Error(${JSON.stringify(thrown)}); } });`);
  const guarded = spawnCli('uc03', ['--task', taskFile, '--config', hostFile(), '--host', hostFile({ assembly: getter })]);
  assert.equal(guarded.status, 5, guarded.stdout + guarded.stderr);
  assert.equal(errorOf(guarded.stdout), 'HOST_ASSEMBLY_UNAVAILABLE: no host assembly is configured');
  assert.equal(guarded.stdout.includes(thrown), false);

  // A malformed file stays a loader refusal at exit 2, whichever CLI reads it.
  const malformed = spawnCli('uc03', ['--task', taskFile, '--config', hostFile(), '--host', hostFile({ assembly: 42 })]);
  assert.equal(malformed.status, 2);
  assert.equal(errorOf(malformed.stdout), 'HOST_CONFIG_INCOMPLETE');
});

test('a caller-supplied assembly takes precedence over the operator file reference', async () => {
  const { resolveHostAssembly } = await import('../../../src/cli/evaluate.ts');
  const loaded = loadHostConfiguration(hostFile({ assembly: assemblyModule('') }));
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  // The caller's own assembly wins; the file's reference is never consulted for the host.
  const resolved = await resolveHostAssembly(loaded.value, ASSEMBLY);
  assert.equal(resolved?.host, ASSEMBLY);
  assert.equal(resolved?.production, undefined);

  // Without a supplied assembly the file's reference is what resolves.
  const fromFile = await resolveHostAssembly(loaded.value);
  assert.notEqual(fromFile?.host, ASSEMBLY);
  assert.equal(typeof fromFile?.host, 'object');
});
