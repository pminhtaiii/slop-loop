import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { WorkflowCaseContext, WorkflowCaseResult, WorkflowObservation } from '../../../eval/uc03/types.ts';
import { runEvaluateCli } from '../../../src/cli/evaluate.ts';
import { createHostAssembly, resolveRealTierAssembly, type RealTierAssembly, type RealTierDependencies } from '../../../src/runtime/real-tier-assembly.ts';
import { PINS, type GraderCapability } from '../../../src/runtime/real-tier-case-grade.ts';
import { stdioOperator, type OperatorIo } from '../../../src/runtime/real-tier-case-operator.ts';
import { createRealTierProductionRoute } from '../../../src/runtime/real-tier-production.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { createScanFixture } from '../unit/real-tier-scan-fixtures.ts';
import { parseCliReport, prodCopyTempCount, REV, setupProductionScenario } from './real-tier-production-route-fixture.ts';

const SOURCE = import.meta.url.endsWith('.ts') ? '.ts' : '.js';

function baseCaseContext(assembly: RealTierAssembly): WorkflowCaseContext {
  return {
    spec: {
      caseId: 'C01',
      name: 'Bug repair',
      description: 'C01 repair',
      category: 'repair',
      required: true,
      expectedOutcome: 'COMPLETED',
      requirements: ['fix bug'],
    },
    mode: 'real',
    tier: 'real-integration',
    manifestDigest: `sha256:${sha256Text('manifest')}`,
    configDigest: `sha256:${sha256Text(JSON.stringify({ limits: assembly.profile.limits, runLimits: assembly.profile.runLimits }))}`,
    profileDigest: assembly.metadata.profileDigest,
    pricingDigest: `sha256:${sha256Text(JSON.stringify(assembly.profile.pricing))}`,
    adapterVersions: ['uc03-adapter-1'],
    requestedModel: assembly.metadata.model,
  };
}

function createUnusedGraderCapability(onResolve: () => void): GraderCapability {
  return {
    resolve: () => {
      onResolve();
      return {
        status: 'unavailable',
        reasonCode: 'should-not-be-called',
      };
    },
  } as unknown as GraderCapability;
}

test('4690270275: stdioOperator exposes idempotent close and rejects pending/subsequent reads cleanly', async () => {
  const io = stdioOperator();
  try {
    assert.equal(typeof io.close, 'function');
    const pending = io.read();
    io.close?.();
    io.close?.();
    assert.equal(await pending, undefined);
    assert.equal(await io.read(), undefined);
  } finally {
    io.close?.();
  }
});

test('4690270275: injected caller-owned operatorIo is left open across completed and refused cases', async () => {
  let closeCalls = 0;
  const s = await setupProductionScenario({ tag: 'injected-io-open', fetchMode: 'repair', decisions: [] });
  try {
    const h = (
      globalThis as unknown as { __t011Harness: { env: Record<string, string | undefined>; fetch: typeof globalThis.fetch; spawn: typeof s.spawnSpy.spawn; stateRoot: string; revision: string } }
    ).__t011Harness;
    const queue: ('approve' | 'reject' | undefined)[] = ['approve', 'approve', undefined];
    const callerIo: OperatorIo = {
      write: line => s.operatorPrompts.push(line),
      read: async () => queue.shift(),
      close: () => {
        closeCalls += 1;
      },
    };
    (globalThis as unknown as { __t011Harness: Record<string, unknown> }).__t011Harness = {
      ...h,
      operatorIo: callerIo,
    };

    const okRes = await runEvaluateCli(['run', '--host', s.hostFile, '--mode', 'real', '--cases', 'C01']);
    assert.equal(okRes.exitCode, 0, okRes.output);
    assert.equal(closeCalls, 0, 'caller-owned operatorIo must remain open after completed route');

    const eofRes = await runEvaluateCli(['run', '--host', s.hostFile, '--mode', 'real', '--cases', 'C01']);
    assert.notEqual(eofRes.exitCode, 0);
    assert.equal(closeCalls, 0, 'caller-owned operatorIo must remain open after non-approved route');
  } finally {
    s.cleanup();
  }
});

