import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { WorkflowCaseContext, WorkflowCaseResult, WorkflowObservation } from '../../../eval/uc03/types.ts';
import { runEvaluateCli } from '../../../src/cli/evaluate.ts';
import { createHostAssembly, resolveRealTierAssembly, REAL_TIER_DELIVERY_CONTRACT, type RealTierAssembly, type RealTierDependencies } from '../../../src/runtime/real-tier-assembly.ts';
import { prepareUC03Host } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { PINS, type GraderCapability } from '../../../src/runtime/real-tier-case-grade.ts';
import { createRealTierGraderCapability } from '../../../src/runtime/real-tier-grader.ts';
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

interface GraderSpyCounts {
  isolationReads: number;
  executorReads: number;
  finalTreeReads: number;
  bindCaseCalls: number;
}

function createGraderSpy(spawn?: RealTierDependencies['spawn']) {
  const real = createRealTierGraderCapability(spawn === undefined ? {} : { spawn });
  const counts: GraderSpyCounts = { isolationReads: 0, executorReads: 0, finalTreeReads: 0, bindCaseCalls: 0 };
  const capability: GraderCapability = {
    tier: real.tier,
    get isolationAuthority() {
      counts.isolationReads += 1;
      return real.isolationAuthority;
    },
    get executor() {
      counts.executorReads += 1;
      return real.executor;
    },
    get finalTree() {
      counts.finalTreeReads += 1;
      return real.finalTree;
    },
    bindCase(pins) {
      counts.bindCaseCalls += 1;
      real.bindCase(pins);
    },
  };
  return { capability, counts };
}

