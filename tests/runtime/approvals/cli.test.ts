import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApprovalService } from '../../../src/approvals/service.ts';
import { runApprovalCli } from '../../../src/approvals/cli.ts';
import { computeActionDigest } from '../../../src/contracts/foundation/uc03.ts';
import { createMockApprovalStore } from '../support/uc05/mock-store.ts';
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
  const options = { taskId: 'task-1', profile, store, context: { loadForAction: async () => trusted, loadForDecision: async () => trusted }, now: () => '2026-10-19T00:00:00Z' };
  const operator = { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' as const } };
  const service = createApprovalService({ ...options, operator });
  await service.requestDecision(binding);
  const presentationDigest = (await service.show('task-1', 'decision-1')).presentation.presentationDigest;
  if (scenario === 'failed-store') store.failNext('resolvePending');
  const protectedStore = { ...store, loadTaskControl: (taskId: string) => {
    const result = store.loadTaskControl(taskId);
    return { ...result, value: result.value === null ? null : { ...result.value, reasonCode: 'MARKER_SECRET_DO_NOT_DISCLOSE' } };
  } };
  return { service: scenario === 'no-operator' ? createApprovalService(options) : scenario === 'protected-metadata' ? createApprovalService({ ...options, store: protectedStore, operator }) : service, presentationDigest };
}

if (process.argv[2] === 'uc05-cli-test-driver') {
  const state = await fixture(process.argv[3] ?? 'normal');
  const result = await runApprovalCli(process.argv.slice(4), state.service);
  process.stdout.write(result.output + '\n');
  process.exitCode = result.exitCode;
} else {
  const child = (args: readonly string[], scenario = 'normal') => spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'uc05-cli-test-driver', scenario, ...args], { encoding: 'utf8', timeout: 5000 });

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
}