test('4690270275: default stdioOperator created by route closes when route finishes so process exits with open stdin', async () => {
  const fixtureUrl = new URL(`./real-tier-production-route-fixture${SOURCE}`, import.meta.url).href;
  const evaluateUrl = new URL(`../../../src/cli/evaluate${SOURCE}`, import.meta.url).href;
  const childScript = `
    import { setupProductionScenario } from ${JSON.stringify(fixtureUrl)};
    import { runEvaluateCli } from ${JSON.stringify(evaluateUrl)};
    const s = await setupProductionScenario({ tag: 'stdio-child', fetchMode: 'repair', decisions: [] });
    delete globalThis.__t011Harness.operatorIo;
    try {
      const res = await runEvaluateCli(['run', '--host', s.hostFile, '--mode', 'real', '--cases', 'C01']);
      process.stdout.write('\\nRESULT_EXIT=' + String(res.exitCode) + '\\n');
      process.exitCode = res.exitCode;
    } finally {
      s.cleanup();
    }
  `;

  const outcome = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string; readonly hungAfterResult: boolean }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let sentPrompts = 0;
      let hungAfterResult = false;
      let postResultTimer: ReturnType<typeof setTimeout> | undefined;

      const overallTimer = setTimeout(() => {
        hungAfterResult = true;
        child.kill('SIGKILL');
      }, 60_000);

      child.stdout.on('data', chunk => {
        stdout += String(chunk);
        const promptMatches = stdout.match(/Type "approve" or "reject"/gu)?.length ?? 0;
        while (sentPrompts < promptMatches) {
          sentPrompts += 1;
          // Keep child.stdin intentionally open to expose an unclosed readline listener.
          child.stdin.write('approve\n');
        }
        if (stdout.includes('RESULT_EXIT=') && postResultTimer === undefined) {
          postResultTimer = setTimeout(() => {
            hungAfterResult = true;
            child.kill('SIGKILL');
          }, 3_000);
        }
      });
      child.stderr.on('data', chunk => {
        stderr += String(chunk);
      });
      child.on('error', err => {
        clearTimeout(overallTimer);
        if (postResultTimer !== undefined) clearTimeout(postResultTimer);
        reject(err);
      });
      child.on('close', (code, signal) => {
        clearTimeout(overallTimer);
        if (postResultTimer !== undefined) clearTimeout(postResultTimer);
        resolve({ code, signal, stdout, stderr, hungAfterResult });
      });
    },
  );

  assert.equal(outcome.hungAfterResult, false, `route kept stdin open after completion:\nSTDOUT:\n${outcome.stdout}\nSTDERR:\n${outcome.stderr}`);
  assert.equal(outcome.signal, null);
  assert.equal(outcome.code, 0, `expected clean exit 0, got ${outcome.code}:\n${outcome.stdout}\n${outcome.stderr}`);
  assert.match(outcome.stdout, /RESULT_EXIT=0/u);
});