function assertZeroGraderSpy(counts: GraderSpyCounts, label: string): void {
  assert.deepEqual(counts, { isolationReads: 0, executorReads: 0, finalTreeReads: 0, bindCaseCalls: 0 }, label);
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
      globalThis as unknown as {
        __t011Harness: { env: Record<string, string | undefined>; fetch: typeof globalThis.fetch; spawn: typeof s.spawnSpy.spawn; stateRoot: string; revision: string; operatorIo: OperatorIo };
      }
    ).__t011Harness;
    const queue: ('approve' | 'reject' | undefined)[] = ['approve', 'approve', undefined];
    const callerIo: OperatorIo = {
      write: h.operatorIo.write,
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
  const catalogDir = join(fixture.REPO, 'fixtures', 'uc03');
  mkdirSync(catalogDir, { recursive: true });
  const graderDoc = JSON.stringify({
    criteria: { digest: `sha256:${sha256Text('c')}`, criteria: [{ criterionId: 'crit-c01', caseId: 'C01', predicate: 'repair-success', hiddenCheckId: 'hidden-C01' }] },
    profile: { profileId: 'p', digest: `sha256:${sha256Text('p')}`, bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 8 } },
    graderPayload: { files: { 'test_oracle.py': 'def test_ok():\n    pass\n' }, argv: ['pytest', '-q', '/grader/test_oracle.py'] },
  });
  const graderPath = join(catalogDir, 'grader-c01.json');
  writeFileSync(graderPath, graderDoc, 'utf8');
  writeFileSync(join(catalogDir, 'catalog.json'), JSON.stringify({ catalog: [{ caseId: 'C01', grader: { path: graderPath, digest: `sha256:${sha256Text(graderDoc)}` } }] }), 'utf8');

  const pins = { contractVersion: REAL_TIER_DELIVERY_CONTRACT, revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(c => [c, REV])) };
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
    const assertNoRun = (obs: WorkflowObservation, spyCounts: GraderSpyCounts, copyBefore: number, label: string) => {
      assert.equal(obs.blocked, 'prerequisite-unavailable', label);
      assert.equal(obs.workflowOutcome, 'not-observed', label);
      assert.equal(obs.effects, 'none', label);
      assert.equal(obs.usage, 'unavailable', label);
      assertZeroGraderSpy(spyCounts, label);
      assert.equal(fetchCalls, 0, label);
      assert.equal(spawnCalls, 0, label);
      assert.equal(prodCopyTempCount(), copyBefore, label);
    };

    // Positive control: matching assembly invokes capability members (`isolationAuthority`, `executor`, `finalTree`, `bindCase`).
    const ctrl = await setupProductionScenario({ tag: 'drift-ctrl', fetchMode: 'repair', decisions: ['approve', 'approve'] });
    try {
      const h = (globalThis as unknown as { __t011Harness: RealTierDependencies }).__t011Harness;
      const ctrlSpy = createGraderSpy(h.spawn);
      const ctrlHost = createHostAssembly({ ...h, graderCapability: ctrlSpy.capability });
      assert.ok('assembly' in ctrlHost && ctrlHost.assembly.status === 'assembly-ready');
      const ctrlReady = prepareUC03Host({
        ...ctrlHost.host,
        identity: { profileId: 't011-profile', profileDigest: ctrl.binding.profileDigest, configDigest: ctrl.binding.configDigest, pricingDigest: ctrl.binding.pricingDigest },
        pins,
      });
      assert.equal(ctrlReady.status, 'ready');
      const ctrlProduced = ctrlHost.production(ctrlReady, { mode: 'real', binding: ctrl.binding, caseIds: ['C01'], pins });
      assert.ok('driver' in ctrlProduced && ctrlProduced.realAdmission !== undefined, 'ctrl realAdmission');
      const ctrlCtx = { ...baseCaseContext(ctrlHost.assembly), ...ctrl.binding };
      const ctrlObs = (await ctrlProduced.driver.executeCase(ctrlCtx.spec, ctrlCtx)) as WorkflowObservation;
      assert.equal(ctrlObs.workflowOutcome, 'COMPLETED');
      assert.ok(ctrlSpy.counts.isolationReads >= 1 && ctrlSpy.counts.executorReads >= 1 && ctrlSpy.counts.finalTreeReads >= 1 && ctrlSpy.counts.bindCaseCalls >= 1);
    } finally {
      ctrl.cleanup();
    }

    const initialRes = resolveRealTierAssembly(deps);
    assert.equal(initialRes.status, 'assembly-ready');
    const context = baseCaseContext(initialRes);
    const binding = {
      profileDigest: context.profileDigest,
      configDigest: context.configDigest,
      pricingDigest: context.pricingDigest,
      adapterVersions: context.adapterVersions,
      requestedModel: context.requestedModel,
    };
    const readyHost = createHostAssembly(deps);
    assert.ok('host' in readyHost);
    const ready = prepareUC03Host({
      ...readyHost.host,
      identity: { profileId: 't011-profile', profileDigest: context.profileDigest, configDigest: context.configDigest, pricingDigest: context.pricingDigest },
      pins,
    });
    assert.equal(ready.status, 'ready');

    const variants: readonly (readonly [string, RealTierDependencies])[] = [
      ['profile-digest-drift', { ...deps, env: fixture.envOf({ campaignId: 'drifted-campaign' }) }],
      ['config-digest-drift', { ...deps, env: fixture.envOf({ limits: { ...initialRes.profile.limits, totalModelCalls: initialRes.profile.limits.totalModelCalls + 1 } }) }],
      ['pricing-digest-drift', { ...deps, env: fixture.envOf({ pricing: { ...initialRes.profile.pricing, outputRate: initialRes.profile.pricing.outputRate + 100 } }) }],
      ['model-drift', { ...deps, env: fixture.envOf({ provider: { ...fixture.PROVIDER, model: 'cmc/deepseek/deepseek-drifted' } }) }],
      ['revision-drift', { ...deps, revision: 'b'.repeat(40) }],
    ];

    for (const [label, driftDeps] of variants) {
      const spy = createGraderSpy(deps.spawn);
      const drifted = resolveRealTierAssembly(driftDeps);
      assert.equal(drifted.status, 'assembly-ready', label);
      const copyBefore = prodCopyTempCount();
      const route = createRealTierProductionRoute(initialRes, { ...deps, graderCapability: spy.capability }, () => drifted);
      const produced = route(ready, { mode: 'real', binding, caseIds: ['C01'], pins });
      assert.ok('driver' in produced && produced.realAdmission !== undefined, `${label}: realAdmission`);
      const obs = (await produced.driver.executeCase(context.spec, context)) as WorkflowObservation;
      assertNoRun(obs, spy.counts, copyBefore, label);
      assert.ok(obs.diagnostic?.includes('admitted bindings'), label);
      assert.ok(obs.artifacts.includes(`profile:${initialRes.metadata.profileDigest}`), label);
      assert.ok(obs.artifacts.includes(`model:req=${initialRes.metadata.model};ret=none`), label);
    }

    // Mutated on-disk profile between createHostAssembly and executeCase must also fail closed.
    const mutableProfilePath = baseEnv.UC03_REAL_TIER_PROFILE ?? '';
    assert.ok(mutableProfilePath !== '');
    const diskSpy = createGraderSpy(deps.spawn);
    const hostBuilt = createHostAssembly({ ...deps, graderCapability: diskSpy.capability });
    assert.ok('assembly' in hostBuilt && hostBuilt.assembly.status === 'assembly-ready');
    const rawDiskProfile = JSON.parse(readFileSync(mutableProfilePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(mutableProfilePath, JSON.stringify({ ...rawDiskProfile, provider: { ...fixture.PROVIDER, model: 'cmc/deepseek/mutated-after-admission' } }), 'utf8');

    const copyBefore = prodCopyTempCount();
    const built = hostBuilt.production(ready, { mode: 'real', binding, caseIds: ['C01'], pins });
    assert.ok('driver' in built && built.realAdmission !== undefined, 'disk mutation realAdmission');
    const obs = (await built.driver.executeCase(context.spec, context)) as WorkflowObservation;
    assertNoRun(obs, diskSpy.counts, copyBefore, 'disk-profile-mutation');
    assert.ok(PINS['C01'] !== undefined);

    // Deleting the profile after admission must still preserve the unavailable-assembly refusal.
    rmSync(mutableProfilePath, { force: true });
    const unavailableObs = (await built.driver.executeCase(context.spec, context)) as WorkflowObservation;
    assertNoRun(unavailableObs, diskSpy.counts, copyBefore, 'deleted-profile');
    assert.match(unavailableObs.diagnostic ?? '', /^Case assembly unavailable \(/u);
  } finally {
    rmSync(fixture.OUTSIDE, { recursive: true, force: true });
    rmSync(fixture.REPO, { recursive: true, force: true });
    rmSync(fixture.BASE, { recursive: true, force: true });
  }
});

