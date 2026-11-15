/**
 * T045 — the production UC-04 journal is accepted for real UC-05 control and continuation
 * (real-tier contract §(c)1–2).
 *
 * `mock` stays unchanged; `real` is accepted only through the T043 construction brand plus the
 * required method surface, so a forged `provenance: 'real'` object stays paused/unavailable. Every
 * row here runs the real `DurableStatePortV02` journal and the T042 durable approval store over a
 * temp root; nothing is answered from in-memory fixtures.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { UC04JournalPortV02 } from '../../../src/approvals/control-v02.ts';
import { publishAuthorityV02, validatePublicationV02, journalSnapshotV02 } from '../../../src/approvals/control-v02.ts';
import { acceptsJournalV02 } from '../../../src/approvals/journal-acceptance-v02.ts';
import { createApprovalContinuationV02 } from '../../../src/approvals/recovery-v02.ts';
import { createApprovalService } from '../../../src/approvals/service.ts';
import type { PolicyProfile } from '../../../src/contracts/approvals/contracts.ts';
import { computeActionDigest, computeCanonicalSha256 } from '../../../src/contracts/foundation/uc03.ts';
import type { ApprovalBinding, ApprovalBindingContext, AdmissionContextV02, PolicyAuthorityRefV02 } from '../../../src/contracts/foundation/uc03.ts';
import { isProductionJournal } from '../../../src/foundation/production-journal-registry.ts';
import { DurableApprovalStore } from '../../../src/persistence/adapters/approval-store-adapter.ts';
import { DEFAULT_POLICY_PROFILE } from '../../../src/persistence/adapters/approval-types.ts';
import type { StoredClaimV02 } from '../../../src/persistence/adapters/state-port-v02-types.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import {
  createTestAdmissionTaskStateV02,
  createTestAdmissionTransitionContextsV02,
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryAdmissionTrustedContextV02,
} from '../support/uc03/state-fixtures.ts';

// The tree reads real sources, so it must find the checkout root from either `tests/` or `dist/tests/`.
const REPO_ROOT = ((): string => {
  for (let dir = dirname(fileURLToPath(import.meta.url)); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  throw new Error('repository root not found');
})();

const context = createTestRepositoryAdmissionContextV02();
const trustedContext = createTestRepositoryAdmissionTrustedContextV02(context);
if (!context.planDecisionRef) throw new Error('fixture plan decision ref missing');
const DECISION_ID: string = context.planDecisionRef;
const identity = {
  policyId: context.policyAuthorityRef.policyId,
  policyVersion: context.policyAuthorityRef.policyVersion,
  configId: context.policyAuthorityRef.configId,
  configVersion: context.policyAuthorityRef.configVersion,
};
const profile: PolicyProfile = { ...DEFAULT_POLICY_PROFILE, policyIdentity: identity };

/** A durable port bound to the fixture task, seeded with the fixture's control head. */
function openJournal(baseDir: string, provenance?: 'mock' | 'real'): DurableStatePortV02 {
  return new DurableStatePortV02({
    store: new DurableStore(baseDir),
    ...(provenance !== undefined ? { provenance } : {}),
    taskId: context.taskId,
    initialControl: { controlVersion: context.expectedControlVersion, epoch: context.expectedEpoch, activeAuthorityRef: context.policyAuthorityRef },
  });
}

/**
 * Seeds a retained admission record: the claim an earlier run persisted for this plan decision, so
 * `loadAdmission` has bytes to read. It is closed and stays out of the control head, which must
 * remain runnable at the fixture version for continuation to claim.
 */
async function seedRetainedAdmission(store: DurableStore): Promise<void> {
  const state = new StatePortStore(store);
  const unsigned = {
    claimId: 'claim-retained-admission-001',
    claimDigest: '',
    taskId: context.taskId,
    runId: context.runId,
    subjectKind: 'repository-action' as const,
    planApplicability: 'approved-plan' as const,
    preClaimTaskStateVersion: context.expectedTaskStateVersion,
    preClaimControlVersion: 1,
    postClaimControlVersion: 2,
    epoch: context.expectedEpoch,
    status: 'claimed' as const,
    reservationRefs: ['res-repair-slot-001'],
  };
  const claim: StoredClaimV02 = {
    receipt: { ...unsigned, claimDigest: computeCanonicalSha256({ ...unsigned, claimDigest: undefined }) },
    context,
    taskSnapshot: createTestAdmissionTaskStateV02(context),
    authorityRef: context.policyAuthorityRef,
    trustedAdmissionContext: trustedContext,
    status: 'closed',
  };
  await state.writeClaim(context.taskId, claim);
}