test('4690270278: per-case assembly drift in profile, config, pricing, model, or revision blocks before grader, copy, or fetch', async () => {
  const fixture = createScanFixture('t011-drift-', 't011-drift-key');
  const stateRoot = join(fixture.OUTSIDE, 'state-drift');
  mkdirSync(stateRoot, { recursive: true });

  const baseEnv = fixture.envOf();
  let fetchCalls = 0;
  let spawnCalls = 0;
  const deps: RealTierDependencies = {
    env: baseEnv,
    stateRoot,
    revision: REV,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('fetch must not be called on drifted assembly');
    },
    spawn: async () => {
      spawnCalls += 1;
      return { exitCode: 1, stdout: '', stderr: 'spawn must not run', timedOut: false };
    },
  };

  try {
    const initialRes = resolveRealTierAssembly(deps);
    assert.equal(initialRes.status, 'assembly-ready');
    const context = baseCaseContext(initialRes);
    const ready = { status: 'ready' as const, identity: { profileDigest: context.profileDigest, configDigest: context.configDigest, pricingDigest: context.pricingDigest } };

    const variants: readonly (readonly [string, () => RealTierAssembly])[] = [
      [
        'profile-digest-drift',
        () => {
          const r = resolveRealTierAssembly({ ...deps, env: fixture.envOf({ campaignId: 'drifted-campaign' }) });
          assert.equal(r.status, 'assembly-ready');
          return r;
        },
      ],
      [
        'config-digest-drift',
        () => {
          const r = resolveRealTierAssembly({
            ...deps,
            env: fixture.envOf({ limits: { ...initialRes.profile.limits, totalModelCalls: initialRes.profile.limits.totalModelCalls + 1 } }),
          });
          assert.equal(r.status, 'assembly-ready');
          return r;
        },
      ],
      [
        'pricing-digest-drift',
        () => {
          const r = resolveRealTierAssembly({
            ...deps,
            env: fixture.envOf({ pricing: { ...initialRes.profile.pricing, outputRate: initialRes.profile.pricing.outputRate + 100 } }),
          });
          assert.equal(r.status, 'assembly-ready');
          return r;
        },
      ],
      [
        'model-drift',
        () => {
          const r = resolveRealTierAssembly({
            ...deps,
            env: fixture.envOf({ provider: { ...fixture.PROVIDER, model: 'cmc/deepseek/deepseek-drifted' } }),
          });
          assert.equal(r.status, 'assembly-ready');
          return r;
        },
      ],
      [
        'revision-drift',
        () => {
          const r = resolveRealTierAssembly({ ...deps, revision: 'b'.repeat(40) });
          assert.equal(r.status, 'assembly-ready');
          return r;
        },
      ],
    ];

    for (const [label, makeDrifted] of variants) {
      let graderResolves = 0;
      const drifted = makeDrifted();
      const routeDeps: RealTierDependencies = {
        ...deps,
        graderCapability: createUnusedGraderCapability(() => {
          graderResolves += 1;
        }),
      };
      const copyBefore = prodCopyTempCount();
      const route = createRealTierProductionRoute(initialRes, routeDeps, () => drifted);
      const produced = route(ready, {
        mode: 'real',
        binding: {
          profileDigest: context.profileDigest,
          configDigest: context.configDigest,
          pricingDigest: context.pricingDigest,
          adapterVersions: context.adapterVersions,
          requestedModel: context.requestedModel,
        },
        caseIds: ['C01'],
        pins: { contractVersion: 'uc03-delivery/2', revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(c => [c, REV])) },
      });
      const driver = 'driver' in produced ? produced.driver : produced;
      const obs = (await driver.executeCase(context.spec, context)) as WorkflowObservation;

      assert.equal(obs.blocked, 'prerequisite-unavailable', `${label}: expected blocked observation`);
      assert.equal(obs.workflowOutcome, 'not-observed', label);
      assert.equal(obs.effects, 'none', label);
      assert.equal(obs.usage, 'unavailable', label);
      assert.ok(obs.diagnostic?.includes('admitted bindings'), label);
      assert.ok(obs.artifacts.includes(`profile:${initialRes.metadata.profileDigest}`), `${label}: must preserve admitted profile artifact`);
      assert.ok(obs.artifacts.includes(`model:req=${initialRes.metadata.model};ret=none`), `${label}: must preserve admitted model artifact`);
      assert.equal(graderResolves, 0, `${label}: must refuse before grader resolution`);
      assert.equal(fetchCalls, 0, `${label}: must make zero provider calls`);
      assert.equal(spawnCalls, 0, `${label}: must make zero spawn calls`);
      assert.equal(prodCopyTempCount(), copyBefore, `${label}: must allocate zero working copies`);
    }

    // Mutated on-disk profile between createHostAssembly and executeCase must also fail closed.
    const mutableProfilePath = baseEnv.UC03_REAL_TIER_PROFILE ?? '';
    assert.ok(mutableProfilePath !== '');
    let diskGraderResolves = 0;
    const hostBuilt = createHostAssembly({
      ...deps,
      graderCapability: createUnusedGraderCapability(() => {
        diskGraderResolves += 1;
      }),
    });
    assert.equal(hostBuilt.assembly.status, 'assembly-ready');
    const rawDiskProfile = JSON.parse(readFileSync(mutableProfilePath, 'utf8')) as Record<string, unknown>;
    const mutatedProfile = { ...rawDiskProfile, provider: { ...fixture.PROVIDER, model: 'cmc/deepseek/mutated-after-admission' } };
    writeFileSync(mutableProfilePath, JSON.stringify(mutatedProfile), 'utf8');

    const copyBefore = prodCopyTempCount();
    const built = hostBuilt.production(ready, {
      mode: 'real',
      binding: {
        profileDigest: context.profileDigest,
        configDigest: context.configDigest,
        pricingDigest: context.pricingDigest,
        adapterVersions: context.adapterVersions,
        requestedModel: context.requestedModel,
      },
      caseIds: ['C01'],
      pins: { contractVersion: 'uc03-delivery/2', revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(c => [c, REV])) },
    });
    const driver = 'driver' in built ? built.driver : built;
    const obs = (await driver.executeCase(context.spec, context)) as WorkflowObservation;
    assert.equal(obs.blocked, 'prerequisite-unavailable');
    assert.equal(diskGraderResolves, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(spawnCalls, 0);
    assert.equal(prodCopyTempCount(), copyBefore);
    assert.ok(PINS['C01'] !== undefined);

    // Deleting the profile after admission must still preserve the unavailable-assembly refusal.
    rmSync(mutableProfilePath, { force: true });
    const unavailableObs = (await driver.executeCase(context.spec, context)) as WorkflowObservation;
    assert.equal(unavailableObs.blocked, 'prerequisite-unavailable');
    assert.equal(unavailableObs.workflowOutcome, 'not-observed');
    assert.match(unavailableObs.diagnostic ?? '', /^Case assembly unavailable \(/u);
    assert.equal(diskGraderResolves, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(spawnCalls, 0);
    assert.equal(prodCopyTempCount(), copyBefore);
  } finally {
    rmSync(fixture.OUTSIDE, { recursive: true, force: true });
    rmSync(fixture.REPO, { recursive: true, force: true });
    rmSync(fixture.BASE, { recursive: true, force: true });
  }
});