test('4690270287: one-shot CLI releases paused working copies on exit 3 while distinguishing unanswered pause from operator rejection', async () => {
  const copyPrefix = `uc03-real-prod-copy-${process.pid}-`;
  const cases = [
    ['plan-eof', ['undefined-marker'] as const, 1, true],
    ['verify-eof', ['approve', 'undefined-marker'] as const, 2, true],
    ['plan-reject', ['reject'] as const, 1, false],
    ['verify-reject', ['approve', 'reject'] as const, 2, false],
  ] as const;

  for (const [label, rawDecisions, expectedReads, expectUnansweredPause] of cases) {
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
      assert.equal(prodCopyTempCount(), copyBefore, `${label}: one-shot CLI must clean up route working copies on exit`);
      const stateRoot = (globalThis as unknown as { __t011Harness?: { stateRoot: string } }).__t011Harness?.stateRoot ?? '';
      assert.ok(stateRoot !== '' && readdirSync(stateRoot).length > 0, `${label}: durable stateRoot artifacts must remain`);
      if (expectUnansweredPause) {
        assert.ok(c01.diagnostic?.includes('remains paused'), `${label}: diagnostic must explain pause`);
        assert.ok(
          c01.limitations.some(item => item.includes('remains paused')),
          `${label}: limitations must explain pause`,
        );
        assert.ok(
          report.limitations.some(item => item.includes('One-shot CLI') && item.includes('unsupported')),
          `${label}: report must note one-shot teardown`,
        );
      } else {
        assert.ok(c01.diagnostic?.includes('Operator rejected approval'), `${label}: diagnostic must report rejection`);
        assert.equal(
          c01.limitations.some(item => item.includes('remains paused')),
          false,
          `${label}: rejection must not claim task remains paused`,
        );
      }
      assert.equal(s.getOperatorReads(), expectedReads, label);
      assert.equal(s.spawnSpy.hiddenChecks.length, 0, `${label}: must not invoke hidden grader`);
    } finally {
      for (const entry of readdirSync(tmpdir())) {
        if (entry.startsWith(copyPrefix) && !beforeNames.has(entry)) rmSync(join(tmpdir(), entry), { recursive: true, force: true });
      }
      assert.equal(prodCopyTempCount(), copyBefore, `${label}: test cleanup must leave zero extra paused copies`);
      s.cleanup();
    }
  }
});
