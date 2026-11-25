/**
 * Focused unit regressions for real-tier case execution and operator handling
 * (PR #260 CodeRabbit findings).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { CommandView } from '../../../src/contracts/foundation/uc03.ts';
import type { RealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import { findSettledCommandAdmission } from '../../../src/runtime/real-tier-case-run.ts';
import { createOperatorDecisionSource, type DecisionTarget, type OperatorIo } from '../../../src/runtime/real-tier-case-operator.ts';
import { buildCaseEvidence } from '../integration/uc03-success-real-run-cases.ts';

function createMockAssemblyWithClaimDir(claimDir: string): RealTierAssembly {
  return {
    owners: {
      taskOwners: () => ({
        statePort: {
          store: {
            getClaimPath: (_taskId: string, claimId: string) => join(claimDir, `${claimId}.json`),
          },
        },
      }),
    },
  } as unknown as RealTierAssembly;
}

const sampleCommandViewA: CommandView = {
  viewId: 'view-c01-1',
  viewDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  taskId: 'task-c01-001',
  workspaceId: 'ws-c01',
  canonicalRevisionDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  admittedFiles: [{ path: 'src/calc.py', digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111' }],
  exclusionsPolicyVersion: '1.0.0',
  scratchIdentity: 'scratch-1',
  mountedReadOnly: true,
};

const sampleCommandViewBReordered: CommandView = {
  mountedReadOnly: true,
  scratchIdentity: 'scratch-1',
  exclusionsPolicyVersion: '1.0.0',
  admittedFiles: [{ digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111', path: 'src/calc.py' }],
  canonicalRevisionDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  workspaceId: 'ws-c01',
  taskId: 'task-c01-001',
  viewDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  viewId: 'view-c01-1',
};

const sampleCommandViewCDifferentAdmittedDigest: CommandView = {
  ...sampleCommandViewA,
  admittedFiles: [{ path: 'src/calc.py', digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222' }],
};

test('finding 4683701580: command-view digest changes when nested admitted-file digest changes and is stable on key reordering', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'claim-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'claim-b-'));
  const dirC = mkdtempSync(join(tmpdir(), 'claim-c-'));

  try {
    writeFileSync(
      join(dirA, 'claim.json'),
      JSON.stringify({
        status: 'settled',
        context: { subjectKind: 'repository-action', commandView: sampleCommandViewA },
        receipt: { claimId: 'claim-a' },
      }),
      'utf8',
    );
    writeFileSync(
      join(dirB, 'claim.json'),
      JSON.stringify({
        status: 'settled',
        context: { subjectKind: 'repository-action', commandView: sampleCommandViewBReordered },
        receipt: { claimId: 'claim-b' },
      }),
      'utf8',
    );
    writeFileSync(
      join(dirC, 'claim.json'),
      JSON.stringify({
        status: 'settled',
        context: { subjectKind: 'repository-action', commandView: sampleCommandViewCDifferentAdmittedDigest },
        receipt: { claimId: 'claim-c' },
      }),
      'utf8',
    );

    const ids = { taskId: 'task-c01-001', workspaceId: 'ws-c01' };
    const resA = findSettledCommandAdmission(createMockAssemblyWithClaimDir(dirA), ids, 'repo-1');
    const resB = findSettledCommandAdmission(createMockAssemblyWithClaimDir(dirB), ids, 'repo-1');
    const resC = findSettledCommandAdmission(createMockAssemblyWithClaimDir(dirC), ids, 'repo-1');

    assert.ok(resA.commandViewDigest, 'resA should have commandViewDigest');
    assert.ok(resB.commandViewDigest, 'resB should have commandViewDigest');
    assert.ok(resC.commandViewDigest, 'resC should have commandViewDigest');

    // Equivalent key-reordered view must produce identical digest
    assert.strictEqual(resA.commandViewDigest, resB.commandViewDigest);

    // Changing nested admitted-file digest must produce a different commandViewDigest
    assert.notStrictEqual(resA.commandViewDigest, resC.commandViewDigest);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    rmSync(dirC, { recursive: true, force: true });
  }
});

test('finding 4683701594: findSettledCommandAdmission ignores unsettled claims and returns settled claims', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-settle-'));
  try {
    // 1. Unsettled claim (e.g. status === 'claimed') must be ignored
    writeFileSync(
      join(dir, 'claim-unsettled.json'),
      JSON.stringify({
        status: 'claimed',
        context: { subjectKind: 'repository-action', commandView: sampleCommandViewA },
        receipt: { claimId: 'claim-unsettled' },
      }),
      'utf8',
    );

    const ids = { taskId: 'task-c01-001', workspaceId: 'ws-c01' };
    const resUnsettled = findSettledCommandAdmission(createMockAssemblyWithClaimDir(dir), ids, 'repo-1');
    assert.strictEqual(resUnsettled.commandView, undefined, 'unsettled claim must be ignored');

    // 2. Settled claim (status === 'settled') is returned
    writeFileSync(
      join(dir, 'claim-settled.json'),
      JSON.stringify({
        status: 'settled',
        context: { subjectKind: 'repository-action', commandView: sampleCommandViewA },
        receipt: { claimId: 'claim-settled-1' },
      }),
      'utf8',
    );

    // Remove the unsettled file so settled is the only candidate in directory
    rmSync(join(dir, 'claim-unsettled.json'), { force: true });
    const resSettled = findSettledCommandAdmission(createMockAssemblyWithClaimDir(dir), ids, 'repo-1');
    assert.ok(resSettled.commandView, 'settled claim should be returned');
    assert.strictEqual(resSettled.commandAdmissionRef, 'claim-settled-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finding 4683701562: malformed presentation reports unexpected-shape without throwing', async () => {
  const written: string[] = [];
  const io: OperatorIo = {
    write: line => written.push(line),
    read: async () => 'approve',
  };
  const decisionSource = createOperatorDecisionSource(io);

  // Subcase 1: elements is missing
  const targetMissingElements: DecisionTarget = {
    taskId: 'task-1',
    console: {
      presentation: async () => ({
        ok: true,
        value: {
          taskId: 'task-1',
          presentation: {
            decisionId: 'dec-1',
            requestVersion: 1,
            presentationDigest: 'sha256:presentation-digest',
          },
        },
      }),
      decide: async () => ({ ok: true, reasonCode: '' }),
    } as unknown as DecisionTarget['console'],
  };

  const res1 = await decisionSource('C01', targetMissingElements);
  assert.strictEqual(res1, undefined);
  assert.ok(
    written.some(line => line.includes('unexpected-shape')),
    'should report unexpected-shape when elements is missing',
  );

  // Subcase 2: targets is not an array
  written.length = 0;
  const targetMalformedTargets: DecisionTarget = {
    taskId: 'task-1',
    console: {
      presentation: async () => ({
        ok: true,
        value: {
          taskId: 'task-1',
          presentation: {
            decisionId: 'dec-2',
            requestVersion: 1,
            presentationDigest: 'sha256:presentation-digest',
            elements: {
              action: 'test',
              necessity: 'test necessity',
              targets: 'not-an-array',
              consequences: 'test consequences',
              verificationStatus: 'test verification',
            },
          },
        },
      }),
      decide: async () => ({ ok: true, reasonCode: '' }),
    } as unknown as DecisionTarget['console'],
  };

  const res2 = await decisionSource('C01', targetMalformedTargets);
  assert.strictEqual(res2, undefined);
  assert.ok(
    written.some(line => line.includes('unexpected-shape')),
    'should report unexpected-shape when targets is not an array',
  );
});

test('finding 4683701653: C02 drops reportDigest while C01 keeps judged value', () => {
  const executionEvidence = {
    snapshot: { snapshotId: 'snap-1', digest: 'sha256:snap' },
    reportDigest: 'sha256:core-report-digest',
  };

  // C02 must not carry reportDigest, even if core execution produced it
  const c02Evidence = buildCaseEvidence('C02', executionEvidence, undefined);
  assert.strictEqual(c02Evidence.reportDigest, undefined, 'C02 evidence artifact must not gain reportDigest');

  // C01 must keep judged reportDigest
  const judgedReport = {
    facts: {
      present: true,
      reportDigest: 'sha256:judged-c16-report-digest',
    },
  };
  const c01Evidence = buildCaseEvidence('C01', executionEvidence, judgedReport as never);
  assert.strictEqual(c01Evidence.reportDigest, 'sha256:judged-c16-report-digest', 'C01 retains judged reportDigest');
});