/** The approval context the host observes: the fixture action, with a risky patch so policy asks. */
function approvalContext(): unknown {
  const transitions = createTestAdmissionTransitionContextsV02(context, createTestAdmissionTaskStateV02(context));
  const planTransition = Object.values(transitions)[0]?.approval as { readonly binding: ApprovalBinding; readonly freshness: ApprovalBindingContext } | undefined;
  assert.ok(planTransition, 'the fixture must provide an approved plan binding');
  return {
    action: context.action,
    runId: context.runId,
    elements: { action: 'Apply the repair patch', necessity: 'Fix the defect', targets: ['src/calculator.py'], consequences: 'Edits the workspace', verificationStatus: 'Not executed' },
    freshness: {
      currentTaskId: context.taskId,
      currentWorkspaceId: context.workspaceId,
      currentRepositoryRevisionDigest: context.canonicalRevision,
      currentPolicyId: identity.policyId,
      currentPolicyVersion: identity.policyVersion,
      currentNormalizedActionDigest: context.actionDigest,
    },
    facts: {
      taskId: context.taskId,
      workspaceId: context.workspaceId,
      repositoryId: context.repositoryId,
      repositoryRevisionDigest: context.canonicalRevision,
      policyIdentity: identity,
      registeredActionDigest: context.actionDigest,
      continuationRef: 'continuation-001',
      role: 'coder',
      safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
      command: null,
      patch: { fileCount: 1, addedDeletedLines: 2, dependencyChange: true, deletion: false, structuralChange: false, sensitiveConfiguration: false, productionCode: false },
      plan: { binding: planTransition.binding, context: planTransition.freshness, materialChange: false, replanSlot: null },
      runId: context.runId,
      taskStateVersion: context.expectedTaskStateVersion,
      taskNode: context.runnableNode,
      planApplicability: 'approved-plan',
      diagnosticPurpose: null,
      taskCriteriaDigest: null,
      checkSetDigest: planTransition.binding.checkSetDigest,
      testPath: null,
      checkId: null,
      planBindingDigest: context.planBindingDigest,
      planDecisionRef: DECISION_ID,
      providerRequest: null,
    },
  };
}

