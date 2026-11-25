import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { EvaluationCaseId, WorkflowCaseContext, WorkflowDriver, WorkflowObservation } from '../../../eval/uc03/types.ts';
import { createHostAssembly, resolveRealTierAssembly, REAL_TIER_DELIVERY_CONTRACT, type RealTierDependencies, type RealTierResolution } from '../../../src/runtime/real-tier-assembly.ts';
import type { OperatorIo } from '../../../src/runtime/real-tier-case-operator.ts';
import { createRealTierCaseLifecycle } from '../../../src/runtime/real-tier-production-lifecycle.ts';
import { abandonRealTierProductionCase, createRealTierProductionRoute, type RealTierProductionRouteOptions } from '../../../src/runtime/real-tier-production.ts';
import { prepareUC03Host } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { prodCopyTempCount, REV, setupProductionScenario, type ProductionScenario } from './real-tier-production-route-fixture.ts';

const COPY_PREFIX = `uc03-real-prod-copy-${process.pid}-`;

interface HarnessGlobals {
  readonly env: Record<string, string | undefined>;
  readonly fetch: typeof globalThis.fetch;
  readonly spawn: Parameters<typeof createHostAssembly>[0] extends infer T ? (T extends { readonly spawn?: infer S } ? S : never) : never;
  readonly stateRoot: string;
  readonly revision: string;
  readonly operatorIo: OperatorIo;
}

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

function newCopyDirs(beforeNames: ReadonlySet<string>): readonly string[] {
  return readdirSync(tmpdir()).filter(name => name.startsWith(COPY_PREFIX) && !beforeNames.has(name));
}

function cleanupNewCopies(beforeNames: ReadonlySet<string>): void {
  for (const entry of newCopyDirs(beforeNames)) rmSync(join(tmpdir(), entry), { recursive: true, force: true });
}

function makeCaseContext(scenario: ProductionScenario, caseId: EvaluationCaseId): WorkflowCaseContext {
  return {
    spec: {
      caseId,
      name: `${caseId} repair`,
      description: `${caseId} repair`,
      category: 'repair',
      required: true,
      expectedOutcome: 'COMPLETED',
      requirements: ['fix bug'],
    },
    mode: 'real',
    tier: 'real-integration',
    manifestDigest: `sha256:${sha256Text('manifest')}`,
    ...scenario.binding,
  };
}

function createRouteDriver(
  scenario: ProductionScenario,
  opts: {
    readonly operatorIo?: OperatorIo | undefined;
    readonly wrapResolve?: (resolveFn: (deps: RealTierDependencies) => RealTierResolution) => (deps: RealTierDependencies) => RealTierResolution;
    readonly routeOptions?: RealTierProductionRouteOptions | undefined;
  } = {},
): { readonly driver: WorkflowDriver } {
  const baseHarness = (globalThis as unknown as { __t011Harness: HarnessGlobals }).__t011Harness;
  const deps: RealTierDependencies = {
    ...baseHarness,
    ...(opts.operatorIo === undefined ? {} : { operatorIo: opts.operatorIo }),
  };
  const resolver = opts.wrapResolve ? opts.wrapResolve(resolveRealTierAssembly) : resolveRealTierAssembly;
  const initial = resolver(deps);
  assert.equal(initial.status, 'assembly-ready');
  const hostBuilt = createHostAssembly(deps);
  assert.notEqual((hostBuilt as { readonly status?: string }).status, 'unavailable');
  const resolvedHost = hostBuilt as Exclude<ReturnType<typeof createHostAssembly>, { readonly status: 'unavailable' }>;
  const ready = prepareUC03Host({
    ...resolvedHost.host,
    identity: {
      profileId: 't011-profile',
      profileDigest: scenario.binding.profileDigest,
      configDigest: scenario.binding.configDigest,
      pricingDigest: scenario.binding.pricingDigest,
    },
    pins: { contractVersion: REAL_TIER_DELIVERY_CONTRACT, revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(c => [c, REV])) },
  });
  assert.equal(ready.status, 'ready');
  const route = createRealTierProductionRoute(initial, deps, resolver, opts.routeOptions);
  const produced = route(ready, {
    mode: 'real',
    binding: scenario.binding,
    caseIds: ['C01', 'C02'],
    pins: { contractVersion: REAL_TIER_DELIVERY_CONTRACT, revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(c => [c, REV])) },
  });
  assert.ok('driver' in produced);
  return { driver: produced.driver };
}

