import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UC04_SCHEMA_VERSION,
  validatePlanStep,
  validateTaskState,
  validateBudgetLedger,
  validateReservationBundle,
  validateDeliberatePauseRecord,
  validateCompactSummary,
  validateRegisterTaskInput,
  validateClaimDispatchInput,
  validatePauseTaskInput,
  validateResumeTaskInput,
  validateRecordAndSettleInput,
  validateRecoverTaskInput,
  validateCheckpointRecord,
  validateBudgetJournalRecord,
  validateDispatchClaimRecord,
  type TaskState,
  type CheckpointRecord,
} from '../../../src/persistence/contracts.ts';

describe('UC-04: Data Contracts and Extension Validators', () => {
  it('validates schema version constant', () => {
    assert.equal(UC04_SCHEMA_VERSION, 'uc04-recovery/0.1-draft');
  });

  describe('validatePlanStep', () => {
    it('accepts valid plan step with dependencies', () => {
      const validStep = {
        id: 'step-1',
        title: 'Step 1',
        description: 'First step',
        status: 'todo',
        predecessorIds: [],
      };
      const res = validatePlanStep(validStep);
      assert.equal(res.ok, true);
    });

    it('rejects step with empty id or title', () => {
      const res = validatePlanStep({
        id: '',
        title: '  ',
        description: 'test',
        status: 'todo',
      });
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.ok(res.errors.some((e) => e.path.endsWith('.id')));
        assert.ok(res.errors.some((e) => e.path.endsWith('.title')));
      }
    });

    it('rejects step with unknown properties', () => {
      const res = validatePlanStep({
        id: 'step-1',
        title: 'Step 1',
        description: 'test',
        status: 'todo',
        unexpectedProp: 123,
      });
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.ok(res.errors.some((e) => e.code === 'UNKNOWN_PROPERTY'));
      }
    });

    it('rejects step with invalid status', () => {
      const res = validatePlanStep({
        id: 'step-1',
        title: 'Step 1',
        description: 'test',
        status: 'invalid_status',
      });
      assert.equal(res.ok, false);
    });

    it('rejects a done step without evidence references', () => {
      const res = validatePlanStep({
        id: 'step-1',
        title: 'Step 1',
        description: 'test',
        status: 'done',
      });
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.ok(res.errors.some((e) => e.code === 'MISSING_COMPLETION_EVIDENCE' && e.path.endsWith('.evidenceRefs')));
      }

      const emptyRes = validatePlanStep({
        id: 'step-1',
        title: 'Step 1',
        description: 'test',
        status: 'done',
        evidenceRefs: [],
      });
      assert.equal(emptyRes.ok, false);
    });

    it('accepts a done step with one evidence reference', () => {
      const res = validatePlanStep({
        id: 'step-1',
        title: 'Step 1',
        description: 'test',
        status: 'done',
        evidenceRefs: ['test-ok'],
      });
      assert.equal(res.ok, true);
    });

    it('validates requiredEvidenceRefs as a string array', () => {
      const res = validatePlanStep({
        id: 'step-1',
        title: 'Step 1',
        description: 'test',
        status: 'todo',
        requiredEvidenceRefs: ['test-ok'],
      });
      assert.equal(res.ok, true);

      const badRes = validatePlanStep({
        id: 'step-1',
        title: 'Step 1',
        description: 'test',
        status: 'todo',
        requiredEvidenceRefs: [123],
      });
      assert.equal(badRes.ok, false);
      if (!badRes.ok) {
        assert.ok(badRes.errors.some((e) => e.code === 'INVALID_REQUIRED_EVIDENCE'));
      }
    });
  });

  describe('validateBudgetLedger', () => {
    it('rejects NaN, Infinity, and fractional version in budget ledger', () => {
      const nanLedger = {
        scope: 'task',
        kind: 'tokens',
        limit: NaN,
        consumed: 0,
        reservations: [],
        configurationId: 'cfg-1',
        version: 1,
      };
      assert.equal(validateBudgetLedger(nanLedger).ok, false);

      const infLedger = {
        scope: 'task',
        kind: 'tokens',
        limit: Infinity,
        consumed: 0,
        reservations: [],
        configurationId: 'cfg-1',
        version: 1,
      };
      assert.equal(validateBudgetLedger(infLedger).ok, false);

      const fracLedger = {
        scope: 'task',
        kind: 'tokens',
        limit: 1000,
        consumed: 0,
        reservations: [],
        configurationId: 'cfg-1',
        version: 1.5,
      };
      assert.equal(validateBudgetLedger(fracLedger).ok, false);
    });
  });

  describe('validateDeliberatePauseRecord', () => {
    it('accepts valid deliberate pause record', () => {
      const record = {
        schemaVersion: UC04_SCHEMA_VERSION,
        taskId: 'task-1',
        active: true,
        pauseKey: 'pause-123',
        operatorRef: 'admin',
        acceptedAt: '2026-10-21T12:00:00.000Z',
        revision: 1,
        epoch: 2,
        resumeKey: null,
        outstandingAttemptRefs: [],
      };
      const res = validateDeliberatePauseRecord(record);
      assert.equal(res.ok, true);
    });

    it('rejects deliberate pause record with incompatible schema version', () => {
      const res = validateDeliberatePauseRecord({
        schemaVersion: 'invalid-version',
        taskId: 'task-1',
        active: true,
        pauseKey: 'pause-123',
        operatorRef: 'admin',
        acceptedAt: '2026-10-21T12:00:00.000Z',
        revision: 1,
        epoch: 2,
        resumeKey: null,
        outstandingAttemptRefs: [],
      });
      assert.equal(res.ok, false);
    });
  });

  describe('validateCompactSummary', () => {
    it('accepts valid 6-field compact summary', () => {
      const summary = {
        taskId: 'task-1',
        sourceStateVersion: 3,
        goal: 'Implement UC-04',
        constraints: ['strict ESM'],
        completedWork: ['Phase 1 done'],
        currentState: 'Phase 2 in progress',
        openRisks: [],
        nextAction: 'Run store tests',
      };
      const res = validateCompactSummary(summary);
      assert.equal(res.ok, true);
    });

    it('rejects summary missing any of the 6 core fields', () => {
      const invalid = {
        taskId: 'task-1',
        sourceStateVersion: 3,
        goal: 'Implement UC-04',
        constraints: ['strict ESM'],
        // missing completedWork
        currentState: 'Phase 2 in progress',
        openRisks: [],
        nextAction: 'Run store tests',
      };
      const res = validateCompactSummary(invalid);
      assert.equal(res.ok, false);
    });
  });

  describe('validateRegisterTaskInput', () => {
    it('accepts valid task registration and checks acyclic step graph', () => {
      const input = {
        schemaVersion: UC04_SCHEMA_VERSION,
        taskId: 'task-1',
        repositoryId: 'repo-1',
        workspaceId: 'ws-1',
        taskType: 'feature',
        goal: 'Add feature',
        acceptanceCriteria: ['pass tests'],
        constraints: ['no regression'],
        plan: [
          { id: 's1', title: 'Step 1', description: 'Desc 1', status: 'todo', predecessorIds: [] },
          { id: 's2', title: 'Step 2', description: 'Desc 2', status: 'todo', predecessorIds: ['s1'] },
        ],
        budgetLedgers: [
          {
            scope: 'task',
            kind: 'tokens',
            limit: 10000,
            consumed: 0,
            reservations: [],
            configurationId: 'cfg-1',
            version: 1,
          },
        ],
        workspaceBaseline: {
          commitHash: 'abcdef1234567890',
          branch: 'feat/test',
          isClean: true,
          trackedFilesHash: 'hash123',
        },
      };
      const res = validateRegisterTaskInput(input);
      assert.equal(res.ok, true);
    });

    it('rejects cycle in step predecessors', () => {
      const input = {
        schemaVersion: UC04_SCHEMA_VERSION,
        taskId: 'task-1',
        repositoryId: 'repo-1',
        workspaceId: 'ws-1',
        taskType: 'feature',
        goal: 'Add feature',
        acceptanceCriteria: ['pass tests'],
        constraints: [],
        plan: [
          { id: 's1', title: 'Step 1', description: 'Desc 1', status: 'todo', predecessorIds: ['s2'] },
          { id: 's2', title: 'Step 2', description: 'Desc 2', status: 'todo', predecessorIds: ['s1'] },
        ],
        budgetLedgers: [],
        workspaceBaseline: {
          commitHash: 'abcdef1234567890',
          branch: 'feat/test',
          isClean: true,
          trackedFilesHash: 'hash123',
        },
      };
      const res = validateRegisterTaskInput(input);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.ok(res.errors.some((e) => e.code === 'CYCLIC_DEPENDENCY'));
      }
    });

    it('rejects duplicate step ID in plan', () => {
      const input = {
        schemaVersion: UC04_SCHEMA_VERSION,
        taskId: 'task-1',
        repositoryId: 'repo-1',
        workspaceId: 'ws-1',
        taskType: 'feature',
        goal: 'Add feature',
        acceptanceCriteria: ['pass tests'],
        constraints: [],
        plan: [
          { id: 's1', title: 'Step 1', description: 'Desc 1', status: 'todo', predecessorIds: [] },
          { id: 's1', title: 'Step 1 dup', description: 'Desc 2', status: 'todo', predecessorIds: [] },
        ],
        budgetLedgers: [],
        workspaceBaseline: {
          commitHash: 'abcdef1234567890',
          branch: 'feat/test',
          isClean: true,
          trackedFilesHash: 'hash123',
        },
      };
      const res = validateRegisterTaskInput(input);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_STEP_ID'));
      }
    });

    it('rejects unknown foreign predecessor ref', () => {
      const input = {
        schemaVersion: UC04_SCHEMA_VERSION,
        taskId: 'task-1',
        repositoryId: 'repo-1',
        workspaceId: 'ws-1',
        taskType: 'feature',
        goal: 'Add feature',
        acceptanceCriteria: ['pass tests'],
        constraints: [],
        plan: [
          { id: 's1', title: 'Step 1', description: 'Desc 1', status: 'todo', predecessorIds: ['unknown-step'] },
        ],
        budgetLedgers: [],
        workspaceBaseline: {
          commitHash: 'abcdef1234567890',
          branch: 'feat/test',
          isClean: true,
          trackedFilesHash: 'hash123',
        },
      };
      const res = validateRegisterTaskInput(input);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.ok(res.errors.some((e) => e.code === 'FOREIGN_PREDECESSOR'));
      }
    });
  });

  describe('validateClaimDispatchInput & Task Control Inputs', () => {
    it('validates claim dispatch input successfully', () => {
      const res = validateClaimDispatchInput({
        taskId: 'task-1',
        runId: 'run-1',
        stepId: 's1',
        actionId: 'act-1',
        expectedEpoch: 1,
        expectedStateVersion: 2,
        requiredEvidenceRefs: ['ev-1'],
        reservationRefs: ['res-1'],
        repoDigest: 'digest-1',
        policyVersion: '1.0',
      });
      assert.equal(res.ok, true);
    });

    it('validates pause and resume inputs', () => {
      const pauseRes = validatePauseTaskInput({
        taskId: 'task-1',
        expectedRevision: 1,
        pauseKey: 'p-1',
        operatorRef: 'user',
      });
      assert.equal(pauseRes.ok, true);

      const resumeRes = validateResumeTaskInput({
        taskId: 'task-1',
        expectedRevision: 2,
        resumeKey: 'r-1',
        operatorRef: 'user',
      });
      assert.equal(resumeRes.ok, true);
    });

    it('validates record and settle and recover inputs', () => {
      const settleRes = validateRecordAndSettleInput({
        taskId: 'task-1',
        runId: 'run-1',
        claimId: 'claim-1',
        requestId: 'req-1',
        observedOutcome: 'success',
        observedUsage: {
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.002,
        },
        evidenceRefs: ['ev-1'],
      });
      assert.equal(settleRes.ok, true);

      const recoverRes = validateRecoverTaskInput({
        taskId: 'task-1',
        newRunId: 'run-2',
        repoEvidence: {
          commitHash: 'abcdef1234567890',
          branch: 'feat/test',
          isClean: true,
          trackedFilesHash: 'hash123',
        },
      });
      assert.equal(recoverRes.ok, true);
    });

    it('validates task state, ledger, and bundle', () => {
      const ledger = {
        scope: 'task' as const,
        kind: 'tokens' as const,
        limit: 1000,
        consumed: 100,
        reservations: [],
        configurationId: 'cfg',
        version: 1,
      };
      const lRes = validateBudgetLedger(ledger);
      assert.equal(lRes.ok, true);

      const bRes = validateReservationBundle({
        bundleId: 'b1',
        transactionRef: 'tx1',
        taskId: 't1',
        runId: 'r1',
        reservations: [],
      });
      assert.equal(bRes.ok, true);

      const sampleState: TaskState = {
        schemaVersion: UC04_SCHEMA_VERSION,
        taskId: 't1',
        runId: 'r1',
        repositoryId: 'repo-1',
        workspaceId: 'ws-1',
        taskType: 'feature',
        goal: 'test task',
        acceptanceCriteria: ['pass'],
        constraints: [],
        plan: [],
        currentStepIndex: 0,
        status: 'running',
        stateVersion: 1,
        budgetLedgers: [ledger],
        workspaceBaseline: {
          commitHash: 'abcdef1234567890',
          branch: 'feat/test',
          isClean: true,
          trackedFilesHash: 'hash123',
        },
        changedFiles: [],
        openRisks: [],
        nextAction: 'Ready to proceed',
      };
      const sRes = validateTaskState(sampleState);
      assert.equal(sRes.ok, true);

      // Rejects missing required field (e.g. status)
      const missingStatus = { ...sampleState, status: undefined };
      assert.equal(validateTaskState(missingStatus).ok, false);

      // Rejects invalid status
      const badStatusRes = validateTaskState({
        ...sampleState,
        status: 'invalid_status' as unknown as TaskState['status'],
      });
      assert.equal(badStatusRes.ok, false);

      // Validates plan steps inside plan array
      const badStepRes = validateTaskState({
        ...sampleState,
        plan: [{ id: '', title: '', description: '', status: 'todo' }],
      });
      assert.equal(badStepRes.ok, false);

      // Validates budget ledgers inside budgetLedgers array
      const badLedgerRes = validateTaskState({
        ...sampleState,
        budgetLedgers: [{ scope: 'invalid' as unknown as 'task', kind: 'tokens', limit: -1, consumed: 0, reservations: [], configurationId: 'c', version: 1 }],
      });
      assert.equal(badLedgerRes.ok, false);

      // Rejects non-array changedFiles / openRisks
      const badArraysRes = validateTaskState({
        ...sampleState,
        changedFiles: 'not-an-array' as unknown as string[],
        openRisks: 123 as unknown as string[],
      });
      assert.equal(badArraysRes.ok, false);

      // Rejects non-string repositoryId, workspaceId, taskType, goal, nextAction
      const badStringsRes = validateTaskState({
        ...sampleState,
        repositoryId: '',
        workspaceId: 123 as unknown as string,
        taskType: '   ' as unknown as 'feature',
        goal: '',
        nextAction: null as unknown as string,
      });
      assert.equal(badStringsRes.ok, false);
    });

    it('rejects budget ledger missing configurationId or with invalid reservation item', () => {
      const resMissingCfg = validateBudgetLedger({
        scope: 'task',
        kind: 'tokens',
        limit: 1000,
        consumed: 0,
        reservations: [],
        version: 1,
      });
      assert.equal(resMissingCfg.ok, false);

      const resBadItem = validateBudgetLedger({
        scope: 'task',
        kind: 'tokens',
        limit: 1000,
        consumed: 0,
        reservations: [{ reservationId: '', keyedId: 'k1', amount: -5 }],
        configurationId: 'cfg-1',
        version: 1,
      });
      assert.equal(resBadItem.ok, false);
    });

    it('rejects reservation bundle missing taskId, runId, or with invalid item', () => {
      const resMissingOwner = validateReservationBundle({
        bundleId: 'b1',
        transactionRef: 'tx1',
        reservations: [],
      });
      assert.equal(resMissingOwner.ok, false);

      const resBadItem = validateReservationBundle({
        bundleId: 'b1',
        transactionRef: 'tx1',
        taskId: 't1',
        runId: 'r1',
        reservations: [
          {
            ledgerIdentity: 'task:tokens',
            scope: 'task',
            kind: 'tokens',
            configurationId: 'cfg',
            version: 1,
            requestId: 'req-1',
            amount: -10,
          },
        ],
      });
      assert.equal(resBadItem.ok, false);
    });

    it('validates checkpoint envelope coherence against embedded state', () => {
      const validState: TaskState = {
        schemaVersion: UC04_SCHEMA_VERSION,
        taskId: 't-cohere',
        runId: 'r-cohere',
        repositoryId: 'repo',
        workspaceId: 'ws',
        taskType: 'feature',
        goal: 'goal',
        acceptanceCriteria: [],
        constraints: [],
        plan: [
          { id: 's1', title: 'Step 1', description: 'desc', status: 'done', evidenceRefs: ['ev-1'] },
          { id: 's2', title: 'Step 2', description: 'desc', status: 'done', evidenceRefs: ['ev-2'] },
          { id: 's3', title: 'Step 3', description: 'desc', status: 'todo' },
        ],
        currentStepIndex: 2,
        changedFiles: [],
        openRisks: [],
        nextAction: 'next',
        status: 'running',
        stateVersion: 5,
        budgetLedgers: [],
        workspaceBaseline: { commitHash: 'abcdef1234567890', branch: 'feat', isClean: true, trackedFilesHash: 'hash' },
      };

      const validCp: CheckpointRecord = {
        checkpointId: 'cp-1',
        taskId: 't-cohere',
        runId: 'r-cohere',
        stepIndex: 2,
        stateVersion: 5,
        timestamp: new Date().toISOString(),
        checksum: 'checksum-123',
        state: validState,
      };
      assert.equal(validateCheckpointRecord(validCp).ok, true);

      // Incoherent taskId
      const incoherentTask = { ...validCp, taskId: 'different-task' };
      const resIncoherent = validateCheckpointRecord(incoherentTask);
      assert.equal(resIncoherent.ok, false);
      if (!resIncoherent.ok) {
        assert.ok(resIncoherent.errors.some((e) => e.code === 'INCOHERENT_CHECKPOINT'));
      }

      // Incoherent stateVersion
      const incoherentVer = { ...validCp, stateVersion: 99 };
      assert.equal(validateCheckpointRecord(incoherentVer).ok, false);
    });
  });

  describe('completion evidence and verification outcome', () => {
    const baseState = (): TaskState => ({
      schemaVersion: UC04_SCHEMA_VERSION,
      taskId: 't-complete',
      runId: 'r-complete',
      repositoryId: 'repo-1',
      workspaceId: 'ws-1',
      taskType: 'feature',
      goal: 'complete the task',
      acceptanceCriteria: ['pass'],
      constraints: [],
      plan: [{ id: 's1', title: 'Step 1', description: 'desc', status: 'done', evidenceRefs: ['ev-1'] }],
      currentStepIndex: 1,
      status: 'completed',
      stateVersion: 4,
      budgetLedgers: [],
      workspaceBaseline: {
        commitHash: 'abcdef1234567890',
        branch: 'feat/test',
        isClean: true,
        trackedFilesHash: 'hash123',
      },
      changedFiles: [],
      openRisks: [],
      nextAction: 'Done',
    });

    it('rejects a completed task with a non-done plan step', () => {
      const state = baseState();
      const res = validateTaskState({
        ...state,
        plan: [
          { id: 's1', title: 'Step 1', description: 'desc', status: 'done', evidenceRefs: ['ev-1'] },
          { id: 's2', title: 'Step 2', description: 'desc', status: 'todo' },
        ],
        verification: { status: 'verified', evidenceRefs: ['test-ok'], checkedAt: '2026-10-21T12:00:00.000Z' },
      });
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.ok(res.errors.some((e) => e.code === 'INCOMPLETE_COMPLETION' && e.path.endsWith('.status')));
      }
    });

    it('rejects a completed task without a verification record', () => {
      const res = validateTaskState(baseState());
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.ok(res.errors.some((e) => e.code === 'INCOMPLETE_COMPLETION' && e.path.endsWith('.verification')));
      }
    });

    it('rejects a completed task whose verification is unavailable', () => {
      const res = validateTaskState({
        ...baseState(),
        verification: { status: 'unavailable', evidenceRefs: [], checkedAt: '2026-10-21T12:00:00.000Z' },
      });
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.ok(res.errors.some((e) => e.code === 'INCOMPLETE_COMPLETION' && e.path.endsWith('.verification')));
      }
    });

    it('accepts a completed task with verified evidence', () => {
      const res = validateTaskState({
        ...baseState(),
        verification: { status: 'verified', evidenceRefs: ['test-ok'], checkedAt: '2026-10-21T12:00:00.000Z' },
      });
      assert.equal(res.ok, true);
    });

    it('rejects a verification record with an invalid status', () => {
      const res = validateTaskState({
        ...baseState(),
        verification: { status: 'trust-me', evidenceRefs: ['test-ok'], checkedAt: '2026-10-21T12:00:00.000Z' },
      });
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.ok(res.errors.some((e) => e.path.endsWith('.verification.status') && e.code === 'INVALID_VERIFICATION_STATUS'));
      }
    });
  });

  describe('validateBudgetJournalRecord', () => {
    const validJournal = {
      schemaVersion: UC04_SCHEMA_VERSION,
      taskId: 'task-1',
      runId: 'run-1',
      ledgers: [
        {
          scope: 'task',
          kind: 'tokens',
          limit: 1000,
          consumed: 100,
          reservations: [],
          configurationId: 'cfg-1',
          version: 1,
        },
      ],
      replanCount: 0,
      updatedAt: '2026-10-31T00:00:00.000Z',
    };

    it('accepts a valid budget journal record', () => {
      assert.equal(validateBudgetJournalRecord(validJournal).ok, true);
    });

    it('rejects a budget journal with a negative replanCount or bad ledger', () => {
      assert.equal(validateBudgetJournalRecord({ ...validJournal, replanCount: -1 }).ok, false);
      assert.equal(validateBudgetJournalRecord({ ...validJournal, ledgers: [{ scope: 'nope' }] }).ok, false);
      assert.equal(validateBudgetJournalRecord({ ...validJournal, taskId: '' }).ok, false);
    });
  });

  describe('validateDispatchClaimRecord', () => {
    const validClaim = {
      claimId: 'claim-1',
      taskId: 'task-1',
      runId: 'run-1',
      stepId: 's1',
      actionId: 'act-1',
      epoch: 0,
      stateVersion: 1,
      phase: 'claimed',
      reservationRefs: ['res-1'],
      createdAt: '2026-10-31T00:00:00.000Z',
    };

    it('accepts a valid dispatch claim record', () => {
      assert.equal(validateDispatchClaimRecord(validClaim).ok, true);
    });

    it('rejects a dispatch claim with a bad phase, negative epoch, or missing claimId', () => {
      assert.equal(validateDispatchClaimRecord({ ...validClaim, phase: 'unknown-phase' }).ok, false);
      assert.equal(validateDispatchClaimRecord({ ...validClaim, phase: 'reconciled' }).ok, true);
      assert.equal(validateDispatchClaimRecord({ ...validClaim, epoch: -1 }).ok, false);
      const missingClaimId: Record<string, unknown> = { ...validClaim };
      delete missingClaimId.claimId;
      const res = validateDispatchClaimRecord(missingClaimId);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.ok(res.errors.some((e) => e.path.endsWith('.claimId')));
      }
    });
  });
});