async function withStore(prefix: string, body: (baseDir: string, store: DurableStore) => Promise<void>): Promise<void> {
  const baseDir = mkdtempSync(join(tmpdir(), prefix));
  try {
    const store = new DurableStore(baseDir);
    await store.init();
    await body(baseDir, store);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

function authorityAfter(ref: PolicyAuthorityRefV02): PolicyAuthorityRefV02 {
  return { ...ref, decisionAuthorityGeneration: ref.decisionAuthorityGeneration + 1 };
}

test('an approval module never imports the persistence layer at runtime, and the predicate imports only the registry', () => {
  const runtimeSpecifiers = (source: string): string[] => {
    const found: string[] = [];
    for (const match of source.matchAll(/^\s*(?:import|export)\s+([^;]*?)\s+from\s+'([^']+)'/gmu)) {
      const clause = (match[1] ?? '').trim();
      if (clause.startsWith('type ')) continue;
      found.push(match[2] ?? '');
    }
    for (const match of source.matchAll(/^\s*import\s+'([^']+)'/gmu)) found.push(match[1] ?? '');
    return found;
  };
  const approvalFiles = readdirSync(join(REPO_ROOT, 'src/approvals'))
    .filter(name => name.endsWith('.ts'))
    .map(name => join(REPO_ROOT, 'src/approvals', name));
  for (const file of approvalFiles) {
    const path = relative(REPO_ROOT, file).replaceAll('\\', '/');
    for (const specifier of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      assert.equal(/(?:^|\/)persistence(?:\/|$)/u.test(specifier), false, `${path} must not import ${specifier}: state-port-v02-storage.ts already imports approvals, so the edge would cycle`);
    }
  }

  // The shared predicate is the only approval module allowed a non-approval import, and only the registry.
  const predicate = readFileSync(join(REPO_ROOT, 'src/approvals/journal-acceptance-v02.ts'), 'utf8');
  const specifiers = [...predicate.matchAll(/\bfrom\s+'([^']+)'/gu)].map(match => match[1] ?? '');
  assert.notEqual(specifiers.length, 0, 'the predicate must import the registry');
  for (const specifier of specifiers) {
    assert.equal(specifier.startsWith('./') || specifier === '../foundation/production-journal-registry.ts', true, `the predicate may not import ${specifier}`);
  }
});

test('the shared predicate accepts a mock journal unchanged and only a branded, complete real journal', () =>
  withStore('uc05-t045-predicate-', async baseDir => {
    const real = openJournal(baseDir);
    assert.equal(isProductionJournal(real), true);
    assert.equal(acceptsJournalV02(real), true);
    assert.equal(acceptsJournalV02(real, ['publishAuthority', 'loadTask']), true);
    assert.equal(acceptsJournalV02(real, ['publishAuthority', 'not-a-method']), false, 'a required method that is absent refuses');
    assert.equal(acceptsJournalV02({ provenance: 'mock' }), true);
    assert.equal(acceptsJournalV02(openJournal(baseDir, 'mock')), true, 'a mock port keeps the controlled path');
    const forged = Object.assign(Object.create(DurableStatePortV02.prototype) as object, { provenance: 'real', publishAuthority: () => Promise.resolve({}) });
    assert.equal(isProductionJournal(forged), false);
    assert.equal(acceptsJournalV02(forged), false, 'declaring real is not proof');
    assert.equal(acceptsJournalV02(undefined), false);
    const declared = { provenance: 'real', publishAuthority: () => Promise.resolve({}), loadTask: () => Promise.resolve(null), getJournalSnapshot: () => null, claim: () => Promise.resolve({}) };
    assert.equal(acceptsJournalV02(declared, ['publishAuthority', 'loadTask']), false, 'a complete surface without the construction brand still refuses');
  }));

test('real-tier publication returns ok with a validated receipt over the T043 port', () =>
  withStore('uc05-t045-publish-', async baseDir => {
    const journal = openJournal(baseDir);
    await journal.transition(createTestAdmissionTaskStateV02(context), 0);
    const next = authorityAfter(context.policyAuthorityRef);

    const result = await publishAuthorityV02(context.taskId, journal, { authorityRef: next });
    assert.equal(result.outcome, 'ok');
    assert.ok(result.receipt);
    assert.deepEqual(validatePublicationV02(result.receipt, next, undefined), result.receipt, 'UC-05 must accept the exact receipt');
    assert.deepEqual(journalSnapshotV02(journal.getJournalSnapshot(context.taskId))?.activeAuthorityRef, next);
  }));

test('a forged journal that only declares provenance real stays paused', () =>
  withStore('uc05-t045-forged-publish-', async () => {
    const forged = { provenance: 'real', publishAuthority: async () => ({}) } as unknown as UC04JournalPortV02;
    assert.deepEqual(await publishAuthorityV02(context.taskId, forged, { authorityRef: authorityAfter(context.policyAuthorityRef) }), { outcome: 'paused', receipt: null });
  }));

test('continuation over the real journal and the T042 store re-observes, revalidates and claims', () =>
  withStore('uc05-t045-continuation-', async (baseDir, store) => {
    const journal = openJournal(baseDir);
    await journal.transition(createTestAdmissionTaskStateV02(context), 0);
    await seedRetainedAdmission(store);

    const approvals = new DurableApprovalStore({ storageDir: baseDir, durableStore: store, profile, provenance: 'real' });
    const service = createApprovalService({
      taskId: context.taskId,
      profile,
      store: approvals,
      provenance: 'real',
      context: { loadForAction: async () => approvalContext(), loadForDecision: async () => approvalContext() },
      operator: { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' } },
      now: () => '2026-11-15T00:00:00.000Z',
    });
    const binding = await service.requestDecision({
      decisionId: DECISION_ID,
      actionKind: 'action',
      normalizedActionDigest: computeActionDigest(context.action),
      taskId: context.taskId,
      workspaceId: context.workspaceId,
      repositoryRevisionDigest: context.canonicalRevision,
      policyId: identity.policyId,
      policyVersion: identity.policyVersion,
      status: 'pending',
    });
    assert.equal(binding.status, 'pending');
    const view = await service.show(context.taskId, DECISION_ID);
    const decided = await service.decide({
      taskId: context.taskId,
      decisionId: DECISION_ID,
      taskVersion: view.control.version,
      requestVersion: 1,
      presentationDigest: view.presentation.presentationDigest,
      decision: 'approve',
      responseKey: 'response-approve',
    });
    assert.equal(decided.outcome, 'ok');

    const before = journalSnapshotV02(journal.getJournalSnapshot(context.taskId));
    assert.ok(before);
    assert.equal(before.mode, 'runnable');
    assert.equal(before.activeClaimId, null);

    const result = await createApprovalContinuationV02({ taskId: context.taskId, profile, approval: service, recovery: journal, journal }).admit(DECISION_ID);
    assert.equal(result.outcome, 'claimed');
    assert.ok(result.claimId);
    assert.equal(result.claimState?.claim.planDecisionRef, DECISION_ID);
    assert.equal(result.claimState?.journalReceipt.preClaimControlVersion, context.expectedControlVersion);
    assert.equal(result.claimState?.journalReceipt.preClaimTaskStateVersion, context.expectedTaskStateVersion);

    const after = journalSnapshotV02(journal.getJournalSnapshot(context.taskId));
    assert.ok(after);
    assert.equal(after.activeClaimId, result.claimId);
    assert.equal(after.controlVersion, before.controlVersion + 1, 'the journal advanced exactly one control version');
    assert.equal(after.claims.length, before.claims.length + 1, 'the retained admission row is kept beside the new claim');
    assert.deepEqual(after.attempts, [], 'continuation issues a claim, never an attempt');
  }));

test('a stale decision is refused and writes no claim', () =>
  withStore('uc05-t045-stale-', async (baseDir, store) => {
    const journal = openJournal(baseDir);
    await journal.transition(createTestAdmissionTaskStateV02(context), 0);
    await seedRetainedAdmission(store);

    let observed = approvalContext();
    const approvals = new DurableApprovalStore({ storageDir: baseDir, durableStore: store, profile, provenance: 'real' });
    const service = createApprovalService({
      taskId: context.taskId,
      profile,
      store: approvals,
      provenance: 'real',
      context: { loadForAction: async () => observed, loadForDecision: async () => observed },
      operator: { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' } },
      now: () => '2026-11-15T00:00:00.000Z',
    });
    await service.requestDecision({
      decisionId: DECISION_ID,
      actionKind: 'action',
      normalizedActionDigest: computeActionDigest(context.action),
      taskId: context.taskId,
      workspaceId: context.workspaceId,
      repositoryRevisionDigest: context.canonicalRevision,
      policyId: identity.policyId,
      policyVersion: identity.policyVersion,
      status: 'pending',
    });
    const view = await service.show(context.taskId, DECISION_ID);
    await service.decide({
      taskId: context.taskId,
      decisionId: DECISION_ID,
      taskVersion: view.control.version,
      requestVersion: 1,
      presentationDigest: view.presentation.presentationDigest,
      decision: 'approve',
      responseKey: 'response-approve',
    });

    // The repository moved after the operator approved: the stored decision no longer binds.
    const moved = `sha256:${'c'.repeat(64)}`;
    const current = approvalContext() as { freshness: Record<string, unknown>; facts: Record<string, unknown> };
    observed = { ...current, freshness: { ...current.freshness, currentRepositoryRevisionDigest: moved } };

    const before = journalSnapshotV02(journal.getJournalSnapshot(context.taskId));
    const result = await createApprovalContinuationV02({ taskId: context.taskId, profile, approval: service, recovery: journal, journal }).admit(DECISION_ID);
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.claimId, null);
    assert.deepEqual(journalSnapshotV02(journal.getJournalSnapshot(context.taskId)), before, 'a refused continuation writes nothing');
  }));

test('a forged journal or recovery port leaves continuation unavailable and the journal untouched', () =>
  withStore('uc05-t045-forged-continuation-', async (baseDir, store) => {
    const journal = openJournal(baseDir);
    await journal.transition(createTestAdmissionTaskStateV02(context), 0);
    await seedRetainedAdmission(store);
    const approvals = new DurableApprovalStore({ storageDir: baseDir, durableStore: store, profile, provenance: 'real' });
    const service = createApprovalService({
      taskId: context.taskId,
      profile,
      store: approvals,
      provenance: 'real',
      context: { loadForAction: async () => approvalContext(), loadForDecision: async () => approvalContext() },
      operator: { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' } },
      now: () => '2026-11-15T00:00:00.000Z',
    });
    const forgedRecovery = { provenance: 'real' as const, loadAdmission: async () => ({ context, trustedContext }) };
    const forgedJournal = Object.assign(Object.create(DurableStatePortV02.prototype) as object, {
      provenance: 'real' as const,
      loadTask: (taskId: string) => journal.loadTask(taskId),
      getJournalSnapshot: (taskId: string) => journal.getJournalSnapshot(taskId),
      claim: (claimContext: AdmissionContextV02) => journal.claim(claimContext),
    });
    assert.equal(isProductionJournal(forgedJournal), false);

    const before = journalSnapshotV02(journal.getJournalSnapshot(context.taskId));
    const forgedRecoveryResult = await createApprovalContinuationV02({ taskId: context.taskId, profile, approval: service, recovery: forgedRecovery, journal }).admit(DECISION_ID);
    assert.equal(forgedRecoveryResult.outcome, 'unavailable');
    const forgedJournalResult = await createApprovalContinuationV02({ taskId: context.taskId, profile, approval: service, recovery: journal, journal: forgedJournal }).admit(DECISION_ID);
    assert.equal(forgedJournalResult.outcome, 'unavailable');
    assert.deepEqual(journalSnapshotV02(journal.getJournalSnapshot(context.taskId)), before, 'neither forgery may touch the real journal');
  }));