test('R2-OWNERSHIP: overlapping executeCase returns busy without deleting active paused copy and sets approvalDisposition', async () => {
  const beforeNames = new Set(readdirSync(tmpdir()).filter(name => name.startsWith(COPY_PREFIX)));
  const copyBefore = beforeNames.size;
  const s = await setupProductionScenario({ tag: 'own-overlap', fetchMode: 'repair', decisions: [] });
  try {
    const barrierEntered = createDeferred();
    const barrierRelease = createDeferred();
    let reads = 0;
    const decisions: ('approve' | 'reject' | undefined)[] = ['approve', undefined, 'approve'];
    const operatorIo: OperatorIo = {
      write: line => {
        void line;
      },
      read: async () => {
        reads += 1;
        if (reads === 2) {
          barrierEntered.resolve();
          await barrierRelease.promise;
        }
        return decisions.shift();
      },
    };

    const { driver } = createRouteDriver(s, { operatorIo });
    const ctx = makeCaseContext(s, 'C01');

    const attempt1Promise = driver.executeCase(ctx.spec, ctx) as Promise<WorkflowObservation>;
    await barrierEntered.promise;

    const fetchCountAtOverlap = s.fetchSpy.requests.length;
    const spawnCountAtOverlap = s.spawnSpy.spawnCalls.length;
    const copiesAtOverlap = prodCopyTempCount();

    // Overlapping call for same case must fail closed as busy without touching Attempt 1's copy or effects.
    const overlapObs = (await driver.executeCase(ctx.spec, ctx)) as WorkflowObservation;
    assert.equal(overlapObs.blocked, 'busy');
    assert.equal(overlapObs.workflowOutcome, 'not-observed');
    assert.equal(overlapObs.effects, 'none');
    assert.equal(overlapObs.usage, 'unavailable');
    assert.equal(overlapObs.approvalDisposition, undefined);
    assert.equal(s.fetchSpy.requests.length, fetchCountAtOverlap);
    assert.equal(s.spawnSpy.spawnCalls.length, spawnCountAtOverlap);
    assert.equal(prodCopyTempCount(), copiesAtOverlap);

    barrierRelease.resolve();
    const pausedObs = await attempt1Promise;
    assert.equal(pausedObs.workflowOutcome, 'waiting-approval');
    assert.equal(pausedObs.approvalDisposition, 'unanswered');
    assert.equal(prodCopyTempCount(), copyBefore + 1);

    const completedObs = (await driver.executeCase(ctx.spec, ctx)) as WorkflowObservation;
    assert.equal(completedObs.workflowOutcome, 'COMPLETED');
    assert.equal(completedObs.approvalDisposition, undefined);
    assert.equal(prodCopyTempCount(), copyBefore);
    assert.equal(abandonRealTierProductionCase(driver, 'C01'), false);

    // Explicit rejection sets approvalDisposition: 'rejected' and releases its copy.
    decisions.push('reject');
    const rejectedObs = (await driver.executeCase(ctx.spec, ctx)) as WorkflowObservation;
    assert.equal(rejectedObs.workflowOutcome, 'waiting-approval');
    assert.equal(rejectedObs.approvalDisposition, 'rejected');
    assert.equal(prodCopyTempCount(), copyBefore);
  } finally {
    cleanupNewCopies(beforeNames);
    s.cleanup();
  }
});

