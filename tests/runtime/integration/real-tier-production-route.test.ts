import assert from 'node:assert/strict';
import test from 'node:test';

import { issueRealExecutionAdmission } from '../../../eval/shared-admission.ts';
import type { WorkflowCaseResult } from '../../../eval/uc03/types.ts';
import { runEvaluateCli, type EvaluateCliOptions } from '../../../src/cli/evaluate.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { GRADER_FILE, GRADER_SECRET, RETURNED_MODEL, REV, parseCliReport, prodCopyTempCount, setupProductionScenario } from './real-tier-production-route-fixture.ts';
test('AC1/AC4/AC5/AC6: real production route succeeds for C01 with host admission, pinned identities, usage label, and zero grader leak', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-25T00:00:00.000Z') });
  const copyBefore = prodCopyTempCount();
  const s = await setupProductionScenario({ tag: 'c01-ok', fetchMode: 'repair', decisions: ['approve', 'approve'] });
  try {
    const cliResult = await runEvaluateCli(['run', '--host', s.hostFile, '--mode', 'real', '--cases', 'C01']);
    assert.equal(cliResult.exitCode, 0, cliResult.output);

    const report = parseCliReport(cliResult.output);
    assert.equal(report.mode, 'real');
    assert.equal(report.tier, 'real-integration');
    assert.equal(report.timestamp, '2026-11-25T00:00:00.000Z');
    assert.equal(report.selectionResult.outcome, 'pass');
    assert.equal(report.cases.length, 1);

    const c01 = report.cases[0] as WorkflowCaseResult;
    assert.equal(c01.caseId, 'C01');
    assert.equal(c01.grade, 'pass');
    assert.equal(c01.gradeReason, 'criteria-satisfied');
    assert.equal(c01.workflowOutcome, 'COMPLETED');
    assert.equal(c01.returnedModel, RETURNED_MODEL);
    assert.equal(c01.graderDigest, s.c01GraderDigest);
    assert.equal(c01.initialRepositoryDigest, s.c01InitialDigest);
    assert.equal(c01.usage, 'observed');
    assert.equal(c01.profileDigest, s.binding.profileDigest);
    assert.equal(c01.configDigest, s.binding.configDigest);
    assert.equal(c01.pricingDigest, s.binding.pricingDigest);

    // AC1: candidate, owner-rev, profile, image, model, evidence, and costLabel identities
    assert.ok(
      c01.artifacts.some(a => a.startsWith('candidate:') && a.includes(`;owner-rev:${REV}`)),
      JSON.stringify(c01.artifacts),
    );
    assert.ok(c01.artifacts.some(a => a === `profile:${s.binding.profileDigest}`));
    assert.ok(c01.artifacts.some(a => a.startsWith('image:sha256:')));
    assert.ok(c01.artifacts.some(a => a === `model:req=${s.binding.requestedModel};ret=${RETURNED_MODEL}`));
    assert.ok(c01.artifacts.some(a => a.startsWith('evidence:diff=sha256:') && a.includes(';report=sha256:')));
    assert.ok(c01.artifacts.some(a => a.startsWith('usage:tokens=') && a.includes(';costLabel=estimate-unverified')));

    // Hidden isolated container grader ran once with fixed code and /grader mount
    assert.equal(s.spawnSpy.hiddenChecks.length, 1);
    assert.equal(s.getOperatorReads(), 2);

    // AC4: Zero solution/grader injection into coder or reviewer model prompts
    assert.ok(s.fetchSpy.requests.length >= 4);
    for (const req of s.fetchSpy.requests) {
      assert.equal(req.bodyText.includes(GRADER_SECRET), false, 'grader secret must never reach coder or reviewer');
      assert.equal(req.bodyText.includes(GRADER_FILE), false, 'grader filename must never reach coder or reviewer');
    }

    // Working copy cleanup by production driver
    assert.equal(prodCopyTempCount(), copyBefore);
  } finally {
    s.cleanup();
  }
});

test('AC1/AC2/AC5: real production route succeeds for C02 clarification without calling approval operator', async () => {
  const s = await setupProductionScenario({ tag: 'c02-ok', fetchMode: 'clarify', decisions: [] });
  try {
    const cliResult = await runEvaluateCli(['run', '--host', s.hostFile, '--mode', 'real', '--cases', 'C02']);
    assert.equal(cliResult.exitCode, 0, cliResult.output);
    const report = parseCliReport(cliResult.output);
    const c02 = report.cases[0] as WorkflowCaseResult;
    assert.equal(c02.caseId, 'C02');
    assert.equal(c02.workflowOutcome, 'waiting-info');
    assert.equal(c02.grade, 'pass');
    assert.equal(c02.gradeReason, 'criteria-satisfied');
    assert.equal(s.getOperatorReads(), 0, 'C02 clarification hold does not invoke operator approval read');
  } finally {
    s.cleanup();
  }
});

