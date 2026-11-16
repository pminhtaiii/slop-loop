import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApprovalService } from '../../../src/approvals/service.ts';
import { computeActionDigest } from '../../../src/contracts/foundation/uc03.ts';
import type { ApprovalService } from '../../../src/approvals/service.ts';
import type { ApprovalStore } from '../../../src/approvals/service-data.ts';
import { runEvaluationControlCli, type EvaluationControlBindings } from '../../../src/cli/evaluate-control.ts';
import { DEFAULT_POLICY_PROFILE } from '../../../src/persistence/adapters/approval-types.ts';
import { DurableApprovalStore } from '../../../src/persistence/adapters/approval-store-adapter.ts';
import { createConsoleApprovalPort } from '../../../src/runtime/console-approval-port.ts';
import type { ConsoleApprovalPort } from '../../../src/runtime/console-server.ts';
import { fail } from '../../../src/runtime/evaluation-service.ts';

const taskId = 'task-1';
const experimentId = 'exp-1';
const decisionId = 'decision-1';
const identity = DEFAULT_POLICY_PROFILE.policyIdentity;
const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;
const action = { actionId: 'action-1', kind: 'run_command' as const, executable: 'pytest', argv: ['-q', 'tests/other.py'], workingDirectory: '/workspace' };

/** Plain trusted context the real service validates; `none` is the policy's lower-bound row. */
function context() {
  return {
    action,
    runId: 'run-1',
    freshness: {
      currentTaskId: taskId,
      currentWorkspaceId: 'default-ws',
      currentRepositoryRevisionDigest: digestA,
      currentPolicyId: identity.policyId,
      currentPolicyVersion: identity.policyVersion,
      currentNormalizedActionDigest: computeActionDigest(action),
    },
    elements: { action: 'Run tests', necessity: 'Verify repair', targets: ['tests/other.py'], consequences: 'Isolated test run', verificationStatus: 'Not executed' },
    facts: {
      taskId,
      repositoryId: 'default-repo',
      workspaceId: 'default-ws',
      repositoryRevisionDigest: digestA,
      policyIdentity: identity,
      registeredActionDigest: computeActionDigest(action),
      continuationRef: 'continuation-1',
      role: 'coder' as const,
      safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
      command: { executableRef: 'pytest', resolvedExecutable: 'pytest', workingDirectoryRef: 'repository-root', workingDirectory: '/workspace', constrainedCapability: 'constrained-tests' },
      patch: null,
      plan: null,
    },
  };
}

type Fixture = Readonly<{
  service: ApprovalService;
  trusted: ReturnType<typeof context>;
  recorded: () => number;
  pending: { presentationDigest: string; requestVersion: number };
}>;

/** A real approval service over a fresh durable temp store with one pending request. */
async function fixture(t: TestContext): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'uc03-console-approval-port-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new DurableApprovalStore({ storageDir: dir });
  const trusted = context();
  const service = createApprovalService({
    taskId,
    profile: DEFAULT_POLICY_PROFILE,
    store: store as unknown as ApprovalStore,
    context: { loadForAction: async () => trusted, loadForDecision: async () => trusted },
    operator: { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' } },
    now: () => '2026-11-16T00:00:00.000Z',
  });
  await service.requestDecision({
    decisionId,
    actionKind: 'action',
    normalizedActionDigest: computeActionDigest(action),
    taskId,
    workspaceId: 'default-ws',
    repositoryRevisionDigest: digestA,
    policyId: identity.policyId,
    policyVersion: identity.policyVersion,
    status: 'pending',
  });
  const view = await service.show(taskId, decisionId);
  return {
    service,
    trusted,
    recorded: () => store.readHistory(taskId).value?.resolutions.length ?? 0,
    pending: { presentationDigest: view.presentation.presentationDigest, requestVersion: view.presentation.requestVersion },
  };
}

const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  experimentId,
  idempotencyKey: 'key-1',
  decision: 'approve',
  expectedVersion: 1,
  presentationDigest: 'placeholder',
  ...overrides,
});

test('presentation returns the owner safe presentation for the experiment task', async t => {
  const { service, pending } = await fixture(t);
  const port = createConsoleApprovalPort(service, id => (id === experimentId ? taskId : undefined));
  const shown = await port.presentation(experimentId);
  assert.equal(shown.ok, true, 'the owner pending presentation is returned');
  if (!shown.ok) return;
  const value = shown.value as { taskId: string; binding: { decisionId: string; status: string }; presentation: { presentationDigest: string } };
  assert.deepEqual([value.taskId, value.binding.decisionId, value.binding.status], [taskId, decisionId, 'pending']);
  assert.equal(value.presentation.presentationDigest, pending.presentationDigest);
  assert.equal((await port.presentation('exp-missing')).ok, false, 'an experiment with no task is refused');
});