test('R2-OWNERSHIP: lifecycle owner token prevents mismatched release from removing another paused record', () => {
  const removed: string[] = [];
  const lifecycle = createRealTierCaseLifecycle<{ readonly workingCopyRoot: string }>(root => {
    removed.push(root);
  });
  const foreignToken = Symbol('foreign');
  const first = lifecycle.beginAttempt('C01');
  assert.ok(first !== null);
  lifecycle.retainPaused('C01', first.token, { workingCopyRoot: '/tmp/owned-root' });
  lifecycle.endAttempt('C01', first.token);

  assert.equal(lifecycle.ownsPaused('C01', foreignToken), false);
  assert.equal(lifecycle.releaseOwnedPaused('C01', foreignToken), false);
  assert.equal(lifecycle.ownsPaused('C01', first.token), true);
  assert.deepEqual(removed, []);

  assert.equal(lifecycle.releaseAttemptCopy('C01', '/tmp/unrelated-root', foreignToken), true);
  assert.deepEqual(removed, ['/tmp/unrelated-root']);
  assert.equal(lifecycle.ownsPaused('C01', first.token), true);

  assert.equal(lifecycle.abandon('C01'), true);
  assert.deepEqual(removed, ['/tmp/unrelated-root', '/tmp/owned-root']);
});

test('R2-ABANDON: abandonRealTierProductionCase refuses while loadTask is awaited and preserves continuation copy', async () => {
  const beforeNames = new Set(readdirSync(tmpdir()).filter(name => name.startsWith(COPY_PREFIX)));
  const copyBefore = beforeNames.size;
  const s = await setupProductionScenario({ tag: 'own-load-barrier', fetchMode: 'repair', decisions: [] });
  let restoreLoadTask: (() => void) | undefined;
  try {
    const loadEntered = createDeferred();
    const loadRelease = createDeferred();
    let armed = false;
    const decisions: ('approve' | 'reject' | undefined)[] = ['approve', undefined, 'approve'];
    const operatorIo: OperatorIo = {
      write: line => {
        void line;
      },
      read: async () => decisions.shift(),
    };

    const { driver } = createRouteDriver(s, {
      operatorIo,
      wrapResolve: baseResolve => deps => {
        const res = baseResolve(deps);
        if (res.status === 'assembly-ready' && !armed) {
          const statePort = res.owners.components.statePort;
          const originalLoadTask = statePort.loadTask.bind(statePort);
          restoreLoadTask = () => {
            statePort.loadTask = originalLoadTask;
          };
          statePort.loadTask = async taskId => {
            if (armed) {
              armed = false;
              loadEntered.resolve();
              await loadRelease.promise;
            }
            return originalLoadTask(taskId);
          };
        }
        return res;
      },
    });

    const ctx = makeCaseContext(s, 'C01');
    const pausedObs = (await driver.executeCase(ctx.spec, ctx)) as WorkflowObservation;
    assert.equal(pausedObs.workflowOutcome, 'waiting-approval');
    assert.equal(pausedObs.approvalDisposition, 'unanswered');
    const added = newCopyDirs(beforeNames);
    assert.equal(added.length, 1);
    const pausedCopyRoot = join(tmpdir(), added[0] ?? '');

    armed = true;
    const contPromise = driver.executeCase(ctx.spec, ctx) as Promise<WorkflowObservation>;
    await loadEntered.promise;

    // Abandonment (both single-case and dispose-all) must refuse while continuation awaits loadTask.
    assert.equal(abandonRealTierProductionCase(driver, 'C01'), false);
    assert.equal(abandonRealTierProductionCase(driver), false);
    assert.equal(existsSync(pausedCopyRoot), true);

    loadRelease.resolve();
    const doneObs = await contPromise;
    assert.equal(doneObs.workflowOutcome, 'COMPLETED');
    assert.equal(existsSync(pausedCopyRoot), false);
    assert.equal(prodCopyTempCount(), copyBefore);
  } finally {
    restoreLoadTask?.();
    cleanupNewCopies(beforeNames);
    s.cleanup();
  }
});

