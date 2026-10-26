/**
 * UC-03 v0.2.0 Atomic Admission Canonical Cutover Contract Tests (T064 / T065).
 *
 * Owned path: tests/runtime/contract/atomic-admission-cutover.test.ts
 * Feature: specs/001-verified-code-repair
 * Amendment: contracts/atomic-admission-amendment.md
 *
 * T064: Add runnable canonical-cutover RED tests and a neutral fail-closed versioned selector.
 *       All 13 migration checkpoints (T038, T040, T042, T044, T046, T048, T050, T052,
 *       T054, T056, T058, T061, T063) are required for canonical v0.2 cutover.
 *       Assert zero effects for no context, v0.1 legacy context, raw old claim ID,
 *       open claim, and missing migration checkpoints.
 *
 * T065: Explicit canonical v0.2 cutover activation and legacy rejection (GREEN).
 *       Canonical mock composition admits explicit v0.2 records only.
 *       Selected path governs actual effect boundary with zero effects on negative vectors.
 *       Retained neutral compatibility selector is separately versioned, test-only, and fail-closed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type TaskState,
  type AdmissionContextV02,
  type RepositoryAdmissionContextV02,
  type ClaimReceiptV02,
  isAdmittedForProduction,
  validateAdmissionV02,
  validateTaskState,
  validateBudgetLedger,
  CANONICAL_V02_SCHEMA_VERSION,
  REQUIRED_MIGRATION_CHECKPOINTS,
  type MigrationCheckpointId,
  areMigrationCheckpointsSatisfied,
  getMissingMigrationCheckpoints,
  selectVersionedAdmission,
  selectAtomicAdmissionContract,
  VersionedCutoverSelectorV02,
  createNeutralCutoverSelectorV02,
  createCanonicalCutoverSelectorV02,
} from '../../../src/contracts/foundation/uc03.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import { createExecutionGuardV02 } from '../../../src/foundation/execution-guard.ts';
import {
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryAdmissionTrustedContextV02,
  createTestProviderAdmissionTrustedContextV02,
  createTestAdmissionTaskStateV02,
  createTestAdmissionTransitionContextsV02,
  createTestExecutorIdentityV02,
} from '../support/uc03/state-fixtures.ts';

function assertAdmissionFixture(context: AdmissionContextV02): {
  readonly initialTaskState: TaskState;
  readonly transitionContexts: ReturnType<typeof createTestAdmissionTransitionContextsV02>;
} {
  const validation =
    context.subjectKind === 'repository-action'
      ? validateAdmissionV02(context, createTestRepositoryAdmissionTrustedContextV02(context))
      : validateAdmissionV02(context, createTestProviderAdmissionTrustedContextV02(context));
  assert.equal(validation.ok, true, `${context.subjectKind} admission fixture must validate`);

  const initialTaskState = createTestAdmissionTaskStateV02(context);
  const stateValidation = validateTaskState(initialTaskState);
  assert.equal(stateValidation.ok, true, `task-state fixture must validate`);

  for (const ledger of initialTaskState.budgetLedgers ?? []) {
    const ledgerValidation = validateBudgetLedger(ledger);
    assert.equal(ledgerValidation.ok, true, `budget-ledger fixture must validate`);
  }

  return {
    initialTaskState,
    transitionContexts: createTestAdmissionTransitionContextsV02(context, initialTaskState),
  };
}

function createPort(
  context: AdmissionContextV02,
  options?: { readonly initialTaskState?: TaskState }
): MemoryStatePortV02 {
  const fixture = assertAdmissionFixture(context);
  const authority =
    context.subjectKind === 'repository-action'
      ? context.policyAuthorityRef
      : {
          policyId: context.providerIdentity.pricingPolicyId,
          policyVersion: context.providerIdentity.pricingPolicyVersion,
          configId: context.providerIdentity.configId,
          configVersion: context.providerIdentity.configVersion,
          issuerKeyRef: context.providerIdentity.issuerKeyRef,
          decisionAuthorityGeneration: context.providerIdentity.decisionAuthorityGeneration,
        };

  return new MemoryStatePortV02({
    ...fixture,
    initialTaskState: options?.initialTaskState ?? fixture.initialTaskState,
    initialControlVersion: context.expectedControlVersion,
    initialEpoch: context.expectedEpoch,
    initialAuthorityRef: authority,
  });
}

test('Checkpoint validation: canonical v0.2 requires every listed migration checkpoint', async () => {
  assert.equal(REQUIRED_MIGRATION_CHECKPOINTS.length, 13, 'Must require exactly 13 migration checkpoints');
  const expectedCheckpoints: readonly MigrationCheckpointId[] = REQUIRED_MIGRATION_CHECKPOINTS;
  assert.deepEqual(REQUIRED_MIGRATION_CHECKPOINTS, expectedCheckpoints);

  // Full set satisfies requirement
  assert.equal(areMigrationCheckpointsSatisfied(REQUIRED_MIGRATION_CHECKPOINTS), true);
  assert.deepEqual(getMissingMigrationCheckpoints(REQUIRED_MIGRATION_CHECKPOINTS), []);

  const selector = createNeutralCutoverSelectorV02();
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const repo = new FakeRepositoryPort({
    statePort: port,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
  });

  // Each missing checkpoint independently causes rejection with zero effects
  for (const checkpoint of expectedCheckpoints) {
    const subset = expectedCheckpoints.filter((cp) => cp !== checkpoint);
    assert.equal(areMigrationCheckpointsSatisfied(subset), false);
    assert.deepEqual(getMissingMigrationCheckpoints(subset), [checkpoint]);

    const decision = selector.select({
      context,
      checkpoints: subset,
      statePort: port,
      repositoryPort: repo,
    });

    assert.equal(decision.admitted, false);
    assert.equal(decision.code, 'MISSING_MIGRATION_CHECKPOINTS');
    assert.deepEqual(decision.missingCheckpoints, [checkpoint]);
    assert.equal(decision.zeroEffects, true);
    assert.equal(repo.commands.length, 0);
    assert.equal(repo.patches.length, 0);
    assert.equal(repo.tests.length, 0);
    assert.equal(port.getJournalSnapshot().claims.length, 0);
  }
});

test('Zero effects: missing or empty admission context is rejected fail-closed', async () => {
  const selector = new VersionedCutoverSelectorV02();
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const repo = new FakeRepositoryPort({
    statePort: port,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
  });

  for (const emptyContext of [undefined, null, {}]) {
    const decision = selector.select({
      context: emptyContext,
      checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
      statePort: port,
      repositoryPort: repo,
    });

    assert.equal(decision.admitted, false);
    assert.equal(decision.code, 'MISSING_ADMISSION_CONTEXT');
    assert.equal(decision.zeroEffects, true);

    assert.equal(Reflect.get(selector, 'executeIfAdmitted'), undefined);
    assert.equal(Reflect.get(selector, 'executeGuardedAction'), undefined);
    assert.equal(repo.commands.length, 0);
    assert.equal(repo.patches.length, 0);
    assert.equal(repo.tests.length, 0);
    assert.equal(port.getJournalSnapshot().claims.length, 0);
  }
});

test('Zero effects: legacy v0.1 context is rejected and never authorizes v0.2 effects', async () => {
  const selector = new VersionedCutoverSelectorV02();
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const repo = new FakeRepositoryPort({
    statePort: port,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
  });

  const legacyContexts = [
    { schemaVersion: '0.1.0', taskId: context.taskId, action: context.action },
    { schemaVersion: 'uc05-approval/0.1-draft', taskId: context.taskId, actionRef: 'act-1' },
    { schemaVersion: '0.1', taskId: context.taskId },
  ];

  for (const legacyContext of legacyContexts) {
    const decision = selector.select({
      context: legacyContext,
      checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
      statePort: port,
      repositoryPort: repo,
    });

    assert.equal(decision.admitted, false);
    assert.equal(decision.code, 'LEGACY_V01_CONTEXT_REJECTED');
    assert.equal(decision.zeroEffects, true);

    // Also assert standalone selectVersionedAdmission entrypoint matches
    const standalone = selectVersionedAdmission({
      context: legacyContext,
      checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
    });
    assert.equal(standalone.admitted, false);
    assert.equal(standalone.code, 'LEGACY_V01_CONTEXT_REJECTED');

    assert.equal(repo.commands.length, 0);
    assert.equal(repo.patches.length, 0);
    assert.equal(repo.tests.length, 0);
    assert.equal(port.getJournalSnapshot().claims.length, 0);
  }
});

test('Zero effects: raw old claim ID alone never authorizes effect execution or backfilled state', async () => {
  const selector = new VersionedCutoverSelectorV02();
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const repo = new FakeRepositoryPort({
    statePort: port,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
  });

  const rawClaimOptions = [
    { rawClaimId: 'claim-legacy-v01-001', checkpoints: REQUIRED_MIGRATION_CHECKPOINTS },
    { context: { claimId: 'claim-raw-old-002' }, checkpoints: REQUIRED_MIGRATION_CHECKPOINTS },
    { context: { claimId: 'claim-raw-003', taskId: context.taskId }, checkpoints: REQUIRED_MIGRATION_CHECKPOINTS },
  ];

  for (const opt of rawClaimOptions) {
    const decision = selector.select({
      ...opt,
      statePort: port,
      repositoryPort: repo,
    });

    assert.equal(decision.admitted, false);
    assert.equal(decision.code, 'RAW_OLD_CLAIM_ID_REJECTED');
    assert.equal(decision.zeroEffects, true);

    // Also assert selectAtomicAdmissionContract alias matches
    const aliasDecision = selectAtomicAdmissionContract(opt);
    assert.equal(aliasDecision.admitted, false);
    assert.equal(aliasDecision.code, 'RAW_OLD_CLAIM_ID_REJECTED');

    assert.equal(repo.commands.length, 0);
    assert.equal(repo.patches.length, 0);
    assert.equal(repo.tests.length, 0);
    assert.equal(port.getJournalSnapshot().claims.length, 0);
  }
});

test('Zero effects: open claim on task blocks fresh admission task-wide', async () => {
  const selector = new VersionedCutoverSelectorV02();
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const repo = new FakeRepositoryPort({
    statePort: port,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
  });

  // Open an unresolved claim in the journal
  const openClaim: ClaimReceiptV02 = await port.claim(context);
  assert.ok(openClaim.claimId);
  assert.equal(port.getJournalSnapshot().activeClaimId, openClaim.claimId);

  // New admission attempt while claim is open must be denied
  const decision = selector.select({
    context,
    checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
    statePort: port,
    repositoryPort: repo,
  });

  assert.equal(decision.admitted, false);
  assert.equal(decision.code, 'OPEN_CLAIM_BLOCKS_ADMISSION');
  assert.equal(decision.zeroEffects, true);

  // Zero repository invocations while claim is open
  assert.equal(repo.commands.length, 0);
  assert.equal(repo.patches.length, 0);
  assert.equal(repo.tests.length, 0);
});

test('Controlled mock composition rejects production admission via isAdmittedForProduction', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const repo = new FakeRepositoryPort({
    statePort: port,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
  });

  // Verify that test mock ports do NOT claim or satisfy production authority
  assert.equal(port.provenance, 'mock');
  assert.equal(repo.provenance, 'mock');
  assert.equal(isAdmittedForProduction([port, repo]), false);
});

test('Positive cutover: fully migrated v0.2 mock composition reaches canonical admission under v0.2 selector', async () => {
  const selector = createCanonicalCutoverSelectorV02();
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const repo = new FakeRepositoryPort({
    statePort: port,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
  });

  assert.equal(context.schemaVersion, CANONICAL_V02_SCHEMA_VERSION);
  assert.equal(port.getJournalSnapshot().activeClaimId, null, 'Task must not have open claims');

  // Evaluate cutover selection for valid positive composition with all 13 checkpoints present
  const decision = selector.select({
    context,
    checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
    statePort: port,
    repositoryPort: repo,
  });

  assert.equal(
    decision.admitted,
    true,
    'Fully migrated v0.2 mock composition must be admitted canonically'
  );
  assert.equal(
    decision.selectedVersion,
    '0.2.0',
    'Canonical cutover must select version 0.2.0'
  );
  assert.equal(decision.code, 'CANONICAL_V02_ADMITTED');
  assert.equal(decision.zeroEffects, true, 'Selection has no effect authority');

  const forgedLabel = selector.select({
    context: { schemaVersion: '0.2.0' },
    checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
  });
  assert.equal(forgedLabel.admitted, false, 'A schema label alone is not a v0.2 admission record');
  assert.equal(forgedLabel.code, 'INVALID_ADMISSION_CONTEXT');
  assert.equal(forgedLabel.zeroEffects, true);

  const missingPorts = selector.select({
    context,
    checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
  });
  assert.equal(missingPorts.admitted, false, 'A valid record without versioned public ports cannot select canonical execution');
  assert.equal(missingPorts.code, 'V02_COMPOSITION_REQUIRED');
  assert.equal(missingPorts.zeroEffects, true);
  assert.equal(port.getJournalSnapshot().claims.length, 0);
  assert.equal(repo.patches.length, 0);
  assert.equal(repo.commands.length, 0);
  assert.equal(repo.tests.length, 0);

  assert.equal(Reflect.get(selector, 'executeIfAdmitted'), undefined);
  assert.equal(Reflect.get(selector, 'executeGuardedAction'), undefined);
});

test('Actual effect boundary: canonical execution goes through ExecutionGuardV02 with explicit context and ports', async () => {
  const selector = new VersionedCutoverSelectorV02();
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const repo = new FakeRepositoryPort({
    statePort: port,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
  });

  const guard = createExecutionGuardV02({
    ports: {
      statePort: port,
      repositoryPort: repo,
    },
  });

  const initialTaskState = createTestAdmissionTaskStateV02(context);

  // 1. Positive admission executes through the actual ExecutionGuardV02
  const selection = selector.select({ context, checkpoints: REQUIRED_MIGRATION_CHECKPOINTS, statePort: port, repositoryPort: repo });
  assert.equal(selection.admitted, true);
  const positiveResult = await guard.validateAndExecute(context.action, initialTaskState, context);
  assert.equal(positiveResult.outcome, 'success');
  assert.equal(repo.patches.length, 1, 'Admitted action executed exactly once via repositoryPort');

  // Migration checkpoints select a contract version; they cannot execute an effect.
  const missing = selector.select({ context, checkpoints: ['T038'], statePort: port, repositoryPort: repo });
  assert.equal(missing.admitted, false);
  assert.equal(missing.code, 'MISSING_MIGRATION_CHECKPOINTS');
  assert.equal(repo.patches.length, 1, 'Selection does not dispatch another patch');

  // The public guard itself rejects legacy/forged contexts before receiver calls.
  const legacyResult = await guard.validateAndExecute(
    context.action,
    initialTaskState,
    { schemaVersion: '0.1.0' } as unknown as RepositoryAdmissionContextV02,
  );
  assert.equal(legacyResult.outcome, 'denied');
  assert.equal(repo.patches.length, 1, 'Legacy context does not reach the receiver');
});

test('Retained compatibility: neutral selector remains separately versioned test-only fail-closed with zero effects', async () => {
  const neutralSelector = createNeutralCutoverSelectorV02();
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const repo = new FakeRepositoryPort({
    statePort: port,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
  });

  const decision = neutralSelector.select({
    context,
    checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
    statePort: port,
    repositoryPort: repo,
  });

  assert.equal(decision.admitted, false);
  assert.equal(decision.code, 'NEUTRAL_CUTOVER_PENDING_T065');
  assert.equal(decision.neutral, true);
  assert.equal(decision.zeroEffects, true);

  assert.equal(Reflect.get(neutralSelector, 'executeIfAdmitted'), undefined);
  assert.equal(Reflect.get(neutralSelector, 'executeGuardedAction'), undefined);
  assert.equal(repo.patches.length, 0);
  assert.equal(repo.commands.length, 0);
  assert.equal(port.getJournalSnapshot().claims.length, 0);
});

test('Controlled mock composition rejects production admission for cutover selector via isAdmittedForProduction', async () => {
  const selector = new VersionedCutoverSelectorV02();
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const repo = new FakeRepositoryPort({
    statePort: port,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
  });

  assert.equal(selector.provenance, 'mock');
  assert.equal(isAdmittedForProduction([selector]), false);
  assert.equal(isAdmittedForProduction([selector, port, repo]), false);
});