test('AC2: plan and verification approvals come strictly from OperatorIo, ignoring env spoofing', async () => {
  const spoofEnv = { APPROVE: '1', UC03_AUTO_APPROVE: '1', UC03_APPROVAL: 'approve' };

  // (a) EOF at plan pause -> waiting-approval, not-run, nonzero exit, no patch or hidden grade
  const planEof = await setupProductionScenario({ tag: 'op-plan-eof', fetchMode: 'repair', decisions: [undefined], envOverrides: spoofEnv });
  try {
    const res = await runEvaluateCli(['run', '--host', planEof.hostFile, '--mode', 'real', '--cases', 'C01']);
    assert.notEqual(res.exitCode, 0);
    const c01 = parseCliReport(res.output).cases[0] as WorkflowCaseResult;
    assert.equal(c01.grade, 'not-run');
    assert.equal(c01.workflowOutcome, 'waiting-approval');
    assert.equal(planEof.spawnSpy.hiddenChecks.length, 0);
    assert.equal(
      planEof.fetchSpy.requests.some(r => r.purpose === 'propose-patch'),
      false,
    );
  } finally {
    planEof.cleanup();
  }

  // (b) Approve plan, then EOF at verification pause -> waiting-approval, not-run, nonzero exit, no hidden grade
  const verifyEof = await setupProductionScenario({ tag: 'op-verify-eof', fetchMode: 'repair', decisions: ['approve', undefined], envOverrides: spoofEnv });
  try {
    const res = await runEvaluateCli(['run', '--host', verifyEof.hostFile, '--mode', 'real', '--cases', 'C01']);
    assert.notEqual(res.exitCode, 0);
    const c01 = parseCliReport(res.output).cases[0] as WorkflowCaseResult;
    assert.equal(c01.grade, 'not-run');
    assert.equal(c01.workflowOutcome, 'waiting-approval');
    assert.equal(verifyEof.getOperatorReads(), 2);
    assert.equal(verifyEof.spawnSpy.hiddenChecks.length, 0);
  } finally {
    verifyEof.cleanup();
  }

  // (c) Explicit reject at plan pause -> waiting-approval, not-run, nonzero exit
  const planReject = await setupProductionScenario({ tag: 'op-reject', fetchMode: 'repair', decisions: ['reject'], envOverrides: spoofEnv });
  try {
    const res = await runEvaluateCli(['run', '--host', planReject.hostFile, '--mode', 'real', '--cases', 'C01']);
    assert.notEqual(res.exitCode, 0);
    const c01 = parseCliReport(res.output).cases[0] as WorkflowCaseResult;
    assert.equal(c01.grade, 'not-run');
    assert.equal(c01.workflowOutcome, 'waiting-approval');
    assert.equal(planReject.spawnSpy.hiddenChecks.length, 0);
  } finally {
    planReject.cleanup();
  }
});

test('AC3: missing or invalid profile, credential, docker daemon, or image fails closed with exit 4 and zero fetch', async () => {
  // Missing profile
  const noProfile = await setupProductionScenario({ tag: 'no-prof', envOverrides: { UC03_REAL_TIER_PROFILE: undefined } });
  try {
    const res = await runEvaluateCli(['run', '--host', noProfile.hostFile, '--mode', 'real', '--cases', 'C01']);
    assert.equal(res.exitCode, 4);
    assert.equal(noProfile.fetchSpy.requests.length, 0);
  } finally {
    noProfile.cleanup();
  }

  // Missing credential
  const noCred = await setupProductionScenario({ tag: 'no-cred', envOverrides: { ANTHROPIC_API_KEY: '' } });
  try {
    const res = await runEvaluateCli(['run', '--host', noCred.hostFile, '--mode', 'real', '--cases', 'C01']);
    assert.equal(res.exitCode, 4);
    assert.equal(noCred.fetchSpy.requests.length, 0);
  } finally {
    noCred.cleanup();
  }

  // Daemon down
  const down = await setupProductionScenario({ tag: 'daemon-down', dockerMode: 'down' });
  try {
    const res = await runEvaluateCli(['run', '--host', down.hostFile, '--mode', 'real', '--cases', 'C01']);
    assert.equal(res.exitCode, 4);
    assert.equal((JSON.parse(res.output) as { operational?: string }).operational, 'docker-unavailable');
    assert.equal(down.fetchSpy.requests.length, 0);
  } finally {
    down.cleanup();
  }

  // Image mismatch
  const imgMismatch = await setupProductionScenario({ tag: 'img-mismatch', dockerMode: 'mismatch' });
  try {
    const res = await runEvaluateCli(['run', '--host', imgMismatch.hostFile, '--mode', 'real', '--cases', 'C01']);
    assert.equal(res.exitCode, 4);
    assert.equal((JSON.parse(res.output) as { operational?: string }).operational, 'image-mismatch');
    assert.equal(imgMismatch.fetchSpy.requests.length, 0);
  } finally {
    imgMismatch.cleanup();
  }
});