test('R2-CLEANUP-RETRY: failed terminal or abandon removal retains cleanup-only tracking, blocks replay, and allows retry', async () => {
  const beforeNames = new Set(readdirSync(tmpdir()).filter(name => name.startsWith(COPY_PREFIX)));
  const copyBefore = beforeNames.size;
  const s = await setupProductionScenario({ tag: 'own-retry', fetchMode: 'repair', decisions: [] });
  const failRoots = new Set<string>();
  const restoreFns: (() => void)[] = [];
  try {
    const decisions: ('approve' | 'reject' | undefined)[] = ['approve', undefined, 'approve', undefined];
    const operatorIo: OperatorIo = {
      write: line => {
        void line;
      },
      read: async () => decisions.shift(),
    };
    const loadedRunIds: (string | null)[] = [];

    const { driver } = createRouteDriver(s, {
      operatorIo,
      routeOptions: {
        removeCopy: root => {
          if (failRoots.has(root)) throw new Error(`EPERM: injected removal failure for ${root}`);
          rmSync(root, { recursive: true, force: true });
        },
      },
      wrapResolve: baseResolve => deps => {
        const res = baseResolve(deps);
        if (res.status === 'assembly-ready') {
          const statePort = res.owners.components.statePort;
          const originalLoadTask = statePort.loadTask.bind(statePort);
          restoreFns.push(() => {
            statePort.loadTask = originalLoadTask;
          });
          statePort.loadTask = async taskId => {
            const loaded = await originalLoadTask(taskId);
            loadedRunIds.push(loaded?.runId ?? null);
            return loaded;
          };
        }
        return res;
      },
    });

    const ctx = makeCaseContext(s, 'C01');
    const paused1 = (await driver.executeCase(ctx.spec, ctx)) as WorkflowObservation;
    assert.equal(paused1.workflowOutcome, 'waiting-approval');
    assert.ok(paused1.runId !== null);
    const terminalRunId = paused1.runId;
    const copy1 = join(tmpdir(), newCopyDirs(beforeNames)[0] ?? '');

    // Inject removal failure for copy1 during terminal completion cleanup.
    failRoots.add(copy1);
    const completed1 = (await driver.executeCase(ctx.spec, ctx)) as WorkflowObservation;
    assert.equal(completed1.workflowOutcome, 'COMPLETED');
    assert.equal(completed1.runId, terminalRunId);
    assert.equal(existsSync(copy1), true, 'failed terminal removal keeps root on disk');

    // Subsequent executeCase must NOT resume or replay the cleanup-only terminal run.
    loadedRunIds.length = 0;
    const paused2 = (await driver.executeCase(ctx.spec, ctx)) as WorkflowObservation;
    assert.equal(paused2.workflowOutcome, 'waiting-approval');
    assert.ok(paused2.runId !== null);
    assert.notEqual(paused2.runId, terminalRunId);
    assert.equal(loadedRunIds.includes(terminalRunId), false, 'cleanup-only record must not trigger terminal replay');

    // Injected abandon failure also preserves retry responsibility.
    const copy2 = join(tmpdir(), newCopyDirs(beforeNames).find(name => join(tmpdir(), name) !== copy1) ?? '');
    failRoots.add(copy2);
    assert.equal(abandonRealTierProductionCase(driver, 'C01'), false);
    assert.equal(existsSync(copy1), true);
    assert.equal(existsSync(copy2), true);

    // Restore removal and prove retry cleans both cleanup-only copies.
    failRoots.clear();
    assert.equal(abandonRealTierProductionCase(driver, 'C01'), true);
    assert.equal(existsSync(copy1), false);
    assert.equal(existsSync(copy2), false);
    assert.equal(prodCopyTempCount(), copyBefore);
    assert.equal(abandonRealTierProductionCase(driver, 'C01'), false);
  } finally {
    failRoots.clear();
    while (restoreFns.length > 0) restoreFns.pop()?.();
    cleanupNewCopies(beforeNames);
    s.cleanup();
  }
});

