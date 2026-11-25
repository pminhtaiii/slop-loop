/**
 * PR #261 R2 verification for R2-DISPOSITION (4690938600) and R2-CLI-DISPOSAL (4690938628):
 * - Optional `WorkflowObservation.approvalDisposition` ('unanswered' | 'rejected') as presentation data only.
 * - Backward compatibility when omitted (zero authority granted, zero diagnostic string parsing).
 * - One-shot CLI `--host` teardown of retained production driver working copies in `finally`, while
 *   direct-driver callers retain same-process continuation.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { issueRealExecutionAdmission } from '../../../eval/shared-admission.ts';
import { workflowCaseResult } from '../../../eval/uc03/results.ts';
import { runEvaluation, validateWorkflowEvaluationReport, validateWorkflowObservation } from '../../../eval/uc03/runner.ts';
import { WORKFLOW_EVALUATION_VERSION, type EvaluationCaseSpec, type WorkflowBinding, type WorkflowDriver, type WorkflowObservation } from '../../../eval/uc03/types.ts';
import { runEvaluateCli, type EvaluateCliOptions, type HostAssembly } from '../../../src/cli/evaluate.ts';
import type { OwnerDelivery } from '../../../src/runtime/evaluation-composition.ts';
import { registerDriverDisposer } from '../../../src/runtime/real-tier-production-lifecycle.ts';
import { abandonRealTierProductionCase } from '../../../src/runtime/real-tier-production.ts';
import { REQUIRED_PORTS_V02_METHODS, UC03_PRODUCTION_COMPONENTS_V02, portDeclarationsV02, type UC03GraphConfigV02 } from '../../../src/uc03/graph-types-v02.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const REV = 'a'.repeat(40);
const CONTRACT = 'uc03-owner-delivery/1';
const HOST_COMPONENTS = new Set<string>(['guardedRead', 'baselineEvidence', 'hostAuthority', 'contextSource']);

const C01_SPEC: EvaluationCaseSpec = {
  caseId: 'C01',
  name: 'Bug repair',
  description: 'C01 repair',
  category: 'repair',
  required: true,
  expectedOutcome: 'COMPLETED',
  requirements: ['fix bug'],
};

const REAL_BINDING: WorkflowBinding = {
  tier: 'real-integration',
  profileDigest: DIGEST,
  configDigest: DIGEST,
  pricingDigest: DIGEST,
  adapterVersions: ['uc03-adapter-1'],
  requestedModel: 'deepseek-v4.1',
};

const CONTROLLED_BINDING: WorkflowBinding = { ...REAL_BINDING, tier: 'controlled' };

function makeObservation(overrides: Record<string, unknown> = {}): WorkflowObservation {
  return {
    repositoryId: 'repo-1',
    taskId: 'task-1',
    runId: 'run-1',
    returnedModel: 'deepseek-v4.1',
    graderDigest: null,
    initialRepositoryDigest: null,
    workflowOutcome: 'waiting-approval',
    expectedWait: null,
    blocked: null,
    effects: 'observed',
    usage: 'uncertain',
    diagnostic: null,
    artifacts: [],
    limitations: [],
    ...overrides,
  } as WorkflowObservation;
}

function makeHostFixture(): { readonly hostFile: string; readonly host: HostAssembly; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'uc03-r2-disp-'));
  const hostFile = join(dir, 'host.json');
  writeFileSync(
    hostFile,
    JSON.stringify({
      profileId: 'profile-001',
      profileDigest: DIGEST,
      configDigest: DIGEST,
      pricingDigest: DIGEST,
      requestedModel: 'deepseek-v4.1',
      adapterVersions: ['uc03-adapter-1'],
      contractVersion: CONTRACT,
      revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(c => [c, REV])),
    }),
    'utf8',
  );
  const owner: OwnerDelivery[] = UC03_PRODUCTION_COMPONENTS_V02.filter(c => !HOST_COMPONENTS.has(c)).map(
    component =>
      ({
        component,
        id: `${component}-id`,
        contractVersion: CONTRACT,
        revision: REV,
        provenance: 'real',
        adapter: { provenance: 'real', ...portDeclarationsV02(component), ...Object.fromEntries(REQUIRED_PORTS_V02_METHODS[component].map(m => [m, () => undefined])) },
      }) as OwnerDelivery,
  );
  const config: UC03GraphConfigV02 = {
    trustedExpectedContext: {
      taskId: 'task-1',
      workspaceId: 'ws-1',
      repositoryId: 'repo-1',
      revisionDigest: DIGEST,
      criteriaDigest: DIGEST,
      checkSetDigest: DIGEST,
      expectedTestFiles: ['tests/test_calc.py'],
    },
  };
  const host: HostAssembly = {
    owner,
    producers: {
      guardedRead: { provenance: 'real', mediateRead: () => undefined } as never,
      baselineEvidence: { provenance: 'real', persistBaselineEvidence: () => undefined, loadBaselineEvidence: () => undefined } as never,
      hostAuthority: { loadSnapshot: () => undefined } as never,
      contextSource: { provenance: 'real', observe: () => undefined } as never,
    },
    config,
  };
  return { hostFile, host, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('R2-DISPOSITION: validateWorkflowObservation handles optional approvalDisposition with backward compatibility and strict validation', () => {
  const omitted = validateWorkflowObservation(makeObservation());
  assert.equal(Object.hasOwn(omitted, 'approvalDisposition'), false, 'absent field must not be materialized');

  const explicitUndefined = validateWorkflowObservation(makeObservation({ approvalDisposition: undefined }));
  assert.equal(Object.hasOwn(explicitUndefined, 'approvalDisposition'), false, 'undefined optional field must not alter canonical keys');

  const unanswered = validateWorkflowObservation(makeObservation({ approvalDisposition: 'unanswered' }));
  assert.equal(unanswered.approvalDisposition, 'unanswered');

  const rejected = validateWorkflowObservation(makeObservation({ approvalDisposition: 'rejected' }));
  assert.equal(rejected.approvalDisposition, 'rejected');

  for (const bad of ['approved', 'pending', '', null, 42, true]) {
    assert.throws(() => validateWorkflowObservation(makeObservation({ approvalDisposition: bad })), `must reject invalid disposition ${String(bad)}`);
  }
  assert.throws(() => validateWorkflowObservation(makeObservation({ approvalDisposition: 'rejected', extraKey: 1 })));
});

test('R2-DISPOSITION: pause limitation appears only for explicit unanswered disposition; rejection and omitted disposition preserve exit 3 without pause contradiction or authority', async () => {
  const pausedLimitation = 'Task remains paused awaiting explicit operator approval; no independent final-snapshot grade was produced.';
  const unverifiedLimitation = 'No independently validated final-snapshot grade was produced; real workflow evidence remains unverified.';

  const unansweredRes = workflowCaseResult(C01_SPEC, makeObservation({ approvalDisposition: 'unanswered' }), REAL_BINDING);
  assert.equal(unansweredRes.grade, 'not-run');
  assert.equal(unansweredRes.gradeReason, 'unresolved-wait');
  assert.ok(unansweredRes.limitations.includes(pausedLimitation));

  const rejectedRes = workflowCaseResult(
    C01_SPEC,
    makeObservation({ approvalDisposition: 'rejected', diagnostic: 'Operator rejected approval; explicit direction or termination is required before continuing.' }),
    REAL_BINDING,
  );
  assert.equal(rejectedRes.grade, 'not-run');
  assert.equal(rejectedRes.gradeReason, 'unresolved-wait');
  assert.ok(rejectedRes.limitations.includes(unverifiedLimitation));
  assert.equal(
    rejectedRes.limitations.some(line => line.includes('remains paused')),
    false,
    'rejected outcome must not claim task remains paused',
  );

  // Backward compatibility when field is absent: never parse diagnostic strings to infer disposition.
  const legacyOmitted = workflowCaseResult(C01_SPEC, makeObservation({ diagnostic: 'Task remains paused awaiting explicit operator approval.', limitations: [] }), REAL_BINDING);
  assert.equal(legacyOmitted.grade, 'not-run');
  assert.equal(legacyOmitted.gradeReason, 'unresolved-wait');
  assert.ok(legacyOmitted.limitations.includes(unverifiedLimitation));
  assert.equal(legacyOmitted.limitations.includes(pausedLimitation), false, 'absent field must not infer pause from diagnostic text');

  // Misplaced disposition grants zero authority on non-waiting real outcomes or controlled runs.
  const nonWaitReal = workflowCaseResult(C01_SPEC, makeObservation({ workflowOutcome: 'COMPLETED', approvalDisposition: 'unanswered' }), REAL_BINDING);
  assert.equal(nonWaitReal.grade, 'not-run');
  assert.equal(nonWaitReal.gradeReason, 'private-grading');
  assert.equal(nonWaitReal.limitations.includes(pausedLimitation), false);

  const controlledRes = workflowCaseResult(C01_SPEC, makeObservation({ approvalDisposition: 'rejected' }), CONTROLLED_BINDING);
  assert.equal(controlledRes.grade, 'not-run');
  assert.equal(controlledRes.gradeReason, 'unresolved-wait');
  assert.deepEqual(controlledRes.limitations, ['Controlled lifecycle predicate only; no snapshot-bound independent grade was attached.']);

  // End-to-end runner exit 3 parity on rejected disposition.
  const adm = issueRealExecutionAdmission({
    profileDigest: DIGEST,
    configDigest: DIGEST,
    pricingDigest: DIGEST,
    adapterVersions: ['uc03-adapter-1'],
    caseIds: ['C01'],
    requestedModel: 'deepseek-v4.1',
  });
  const report = await runEvaluation({
    contractVersion: WORKFLOW_EVALUATION_VERSION,
    mode: 'real',
    cases: ['C01'],
    profileDigest: DIGEST,
    configDigest: DIGEST,
    pricingDigest: DIGEST,
    adapterVersions: ['uc03-adapter-1'],
    requestedModel: 'deepseek-v4.1',
    realAdmission: adm,
    driver: { executeCase: () => makeObservation({ approvalDisposition: 'rejected' }) },
  });
  assert.equal(report.exitCode, 3);
  assert.deepEqual(report.selectionResult.pendingWaits, ['C01']);
  assert.equal(
    report.cases[0]?.limitations.some(line => line.includes('remains paused')),
    false,
  );
});

test('R2-CLI-DISPOSAL: one-shot --host CLI disposes retained driver copies on exit while direct-driver caller retains ownership', async () => {
  const fixture = makeHostFixture();
  const retainedDir = mkdtempSync(join(tmpdir(), 'uc03-r2-retained-'));
  const durableDir = mkdtempSync(join(tmpdir(), 'uc03-r2-durable-'));
  writeFileSync(join(durableDir, 'task.json'), '{"status":"paused"}', 'utf8');
  let disposerCalls = 0;

  try {
    const cliOptions: EvaluateCliOptions = {
      profileDigest: DIGEST,
      configDigest: DIGEST,
      pricingDigest: DIGEST,
      adapterVersions: ['uc03-adapter-1'],
      requestedModel: 'deepseek-v4.1',
      host: fixture.host,
      production: (_ready, ctx) => {
        const driver: WorkflowDriver = {
          executeCase: () => makeObservation({ approvalDisposition: 'unanswered' }),
        };
        registerDriverDisposer(driver, () => {
          disposerCalls += 1;
          rmSync(retainedDir, { recursive: true, force: true });
          return true;
        });
        const realAdmission = issueRealExecutionAdmission({
          profileDigest: DIGEST,
          configDigest: DIGEST,
          pricingDigest: DIGEST,
          adapterVersions: ['uc03-adapter-1'],
          caseIds: ctx?.caseIds ?? ['C01'],
          requestedModel: 'deepseek-v4.1',
        });
        return { driver, realAdmission };
      },
    };

    const res = await runEvaluateCli(['run', '--host', fixture.hostFile, '--mode', 'real', '--cases', 'C01'], cliOptions);
    assert.equal(res.exitCode, 3, res.output);
    assert.equal(disposerCalls, 1, 'one-shot CLI must dispose production driver resources in finally');
    assert.equal(existsSync(retainedDir), false, 'one-shot teardown must delete owned temp working copy');
    assert.equal(existsSync(join(durableDir, 'task.json')), true, 'durable operator artifact must stay untouched');
    const cutoff = res.output.lastIndexOf('\nUC-03 Workflow Evaluation [');
    const report = validateWorkflowEvaluationReport(JSON.parse(res.output.slice(0, cutoff)));
    assert.deepEqual(report.selectionResult.pendingWaits, ['C01']);
    assert.ok(report.limitations.some(line => line.includes('One-shot CLI') && line.includes('unsupported')));

    // Error/invalid-observation path must still trigger finally disposal.
    let errDisposerCalls = 0;
    const errRes = await runEvaluateCli(['run', '--host', fixture.hostFile, '--mode', 'real', '--cases', 'C01'], {
      ...cliOptions,
      production: (_ready, ctx) => {
        const driver: WorkflowDriver = {
          executeCase: () => {
            throw new Error('simulated driver error');
          },
        };
        registerDriverDisposer(driver, () => {
          errDisposerCalls += 1;
          return true;
        });
        return {
          driver,
          realAdmission: issueRealExecutionAdmission({
            profileDigest: DIGEST,
            configDigest: DIGEST,
            pricingDigest: DIGEST,
            adapterVersions: ['uc03-adapter-1'],
            caseIds: ctx?.caseIds ?? ['C01'],
            requestedModel: 'deepseek-v4.1',
          }),
        };
      },
    });
    assert.equal(errRes.exitCode, 1);
    assert.equal(errDisposerCalls, 1, 'finally disposal must also run on driver failure');

    // Direct caller supplying options.driver without --host retains same-process ownership.
    let directDisposed = false;
    const directDriver: WorkflowDriver = {
      executeCase: () => makeObservation({ approvalDisposition: 'unanswered' }),
    };
    registerDriverDisposer(directDriver, () => {
      directDisposed = true;
      return true;
    });
    const directAdmission = issueRealExecutionAdmission({
      profileDigest: DIGEST,
      configDigest: DIGEST,
      pricingDigest: DIGEST,
      adapterVersions: ['uc03-adapter-1'],
      caseIds: ['C01'],
      requestedModel: 'deepseek-v4.1',
    });
    const directRes = await runEvaluateCli(['run', '--mode', 'real', '--cases', 'C01'], {
      profileDigest: DIGEST,
      configDigest: DIGEST,
      pricingDigest: DIGEST,
      adapterVersions: ['uc03-adapter-1'],
      requestedModel: 'deepseek-v4.1',
      realAdmission: directAdmission,
      driver: directDriver,
    });
    assert.equal(directRes.exitCode, 3);
    assert.equal(directDisposed, false, 'direct-driver caller must keep retained copy for same-process continuation');
    assert.equal(abandonRealTierProductionCase(directDriver, 'C01'), true);
    assert.equal(directDisposed, true);
  } finally {
    fixture.cleanup();
    rmSync(retainedDir, { recursive: true, force: true });
    rmSync(durableDir, { recursive: true, force: true });
  }
});