test('AC3: missing catalog entry and missing/corrupt/payloadless grader material refuse not-run with nonzero exit', async () => {
  for (const [label, patch] of [
    ['missing-catalog-entry', { omitCatalogC01: true }],
    ['grader-digest-mismatch', { graderMode: 'bad-digest' as const }],
    ['grader-file-missing', { graderMode: 'missing-file' as const }],
    ['grader-payload-null', { graderMode: 'null-payload' as const }],
  ] as const) {
    const s = await setupProductionScenario({ tag: label, ...patch });
    try {
      const res = await runEvaluateCli(['run', '--host', s.hostFile, '--mode', 'real', '--cases', 'C01']);
      assert.notEqual(res.exitCode, 0, `${label} must fail nonzero`);
      const c01 = parseCliReport(res.output).cases[0] as WorkflowCaseResult;
      assert.equal(c01.grade, 'not-run', label);
      assert.equal(c01.gradeReason, 'prerequisite-unavailable', label);
      assert.equal(s.fetchSpy.requests.length, 0, `${label} must not call model`);
      assert.equal(s.spawnSpy.hiddenChecks.length, 0, `${label} must not run hidden grader`);
    } finally {
      s.cleanup();
    }
  }
});

test('AC3: a case with no pinned grader is refused before any model call', async () => {
  const s = await setupProductionScenario({ tag: 'unpinned' });
  try {
    const res = await runEvaluateCli(['run', '--host', s.hostFile, '--mode', 'real', '--cases', 'C03']);
    assert.notEqual(res.exitCode, 0);
    const c03 = parseCliReport(res.output).cases[0] as WorkflowCaseResult;
    assert.equal(c03.grade, 'not-run');
    assert.equal(c03.gradeReason, 'prerequisite-unavailable');
    assert.equal(s.fetchSpy.requests.length, 0);
  } finally {
    s.cleanup();
  }
});

