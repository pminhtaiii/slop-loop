/**
 * Feature 007 T017 (#267) integration tests:
 * End-to-end `runEvaluateCli(['serve', '--host', <real host file>])` over `real-tier-assembly.ts`
 * and `real-tier-console.ts` with controlled `fetch`, `spawn`, and `Date` clock doubles.
 * Zero live model calls and zero real Docker executions.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runEvaluateCli } from '../../../src/cli/evaluate.ts';
import type { BugTask } from '../../../src/contracts/foundation/uc03.ts';
import type { StructuredSpawn } from '../../../src/foundation/docker-controller.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import { createHostAssembly, resolveRealTierAssembly, type RealTierDependencies } from '../../../src/runtime/real-tier-assembly.ts';
import { createRealTierConsoleFactory, REAL_CONSOLE_TOKEN_ENV } from '../../../src/runtime/real-tier-console.ts';
import { admitRealTierConsole, realTierHostDigestsOf } from '../../../src/runtime/real-tier-console-admission.ts';
import { REAL_TIER_DELIVERY_CONTRACT } from '../../../src/runtime/real-tier-owners.ts';
import { loadRealTierProfile, type RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { createVolumeSpawn } from '../support/docker-volume-spawn.ts';

const HOOK_KEY = '__uc03RealConsoleTestHook';
const REV = 'a'.repeat(40);
const MODEL = 'cmc/deepseek/deepseek-v4.1-flash';
const RETURNED_MODEL = 'deepseek-v4.1-flash';
const ENDPOINT_HOST = 'provider.invalid';
const ENDPOINT_HREF = `https://${ENDPOINT_HOST}/v1/messages`;
const API_KEY_SENTINEL = 'sentinel-real-console-key-01234567';
const GRADER_FILE = 'test_private_real_serve_oracle.py';
const GRADER_SECRET = 'GRADER_PRIVATE_REAL_SERVE_ORACLE_98765';
const FIXED_NOW_MS = Date.UTC(2026, 10, 26, 12, 0, 0);

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
  profileId: 't017-real-console-profile',
  digest: `sha256:${sha256Text('t017-real-console-profile')}`,
  bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 8 },
};

const C01_CRITERIA = {
  digest: `sha256:${sha256Text('t017-real-console-c01-criteria')}`,
  criteria: [{ criterionId: 'crit-c01', caseId: 'C01', predicate: 'repair-success', hiddenCheckId: 'hidden-C01' }],
};

const C02_CRITERIA = {
  digest: `sha256:${sha256Text('t017-real-console-c02-criteria')}`,
  criteria: [{ criterionId: 'crit-c02', caseId: 'C02', predicate: 'clarification', hiddenCheckId: null }],
};

type ConsoleEnvelope<T> = Readonly<{ ok: true; result: T }> | Readonly<{ ok: false; error: string }>;

interface ExperimentViewShape {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly scope: string;
  readonly graded: boolean;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly workspaceId: string | null;
  readonly workflowClarification: {
    readonly questionId: string;
    readonly questionDigest: string;
    readonly questions: readonly { readonly questionId: string; readonly text: string }[];
  } | null;
  readonly answers: readonly unknown[];
  readonly control?: { readonly taskVersion: number; readonly controlVersion: number } | null | undefined;
  readonly workflowReport: {
    readonly mode: string;
    readonly tier: string;
    readonly isRealVerified: boolean;
    readonly cases: readonly {
      readonly caseId: string;
      readonly workflowOutcome: string;
      readonly grade: string;
      readonly gradeReason: string;
      readonly returnedModel: string | null;
      readonly graderDigest: string | null;
    }[];
  } | null;
}

interface ApprovalPresentationShape {
  readonly taskId: string;
  readonly control: { readonly version: number; readonly mode: string };
  readonly binding: { readonly decisionId: string; readonly actionKind: string; readonly status: string };
  readonly presentation: { readonly requestVersion: number; readonly presentationDigest: string; readonly bindingFingerprint: string };
}

interface DecisionReplyShape {
  readonly outcome: string;
  readonly decisionId: string;
  readonly controlVersion: number;
  readonly requestVersion: number;
}

function resolveRepoRoot(): string {
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(cursor, 'package.json')) && existsSync(join(cursor, 'eval', 'uc03', 'manifest.json'))) return cursor;
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error('Could not locate repository root');
}

function realAssemblyModuleUrl(repoRoot: string): string {
  const isEmitted = fileURLToPath(import.meta.url).endsWith('.js');
  const rel = isEmitted ? join('dist', 'src', 'runtime', 'real-tier-assembly.js') : join('src', 'runtime', 'real-tier-assembly.ts');
  return pathToFileURL(join(repoRoot, rel)).href;
}

function hostImageUser(): string {
  if (typeof process.getuid !== 'function') return '1000:1000';
  const uid = process.getuid();
  if (uid === 0) return '1000:1000';
  const gid = typeof process.getgid === 'function' ? process.getgid() : uid;
  return `${uid}:${gid > 0 ? gid : uid}`;
}

function makeTask(tag: string, initialRevisionDigest: string): BugTask {
  return {
    taskId: `task-${tag}`,
    repositoryId: `repo-${tag}`,
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

function createFetchDouble(mode: 'repair' | 'clarify' = 'repair') {
  const requests: { readonly role: string; readonly purpose: string }[] = [];
  let seq = 0;
  let askedClarification = false;

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
    requests.push({ role, purpose });

    let replyObj: unknown;
    if (role === 'reviewer') {
      replyObj = { status: 'accepted', findings: [] };
    } else if (purpose === 'propose-plan' || purpose === 'propose-replan') {
      const hasEvidence = (prompt.task?.evidenceRefs?.length ?? 0) > 0 || (prompt.untrustedEvidence?.length ?? 0) > 0;
      if (!hasEvidence) {
        replyObj = { kind: 'inspect', proposalId: `insp-${++seq}`, operation: 'read_file', args: { path: 'src/calculator.py' } };
      } else if (mode === 'clarify' && !askedClarification) {
        askedClarification = true;
        replyObj = {
          kind: 'request-info',
          proposalId: `clarify-${++seq}`,
          questions: [{ questionId: 'q-denominator', text: 'Should divide raise CalculationError on zero?' }],
          evidenceRefs: ['src/calculator.py'],
        };
      } else {
        replyObj = {
          kind: 'propose-plan',
          proposalId: `plan-${++seq}`,
          diagnosis: 'divide() does not guard b == 0 before dividing.',
          strategy: 'Guard b == 0 in divide() and raise CalculationError.',
          suspectedLocations: ['src/calculator.py'],
          scopedPaths: ['src/calculator.py'],
          evidenceRefs: ['src/calculator.py'],
        };
      }
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

function createSpawnDouble(options: { versionFail?: boolean; imageFail?: boolean; imageIdOverride?: string } = {}) {
  const volumeSub = createVolumeSpawn();
  const hiddenChecks: { readonly args: readonly string[] }[] = [];
  const state = { versionFail: options.versionFail ?? false, imageFail: options.imageFail ?? false };

  const spawn: StructuredSpawn = async (command, args, spawnOpts) => {
    if (command !== 'docker') return { exitCode: 1, stdout: '', stderr: 'unexpected command', timedOut: false };
    if (args[0] === 'version') {
      return state.versionFail ? { exitCode: 1, stdout: '', stderr: 'daemon unavailable', timedOut: false } : { exitCode: 0, stdout: '27.3.1\n', stderr: '', timedOut: false };
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (state.imageFail) return { exitCode: 1, stdout: '', stderr: 'No such image', timedOut: false };
      return { exitCode: 0, stdout: `${options.imageIdOverride ?? args[4]}\n`, stderr: '', timedOut: false };
    }
    if (args[0] === 'run' && args.some(a => a.includes('target=/grader'))) {
      hiddenChecks.push({ args: [...args] });
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
    return volumeSub.spawn(command, args, spawnOpts);
  };

  return { spawn, hiddenChecks, state };
}

function countConsoleCopies(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter(name => name.startsWith('uc03-real-console-copy-')));
}

function assertNoLeaks(text: string, secrets: readonly (string | undefined)[], label: string): void {
  for (const secret of secrets) {
    if (secret !== undefined && secret !== '') {
      assert.equal(text.includes(secret), false, `${label}: leaked sensitive value`);
    }
  }
}

async function setupServeScenario(opts: {
  readonly tag: string;
  readonly mode?: 'repair' | 'clarify';
  readonly includeC03?: boolean;
  readonly omittApiKey?: boolean;
  readonly unpinnedImage?: boolean;
  readonly spawnOptions?: { versionFail?: boolean; imageFail?: boolean; imageIdOverride?: string };
  readonly extraEnv?: Readonly<Record<string, string>>;
}) {
  const repoRoot = resolveRepoRoot();
  const outside = mkdtempSync(join(tmpdir(), `t017-serve-${opts.tag}-`));
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
  const c02 = await createRepo('C02');
  const c03 = opts.includeC03 ? await createRepo('C03') : undefined;

  const c01GraderPath = join(outside, 'grader-c01.json');
  const c01GraderDoc = JSON.stringify({
    criteria: C01_CRITERIA,
    profile: GRADER_PROFILE,
    graderPayload: { files: { [GRADER_FILE]: `def test_hidden_oracle():\n    # ${GRADER_SECRET}\n    pass\n` }, argv: ['pytest', '-q', `/grader/${GRADER_FILE}`] },
  });
  writeFileSync(c01GraderPath, c01GraderDoc, 'utf8');
  const c01GraderDigest = sha256Text(c01GraderDoc);

  const c02GraderPath = join(outside, 'grader-c02.json');
  const c02GraderDoc = JSON.stringify({ criteria: C02_CRITERIA, profile: GRADER_PROFILE, graderPayload: null });
  writeFileSync(c02GraderPath, c02GraderDoc, 'utf8');
  const c02GraderDigest = sha256Text(c02GraderDoc);

  const catalogEntries = [
    {
      caseId: 'C01',
      initialRepositoryDigest: c01.initialDigest.slice(7),
      fixturePath: c01.fixturePath,
      fixtureDigest: c01.fixtureDigest,
      grader: { path: c01GraderPath, digest: `sha256:${c01GraderDigest}` },
    },
    {
      caseId: 'C02',
      initialRepositoryDigest: c02.initialDigest.slice(7),
      fixturePath: c02.fixturePath,
      fixtureDigest: c02.fixtureDigest,
      grader: { path: c02GraderPath, digest: `sha256:${c02GraderDigest}` },
    },
  ];
  if (c03 !== undefined) {
    catalogEntries.push({
      caseId: 'C03',
      initialRepositoryDigest: c03.initialDigest.slice(7),
      fixturePath: c03.fixturePath,
      fixtureDigest: c03.fixtureDigest,
      grader: { path: c02GraderPath, digest: `sha256:${c02GraderDigest}` },
    });
  }
  const catalogPath = join(outside, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify({ catalog: catalogEntries }), 'utf8');

  const digestKey = sha256Text('uc03 real console serve synthetic digest key');
  const profilePath = join(outside, 'profile.json');
  writeFileSync(
    profilePath,
    JSON.stringify({
      schema: 'uc03-real-tier-profile/1',
      campaignId: `uc03-real-serve-${opts.tag}`,
      stateRoot: stateRootBase,
      provider: { endpoint: ENDPOINT_HREF, allowInsecureHttp: false, model: MODEL, mode: 'nonstreaming', timeoutMs: 60000, endpointDigestKey: digestKey },
      pricing: { pricingId: 'placeholder-unverified', denominator: 1000000, inputRate: 2000000, cacheRate: 2000000, outputRate: 8000000, overheadRate: 0 },
      runLimits: { perRunInputTokens: 400000, perRunOutputTokens: 80000 },
      limits: {
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
      },
      image: {
        label: 'uc03-pytest:real-tier',
        imageId: opts.unpinnedImage ? 'latest' : `sha256:${sha256Text('image')}`,
        base: `python:3.12-alpine@sha256:${sha256Text('base')}`,
        platform: 'linux/amd64',
        user: hostImageUser(),
      },
      catalog: { path: catalogPath },
      artifacts: { retainRoot, retainRawStreams: false },
      approvalPolicy: { profileVersion: 'real-tier-2026-11-14' },
    }),
    'utf8',
  );

  const env: RealTierEnvironment = {
    UC03_REAL_TIER_PROFILE: profilePath,
    ...(opts.omittApiKey ? {} : { ANTHROPIC_API_KEY: API_KEY_SENTINEL }),
    ...(opts.extraEnv ?? {}),
  };

  let digests: ReturnType<typeof realTierHostDigestsOf> = {
    profileId: 'uc03-runtime-evaluation-v1',
    profileDigest: `sha256:${'b'.repeat(64)}`,
    configDigest: `sha256:${'c'.repeat(64)}`,
    pricingDigest: `sha256:${'d'.repeat(64)}`,
    requestedModel: MODEL,
    adapterVersions: ['uc03-real-tier/1'],
  };
  const loadedProfile = loadRealTierProfile(env);
  if (loadedProfile.ok) {
    digests = realTierHostDigestsOf(loadedProfile.value);
    const config = {
      identity: { profileId: digests.profileId, profileDigest: digests.profileDigest, configDigest: digests.configDigest, pricingDigest: digests.pricingDigest },
      profileDigest: digests.profileDigest,
      configDigest: digests.configDigest,
      pricingDigest: digests.pricingDigest,
      requestedModel: digests.requestedModel,
      adapterVersions: digests.adapterVersions,
    };
    admitRealTierConsole({ profile: loadedProfile.value, configuration: config });
  }

  const wrapperPath = join(outside, 'host-wrapper.mjs');
  writeFileSync(
    wrapperPath,
    `import { createHostAssembly as realCreate } from ${JSON.stringify(realAssemblyModuleUrl(repoRoot))};\nexport function createHostAssembly() {\n  const deps = globalThis[${JSON.stringify(HOOK_KEY)}]?.();\n  return realCreate(deps);\n}\n`,
    'utf8',
  );

  const hostFile = join(outside, 'real-host.json');
  writeFileSync(
    hostFile,
    JSON.stringify({
      profileId: digests.profileId,
      profileDigest: digests.profileDigest,
      configDigest: digests.configDigest,
      pricingDigest: digests.pricingDigest,
      requestedModel: digests.requestedModel,
      adapterVersions: digests.adapterVersions,
      contractVersion: REAL_TIER_DELIVERY_CONTRACT,
      revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(c => [c, REV])),
      assembly: wrapperPath,
    }),
    'utf8',
  );

  const fetchSpy = createFetchDouble(opts.mode ?? 'repair');
  const spawnSpy = createSpawnDouble(opts.spawnOptions);
  const deps: RealTierDependencies = { env, fetch: fetchSpy.fetch, spawn: spawnSpy.spawn, stateRoot: join(stateRootBase, 'startup'), revision: REV };

  const captureStderr = async <T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> => {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: Uint8Array | string, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      if (typeof encoding === 'function') return orig(chunk, encoding);
      return orig(chunk, encoding, cb);
    }) as typeof process.stderr.write;
    try {
      const value = await fn();
      return { value, stderr: chunks.join('') };
    } finally {
      process.stderr.write = orig;
    }
  };

  (globalThis as Record<string, unknown>)[HOOK_KEY] = () => deps;

  return {
    tag: opts.tag,
    outside,
    hostFile,
    catalogPath,
    c01GraderPath,
    c01GraderDigest,
    c02GraderPath,
    c02GraderDigest,
    profileId: digests.profileId,
    digests,
    deps,
    fetchSpy,
    spawnSpy,
    env,
    captureStderr,
    secrets: (token?: string) => [ENDPOINT_HREF, ENDPOINT_HOST, API_KEY_SENTINEL, c01GraderPath, c02GraderPath, GRADER_FILE, GRADER_SECRET, token],
    cleanup: () => {
      Reflect.deleteProperty(globalThis as Record<string, unknown>, HOOK_KEY);
      rmSync(outside, { recursive: true, force: true });
    },
  };
}

function makeClient(origin: string, token: string) {
  const headers = { 'content-type': 'application/json', origin, 'x-operator-token': token };
  let seq = 0;
  const nextKey = (label: string) => `${label}-${++seq}`;
  const get = async <T>(path: string): Promise<{ status: number; body: ConsoleEnvelope<T> }> => {
    const res = await fetch(`${origin}${path}`);
    return { status: res.status, body: (await res.json()) as ConsoleEnvelope<T> };
  };
  const post = async <T>(path: string, body: unknown, customHeaders?: Record<string, string>): Promise<{ status: number; body: ConsoleEnvelope<T> }> => {
    const res = await fetch(`${origin}${path}`, { method: 'POST', headers: customHeaders ?? headers, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as ConsoleEnvelope<T> };
  };
  const unwrap = <T>(reply: { status: number; body: ConsoleEnvelope<T> }, label: string): T => {
    assert.equal(reply.status, 200, `${label}: expected 200, got ${reply.status} (${JSON.stringify(reply.body)})`);
    if (!reply.body.ok) assert.fail(`${label}: expected ok envelope (${reply.body.error})`);
    return reply.body.result;
  };
  const issueAndContinue = async (
    experimentId: string,
    input: { kind: 'resume' | 'revise' | 'end'; expectedTaskVersion: number; expectedControlVersion: number; decisionRef?: string; label: string },
    expectedExpVersion: number,
  ) => {
    const dir = unwrap<{ experiment: ExperimentViewShape; receipt: { receiptRef: string; controlVersion: number } }>(
      await post(`/api/experiments/${experimentId}/directions`, {
        idempotencyKey: nextKey(`${input.label}-dir`),
        kind: input.kind,
        expectedTaskVersion: input.expectedTaskVersion,
        expectedControlVersion: input.expectedControlVersion,
        ...(input.decisionRef === undefined ? {} : { decisionRef: input.decisionRef }),
      }),
      `${input.label}-dir`,
    );
    assert.equal(dir.experiment.version, expectedExpVersion + 1);
    const cont = unwrap<{ experiment: ExperimentViewShape }>(
      await post(`/api/experiments/${experimentId}/continue`, {
        idempotencyKey: nextKey(`${input.label}-cont`),
        directionRef: dir.receipt.receiptRef,
        expectedVersion: dir.experiment.version,
      }),
      `${input.label}-cont`,
    );
    return { experiment: cont.experiment, controlVersion: dir.receipt.controlVersion };
  };
  return { get, post, unwrap, nextKey, issueAndContinue };
}

test('serve --host real assembly: generated and env tokens, auth, catalog readiness, and zero leaks', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW_MS });
  const scGenerated = await setupServeScenario({ tag: 'tok-gen' });
  let cliGen: Awaited<ReturnType<typeof runEvaluateCli>> | undefined;
  try {
    const started = await scGenerated.captureStderr(() => runEvaluateCli(['serve', '--host', scGenerated.hostFile]));
    cliGen = started.value;
    assert.equal(cliGen.exitCode, 0);
    const tokenMatches = [...started.stderr.matchAll(/UC-03 real console operator token \(generated\): ([a-f0-9]+)\n/gu)];
    assert.equal(tokenMatches.length, 1, 'generated bootstrap token must be printed once to stderr');
    const generatedToken = tokenMatches[0]?.[1] ?? '';
    assert.ok(generatedToken.length >= 32);

    assertNoLeaks(cliGen.output, scGenerated.secrets(generatedToken), 'generated stdout');
    assertNoLeaks(started.stderr, scGenerated.secrets(), 'generated stderr');

    const listening = JSON.parse(cliGen.output) as { outcome: string; host: string; port: number };
    assert.equal(listening.outcome, 'listening');
    assert.equal(listening.host, '127.0.0.1');
    const origin = `http://${listening.host}:${listening.port}`;

    const pageRes = await fetch(`${origin}/`);
    assert.equal(pageRes.status, 200);
    const pageHtml = await pageRes.text();
    assert.match(pageHtml, /UC-03 Evaluation Console/u);
    assertNoLeaks(pageHtml, scGenerated.secrets(generatedToken), 'console HTML');

    const client = makeClient(origin, generatedToken);
    const cat = client.unwrap<{ profileId: string; cases: readonly { caseId: string; ready: boolean }[] }>(await client.get('/api/catalog'), 'catalog');
    assert.equal(cat.profileId, scGenerated.profileId);
    assert.deepEqual(
      cat.cases.map(c => ({ caseId: c.caseId, ready: c.ready })),
      [
        { caseId: 'C01', ready: true },
        { caseId: 'C02', ready: true },
      ],
    );
    assertNoLeaks(JSON.stringify(cat), scGenerated.secrets(generatedToken), 'catalog JSON');

    const noTok = await client.post('/api/experiments', {}, { 'content-type': 'application/json', origin });
    assert.equal(noTok.status, 403);
    const badTok = await client.post('/api/experiments', {}, { 'content-type': 'application/json', origin, 'x-operator-token': 'wrong-token-value-1234' });
    assert.equal(badTok.status, 403);
    const badOrig = await client.post('/api/experiments', {}, { 'content-type': 'application/json', origin: 'http://evil.invalid', 'x-operator-token': generatedToken });
    assert.equal(badOrig.status, 403);
  } finally {
    await cliGen?.close?.();
    scGenerated.cleanup();
    t.mock.timers.reset();
  }

  // Env token mode: never echoes env token anywhere; invalid env token refuses serve
  const envToken = ['real', 'serve', 'env', 'token', '0123'].join('-');
  const scEnv = await setupServeScenario({ tag: 'tok-env', extraEnv: { [REAL_CONSOLE_TOKEN_ENV]: envToken } });
  let cliEnv: Awaited<ReturnType<typeof runEvaluateCli>> | undefined;
  try {
    const started = await scEnv.captureStderr(() => runEvaluateCli(['serve', '--host', scEnv.hostFile]));
    cliEnv = started.value;
    assert.equal(cliEnv.exitCode, 0);
    assert.match(started.stderr, /using UC03_REAL_CONSOLE_TOKEN from environment/u);
    assertNoLeaks(started.stderr, scEnv.secrets(envToken), 'env stderr');
    assertNoLeaks(cliEnv.output, scEnv.secrets(envToken), 'env stdout');
    const listening = JSON.parse(cliEnv.output) as { host: string; port: number };
    const client = makeClient(`http://${listening.host}:${listening.port}`, envToken);
    const cat = client.unwrap(await client.get('/api/catalog'), 'env-catalog');
    assertNoLeaks(JSON.stringify(cat), scEnv.secrets(envToken), 'env catalog JSON');
  } finally {
    await cliEnv?.close?.();
    scEnv.cleanup();
  }

  const badEnvToken = 'too short!';
  const scBadTok = await setupServeScenario({ tag: 'tok-bad', extraEnv: { [REAL_CONSOLE_TOKEN_ENV]: badEnvToken } });
  try {
    const started = await scBadTok.captureStderr(() => runEvaluateCli(['serve', '--host', scBadTok.hostFile]));
    assert.equal(started.value.exitCode, 4);
    assert.deepEqual(JSON.parse(started.value.output), { error: 'HOST_CONSOLE_UNAVAILABLE' });
    assertNoLeaks(started.value.output, [badEnvToken], 'bad token output');
    assertNoLeaks(started.stderr, [badEnvToken], 'bad token stderr');
  } finally {
    scBadTok.cleanup();
  }
});

test('serve --host real assembly: C01 fresh per-case approval journey, rejection/end, and decision isolation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW_MS });
  const envToken = ['real', 'serve', 'c01', 'token', '0123'].join('-');
  // Spoofed env approval flag must be ignored; only console operator decisions count.
  const sc = await setupServeScenario({ tag: 'c01-journey', extraEnv: { [REAL_CONSOLE_TOKEN_ENV]: envToken, UC03_APPROVAL_DECISION: 'approve' } });
  const copiesBefore = countConsoleCopies();
  let cliResult: Awaited<ReturnType<typeof runEvaluateCli>> | undefined;
  try {
    const started = await sc.captureStderr(() => runEvaluateCli(['serve', '--host', sc.hostFile]));
    cliResult = started.value;
    assert.equal(cliResult.exitCode, 0);
    const { host, port } = JSON.parse(cliResult.output) as { host: string; port: number };
    const client = makeClient(`http://${host}:${port}`, envToken);

    // Run 1: full approval journey C01 -> D0 approve -> D1 approve -> completed + real grade pass
    const c01Run1 = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post('/api/experiments', { profileId: sc.profileId, idempotencyKey: client.nextKey('c01-1-start'), source: { kind: 'catalog', caseIds: ['C01'] } }),
      'c01-1-start',
    ).experiment;
    assert.equal(c01Run1.status, 'waiting-approval');
    assert.equal(c01Run1.control, null);
    assert.equal(c01Run1.workflowReport?.cases[0]?.workflowOutcome, 'waiting-approval');
    assert.equal(c01Run1.workflowReport?.cases[0]?.grade, 'not-run');
    assert.equal(c01Run1.workflowReport?.cases[0]?.gradeReason, 'unresolved-wait');

    // Direction before operator decision must be refused even with UC03_APPROVAL_DECISION set
    const beforeDec = await client.post(`/api/experiments/${c01Run1.id}/directions`, {
      idempotencyKey: client.nextKey('c01-no-decision'),
      kind: 'resume',
      expectedTaskVersion: 2,
      expectedControlVersion: 2,
    });
    assert.equal(beforeDec.status, 409);

    const p0 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${c01Run1.id}/approval`), 'c01-p0');
    assert.equal(p0.binding.status, 'pending');

    const d0 = client.unwrap<DecisionReplyShape>(
      await client.post(`/api/experiments/${c01Run1.id}/decision`, {
        idempotencyKey: client.nextKey('c01-d0-approve'),
        decision: 'approve',
        expectedVersion: p0.presentation.requestVersion,
        presentationDigest: p0.presentation.presentationDigest,
      }),
      'c01-d0-approve',
    );
    assert.equal(d0.outcome, 'ok');
    const c01AfterD0Approve = client.unwrap<ExperimentViewShape>(await client.get(`/api/experiments/${c01Run1.id}`), 'c01-after-d0-approve');
    assert.ok(c01AfterD0Approve.control && c01AfterD0Approve.control.taskVersion > 0);
    assert.equal(c01AfterD0Approve.control.controlVersion, d0.controlVersion);

    // Forbidden/stale directions at AwaitPlan return 409
    const badRevise = await client.post(`/api/experiments/${c01Run1.id}/directions`, {
      idempotencyKey: client.nextKey('c01-bad-revise'),
      kind: 'revise',
      expectedTaskVersion: c01AfterD0Approve.control.taskVersion,
      expectedControlVersion: c01AfterD0Approve.control.controlVersion,
    });
    assert.equal(badRevise.status, 409);
    const staleCtrl = await client.post(`/api/experiments/${c01Run1.id}/directions`, {
      idempotencyKey: client.nextKey('c01-stale-ctrl'),
      kind: 'resume',
      expectedTaskVersion: c01AfterD0Approve.control.taskVersion,
      expectedControlVersion: c01AfterD0Approve.control.controlVersion - 1,
    });
    assert.equal(staleCtrl.status, 409);

    const afterD0 = await client.issueAndContinue(
      c01Run1.id,
      { kind: 'resume', expectedTaskVersion: c01AfterD0Approve.control.taskVersion, expectedControlVersion: c01AfterD0Approve.control.controlVersion, label: 'c01-to-verify' },
      c01Run1.version,
    );
    assert.equal(afterD0.experiment.status, 'waiting-approval');
    assert.equal(afterD0.experiment.control, null);

    const p1 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${c01Run1.id}/approval`), 'c01-p1');
    const d1 = client.unwrap<DecisionReplyShape>(
      await client.post(`/api/experiments/${c01Run1.id}/decision`, {
        idempotencyKey: client.nextKey('c01-d1-approve'),
        decision: 'approve',
        expectedVersion: p1.presentation.requestVersion,
        presentationDigest: p1.presentation.presentationDigest,
      }),
      'c01-d1-approve',
    );
    const completed = await client.issueAndContinue(
      c01Run1.id,
      { kind: 'resume', expectedTaskVersion: d1.controlVersion, expectedControlVersion: d1.controlVersion, label: 'c01-to-deliver' },
      afterD0.experiment.version,
    );
    assert.equal(completed.experiment.status, 'completed');
    assert.equal(completed.experiment.control, null);
    assert.ok(completed.experiment.workflowReport);
    assert.equal(completed.experiment.workflowReport.mode, 'real');
    assert.equal(completed.experiment.workflowReport.tier, 'real-integration');
    assert.equal(completed.experiment.workflowReport.isRealVerified, false);
    assert.equal(completed.experiment.workflowReport.cases[0]?.workflowOutcome, 'COMPLETED');
    assert.equal(completed.experiment.workflowReport.cases[0]?.grade, 'pass');
    assert.equal(completed.experiment.workflowReport.cases[0]?.gradeReason, 'criteria-satisfied');
    assert.equal(completed.experiment.workflowReport.cases[0]?.returnedModel, RETURNED_MODEL);
    assert.equal(completed.experiment.workflowReport.cases[0]?.graderDigest, sc.c01GraderDigest);
    assert.equal(sc.spawnSpy.hiddenChecks.length, 1);
    assertNoLeaks(JSON.stringify(completed.experiment), sc.secrets(envToken), 'c01 completed report');

    // Run 2: fresh per-case assembly -> reject D0 -> AwaitFeedback -> end -> incomplete
    const c01Run2 = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post('/api/experiments', { profileId: sc.profileId, idempotencyKey: client.nextKey('c01-2-start'), source: { kind: 'catalog', caseIds: ['C01'] } }),
      'c01-2-start',
    ).experiment;
    assert.notEqual(c01Run2.runId, c01Run1.runId);
    assert.notEqual(c01Run2.workspaceId, c01Run1.workspaceId);

    const p2 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${c01Run2.id}/approval`), 'c01-2-p0');
    const rejected = client.unwrap<DecisionReplyShape>(
      await client.post(`/api/experiments/${c01Run2.id}/decision`, {
        idempotencyKey: client.nextKey('c01-2-reject'),
        decision: 'reject',
        expectedVersion: p2.presentation.requestVersion,
        presentationDigest: p2.presentation.presentationDigest,
      }),
      'c01-2-reject',
    );
    const c01Run2AfterReject = client.unwrap<ExperimentViewShape>(await client.get(`/api/experiments/${c01Run2.id}`), 'c01-2-after-reject');
    assert.ok(c01Run2AfterReject.control && c01Run2AfterReject.control.controlVersion === rejected.controlVersion);
    const feedback = await client.issueAndContinue(
      c01Run2.id,
      { kind: 'resume', expectedTaskVersion: rejected.controlVersion, expectedControlVersion: rejected.controlVersion, label: 'c01-2-fb' },
      c01Run2.version,
    );
    assert.equal(feedback.experiment.status, 'waiting-info');
    assert.ok(feedback.experiment.control && feedback.experiment.control.taskVersion > 0);
    assert.equal(feedback.experiment.control.controlVersion, feedback.controlVersion);

    // Resume at AwaitFeedback must be refused, and revise must be refused without verifyDirection (only end permitted)
    const resumeAtFb = await client.post(`/api/experiments/${c01Run2.id}/directions`, {
      idempotencyKey: client.nextKey('c01-2-bad-resume'),
      kind: 'resume',
      expectedTaskVersion: feedback.controlVersion,
      expectedControlVersion: feedback.controlVersion,
    });
    assert.equal(resumeAtFb.status, 409);

    const reviseAtFb = await client.post(`/api/experiments/${c01Run2.id}/directions`, {
      idempotencyKey: client.nextKey('c01-2-refused-revise'),
      kind: 'revise',
      expectedTaskVersion: feedback.controlVersion,
      expectedControlVersion: feedback.controlVersion,
      decisionRef: p2.binding.decisionId,
      feedback: 'Revise plan.',
    });
    assert.equal(reviseAtFb.status, 409);
    assert.equal(reviseAtFb.body.ok, false);
    if (!reviseAtFb.body.ok) assert.equal(reviseAtFb.body.error, 'INVALID_CONTROL_RECEIPT');

    const ended = await client.issueAndContinue(
      c01Run2.id,
      {
        kind: 'end',
        expectedTaskVersion: feedback.experiment.control.taskVersion,
        expectedControlVersion: feedback.experiment.control.controlVersion,
        decisionRef: p2.binding.decisionId,
        label: 'c01-2-end',
      },
      feedback.experiment.version,
    );
    assert.equal(ended.experiment.status, 'incomplete');
    assert.equal(ended.experiment.control, null);
    assert.equal(ended.experiment.workflowReport?.cases[0]?.workflowOutcome, 'INCOMPLETE');
    assert.equal(ended.experiment.workflowReport?.cases[0]?.grade, 'not-run');

    const copiesAfter = countConsoleCopies();
    for (const dir of copiesAfter) {
      assert.equal(copiesBefore.has(dir), true, `temporary console working copy ${dir} should have been cleaned up`);
    }
  } finally {
    await cliResult?.close?.();
    sc.cleanup();
    t.mock.timers.reset();
  }
});

test('serve --host real assembly: C02 clarification journey (pause -> answers -> resume -> approvals -> completed)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW_MS });
  const envToken = ['real', 'serve', 'c02', 'token', '0123'].join('-');
  const sc = await setupServeScenario({ tag: 'c02-clarify', mode: 'clarify', extraEnv: { [REAL_CONSOLE_TOKEN_ENV]: envToken } });
  const copiesBefore = countConsoleCopies();
  let cliResult: Awaited<ReturnType<typeof runEvaluateCli>> | undefined;
  try {
    const started = await sc.captureStderr(() => runEvaluateCli(['serve', '--host', sc.hostFile]));
    cliResult = started.value;
    assert.equal(cliResult.exitCode, 0);
    const { host, port } = JSON.parse(cliResult.output) as { host: string; port: number };
    const client = makeClient(`http://${host}:${port}`, envToken);

    const c02Start = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post('/api/experiments', { profileId: sc.profileId, idempotencyKey: client.nextKey('c02-start'), source: { kind: 'catalog', caseIds: ['C02'] } }),
      'c02-start',
    ).experiment;
    assert.equal(c02Start.status, 'waiting-info');
    assert.ok(c02Start.control && c02Start.control.taskVersion > 0 && c02Start.control.controlVersion === 1);
    assert.ok(c02Start.workflowClarification);
    assert.equal(c02Start.workflowClarification.questions[0]?.questionId, 'q-denominator');
    assert.equal(c02Start.workflowReport?.cases[0]?.workflowOutcome, 'waiting-info');
    assert.equal(c02Start.workflowReport?.cases[0]?.grade, 'pass');
    assert.equal(c02Start.workflowReport?.cases[0]?.gradeReason, 'criteria-satisfied');

    // Working copy must remain intact while paused at NeedsInfo
    const copiesPaused = countConsoleCopies();
    assert.equal(
      [...copiesPaused].some(d => !copiesBefore.has(d)),
      true,
    );

    const answered = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post(`/api/experiments/${c02Start.id}/answers`, {
        idempotencyKey: client.nextKey('c02-answer'),
        questionId: c02Start.workflowClarification.questionId,
        questionDigest: c02Start.workflowClarification.questionDigest,
        expectedVersion: c02Start.version,
        answers: ['Raise CalculationError when divisor is zero.'],
      }),
      'c02-answer',
    ).experiment;
    assert.equal(answered.status, 'waiting-info');
    assert.equal(answered.answers.length, 1);

    const afterClarify = await client.issueAndContinue(
      c02Start.id,
      { kind: 'resume', expectedTaskVersion: c02Start.control.taskVersion, expectedControlVersion: c02Start.control.controlVersion, label: 'c02-resume' },
      answered.version,
    );
    assert.equal(afterClarify.experiment.status, 'waiting-approval');
    assert.equal(afterClarify.experiment.control, null);

    const p0 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${c02Start.id}/approval`), 'c02-p0');
    const d0 = client.unwrap<DecisionReplyShape>(
      await client.post(`/api/experiments/${c02Start.id}/decision`, {
        idempotencyKey: client.nextKey('c02-d0'),
        decision: 'approve',
        expectedVersion: p0.presentation.requestVersion,
        presentationDigest: p0.presentation.presentationDigest,
      }),
      'c02-d0',
    );
    const afterD0 = await client.issueAndContinue(
      c02Start.id,
      { kind: 'resume', expectedTaskVersion: d0.controlVersion, expectedControlVersion: d0.controlVersion, label: 'c02-verify' },
      afterClarify.experiment.version,
    );
    assert.equal(afterD0.experiment.status, 'waiting-approval');

    const p1 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${c02Start.id}/approval`), 'c02-p1');
    const d1 = client.unwrap<DecisionReplyShape>(
      await client.post(`/api/experiments/${c02Start.id}/decision`, {
        idempotencyKey: client.nextKey('c02-d1'),
        decision: 'approve',
        expectedVersion: p1.presentation.requestVersion,
        presentationDigest: p1.presentation.presentationDigest,
      }),
      'c02-d1',
    );
    const completed = await client.issueAndContinue(
      c02Start.id,
      { kind: 'resume', expectedTaskVersion: d1.controlVersion, expectedControlVersion: d1.controlVersion, label: 'c02-deliver' },
      afterD0.experiment.version,
    );
    assert.equal(completed.experiment.status, 'completed');
    assert.equal(completed.experiment.workflowReport?.mode, 'real');
    assert.equal(completed.experiment.workflowReport?.tier, 'real-integration');
    assert.equal(completed.experiment.workflowReport?.cases[0]?.workflowOutcome, 'COMPLETED');
    assert.equal(completed.experiment.workflowReport?.cases[0]?.returnedModel, RETURNED_MODEL);
    assert.equal(completed.experiment.workflowReport?.cases[0]?.graderDigest, sc.c02GraderDigest);
    assertNoLeaks(JSON.stringify(completed.experiment), sc.secrets(envToken), 'c02 completed report');

    const copiesAfter = countConsoleCopies();
    for (const dir of copiesAfter) {
      assert.equal(copiesBefore.has(dir), true, `C02 temporary copy ${dir} should have been cleaned up`);
    }
  } finally {
    await cliResult?.close?.();
    sc.cleanup();
    t.mock.timers.reset();
  }
});

test('serve --host real assembly: custom submissions stay exploratory/ungraded and unpinned cases refuse cleanly', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW_MS });
  const envToken = ['real', 'serve', 'cust', 'token', '0123'].join('-');
  const sc = await setupServeScenario({ tag: 'custom-unpinned', includeC03: true, extraEnv: { [REAL_CONSOLE_TOKEN_ENV]: envToken } });
  let cliResult: Awaited<ReturnType<typeof runEvaluateCli>> | undefined;
  try {
    const started = await sc.captureStderr(() => runEvaluateCli(['serve', '--host', sc.hostFile]));
    cliResult = started.value;
    assert.equal(cliResult.exitCode, 0);
    const { host, port } = JSON.parse(cliResult.output) as { host: string; port: number };
    const client = makeClient(`http://${host}:${port}`, envToken);

    const cat = client.unwrap<{ catalog?: unknown }>(await client.get('/api/catalog'), 'catalog');
    assert.ok(cat);

    // 1. Incomplete custom bug stays exploratory waiting-info, never graded
    const incCustom = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post('/api/experiments', {
        profileId: sc.profileId,
        idempotencyKey: client.nextKey('custom-inc'),
        source: {
          kind: 'bug',
          repositoryId: `repo-${sc.tag}-C01`,
          checkSetId: 'checks-configured',
          bugInput: { goal: 'Exploratory check', observedBehavior: 'ZeroDivisionError', expectedBehavior: 'CalculationError' },
        },
      }),
      'custom-inc',
    ).experiment;
    assert.equal(incCustom.scope, 'exploratory');
    assert.equal(incCustom.status, 'waiting-info');
    assert.equal(incCustom.graded, false);
    assert.equal(incCustom.workflowReport, null);
    assert.equal(incCustom.control, null);

    // End taskless incomplete intake locally so another experiment can start; remains ungraded.
    const endedInc = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post(`/api/experiments/${incCustom.id}/directions`, {
        idempotencyKey: client.nextKey('custom-inc-end'),
        kind: 'end',
        expectedTaskVersion: 0,
        expectedControlVersion: 0,
      }),
      'custom-inc-end',
    ).experiment;
    assert.equal(endedInc.status, 'incomplete');
    assert.equal(endedInc.graded, false);
    assert.equal(endedInc.workflowReport, null);
    assert.equal(endedInc.control, null);

    // 2. Complete custom bug is refused (CUSTOM_ROUTE_UNAVAILABLE -> incomplete), never graded
    const fullCustom = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post('/api/experiments', {
        profileId: sc.profileId,
        idempotencyKey: client.nextKey('custom-full'),
        source: {
          kind: 'bug',
          repositoryId: `repo-${sc.tag}-C01`,
          checkSetId: 'checks-configured',
          bugInput: {
            goal: 'Reject zero divisor',
            observedBehavior: 'ZeroDivisionError',
            expectedBehavior: 'CalculationError',
            reproduction: 'pytest -q tests/test_calculator.py',
            acceptanceCriteria: ['Raises CalculationError'],
          },
        },
      }),
      'custom-full',
    ).experiment;
    assert.equal(fullCustom.scope, 'exploratory');
    assert.equal(fullCustom.status, 'incomplete');
    assert.equal(fullCustom.graded, false);
    assert.equal(fullCustom.workflowReport, null);

    // 3. Unpinned catalog case C03 refuses at bindCase with zero model calls
    const unpinned = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post('/api/experiments', { profileId: sc.profileId, idempotencyKey: client.nextKey('c03-unpinned'), source: { kind: 'catalog', caseIds: ['C03'] } }),
      'c03-unpinned',
    ).experiment;
    assert.equal(unpinned.status, 'incomplete');
    assert.equal(unpinned.taskId, null);
    assert.equal(unpinned.workflowReport, null);
    assert.equal(sc.fetchSpy.requests.length, 0);
  } finally {
    await cliResult?.close?.();
    sc.cleanup();
    t.mock.timers.reset();
  }
});

test('serve --host real assembly: prerequisite refusals (profile, credential, image, daemon, catalog, grader) with zero leaks', async () => {
  // 1. Missing profile directly via createHostAssembly
  const missingProfile = createHostAssembly({ env: {} });
  assert.equal('status' in missingProfile && missingProfile.status, 'unavailable');

  // 2. Missing credential refuses serve startup
  const scNoKey = await setupServeScenario({ tag: 'no-key', omittApiKey: true });
  try {
    const res = await runEvaluateCli(['serve', '--host', scNoKey.hostFile]);
    assert.equal(res.exitCode, 4);
    assert.deepEqual(JSON.parse(res.output), { error: 'HOST_CONSOLE_UNAVAILABLE' });
    assertNoLeaks(res.output, scNoKey.secrets(), 'no-key refusal');
  } finally {
    scNoKey.cleanup();
  }

  // 3. Unpinned image refuses serve startup
  const scBadImg = await setupServeScenario({ tag: 'bad-img', unpinnedImage: true });
  try {
    const res = await runEvaluateCli(['serve', '--host', scBadImg.hostFile]);
    assert.equal(res.exitCode, 4);
    assert.deepEqual(JSON.parse(res.output), { error: 'HOST_CONSOLE_UNAVAILABLE' });
    assertNoLeaks(res.output, scBadImg.secrets(), 'unpinned image refusal');
  } finally {
    scBadImg.cleanup();
  }

  // 4. Docker daemon unavailable refuses serve startup with operational: docker-unavailable
  const scNoDocker = await setupServeScenario({ tag: 'no-docker', spawnOptions: { versionFail: true } });
  try {
    const res = await runEvaluateCli(['serve', '--host', scNoDocker.hostFile]);
    assert.equal(res.exitCode, 4);
    assert.equal(JSON.parse(res.output).operational, 'docker-unavailable');
    assertNoLeaks(res.output, scNoDocker.secrets(), 'docker-unavailable refusal');
  } finally {
    scNoDocker.cleanup();
  }

  // 5. Image mismatch refuses serve startup with operational: image-mismatch
  const scImgMismatch = await setupServeScenario({ tag: 'img-mismatch', spawnOptions: { imageFail: true } });
  try {
    const res = await runEvaluateCli(['serve', '--host', scImgMismatch.hostFile]);
    assert.equal(res.exitCode, 4);
    assert.equal(JSON.parse(res.output).operational, 'image-mismatch');
    assertNoLeaks(res.output, scImgMismatch.secrets(), 'image-mismatch refusal');
  } finally {
    scImgMismatch.cleanup();
  }

  // 6. Tampered catalog at startup refuses HOST_CONSOLE_UNAVAILABLE
  const scBadCat = await setupServeScenario({ tag: 'bad-cat' });
  try {
    writeFileSync(scBadCat.catalogPath, JSON.stringify({ catalog: [] }), 'utf8');
    const res = await runEvaluateCli(['serve', '--host', scBadCat.hostFile]);
    assert.equal(res.exitCode, 4);
    assert.deepEqual(JSON.parse(res.output), { error: 'HOST_CONSOLE_UNAVAILABLE' });
    assertNoLeaks(res.output, scBadCat.secrets(), 'bad catalog refusal');
  } finally {
    scBadCat.cleanup();
  }

  // 7. Tampered grader at startup refuses HOST_CONSOLE_UNAVAILABLE
  const scBadGrader = await setupServeScenario({ tag: 'bad-grader' });
  try {
    writeFileSync(scBadGrader.c01GraderPath, JSON.stringify({ corrupted: true }), 'utf8');
    const res = await runEvaluateCli(['serve', '--host', scBadGrader.hostFile]);
    assert.equal(res.exitCode, 4);
    assert.deepEqual(JSON.parse(res.output), { error: 'HOST_CONSOLE_UNAVAILABLE' });
    assertNoLeaks(res.output, scBadGrader.secrets(), 'bad grader refusal');
  } finally {
    scBadGrader.cleanup();
  }

  // 8. Runtime refusals after startup: daemon drop before case bind + grader corruption before bind
  const envToken = ['real', 'serve', 'rtref', 'token', '0123'].join('-');
  const scRuntime = await setupServeScenario({ tag: 'rt-refusal', extraEnv: { [REAL_CONSOLE_TOKEN_ENV]: envToken } });
  let cliRuntime: Awaited<ReturnType<typeof runEvaluateCli>> | undefined;
  try {
    const started = await scRuntime.captureStderr(() => runEvaluateCli(['serve', '--host', scRuntime.hostFile]));
    cliRuntime = started.value;
    assert.equal(cliRuntime.exitCode, 0);
    const { host, port } = JSON.parse(cliRuntime.output) as { host: string; port: number };
    const client = makeClient(`http://${host}:${port}`, envToken);

    scRuntime.spawnSpy.state.versionFail = true;
    const daemonDrop = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post('/api/experiments', { profileId: scRuntime.profileId, idempotencyKey: client.nextKey('daemon-drop'), source: { kind: 'catalog', caseIds: ['C01'] } }),
      'daemon-drop',
    ).experiment;
    assert.equal(daemonDrop.status, 'incomplete');
    assert.equal(scRuntime.fetchSpy.requests.length, 0);

    scRuntime.spawnSpy.state.versionFail = false;
    writeFileSync(scRuntime.c01GraderPath, JSON.stringify({ corrupted: true }), 'utf8');
    const graderDrop = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post('/api/experiments', { profileId: scRuntime.profileId, idempotencyKey: client.nextKey('grader-drop'), source: { kind: 'catalog', caseIds: ['C01'] } }),
      'grader-drop',
    ).experiment;
    assert.equal(graderDrop.status, 'incomplete');
    assert.equal(scRuntime.fetchSpy.requests.length, 0);
    assertNoLeaks(JSON.stringify(graderDrop), scRuntime.secrets(envToken), 'runtime grader refusal');
  } finally {
    await cliRuntime?.close?.();
    scRuntime.cleanup();
  }

  // 9. Mid-run grader corruption after bindCase yields not-run (private-grading) with zero leaks and removes working copy
  const envTokenMid = ['real', 'serve', 'mid', 'token', '0123'].join('-');
  const scMid = await setupServeScenario({ tag: 'mid-grader', extraEnv: { [REAL_CONSOLE_TOKEN_ENV]: envTokenMid } });
  const copiesBeforeMid = countConsoleCopies();
  let cliMid: Awaited<ReturnType<typeof runEvaluateCli>> | undefined;
  try {
    const started = await scMid.captureStderr(() => runEvaluateCli(['serve', '--host', scMid.hostFile]));
    cliMid = started.value;
    assert.equal(cliMid.exitCode, 0);
    const { host, port } = JSON.parse(cliMid.output) as { host: string; port: number };
    const client = makeClient(`http://${host}:${port}`, envTokenMid);

    const startedC01 = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post('/api/experiments', { profileId: scMid.profileId, idempotencyKey: client.nextKey('mid-start'), source: { kind: 'catalog', caseIds: ['C01'] } }),
      'mid-start',
    ).experiment;
    assert.equal(startedC01.status, 'waiting-approval');
    assert.equal(
      [...countConsoleCopies()].some(d => !copiesBeforeMid.has(d)),
      true,
      'working copy should exist while waiting-approval',
    );

    writeFileSync(scMid.c01GraderPath, JSON.stringify({ corrupted: true }), 'utf8');

    const p0 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${startedC01.id}/approval`), 'mid-p0');
    const d0 = client.unwrap<DecisionReplyShape>(
      await client.post(`/api/experiments/${startedC01.id}/decision`, {
        idempotencyKey: client.nextKey('mid-d0'),
        decision: 'approve',
        expectedVersion: p0.presentation.requestVersion,
        presentationDigest: p0.presentation.presentationDigest,
      }),
      'mid-d0',
    );
    const afterD0 = await client.issueAndContinue(
      startedC01.id,
      { kind: 'resume', expectedTaskVersion: d0.controlVersion, expectedControlVersion: d0.controlVersion, label: 'mid-verify' },
      startedC01.version,
    );
    const p1 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${startedC01.id}/approval`), 'mid-p1');
    const d1 = client.unwrap<DecisionReplyShape>(
      await client.post(`/api/experiments/${startedC01.id}/decision`, {
        idempotencyKey: client.nextKey('mid-d1'),
        decision: 'approve',
        expectedVersion: p1.presentation.requestVersion,
        presentationDigest: p1.presentation.presentationDigest,
      }),
      'mid-d1',
    );
    const done = await client.issueAndContinue(
      startedC01.id,
      { kind: 'resume', expectedTaskVersion: d1.controlVersion, expectedControlVersion: d1.controlVersion, label: 'mid-deliver' },
      afterD0.experiment.version,
    );
    assert.equal(done.experiment.status, 'completed');
    assert.equal(done.experiment.workflowReport?.cases[0]?.grade, 'not-run');
    assert.equal(done.experiment.workflowReport?.cases[0]?.gradeReason, 'private-grading');
    assertNoLeaks(JSON.stringify(done.experiment), scMid.secrets(envTokenMid), 'mid-run grader refusal');
    for (const dir of countConsoleCopies()) {
      assert.equal(copiesBeforeMid.has(dir), true, `mid-run not-run working copy ${dir} should have been cleaned up`);
    }
  } finally {
    await cliMid?.close?.();
    scMid.cleanup();
  }
});

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

test('serve --host real assembly: monotonic control versions across NeedsInfo and approval advance', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW_MS });
  const envToken = ['real', 'serve', 'mono', 'token', '0123'].join('-');
  const sc = await setupServeScenario({ tag: 'mono-ctrl', mode: 'clarify', extraEnv: { [REAL_CONSOLE_TOKEN_ENV]: envToken } });
  let cliResult: Awaited<ReturnType<typeof runEvaluateCli>> | undefined;
  try {
    const started = await sc.captureStderr(() => runEvaluateCli(['serve', '--host', sc.hostFile]));
    cliResult = started.value;
    assert.equal(cliResult.exitCode, 0);
    const { host, port } = JSON.parse(cliResult.output) as { host: string; port: number };
    const client = makeClient(`http://${host}:${port}`, envToken);

    const c02Start = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post('/api/experiments', { profileId: sc.profileId, idempotencyKey: client.nextKey('mono-start'), source: { kind: 'catalog', caseIds: ['C02'] } }),
      'mono-start',
    ).experiment;
    assert.equal(c02Start.status, 'waiting-info');
    assert.ok(c02Start.control && c02Start.control.taskVersion > 0 && c02Start.control.controlVersion === 1);
    assert.ok(c02Start.workflowClarification);

    const answered = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post(`/api/experiments/${c02Start.id}/answers`, {
        idempotencyKey: client.nextKey('mono-ans'),
        questionId: c02Start.workflowClarification.questionId,
        questionDigest: c02Start.workflowClarification.questionDigest,
        expectedVersion: c02Start.version,
        answers: ['Raise CalculationError when divisor is zero.'],
      }),
      'mono-ans',
    ).experiment;

    // Issue three resume directions at NeedsInfo to advance session controlVersion to 4 before continuing
    const d1 = client.unwrap<{ experiment: ExperimentViewShape; receipt: { receiptRef: string; controlVersion: number } }>(
      await client.post(`/api/experiments/${c02Start.id}/directions`, {
        idempotencyKey: client.nextKey('mono-r1'),
        kind: 'resume',
        expectedTaskVersion: c02Start.control.taskVersion,
        expectedControlVersion: c02Start.control.controlVersion,
      }),
      'mono-r1',
    );
    assert.equal(d1.receipt.controlVersion, 2);
    assert.equal(d1.experiment.control?.controlVersion, 2);

    const d2 = client.unwrap<{ experiment: ExperimentViewShape; receipt: { receiptRef: string; controlVersion: number } }>(
      await client.post(`/api/experiments/${c02Start.id}/directions`, {
        idempotencyKey: client.nextKey('mono-r2'),
        kind: 'resume',
        expectedTaskVersion: d1.receipt.controlVersion,
        expectedControlVersion: d1.receipt.controlVersion,
      }),
      'mono-r2',
    );
    assert.equal(d2.receipt.controlVersion, 3);
    assert.equal(d2.experiment.control?.controlVersion, 3);

    const d3 = client.unwrap<{ experiment: ExperimentViewShape; receipt: { receiptRef: string; controlVersion: number } }>(
      await client.post(`/api/experiments/${c02Start.id}/directions`, {
        idempotencyKey: client.nextKey('mono-r3'),
        kind: 'resume',
        expectedTaskVersion: d2.receipt.controlVersion,
        expectedControlVersion: d2.receipt.controlVersion,
      }),
      'mono-r3',
    );
    assert.equal(d3.receipt.controlVersion, 4);
    assert.equal(d3.experiment.control?.controlVersion, 4);
    assert.equal(d3.experiment.version, answered.version + 3);

    const afterClarify = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post(`/api/experiments/${c02Start.id}/continue`, {
        idempotencyKey: client.nextKey('mono-cont'),
        directionRef: d3.receipt.receiptRef,
        expectedVersion: d3.experiment.version,
      }),
      'mono-cont',
    ).experiment;
    assert.equal(afterClarify.status, 'waiting-approval');
    assert.equal(afterClarify.control, null);

    const p0 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${c02Start.id}/approval`), 'mono-p0');
    const approved = client.unwrap<DecisionReplyShape>(
      await client.post(`/api/experiments/${c02Start.id}/decision`, {
        idempotencyKey: client.nextKey('mono-d0'),
        decision: 'approve',
        expectedVersion: p0.presentation.requestVersion,
        presentationDigest: p0.presentation.presentationDigest,
      }),
      'mono-d0',
    );
    assert.ok(approved.controlVersion < d3.receipt.controlVersion, 'approval controlVersion is lower than session lastControlVersion');
    const afterMonoApprove = client.unwrap<ExperimentViewShape>(await client.get(`/api/experiments/${c02Start.id}`), 'mono-after-approve');
    assert.ok(afterMonoApprove.control && afterMonoApprove.control.taskVersion > 0);
    assert.equal(afterMonoApprove.control.controlVersion, 4);

    // Dropping back to approval.controlVersion must be refused; monotonic controlVersion 4 -> 5 succeeds
    const regressed = await client.post(`/api/experiments/${c02Start.id}/directions`, {
      idempotencyKey: client.nextKey('mono-regress'),
      kind: 'resume',
      expectedTaskVersion: approved.controlVersion,
      expectedControlVersion: approved.controlVersion,
    });
    assert.equal(regressed.status, 409);

    const nextDir = client.unwrap<{ receipt: { controlVersion: number } }>(
      await client.post(`/api/experiments/${c02Start.id}/directions`, {
        idempotencyKey: client.nextKey('mono-next'),
        kind: 'resume',
        expectedTaskVersion: afterMonoApprove.control.taskVersion,
        expectedControlVersion: afterMonoApprove.control.controlVersion,
      }),
      'mono-next',
    );
    assert.equal(nextDir.receipt.controlVersion, 5);
  } finally {
    await cliResult?.close?.();
    sc.cleanup();
    t.mock.timers.reset();
  }
});

test('serve --host real assembly: refuses catalog identity drift at bindCase before task seed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW_MS });
  const envToken = ['real', 'serve', 'drift', 'token', '0123'].join('-');
  const sc = await setupServeScenario({ tag: 'cat-drift', extraEnv: { [REAL_CONSOLE_TOKEN_ENV]: envToken } });
  let cliResult: Awaited<ReturnType<typeof runEvaluateCli>> | undefined;
  try {
    const started = await sc.captureStderr(() => runEvaluateCli(['serve', '--host', sc.hostFile]));
    cliResult = started.value;
    assert.equal(cliResult.exitCode, 0);
    const { host, port } = JSON.parse(cliResult.output) as { host: string; port: number };
    const client = makeClient(`http://${host}:${port}`, envToken);

    // Replace the C01 fixture and update catalog.json at the same path so fresh admission succeeds with a drifted digest
    const catDoc = JSON.parse(readFileSync(sc.catalogPath, 'utf8')) as {
      catalog: { caseId: string; initialRepositoryDigest: string; fixturePath: string; fixtureDigest: string; grader: { path: string; digest: string } }[];
    };
    const c01Entry = catDoc.catalog.find(e => e.caseId === 'C01');
    assert.ok(c01Entry);
    const fixDoc = JSON.parse(readFileSync(c01Entry.fixturePath, 'utf8')) as { task: BugTask; repositoryRoot: string };
    const replacedFix = JSON.stringify({ ...fixDoc, task: { ...fixDoc.task, goal: 'Replaced catalog task goal' } });
    writeFileSync(c01Entry.fixturePath, replacedFix, 'utf8');
    c01Entry.fixtureDigest = sha256Text(replacedFix);
    writeFileSync(sc.catalogPath, JSON.stringify(catDoc), 'utf8');

    const drifted = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post('/api/experiments', { profileId: sc.profileId, idempotencyKey: client.nextKey('cat-drift'), source: { kind: 'catalog', caseIds: ['C01'] } }),
      'cat-drift',
    ).experiment;
    assert.equal(drifted.status, 'incomplete');
    assert.equal(drifted.taskId, null);
    assert.equal(drifted.workflowReport, null);
    assert.equal(sc.fetchSpy.requests.length, 0);
    assert.deepEqual(listFilesRecursive(join(sc.outside, 'state')), [], 'catalog identity drift must not seed or write any task record');
  } finally {
    await cliResult?.close?.();
    sc.cleanup();
    t.mock.timers.reset();
  }
});

test('real console factory: removes workingCopyRoot and rethrows when bindRealTierTask throws', async () => {
  const sc = await setupServeScenario({ tag: 'bind-throw' });
  const copiesBefore = countConsoleCopies();
  try {
    const initial = resolveRealTierAssembly(sc.deps);
    assert.equal(initial.status, 'assembly-ready');
    const factory = createRealTierConsoleFactory(initial, sc.deps, deps => {
      const fresh = resolveRealTierAssembly(deps);
      if (fresh.status !== 'assembly-ready') return fresh;
      return {
        ...fresh,
        owners: {
          ...fresh.owners,
          components: {
            ...fresh.owners.components,
            statePort: {
              ...fresh.owners.components.statePort,
              loadTask: () => {
                throw new Error('SIMULATED_BIND_THROW');
              },
            },
          },
        },
      };
    });
    const hostDoc = JSON.parse(readFileSync(sc.hostFile, 'utf8')) as {
      profileId: string;
      profileDigest: string;
      configDigest: string;
      pricingDigest: string;
      requestedModel: string;
      adapterVersions: string[];
    };
    const readiness = { status: 'ready' } as Parameters<typeof factory>[0]['readiness'];
    const consoleAssembly = factory({
      readiness,
      configuration: {
        identity: {
          profileId: hostDoc.profileId,
          profileDigest: hostDoc.profileDigest,
          configDigest: hostDoc.configDigest,
          pricingDigest: hostDoc.pricingDigest,
        },
        profileDigest: hostDoc.profileDigest,
        configDigest: hostDoc.configDigest,
        pricingDigest: hostDoc.pricingDigest,
        requestedModel: hostDoc.requestedModel,
        adapterVersions: hostDoc.adapterVersions,
      },
    });
    const entry = consoleAssembly.catalog.find(c => c.caseId === 'C01');
    assert.ok(entry);
    const route = consoleAssembly.routesFor(readiness, consoleAssembly.catalog).get('C01');
    assert.ok(route);
    const bindCase = route.bindCase;
    assert.ok(bindCase);
    const source = { kind: 'catalog' as const, status: 'bound' as const, bindings: [entry] };
    const task = await route.resolveTask({ experimentId: 'exp-bind-throw', source, priorState: null, answers: [] });
    await assert.rejects(async () => await bindCase({ experimentId: 'exp-bind-throw', source, task, priorState: null, answers: [] }), /SIMULATED_BIND_THROW/u);
    for (const dir of countConsoleCopies()) {
      assert.equal(copiesBefore.has(dir), true, `thrown bind working copy ${dir} should have been cleaned up`);
    }
  } finally {
    sc.cleanup();
  }
});

test('serve --host real assembly: wrong presentationDigest (bindingFingerprint) leaves approval readable and decidable', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW_MS });
  const envToken = ['real', 'serve', 'bad', 'dig', '0123'].join('-');
  const sc = await setupServeScenario({ tag: 'bad-digest', extraEnv: { [REAL_CONSOLE_TOKEN_ENV]: envToken } });
  let cliResult: Awaited<ReturnType<typeof runEvaluateCli>> | undefined;
  try {
    const started = await sc.captureStderr(() => runEvaluateCli(['serve', '--host', sc.hostFile]));
    cliResult = started.value;
    assert.equal(cliResult.exitCode, 0);
    const { host, port } = JSON.parse(cliResult.output) as { host: string; port: number };
    const client = makeClient(`http://${host}:${port}`, envToken);

    const startedC01 = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post('/api/experiments', { profileId: sc.profileId, idempotencyKey: client.nextKey('bad-dig-start'), source: { kind: 'catalog', caseIds: ['C01'] } }),
      'bad-dig-start',
    ).experiment;
    assert.equal(startedC01.status, 'waiting-approval');

    const get1 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${startedC01.id}/approval`), 'bad-dig-get1');
    const get2 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${startedC01.id}/approval`), 'bad-dig-get2');
    assert.equal(get2.presentation.bindingFingerprint, get1.presentation.bindingFingerprint);
    assert.notEqual(get1.presentation.bindingFingerprint, get1.presentation.presentationDigest);

    const badVer = await client.post(`/api/experiments/${startedC01.id}/decision`, {
      idempotencyKey: client.nextKey('bad-dig-v0'),
      decision: 'approve',
      expectedVersion: 0,
      presentationDigest: get1.presentation.bindingFingerprint,
    });
    assert.equal(badVer.status, 400);
    assert.deepEqual(badVer.body, { ok: false, error: 'INVALID_DECISION_REQUEST' });

    const badDig = await client.post(`/api/experiments/${startedC01.id}/decision`, {
      idempotencyKey: client.nextKey('bad-dig-v1'),
      decision: 'approve',
      expectedVersion: 1,
      presentationDigest: get1.presentation.bindingFingerprint,
    });
    assert.equal(badDig.status, 409);
    assert.deepEqual(badDig.body, { ok: false, error: 'approval-operation-denied' });

    const get3 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${startedC01.id}/approval`), 'bad-dig-get3');
    assert.equal(get3.presentation.presentationDigest, get1.presentation.presentationDigest);

    const d0 = client.unwrap<DecisionReplyShape>(
      await client.post(`/api/experiments/${startedC01.id}/decision`, {
        idempotencyKey: client.nextKey('bad-dig-ok'),
        decision: 'approve',
        expectedVersion: get3.presentation.requestVersion,
        presentationDigest: get3.presentation.presentationDigest,
      }),
      'bad-dig-ok',
    );
    assert.equal(d0.outcome, 'ok');
    const afterD0 = await client.issueAndContinue(
      startedC01.id,
      { kind: 'resume', expectedTaskVersion: d0.controlVersion, expectedControlVersion: d0.controlVersion, label: 'bad-dig-verify' },
      startedC01.version,
    );
    assert.equal(afterD0.experiment.status, 'waiting-approval');
  } finally {
    await cliResult?.close?.();
    sc.cleanup();
    t.mock.timers.reset();
  }
});

test('serve --host real assembly: clock advance past action TTL during waiting-approval leaves approval readable and decidable', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW_MS });
  const envToken = ['real', 'serve', 'clk', 'adv', '0123'].join('-');
  const sc = await setupServeScenario({ tag: 'clock-adv', extraEnv: { [REAL_CONSOLE_TOKEN_ENV]: envToken } });
  let cliResult: Awaited<ReturnType<typeof runEvaluateCli>> | undefined;
  try {
    const started = await sc.captureStderr(() => runEvaluateCli(['serve', '--host', sc.hostFile]));
    cliResult = started.value;
    assert.equal(cliResult.exitCode, 0);
    const { host, port } = JSON.parse(cliResult.output) as { host: string; port: number };
    const client = makeClient(`http://${host}:${port}`, envToken);

    const startedC01 = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post('/api/experiments', { profileId: sc.profileId, idempotencyKey: client.nextKey('clk-start'), source: { kind: 'catalog', caseIds: ['C01'] } }),
      'clk-start',
    ).experiment;
    assert.equal(startedC01.status, 'waiting-approval');

    const get1 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${startedC01.id}/approval`), 'clk-get1');
    const get2 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${startedC01.id}/approval`), 'clk-get2');
    assert.equal(get2.presentation.presentationDigest, get1.presentation.presentationDigest);

    // Advance doubled Date clock past the default 60s action TTL, then replay the wrong-digest sequence
    t.mock.timers.tick(65_000);

    const badVer = await client.post(`/api/experiments/${startedC01.id}/decision`, {
      idempotencyKey: client.nextKey('clk-bad-v0'),
      decision: 'approve',
      expectedVersion: 0,
      presentationDigest: get1.presentation.bindingFingerprint,
    });
    assert.equal(badVer.status, 400);
    assert.deepEqual(badVer.body, { ok: false, error: 'INVALID_DECISION_REQUEST' });

    const badDig = await client.post(`/api/experiments/${startedC01.id}/decision`, {
      idempotencyKey: client.nextKey('clk-bad-v1'),
      decision: 'approve',
      expectedVersion: 1,
      presentationDigest: get1.presentation.bindingFingerprint,
    });
    assert.equal(badDig.status, 409);
    assert.deepEqual(badDig.body, { ok: false, error: 'approval-operation-denied' });

    const get3 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${startedC01.id}/approval`), 'clk-get3');
    assert.equal(get3.presentation.presentationDigest, get1.presentation.presentationDigest);

    const d0 = client.unwrap<DecisionReplyShape>(
      await client.post(`/api/experiments/${startedC01.id}/decision`, {
        idempotencyKey: client.nextKey('clk-d0-ok'),
        decision: 'approve',
        expectedVersion: get3.presentation.requestVersion,
        presentationDigest: get3.presentation.presentationDigest,
      }),
      'clk-d0-ok',
    );
    assert.equal(d0.outcome, 'ok');

    // A second TTL expiry before resuming AwaitPlan must also resolve cleanly
    t.mock.timers.tick(65_000);
    const afterD0 = await client.issueAndContinue(
      startedC01.id,
      { kind: 'resume', expectedTaskVersion: d0.controlVersion, expectedControlVersion: d0.controlVersion, label: 'clk-verify' },
      startedC01.version,
    );
    assert.equal(afterD0.experiment.status, 'waiting-approval');

    t.mock.timers.tick(65_000);
    const get4 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${startedC01.id}/approval`), 'clk-get4');
    const d1 = client.unwrap<DecisionReplyShape>(
      await client.post(`/api/experiments/${startedC01.id}/decision`, {
        idempotencyKey: client.nextKey('clk-d1-ok'),
        decision: 'approve',
        expectedVersion: get4.presentation.requestVersion,
        presentationDigest: get4.presentation.presentationDigest,
      }),
      'clk-d1-ok',
    );
    const completed = await client.issueAndContinue(
      startedC01.id,
      { kind: 'resume', expectedTaskVersion: d1.controlVersion, expectedControlVersion: d1.controlVersion, label: 'clk-deliver' },
      afterD0.experiment.version,
    );
    assert.equal(completed.experiment.status, 'completed');
  } finally {
    await cliResult?.close?.();
    sc.cleanup();
    t.mock.timers.reset();
  }
});

test('serve --host real assembly: ending NeedsInfo wait closes bounded incomplete, refuses stale/duplicate/revise, and permits a new experiment without restart', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW_MS });
  const envToken = ['real', 'serve', 'c02', 'end', 'token', '0123'].join('-');
  const sc = await setupServeScenario({ tag: 'c02-end', mode: 'clarify', extraEnv: { [REAL_CONSOLE_TOKEN_ENV]: envToken } });
  const copiesBefore = countConsoleCopies();
  let cliResult: Awaited<ReturnType<typeof runEvaluateCli>> | undefined;
  try {
    const started = await sc.captureStderr(() => runEvaluateCli(['serve', '--host', sc.hostFile]));
    cliResult = started.value;
    assert.equal(cliResult.exitCode, 0);
    const { host, port } = JSON.parse(cliResult.output) as { host: string; port: number };
    const client = makeClient(`http://${host}:${port}`, envToken);

    const c02Start = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post('/api/experiments', { profileId: sc.profileId, idempotencyKey: client.nextKey('c02-end-start'), source: { kind: 'catalog', caseIds: ['C02'] } }),
      'c02-end-start',
    ).experiment;
    assert.equal(c02Start.status, 'waiting-info');
    assert.ok(c02Start.workflowClarification);
    const callsAtPause = sc.fetchSpy.requests.length;
    assert.ok(callsAtPause > 0);
    assert.equal(
      [...countConsoleCopies()].some(dir => !copiesBefore.has(dir)),
      true,
      'working copy should exist while paused at NeedsInfo',
    );

    // Starting another experiment while C02 is still paused at NeedsInfo is busy (409 EXPERIMENT_ACTIVE).
    const activeConflict = await client.post('/api/experiments', {
      profileId: sc.profileId,
      idempotencyKey: client.nextKey('c02-busy'),
      source: { kind: 'catalog', caseIds: ['C01'] },
    });
    assert.equal(activeConflict.status, 409);
    assert.deepEqual(activeConflict.body, { ok: false, error: 'EXPERIMENT_ACTIVE' });

    // revise at NeedsInfo must stay refused and leave version unchanged.
    const reviseRefused = await client.post(`/api/experiments/${c02Start.id}/directions`, {
      idempotencyKey: client.nextKey('c02-revise'),
      kind: 'revise',
      expectedTaskVersion: 0,
      expectedControlVersion: 0,
      feedback: 'Revise plan instead of clarify.',
    });
    assert.equal(reviseRefused.status, 409);
    assert.deepEqual(reviseRefused.body, { ok: false, error: 'INVALID_CONTROL_RECEIPT' });

    // Stale version end direction must be refused and leave version unchanged.
    const staleEnd = await client.post(`/api/experiments/${c02Start.id}/directions`, {
      idempotencyKey: client.nextKey('c02-end-stale'),
      kind: 'end',
      expectedTaskVersion: 0,
      expectedControlVersion: 99,
    });
    assert.equal(staleEnd.status, 409);
    assert.deepEqual(staleEnd.body, { ok: false, error: 'INVALID_CONTROL_RECEIPT' });

    const snapBeforeEnd = client.unwrap<ExperimentViewShape>(await client.get(`/api/experiments/${c02Start.id}`), 'c02-before-end');
    assert.equal(snapBeforeEnd.version, c02Start.version);

    // Issue valid end direction at current versions with zero answers.
    const endKey = client.nextKey('c02-end-dir');
    const endDir = client.unwrap<{ experiment: ExperimentViewShape; receipt: { receiptRef: string; kind: string; controlVersion: number } }>(
      await client.post(`/api/experiments/${c02Start.id}/directions`, {
        idempotencyKey: endKey,
        kind: 'end',
        expectedTaskVersion: 0,
        expectedControlVersion: 0,
      }),
      'c02-end-dir',
    );
    assert.equal(endDir.receipt.kind, 'end');
    assert.equal(endDir.receipt.controlVersion, 2);

    // Same-key replay succeeds idempotently.
    const endReplay = client.unwrap<{ experiment: ExperimentViewShape; receipt: { receiptRef: string; controlVersion: number } }>(
      await client.post(`/api/experiments/${c02Start.id}/directions`, {
        idempotencyKey: endKey,
        kind: 'end',
        expectedTaskVersion: 0,
        expectedControlVersion: 0,
      }),
      'c02-end-replay',
    );
    assert.equal(endReplay.receipt.receiptRef, endDir.receipt.receiptRef);
    assert.equal(endReplay.experiment.version, endDir.experiment.version);

    // Duplicate end before /continue (both old 0/0 and updated controlVersion) must be refused and change nothing.
    const dupOldEnd = await client.post(`/api/experiments/${c02Start.id}/directions`, {
      idempotencyKey: client.nextKey('c02-end-dup-old'),
      kind: 'end',
      expectedTaskVersion: 0,
      expectedControlVersion: 0,
    });
    assert.equal(dupOldEnd.status, 409);
    assert.deepEqual(dupOldEnd.body, { ok: false, error: 'INVALID_CONTROL_RECEIPT' });

    const dupCurrentEnd = await client.post(`/api/experiments/${c02Start.id}/directions`, {
      idempotencyKey: client.nextKey('c02-end-dup-cur'),
      kind: 'end',
      expectedTaskVersion: endDir.receipt.controlVersion,
      expectedControlVersion: endDir.receipt.controlVersion,
    });
    assert.equal(dupCurrentEnd.status, 409);
    assert.deepEqual(dupCurrentEnd.body, { ok: false, error: 'INVALID_CONTROL_RECEIPT' });

    const snapBeforeCont = client.unwrap<ExperimentViewShape>(await client.get(`/api/experiments/${c02Start.id}`), 'c02-before-cont');
    assert.equal(snapBeforeCont.version, endDir.experiment.version);

    // Continue with the end direction -> bounded INCOMPLETE outcome, zero extra model calls, zero patches, copy removed.
    const ended = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post(`/api/experiments/${c02Start.id}/continue`, {
        idempotencyKey: client.nextKey('c02-end-cont'),
        directionRef: endDir.receipt.receiptRef,
        expectedVersion: endDir.experiment.version,
      }),
      'c02-end-cont',
    ).experiment;
    assert.equal(ended.status, 'incomplete');
    assert.equal(ended.control, null);
    assert.equal(ended.workflowClarification, null);
    assert.equal(ended.workflowReport?.cases[0]?.workflowOutcome, 'INCOMPLETE');
    assert.equal(ended.workflowReport?.cases[0]?.grade, 'not-run');
    assert.equal(sc.fetchSpy.requests.length, callsAtPause);
    assert.equal(
      sc.fetchSpy.requests.some(req => req.purpose !== 'propose-plan'),
      false,
      'ending NeedsInfo must not request any patch generation',
    );
    assertNoLeaks(JSON.stringify(ended), sc.secrets(envToken), 'c02 ended report');
    for (const dir of countConsoleCopies()) {
      assert.equal(copiesBefore.has(dir), true, `ended NeedsInfo temporary copy ${dir} should have been cleaned up`);
    }

    // Post-terminal duplicate end, revise, and duplicate continue must be refused and change nothing.
    const postTermEnd = await client.post(`/api/experiments/${c02Start.id}/directions`, {
      idempotencyKey: client.nextKey('c02-post-end'),
      kind: 'end',
      expectedTaskVersion: endDir.receipt.controlVersion,
      expectedControlVersion: endDir.receipt.controlVersion,
    });
    assert.equal(postTermEnd.status, 409);
    assert.deepEqual(postTermEnd.body, { ok: false, error: 'INVALID_CONTROL_RECEIPT' });

    const postTermRevise = await client.post(`/api/experiments/${c02Start.id}/directions`, {
      idempotencyKey: client.nextKey('c02-post-revise'),
      kind: 'revise',
      expectedTaskVersion: endDir.receipt.controlVersion,
      expectedControlVersion: endDir.receipt.controlVersion,
      feedback: 'Revise after terminal.',
    });
    assert.equal(postTermRevise.status, 409);
    assert.deepEqual(postTermRevise.body, { ok: false, error: 'INVALID_CONTROL_RECEIPT' });

    const dupContinue = await client.post(`/api/experiments/${c02Start.id}/continue`, {
      idempotencyKey: client.nextKey('c02-dup-cont'),
      directionRef: endDir.receipt.receiptRef,
      expectedVersion: ended.version,
    });
    assert.equal(dupContinue.status, 409);
    assert.deepEqual(dupContinue.body, { ok: false, error: 'DIRECTION_ALREADY_CONSUMED' });

    const snapAfterPost = client.unwrap<ExperimentViewShape>(await client.get(`/api/experiments/${c02Start.id}`), 'c02-after-post');
    assert.equal(snapAfterPost.version, ended.version);
    assert.equal(snapAfterPost.status, 'incomplete');

    // A new experiment can start and complete immediately on the same server without restart.
    const nextC01 = client.unwrap<{ experiment: ExperimentViewShape }>(
      await client.post('/api/experiments', { profileId: sc.profileId, idempotencyKey: client.nextKey('next-c01-start'), source: { kind: 'catalog', caseIds: ['C01'] } }),
      'next-c01-start',
    ).experiment;
    assert.equal(nextC01.status, 'waiting-approval');
    assert.notEqual(nextC01.id, c02Start.id);

    const p0 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${nextC01.id}/approval`), 'next-p0');
    const d0 = client.unwrap<DecisionReplyShape>(
      await client.post(`/api/experiments/${nextC01.id}/decision`, {
        idempotencyKey: client.nextKey('next-d0'),
        decision: 'approve',
        expectedVersion: p0.presentation.requestVersion,
        presentationDigest: p0.presentation.presentationDigest,
      }),
      'next-d0',
    );
    const afterD0 = await client.issueAndContinue(
      nextC01.id,
      { kind: 'resume', expectedTaskVersion: d0.controlVersion, expectedControlVersion: d0.controlVersion, label: 'next-verify' },
      nextC01.version,
    );
    assert.equal(afterD0.experiment.status, 'waiting-approval');
    const p1 = client.unwrap<ApprovalPresentationShape>(await client.get(`/api/experiments/${nextC01.id}/approval`), 'next-p1');
    const d1 = client.unwrap<DecisionReplyShape>(
      await client.post(`/api/experiments/${nextC01.id}/decision`, {
        idempotencyKey: client.nextKey('next-d1'),
        decision: 'approve',
        expectedVersion: p1.presentation.requestVersion,
        presentationDigest: p1.presentation.presentationDigest,
      }),
      'next-d1',
    );
    const completed = await client.issueAndContinue(
      nextC01.id,
      { kind: 'resume', expectedTaskVersion: d1.controlVersion, expectedControlVersion: d1.controlVersion, label: 'next-deliver' },
      afterD0.experiment.version,
    );
    assert.equal(completed.experiment.status, 'completed');
    for (const dir of countConsoleCopies()) {
      assert.equal(copiesBefore.has(dir), true, `follow-up C01 temporary copy ${dir} should have been cleaned up`);
    }
  } finally {
    await cliResult?.close?.();
    sc.cleanup();
    t.mock.timers.reset();
  }
});
