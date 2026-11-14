/** T035 same-process console composition; all graph adapters remain explicitly controlled. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { Server as HttpServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { admitEvaluationProfile, type CatalogEntry } from '../../../src/runtime/evaluation-profile.ts';
import { createEvaluationConsoleHost, type EvaluationConsoleAssembly } from '../../../src/runtime/evaluation-console-host.ts';
import { prepareControlledUC03Host } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { prepareAssembly, type HostAssembly, type HostConfiguration, type HostConfigurationLoad } from '../../../src/cli/evaluate.ts';
import { runEvaluationConsoleCli } from '../../../src/cli/evaluate-console.ts';
import { REQUIRED_PORTS_V02_METHODS, UC03_PRODUCTION_COMPONENTS_V02, portDeclarationsV02 } from '../../../src/uc03/graph-types-v02.ts';
import type { OwnerDelivery } from '../../../src/runtime/evaluation-composition.ts';
import { controlledGeneratedPlanFixture } from '../support/uc03/controlled-host-journey.ts';

const digest = (seed: string): string => sha256Text(seed);

async function controlledAssembly() {
  const fixture = await controlledGeneratedPlanFixture();
  const files = mkdtempSync(join(tmpdir(), 'uc03-console-host-'));
  const fixturePath = join(files, 'case.json');
  const graderPath = join(files, 'grader.json');
  writeFileSync(fixturePath, '{}', 'utf8');
  writeFileSync(graderPath, '{}', 'utf8');
  const entry: CatalogEntry = {
    catalogEntryId: 'entry-C01-console',
    caseId: 'C01',
    version: '1.0.0',
    caseDigest: digest('console-case'),
    publicTaskDigest: digest('console-task'),
    initialRepositoryDigest: fixture.task.initialRevisionDigest.replace(/^sha256:/u, ''),
    fixturePath,
    fixtureDigest: digest('console-fixture'),
    grader: { version: '1.0.0', digest: digest('console-grader'), path: graderPath },
  };
  const admitted = admitEvaluationProfile({
    endpoint: 'https://api.deepseek.com/v1/messages',
    model: 'deepseek-v4.1',
    mode: 'nonstreaming',
    credentialRef: 'host-deepseek-key',
    codeDigest: digest('console-code'),
    configDigest: digest('console-config'),
    imageDigest: `sha256:${digest('console-image')}`,
    platform: 'linux/amd64',
    adapterVersions: ['uc03-console-adapter-1'],
    pricing: { pricingId: 'console-pricing-1', inputRate: 270, outputRate: 1100, cacheRate: 27, overheadRate: 10, denominator: 1 },
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
    catalog: [entry],
  });
  assert.ok(admitted.ok, admitted.ok ? '' : admitted.reasonCode);
  const profile = admitted.value;
  const configuration = {
    identity: {
      profileId: profile.profileId,
      profileDigest: profile.profileDigest,
      configDigest: profile.configDigest,
      pricingDigest: profile.pricingDigest,
    },
    profileDigest: profile.profileDigest,
    configDigest: profile.configDigest,
    pricingDigest: profile.pricingDigest,
    requestedModel: profile.model,
    adapterVersions: profile.adapterVersions,
  };
  const readiness = prepareControlledUC03Host({
    ...fixture.host.inputs,
    identity: configuration.identity,
    config: { ...fixture.host.inputs.config, generation: undefined },
  });
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') throw new Error('Controlled console host was refused');

  const token = 'controlled-local-operator-token';
  let routeCalls = 0;
  let tokenCalls = 0;
  let exactReady = false;
  let exactCatalog = false;
  const assembly: EvaluationConsoleAssembly = {
    profile,
    catalog: [entry],
    repositoryIds: [fixture.task.repositoryId],
    checkSetIds: ['checks-configured'],
    control: { issue: input => ({ receiptRef: 'console-control', kind: input.kind, taskId: fixture.task.taskId, controlVersion: input.expectedControlVersion + 1 }) },
    approval: {
      presentation: () => ({ ok: true, value: { status: 'pending' } }),
      decide: () => ({ ok: true, value: { status: 'accepted' } }),
    },
    routesFor(ready, catalog) {
      routeCalls += 1;
      exactReady = ready === readiness;
      exactCatalog = catalog === assembly.catalog;
      const route = {
        entry,
        readiness: ready,
        coderBudget: { maxModelCalls: 8, maxActiveMs: 60000, maxRepairs: 2, maxReplans: 3 },
        expectedWait: 'waiting-approval' as const,
        workflowReport: {
          profileDigest: profile.profileDigest,
          configDigest: profile.configDigest,
          pricingDigest: profile.pricingDigest,
          adapterVersions: profile.adapterVersions,
          requestedModel: profile.model,
          timestamp: '2026-11-13T00:00:00.000Z',
        },
        resolveTask: () => fixture.task,
        resolveDirection: () => undefined,
      };
      return new Map([['C01', route]]);
    },
    operatorToken() {
      tokenCalls += 1;
      return token;
    },
  };
  return { fixture, entry, profile, configuration, readiness, assembly, token, counters: () => ({ routeCalls, tokenCalls, exactReady, exactCatalog }) };
}

test('one controlled graph and service back the loopback console and live report comparison', async () => {
  const fixture = await controlledAssembly();
  const started = await createEvaluationConsoleHost(fixture.readiness, fixture.configuration, () => fixture.assembly);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  try {
    assert.equal(started.host.address.host, '127.0.0.1');
    assert.ok(started.host.address.port > 0);
    assert.deepEqual(fixture.counters(), { routeCalls: 1, tokenCalls: 1, exactReady: true, exactCatalog: true });

    const origin = `http://${started.host.address.host}:${started.host.address.port}`;
    const catalogResponse = await fetch(`${origin}/api/catalog`);
    assert.equal(catalogResponse.status, 200);
    const catalog = (await catalogResponse.json()) as { readonly result: { readonly cases: readonly { readonly caseId: string }[] } };
    assert.deepEqual(
      catalog.result.cases.map(row => row.caseId),
      ['C01'],
    );

    const headers = { 'content-type': 'application/json', origin, 'x-operator-token': fixture.token };
    const startResponse = await fetch(`${origin}/api/experiments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ profileId: fixture.profile.profileId, idempotencyKey: 'console-start', source: { kind: 'catalog', caseIds: ['C01'] } }),
    });
    assert.equal(startResponse.status, 200);
    const start = (await startResponse.json()) as {
      readonly ok: boolean;
      readonly result: { readonly experiment: { readonly id: string; readonly status: string; readonly workflowReport: unknown } };
    };
    assert.equal(start.ok, true);
    assert.equal(start.result.experiment.status, 'waiting-approval');
    assert.ok(start.result.experiment.workflowReport, 'the exact graph result is retained by the shared service');
    assert.deepEqual(fixture.fixture.modelCalls, ['coder:propose-plan', 'coder:propose-plan']);

    const comparisonResponse = await fetch(`${origin}/api/comparisons`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ idempotencyKey: 'console-compare', baselineId: start.result.experiment.id, candidateId: start.result.experiment.id, policy: 'guarded' }),
    });
    assert.equal(comparisonResponse.status, 200);
    const comparison = (await comparisonResponse.json()) as { readonly ok: boolean; readonly result: { readonly compatible: boolean } };
    assert.equal(comparison.ok, true);
    assert.equal(comparison.result.compatible, true);

    const missingComparison = await fetch(`${origin}/api/comparisons`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ idempotencyKey: 'console-compare-missing', baselineId: 'exp-missing', candidateId: start.result.experiment.id, policy: 'guarded' }),
    });
    assert.equal(missingComparison.status, 404);
    assert.deepEqual(await missingComparison.json(), { ok: false, error: 'WORKFLOW_REPORT_NOT_FOUND' });

    const output = JSON.stringify({ host: started.host.address.host, port: started.host.address.port });
    assert.equal(output.includes(fixture.token), false);
  } finally {
    await started.host.close();
    await started.host.close();
  }
});

test('misbound identity and throwing route factories refuse before token lookup or listen', async () => {
  const fixture = await controlledAssembly();
  const wrong = { ...fixture.configuration, configDigest: digest('wrong-config') };
  const identityMismatch = await createEvaluationConsoleHost(fixture.readiness, wrong, () => fixture.assembly);
  assert.deepEqual(identityMismatch, { ok: false, reasonCode: 'HOST_CONSOLE_UNAVAILABLE' });
  assert.equal(fixture.counters().tokenCalls, 0);

  const throwing: EvaluationConsoleAssembly = {
    ...fixture.assembly,
    routesFor() {
      throw new Error('secret-route-factory-detail');
    },
  };
  const failed = await createEvaluationConsoleHost(fixture.readiness, fixture.configuration, () => throwing);
  assert.deepEqual(failed, { ok: false, reasonCode: 'HOST_CONSOLE_UNAVAILABLE' });
  assert.equal(fixture.counters().tokenCalls, 0);
  assert.equal(JSON.stringify(failed).includes('secret-route-factory-detail'), false);
});

test('profile, catalog, route, budget, token, getter and factory faults fail closed without graph effects', async () => {
  const fixture = await controlledAssembly();
  const refuse = async (assembly: EvaluationConsoleAssembly, factory = () => assembly) => {
    const result = await createEvaluationConsoleHost(fixture.readiness, fixture.configuration, factory);
    if (result.ok) await result.host.close();
    assert.deepEqual(result, { ok: false, reasonCode: 'HOST_CONSOLE_UNAVAILABLE' });
    assert.deepEqual(fixture.fixture.modelCalls, []);
  };

  await refuse({ ...fixture.assembly, profile: structuredClone(fixture.profile) });
  await refuse({ ...fixture.assembly, catalog: [{ ...fixture.entry, caseDigest: digest('substituted-catalog') }] });
  await refuse({
    ...fixture.assembly,
    routesFor(ready, catalog) {
      const routes = fixture.assembly.routesFor(ready, catalog);
      const route = routes.get('C01');
      assert.ok(route);
      return new Map([['C01', { ...route, readiness: { ...ready } }]]);
    },
  });
  await refuse({
    ...fixture.assembly,
    routesFor(ready, catalog) {
      const routes = fixture.assembly.routesFor(ready, catalog);
      const route = routes.get('C01');
      assert.ok(route);
      return new Map([['C01', { ...route, coderBudget: { ...route.coderBudget, maxActiveMs: fixture.profile.limits.activeExecutionMs + 1 } }]]);
    },
  });
  await refuse({ ...fixture.assembly, operatorToken: () => 'short' });

  const getter = new Proxy(fixture.assembly, {
    get(target, property, receiver) {
      if (property === 'profile') throw new Error('private-assembly-getter');
      return Reflect.get(target, property, receiver);
    },
  });
  await refuse(getter);
  await refuse(fixture.assembly, () => {
    throw new Error('private-factory-exception');
  });
  assert.equal(fixture.counters().tokenCalls, 0);
});

test('serve uses one host load, assembly resolution and bootstrap, then closes on signal', async () => {
  const fixture = await controlledAssembly();
  // Counting declarations exercise the CLI wiring only; they are not owner deliveries or real acceptance.
  const revision = 'a'.repeat(40);
  const hostComponents = ['guardedRead', 'baselineEvidence', 'hostAuthority', 'contextSource'];
  let ownerCalls = 0;
  const owner = UC03_PRODUCTION_COMPONENTS_V02.filter(component => !hostComponents.includes(component)).map(component => ({
    component,
    id: `shell-${component}`,
    contractVersion: 'uc03-owner-delivery/1',
    revision,
    provenance: 'real' as const,
    adapter: {
      provenance: 'real',
      ...portDeclarationsV02(component),
      ...Object.fromEntries(
        REQUIRED_PORTS_V02_METHODS[component].map(method => [
          method,
          () => {
            ownerCalls += 1;
            return undefined;
          },
        ]),
      ),
    },
  })) as OwnerDelivery[];
  const host = {
    owner,
    producers: {
      guardedRead: {
        provenance: 'real',
        mediateRead: () => {
          ownerCalls += 1;
          return undefined;
        },
      },
      baselineEvidence: {
        provenance: 'real',
        persistBaselineEvidence: () => {
          ownerCalls += 1;
          return undefined;
        },
        loadBaselineEvidence: () => {
          ownerCalls += 1;
          return undefined;
        },
      },
      hostAuthority: {
        loadSnapshot: () => {
          ownerCalls += 1;
          return undefined;
        },
      },
      contextSource: {
        provenance: 'real',
        observe: () => {
          ownerCalls += 1;
          return undefined;
        },
      },
    } as never,
    config: fixture.fixture.host.inputs.config,
  } satisfies HostAssembly;
  const loadedConfiguration: HostConfiguration = {
    identity: fixture.configuration.identity,
    pins: fixture.fixture.host.inputs.pins,
    profileDigest: fixture.configuration.profileDigest,
    configDigest: fixture.configuration.configDigest,
    pricingDigest: fixture.configuration.pricingDigest,
    requestedModel: fixture.configuration.requestedModel,
    adapterVersions: fixture.configuration.adapterVersions,
  };
  let loadCalls = 0;
  let resolutionCalls = 0;
  let prepareCalls = 0;
  const loaded: HostConfigurationLoad = { ok: true, value: loadedConfiguration };
  const beforeInt = process.listenerCount('SIGINT');
  const previousTermListeners = new Set(process.listeners('SIGTERM'));
  const beforeTerm = previousTermListeners.size;
  const assemblyForCli: EvaluationConsoleAssembly = {
    ...fixture.assembly,
    routesFor(readiness, catalog) {
      const routes = fixture.assembly.routesFor(readiness, catalog);
      const route = routes.get('C01');
      assert.ok(route);
      return new Map([['C01', { ...route, workflowReport: undefined }]]);
    },
  };
  const result = await runEvaluationConsoleCli(
    ['serve', '--host', 'trusted-host.json'],
    {
      loadConfiguration(path) {
        loadCalls += 1;
        assert.equal(path, 'trusted-host.json');
        return loaded;
      },
      async resolveAssembly(configuration) {
        resolutionCalls += 1;
        assert.equal(configuration, loadedConfiguration);
        return { host, console: () => assemblyForCli };
      },
      prepareAssembly(hostInput, configuration) {
        prepareCalls += 1;
        return prepareAssembly(hostInput, configuration);
      },
      readinessReport: () => 'unavailable',
    },
    true,
  );
  try {
    assert.equal(result.exitCode, 0, result.output);
    assert.deepEqual([loadCalls, resolutionCalls, prepareCalls], [1, 1, 1]);
    assert.equal(ownerCalls, 0, 'readiness and listener construction invoke no owner/provider methods');
    assert.equal(process.listenerCount('SIGINT'), beforeInt + 1);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm + 1);
    assert.equal(result.output.includes(fixture.token), false);
    const shutdown = process.listeners('SIGTERM').find(listener => !previousTermListeners.has(listener));
    assert.ok(shutdown, 'direct serving installs one bounded termination handler');
    Reflect.apply(shutdown, process, []);
    await result.close?.();
    assert.equal(process.listenerCount('SIGINT'), beforeInt);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  } finally {
    await result.close?.();
  }
});

test('the production CLI refuses an explicitly controlled-ready bootstrap without starting a listener', async () => {
  const fixture = await controlledAssembly();
  let factoryCalls = 0;
  const loaded: HostConfigurationLoad = {
    ok: true,
    value: {
      identity: fixture.configuration.identity,
      pins: fixture.fixture.host.inputs.pins,
      profileDigest: fixture.configuration.profileDigest,
      configDigest: fixture.configuration.configDigest,
      pricingDigest: fixture.configuration.pricingDigest,
      requestedModel: fixture.configuration.requestedModel,
      adapterVersions: fixture.configuration.adapterVersions,
    },
  };
  const result = await runEvaluationConsoleCli(
    ['serve', '--host', 'controlled.json'],
    {
      loadConfiguration: () => loaded,
      resolveAssembly: async () => ({
        host: fixture.fixture.host.inputs,
        console: () => {
          factoryCalls += 1;
          return fixture.assembly;
        },
      }),
      prepareAssembly: () => fixture.readiness,
      readinessReport: () => 'unavailable',
    },
    false,
  );

  assert.equal(result.exitCode, 4);
  assert.equal(JSON.parse(result.output).error, 'HOST_CONSOLE_UNAVAILABLE');
  assert.equal(factoryCalls, 0);
  assert.equal(fixture.counters().routeCalls, 0);
  assert.equal(fixture.counters().tokenCalls, 0);
  assert.deepEqual(fixture.fixture.modelCalls, []);
});

test('a bind failure returns a fixed reason and closes partial server resources', async () => {
  const fixture = await controlledAssembly();
  const prototype = HttpServer.prototype;
  const names = ['listen', 'close', 'closeAllConnections'] as const;
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(prototype, name)]));
  let closeCalls = 0;
  let connectionCleanupCalls = 0;
  assert.equal(
    Reflect.set(prototype, 'listen', () => {
      throw new Error('private bind detail');
    }),
    true,
  );
  assert.equal(
    Reflect.set(prototype, 'close', (callback?: unknown) => {
      closeCalls += 1;
      if (typeof callback === 'function') queueMicrotask(() => Reflect.apply(callback, undefined, []));
      return undefined;
    }),
    true,
  );
  assert.equal(
    Reflect.set(prototype, 'closeAllConnections', () => {
      connectionCleanupCalls += 1;
    }),
    true,
  );
  try {
    const result = await createEvaluationConsoleHost(fixture.readiness, fixture.configuration, () => fixture.assembly);
    assert.deepEqual(result, { ok: false, reasonCode: 'HOST_CONSOLE_LISTEN_FAILED' });
    assert.equal(JSON.stringify(result).includes('private bind detail'), false);
    assert.equal(closeCalls, 1);
    assert.equal(connectionCleanupCalls, 1);
    assert.equal(fixture.counters().tokenCalls, 1);
    assert.deepEqual(fixture.fixture.modelCalls, []);
  } finally {
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(prototype, name, descriptor);
      else Reflect.deleteProperty(prototype, name);
    }
  }
});
