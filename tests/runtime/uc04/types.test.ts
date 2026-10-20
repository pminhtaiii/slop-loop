import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStepStatus,
  validatePlanStep,
  validateTaskState,
  validateBudgetLedger,
  validateReservationBundle,
  validateApprovalRequestBinding,
  validateWorkspaceBaseline,
} from '../../../src/contracts/uc04.ts';
import type { TaskState, PlanStep, BudgetLedger, ApprovalRequestBinding, WorkspaceBaseline } from '../../../src/state/types.ts';

describe('UC-04 Contract & Types Validation', () => {
  it('validates canonical step statuses: todo, doing, done, failed', () => {
    assert.equal(validateStepStatus('todo').ok, true);
    assert.equal(validateStepStatus('doing').ok, true);
    assert.equal(validateStepStatus('done').ok, true);
    assert.equal(validateStepStatus('failed').ok, true);
    assert.equal(validateStepStatus('in_progress').ok, false);
    assert.equal(validateStepStatus('').ok, false);
    assert.equal(validateStepStatus(123).ok, false);
  });

  it('validates PlanStep schema', () => {
    const validStep: PlanStep = {
      id: 'step-1',
      title: 'Setup models',
      description: 'Define initial domain models',
      status: 'todo',
    };
    const res = validatePlanStep(validStep);
    assert.equal(res.ok, true);

    const invalidStep = {
      id: '',
      title: 'Invalid',
      status: 'unknown',
    };
    const invalidRes = validatePlanStep(invalidStep);
    assert.equal(invalidRes.ok, false);
  });

  it('validates TaskState schema with required fields', () => {
    const baseline: WorkspaceBaseline = {
      commitHash: 'abcdef1234567890abcdef1234567890abcdef12',
      branch: 'feature/use-case-4',
      isClean: true,
      trackedFilesHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    };

    const validTask: TaskState = {
      taskId: 'task-100',
      runId: 'run-1',
      taskType: 'feature',
      goal: 'Implement multi-step workflow',
      acceptanceCriteria: ['Pass all tests', 'Persist checkpoints'],
      constraints: ['No unconstrained shell execution'],
      plan: [
        {
          id: 'step-1',
          title: 'Step 1',
          description: 'First step',
          status: 'todo',
        },
      ],
      currentStepIndex: 0,
      changedFiles: [],
      status: 'pending',
      stateVersion: 1,
      budgetLedgers: [
        {
          scope: 'task',
          kind: 'tokens',
          limit: 100000,
          consumed: 0,
          reservations: [],
          configurationId: 'default-config',
          version: 1,
        },
      ],
      workspaceBaseline: baseline,
    };

    const res = validateTaskState(validTask);
    assert.equal(res.ok, true);

    const invalidTask = {
      taskId: '',
      status: 'non_existent_status',
    };
    assert.equal(validateTaskState(invalidTask).ok, false);
  });

  it('validates BudgetLedger and ReservationBundle', () => {
    const ledger: BudgetLedger = {
      scope: 'task',
      kind: 'cost',
      limit: 10.0,
      consumed: 1.5,
      reservations: [{ reservationId: 'res-1', keyedId: 'req-1', amount: 0.5 }],
      configurationId: 'cfg-1',
      version: 2,
    };
    assert.equal(validateBudgetLedger(ledger).ok, true);

    const malformedLedger = {
      scope: 'invalid_scope',
      kind: 'cost',
      limit: -5,
    };
    assert.equal(validateBudgetLedger(malformedLedger).ok, false);

    const bundle = {
      bundleId: 'bundle-1',
      transactionRef: 'tx-1',
      taskId: 'task-1',
      runId: 'run-1',
      reservations: [
        {
          ledgerIdentity: 'task:cost',
          scope: 'task',
          kind: 'cost',
          configurationId: 'cfg-1',
          version: 2,
          requestId: 'req-1',
          amount: 0.5,
        },
      ],
    };
    assert.equal(validateReservationBundle(bundle).ok, true);
  });

  it('validates ApprovalRequestBinding', () => {
    const validApproval: ApprovalRequestBinding = {
      requestId: 'app-req-1',
      actionType: 'run_command',
      targetFiles: ['deploy.sh'],
      normalizedActionDigest: 'hash123',
      repoCommit: 'abcdef1234567890abcdef1234567890abcdef12',
      policyVersion: 'v1.0.0',
      createdAt: new Date().toISOString(),
    };
    assert.equal(validateApprovalRequestBinding(validApproval).ok, true);

    const invalidApproval = {
      requestId: '',
      actionType: '',
    };
    assert.equal(validateApprovalRequestBinding(invalidApproval).ok, false);
  });

  it('validates WorkspaceBaseline', () => {
    const validBaseline: WorkspaceBaseline = {
      commitHash: 'abcdef1234567890abcdef1234567890abcdef12',
      branch: 'main',
      isClean: false,
      trackedFilesHash: 'hash321',
    };
    assert.equal(validateWorkspaceBaseline(validBaseline).ok, true);

    const invalidBaseline = {
      commitHash: 'short',
      branch: '',
    };
    assert.equal(validateWorkspaceBaseline(invalidBaseline).ok, false);
  });
});
