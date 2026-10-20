import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApprovalService } from '../../../src/approvals/service.ts';
import { runApprovalCli } from '../../../src/approvals/cli.ts';
import { computeActionDigest } from '../../../src/contracts/foundation/uc03.ts';
import { createMockApprovalStore } from '../support/uc05/mock-store.ts';
import { createMockActivityControl } from '../support/uc05/mock-context.ts';
import type { PolicyProfile } from '../../../src/contracts/approvals/contracts.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const identity = { policyId: 'policy-1', policyVersion: '1', configId: 'config-1', configVersion: '1' };
const profile: PolicyProfile = {
  schemaVersion: 'uc05-approval/0.1-draft', profileId: 'uc05-local-v1', profileVersion: '1', policyIdentity: identity,
  supportedActionKinds: ['run_command'], commandRules: [{ ruleId: 'tests', executableRef: 'pytest', argvPrefix: ['-q', 'tests/'], workingDirectoryRef: 'repository-root', timeoutMs: 2000, maxOutputBytes: 8192 }],
  sensitivePaths: ['pyproject.toml'], patchBreadth: { maxFiles: 8, maxAddedDeletedLines: 400 }, maxActionBytes: 65536,
  maxArgvEntries: 32, maxArgvEntryBytes: 4096, maxPresentationPageBytes: 8192, maxPresentationPages: 3, maxPresentationTotalBytes: 24576,
  maxEventBytes: 1024, operationDeadlineMs: 2000, maxMutationAttempts: 1,
  diagnosticRules: { maxBytes: 1024, redactSecrets: true, allowRawArtifacts: false, retainUnresolvedDecisions: true },
};