test('decide forwards only the submitted decision and records exactly one resolution', async t => {
  const { service, recorded, pending } = await fixture(t);
  const port = createConsoleApprovalPort(service, () => taskId);
  const result = await port.decide(body({ presentationDigest: pending.presentationDigest }));
  assert.equal(result.ok, true, 'the operator decision is recorded');
  assert.equal(recorded(), 1);
  // The owner leaves `waiting` on an approval, so a replay is its own `conflict`, not a second record.
  const replay = await port.decide(body({ presentationDigest: pending.presentationDigest }));
  assert.deepEqual([replay.ok, replay.ok ? undefined : replay.status], [false, 'conflict']);
  assert.equal(recorded(), 1, 'a replay records nothing new');
});

test('a stale presentation keeps the owner refusal with zero decisions recorded', async t => {
  const { service, trusted, recorded, pending } = await fixture(t);
  const port = createConsoleApprovalPort(service, () => taskId);
  trusted.freshness.currentRepositoryRevisionDigest = digestB;
  const result = await port.decide(body({ presentationDigest: pending.presentationDigest }));
  assert.equal(result.ok, false, 'a changed context is refused');
  if (!result.ok) assert.equal(result.status, 'conflict');
  assert.equal(recorded(), 0);
  const wrongDigest = await port.decide(body({ presentationDigest: digestB }));
  assert.equal(wrongDigest.ok, false, 'a digest the owner never issued is refused');
  assert.equal(recorded(), 0);
});

test('a duplicate key with a different body keeps the owner refusal', async t => {
  const { service, recorded, pending } = await fixture(t);
  const port = createConsoleApprovalPort(service, () => taskId);
  assert.equal((await port.decide(body({ presentationDigest: pending.presentationDigest }))).ok, true);
  const contradiction = await port.decide(body({ presentationDigest: pending.presentationDigest, decision: 'reject' }));
  assert.equal(contradiction.ok, false, 'the same key cannot carry another decision');
  if (!contradiction.ok) assert.equal(contradiction.status, 'conflict');
  assert.equal(recorded(), 1);
});

test('an unknown experiment is refused before the service records anything', async t => {
  const { service, recorded, pending } = await fixture(t);
  const port = createConsoleApprovalPort(service, () => undefined);
  const shown = await port.presentation(experimentId);
  assert.deepEqual([shown.ok, shown.ok ? undefined : shown.status], [false, 'not-found']);
  const result = await port.decide(body({ presentationDigest: pending.presentationDigest }));
  assert.deepEqual([result.ok, result.ok ? undefined : result.status], [false, 'not-found']);
  assert.equal(recorded(), 0);
});

test('no input is ever recorded as a decision', async t => {
  const { service, recorded, pending } = await fixture(t);
  const port = createConsoleApprovalPort(service, () => taskId);
  for (const input of [
    undefined,
    null,
    {},
    { ...body({ presentationDigest: pending.presentationDigest }), extra: 1 },
    body({ presentationDigest: 'not-a-digest' }),
    body({ presentationDigest: pending.presentationDigest, decision: 'maybe' }),
    body({ presentationDigest: pending.presentationDigest, expectedVersion: 0 }),
  ]) {
    const result = await port.decide(input);
    assert.deepEqual([result.ok, result.ok ? undefined : result.status], [false, 'invalid-input']);
  }
  await port.presentation(experimentId);
  assert.equal(recorded(), 0, 'reading a presentation records nothing');
});

test('the port fits EvaluationControlBindings.approval and the operator CLI records through it', async t => {
  const { service, recorded, pending } = await fixture(t);
  const port: ConsoleApprovalPort = createConsoleApprovalPort(service, () => taskId);
  const unused = async (): Promise<never> => {
    throw new Error('unused control surface');
  };
  const bindings: EvaluationControlBindings = {
    service: {
      getExperiment: () => fail('not-found', 'UNUSED'),
      issueDirection: unused,
      continueExperiment: unused,
    },
    approval: port,
  };
  const result = await runEvaluationControlCli(
    ['decision', '--experiment', experimentId, '--presentation', pending.presentationDigest, '--version', '1', '--choice', 'approve', '--idempotency-key', 'cli-key'],
    bindings,
  );
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(recorded(), 1);
});
