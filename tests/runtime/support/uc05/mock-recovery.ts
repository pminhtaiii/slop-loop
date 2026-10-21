import type { ApprovalContext, ApprovalService, ApprovalStore } from '../../../../src/approvals/service.ts';
import type { RecoveryClaimInput, ApprovalRecoveryOwner } from '../../../../src/approvals/control.ts';
import type { DecisionEvent, DispatchClaim, PolicyProfile } from '../../../../src/contracts/approvals/contracts.ts';
import type { ApprovalBinding } from '../../../../src/contracts/foundation/uc03.ts';
import { isDeepStrictEqual } from 'node:util';
import { createApprovalService } from '../../../../src/approvals/service.ts';
import { computeActionDigest, validateApprovalBinding } from '../../../../src/contracts/foundation/uc03.ts';
import { compilePolicy } from '../../../../src/approvals/policy.ts';
import { MemoryStatePort } from '../uc03/memory-state.ts';
import { createTestLedgers } from '../uc03/state-fixtures.ts';
import { createMockApprovalStore } from './mock-store.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const identity = { policyId: 'policy-1', policyVersion: '1', configId: 'config-1', configVersion: '1' };
export const recoveryProfile: PolicyProfile = {
  schemaVersion: 'uc05-approval/0.1-draft', profileId: 'uc05-local-v1', profileVersion: '1', policyIdentity: identity,
  supportedActionKinds: ['run_command', 'apply_patch', 'approve_fix_plan'],
  commandRules: [{ ruleId: 'tests', executableRef: 'pytest', argvPrefix: ['-q', 'tests/'], workingDirectoryRef: 'repository-root', timeoutMs: 2000, maxOutputBytes: 8192 }],
  sensitivePaths: ['pyproject.toml'], patchBreadth: { maxFiles: 8, maxAddedDeletedLines: 400 },
  maxActionBytes: 65536, maxArgvEntries: 32, maxArgvEntryBytes: 4096, maxPresentationPageBytes: 8192, maxPresentationPages: 3,
  maxPresentationTotalBytes: 24576, maxEventBytes: 1024, operationDeadlineMs: 2000, maxMutationAttempts: 1,
  diagnosticRules: { maxBytes: 1024, redactSecrets: true, allowRawArtifacts: false, retainUnresolvedDecisions: true },
};