/** Explicit subprocess-only composition; production CLI cannot select or load this driver. */
async function fixture(scenario: string) {
  const action = { actionId: 'action-1', kind: 'run_command' as const, executable: 'pytest', argv: ['-q', 'tests/other.py'], workingDirectory: '/workspace' };
  const binding = { decisionId: 'decision-1', actionKind: 'action' as const, normalizedActionDigest: computeActionDigest(action), taskId: 'task-1', workspaceId: 'workspace-1', repositoryRevisionDigest: digest, policyId: 'policy-1', policyVersion: '1', status: 'pending' as const };
  const store = createMockApprovalStore({ profile, initialControls: [{ schemaVersion: 'uc05-approval/0.1-draft', taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', version: 1, epoch: 1, mode: 'runnable', pendingDecisionId: null, continuationRef: null, reasonCode: 'ready', outstandingClaimRefs: [] }] });
  const trusted = { action, runId: 'run-1', freshness: { currentTaskId: 'task-1', currentWorkspaceId: 'workspace-1', currentRepositoryRevisionDigest: digest, currentPolicyId: 'policy-1', currentPolicyVersion: '1', currentNormalizedActionDigest: computeActionDigest(action) },
    elements: { action: 'Run tests', necessity: 'Verify repair', targets: ['tests/other.py'], consequences: 'Isolated test run', verificationStatus: 'Not executed' },
    facts: { taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', repositoryRevisionDigest: digest, policyIdentity: identity, registeredActionDigest: computeActionDigest(action), continuationRef: 'continuation-1', role: 'coder' as const,
      safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
      command: { executableRef: 'pytest', resolvedExecutable: 'pytest', workingDirectoryRef: 'repository-root', workingDirectory: '/workspace', constrainedCapability: 'constrained-tests' }, patch: null, plan: null } };
  const activity = createMockActivityControl(profile);
  const context = { loadForAction: async () => trusted, loadForDecision: async () => trusted, loadForTask: async () => ({ taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', runId: 'run-1', safeScopeRef: 'scope-1', policyIdentity: identity }) };
  const options = { taskId: 'task-1', profile, store, context, activity, now: () => '2026-10-19T00:00:00Z' };
  const operator = { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' as const } };
  const service = createApprovalService({ ...options, operator });
  await service.requestDecision(binding);
  const presentationDigest = (await service.show('task-1', 'decision-1')).presentation.presentationDigest;
  if (scenario.startsWith('control-') && scenario !== 'control-pending') await service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: 2, requestVersion: 1, presentationDigest, decision: 'reject', responseKey: 'reject' });
  if (scenario === 'failed-store') store.failNext('resolvePending');
  const protectedStore = { ...store, loadTaskControl: (taskId: string) => {
    const result = store.loadTaskControl(taskId);
    return { ...result, value: result.value === null ? null : { ...result.value, reasonCode: 'MARKER_SECRET_DO_NOT_DISCLOSE' } };
  } };
  const protectedReceiptStore = { ...store, resolvePending: (input: unknown) => {
    const result = store.resolvePending(input);
    return { ...result, safe: { ...result.safe, eventRef: 'MARKER_SECRET_DO_NOT_DISCLOSE' } };
  } };
  if (scenario === 'control-failed-store') store.failNext('recordDirection');
  const directionStore = { ...store, recordDirection: (input: unknown) => {
    const response = store.recordDirection(input);
    return { ...response, safe: { ...response.safe, ...(scenario === 'control-uncertain' ? { outcome: 'uncertain' as const, eventRef: null } : { eventRef: 'MARKER_SECRET_DO_NOT_DISCLOSE' }) } };
  } };
  const selectedService = scenario === 'no-operator' || scenario === 'control-no-operator' ? createApprovalService(options)
    : scenario === 'protected-metadata' ? createApprovalService({ ...options, store: protectedStore, operator })
    : scenario === 'protected-receipt' ? createApprovalService({ ...options, store: protectedReceiptStore, operator })
    : scenario === 'control-uncertain' || scenario === 'control-protected' ? createApprovalService({ ...options, store: directionStore, operator })
    : scenario === 'control-activity-fault' ? createApprovalService({ ...options, operator, activity: { ...activity, inspectOutstanding: () => { throw new Error('MARKER_SECRET_DO_NOT_DISCLOSE'); } } })
    : scenario === 'control-missing-context' ? createApprovalService({ ...options, operator, context: { loadForAction: context.loadForAction, loadForDecision: context.loadForDecision } }) : service;
  const snapshot = (stage: string) => ({ stage, mode: store.loadTaskControl('task-1').value?.mode, version: store.loadTaskControl('task-1').value?.version, directions: store.readHistory('task-1').value?.directions.length, resolutions: store.readHistory('task-1').value?.resolutions.map(value => value.decision), events: store.readEvents('task-1').value?.length });
  return { service: selectedService, presentationDigest, store, context, binding, snapshot };
}

if (process.argv[2] === 'uc05-cli-test-driver') {
  const state = await fixture(process.argv[3] ?? 'normal');
  const scenario = process.argv[3];
  if (scenario === 'control-interrupt-before') state.context.loadForTask = async () => {
    process.send?.(state.snapshot('before'));
    await new Promise(() => { /* The parent interrupts this real child before mutation. */ });
    throw new Error('unreachable');
  };
  if (scenario === 'control-retry-wait' || scenario === 'control-retry-end') {
    const initial = await runApprovalCli(process.argv.slice(4), state.service);
    if (initial.exitCode !== 0) throw new Error('test-driver initial direction failed');
    state.context.loadForTask = async () => ({ taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', runId: 'run-2', safeScopeRef: 'scope-2', policyIdentity: identity });
    if (scenario === 'control-retry-wait') await state.service.requestDecision({ ...state.binding, decisionId: 'decision-2' });
    else await state.service.control({ taskId: 'task-1', taskVersion: 4, direction: 'end', responseKey: 'later-end' });
    state.context.loadForTask = async () => { throw new Error('retry must not reload changed scope'); };
  }
  if (scenario === 'control-conflict') await state.service.control({ taskId: 'task-1', taskVersion: 3, direction: 'resume', responseKey: 'direction-1' });
  const result = await runApprovalCli(process.argv.slice(4), state.service);
  process.send?.(state.snapshot('committed'));
  if (scenario === 'control-interrupt-after') await new Promise(() => { /* Observe committed state before stdout is lost. */ });
  process.stdout.write(result.output + '\n');
  process.exitCode = result.exitCode;
} else {
  const child = (args: readonly string[], scenario = 'normal') => spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'uc05-cli-test-driver', scenario, ...args], { encoding: 'utf8', timeout: 5000 });
  const controlArgs = (direction = 'resume', version = '3', responseKey = 'direction-1') => ['control', '--task', 'task-1', '--task-version', version, '--direction', direction, '--response-key', responseKey];
  const observedChild = async (args: readonly string[], scenario: string, interrupt?: NodeJS.Signals) => {
    const processChild = spawn(process.execPath, [fileURLToPath(import.meta.url), 'uc05-cli-test-driver', scenario, ...args], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    assert.ok(processChild.stdin && processChild.stdout && processChild.stderr);
    let stdout = '', stderr = '', timedOut = false, interrupted = false;
    const snapshots: unknown[] = [];
    processChild.stdout.on('data', chunk => { stdout += String(chunk); });
    processChild.stderr.on('data', chunk => { stderr += String(chunk); });
    processChild.on('message', snapshot => { snapshots.push(snapshot); if (interrupt) interrupted = processChild.kill(interrupt); });
    // EOF carries no operator direction; only the explicit argv above may submit one.
    processChild.stdin.end();
    const timer = setTimeout(() => { timedOut = true; processChild.kill('SIGKILL'); }, 5000);
    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        processChild.on('error', reject);
        processChild.on('close', (code, signal) => resolve({ code, signal }));
      });
      return { ...exit, stdout, stderr, snapshots, timedOut, interrupted };
    } finally { clearTimeout(timer); if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill('SIGKILL'); }
  };

  test('actual subprocess lists one explicitly selected task, shows and inspects its exact registered action', () => {
    const listed = child(['list', '--task', 'task-1']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /decision-1/);
    const shown = child(['show', '--task', 'task-1', '--request', 'decision-1']);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /Verify repair/);
    const inspected = child(['inspect', '--task', 'task-1', '--request', 'decision-1', '--page', '1']);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.match(inspected.stdout, /tests\/other.py/);
  });

  test('actual subprocess records explicit resume after rejection without treating direction as approval', () => {
    const response = child(['control', '--task', 'task-1', '--task-version', '3', '--direction', 'resume', '--response-key', 'resume'], 'control-normal');
    assert.equal(response.status, 0, response.stdout + response.stderr);
    assert.partialDeepStrictEqual(JSON.parse(response.stdout), { outcome: 'ok', safeReasonCode: 'approval-cli-recorded', value: { safeReasonCode: 'direction-recorded', decisionId: null, controlVersion: 4 } });
  });

  test('actual control subprocess records resume/revise/end, preserving the rejected decision and one direction', async () => {
    for (const direction of ['resume', 'revise', 'end']) {
      const response = await observedChild(controlArgs(direction), 'control-normal');
      assert.equal(response.code, 0, response.stdout + response.stderr);
      assert.partialDeepStrictEqual(JSON.parse(response.stdout), { outcome: direction === 'end' ? 'paused' : 'ok', safeReasonCode: 'approval-cli-recorded', value: { safeReasonCode: 'direction-recorded', decisionId: null } });
      assert.partialDeepStrictEqual(response.snapshots, [{ stage: 'committed', mode: direction === 'end' ? 'ended' : 'runnable', version: 4, directions: 1, resolutions: ['rejected'], events: 3 }]);
    }
    const endPending = await observedChild(controlArgs('end', '2'), 'control-pending');
    assert.equal(endPending.code, 0, endPending.stdout + endPending.stderr);
    assert.partialDeepStrictEqual(endPending.snapshots, [{ mode: 'ended', directions: 1, resolutions: [], events: 2 }]);
    const cannotApprove = await observedChild(controlArgs('resume', '2'), 'control-pending');
    assert.equal(cannotApprove.code, 4, cannotApprove.stdout + cannotApprove.stderr);
    assert.partialDeepStrictEqual(cannotApprove.snapshots, [{ mode: 'waiting', directions: 0, resolutions: [], events: 1 }]);
  });

  test('identical original control argv confirms one accepted direction while preserving a newer hold or end', async () => {
    for (const [scenario, mode, directions] of [['control-retry-wait', 'waiting', 1], ['control-retry-end', 'ended', 2]] as const) {
      const response = await observedChild(controlArgs('revise'), scenario);
      assert.equal(response.code, 0, response.stdout + response.stderr);
      assert.partialDeepStrictEqual(JSON.parse(response.stdout), { safeReasonCode: 'approval-cli-recorded', value: { safeReasonCode: 'direction-recorded', controlVersion: 5 } });
      assert.partialDeepStrictEqual(response.snapshots, [{ mode, version: 5, directions, resolutions: ['rejected'], events: 4 }]);
    }
  });

  test('control subprocess translates authority, version, response conflicts and dependency failures safely', async () => {
    for (const [scenario, args, code, outcome, mode, directions] of [
      ['control-normal', controlArgs('resume', '2'), 3, 'conflict', 'rejected', 0],
      ['control-conflict', controlArgs('end'), 3, 'conflict', 'runnable', 1],
      ['control-normal', controlArgs().map(value => value === 'task-1' ? 'foreign' : value), 2, 'invalid', 'rejected', 0],
      ['control-no-operator', controlArgs(), 4, 'denied', 'rejected', 0],
      ['control-failed-store', controlArgs(), 5, 'unavailable', 'rejected', 0],
      ['control-missing-context', controlArgs(), 5, 'unavailable', 'rejected', 0],
      ['control-activity-fault', controlArgs(), 5, 'unavailable', 'rejected', 0],
      ['control-uncertain', controlArgs(), 5, 'uncertain', 'runnable', 1],
      ['control-protected', controlArgs(), 5, 'unavailable', 'runnable', 1],
    ] as const) {
      const response = await observedChild(args, scenario);
      assert.equal(response.code, code, response.stdout + response.stderr);
      assert.partialDeepStrictEqual(JSON.parse(response.stdout), { outcome, safeReasonCode: 'approval-cli-denied' });
      assert.partialDeepStrictEqual(response.snapshots, [{ mode, directions, resolutions: ['rejected'] }]);
      assert.ok(Buffer.byteLength(response.stdout) <= 65536);
      assert.doesNotMatch(response.stdout + response.stderr, /MARKER_SECRET|DO_NOT_DISCLOSE|Error:|at file:/);
    }
  });

  test('control grammar rejects missing, duplicate, unknown, unsafe and injected selectors with pause retained at EOF', async () => {
    const valid = controlArgs();
    for (const args of [[], ['control'], valid.slice(0, -2), [...valid, '--request', 'decision-1'],
      [...valid.slice(0, -2), '--direction', 'end'], [...valid, '--actor', 'operator-1'],
      ...['0', '-1', '1.5', '01', '9007199254740992'].map(version => controlArgs('resume', version)),
      ...['approve', 'feedback', '', 'resume\u001b', 'end\n'].map(direction => controlArgs(direction)),
      controlArgs('resume', '3', ''), controlArgs('resume', '3', '../escape'), controlArgs('resume', '3', 'x'.repeat(257))]) {
      const response = await observedChild(args, 'control-normal');
      assert.equal(response.code, 2, JSON.stringify(args) + response.stdout + response.stderr);
      assert.partialDeepStrictEqual(response.snapshots, [{ mode: 'rejected', directions: 0, resolutions: ['rejected'], events: 2 }]);
    }
    const pending = await observedChild([], 'normal');
    assert.equal(pending.code, 2);
    assert.partialDeepStrictEqual(pending.snapshots, [{ mode: 'waiting', directions: 0, resolutions: [], events: 1 }]);
  });

  test('actual process interruption observes the same mock pause before submission and recorded end before lost output', async t => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const before = await observedChild(controlArgs(), 'control-interrupt-before', signal);
      assert.equal(before.stdout, '');
      assert.equal(before.timedOut, false);
      assert.equal(before.interrupted, true);
      assert.ok(before.signal !== null || before.code !== 0, JSON.stringify(before));
      assert.partialDeepStrictEqual(before.snapshots, [{ stage: 'before', mode: 'rejected', version: 3, directions: 0, resolutions: ['rejected'], events: 2 }]);
      const after = await observedChild(controlArgs('end'), 'control-interrupt-after', signal);
      assert.equal(after.stdout, '');
      assert.equal(after.timedOut, false);
      assert.equal(after.interrupted, true);
      assert.ok(after.signal !== null || after.code !== 0, JSON.stringify(after));
      assert.partialDeepStrictEqual(after.snapshots, [{ stage: 'committed', mode: 'ended', version: 4, directions: 1, resolutions: ['rejected'], events: 3 }]);
      t.diagnostic(`${process.platform} ${signal}: before exit=${before.code} signal=${before.signal}; after exit=${after.code} signal=${after.signal}; parent-retained IPC mock observations only`);
    }
  });

  test('actual subprocess records only an exact displayed response through injected host authority', async () => {
    const { presentationDigest } = await fixture('normal');
    const args = ['decide', '--task', 'task-1', '--request', 'decision-1', '--task-version', '2', '--request-version', '1', '--presentation-digest', presentationDigest, '--decision', 'approve', '--response-key', 'response-1'];
    const approved = child(args);
    assert.equal(approved.status, 0, approved.stdout + approved.stderr);
    assert.match(approved.stdout, /decision-recorded/);
    assert.equal(child(args, 'no-operator').status, 4);
    assert.equal(child(args, 'failed-store').status, 5);
    assert.equal(child(args.map(token => token === presentationDigest ? digest : token)).status, 3);
    assert.equal(child(args.map(token => token === '2' ? '99' : token)).status, 3);
    const rejected = child(args.map(token => token === 'approve' ? 'reject' : token));
    assert.equal(rejected.status, 0);
    assert.match(rejected.stdout, /paused/);
    const rejectedOutput: unknown = JSON.parse(rejected.stdout);
    assert.partialDeepStrictEqual(rejectedOutput, { outcome: 'paused', safeReasonCode: 'approval-cli-recorded' });
  });

  test('actual subprocess refuses missing, duplicated, unknown, injected and foreign selectors', () => {
    for (const args of [[], ['list'], ['list', '--task', 'task-1', '--task', 'task-1'], ['list', '--actor', 'operator-1'],
      ['list', '--task', '\u001b]0;approve\u0007'], ['list', '--task', 'task-1;approve'],
      ['inspect', '--task', 'task-1', '--request', 'decision-1', '--page', '0'],
      ['inspect', '--task', 'task-1', '--request', 'decision-1', '--page', '../secret'],
      ['decide', '--task', 'task-1'], ['control', '--task', 'task-1'], ['show', '--task', 'other-task', '--request', 'decision-1'],
      ['show', '--task', 'task-1', '--request', 'foreign']]) {
      const response = child(args);
      assert.equal(response.status, 2, JSON.stringify(args) + response.stdout + response.stderr);
      assert.doesNotMatch(response.stdout, /Error:|at file:|operator-1|secret|\u001b/);
    }
  });

  test('direct executable has no store or environment-selected test-driver composition', () => {
    const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const entry = fileURLToPath(new URL(`../../../src/approvals/cli${extension}`, import.meta.url));
    const response = spawnSync(process.execPath, [entry, 'list', '--task', 'task-1'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, UC05_APPROVAL_DRIVER: fileURLToPath(import.meta.url) } });
    assert.equal(response.status, 5, response.stdout + response.stderr);
    assert.match(response.stdout, /unavailable/);
    assert.doesNotMatch(response.stdout, /decision-1|Verify repair/);
  });

  test('actual subprocess rejects protected shape-valid stored metadata before rendering it', () => {
    for (const args of [['list', '--task', 'task-1'], ['show', '--task', 'task-1', '--request', 'decision-1']]) {
      const response = child(args, 'protected-metadata');
      assert.equal(response.status, 5);
      assert.doesNotMatch(response.stdout + response.stderr, /MARKER_SECRET|DO_NOT_DISCLOSE/);
    }
  });

  test('actual subprocess returns a safe failure exit for protected approval and rejection receipts', async () => {
    const { presentationDigest } = await fixture('normal');
    for (const decision of ['approve', 'reject']) {
      const response = child(['decide', '--task', 'task-1', '--request', 'decision-1', '--task-version', '2', '--request-version', '1', '--presentation-digest', presentationDigest, '--decision', decision, '--response-key', 'response-1'], 'protected-receipt');
      assert.notEqual(response.status, 0, response.stdout + response.stderr);
      assert.equal(JSON.parse(response.stdout).outcome, 'unavailable');
      assert.equal(response.status, 5);
      assert.doesNotMatch(response.stdout + response.stderr, /MARKER_SECRET|DO_NOT_DISCLOSE|decision-not-recorded/);
    }
  });
}
