/** Trusted task state transition admission. */

import { canonicalJsonStringify, computeCanonicalSha256 } from '../identity.ts';
import type { StateTransitionOptions, TaskState, ValidationError, ValidationResult, VerificationResult } from '../types.ts';
import { ALLOWED_NODE_TRANSITIONS } from '../types.ts';
import { isPlainObject } from './common.ts';
import { validateReviewAdmission, validateVerificationAdmission, validateVerificationResult } from './evidence.ts';
import { validateApprovalBinding } from './intake.ts';
import { validateTaskState } from './state.ts';

export function validateStateTransition(
  priorState: unknown,
  nextState: unknown,
  options?: StateTransitionOptions
): ValidationResult<TaskState> {
  const priorRes = validateTaskState(priorState);
  if (!priorRes.ok) {
    return {
      ok: false,
      errors: priorRes.errors.map((e) => ({
        ...e,
        path: `priorState.${e.path}`,
      })),
    };
  }

  const nextRes = validateTaskState(nextState);
  if (!nextRes.ok) {
    return {
      ok: false,
      errors: nextRes.errors.map((e) => ({
        ...e,
        path: `nextState.${e.path}`,
      })),
    };
  }

  const prior = priorRes.value;
  const next = nextRes.value;
  const errors: ValidationError[] = [];

  // 1. CAS State Version Check
  if (next.stateVersion !== prior.stateVersion + 1) {
    errors.push({
      path: 'stateVersion',
      message: `CAS conflict: expected stateVersion ${prior.stateVersion + 1}, got ${next.stateVersion}`,
      code: 'CAS_CONFLICT',
    });
  }

  // 2. Identity preservation
  if (next.taskId !== prior.taskId) {
    errors.push({
      path: 'taskId',
      message: `Task identity mismatch: prior ${prior.taskId} !== next ${next.taskId}`,
      code: 'TASK_IDENTITY_MISMATCH',
    });
  }

  if (next.workspaceId !== prior.workspaceId) {
    errors.push({
      path: 'workspaceId',
      message: `Workspace identity mismatch: prior ${prior.workspaceId} !== next ${next.workspaceId}`,
      code: 'WORKSPACE_IDENTITY_MISMATCH',
    });
  }

  if (next.repositoryId !== prior.repositoryId) {
    errors.push({
      path: 'repositoryId',
      message: `Repository identity mismatch: prior ${prior.repositoryId} !== next ${next.repositoryId}`,
      code: 'REPOSITORY_IDENTITY_MISMATCH',
    });
  }

  if (next.schemaVersion !== prior.schemaVersion) {
    errors.push({
      path: 'schemaVersion',
      message: `Schema version mismatch: prior ${prior.schemaVersion} !== next ${next.schemaVersion}`,
      code: 'SCHEMA_VERSION_MISMATCH',
    });
  }

  const fail = (path: string, code: string, message: string): void => { errors.push({ path, code, message }); };
  if (canonicalJsonStringify(prior.taskContext) !== canonicalJsonStringify(next.taskContext)) fail('taskContext', 'IMMUTABLE_TASK_CONTEXT', 'Original task and configuration cannot change');
  if (next.plan && next.plan.planVersion !== next.planVersion) fail('planVersion', 'PLAN_VERSION_MISMATCH', 'Plan version must match state');
  if (prior.checkpointConfigId !== undefined && next.checkpointConfigId !== prior.checkpointConfigId) fail('checkpointConfigId', 'IMMUTABLE_CHECKPOINT_CONFIG', 'Checkpoint configuration cannot disappear or change');
  if (prior.checkpointVersion !== undefined && (next.checkpointVersion === undefined ||
      next.checkpointVersion < prior.checkpointVersion)) fail('checkpointVersion', 'CHECKPOINT_VERSION_RESET', 'Checkpoint version cannot disappear or reset');
  if (next.planVersion < prior.planVersion) fail('planVersion', 'PLAN_VERSION_DECREASED', 'Plan versions cannot reset');
  for (const ledger of prior.budgetLedgers ?? []) {
    const current = next.budgetLedgers?.find(l => l.scope === ledger.scope && l.kind === ledger.kind);
    if (!current ||
      current.configurationId !== ledger.configurationId ||
      current.limit !== ledger.limit ||
      current.unit !== ledger.unit ||
      current.consumed < ledger.consumed ||
      current.version < ledger.version) {
      fail('budgetLedgers', 'ACCOUNTING_RESET', 'Persisted accounting cannot disappear or reset'); continue;
    }
    const removed = ledger.reservations.filter(r => !current.reservations.some(n => n.reservationId === r.reservationId && n.keyedId === r.keyedId && n.amount === r.amount)).reduce((sum, r) => sum + r.amount, 0);
    if (current.consumed < ledger.consumed + removed) fail('budgetLedgers', 'ACCOUNTING_RESET', 'Removed reservations must remain charged as consumption');
  }
  if (prior.plan && !next.plan && next.planVersion !== prior.planVersion + 1) {
    fail('plan', 'PLAN_IDENTITY_DROPPED', 'Retain the recorded strategy until a new charged plan version is reserved');
  }
  const material = (prior.plan && next.plan && (prior.plan.strategyDigest !== next.plan.strategyDigest ||
      prior.plan.strategy !== next.plan.strategy)) ||
      next.planVersion > prior.planVersion ||
      (prior.node === 'Repair' && next.node === 'Investigate');
  if (material || next.replanCount > prior.replanCount) {
    const reservation = options?.trusted?.replanReservation;
    const ledger = next.budgetLedgers?.find(l => l.scope === 'task' && l.kind === 'replan');
    if (next.replanCount !== prior.replanCount + 1 ||
      !reservation ||
      !reservation.proposalId?.trim() ||
      prior.budgetLedgers?.some(l => l.reservations.some(r => r.reservationId === reservation.reservationId ||
      r.keyedId === reservation.proposalId)) ||
      reservation.taskId !== next.taskId ||
      reservation.configurationId !== next.taskContext?.configId ||
      reservation.priorCount !== prior.replanCount ||
      reservation.nextCount !== next.replanCount ||
      !ledger ||
      ledger.limit > 3 ||
      ledger.configurationId !== reservation.configurationId ||
      !ledger.reservations.some(r => r.reservationId === reservation.reservationId && r.keyedId === reservation.proposalId && r.amount === 1) ||
      ledger.consumed + ledger.reservations.reduce((sum, r) => sum + r.amount, 0) < next.replanCount) fail('replanCount', 'MISSING_REPLAN_RESERVATION', 'Material replan needs one monotone task-scoped reserved slot');
    if (prior.node === 'Repair' && next.node === 'Investigate' && next.planVersion !== prior.planVersion + 1) fail('planVersion', 'MATERIAL_PLAN_VERSION', 'Reserve the new plan version before investigation');
    if (prior.plan && next.plan && (prior.plan.strategyDigest !== next.plan.strategyDigest ||
      prior.plan.strategy !== next.plan.strategy) && next.planVersion !== prior.planVersion + 1) fail('planVersion', 'MATERIAL_PLAN_VERSION', 'Material strategy changes require a new plan version');
  }
  if (next.node === 'Patch') {
    const authorization = options?.trusted?.approval;
    const admitted = validateApprovalBinding(authorization?.binding, authorization?.freshness);
    const binding = admitted.ok ? admitted.value : undefined;
    const plan = next.plan;
    if (!binding ||
      binding.status !== 'approved' ||
      binding.actionKind !== 'fix_plan' ||
      !plan ||
      material ||
      binding.taskId !== next.taskId ||
      binding.workspaceId !== next.workspaceId ||
      binding.repositoryRevisionDigest !== next.repositoryRevisionDigest ||
      binding.planVersion !== next.planVersion ||
      binding.strategyDigest !== plan.strategyDigest ||
      binding.baselineRef !== plan.baselineRef ||
      binding.checkSetDigest !== plan.checkSetDigest ||
      binding.criteriaDigest !== computeCanonicalSha256(next.acceptanceCriteria) ||
      canonicalJsonStringify(binding.evidenceRefs) !== canonicalJsonStringify(plan.evidenceRefs) ||
      binding.decisionId !== next.activeDecisionId ||
      plan.decisionRef !== binding.decisionId) fail('node', 'UNAPPROVED_PATCH', 'Patch requires a fresh trusted approved binding for this exact plan');
  }
  if (next.outcome === 'COMPLETED') {
    const evidence = options?.trusted?.completion;
    const plan = next.plan;
    const rawChecksValid = evidence && Array.isArray(evidence.checks) && evidence.checks.every(record => {
      if (!isPlainObject(record)) return false;
      if ('checkId' in record) return Object.keys(record).every(key => ['checkId', 'outcome', 'repositoryRevisionDigest', 'diffDigest'].includes(key));
      const shape = validateVerificationResult(record);
      if (!shape.ok) return false;
      const matching = next.taskContext?.requiredChecks.filter(check => shape.value.testedIds.includes(check.checkId));
      return !!matching?.length && shape.value.testedIds.every(id => matching.some(check => check.checkId === id)) && matching.every(check => validateVerificationAdmission(record, {
        expectedTaskId: next.taskId, expectedRunId: next.runId,
        expectedRepoDigest: next.repositoryRevisionDigest, expectedDiffDigest: evidence.diffDigest,
        expectedCheckId: check.checkId, requiredPhase: check.purpose === 'reproduction' ? 'focused' : check.purpose,
      }).ok);
    });
    const rawReviewValid = evidence && evidence.review !== null && typeof evidence.review === 'object' && ('roleConfigId' in evidence.review
      ? Object.keys(evidence.review).every(key => ['reviewId', 'status', 'repositoryRevisionDigest', 'diffDigest', 'checkSetDigest', 'roleConfigId'].includes(key))
      : !!evidence.reviewerRoleConfigId && !!evidence.reviewIterationReservationRef && validateReviewAdmission(evidence.review, {
          expectedReviewId: next.latestReviewRef, expectedRepoDigest: next.repositoryRevisionDigest,
          expectedDiffDigest: evidence.diffDigest, expectedCheckSetDigest: evidence.checkSetDigest,
          expectedRoleConfigId: evidence.reviewerRoleConfigId,
          expectedIterationReservationRef: evidence.reviewIterationReservationRef,
        }).ok);

    if (!evidence ||
      !rawChecksValid || !rawReviewValid ||
      !plan ||
      evidence.taskId !== next.taskId ||
      evidence.runId !== next.runId ||
      evidence.repositoryRevisionDigest !== next.repositoryRevisionDigest ||
      !evidence.diffDigest?.trim() ||
      evidence.authorizedDiffDigest !== evidence.diffDigest ||
      evidence.baselineRef !== plan.baselineRef ||
      !next.evidenceRefs.includes(evidence.baselineRef) ||
      evidence.criteriaDigest !== computeCanonicalSha256(next.acceptanceCriteria) ||
      evidence.checkSetDigest !== plan.checkSetDigest ||
      !evidence.protectedTestsDigest?.trim() ||
      evidence.protectedTestsDigest !== evidence.originalProtectedTestsDigest ||
      !Array.isArray(evidence.checks) ||
      !next.taskContext?.requiredChecks.every(c => evidence.checks.some(r => {
        const checkIdMatch = 'checkId' in r ? r.checkId === c.checkId : ('testedIds' in r && Array.isArray((r as VerificationResult).testedIds) && (r as VerificationResult).testedIds.includes(c.checkId));
        const outcomeMatch = r.outcome === 'pass';
        const repoMatch = ('repositoryRevisionDigest' in r ? r.repositoryRevisionDigest : ('repoDigest' in r ? (r as VerificationResult).repoDigest : undefined)) === next.repositoryRevisionDigest;
        const diffMatch = r.diffDigest === evidence.diffDigest;
        return checkIdMatch && outcomeMatch && repoMatch && diffMatch;
      })) ||
      evidence.review?.status !== 'accepted' ||
      !('roleConfigId' in evidence.review ? evidence.review.roleConfigId?.trim() : evidence.review.reviewerRoleConfigId?.trim()) ||
      ('repositoryRevisionDigest' in evidence.review ? evidence.review.repositoryRevisionDigest : evidence.review.repoDigest) !== next.repositoryRevisionDigest ||
      evidence.review.diffDigest !== evidence.diffDigest ||
      evidence.review.checkSetDigest !== evidence.checkSetDigest ||
      evidence.review.reviewId !== next.latestReviewRef ||
      !next.reviewRefs?.includes(evidence.review.reviewId)) fail('outcome', 'UNSUPPORTED_COMPLETION', 'Completion requires trusted current baseline, authorized diff, passing checks, test protection and accepted read-only review');
  }

  // 3. Terminal node check
  if (prior.node === 'Deliver' || prior.node === 'Incomplete') {
    errors.push({
      path: 'node',
      message: `Cannot transition from terminal node: ${prior.node}`,
      code: 'TERMINAL_NODE_CANNOT_TRANSITION',
    });
  }

  // 4. Allowed Node Transition Check
  if (prior.node === next.node) {
    if (!options?.allowSameNode) {
      errors.push({
        path: 'node',
        message: `Self-transition on node ${prior.node} is not allowed without allowSameNode option`,
        code: 'INVALID_NODE_TRANSITION',
      });
    }
  } else {
    const allowed = ALLOWED_NODE_TRANSITIONS[prior.node] ?? [];
    if (!allowed.includes(next.node)) {
      errors.push({
        path: 'node',
        message: `Invalid transition from ${prior.node} to ${next.node}. Allowed: ${allowed.join(', ') || 'none'}`,
        code: 'INVALID_NODE_TRANSITION',
      });
    }
  }

  // 5. Material Replan Limits & Replenishment Prohibition
  if (next.replanCount < prior.replanCount) {
    errors.push({
      path: 'replanCount',
      message: `replanCount cannot decrease from ${prior.replanCount} to ${next.replanCount} (replenishment prohibited)`,
      code: 'REPLAN_COUNT_DECREASED',
    });
  }
  if (next.replanCount > 3) {
    errors.push({
      path: 'replanCount',
      message: 'replanCount exceeds 3 (fixed task-scoped replan limit)',
      code: 'REPLAN_CAP_EXCEEDED',
    });
  }

  // 6. Plan required before entering AwaitPlan
  if (next.node === 'AwaitPlan' && !next.plan) {
    errors.push({
      path: 'plan',
      message: 'A baseline and fix plan must be recorded before entering AwaitPlan',
      code: 'MISSING_PLAN',
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: next };
}

/* ------------------------------------------------------------------
 * Slice 3: Provider Accounting & Model Proposal / Result Validators
 * ------------------------------------------------------------------ */
