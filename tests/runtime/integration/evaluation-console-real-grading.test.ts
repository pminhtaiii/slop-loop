/**
 * Feature 007 T017 (#271) integration tests:
 * Real-mode console grading through the registered workflow-evidence path with
 * controlled fetch (`.invalid` endpoint host), spawn, and grader doubles.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { BugTask } from '../../../src/contracts/foundation/uc03.ts';
import type { StructuredSpawn } from '../../../src/foundation/docker-controller.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import type { WorkflowEvaluationReport } from '../../../eval/uc03/types.ts';
import { createEvaluationConsoleHost, type EvaluationConsoleAssembly } from '../../../src/runtime/evaluation-console-host.ts';
import { createRealTierReportEvidenceHost } from '../../../src/runtime/evaluation-graph-report.ts';
import type { EvaluationCaseBinding, UC03EvaluationGraphRoute } from '../../../src/runtime/evaluation-graph.ts';
import type { ConsoleApprovalPort } from '../../../src/runtime/console-server.ts';
import { admitRealTierConsole, realTierHostDigestsOf } from '../../../src/runtime/real-tier-console-admission.ts';
import { createHostAssembly, resolveRealTierAssembly, type RealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import type { GraderCapability } from '../../../src/runtime/real-tier-case-grade.ts';
import { createRealTierGraderCapability } from '../../../src/runtime/real-tier-grader.ts';
import { loadRealTierProfile, type RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { REAL_TIER_DELIVERY_CONTRACT } from '../../../src/runtime/real-tier-owners.ts';
import { bindRealTierTask } from '../../../src/runtime/real-tier-task-binding.ts';
import { prepareUC03Host } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { createVolumeSpawn } from '../support/docker-volume-spawn.ts';

const REV = 'a'.repeat(40);
const MODEL = 'cmc/deepseek/deepseek-v4.1-flash';
const RETURNED_MODEL = 'deepseek-v4.1-flash';
const ENDPOINT_HOST = 'provider.invalid';
const ENDPOINT_HREF = `https://${ENDPOINT_HOST}/v1/messages`;
const API_KEY_SENTINEL = 'sentinel-real-console-key-01234567';
const GRADER_FILE = 'test_private_console_grader_oracle.py';
const GRADER_SECRET = 'GRADER_PRIVATE_CONSOLE_ORACLE_54321';
const OPERATOR_TOKEN = 'real-console-operator-token-012345';

const INITIAL_CALC_PY = ['class CalculationError(Exception):', '    pass', '', 'def divide(a, b):', '    return a / b', ''].join('\n');
const TEST_CALC_PY = [
  'from src.calculator import CalculationError, divide',
  '',
  'def test_div_zero():',
  '    try:',
  '        divide(10, 0)',
  '        assert False',
  '    except CalculationError:',
  '        pass',
  '',
].join('\n');
const PATCH_DIFF = [
  '--- a/src/calculator.py',
  '+++ b/src/calculator.py',
  '@@ -2,4 +2,6 @@',
  '     pass',
  ' ',
  ' def divide(a, b):',
  '+    if b == 0:',
  '+        raise CalculationError("division by zero")',
  '     return a / b',
  '',
].join('\n');

const GRADER_PROFILE = {
  profileId: 't017-grader-profile',
  digest: `sha256:${sha256Text('t017-grader-profile')}`,
  bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 8 },
};

const GRADER_CRITERIA = {
  digest: `sha256:${sha256Text('t017-criteria')}`,
  criteria: [{ criterionId: 'crit-c01', caseId: 'C01', predicate: 'repair-success', hiddenCheckId: 'hidden-C01' }],
};

interface FetchRecord {
  readonly role: string;
  readonly purpose: string;
  readonly bodyText: string;
}

function makeTask(tag: string, initialRevisionDigest: string): BugTask {
  return {
    taskId: `c-${tag}`,
    repositoryId: `r-${tag}`,
    initialRevisionDigest,
    goal: 'Handle division by zero cleanly',
    observedBehavior: 'ZeroDivisionError on zero divisor',
    expectedBehavior: 'Raise CalculationError when divisor is zero',
    reproduction: 'pytest -q tests/test_calculator.py',
    acceptanceCriteria: ['Raises CalculationError on zero divisor'],
    constraints: ['Do not edit test files'],
    requiredChecks: [
      {
        checkId: 'check-1',
        executable: 'pytest',
        argv: ['-q', 'tests/test_calculator.py'],
        purpose: 'reproduction',
        workingDirectory: '/workspace/repo',
        timeoutMs: 2_000,
        maxOutputBytes: 65_536,
      },
    ],
    limits: { timeoutMs: 2_000, maxOutputBytes: 65_536, maxCpuCores: 1, maxMemoryBytes: 536_870_912, maxPids: 64 },
    budgetLimits: { maxReplanCount: 3, maxTokens: 200_000, maxCostUsd: 2, maxRepairAttempts: 2, maxReviewIterations: 2 },
    configId: 'config-v1',
    configVersion: '1.0.0',
  };
}

function createFetchDouble() {
  const requests: FetchRecord[] = [];
  let seq = 0;

  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const parsedBody = JSON.parse(bodyText) as { messages?: { content?: string }[] };
    const prompt = JSON.parse(parsedBody.messages?.[0]?.content ?? '{}') as {
      task?: { evidenceRefs?: readonly string[]; plan?: { decisionRef?: string } };
      request?: { role?: string; purpose?: string };
      untrustedEvidence?: readonly unknown[];
    };
    const role = prompt.request?.role ?? 'unknown';
    const purpose = prompt.request?.purpose ?? 'unknown';
    requests.push({ role, purpose, bodyText });

    let replyObj: unknown;
    if (role === 'reviewer') {
      replyObj = { status: 'accepted', findings: [] };
    } else if (purpose === 'propose-plan' || purpose === 'propose-replan') {
      const hasEvidence = (prompt.task?.evidenceRefs?.length ?? 0) > 0 || (prompt.untrustedEvidence?.length ?? 0) > 0;
      replyObj = hasEvidence
        ? {
            kind: 'propose-plan',
            proposalId: `plan-${++seq}`,
            diagnosis: 'divide() does not guard b == 0 before dividing.',
            strategy: 'Guard b == 0 in divide() and raise CalculationError.',
            suspectedLocations: ['src/calculator.py'],
            scopedPaths: ['src/calculator.py'],
            evidenceRefs: ['src/calculator.py'],
          }
        : { kind: 'inspect', proposalId: `insp-${++seq}`, operation: 'read_file', args: { path: 'src/calculator.py' } };
    } else {
      replyObj = {
        kind: 'propose-patch',
        proposalId: `patch-${++seq}`,
        diff: PATCH_DIFF,
        targetPaths: ['src/calculator.py'],
        approvedPlanRef: prompt.task?.plan?.decisionRef ?? '',
      };
    }

    return new Response(
      JSON.stringify({
        id: `msg_${++seq}`,
        type: 'message',
        role: 'assistant',
        model: RETURNED_MODEL,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(replyObj) }],
        usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 0 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  return { fetch: fakeFetch, requests };
}

function createCombinedSpawn(hiddenOutcome: 'from-snapshot' | 'fail' = 'from-snapshot') {
  const volumeSub = createVolumeSpawn();
  const hiddenChecks: { readonly args: readonly string[] }[] = [];

  const spawn: StructuredSpawn = async (command, args, options) => {
    if (command !== 'docker') return { exitCode: 1, stdout: '', stderr: 'unexpected command', timedOut: false };
    if (args[0] === 'version') return { exitCode: 0, stdout: '27.3.1\n', stderr: '', timedOut: false };
    if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: `${args[4]}\n`, stderr: '', timedOut: false };
    if (args[0] === 'volume' || args[0] === 'rm' || args[0] === 'kill') return volumeSub.spawn(command, args, options);

    if (args[0] === 'run' && args.some(a => a.includes('target=/grader'))) {
      hiddenChecks.push({ args: [...args] });
      if (hiddenOutcome === 'fail') {
        return { exitCode: 1, stdout: '1 hidden failed\n', stderr: '', timedOut: false };
      }
      const repoMount = args.find(a => a.includes('target=/workspace/repo'));
      const snapDir = repoMount?.match(/source=([^,]+)/u)?.[1];
      const calcPath = snapDir ? join(snapDir, 'src', 'calculator.py') : '';
      const fixed = snapDir !== undefined && calcPath !== '' && existsSync(calcPath) ? await new WorkspaceFilesystemPort({ root: snapDir }).readTextFile('src/calculator.py', 65_536) : '';
      return fixed.includes('raise CalculationError')
        ? { exitCode: 0, stdout: '1 hidden passed\n', stderr: '', timedOut: false }
        : { exitCode: 1, stdout: '1 hidden failed\n', stderr: '', timedOut: false };
    }

    if (args[0] === 'run' && args.some(a => a.includes('target=/workspace/scratch'))) {
      const repoMount = args.find(a => a.includes('target=/workspace/repo'));
      const source = repoMount?.match(/source=([^,]+)/u)?.[1];
      const vol = source ? volumeSub.volumes.get(source) : undefined;
      const calcText = vol?.get('src/calculator.py')?.toString('utf8') ?? '';
      return calcText.includes('raise CalculationError') ? { exitCode: 0, stdout: '1 passed\n', stderr: '', timedOut: false } : { exitCode: 1, stdout: '1 failed\n', stderr: '', timedOut: false };
    }

    return volumeSub.spawn(command, args, options);
  };

  return { spawn, hiddenChecks };
}

function hostImageUser(): string {
  if (typeof process.getuid !== 'function') return '1000:1000';
  const uid = process.getuid();
  if (uid === 0) return '1000:1000';
  const gid = typeof process.getgid === 'function' ? process.getgid() : uid;
  return `${uid}:${gid > 0 ? gid : uid}`;
}

interface BoundExperimentContext {
  readonly caseId: string;
  readonly task: BugTask;
  readonly assembly: RealTierAssembly;
  readonly approvalConsole: ConsoleApprovalPort;
  controlVersion: number;
}

async function setupRealConsoleScenario(opts: {
  readonly tag: string;
  readonly hiddenOutcome?: 'from-snapshot' | 'fail';
  readonly corruptC01GraderAfterStart?: boolean;
  readonly refuseIsolation?: boolean;
}) {
  const outside = mkdtempSync(join(tmpdir(), `t017-outside-${opts.tag}-`));
  const stateRootBase = join(outside, 'state');
  const retainRoot = join(outside, 'artifacts');
  mkdirSync(stateRootBase, { recursive: true });
  mkdirSync(retainRoot, { recursive: true });

  const createRepo = async (caseId: string) => {
    const repoDir = join(outside, `repo-${caseId}`);
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    mkdirSync(join(repoDir, 'tests'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'calculator.py'), INITIAL_CALC_PY, 'utf8');
    writeFileSync(join(repoDir, 'tests', 'test_calculator.py'), TEST_CALC_PY, 'utf8');
    const initialDigest = await new WorkspaceFilesystemPort({ root: repoDir }).getCurrentRevisionDigest();
    const task = makeTask(`${opts.tag}-${caseId}`, initialDigest);
    const fixtureDoc = JSON.stringify({ task, repositoryRoot: `repo-${caseId}` });
    const fixturePath = join(outside, `fixture-${caseId}.json`);
    writeFileSync(fixturePath, fixtureDoc, 'utf8');
    return { caseId, task, initialDigest, fixturePath, fixtureDigest: sha256Text(fixtureDoc) };
  };

  const c01 = await createRepo('C01');
  const c03 = await createRepo('C03');

  const c01GraderPath = join(outside, 'grader-c01.json');
  const c01GraderDoc = JSON.stringify({
    criteria: GRADER_CRITERIA,
    profile: GRADER_PROFILE,
    graderPayload: {
      files: { [GRADER_FILE]: `def test_hidden_oracle():\n    # ${GRADER_SECRET}\n    pass\n` },
      argv: ['pytest', '-q', `/grader/${GRADER_FILE}`],
    },
  });
  writeFileSync(c01GraderPath, c01GraderDoc, 'utf8');
  const c01GraderDigest = sha256Text(c01GraderDoc);

  const c03GraderPath = join(outside, 'grader-c03.json');
  const c03GraderDoc = JSON.stringify({ criteria: GRADER_CRITERIA, profile: GRADER_PROFILE, graderPayload: null });
  writeFileSync(c03GraderPath, c03GraderDoc, 'utf8');
  const c03GraderDigest = sha256Text(c03GraderDoc);

  const catalogPath = join(outside, 'catalog.json');
  writeFileSync(
    catalogPath,
    JSON.stringify({
      catalog: [
        {
          caseId: 'C01',
          initialRepositoryDigest: c01.initialDigest.replace(/^sha256:/u, ''),
          fixturePath: c01.fixturePath,
          fixtureDigest: c01.fixtureDigest,
          grader: { path: c01GraderPath, digest: `sha256:${c01GraderDigest}` },
        },
        {
          caseId: 'C03',
          initialRepositoryDigest: c03.initialDigest.replace(/^sha256:/u, ''),
          fixturePath: c03.fixturePath,
          fixtureDigest: c03.fixtureDigest,
          grader: { path: c03GraderPath, digest: `sha256:${c03GraderDigest}` },
        },
      ],
    }),
    'utf8',
  );

  const digestKey = '0123456789abcdef'.repeat(4);
  const pricing = { pricingId: 'placeholder-unverified', denominator: 1000000, inputRate: 2000000, cacheRate: 2000000, outputRate: 8000000, overheadRate: 0 };
  const limits = {
    totalModelCalls: 24,
    inputTokensPerRequest: 32768,
    outputTokensPerRequest: 8192,
    providerTimeoutMs: 60000,
    activeExecutionMs: 900000,
    repairs: 2,
    reviewerIterations: 2,
    materialReplans: 3,
    commandTimeoutMs: 60000,
    outputBytes: 1048576,
    memoryBytes: 1073741824,
    cpus: 1,
    processes: 128,
  };
  const image = {
    label: 'uc03-pytest:real-tier',
    imageId: `sha256:${sha256Text('image')}`,
    base: `python:3.12-alpine@sha256:${sha256Text('base')}`,
    platform: 'linux/amd64',
    user: hostImageUser(),
  };

  const profilePath = join(outside, 'profile.json');
  writeFileSync(
    profilePath,
    JSON.stringify({
      schema: 'uc03-real-tier-profile/1',
      campaignId: `uc03-console-real-${opts.tag}`,
      stateRoot: stateRootBase,
      provider: {
        endpoint: ENDPOINT_HREF,
        allowInsecureHttp: false,
        model: MODEL,
        mode: 'nonstreaming',
        timeoutMs: 60000,
        endpointDigestKey: digestKey,
      },
      pricing,
      runLimits: { perRunInputTokens: 400000, perRunOutputTokens: 80000 },
      limits,
      image,
      catalog: { path: catalogPath },
      artifacts: { retainRoot, retainRawStreams: false },
      approvalPolicy: { profileVersion: 'real-tier-2026-11-14' },
    }),
    'utf8',
  );

  const env: RealTierEnvironment = { UC03_REAL_TIER_PROFILE: profilePath, ANTHROPIC_API_KEY: API_KEY_SENTINEL };
  const loadedProfile = loadRealTierProfile(env);
  assert.ok(loadedProfile.ok, loadedProfile.ok ? '' : loadedProfile.reasonCode);

  const digests = realTierHostDigestsOf(loadedProfile.value);
  const configuration = {
    identity: {
      profileId: digests.profileId,
      profileDigest: digests.profileDigest,
      configDigest: digests.configDigest,
      pricingDigest: digests.pricingDigest,
    },
    profileDigest: digests.profileDigest,
    configDigest: digests.configDigest,
    pricingDigest: digests.pricingDigest,
    requestedModel: digests.requestedModel,
    adapterVersions: digests.adapterVersions,
  };
  const admitted = admitRealTierConsole({ profile: loadedProfile.value, configuration });
  assert.ok(admitted.ok, admitted.ok ? '' : admitted.reasonCode);

  const fetchSpy = createFetchDouble();
  const spawnSpy = createCombinedSpawn(opts.hiddenOutcome ?? 'from-snapshot');

  const startupHosted = createHostAssembly({
    env,
    stateRoot: join(stateRootBase, 'startup'),
    revision: REV,
    fetch: fetchSpy.fetch,
    spawn: spawnSpy.spawn,
  });
  assert.ok(!('status' in startupHosted), 'Startup assembly failed');
  if ('status' in startupHosted) throw new Error('Startup assembly failed');
  const startupResolution = startupHosted.assembly;

  const pins = {
    contractVersion: REAL_TIER_DELIVERY_CONTRACT,
    revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(c => [c, REV])),
  };
  const startupReadiness = prepareUC03Host({
    ...startupHosted.host,
    pins,
    identity: configuration.identity,
  });
  assert.equal(startupReadiness.status, 'ready');
  if (startupReadiness.status !== 'ready') throw new Error('Startup readiness failed');

  const baseCapability = createRealTierGraderCapability({ spawn: spawnSpy.spawn });
  const capabilityForCase = (): GraderCapability =>
    opts.refuseIsolation
      ? {
          tier: baseCapability.tier,
          isolationAuthority: { admit: () => undefined },
          executor: baseCapability.executor,
          finalTree: baseCapability.finalTree,
          bindCase: casePins => baseCapability.bindCase?.(casePins),
        }
      : baseCapability;

  let bindCalls = 0;
  let seq = 0;
  const boundExperiments = new Map<string, BoundExperimentContext>();
  const cleanupDirs: string[] = [outside];

  const assembly: EvaluationConsoleAssembly = {
    profile: admitted.value.profile,
    catalog: admitted.value.catalog,
    repositoryIds: [c01.task.repositoryId, c03.task.repositoryId],
    checkSetIds: ['checks-configured'],
    control: {
      issue: async input => {
        const ctx = boundExperiments.get(input.experimentId);
        assert.ok(ctx, `control.issue requires bound experiment ${input.experimentId}`);
        return {
          receiptRef: `real-console-ctrl-${++seq}`,
          kind: input.kind,
          taskId: ctx.task.taskId,
          controlVersion: input.expectedControlVersion + 1,
        };
      },
    },
    approval: {
      presentation: async experimentId => {
        const ctx = boundExperiments.get(experimentId);
        if (!ctx) return { ok: false, status: 'not-found', reasonCode: 'UNKNOWN_EXPERIMENT' };
        return ctx.approvalConsole.presentation(experimentId);
      },
      decide: async input => {
        const expId = (input as { readonly experimentId?: unknown }).experimentId;
        const ctx = typeof expId === 'string' ? boundExperiments.get(expId) : undefined;
        if (!ctx) return { ok: false, status: 'not-found', reasonCode: 'UNKNOWN_EXPERIMENT' };
        return ctx.approvalConsole.decide(input);
      },
    },
    routesFor: (readiness, catalog) => {
      assert.equal(readiness.status, 'ready');
      const routes = new Map<string, UC03EvaluationGraphRoute>();
      for (const entry of catalog) {
        const taskFixture = entry.caseId === 'C01' ? c01.task : c03.task;
        routes.set(entry.caseId, {
          entry,
          readiness,
          coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
          expectedWait: null,
          workflowReport: {
            profileDigest: admitted.value.profile.profileDigest,
            configDigest: admitted.value.profile.configDigest,
            pricingDigest: admitted.value.profile.pricingDigest,
            adapterVersions: admitted.value.profile.adapterVersions,
            requestedModel: admitted.value.profile.model,
            workflowEvidence: createRealTierReportEvidenceHost({
              assembly: startupResolution,
              caseId: entry.caseId,
              graderCapability: capabilityForCase(),
            }),
          },
          resolveTask: () => taskFixture,
          bindCase: async ({ experimentId }): Promise<EvaluationCaseBinding> => {
            bindCalls += 1;
            const caseStateRoot = join(stateRootBase, `run-${++seq}-${entry.caseId}`);
            const workingCopyRoot = mkdtempSync(join(outside, `copy-${seq}-`));
            cleanupDirs.push(workingCopyRoot);
            const resolved = resolveRealTierAssembly({
              env,
              stateRoot: caseStateRoot,
              revision: REV,
              fetch: fetchSpy.fetch,
              spawn: spawnSpy.spawn,
            });
            if (resolved.status !== 'assembly-ready') return { ok: false, reasonCode: resolved.reasonCode };
            const bound = await bindRealTierTask(resolved, {
              caseId: entry.caseId,
              pins,
              identity: configuration.identity,
              workingCopyRoot,
              retainedRoot: retainRoot,
            });
            if (bound.status !== 'task-bound') return { ok: false, reasonCode: bound.reasonCode };
            const owners = resolved.owners.taskOwners({
              taskId: bound.ids.taskId,
              workspaceId: bound.ids.workspaceId,
              repositoryId: bound.task.repositoryId,
            });
            boundExperiments.set(experimentId, {
              caseId: entry.caseId,
              task: bound.task,
              assembly: resolved,
              approvalConsole: owners.console,
              controlVersion: 0,
            });
            if (opts.corruptC01GraderAfterStart && entry.caseId === 'C01') {
              writeFileSync(c01GraderPath, JSON.stringify({ corrupted: true }), 'utf8');
            }
            return {
              ok: true,
              task: bound.task,
              ports: bound.ports,
              config: bound.config,
              workflowEvidence: createRealTierReportEvidenceHost({
                assembly: resolved,
                caseId: entry.caseId,
                task: bound.task,
                repositoryRoot: bound.repositoryRoot,
                graderCapability: capabilityForCase(),
              }),
            };
          },
          resolveDirection: () => undefined,
        });
      }
      return routes;
    },
    operatorToken: () => OPERATOR_TOKEN,
  };

  const started = await createEvaluationConsoleHost(startupReadiness, configuration, () => assembly);
  assert.equal(started.ok, true);
  if (!started.ok) throw new Error('Console host startup failed');

  const origin = `http://${started.host.address.host}:${started.host.address.port}`;
  const headers = { 'content-type': 'application/json', origin, 'x-operator-token': OPERATOR_TOKEN };

  const jsonFetch = async <T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<{ status: number; json: T; raw: string }> => {
    const response = await fetch(`${origin}${path}`, {
      method,
      ...(method === 'POST' ? { headers } : {}),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    return { status: response.status, json: JSON.parse(raw) as T, raw };
  };

  const cleanup = async () => {
    await started.host.close();
    for (const dir of cleanupDirs.reverse()) {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  return {
    host: started.host,
    origin,
    profileId: admitted.value.profile.profileId,
    c01GraderDigest,
    c01GraderPath,
    c03GraderPath,
    boundExperiments,
    fetchSpy,
    spawnSpy,
    getBindCalls: () => bindCalls,
    jsonFetch,
    cleanup,
  };
}

function assertNoPrivateMaterial(text: string, c01GraderPath: string, c03GraderPath: string): void {
  assert.equal(text.includes(ENDPOINT_HREF), false, 'endpoint URL must never leak');
  assert.equal(text.includes(ENDPOINT_HOST), false, 'endpoint host must never leak');
  assert.equal(text.includes(API_KEY_SENTINEL), false, 'credential must never leak');
  assert.equal(text.includes(GRADER_SECRET), false, 'grader secret must never leak');
  assert.equal(text.includes(GRADER_FILE), false, 'grader filename must never leak');
  assert.equal(text.includes(c01GraderPath), false, 'c01 grader path must never leak');
  assert.equal(text.includes(c03GraderPath), false, 'c03 grader path must never leak');
}

interface ExperimentHttpPayload {
  readonly ok: boolean;
  readonly result: {
    readonly experiment: {
      readonly id: string;
      readonly version: number;
      readonly status: string;
      readonly taskId: string | null;
      readonly workflowReport: WorkflowEvaluationReport | null;
    };
  };
}

interface ApprovalViewPayload {
  readonly ok: boolean;
  readonly result: {
    readonly taskId: string;
    readonly presentation: {
      readonly decisionId: string;
      readonly requestVersion: number;
      readonly presentationDigest: string;
    };
  };
}

async function driveApprovalStep(
  scenario: Awaited<ReturnType<typeof setupRealConsoleScenario>>,
  experiment: ExperimentHttpPayload['result']['experiment'],
  stepTag: string,
): Promise<ExperimentHttpPayload['result']['experiment']> {
  const pres = await scenario.jsonFetch<ApprovalViewPayload>(`/api/experiments/${experiment.id}/approval`, 'GET');
  assert.equal(pres.status, 200, pres.raw);
  assert.equal(pres.json.ok, true);

  const decided = await scenario.jsonFetch<{ ok: boolean }>(`/api/experiments/${experiment.id}/decision`, 'POST', {
    idempotencyKey: `decide-${stepTag}`,
    presentationDigest: pres.json.result.presentation.presentationDigest,
    expectedVersion: pres.json.result.presentation.requestVersion,
    decision: 'approve',
  });
  assert.equal(decided.status, 200, decided.raw);
  assert.equal(decided.json.ok, true);

  const ctx = scenario.boundExperiments.get(experiment.id);
  assert.ok(ctx, `missing bound context for ${experiment.id}`);
  const ownerState = await ctx.assembly.components.statePort.loadTask(ctx.task.taskId);
  assert.ok(ownerState, `missing owner state for ${ctx.task.taskId}`);

  const dir = await scenario.jsonFetch<{ ok: boolean; result: { receipt: { receiptRef: string; controlVersion: number }; experiment: { version: number } } }>(
    `/api/experiments/${experiment.id}/directions`,
    'POST',
    {
      kind: 'resume',
      expectedTaskVersion: ownerState.stateVersion,
      expectedControlVersion: ctx.controlVersion,
      idempotencyKey: `dir-${stepTag}`,
    },
  );
  assert.equal(dir.status, 200, dir.raw);
  assert.equal(dir.json.ok, true);
  ctx.controlVersion = dir.json.result.receipt.controlVersion;

  const cont = await scenario.jsonFetch<ExperimentHttpPayload>(`/api/experiments/${experiment.id}/continue`, 'POST', {
    expectedVersion: dir.json.result.experiment.version,
    directionRef: dir.json.result.receipt.receiptRef,
    idempotencyKey: `cont-${stepTag}`,
  });
  assert.equal(cont.status, 200, cont.raw);
  assert.equal(cont.json.ok, true);
  return cont.json.result.experiment;
}

async function runC01ToCompletion(scenario: Awaited<ReturnType<typeof setupRealConsoleScenario>>, tag: string): Promise<ExperimentHttpPayload['result']['experiment']> {
  const started = await scenario.jsonFetch<ExperimentHttpPayload>('/api/experiments', 'POST', {
    profileId: scenario.profileId,
    idempotencyKey: `start-${tag}`,
    source: { kind: 'catalog', caseIds: ['C01'] },
  });
  assert.equal(started.status, 200, started.raw);
  assert.equal(started.json.ok, true);
  const pausedPlan = started.json.result.experiment;
  assert.equal(pausedPlan.status, 'waiting-approval');
  assert.equal(pausedPlan.workflowReport?.mode, 'real');
  assert.equal(pausedPlan.workflowReport?.tier, 'real-integration');
  assert.equal(pausedPlan.workflowReport?.cases[0]?.grade, 'not-run');
  assert.equal(pausedPlan.workflowReport?.cases[0]?.gradeReason, 'unresolved-wait');
  assert.equal(scenario.spawnSpy.hiddenChecks.length, 0, 'paused plan step must not invoke hidden grader');

  const pausedVerify = await driveApprovalStep(scenario, pausedPlan, `${tag}-plan`);
  assert.equal(pausedVerify.status, 'waiting-approval');
  assert.equal(pausedVerify.workflowReport?.mode, 'real');
  assert.equal(pausedVerify.workflowReport?.cases[0]?.grade, 'not-run');
  assert.equal(pausedVerify.workflowReport?.cases[0]?.gradeReason, 'unresolved-wait');
  assert.equal(scenario.spawnSpy.hiddenChecks.length, 0, 'paused verification step must not invoke hidden grader');

  const completed = await driveApprovalStep(scenario, pausedVerify, `${tag}-verify`);
  assert.equal(completed.status, 'completed');
  return completed;
}

test('real console route records a real-labelled pass via registered workflow evidence and keeps grader material host-private', async () => {
  const s = await setupRealConsoleScenario({ tag: 'pass' });
  try {
    assert.equal(s.getBindCalls(), 0, 'console startup must not bind cases before an experiment starts');

    const completed = await runC01ToCompletion(s, 'pass');
    const report = completed.workflowReport;
    assert.ok(report, 'real route must emit a workflow report');
    assert.equal(report.mode, 'real');
    assert.equal(report.tier, 'real-integration');
    assert.equal(report.cases.length, 1);

    const row = report.cases[0];
    assert.ok(row);
    assert.equal(row.caseId, 'C01');
    assert.equal(row.tier, 'real-integration');
    assert.equal(row.workflowOutcome, 'COMPLETED');
    assert.equal(row.grade, 'pass');
    assert.equal(row.gradeReason, 'criteria-satisfied');
    assert.equal(row.returnedModel, RETURNED_MODEL);
    assert.equal(row.graderDigest, s.c01GraderDigest);
    assert.equal(s.spawnSpy.hiddenChecks.length, 1);
    assert.equal(s.getBindCalls(), 1);

    const fetched = await s.jsonFetch<{ readonly ok: boolean; readonly result: ExperimentHttpPayload['result']['experiment'] }>(`/api/experiments/${completed.id}`, 'GET');
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json.result.workflowReport?.mode, 'real');
    assert.equal(fetched.json.result.workflowReport?.cases[0]?.grade, 'pass');
    assertNoPrivateMaterial(fetched.raw, s.c01GraderPath, s.c03GraderPath);

    const pageRes = await fetch(`${s.origin}/`);
    assert.equal(pageRes.status, 200);
    const pageHtml = await pageRes.text();
    assertNoPrivateMaterial(pageHtml, s.c01GraderPath, s.c03GraderPath);

    assert.ok(s.fetchSpy.requests.length >= 4);
    for (const req of s.fetchSpy.requests) {
      assertNoPrivateMaterial(req.bodyText, s.c01GraderPath, s.c03GraderPath);
    }
  } finally {
    await s.cleanup();
  }
});

test('real console route records a real-labelled fail when workflow completes but the pinned hidden grader fails', async () => {
  const s = await setupRealConsoleScenario({ tag: 'fail', hiddenOutcome: 'fail' });
  try {
    const completed = await runC01ToCompletion(s, 'fail');
    const report = completed.workflowReport;
    assert.ok(report);
    assert.equal(report.mode, 'real');
    assert.equal(report.tier, 'real-integration');

    const row = report.cases[0];
    assert.ok(row);
    assert.equal(row.caseId, 'C01');
    assert.equal(row.workflowOutcome, 'COMPLETED');
    assert.equal(row.grade, 'fail');
    assert.equal(row.gradeReason, 'criteria-violation');
    assert.equal(s.spawnSpy.hiddenChecks.length, 1);
    assertNoPrivateMaterial(JSON.stringify(report), s.c01GraderPath, s.c03GraderPath);
  } finally {
    await s.cleanup();
  }
});

test('real console route records not-run for an unpinned case and for grader or isolation refusals', async () => {
  const unpinned = await setupRealConsoleScenario({ tag: 'unpinned' });
  try {
    const started = await unpinned.jsonFetch<ExperimentHttpPayload>('/api/experiments', 'POST', {
      profileId: unpinned.profileId,
      idempotencyKey: 'start-c03-unpinned',
      source: { kind: 'catalog', caseIds: ['C03'] },
    });
    assert.equal(started.status, 200, started.raw);
    assert.equal(started.json.result.experiment.status, 'waiting-approval', started.raw);
    const pausedVerify = await driveApprovalStep(unpinned, started.json.result.experiment, 'c03-plan');
    const completed = await driveApprovalStep(unpinned, pausedVerify, 'c03-verify');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.workflowReport?.mode, 'real');
    assert.equal(completed.workflowReport?.tier, 'real-integration');
    assert.equal(completed.workflowReport?.cases[0]?.caseId, 'C03');
    assert.equal(completed.workflowReport?.cases[0]?.workflowOutcome, 'COMPLETED');
    assert.equal(completed.workflowReport?.cases[0]?.grade, 'not-run');
    assert.equal(completed.workflowReport?.cases[0]?.gradeReason, 'unpinned-criteria');
    assert.equal(unpinned.spawnSpy.hiddenChecks.length, 0);
    assertNoPrivateMaterial(JSON.stringify(completed.workflowReport), unpinned.c01GraderPath, unpinned.c03GraderPath);
  } finally {
    await unpinned.cleanup();
  }

  const malformedGrader = await setupRealConsoleScenario({ tag: 'bad-grader', corruptC01GraderAfterStart: true });
  try {
    const completed = await runC01ToCompletion(malformedGrader, 'bad-grader');
    assert.equal(completed.workflowReport?.mode, 'real');
    assert.equal(completed.workflowReport?.tier, 'real-integration');
    assert.equal(completed.workflowReport?.cases[0]?.workflowOutcome, 'COMPLETED');
    assert.equal(completed.workflowReport?.cases[0]?.grade, 'not-run');
    assert.equal(completed.workflowReport?.cases[0]?.gradeReason, 'private-grading');
    assert.equal(malformedGrader.spawnSpy.hiddenChecks.length, 0);
    assertNoPrivateMaterial(JSON.stringify(completed.workflowReport), malformedGrader.c01GraderPath, malformedGrader.c03GraderPath);
  } finally {
    await malformedGrader.cleanup();
  }

  const refusedIsolation = await setupRealConsoleScenario({ tag: 'refuse-iso', refuseIsolation: true });
  try {
    const completed = await runC01ToCompletion(refusedIsolation, 'refuse-iso');
    assert.equal(completed.workflowReport?.mode, 'real');
    assert.equal(completed.workflowReport?.tier, 'real-integration');
    assert.equal(completed.workflowReport?.cases[0]?.workflowOutcome, 'COMPLETED');
    assert.equal(completed.workflowReport?.cases[0]?.grade, 'not-run');
    assert.equal(completed.workflowReport?.cases[0]?.gradeReason, 'private-grading');
    assert.equal(refusedIsolation.spawnSpy.hiddenChecks.length, 0);
    assertNoPrivateMaterial(JSON.stringify(completed.workflowReport), refusedIsolation.c01GraderPath, refusedIsolation.c03GraderPath);
  } finally {
    await refusedIsolation.cleanup();
  }
});