test('AC3: forged, copied, stale, withheld, and foreign real-execution admissions are refused', async () => {
  // Withheld admission (host configDigest mismatches profile limits digest)
  const mismatched = await setupProductionScenario({
    tag: 'withheld-adm',
    hostPatch: { configDigest: `sha256:${'9'.repeat(64)}` },
  });
  try {
    const res = await runEvaluateCli(['run', '--host', mismatched.hostFile, '--mode', 'real', '--cases', 'C01']);
    assert.equal(res.exitCode, 1);
    const c01 = parseCliReport(res.output).cases[0] as WorkflowCaseResult;
    assert.equal(c01.grade, 'not-run');
    assert.equal(c01.gradeReason, 'real-execution-unavailable');
    assert.equal(mismatched.fetchSpy.requests.length, 0);
  } finally {
    mismatched.cleanup();
  }

  // Forged, spread-copied, and foreign admissions supplied in EvaluateCliOptions
  const s = await setupProductionScenario({ tag: 'bad-admissions' });
  try {
    const realAdm = issueRealExecutionAdmission({ ...s.binding, caseIds: ['C01'] });
    const staleProfileAdm = issueRealExecutionAdmission({ ...s.binding, profileDigest: `sha256:${'e'.repeat(64)}`, caseIds: ['C01'] });
    const foreignCaseAdm = issueRealExecutionAdmission({ ...s.binding, caseIds: ['C02'] });
    const foreignModelAdm = issueRealExecutionAdmission({ ...s.binding, requestedModel: 'other/model', caseIds: ['C01'] });
    const malformedForgedAdm = {
      schema: 'uc03-real-execution-admission/1',
      bindingDigest: realAdm.bindingDigest,
    };
    const malformedRes = await runEvaluateCli(['run', '--host', s.hostFile, '--mode', 'real', '--cases', 'C01'], {
      ...s.binding,
      realAdmission: malformedForgedAdm as unknown as EvaluateCliOptions['realAdmission'],
    });
    assert.equal(malformedRes.exitCode, 2, 'malformed forged admission must exit 2');
    assert.equal(s.fetchSpy.requests.length, 0, 'malformed forged admission must make zero model calls');

    const forgedAdm = {
      admissionId: sha256Text('forged-admission'),
      profileDigest: s.binding.profileDigest,
      bindingDigest: realAdm.bindingDigest,
    };
    const copiedAdm = { ...realAdm };

    for (const [label, badAdmission] of [
      ['forged', forgedAdm],
      ['spread-copy', copiedAdm],
      ['stale-profile', staleProfileAdm],
      ['foreign-caseIds', foreignCaseAdm],
      ['foreign-model', foreignModelAdm],
    ] as const) {
      const cliOpts: EvaluateCliOptions = {
        ...s.binding,
        realAdmission: badAdmission as EvaluateCliOptions['realAdmission'],
      };
      const res = await runEvaluateCli(['run', '--host', s.hostFile, '--mode', 'real', '--cases', 'C01'], cliOpts);
      assert.equal(res.exitCode, 1, `${label} must exit 1`);
      const c01 = parseCliReport(res.output).cases[0] as WorkflowCaseResult;
      assert.equal(c01.grade, 'not-run', label);
      assert.equal(c01.gradeReason, 'real-execution-unavailable', label);
      assert.equal(s.fetchSpy.requests.length, 0, `${label} must make zero model calls`);
    }
  } finally {
    s.cleanup();
  }
});

test('AC1/AC5: C01 hidden grading succeeds under a non-1000 POSIX host uid without weakening admission checks', async () => {
  const uidDesc = Object.getOwnPropertyDescriptor(process, 'getuid');
  const gidDesc = Object.getOwnPropertyDescriptor(process, 'getgid');
  Object.defineProperty(process, 'getuid', { value: () => 1001, configurable: true, writable: true });
  Object.defineProperty(process, 'getgid', { value: () => 127, configurable: true, writable: true });
  try {
    const s = await setupProductionScenario({ tag: 'posix-uid-ok', fetchMode: 'repair', decisions: ['approve', 'approve'] });
    try {
      const cliResult = await runEvaluateCli(['run', '--host', s.hostFile, '--mode', 'real', '--cases', 'C01']);
      assert.equal(cliResult.exitCode, 0, cliResult.output);
      const c01 = parseCliReport(cliResult.output).cases[0] as WorkflowCaseResult;
      assert.equal(c01.workflowOutcome, 'COMPLETED');
      assert.equal(c01.grade, 'pass');
      assert.equal(c01.gradeReason, 'criteria-satisfied');
      assert.equal(s.spawnSpy.hiddenChecks.length, 1);
      assert.ok(s.spawnSpy.hiddenChecks[0]?.args.includes('--user=1001:127'));
    } finally {
      s.cleanup();
    }

    const mismatched = await setupProductionScenario({ tag: 'posix-uid-mismatch', fetchMode: 'repair', decisions: ['approve', 'approve'], imageUser: '1000:1000' });
    try {
      const cliResult = await runEvaluateCli(['run', '--host', mismatched.hostFile, '--mode', 'real', '--cases', 'C01']);
      assert.equal(cliResult.exitCode, 1, cliResult.output);
      const c01 = parseCliReport(cliResult.output).cases[0] as WorkflowCaseResult;
      assert.equal(c01.workflowOutcome, 'COMPLETED');
      assert.equal(c01.grade, 'not-run');
      assert.equal(c01.gradeReason, 'private-grading');
      assert.equal(mismatched.spawnSpy.hiddenChecks.length, 0);
    } finally {
      mismatched.cleanup();
    }
  } finally {
    if (uidDesc !== undefined) Object.defineProperty(process, 'getuid', uidDesc);
    else delete (process as { getuid?: (() => number) | undefined }).getuid;
    if (gidDesc !== undefined) Object.defineProperty(process, 'getgid', gidDesc);
    else delete (process as { getgid?: (() => number) | undefined }).getgid;
  }
});