test('4690270287: unresolved approval pause retains working copy with waiting-approval/exit 3 while explicit reject releases copy', async () => {
  const copyPrefix = `uc03-real-prod-copy-${process.pid}-`;
  const cases = [
    ['plan-eof', ['undefined-marker'] as const, 1, true],
    ['verify-eof', ['approve', 'undefined-marker'] as const, 2, true],
    ['plan-reject', ['reject'] as const, 1, false],
    ['verify-reject', ['approve', 'reject'] as const, 2, false],
  ] as const;

  for (const [label, rawDecisions, expectedReads, expectRetainedCopy] of cases) {
    const beforeNames = new Set(readdirSync(tmpdir()).filter(name => name.startsWith(copyPrefix)));
    const copyBefore = beforeNames.size;
    const decisions = rawDecisions.map(d => (d === 'undefined-marker' ? undefined : d));
    const s = await setupProductionScenario({ tag: `nr-${label}`, fetchMode: 'repair', decisions });
    try {
      const cliResult = await runEvaluateCli(['run', '--host', s.hostFile, '--mode', 'real', '--cases', 'C01']);
      assert.equal(cliResult.exitCode, 3, `${label}: expected exit 3, got ${cliResult.exitCode}:\n${cliResult.output}`);
      const report = parseCliReport(cliResult.output);
      const c01 = report.cases[0] as WorkflowCaseResult;

      assert.equal(c01.grade, 'not-run', label);
      assert.equal(c01.gradeReason, 'unresolved-wait', label);
      assert.equal(c01.workflowOutcome, 'waiting-approval', label);
      assert.deepEqual(report.selectionResult.pendingWaits, ['C01'], label);
      if (expectRetainedCopy) {
        assert.ok(c01.diagnostic?.includes('remains paused'), `${label}: diagnostic must explain pause`);
        assert.ok(
          c01.limitations.some(item => item.includes('remains paused')),
          `${label}: limitations must explain pause`,
        );
        assert.equal(prodCopyTempCount(), copyBefore + 1, `${label}: unresolved pause must retain working copy`);
      } else {
        assert.ok(c01.diagnostic?.includes('Operator rejected approval'), `${label}: diagnostic must report rejection`);
        assert.equal(prodCopyTempCount(), copyBefore, `${label}: reject must release working copy`);
      }
      assert.equal(s.getOperatorReads(), expectedReads, label);
      assert.equal(s.spawnSpy.hiddenChecks.length, 0, `${label}: must not invoke hidden grader`);
    } finally {
      for (const entry of readdirSync(tmpdir())) {
        if (entry.startsWith(copyPrefix) && !beforeNames.has(entry)) {
          rmSync(join(tmpdir(), entry), { recursive: true, force: true });
        }
      }
      assert.equal(prodCopyTempCount(), copyBefore, `${label}: test cleanup must leave zero extra paused copies`);
      s.cleanup();
    }
  }
});
