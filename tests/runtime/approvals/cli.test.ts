import {
  buildPresentationV02,
  buildPresentationCompatibilityV01,
  validateSafePresentationV02,
  type PresentationInputV02,
} from '../../../src/approvals/presentation.ts';
import { runApprovalCliV02 } from '../../../src/approvals/cli.ts';
import { UC05_APPROVAL_SCHEMA_VERSION_V02 } from '../../../src/contracts/approvals/contracts.ts';
import type { ProviderRequest } from '../../../src/contracts/foundation/uc03.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApprovalService } from '../../../src/approvals/service.ts';
import { runApprovalCli } from '../../../src/approvals/cli.ts';
import { computeActionDigest } from '../../../src/contracts/foundation/uc03.ts';
import { computeRequestContentDigest, validateProviderRequest } from '../../../src/contracts/foundation/uc03.ts';
import { createMockApprovalStore } from '../support/uc05/mock-store.ts';
import { createMockActivityControl } from '../support/uc05/mock-context.ts';
import { createFixtureProviderAdmissionContextV02 } from '../support/uc03/port-fixtures.ts';
import type { PolicyProfile } from '../../../src/contracts/approvals/contracts.ts';
import type { ApprovalStore } from '../../../src/approvals/service.ts';

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
  if (scenario === 'utf8') action.argv = ['-q', 'tests/other.py', '--label=日本語-kiểm-chứng'];
  const binding = { decisionId: 'decision-1', actionKind: 'action' as const, normalizedActionDigest: computeActionDigest(action), taskId: 'task-1', workspaceId: 'workspace-1', repositoryRevisionDigest: digest, policyId: 'policy-1', policyVersion: '1', status: 'pending' as const };
  const store = createMockApprovalStore({ profile, initialControls: [{ schemaVersion: 'uc05-approval/0.1-draft', taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', version: 1, epoch: 1, mode: 'runnable', pendingDecisionId: null, continuationRef: null, reasonCode: 'ready', outstandingClaimRefs: [] }] });
  const trusted = { action, runId: 'run-1', freshness: { currentTaskId: 'task-1', currentWorkspaceId: 'workspace-1', currentRepositoryRevisionDigest: digest, currentPolicyId: 'policy-1', currentPolicyVersion: '1', currentNormalizedActionDigest: computeActionDigest(action) },
    elements: { action: 'Run tests', necessity: 'Verify repair', targets: ['tests/other.py'], consequences: 'Isolated test run', verificationStatus: 'Not executed' },
    facts: { taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', repositoryRevisionDigest: digest, policyIdentity: identity, registeredActionDigest: computeActionDigest(action), continuationRef: 'continuation-1', role: 'coder' as const,
      safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
      command: { executableRef: 'pytest', resolvedExecutable: 'pytest', workingDirectoryRef: 'repository-root', workingDirectory: '/workspace', constrainedCapability: 'constrained-tests' }, patch: null, plan: null } };
  if (scenario === 'utf8') trusted.elements.necessity = 'Kiểm chứng đầy đủ 日本語';
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
  let selectedService = scenario === 'no-operator' || scenario === 'control-no-operator' ? createApprovalService(options)
    : scenario === 'protected-metadata' ? createApprovalService({ ...options, store: protectedStore, operator })
    : scenario === 'protected-receipt' ? createApprovalService({ ...options, store: protectedReceiptStore, operator })
    : scenario === 'control-uncertain' || scenario === 'control-protected' ? createApprovalService({ ...options, store: directionStore, operator })
    : scenario === 'control-activity-fault' ? createApprovalService({ ...options, operator, activity: { ...activity, inspectOutstanding: () => { throw new Error('MARKER_SECRET_DO_NOT_DISCLOSE'); } } })
    : scenario === 'control-missing-context' ? createApprovalService({ ...options, operator, context: { loadForAction: context.loadForAction, loadForDecision: context.loadForDecision } }) : service;
  if (scenario.startsWith('history-') || scenario.startsWith('decision-')) {
    if (['history-approved', 'history-stale', 'history-uninspectable', 'history-paged', 'history-too-large', 'history-tiny-page'].includes(scenario)) {
      await service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: 2, requestVersion: 1, presentationDigest, decision: 'approve', responseKey: 'response-1' });
    }
    if (scenario === 'history-rejected' || scenario.startsWith('history-observation-')) {
      await service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: 2, requestVersion: 1, presentationDigest, decision: 'reject', responseKey: 'response-1' });
    }
    if (scenario === 'history-stale' || scenario === 'decision-stale') trusted.freshness.currentRepositoryRevisionDigest = `sha256:${'b'.repeat(64)}`;
    if (scenario === 'history-forbidden' || scenario === 'decision-forbidden') trusted.facts.safety.testsPreserved = false;
    if (scenario === 'history-allowed') {
      action.argv = ['-q', 'tests/'];
      trusted.facts.registeredActionDigest = computeActionDigest(action);
      trusted.freshness.currentNormalizedActionDigest = computeActionDigest(action);
    }
    if (scenario === 'history-uninspectable') context.loadForDecision = async () => { throw new Error('MARKER_SECRET_DO_NOT_DISCLOSE RAW_PROMPT_MARKER\u001b]0;approve\u0007\u202e'); };
    if (scenario === 'history-paged' || scenario === 'history-too-large' || scenario === 'history-tiny-page') {
      trusted.elements.necessity = 'Kiểm chứng đầy đủ 日本語';
      await service.requestDecision({ ...binding, decisionId: 'decision-2' });
      selectedService = createApprovalService({ ...options, operator, profile: { ...profile,
        maxPresentationPageBytes: scenario === 'history-tiny-page' ? 512 : 4096,
        maxPresentationPages: scenario === 'history-too-large' ? 1 : 3,
        maxPresentationTotalBytes: scenario === 'history-tiny-page' ? 1536 : scenario === 'history-too-large' ? 4096 : 12288 } });
    }
    if (scenario.startsWith('history-observation-')) selectedService = createApprovalService({ ...options, operator,
      observations: { provenance: 'mock', read: async () => [{ observationId: 'observation-1', taskId: 'task-1', runId: 'run-1', decisionId: 'decision-1', attemptId: 'attempt-1', claimId: null, state: scenario.slice('history-observation-'.length), observedAt: '2026-10-22T00:00:00Z', evidenceRef: 'owner-evidence-1' }] } });
    if (scenario === 'history-no-store' || scenario === 'decision-no-store') selectedService = createApprovalService({ taskId: 'task-1', profile, context, operator, activity, now: options.now });
    if (scenario === 'history-failed-store') selectedService = createApprovalService({ ...options, operator, store: { ...store, readHistory: () => { throw new Error('RAW_TOOL_STREAM_MARKER\u001b]0;approve\u0007\u202e'); } } });
    if (scenario === 'history-uncertain-store') selectedService = createApprovalService({ ...options, operator, store: { ...store, readHistory: (taskId: string) => {
      const response = store.readHistory(taskId);
      return { ...response, safe: { ...response.safe, outcome: 'uncertain' } };
    } } });
    if (scenario === 'decision-uncertain' || scenario === 'decision-lost-response' || scenario === 'decision-lost-retry') selectedService = createApprovalService({ ...options, operator, store: { ...store, resolvePending: (input: unknown) => {
      const response = store.resolvePending(input);
      if (scenario !== 'decision-uncertain') throw new Error('RAW_TOOL_STREAM_MARKER\u001b]0;approve\u0007\u202e');
      return { ...response, safe: { ...response.safe, outcome: 'uncertain', eventRef: null } };
    } } });
    if (scenario.startsWith('history-unsafe-')) {
      const marker = scenario.slice('history-unsafe-'.length);
      const payload = marker === 'secret' ? 'MARKER_SECRET_DO_NOT_DISCLOSE' : marker === 'ansi' ? '\u001b[31mapprove' : marker === 'osc' ? '\u001b]0;approve\u0007' : marker === 'bidi' ? '\u202eapprove' : 'RAW_PROMPT_MARKER';
      // Inject unknown owner data at the existing adapter port, never a fake service result.
      const backend: ApprovalStore = { ...store, readEvents: taskId => {
        const response = store.readEvents(taskId);
        return { ...response, value: response.value?.map(event => marker === 'raw' ? { ...event, rawStream: payload } : { ...event, safeReasonCode: payload }) ?? null };
      } };
      selectedService = createApprovalService({ ...options, operator, store: backend });
    }
  }
  const snapshot = (stage: string) => ({ stage, mode: store.loadTaskControl('task-1').value?.mode, version: store.loadTaskControl('task-1').value?.version, directions: store.readHistory('task-1').value?.directions.length, resolutions: store.readHistory('task-1').value?.resolutions.map(value => value.decision), events: store.readEvents('task-1').value?.length });
  return { service: selectedService, healthyService: service, presentationDigest, store, context, binding, snapshot };
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
  if (scenario === 'decision-retry' || scenario === 'decision-retry-newer' || scenario === 'decision-reject-retry') {
    const initial = await runApprovalCli(process.argv.slice(4), state.service);
    if (initial.exitCode !== 0) throw new Error('test-driver initial decision failed');
    if (scenario === 'decision-retry-newer') await state.service.requestDecision({ ...state.binding, decisionId: 'decision-2' });
  }
  if (scenario === 'decision-conflict' || scenario === 'decision-conflict-key') await state.service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: 2, requestVersion: 1, presentationDigest: state.presentationDigest, decision: 'approve', responseKey: scenario === 'decision-conflict-key' ? 'another-response' : 'response-1' });
  let selectedService = state.service;
  if (scenario === 'decision-lost-retry') {
    const initial = await runApprovalCli(process.argv.slice(4), selectedService);
    process.send?.({ result: initial, ...state.snapshot('lost-response') });
    selectedService = state.healthyService;
  }
  if (scenario === 'history-paged') {
    const first = JSON.parse((await runApprovalCli(['history', '--task', 'task-1', '--page', '1'], selectedService)).output);
    const pages = [first.value];
    for (let page = 2; page <= first.value.pageCount; page += 1) pages.push(JSON.parse((await runApprovalCli(['history', '--task', 'task-1', '--page', String(page)], selectedService)).output).value);
    process.send?.({ stage: 'pages', pages });
  }
  const result = await runApprovalCli(process.argv.slice(4), selectedService);
  process.send?.({ ...state.snapshot('committed'), ...(['decision-uncertain', 'decision-lost-response'].includes(scenario ?? '') ? { bindingValid: await selectedService.validateBinding({ ...state.binding, status: 'approved' }) } : {}) });
  if (scenario === 'control-interrupt-after') await new Promise(() => { /* Observe committed state before stdout is lost. */ });
  process.stdout.write(result.output + '\n');
  process.exitCode = result.exitCode;
} else {
  const child = (args: readonly string[], scenario = 'normal') => spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'uc05-cli-test-driver', scenario, ...args], { encoding: 'utf8', timeout: 15000 });
  const controlArgs = (direction = 'resume', version = '3', responseKey = 'direction-1') => ['control', '--task', 'task-1', '--task-version', version, '--direction', direction, '--response-key', responseKey];
  const historyArgs = (page = '1', task = 'task-1') => ['history', '--task', task, '--page', page];
  const decisionArgs = async (decision = 'approve') => ['decide', '--task', 'task-1', '--request', 'decision-1', '--task-version', '2', '--request-version', '1', '--presentation-digest', (await fixture('normal')).presentationDigest, '--decision', decision, '--response-key', 'response-1'];
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
    const timer = setTimeout(() => { timedOut = true; processChild.kill('SIGKILL'); }, 15000);
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

  test('actual history subprocess reads complete bounded metadata without implying execution', async () => {
    const response = await observedChild(['history', '--task', 'task-1', '--page', '1'], 'normal');
    assert.equal(response.code, 0, response.stdout + response.stderr);
    const envelope = JSON.parse(response.stdout);
    assert.partialDeepStrictEqual(envelope, { outcome: 'ok', value: { taskId: 'task-1', page: 1, pageCount: 1, truncated: false } });
    assert.match(envelope.value.snapshotDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(envelope.value.totalBytes, Buffer.byteLength(JSON.stringify(envelope.value)));
    assert.ok(envelope.value.totalBytes <= profile.maxPresentationPageBytes);
    const entries = JSON.parse(envelope.value.content);
    assert.ok(entries.some((entry: { kind: string; status: string }) => entry.kind === 'execution' && entry.status === 'unknown'));
    assert.ok(entries.some((entry: { kind: string; status: string }) => entry.kind === 'cancellation' && entry.status === 'unknown'));
    assert.doesNotMatch(response.stdout + response.stderr, /tests\/other.py|Verify repair|pytest|commandOutput|rawStream/);
    assert.partialDeepStrictEqual(response.snapshots, [{ mode: 'waiting', version: 2, directions: 0, resolutions: [], events: 1 }]);
  });

  test('history inspection succeeds for immutable approval/rejection and stale or unavailable current details', async () => {
    for (const [scenario, decision, mode, current] of [
      ['history-approved', 'approved', 'runnable', 'valid'],
      ['history-rejected', 'rejected', 'rejected', 'valid'],
      ['history-stale', 'approved', 'runnable', 'stale'],
      ['history-uninspectable', 'approved', 'runnable', 'unknown'],
    ]) {
      const response = await observedChild(historyArgs(), scenario ?? '');
      assert.equal(response.code, 0, response.stdout + response.stderr);
      const entries: Record<string, unknown>[] = JSON.parse(JSON.parse(response.stdout).value.content);
      assert.partialDeepStrictEqual(entries.find(entry => entry['kind'] === 'resolution'), { decision, decisionId: 'decision-1', source: 'committed-owner-record' });
      assert.partialDeepStrictEqual(entries.find(entry => entry['kind'] === 'current-assessment'), { status: current, source: 'derived-current-observation' });
      assert.partialDeepStrictEqual(entries.find(entry => entry['kind'] === 'execution'), { status: 'unknown', verifiedCompletion: 'unknown' });
      assert.partialDeepStrictEqual(response.snapshots, [{ mode, resolutions: [decision], events: 2, directions: 0 }]);
      assert.doesNotMatch(response.stdout + response.stderr, /RAW_PROMPT|RAW_TOOL|MARKER_SECRET|DO_NOT_DISCLOSE|Error:|\u001b|\u202e|pytest|Verify repair/);
    }
    assert.equal(child(['show', '--task', 'task-1', '--request', 'decision-1'], 'history-stale').status, 3);
    assert.equal(child(['inspect', '--task', 'task-1', '--request', 'decision-1', '--page', '1'], 'history-uninspectable').status, 5);
  });

  test('CLI history reports current classifications independently from the pending immutable request', async () => {
    for (const [scenario, classification, status] of [['normal', 'APPROVAL_REQUIRED', 'valid'], ['history-allowed', 'ALLOWED', 'stale'], ['history-forbidden', 'FORBIDDEN', 'denied']] as const) {
      const response = await observedChild(historyArgs(), scenario);
      assert.equal(response.code, 0, response.stdout + response.stderr);
      const entries: Record<string, unknown>[] = JSON.parse(JSON.parse(response.stdout).value.content);
      assert.partialDeepStrictEqual(entries.find(entry => entry['kind'] === 'current-assessment'), { classification, status });
      assert.partialDeepStrictEqual(response.snapshots, [{ mode: 'waiting', resolutions: [], events: 1 }]);
    }
  });

  test('CLI preserves known activity evidence and rejected pause without inventing verified completion or rollback', async () => {
    for (const state of ['cancelled', 'failed', 'completed', 'uncertain', 'cancellation-requested']) {
      const response = await observedChild(historyArgs(), `history-observation-${state}`);
      assert.equal(response.code, 0, response.stdout + response.stderr);
      const entries: Record<string, unknown>[] = JSON.parse(JSON.parse(response.stdout).value.content);
      assert.partialDeepStrictEqual(entries.find(entry => entry['kind'] === 'activity-observation'), { state, source: 'owner-activity-observation', verifiedCompletion: 'unknown', evidenceRef: 'owner-evidence-1' });
      assert.partialDeepStrictEqual(entries.find(entry => entry['kind'] === 'cancellation'), { status: 'unknown' });
      assert.partialDeepStrictEqual(entries.find(entry => entry['kind'] === 'execution'), { status: 'unknown', verifiedCompletion: 'unknown' });
      assert.partialDeepStrictEqual(response.snapshots, [{ mode: 'rejected', version: 3, directions: 0, resolutions: ['rejected'], events: 2 }]);
    }
  });

  test('history grammar requires exact task/page selectors and never selects the current request implicitly', async () => {
    for (const args of [[], ['history'], ['history', '--task', 'task-1'], ['history', '--page', '1'],
      ['history', '--task', 'task-1', '--task', 'task-1'], ['history', '--page', '1', '--page', '1'],
      [...historyArgs(), '--request', 'decision-1'], ['history', '--task', 'task-1', '--request', 'decision-1'],
      ['show', '--task', 'task-1'], ['inspect', '--task', 'task-1', '--page', '1'],
      ...['0', '-1', '1.5', '01', '9007199254740992', '999', '../secret', '1\n', '1\u001b', '1\u202e'].map(page => historyArgs(page)),
      ...['foreign-task', '../escape', '', 'task-1\u001b', 'task-1\u202e', 'x'.repeat(257)].map(task => historyArgs('1', task))]) {
      const response = await observedChild(args, 'normal');
      assert.equal(response.code, 2, JSON.stringify(args) + response.stdout + response.stderr);
      assert.partialDeepStrictEqual(response.snapshots, [{ mode: 'waiting', resolutions: [], directions: 0, events: 1 }]);
      assert.doesNotMatch(response.stdout + response.stderr, /decision-1|Error:|secret|\u001b|\u202e/);
    }
    const reordered = child(['history', '--page', '1', '--task', 'task-1']);
    assert.equal(reordered.status, 0, reordered.stdout + reordered.stderr);
  });

  test('history CLI keeps complete pages and aggregate byte accounting from the same child owner state', async () => {
    const response = await observedChild(historyArgs(), 'history-paged');
    assert.equal(response.code, 0, response.stdout + response.stderr);
    const snapshot = response.snapshots[0] as { stage: string; pages: { content: string; page: number; pageCount: number; totalBytes: number; snapshotDigest: string; truncated: boolean }[] };
    assert.equal(snapshot.stage, 'pages');
    assert.ok(snapshot.pages.length > 1);
    const first = snapshot.pages[0];
    assert.ok(first);
    assert.equal(snapshot.pages.reduce((sum, page) => sum + Buffer.byteLength(JSON.stringify(page)), 0), first.totalBytes);
    assert.ok(first.totalBytes <= 12288);
    const entries: Record<string, unknown>[] = [];
    for (const [index, page] of snapshot.pages.entries()) {
      assert.equal(page.page, index + 1);
      assert.equal(page.pageCount, snapshot.pages.length);
      assert.equal(page.snapshotDigest, first.snapshotDigest);
      assert.equal(page.truncated, false);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096);
      entries.push(...JSON.parse(page.content) as Record<string, unknown>[]);
    }
    assert.equal(entries.filter(entry => entry['kind'] === 'request').length, 2);
    assert.partialDeepStrictEqual(response.snapshots[1], { mode: 'waiting', version: 4, resolutions: ['approved'], events: 3 });
    for (const scenario of ['history-too-large', 'history-tiny-page']) {
      const denied = await observedChild(historyArgs(), scenario);
      assert.equal(denied.code, 4, denied.stdout + denied.stderr);
      assert.partialDeepStrictEqual(JSON.parse(denied.stdout), { outcome: 'denied', safeReasonCode: 'approval-cli-denied' });
      assert.partialDeepStrictEqual(denied.snapshots, [{ mode: 'waiting', resolutions: ['approved'], events: 3 }]);
    }
  });

  test('actual CLI preserves permitted UTF-8 presentation and exact inspect bytes without leaking details to history', () => {
    const show = child(['show', '--task', 'task-1', '--request', 'decision-1'], 'utf8');
    assert.equal(show.status, 0, show.stdout + show.stderr);
    assert.match(show.stdout, /Kiểm chứng đầy đủ 日本語/);
    const inspect = child(['inspect', '--task', 'task-1', '--request', 'decision-1', '--page', '1'], 'utf8');
    assert.equal(inspect.status, 0, inspect.stdout + inspect.stderr);
    const page = JSON.parse(inspect.stdout).value;
    assert.match(page.content, /--label=日本語-kiểm-chứng/);
    assert.doesNotMatch(page.content, /\ufffd/);
    assert.ok(Buffer.byteLength(page.content) > page.content.length);
    assert.ok(Buffer.byteLength(page.content) <= profile.maxPresentationPageBytes);
    const history = child(historyArgs(), 'utf8');
    assert.equal(history.status, 0, history.stdout + history.stderr);
    assert.doesNotMatch(history.stdout, /kiểm-chứng|Kiểm chứng|日本語|pytest/);
  });

  test('actual CLI decision retries confirm immutable responses while contradictions conflict and newer holds survive', async () => {
    for (const [scenario, decision, code, mode, events] of [
      ['decision-retry', 'approve', 0, 'runnable', 2],
      ['decision-reject-retry', 'reject', 0, 'rejected', 2],
      ['decision-retry-newer', 'approve', 0, 'waiting', 3],
      ['decision-conflict', 'reject', 3, 'runnable', 2],
      ['decision-conflict-key', 'approve', 3, 'runnable', 2],
    ] as const) {
      const response = await observedChild(await decisionArgs(decision), scenario);
      assert.equal(response.code, code, response.stdout + response.stderr);
      assert.partialDeepStrictEqual(JSON.parse(response.stdout), { safeReasonCode: code === 0 ? 'approval-cli-recorded' : 'approval-cli-denied' });
      if (code === 3) assert.equal(JSON.parse(response.stdout).outcome, 'conflict');
      assert.partialDeepStrictEqual(response.snapshots, [{ mode, resolutions: [decision === 'reject' && code === 0 ? 'rejected' : 'approved'], directions: 0, events }]);
    }
  });

  test('actual decision CLI maps stale denial missing storage lost responses and uncertainty without claiming noncommit', async () => {
    for (const [scenario, code, outcome, mode, resolutions] of [
      ['decision-stale', 3, 'stale', 'waiting', []],
      ['decision-forbidden', 4, 'denied', 'waiting', []],
      ['decision-no-store', 5, 'unavailable', 'waiting', []],
      ['decision-lost-response', 5, 'unavailable', 'runnable', ['approved']],
      ['decision-uncertain', 5, 'uncertain', 'runnable', ['approved']],
    ] as const) {
      const response = await observedChild(await decisionArgs(), scenario);
      assert.equal(response.code, code, response.stdout + response.stderr);
      assert.partialDeepStrictEqual(JSON.parse(response.stdout), { outcome, safeReasonCode: 'approval-cli-denied' });
      assert.partialDeepStrictEqual(response.snapshots, [{ mode, resolutions, directions: 0, ...(resolutions.length ? { bindingValid: false } : {}) }]);
      assert.doesNotMatch(response.stdout + response.stderr, /RAW_|Error:|\u001b|\u202e|decision-not-recorded/);
    }
    const retry = await observedChild(await decisionArgs(), 'decision-lost-retry');
    assert.equal(retry.code, 0, retry.stdout + retry.stderr);
    assert.partialDeepStrictEqual(retry.snapshots, [{ stage: 'lost-response', result: { exitCode: 5 }, resolutions: ['approved'], events: 2 }, { stage: 'committed', resolutions: ['approved'], events: 2 }]);
  });

  test('decision selectors must identify the exact displayed request and version without implicit approval', async () => {
    const valid = await decisionArgs();
    for (const args of [valid.slice(0, -2), [...valid, '--actor', 'operator-1'],
      valid.map(value => value === '--request' ? '--task' : value),
      ...['0', '-1', '01', '1.5', '9007199254740992', '2\u202e'].map(version => valid.map((value, index) => valid[index - 1] === '--task-version' ? version : value)),
      ...['0', '01', '-1', '9007199254740992'].map(version => valid.map((value, index) => valid[index - 1] === '--request-version' ? version : value)),
      ...['approve\u001b', 'APPROVE', 'resume', ''].map(decision => valid.map((value, index) => valid[index - 1] === '--decision' ? decision : value)),
      valid.map((value, index) => valid[index - 1] === '--presentation-digest' ? 'sha256:wrong' : value),
      valid.map((value, index) => valid[index - 1] === '--request' ? 'foreign-request' : value),
      valid.map((value, index) => valid[index - 1] === '--task' ? 'foreign-task' : value)]) {
      const response = await observedChild(args, 'normal');
      assert.equal(response.code, 2, response.stdout + response.stderr);
      assert.partialDeepStrictEqual(response.snapshots, [{ mode: 'waiting', resolutions: [], events: 1 }]);
      assert.doesNotMatch(response.stdout + response.stderr, /Error:|\u001b|\u202e|decision-recorded/);
    }
    const changedRequestVersion = await observedChild(valid.map((value, index) => valid[index - 1] === '--request-version' ? '2' : value), 'normal');
    assert.equal(changedRequestVersion.code, 3, changedRequestVersion.stdout + changedRequestVersion.stderr);
    assert.partialDeepStrictEqual(changedRequestVersion.snapshots, [{ mode: 'waiting', resolutions: [], events: 1 }]);
  });

  test('history CLI fails safely on missing uncertain failed raw protected and terminal owner evidence', async () => {
    for (const scenario of ['history-no-store', 'history-failed-store', 'history-uncertain-store', ...['raw', 'secret', 'ansi', 'osc', 'bidi'].map(marker => `history-unsafe-${marker}`)]) {
      const response = await observedChild(historyArgs(), scenario);
      assert.equal(response.code, 5, scenario + response.stdout + response.stderr);
      assert.partialDeepStrictEqual(JSON.parse(response.stdout), { outcome: 'unavailable', safeReasonCode: 'approval-cli-denied' });
      assert.partialDeepStrictEqual(response.snapshots, [{ mode: 'waiting', resolutions: [], events: 1, directions: 0 }]);
      assert.doesNotMatch(response.stdout + response.stderr, /RAW_|MARKER_SECRET|DO_NOT_DISCLOSE|Error:|approve|\u001b|\u202e/);
    }
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
    const history = spawnSync(process.execPath, [entry, ...historyArgs()], { encoding: 'utf8', timeout: 5000, env: { ...process.env, UC05_APPROVAL_DRIVER: fileURLToPath(import.meta.url) } });
    assert.equal(history.status, 5, history.stdout + history.stderr);
    assert.partialDeepStrictEqual(JSON.parse(history.stdout), { outcome: 'unavailable' });
    assert.doesNotMatch(history.stdout + history.stderr, /decision-1|Verify repair|pytest/);
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
  test('v0.2 approval presentation and CLI records (T055/T056)', async () => {
    // 1. Valid current v0.2 presentation records on both branches
    const validRepoPrePlan: PresentationInputV02 = {
      subjectKind: 'repository-action',
      planApplicability: 'pre-plan-diagnostic',
      requestVersion: 1,
      decisionId: 'decision-repo-pre',
      repositoryId: 'repository-1',
      continuationRef: 'continuation-1',
      policyIdentity: identity,
      elements: { action: 'Run tests', necessity: 'Verify diagnostic baseline', targets: ['tests/other.py'], consequences: 'Isolated test run', verificationStatus: 'Not executed' },
      action: { actionId: 'action-1', kind: 'run_command', executable: 'pytest', argv: ['-q', 'tests/other.py'], workingDirectory: '/workspace' },
      diagnosticPurpose: 'investigation_reproduction',
      taskCriteriaDigest: digest,
    };

    const validRepoApprovedPlan: PresentationInputV02 = {
      subjectKind: 'repository-action',
      planApplicability: 'approved-plan',
      requestVersion: 1,
      decisionId: 'decision-repo-plan',
      repositoryId: 'repository-1',
      continuationRef: 'continuation-1',
      policyIdentity: identity,
      elements: { action: 'Apply repair patch', necessity: 'Fix identified defect', targets: ['src/core.ts'], consequences: 'Modifies workspace file', verificationStatus: 'Pending verification' },
      action: { actionId: 'action-2', kind: 'run_command', executable: 'git', argv: ['apply'], workingDirectory: '/workspace' },
      planBindingDigest: digest,
      planDecisionRef: 'decision-plan-1',
    };

    const providerReq: ProviderRequest = {
      providerRequestId: 'provider-req-1',
      taskId: 'task-1',
      runId: 'run-1',
      role: 'coder',
      purpose: 'reproduction_check',
      providerId: 'provider-1',
      modelId: 'model-1',
      configId: 'config-1',
      pricingPolicyId: 'pricing-1',
      contextDigest: digest,
      timeoutMs: 2000,
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxBillableTokens: 220,
      maxCostUsd: 0.25,
      reservationRef: 'reservation-1',
      dispatchState: 'reserved',
    };

    const validProviderPrePlan: PresentationInputV02 = {
      subjectKind: 'provider-request',
      planApplicability: 'pre-plan-diagnostic',
      requestVersion: 1,
      decisionId: 'decision-provider-pre',
      repositoryId: 'repository-1',
      continuationRef: 'continuation-1',
      policyIdentity: identity,
      elements: { action: 'Model coder diagnostic', necessity: 'Generate reproduction check', targets: ['tests/reproduce.py'], consequences: 'Consumes provider tokens', verificationStatus: 'Not executed' },
      providerRequest: providerReq,
      diagnosticPurpose: 'coder_reproduction_diagnostic',
      taskCriteriaDigest: digest,
    };

    const validProviderApprovedPlan: PresentationInputV02 = {
      subjectKind: 'provider-request',
      planApplicability: 'approved-plan',
      requestVersion: 1,
      decisionId: 'decision-provider-plan',
      repositoryId: 'repository-1',
      continuationRef: 'continuation-1',
      policyIdentity: identity,
      elements: { action: 'Reviewer evaluation', necessity: 'Review proposed repair candidate', targets: ['src/core.ts'], consequences: 'Consumes reviewer tokens', verificationStatus: 'Not executed' },
      providerRequest: { ...providerReq, providerRequestId: 'provider-req-2', role: 'reviewer', purpose: 'repair_review' },
      planBindingDigest: digest,
      planDecisionRef: 'decision-plan-1',
    };

    const repoPreBundle = buildPresentationV02(validRepoPrePlan, profile);
    assert.equal(repoPreBundle.summary.schemaVersion, UC05_APPROVAL_SCHEMA_VERSION_V02);
    assert.equal(repoPreBundle.summary.subjectKind, 'repository-action');
    assert.equal(repoPreBundle.summary.planApplicability, 'pre-plan-diagnostic');
    assert.equal(repoPreBundle.summary.diagnosticPurpose, 'investigation_reproduction');
    assert.equal(repoPreBundle.summary.taskCriteriaDigest, digest);
    assert.equal(validateSafePresentationV02(repoPreBundle.summary, profile).ok, true);

    const repoPlanBundle = buildPresentationV02(validRepoApprovedPlan, profile);
    assert.equal(repoPlanBundle.summary.schemaVersion, UC05_APPROVAL_SCHEMA_VERSION_V02);
    assert.equal(repoPlanBundle.summary.subjectKind, 'repository-action');
    assert.equal(repoPlanBundle.summary.planApplicability, 'approved-plan');
    assert.equal(repoPlanBundle.summary.planBindingDigest, digest);
    assert.equal(repoPlanBundle.summary.planDecisionRef, 'decision-plan-1');
    assert.equal(validateSafePresentationV02(repoPlanBundle.summary, profile).ok, true);

    const provPreBundle = buildPresentationV02(validProviderPrePlan, profile);
    assert.equal(provPreBundle.summary.schemaVersion, UC05_APPROVAL_SCHEMA_VERSION_V02);
    assert.equal(provPreBundle.summary.subjectKind, 'provider-request');
    assert.equal(provPreBundle.summary.planApplicability, 'pre-plan-diagnostic');
    assert.equal(provPreBundle.summary.role, 'coder');
    assert.equal(validateSafePresentationV02(provPreBundle.summary, profile).ok, true);

    const providerAdmission = createFixtureProviderAdmissionContextV02();
    const providerWithReceipt = buildPresentationV02({
      ...validProviderApprovedPlan,
      providerRequest: providerAdmission.providerRequest,
    }, profile).summary;
    assert.equal(validateProviderRequest(providerAdmission.providerRequest).ok, true);
    if (providerWithReceipt.subjectKind !== 'provider-request') throw new Error('provider presentation branch mismatch');
    assert.equal(providerWithReceipt.providerRequestId, providerAdmission.providerAdmissionReceipt.providerRequestId);
    assert.equal(providerWithReceipt.role, providerAdmission.providerAdmissionReceipt.role);
    assert.equal(providerWithReceipt.requestContentDigest, providerAdmission.providerAdmissionReceipt.requestContentDigest);
    assert.equal(providerWithReceipt.requestContentDigest, computeRequestContentDigest(providerAdmission.providerRequest));
    const incompleteProviderRequest = { providerRequestId: 'provider-req-incomplete', role: 'coder' };
    assert.throws(() => buildPresentationV02({
      ...validProviderPrePlan,
      providerRequest: incompleteProviderRequest,
    } as unknown as PresentationInputV02, profile), /unsafe-presentation/);

    const provPlanBundle = buildPresentationV02(validProviderApprovedPlan, profile);
    assert.equal(provPlanBundle.summary.schemaVersion, UC05_APPROVAL_SCHEMA_VERSION_V02);
    assert.equal(provPlanBundle.summary.subjectKind, 'provider-request');
    assert.equal(provPlanBundle.summary.planApplicability, 'approved-plan');
    assert.equal(provPlanBundle.summary.role, 'reviewer');
    assert.equal(validateSafePresentationV02(provPlanBundle.summary, profile).ok, true);

    const protectedSummary = { ...repoPreBundle.summary, elements: { ...repoPreBundle.summary.elements, necessity: 'MARKER_SECRET_DO_NOT_DISCLOSE' } };
    assert.equal(validateSafePresentationV02(protectedSummary, profile).ok, false);
    assert.equal(validateSafePresentationV02({ ...repoPreBundle.summary, rawPayload: 'unrecognized' }, profile).ok, false);
    assert.equal(validateSafePresentationV02({
      ...repoPreBundle.summary,
      elements: { ...repoPreBundle.summary.elements, action: '\u001b[31mRun tests' },
    }, profile).ok, false);
    assert.equal(validateSafePresentationV02({
      ...repoPreBundle.summary,
      elements: { ...repoPreBundle.summary.elements, action: 'x'.repeat(profile.maxPresentationPageBytes + 1) },
    }, profile).ok, false);
    assert.equal(validateSafePresentationV02({
      ...repoPreBundle.summary,
      page: { ...repoPreBundle.summary.page, pageNumber: 2, pageCount: 1 },
    }, profile).ok, false);

    let getterReads = 0;
    const accessorSummary = { ...repoPreBundle.summary };
    Object.defineProperty(accessorSummary, 'schemaVersion', {
      enumerable: true,
      get: () => { getterReads += 1; return UC05_APPROVAL_SCHEMA_VERSION_V02; },
    });
    assert.equal(validateSafePresentationV02(accessorSummary, profile).ok, false);
    assert.equal(getterReads, 0);
    const proxySummary = new Proxy(repoPreBundle.summary, { get: (target, property, receiver) => Reflect.get(target, property, receiver) });
    assert.equal(validateSafePresentationV02(proxySummary, profile).ok, false);

    // 2. Missing branch fields reject
    const missingRepoDiag = { ...validRepoPrePlan, diagnosticPurpose: undefined } as unknown as PresentationInputV02;
    assert.throws(() => buildPresentationV02(missingRepoDiag, profile), /unsafe-presentation/);
    assert.equal(validateSafePresentationV02({ ...repoPreBundle.summary, diagnosticPurpose: undefined }, profile).ok, false);

    const missingRepoPlan = { ...validRepoApprovedPlan, planBindingDigest: undefined } as unknown as PresentationInputV02;
    assert.throws(() => buildPresentationV02(missingRepoPlan, profile), /unsafe-presentation/);
    assert.equal(validateSafePresentationV02({ ...repoPlanBundle.summary, planBindingDigest: undefined }, profile).ok, false);

    const missingProvRole = { ...validProviderPrePlan, providerRequest: { ...providerReq, role: undefined } } as unknown as PresentationInputV02;
    assert.throws(() => buildPresentationV02(missingProvRole, profile), /unsafe-presentation/);
    assert.equal(validateSafePresentationV02({ ...provPreBundle.summary, role: undefined }, profile).ok, false);

    // 3. Cross-branch fields forbidden
    const repoWithProviderField = { ...validRepoPrePlan, providerRequestId: 'req-1', role: 'coder' } as unknown as PresentationInputV02;
    assert.throws(() => buildPresentationV02(repoWithProviderField, profile), /unsafe-presentation/);
    const repoSummaryWithProv = { ...repoPreBundle.summary, providerRequestId: 'req-1' };
    const repoProvVal = validateSafePresentationV02(repoSummaryWithProv, profile);
    assert.equal(repoProvVal.ok, false);
    assert.ok(repoProvVal.errors.some(e => e.code === 'CROSS_BRANCH_FIELDS_FORBIDDEN'));

    const provWithRepoField = { ...validProviderPrePlan, actionId: 'action-1', actionDigest: digest } as unknown as PresentationInputV02;
    assert.throws(() => buildPresentationV02(provWithRepoField, profile), /unsafe-presentation/);
    const provSummaryWithRepo = { ...provPreBundle.summary, actionId: 'action-1' };
    const provRepoVal = validateSafePresentationV02(provSummaryWithRepo, profile);
    assert.equal(provRepoVal.ok, false);
    assert.ok(provRepoVal.errors.some(e => e.code === 'CROSS_BRANCH_FIELDS_FORBIDDEN'));

    const prePlanWithPlanDigest = { ...validRepoPrePlan, planBindingDigest: digest, planDecisionRef: 'decision-plan-1' } as unknown as PresentationInputV02;
    assert.throws(() => buildPresentationV02(prePlanWithPlanDigest, profile), /unsafe-presentation/);
    const prePlanSummaryWithPlan = { ...repoPreBundle.summary, planBindingDigest: digest };
    const prePlanVal = validateSafePresentationV02(prePlanSummaryWithPlan, profile);
    assert.equal(prePlanVal.ok, false);
    assert.ok(prePlanVal.errors.some(e => e.code === 'CROSS_BRANCH_FIELDS_FORBIDDEN'));

    // 4. Old-version data rejected at the v0.2 boundary
    const v01Summary = {
      schemaVersion: 'uc05-approval/0.1-draft',
      decisionId: 'decision-1',
      requestVersion: 1,
      bindingFingerprint: digest,
      elements: validRepoPrePlan.elements,
      inspectionRef: 'decision-1',
      presentationDigest: digest,
      page: { pageNumber: 1, pageCount: 1, pageBytes: 100, totalBytes: 100, truncated: false },
    };
    const v01Val = validateSafePresentationV02(v01Summary, profile);
    assert.equal(v01Val.ok, false);
    assert.ok(v01Val.errors.some(e => e.code === 'INVALID_SCHEMA_VERSION'));
    assert.throws(() => buildPresentationV02(v01Summary as unknown as PresentationInputV02, profile), /unsafe-presentation/);

    // 5. Deliberate versioned compatibility display retained with no effect authority
    const v01Input = {
      requestVersion: 1,
      binding: { decisionId: 'decision-1', actionKind: 'action' as const, normalizedActionDigest: computeActionDigest(validRepoPrePlan.action), taskId: 'task-1', workspaceId: 'workspace-1', repositoryRevisionDigest: digest, policyId: 'policy-1', policyVersion: '1', status: 'pending' as const },
      freshness: { currentTaskId: 'task-1', currentWorkspaceId: 'workspace-1', currentRepositoryRevisionDigest: digest, currentPolicyId: 'policy-1', currentPolicyVersion: '1', currentNormalizedActionDigest: computeActionDigest(validRepoPrePlan.action) },
      action: validRepoPrePlan.action,
      repositoryId: 'repository-1',
      continuationRef: 'continuation-1',
      policyIdentity: identity,
      elements: validRepoPrePlan.elements,
    };
    const compatBundle = buildPresentationCompatibilityV01(v01Input, profile);
    assert.equal(compatBundle.summary.schemaVersion, 'uc05-approval/0.1-draft');

    const compatShowRes = child(['compat-show', '--task', 'task-1', '--request', 'decision-1']);
    assert.equal(compatShowRes.status, 0, compatShowRes.stderr);
    const compatParsed = JSON.parse(compatShowRes.stdout);
    assert.equal(compatParsed.schemaVersion, 'uc05-approval/0.1-draft');
    assert.equal(compatParsed.outcome, 'ok');

    // Compatibility mode has no effect authority (compat-decide / compat-control fail as invalid commands)
    const compatDecide = child(['compat-decide', '--task', 'task-1']);
    assert.equal(compatDecide.status, 2);
    const compatControl = child(['compat-control', '--task', 'task-1']);
    assert.equal(compatControl.status, 2);

    // 6. Versioned CLI views retain every presentation branch and their own mutation boundary.
    let versionedMutations = 0;
    const versionedService = {
      cliSchemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
      presentationProfileV02: profile,
      listV02: async () => ({ schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, items: [repoPreBundle.summary, repoPlanBundle.summary, provPreBundle.summary, provPlanBundle.summary] }),
      historyV02: async () => ({ schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, records: [repoPreBundle.summary, repoPlanBundle.summary, provPreBundle.summary, provPlanBundle.summary] }),
      showV02: async () => repoPreBundle.summary,
      inspectV02: async () => provPlanBundle.summary,
      decideV02: async () => {
        versionedMutations += 1;
        return { schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, outcome: 'paused', safeReasonCode: 'decision-recorded' };
      },
      controlV02: async () => {
        versionedMutations += 1;
        return { schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, outcome: 'paused', safeReasonCode: 'direction-recorded' };
      },
    };
    const versionedReads = [
      await runApprovalCliV02(['show', '--task', 'task-1', '--request', 'decision-1'], versionedService),
      await runApprovalCliV02(['list', '--task', 'task-1'], versionedService),
      await runApprovalCliV02(['history', '--task', 'task-1', '--page', '1'], versionedService),
      await runApprovalCliV02(['inspect', '--task', 'task-1', '--request', 'decision-1', '--page', '1'], versionedService),
    ];
    for (const response of versionedReads) {
      assert.equal(response.exitCode, 0);
      const parsed = JSON.parse(response.output);
      assert.equal(parsed.schemaVersion, UC05_APPROVAL_SCHEMA_VERSION_V02);
      assert.equal(parsed.outcome, 'ok');
    }
    const versionedDecision = await runApprovalCliV02([
      'decide', '--task', 'task-1', '--request', 'decision-repo-pre', '--task-version', '2', '--request-version', '1',
      '--presentation-digest', repoPreBundle.summary.presentationDigest, '--decision', 'reject', '--response-key', 'versioned-reject',
    ], versionedService);
    const versionedControl = await runApprovalCliV02([
      'control', '--task', 'task-1', '--task-version', '3', '--direction', 'end', '--response-key', 'versioned-end',
    ], versionedService);
    assert.equal(versionedDecision.exitCode, 0);
    assert.equal(versionedControl.exitCode, 0);
    assert.equal(versionedMutations, 2);
  });

  test('v0.2 CLI refuses legacy views and never invokes legacy mutation methods', async () => {
    const state = await fixture('normal');
    let legacyMutationCalls = 0;
    const service = {
      ...state.service,
      decide: async (input: unknown) => {
        legacyMutationCalls += 1;
        return state.service.decide(input);
      },
      control: async (input: unknown) => {
        legacyMutationCalls += 1;
        return state.service.control(input);
      },
    };
    const before = state.snapshot('same');
    const reads: readonly (readonly string[])[] = [
      ['show', '--task', 'task-1', '--request', 'decision-1'],
      ['list', '--task', 'task-1'],
      ['history', '--task', 'task-1', '--page', '1'],
      ['inspect', '--task', 'task-1', '--request', 'decision-1', '--page', '1'],
    ];

    for (const args of reads) {
      const response = await runApprovalCliV02(args, service);
      const parsed = JSON.parse(response.output) as { schemaVersion?: string; outcome?: string };
      assert.equal(response.exitCode, 5, args[0]);
      assert.equal(parsed.schemaVersion, UC05_APPROVAL_SCHEMA_VERSION_V02, args[0]);
      assert.equal(parsed.outcome, 'unavailable', args[0]);
    }

    const decisions = [
      ['decide', '--task', 'task-1', '--request', 'decision-1', '--task-version', '2', '--request-version', '1', '--presentation-digest', state.presentationDigest, '--decision', 'reject', '--response-key', 'legacy-reject'],
      ['control', '--task', 'task-1', '--task-version', '3', '--direction', 'end', '--response-key', 'legacy-end'],
    ];
    for (const args of decisions) {
      const response = await runApprovalCliV02(args, service);
      assert.notEqual(response.exitCode, 0, args[0]);
    }

    assert.equal(legacyMutationCalls, 0);
    assert.deepEqual(state.snapshot('same'), before);
  });

  test('v0.2 CLI rejects legacy and cross-branch records from a versioned capability', async () => {
    const state = await fixture('normal');
    let legacyMutationCalls = 0;
    let versionedMutationCalls = 0;
    const service = {
      ...state.service,
      cliSchemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
      presentationProfileV02: profile,
      listV02: async (taskId: string) => ({ ...await state.service.list(taskId), schemaVersion: 'uc05-approval/0.1-draft' }),
      historyV02: async (taskId: string, page: number) => ({ ...await state.service.history(taskId, page), schemaVersion: 'uc05-approval/0.1-draft' }),
      showV02: async (taskId: string, decisionId: string) => {
        const view = await state.service.show(taskId, decisionId);
        return { ...view, schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, presentation: { ...view.presentation, subjectKind: 'provider-request' } };
      },
      inspectV02: async (taskId: string, decisionId: string, page: number) => ({
        ...await state.service.inspect(taskId, decisionId, page),
        schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
        subjectKind: 'provider-request',
        planApplicability: 'pre-plan-diagnostic',
      }),
      decide: async (input: unknown) => {
        legacyMutationCalls += 1;
        return state.service.decide(input);
      },
      control: async (input: unknown) => {
        legacyMutationCalls += 1;
        return state.service.control(input);
      },
      decideV02: async () => { versionedMutationCalls += 1; return { outcome: 'ok' }; },
      controlV02: async () => { versionedMutationCalls += 1; return { outcome: 'ok' }; },
    };
    const reads: readonly (readonly string[])[] = [
      ['show', '--task', 'task-1', '--request', 'decision-1'],
      ['list', '--task', 'task-1'],
      ['history', '--task', 'task-1', '--page', '1'],
      ['inspect', '--task', 'task-1', '--request', 'decision-1', '--page', '1'],
    ];

    for (const args of reads) {
      const response = await runApprovalCliV02(args, service);
      const parsed = JSON.parse(response.output) as { outcome?: string };
      assert.equal(response.exitCode, 5, args[0]);
      assert.equal(parsed.outcome, 'unavailable', args[0]);
    }
    const mutations = [
      ['decide', '--task', 'task-1', '--request', 'decision-1', '--task-version', '2', '--request-version', '1', '--presentation-digest', state.presentationDigest, '--decision', 'reject', '--response-key', 'versioned-reject'],
      ['control', '--task', 'task-1', '--task-version', '3', '--direction', 'end', '--response-key', 'versioned-end'],
    ];
    for (const args of mutations) {
      const response = await runApprovalCliV02(args, service);
      assert.notEqual(response.exitCode, 0, args[0]);
    }

    assert.equal(legacyMutationCalls, 0);
    assert.equal(versionedMutationCalls, 0);
  });

  test('v0.2 CLI rejects unversioned legacy records inside versioned list and history envelopes', async () => {
    const service = {
      cliSchemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
      presentationProfileV02: profile,
      listV02: async () => ({ schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, items: [{ decisionId: 'legacy-decision', requestVersion: 1 }] }),
      historyV02: async () => ({ schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, records: [{ decisionId: 'legacy-decision', eventKind: 'decision-recorded' }] }),
      showV02: async () => ({ schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02 }),
      inspectV02: async () => ({ schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02 }),
      decideV02: async () => ({ schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, outcome: 'ok' }),
      controlV02: async () => ({ schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, outcome: 'ok' }),
    };

    for (const args of [
      ['list', '--task', 'task-1'],
      ['history', '--task', 'task-1', '--page', '1'],
    ]) {
      const response = await runApprovalCliV02(args, service);
      assert.equal(response.exitCode, 5, args[0]);
      assert.equal(JSON.parse(response.output).outcome, 'unavailable', args[0]);
    }
  });

  test('v0.2 control preflight validates the versioned list collection before mutation', async t => {
    const validPresentation = {
      schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
      decisionId: 'decision-1',
      requestVersion: 1,
      bindingFingerprint: digest,
      elements: { action: 'Run tests', necessity: 'Verify the change', targets: ['tests/unit'], consequences: 'Runs focused checks', verificationStatus: 'Not run' },
      inspectionRef: 'decision-1',
      presentationDigest: digest,
      page: { pageNumber: 1, pageCount: 1, pageBytes: 512, totalBytes: 512, truncated: false },
      subjectKind: 'repository-action',
      planApplicability: 'pre-plan-diagnostic',
      actionId: 'action-1',
      actionDigest: digest,
      diagnosticPurpose: 'investigation_reproduction',
      taskCriteriaDigest: digest,
    };
    const invalidCollections: readonly (readonly [string, unknown])[] = [
      ['root-only envelope', { schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, decisionId: 'root-only', requestVersion: 1 }],
      ['unversioned collection item', { schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, items: [{ decisionId: 'legacy-decision', requestVersion: 1 }] }],
      ['legacy collection envelope', { schemaVersion: 'uc05-approval/0.1-draft', items: [{ schemaVersion: 'uc05-approval/0.1-draft' }] }],
      ['cross-branch collection item', { schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, items: [{ ...validPresentation, providerRequestId: 'provider-1' }] }],
    ];
    const controlArgs = ['control', '--task', 'task-1', '--task-version', '7', '--direction', 'end', '--response-key', 'end-1'];

    const runWithCollection = async (collection: unknown) => {
      const effects = { mutations: 0, queue: ['pending-control'], accountingEvents: 0, controlVersion: 7 };
      const service = {
        cliSchemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
        presentationProfileV02: profile,
        listV02: async () => collection,
        historyV02: async () => ({ schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, records: [] }),
        showV02: async () => ({ schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02 }),
        inspectV02: async () => ({ schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02 }),
        decideV02: async () => ({ schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, outcome: 'ok' }),
        controlV02: async () => {
          effects.mutations += 1;
          effects.queue.shift();
          effects.accountingEvents += 1;
          effects.controlVersion += 1;
          return { schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, outcome: 'ok', safeReasonCode: 'direction-recorded' };
        },
      };
      return { response: await runApprovalCliV02(controlArgs, service), effects };
    };

    for (const [name, collection] of invalidCollections) {
      await t.test(name, async () => {
        const { response, effects } = await runWithCollection(collection);
        assert.equal(response.exitCode, 5);
        assert.deepEqual(JSON.parse(response.output), {
          schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
          outcome: 'unavailable',
          safeReasonCode: 'approval-cli-denied',
        });
        assert.deepEqual(effects, { mutations: 0, queue: ['pending-control'], accountingEvents: 0, controlVersion: 7 });
      });
    }

    const { response, effects } = await runWithCollection({ schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, items: [validPresentation] });
    assert.equal(response.exitCode, 0);
    assert.deepEqual(JSON.parse(response.output), {
      schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
      outcome: 'ok',
      safeReasonCode: 'approval-cli-recorded',
      value: { schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, outcome: 'ok', safeReasonCode: 'direction-recorded' },
    });
    assert.deepEqual(effects, { mutations: 1, queue: [], accountingEvents: 1, controlVersion: 8 });
  });

  test('v0.2 presentation rejection metadata is fixed, bounded, and input-independent', () => {
    const validPresentation = {
      schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
      decisionId: 'decision-1',
      requestVersion: 1,
      bindingFingerprint: digest,
      elements: { action: 'Run tests', necessity: 'Verify the change', targets: ['tests/unit'], consequences: 'Runs focused checks', verificationStatus: 'Not run' },
      inspectionRef: 'decision-1',
      presentationDigest: digest,
      page: { pageNumber: 1, pageCount: 1, pageBytes: 512, totalBytes: 512, truncated: false },
      subjectKind: 'repository-action',
      planApplicability: 'pre-plan-diagnostic',
      actionId: 'action-1',
      actionDigest: digest,
      diagnosticPurpose: 'investigation_reproduction',
      taskCriteriaDigest: digest,
    };
    const invalidInput = {
      ok: false,
      errors: [{ path: 'safePresentationV02', code: 'INVALID_OBJECT', message: 'expected bounded plain data' }],
    };
    const protectedContent = {
      ok: false,
      errors: [{ path: 'safePresentationV02', code: 'PROTECTED_CONTENT', message: 'presentation contains protected content' }],
    };

    assert.equal(validateSafePresentationV02(validPresentation, profile).ok, true);
    assert.deepEqual(validateSafePresentationV02({ ...validPresentation, schemaVersion: 'MARKER_SECRET_DO_NOT_DISCLOSE' }, profile), protectedContent);

    const protectedKey = { ...validPresentation };
    Object.defineProperty(protectedKey, 'MARKER_SECRET_DO_NOT_DISCLOSE', { enumerable: true, value: true });
    assert.deepEqual(validateSafePresentationV02(protectedKey, profile), protectedContent);

    assert.deepEqual(validateSafePresentationV02({ ...validPresentation, schemaVersion: 'unsupported-version' }, profile), {
      ok: false,
      errors: [{ path: 'safePresentationV02.schemaVersion', code: 'INVALID_SCHEMA_VERSION', message: 'schemaVersion must match the supported version' }],
    });
    assert.deepEqual(validateSafePresentationV02({ ...validPresentation, unexpectedField: 'value' }, profile), {
      ok: false,
      errors: [{ path: 'safePresentationV02', code: 'UNKNOWN_FIELD', message: 'presentation contains unknown fields' }],
    });

    const unsafeKeys = [
      `\u001b[31mMARKER_SECRET_DO_NOT_DISCLOSE`,
      `\u009d8;;https://example.invalid\u009cMARKER_SECRET_DO_NOT_DISCLOSE`,
      `\u202eMARKER_SECRET_DO_NOT_DISCLOSE`,
      'x'.repeat(65_537),
      '__proto__', 'constructor', 'prototype',
    ];
    for (const key of unsafeKeys) {
      const input = { ...validPresentation };
      Object.defineProperty(input, key, { enumerable: true, value: 'rejected-key-value' });
      const result = validateSafePresentationV02(input, profile);
      assert.deepEqual(result, invalidInput);
      const serialized = JSON.stringify(result);
      assert.ok(Buffer.byteLength(serialized) <= 1024);
      assert.equal(serialized.includes(key), false);
      assert.equal(serialized.includes('rejected-key-value'), false);
    }

    for (const value of ['\u001b[31mvalue', '\u009d8;;https://example.invalid\u009c', '\u202evalue', 'x'.repeat(65_537)]) {
      const result = validateSafePresentationV02({ ...validPresentation, schemaVersion: value }, profile);
      assert.deepEqual(result, invalidInput);
      const serialized = JSON.stringify(result);
      assert.ok(Buffer.byteLength(serialized) <= 1024);
      assert.equal(serialized.includes(value), false);
    }

    const profileDiagnosticKey = 'PROFILE_VALIDATOR_KEY_SHOULD_NOT_ESCAPE';
    const profileDiagnosticValue = 'PROFILE_VALIDATOR_VALUE_SHOULD_NOT_ESCAPE';
    const invalidProfile = { ...profile };
    Object.defineProperty(invalidProfile, profileDiagnosticKey, { enumerable: true, value: profileDiagnosticValue });
    const profileResult = validateSafePresentationV02(validPresentation, invalidProfile);
    assert.deepEqual(profileResult, {
      ok: false,
      errors: [{ path: 'profile', code: 'INVALID_PROFILE', message: 'presentation profile is invalid' }],
    });
    assert.equal(JSON.stringify(profileResult).includes(profileDiagnosticKey), false);
    assert.equal(JSON.stringify(profileResult).includes(profileDiagnosticValue), false);

    let getterReads = 0;
    const accessorInput = { ...validPresentation };
    Object.defineProperty(accessorInput, 'schemaVersion', { enumerable: true, get: () => { getterReads += 1; return UC05_APPROVAL_SCHEMA_VERSION_V02; } });
    assert.deepEqual(validateSafePresentationV02(accessorInput, profile), invalidInput);
    assert.equal(getterReads, 0);

    let proxyTrapCalls = 0;
    const proxyInput = new Proxy(validPresentation, {
      get: () => { proxyTrapCalls += 1; throw new Error('proxy getter invoked'); },
      getPrototypeOf: () => { proxyTrapCalls += 1; throw new Error('proxy prototype trap invoked'); },
      ownKeys: () => { proxyTrapCalls += 1; throw new Error('proxy key trap invoked'); },
    });
    assert.deepEqual(validateSafePresentationV02(proxyInput, profile), invalidInput);
    assert.equal(proxyTrapCalls, 0);
  });
}