test('R2-CLEANUP-RETRY: disposal-all skips active roots, isolates partial failures, and completes on retry', async () => {
  const beforeNames = new Set(readdirSync(tmpdir()).filter(name => name.startsWith(COPY_PREFIX)));
  const copyBefore = beforeNames.size;
  const s = await setupProductionScenario({ tag: 'own-dispose-all', fetchMode: 'repair', decisions: [] });
  const failRoots = new Set<string>();
  const restoreFns: (() => void)[] = [];
  try {
    const loadEntered = createDeferred();
    const loadRelease = createDeferred();
    let armBarrierForTask: string | undefined;
    const decisions: ('approve' | 'reject' | undefined)[] = ['approve', undefined, 'approve'];
    const operatorIo: OperatorIo = {
      write: line => {
        void line;
      },
      read: async () => decisions.shift(),
    };

    const { driver } = createRouteDriver(s, {
      operatorIo,
      routeOptions: {
        removeCopy: root => {
          if (failRoots.has(root)) throw new Error(`EPERM: injected removal failure for ${root}`);
          rmSync(root, { recursive: true, force: true });
        },
      },
      wrapResolve: baseResolve => deps => {
        const res = baseResolve(deps);
        if (res.status === 'assembly-ready') {
          const statePort = res.owners.components.statePort;
          const originalLoadTask = statePort.loadTask.bind(statePort);
          restoreFns.push(() => {
            statePort.loadTask = originalLoadTask;
          });
          statePort.loadTask = async taskId => {
            if (armBarrierForTask === taskId) {
              armBarrierForTask = undefined;
              loadEntered.resolve();
              await loadRelease.promise;
            }
            return originalLoadTask(taskId);
          };
        }
        return res;
      },
    });

    const c01Ctx = makeCaseContext(s, 'C01');
    const c02Ctx = makeCaseContext(s, 'C02');

    // Pause both C01 (active barrier target) and C02 (clarificationHold holds pending-approval on C02).
    const c01Paused = (await driver.executeCase(c01Ctx.spec, c01Ctx)) as WorkflowObservation;
    assert.equal(c01Paused.workflowOutcome, 'waiting-approval');
    assert.ok(c01Paused.taskId !== null);
    const c01Root = join(tmpdir(), newCopyDirs(beforeNames)[0] ?? '');

    const c02Paused = (await driver.executeCase(c02Ctx.spec, c02Ctx)) as WorkflowObservation;
    assert.equal(c02Paused.workflowOutcome, 'waiting-approval');
    const c02Root = join(tmpdir(), newCopyDirs(beforeNames).find(name => join(tmpdir(), name) !== c01Root) ?? '');
    assert.equal(prodCopyTempCount(), copyBefore + 2);

    // Block C01 at loadTask while C02 fails removal -> disposal-all must skip C01 and keep C02 for retry.
    armBarrierForTask = c01Paused.taskId;
    const c01Cont = driver.executeCase(c01Ctx.spec, c01Ctx) as Promise<WorkflowObservation>;
    await loadEntered.promise;

    failRoots.add(c02Root);
    assert.equal(abandonRealTierProductionCase(driver), false);
    assert.equal(existsSync(c01Root), true, 'active C01 root must be untouched by disposal-all');
    assert.equal(existsSync(c02Root), true, 'failed C02 removal must stay tracked');

    loadRelease.resolve();
    const c01Done = await c01Cont;
    assert.equal(c01Done.workflowOutcome, 'COMPLETED');
    assert.equal(existsSync(c01Root), false);

    // Pause a fresh C01 so we can also test partial failure across two non-active cases (C01 succeeds, C02 fails).
    decisions.push('approve', undefined);
    const c01Paused2 = (await driver.executeCase(c01Ctx.spec, c01Ctx)) as WorkflowObservation;
    assert.equal(c01Paused2.workflowOutcome, 'waiting-approval');
    const c01Root2 = join(tmpdir(), newCopyDirs(beforeNames).find(name => join(tmpdir(), name) !== c02Root) ?? '');
    assert.equal(abandonRealTierProductionCase(driver), false);
    assert.equal(existsSync(c01Root2), false, 'non-failing case must still be cleaned during partial failure');
    assert.equal(existsSync(c02Root), true, 'failing case stays tracked for retry');

    failRoots.clear();
    assert.equal(abandonRealTierProductionCase(driver), true);
    assert.equal(existsSync(c02Root), false);
    assert.equal(prodCopyTempCount(), copyBefore);
  } finally {
    failRoots.clear();
    while (restoreFns.length > 0) restoreFns.pop()?.();
    cleanupNewCopies(beforeNames);
    s.cleanup();
  }
});