/** Same-process retained-state simulation only; not a durable UC-04 adapter. */
export interface RecoveryScenario {
  readonly store: ReturnType<typeof createMockApprovalStore>;
  readonly owner: ApprovalRecoveryOwner;
  readonly binding: ApprovalBinding;
  readonly accounting: MemoryStatePort;
  service(backend?: ApprovalStore): ApprovalService;
  decide(service: ApprovalService, decision?: 'approve' | 'reject'): Promise<void>;
  event(type: 'dispatch-claim-created' | 'dispatch-uncertain' | 'dispatch-effect-observed' | 'claim-reconciled', claimId: string): DecisionEvent;
  current(): ApprovalContext;
  setContext(value: ApprovalContext): void;
  beforeClaim(value: () => Promise<void>): void;
  loseClaimResponse(): void;
}
export function createRecoveryScenario(options: { readonly accounting?: 'missing' | 'exhausted'; readonly accountingRunId?: string } = {}): RecoveryScenario {
  const action = { actionId: 'action-1', kind: 'run_command' as const, executable: 'pytest', argv: ['-q', 'tests/other.py'], workingDirectory: '/workspace' };
  const binding = { decisionId: 'decision-1', actionKind: 'action' as const, normalizedActionDigest: computeActionDigest(action), taskId: 'task-1', workspaceId: 'workspace-1', repositoryRevisionDigest: digest, policyId: 'policy-1', policyVersion: '1', status: 'pending' as const };
  let current: ApprovalContext = { action, runId: 'run-1', freshness: { currentTaskId: 'task-1', currentWorkspaceId: 'workspace-1', currentRepositoryRevisionDigest: digest, currentPolicyId: 'policy-1', currentPolicyVersion: '1', currentNormalizedActionDigest: computeActionDigest(action) },
    elements: { action: 'Run focused tests', necessity: 'Verify repair', targets: ['tests/other.py'], consequences: 'Runs isolated tests', verificationStatus: 'Not executed' },
    facts: { taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', repositoryRevisionDigest: digest, policyIdentity: identity, registeredActionDigest: computeActionDigest(action), continuationRef: 'continuation-1', role: 'coder',
      safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
      command: { executableRef: 'pytest', resolvedExecutable: 'pytest', workingDirectoryRef: 'repository-root', workingDirectory: '/workspace', constrainedCapability: 'constrained-tests' }, patch: null, plan: null } };
  const store = createMockApprovalStore({ profile: recoveryProfile, initialControls: [{ schemaVersion: 'uc05-approval/0.1-draft', taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', version: 1, epoch: 1, mode: 'runnable', pendingDecisionId: null, continuationRef: null, reasonCode: 'ready', outstandingClaimRefs: [] }] });
  const ledgers = createTestLedgers('config-1').filter(ledger => options.accounting !== 'missing' || ledger.scope !== 'task' || ledger.kind !== 'cost')
    .map(ledger => options.accounting === 'exhausted' && ledger.scope === 'task' && ledger.kind === 'tokens' ? { ...ledger, consumed: ledger.limit } : ledger);
  const accounting = new MemoryStatePort({ initialLedgers: ledgers, currentTaskId: 'task-1', currentRunId: options.accountingRunId ?? 'run-1' });
  let beforeClaim: (() => Promise<void>) | undefined;
  let lostClaimResponse = false;
  let sequence = 0;
  const policy = compilePolicy(recoveryProfile);
  if (!policy.ok) throw new Error('invalid-mock-recovery-policy');
  const ownerReady = (input: RecoveryClaimInput): boolean => {
    const latest = store.loadTaskControl('task-1').value;
    const classified = policy.value.classify(current.action, current.facts);
    return latest !== null && latest.mode === 'runnable' && latest.version === input.expectedControlVersion && latest.epoch === input.expectedEpoch &&
      !store.readHistory('task-1').value?.claims.some(claim => claim.actionId === input.action.actionId) && current.runId === input.runId &&
      isDeepStrictEqual(current.facts.policyIdentity, identity) && input.binding.repositoryRevisionDigest === current.facts.repositoryRevisionDigest &&
      input.binding.normalizedActionDigest === computeActionDigest(current.action) && validateApprovalBinding(input.binding, current.freshness).ok && classified.ok && classified.permission !== 'FORBIDDEN';
  };
  const service = (backend: ApprovalStore = store): ApprovalService => createApprovalService({ taskId: 'task-1', profile: recoveryProfile, store: backend,
    context: { loadForAction: async () => current, loadForDecision: async () => current },
    operator: { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' } }, now: () => '2026-10-21T00:00:00Z' });
  const event = (type: 'dispatch-claim-created' | 'dispatch-uncertain' | 'dispatch-effect-observed' | 'claim-reconciled', claimId: string): DecisionEvent => ({ schemaVersion: 'uc05-approval/0.1-draft', eventId: `event-recovery-${++sequence}`, taskId: 'task-1', runId: current.runId, decisionId: null, directionId: null, claimId, type, outcome: type === 'dispatch-uncertain' ? 'uncertain' : 'ok', policyRef: identity, safeReasonCode: 'mock-recovery', timestamp: '2026-10-21T00:00:00Z' });
  const owner: ApprovalRecoveryOwner = {
    provenance: 'mock',
    reservationRequirements: [{ scope: 'task', kind: 'tokens', amount: 100 }, { scope: 'task', kind: 'cost', amount: 0.01 }, { scope: 'run', kind: 'tokens', amount: 100 }, { scope: 'run', kind: 'cost', amount: 0.01 }],
    load: async decisionId => ({ control: store.loadTaskControl('task-1').value, request: store.readRequest(decisionId).value, action: current.action, runId: current.runId, claims: store.readHistory('task-1').value?.claims }),
    claimDispatch: async (input: RecoveryClaimInput) => {
      await beforeClaim?.();
      if (!ownerReady(input)) return null;
      // Actual in-memory canonical reservations. A failed/racing claim retains charge; no rollback or durable-atomicity claim.
      const bundle = await accounting.reserveMany(owner.reservationRequirements, `request-${input.action.actionId}`, `transaction-${input.action.actionId}`);
      if (!ownerReady(input)) return null;
      const claim: DispatchClaim = { schemaVersion: 'uc05-approval/0.1-draft', claimId: 'claim-1', actionId: input.action.actionId, taskId: input.taskId,
        expectedControlVersion: input.expectedControlVersion, expectedEpoch: input.expectedEpoch, repositoryStateDigest: input.binding.repositoryRevisionDigest,
        policyIdentity: identity, decisionRefs: [input.binding.decisionId], reservationRefs: [bundle.bundleId], phase: 'claimed', resultRef: null };
      const receipt = store.claimDispatch({ claim, event: event('dispatch-claim-created', claim.claimId) });
      if (lostClaimResponse) throw new Error('mock-response-lost');
      return { safe: receipt.safe, claim: receipt.value, control: store.loadTaskControl('task-1').value, reservations: bundle };
    },
  };
  const decide = async (sut: ApprovalService, decision: 'approve' | 'reject' = 'approve'): Promise<void> => {
    const view = await sut.show('task-1', 'decision-1');
    await sut.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision, responseKey: `response-${decision}` });
  };
  return { store, owner, binding, accounting, service, decide, event, current: () => current,
    setContext: (value: ApprovalContext) => { current = value; },
    beforeClaim: (value: () => Promise<void>) => { beforeClaim = value; },
    loseClaimResponse: () => { lostClaimResponse = true; } };
}
