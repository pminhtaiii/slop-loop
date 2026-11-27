import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { BugTask } from '../../../src/contracts/foundation/uc03.ts';
import type { RealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import { resolvePinnedGrader, type CaseGradeRequest, type GraderCapability } from '../../../src/runtime/real-tier-case-grade.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import type { UC03WorkflowResult } from '../../../src/uc03/graph-types.ts';
import { parseWorkflowFinalTree } from '../../../eval/uc03/workflow-evidence-facts.ts';

const PROFILE = {
  profileId: 'unit-grader-profile',
  digest: `sha256:${sha256Text('unit-grader-profile')}`,
  bounds: {
    timeoutMs: 10_000,
    maxCpuMs: 5_000,
    maxOutputBytes: 65_536,
    maxMemoryBytes: 536_870_912,
    maxProcesses: 8,
  },
};

const CRITERIA = {
  digest: `sha256:${sha256Text('unit-criteria')}`,
  criteria: [{ criterionId: 'criterion-C01', caseId: 'C01', predicate: 'repair-success', hiddenCheckId: 'hidden-C01' }],
};

const PAYLOAD = {
  files: { 'test_grade.py': 'def test_pass(): pass\n' },
  argv: ['pytest', '-q', '/grader/test_grade.py'],
};

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rtcg-${prefix}-`));
}

function makeAssembly(catalogPath: string): RealTierAssembly {
  return {
    profile: {
      catalog: { path: catalogPath },
      image: { platform: 'linux/amd64', user: 'root' },
    },
    metadata: { imageId: 'img-test' },
  } as unknown as RealTierAssembly;
}

test('Finding 1 (4683701529): inaccessible grader input yields bounded unreadable refusal, not thrown error', t => {
  const dir = createTempDir('inaccessible');
  try {
    const regularFile = join(dir, 'file.txt');
    writeFileSync(regularFile, 'regular file content', 'utf8');

    // A path below a regular file makes statSync throw ENOTDIR on POSIX despite throwIfNoEntry: false.
    const inaccessiblePath = join(regularFile, 'child.json');
    let exercisedCode: string | undefined;
    try {
      statSync(inaccessiblePath, { throwIfNoEntry: false });
    } catch (err: unknown) {
      exercisedCode = (err as { code?: string })?.code ?? 'unknown';
    }
    if (exercisedCode === undefined) {
      t.skip('this platform reports a path below a regular file as absent, so no stat error can be exercised');
      return;
    }

    // 1. Inaccessible catalog input
    const catalogAssembly = makeAssembly(inaccessiblePath);
    const catalogRes = resolvePinnedGrader(catalogAssembly, 'C01', undefined);
    assert.equal(catalogRes.status, 'unavailable', `Expected unavailable for inaccessible catalog exercising ${exercisedCode}`);
    if (catalogRes.status === 'unavailable') {
      assert.equal(catalogRes.reasonCode, 'grader-catalog-unavailable');
      assert.deepEqual(catalogRes.missing, ['catalog']);
    }

    // 2. Inaccessible grader file input
    const catalogPath = join(dir, 'catalog.json');
    writeFileSync(
      catalogPath,
      JSON.stringify({
        catalog: [
          {
            caseId: 'C01',
            grader: { path: inaccessiblePath, digest: `sha256:${'0'.repeat(64)}` },
          },
        ],
      }),
      'utf8',
    );
    const graderAssembly = makeAssembly(catalogPath);
    const graderRes = resolvePinnedGrader(graderAssembly, 'C01', undefined);
    assert.equal(graderRes.status, 'unavailable', `Expected unavailable for inaccessible grader file exercising ${exercisedCode}`);
    if (graderRes.status === 'unavailable') {
      assert.equal(graderRes.reasonCode, 'grader-file-unreadable');
      assert.deepEqual(graderRes.missing, ['catalog.grader.path']);
    }

    // 3. Keep malformed JSON distinct from unreadable
    const malformedCatalogPath = join(dir, 'malformed-catalog.json');
    writeFileSync(malformedCatalogPath, '{ not valid json', 'utf8');
    const malformedCatalogRes = resolvePinnedGrader(makeAssembly(malformedCatalogPath), 'C01', undefined);
    assert.equal(malformedCatalogRes.status, 'unavailable');
    if (malformedCatalogRes.status === 'unavailable') {
      assert.equal(malformedCatalogRes.reasonCode, 'grader-catalog-malformed');
      assert.deepEqual(malformedCatalogRes.missing, ['catalog']);
    }

    const malformedGraderPath = join(dir, 'malformed-grader.json');
    writeFileSync(malformedGraderPath, '{ not valid json', 'utf8');
    const catalogWithMalformedGrader = join(dir, 'catalog-malformed-grader.json');
    writeFileSync(
      catalogWithMalformedGrader,
      JSON.stringify({
        catalog: [
          {
            caseId: 'C01',
            grader: { path: malformedGraderPath, digest: `sha256:${'0'.repeat(64)}` },
          },
        ],
      }),
      'utf8',
    );
    const malformedGraderRes = resolvePinnedGrader(makeAssembly(catalogWithMalformedGrader), 'C01', undefined);
    assert.equal(malformedGraderRes.status, 'unavailable');
    if (malformedGraderRes.status === 'unavailable') {
      assert.equal(malformedGraderRes.reasonCode, 'grader-file-malformed');
      assert.deepEqual(malformedGraderRes.missing, ['catalog.grader']);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Finding 2 (4683701540): single read hashes and parses identical bytes; digest check mismatch refuses', () => {
  const dir = createTempDir('single-read');
  try {
    const graderRaw = JSON.stringify({
      criteria: CRITERIA,
      profile: PROFILE,
      graderPayload: PAYLOAD,
    });
    const correctDigest = `sha256:${sha256Text(graderRaw)}`;
    const graderPath = join(dir, 'grader.json');
    writeFileSync(graderPath, graderRaw, 'utf8');

    // 1. Correctly pinned file resolves with fields matching the hashed bytes
    const catalogPath = join(dir, 'catalog.json');
    writeFileSync(
      catalogPath,
      JSON.stringify({
        catalog: [{ caseId: 'C01', grader: { path: graderPath, digest: correctDigest } }],
      }),
      'utf8',
    );

    const dummyCapability: GraderCapability = {
      tier: 'controlled-tier',
      isolationAuthority: { admit: async () => ({ kind: 'injected-mock-isolation-admission' }) },
      executor: { executorId: 'ex-1', execute: async () => ({ status: 'pass' }) as never },
      finalTree: {
        freezeFinalTree: async b => ({ ...b, snapshotId: 's', complete: true, files: [] }),
        recheckCurrentFinalTree: async b => ({ ...b, snapshotId: 's', complete: true, files: [] }),
      },
    };

    const res = resolvePinnedGrader(makeAssembly(catalogPath), 'C01', dummyCapability);
    assert.equal(res.status, 'ready');

    // 2. Digest mismatch refuses with grader-digest-mismatch
    const staleDigest = `sha256:${sha256Text('stale-content')}`;
    const staleCatalogPath = join(dir, 'stale-catalog.json');
    writeFileSync(
      staleCatalogPath,
      JSON.stringify({
        catalog: [{ caseId: 'C01', grader: { path: graderPath, digest: staleDigest } }],
      }),
      'utf8',
    );

    const staleRes = resolvePinnedGrader(makeAssembly(staleCatalogPath), 'C01', dummyCapability);
    assert.equal(staleRes.status, 'unavailable');
    if (staleRes.status === 'unavailable') {
      assert.equal(staleRes.reasonCode, 'grader-digest-mismatch');
      assert.deepEqual(staleRes.missing, ['catalog.grader.digest']);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Finding 3 (4683701547): two overlapping grade calls on one resolution each receive exactly one admission and succeed', async () => {
  const dir = createTempDir('serialize');
  try {
    const graderRaw = JSON.stringify({
      criteria: CRITERIA,
      profile: PROFILE,
      graderPayload: PAYLOAD,
    });
    const graderPath = join(dir, 'grader.json');
    writeFileSync(graderPath, graderRaw, 'utf8');

    const catalogPath = join(dir, 'catalog.json');
    writeFileSync(
      catalogPath,
      JSON.stringify({
        catalog: [{ caseId: 'C01', grader: { path: graderPath, digest: `sha256:${sha256Text(graderRaw)}` } }],
      }),
      'utf8',
    );

    let admissionCounter = 0;
    const admissionLog: string[] = [];

    const capability: GraderCapability = {
      tier: 'controlled-tier',
      isolationAuthority: {
        admit: async request => {
          admissionCounter += 1;
          const admissionId = `adm-token-${admissionCounter}`;
          admissionLog.push(admissionId);
          // Yield to event loop to encourage interleaving if not serialized
          await new Promise(resolve => setTimeout(resolve, 20));
          return {
            kind: 'injected-mock-isolation-admission',
            admissionId,
            ...request,
          };
        },
      },
      executor: {
        executorId: 'unit-executor',
        execute: async request => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return {
            checkId: request.checkId,
            finalSnapshot: request.finalSnapshot,
            profile: request.profile,
            executorId: request.executorId,
            status: 'pass',
            actualOutcome: 'COMPLETED',
            durationMs: 5,
            cpuMs: 2,
            outputBytes: 50,
          };
        },
      },
      finalTree: {
        freezeFinalTree: async binding => ({
          ...binding,
          snapshotId: 'snap-c01',
          complete: true,
          files: [{ path: 'calculator.py', content: 'def divide(a, b): return a / b\n' }],
        }),
        recheckCurrentFinalTree: async binding => ({
          ...binding,
          snapshotId: 'snap-c01',
          complete: true,
          files: [{ path: 'calculator.py', content: 'def divide(a, b): return a / b\n' }],
        }),
      },
      deriveFacts: async input => {
        const final = input.result.executionEvidence?.finalState;
        if (!final) return undefined;
        const binding = {
          taskId: final.taskId,
          runId: final.runId,
          workspaceId: final.workspaceId,
          repositoryId: final.repositoryId,
          initialRevisionDigest: input.task.initialRevisionDigest,
          finalRevisionDigest: final.repositoryRevisionDigest,
        };
        const parsed = parseWorkflowFinalTree(await input.finalTree.freezeFinalTree(binding), binding);
        if (!parsed) return undefined;
        const diff = input.result.finalReport?.diff.diffDigest ?? `sha256:${'c'.repeat(64)}`;
        return {
          snapshot: parsed.snapshot,
          evidence: {
            digest: `sha256:${sha256Text(parsed.snapshot.digest)}`,
            snapshotDigest: parsed.snapshot.digest,
            diffDigest: diff,
            baselineFailed: true,
            requiredChecksPassed: true,
            focusedCheckPassed: true,
            testsProtected: true,
            reviewAccepted: true,
            reviewedDiffDigest: diff,
            sentinelsUnchanged: true,
            speculativePatchApplied: false,
            stoppedBeforeEffect: false,
            completionWithheld: false,
          },
        };
      },
    };

    const resolution = resolvePinnedGrader(makeAssembly(catalogPath), 'C01', capability);
    assert.equal(resolution.status, 'ready');
    if (resolution.status !== 'ready') return;

    const makeRequest = (id: string): CaseGradeRequest => {
      const state = {
        taskId: `task-${id}`,
        runId: `run-${id}`,
        workspaceId: `ws-${id}`,
        repositoryId: 'repo-test',
        repositoryRevisionDigest: `sha256:${'1'.repeat(64)}`,
      };
      return {
        caseId: 'C01',
        task: {
          taskId: `task-${id}`,
          repositoryId: 'repo-test',
          initialRevisionDigest: `sha256:${'2'.repeat(64)}`,
        } as unknown as BugTask,
        result: {
          outcome: 'COMPLETED',
          state,
          executionEvidence: { finalState: state },
          finalReport: {
            taskId: `task-${id}`,
            runId: `run-${id}`,
            repositoryId: 'repo-test',
            outcome: 'COMPLETED',
            isComplete: true,
            diff: { diffDigest: `sha256:${'3'.repeat(64)}`, changedFiles: ['calculator.py'] },
            evidence: { verificationRefs: ['v1'], reviewRef: 'r1', evidenceRefs: ['e1'] },
            limitations: [],
            failureReasons: [],
            safeNextAction: 'none',
            usage: { tokensConsumed: 50, costUsd: 0.005, replanCount: 0, perLedger: [] },
            milestones: [],
            generatedAt: new Date().toISOString(),
          },
        } as unknown as UC03WorkflowResult,
        ports: {} as CaseGradeRequest['ports'],
        model: 'model-conformed',
        repositoryRoot: dir,
        requiresAdmission: true,
      };
    };

    const req1 = makeRequest('call-1');
    const req2 = makeRequest('call-2');

    // Run overlapping grade calls on the same resolution
    const [outcome1, outcome2] = await Promise.all([resolution.grade(req1), resolution.grade(req2)]);

    assert.ok(outcome1 && !('refusal' in outcome1), `Call 1 should succeed, got: ${JSON.stringify(outcome1)}`);
    assert.ok(outcome2 && !('refusal' in outcome2), `Call 2 should succeed, got: ${JSON.stringify(outcome2)}`);

    assert.equal(outcome1.grade.grade, 'pass');
    assert.equal(outcome2.grade.grade, 'pass');

    // Each call must bind its own unique admission issued during its serialized window
    assert.equal(outcome1.binding.admissionId, 'adm-token-1');
    assert.equal(outcome2.binding.admissionId, 'adm-token-2');
    assert.deepEqual(admissionLog, ['adm-token-1', 'adm-token-2']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real-route missing snapshot evidence never reports the controlled-tier limitation', async () => {
  const dir = createTempDir('real-not-run');
  try {
    const graderRaw = JSON.stringify({ criteria: CRITERIA, profile: PROFILE, graderPayload: PAYLOAD });
    const graderPath = join(dir, 'grader.json');
    const catalogPath = join(dir, 'catalog.json');
    writeFileSync(graderPath, graderRaw, 'utf8');
    writeFileSync(catalogPath, JSON.stringify({ catalog: [{ caseId: 'C01', grader: { path: graderPath, digest: `sha256:${sha256Text(graderRaw)}` } }] }), 'utf8');
    const capability: GraderCapability = {
      tier: 'real-tier',
      isolationAuthority: { admit: () => assert.fail('missing evidence must not admit a hidden check') },
      executor: { executorId: 'unused-real-executor', execute: () => assert.fail('missing evidence must not execute a hidden check') },
      finalTree: { freezeFinalTree: () => undefined, recheckCurrentFinalTree: () => undefined },
    };
    const resolution = resolvePinnedGrader(makeAssembly(catalogPath), 'C01', capability);
    assert.equal(resolution.status, 'ready');
    if (resolution.status !== 'ready') return;
    const host = resolution.evidenceHost({ taskId: 'task-missing-evidence' } as BugTask, dir);
    const result = await host.grader.grade('C01', {});
    assert.equal(result.grade, 'not-run');
    assert.equal(result.reason, 'invalid-observation');
    assert.equal(
      result.limitations.some(value => value.startsWith('Controlled-tier grade only;')),
      false,
    );
    assert.equal(
      result.limitations.some(value => value.includes('admitted by')),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
