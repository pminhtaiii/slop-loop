/**
 * Feature 007 T011 (#257) integration suite:
 * `evaluate run --host <host.json> --mode real` end-to-end with controlled
 * fetch, spawn, clock, and OperatorIo doubles (zero live model calls, zero real Docker).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileURLToPath, pathToFileURL } from 'node:url';

import type { WorkflowEvaluationReport } from '../../../eval/uc03/types.ts';

import type { BugTask } from '../../../src/contracts/foundation/uc03.ts';
import type { StructuredSpawn } from '../../../src/foundation/docker-controller.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import type { OperatorIo } from '../../../src/runtime/real-tier-case-operator.ts';
import { REAL_TIER_DELIVERY_CONTRACT } from '../../../src/runtime/real-tier-owners.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { createVolumeSpawn } from '../support/docker-volume-spawn.ts';
import { createScanFixture } from '../unit/real-tier-scan-fixtures.ts';

const SOURCE = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
export const REV = 'a'.repeat(40);
export const RETURNED_MODEL = 'deepseek-v4.1-flash';
export const GRADER_SECRET = 'GRADER_PRIVATE_ORACLE_9876';
export const GRADER_FILE = 'test_private_grader_oracle.py';

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
  profileId: 't011-grader-profile',
  digest: `sha256:${sha256Text('t011-grader-profile')}`,
  bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 8 },
};

const GRADER_CRITERIA = {
  digest: `sha256:${sha256Text('t011-criteria')}`,
  criteria: [
    { criterionId: 'crit-c01', caseId: 'C01', predicate: 'repair-success', hiddenCheckId: 'hidden-C01' },
    { criterionId: 'crit-c02', caseId: 'C02', predicate: 'clarification', hiddenCheckId: null },
  ],
};

interface FetchRecord {
  readonly role: string;
  readonly purpose: string;
  readonly bodyText: string;
}

interface HarnessState {
  readonly env: Record<string, string | undefined>;
  readonly fetch: typeof globalThis.fetch;
  readonly spawn: StructuredSpawn;
  readonly stateRoot: string;
  readonly revision: string;
  readonly operatorIo: OperatorIo;
}

declare global {
  var __t011Harness: HarnessState | undefined;
}

export function parseCliReport(output: string): WorkflowEvaluationReport {
  const marker = output.lastIndexOf('\nUC-03 Workflow Evaluation [');
  const jsonText = marker === -1 ? output : output.slice(0, marker);
  return JSON.parse(jsonText) as WorkflowEvaluationReport;
}

function makeTask(tag: string, initialRevisionDigest: string): BugTask {
  return {
    taskId: `task-prod-${tag}`,
    repositoryId: `repo-prod-${tag}`,
    initialRevisionDigest,
    goal: 'Handle division by zero cleanly',
    observedBehavior: 'ZeroDivisionError on zero divisor',
    expectedBehavior: tag === 'C02' ? 'Clarify error type or fallback value before changing behavior' : 'Raise CalculationError when divisor is zero',
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

function createFetchDouble(mode: 'repair' | 'clarify'): { readonly fetch: typeof globalThis.fetch; readonly requests: FetchRecord[] } {
  const requests: FetchRecord[] = [];
  let msgSeq = 0;

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
      if (!hasEvidence) {
        replyObj = { kind: 'inspect', proposalId: `insp-${++msgSeq}`, operation: 'read_file', args: { path: 'src/calculator.py' } };
      } else if (mode === 'clarify') {
        replyObj = {
          kind: 'request-info',
          proposalId: `ask-${++msgSeq}`,
          questions: [{ questionId: 'q1', text: 'Should division by zero raise CalculationError or return None?' }],
          evidenceRefs: ['src/calculator.py'],
        };
      } else {
        replyObj = {
          kind: 'propose-plan',
          proposalId: `plan-${++msgSeq}`,
          diagnosis: 'divide() does not guard b == 0 before performing floating-point division.',
          strategy: 'Guard b == 0 in divide() and raise CalculationError.',
          suspectedLocations: ['src/calculator.py'],
          scopedPaths: ['src/calculator.py'],
          evidenceRefs: ['src/calculator.py'],
        };
      }
    } else {
      replyObj = {
        kind: 'propose-patch',
        proposalId: `patch-${++msgSeq}`,
        diff: PATCH_DIFF,
        targetPaths: ['src/calculator.py'],
        approvedPlanRef: prompt.task?.plan?.decisionRef ?? '',
      };
    }

    return new Response(
      JSON.stringify({
        id: `msg_${++msgSeq}`,
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

function createCombinedSpawn(dockerMode: 'ok' | 'down' | 'mismatch' = 'ok') {
  const volumeSub = createVolumeSpawn();
  const hiddenChecks: { readonly args: readonly string[] }[] = [];
  const spawnCalls: { readonly command: string; readonly args: readonly string[] }[] = [];

  const spawn: StructuredSpawn = async (command, args, options) => {
    spawnCalls.push({ command, args: [...args] });
    if (command !== 'docker') return { exitCode: 1, stdout: '', stderr: 'unexpected command', timedOut: false };

    if (args[0] === 'version') {
      return dockerMode === 'down' ? { exitCode: 1, stdout: '', stderr: 'daemon unavailable', timedOut: false } : { exitCode: 0, stdout: '27.3.1\n', stderr: '', timedOut: false };
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      return dockerMode === 'mismatch' ? { exitCode: 1, stdout: '', stderr: 'No such image', timedOut: false } : { exitCode: 0, stdout: `${args[4]}\n`, stderr: '', timedOut: false };
    }
    if (args[0] === 'volume' || args[0] === 'rm' || args[0] === 'kill') {
      return volumeSub.spawn(command, args, options);
    }

    if (args[0] === 'run' && args.some(a => a.includes('target=/grader'))) {
      hiddenChecks.push({ args: [...args] });
      const repoMount = args.find(a => a.includes('target=/workspace/repo'));
      const snapDir = repoMount?.match(/source=([^,]+)/u)?.[1];
      const calcPath = snapDir ? join(snapDir, 'src', 'calculator.py') : '';
      const fixed = snapDir !== undefined && calcPath !== '' && existsSync(calcPath) ? new WorkspaceFilesystemPort({ root: snapDir }).readTextFile('src/calculator.py', 65_536) : Promise.resolve('');
      const content = await fixed;
      return content.includes('raise CalculationError')
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

  return { spawn, hiddenChecks, spawnCalls };
}

function writeAssemblyWrapper(root: string): string {
  const path = join(root, 'assembly-wrapper.mjs');
  const assemblyUrl = pathToFileURL(fileURLToPath(new URL(`../../../src/runtime/real-tier-assembly${SOURCE}`, import.meta.url))).href;
  writeFileSync(
    path,
    `import { createHostAssembly as realCreate } from ${JSON.stringify(assemblyUrl)};
export function createHostAssembly() {
  const h = globalThis.__t011Harness;
  return realCreate({ env: h.env, fetch: h.fetch, spawn: h.spawn, stateRoot: h.stateRoot, revision: h.revision, operatorIo: h.operatorIo });
}
`,
    'utf8',
  );
  return path;
}

export async function setupProductionScenario(opts: {
  tag: string;
  fetchMode?: 'repair' | 'clarify';
  dockerMode?: 'ok' | 'down' | 'mismatch';
  decisions?: readonly ('approve' | 'reject' | undefined)[];
  envOverrides?: Record<string, string | undefined>;
  omitCatalogC01?: boolean;
  graderMode?: 'valid' | 'bad-digest' | 'missing-file' | 'null-payload';
  hostPatch?: Record<string, unknown>;
}) {
  const fixture = createScanFixture(`t011-${opts.tag}-`, `t011-key-${opts.tag}`);
  const root = mkdtempSync(join(tmpdir(), `t011-root-${opts.tag}-`));
  const stateRoot = mkdtempSync(join(tmpdir(), `t011-state-${opts.tag}-`));

  const createRepo = async (caseId: string) => {
    const repoDir = join(root, `repo-${caseId}`);
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    mkdirSync(join(repoDir, 'tests'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'calculator.py'), INITIAL_CALC_PY, 'utf8');
    writeFileSync(join(repoDir, 'tests', 'test_calculator.py'), TEST_CALC_PY, 'utf8');
    const initialDigest = await new WorkspaceFilesystemPort({ root: repoDir }).getCurrentRevisionDigest();
    const task = makeTask(caseId, initialDigest);
    const fixtureDoc = JSON.stringify({ task, repositoryRoot: `repo-${caseId}` });
    const fixturePath = join(root, `fixture-${caseId}.json`);
    writeFileSync(fixturePath, fixtureDoc, 'utf8');
    return { caseId, initialDigest, fixturePath, fixtureDigest: sha256Text(fixtureDoc) };
  };

  const c01 = await createRepo('C01');
  const c02 = await createRepo('C02');

  const c01GraderDoc = JSON.stringify({
    criteria: GRADER_CRITERIA,
    profile: GRADER_PROFILE,
    graderPayload:
      opts.graderMode === 'null-payload'
        ? null
        : {
            files: { [GRADER_FILE]: `def test_hidden_oracle():\n    # ${GRADER_SECRET}\n    pass\n` },
            argv: ['pytest', '-q', `/grader/${GRADER_FILE}`],
          },
  });
  const c01GraderPath = join(root, 'grader-c01.json');
  if (opts.graderMode !== 'missing-file') writeFileSync(c01GraderPath, c01GraderDoc, 'utf8');
  const c01GraderDigest = opts.graderMode === 'bad-digest' ? `sha256:${'f'.repeat(64)}` : `sha256:${sha256Text(c01GraderDoc)}`;

  const c02GraderDoc = JSON.stringify({ criteria: GRADER_CRITERIA, profile: GRADER_PROFILE, graderPayload: null });
  const c02GraderPath = join(root, 'grader-c02.json');
  writeFileSync(c02GraderPath, c02GraderDoc, 'utf8');
  const c02GraderDigest = `sha256:${sha256Text(c02GraderDoc)}`;

  const catalogEntries = [
    ...(opts.omitCatalogC01
      ? []
      : [
          {
            caseId: 'C01',
            initialRepositoryDigest: c01.initialDigest.replace(/^sha256:/u, ''),
            fixturePath: c01.fixturePath,
            fixtureDigest: c01.fixtureDigest,
            grader: { path: c01GraderPath, digest: c01GraderDigest },
          },
        ]),
    {
      caseId: 'C02',
      initialRepositoryDigest: c02.initialDigest.replace(/^sha256:/u, ''),
      fixturePath: c02.fixturePath,
      fixtureDigest: c02.fixtureDigest,
      grader: { path: c02GraderPath, digest: c02GraderDigest },
    },
  ];
  const catalogPath = join(root, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify({ catalog: catalogEntries }), 'utf8');

  const baseEnv = fixture.envOf({ catalog: { path: catalogPath } });
  const env = { ...baseEnv, ...(opts.envOverrides ?? {}) };

  const fetchSpy = createFetchDouble(opts.fetchMode ?? 'repair');
  const spawnSpy = createCombinedSpawn(opts.dockerMode ?? 'ok');
  const decisionQueue = [...(opts.decisions ?? ['approve', 'approve'])];
  const operatorPrompts: string[] = [];
  let operatorReads = 0;

  const operatorIo: OperatorIo = {
    write: line => operatorPrompts.push(line),
    read: async () => {
      operatorReads += 1;
      return decisionQueue.shift();
    },
  };

  globalThis.__t011Harness = {
    env,
    fetch: fetchSpy.fetch,
    spawn: spawnSpy.spawn,
    stateRoot,
    revision: REV,
    operatorIo,
  };

  const wrapperPath = writeAssemblyWrapper(root);
  const { resolveRealTierAssembly } = await import(`../../../src/runtime/real-tier-assembly${SOURCE}`);
  const probed = resolveRealTierAssembly({ env: baseEnv, stateRoot, revision: REV, spawn: spawnSpy.spawn });
  assert.equal(probed.status, 'assembly-ready');

  const binding = {
    profileDigest: probed.metadata.profileDigest,
    configDigest: `sha256:${sha256Text(JSON.stringify({ limits: probed.profile.limits, runLimits: probed.profile.runLimits }))}`,
    pricingDigest: `sha256:${sha256Text(JSON.stringify(probed.profile.pricing))}`,
    adapterVersions: ['uc03-adapter-1'] as const,
    requestedModel: probed.metadata.model,
  };

  const hostFile = join(root, 'host.json');
  writeFileSync(
    hostFile,
    JSON.stringify({
      profileId: 't011-profile',
      ...binding,
      contractVersion: REAL_TIER_DELIVERY_CONTRACT,
      revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(c => [c, REV])),
      assembly: wrapperPath,
      ...(opts.hostPatch ?? {}),
    }),
    'utf8',
  );

  return {
    hostFile,
    binding,
    c01InitialDigest: c01.initialDigest,
    c01GraderDigest,
    fetchSpy,
    spawnSpy,
    operatorPrompts,
    getOperatorReads: () => operatorReads,
    cleanup: () => {
      globalThis.__t011Harness = undefined;
      rmSync(fixture.OUTSIDE, { recursive: true, force: true });
      rmSync(fixture.REPO, { recursive: true, force: true });
      rmSync(fixture.BASE, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    },
  };
}

export function prodCopyTempCount(): number {
  return readdirSync(tmpdir()).filter(name => name.startsWith(`uc03-real-prod-copy-${process.pid}-`)).length;
}
