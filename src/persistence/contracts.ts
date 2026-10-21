/**
 * UC-04 Recovery & Multi-step Feature Extension Contracts and Validators.
 * Schema version: uc04-recovery/0.1-draft
 */

export const UC04_SCHEMA_VERSION = 'uc04-recovery/0.1-draft' as const;

export interface ValidationError {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export type StepStatus = 'todo' | 'doing' | 'done' | 'failed';

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: StepStatus;
  readonly predecessorIds?: readonly string[] | undefined;
  readonly startedAt?: string | undefined;
  readonly completedAt?: string | undefined;
  readonly evidenceRefs?: readonly string[] | undefined;
  readonly error?: string | undefined;
  readonly changedFiles?: readonly string[] | undefined;
}

export interface WorkspaceBaseline {
  readonly commitHash: string;
  readonly branch: string;
  readonly isClean: boolean;
  readonly trackedFilesHash: string;
}

export interface BudgetReservationItem {
  readonly reservationId: string;
  readonly keyedId: string;
  readonly amount: number;
}

export interface BudgetLedger {
  readonly scope: 'task' | 'run';
  readonly kind: 'tokens' | 'token' | 'cost' | 'repair' | 'reviewer';
  readonly limit: number;
  readonly consumed: number;
  readonly reservations: readonly BudgetReservationItem[];
  readonly configurationId: string;
  readonly version: number;
}

export interface ReservationBundleItem {
  readonly ledgerIdentity: string;
  readonly scope: 'task' | 'run';
  readonly kind: 'tokens' | 'token' | 'cost' | 'repair' | 'reviewer';
  readonly configurationId: string;
  readonly version: number;
  readonly requestId: string;
  readonly amount: number;
}

export interface ReservationBundle {
  readonly bundleId: string;
  readonly transactionRef: string;
  readonly taskId: string;
  readonly runId: string;
  readonly reservations: readonly ReservationBundleItem[];
}

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly billableTokens?: number | undefined;
  readonly costUsd: number;
}

export interface DeliberatePauseRecord {
  readonly schemaVersion: typeof UC04_SCHEMA_VERSION;
  readonly taskId: string;
  readonly active: boolean;
  readonly pauseKey: string;
  readonly operatorRef: string;
  readonly acceptedAt: string;
  readonly revision: number;
  readonly epoch: number;
  readonly resumeKey: string | null;
  readonly outstandingAttemptRefs: readonly string[];
}

export interface DispatchClaimRecord {
  readonly claimId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly actionId: string;
  readonly epoch: number;
  readonly stateVersion: number;
  readonly phase: 'claimed' | 'dispatched' | 'observed' | 'uncertain' | 'reconciled';
  readonly reservationRefs: readonly string[];
  readonly createdAt: string;
  readonly settledAt?: string | undefined;
  readonly outcomeEvidence?: unknown | undefined;
}

export interface CompactSummary {
  readonly taskId: string;
  readonly sourceStateVersion: number;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly completedWork: readonly string[];
  readonly currentState: string;
  readonly openRisks: readonly string[];
  readonly nextAction: string;
}

export type TaskStatus = 'pending' | 'running' | 'waiting_approval' | 'paused' | 'completed' | 'failed';

export interface ApprovalRequestBinding {
  readonly requestId: string;
  readonly actionType: string;
  readonly targetFiles: readonly string[];
  readonly normalizedActionDigest: string;
  readonly repoCommit: string;
  readonly policyVersion: string;
  readonly createdAt: string;
}

export interface TaskState {
  readonly schemaVersion: typeof UC04_SCHEMA_VERSION;
  readonly taskId: string;
  readonly runId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly taskType: 'feature' | 'bugfix' | 'refactor';
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly plan: readonly PlanStep[];
  readonly currentStepIndex: number;
  readonly status: TaskStatus;
  readonly stateVersion: number;
  readonly lastCheckpointId?: string | undefined;
  readonly budgetLedgers: readonly BudgetLedger[];
  readonly workspaceBaseline: WorkspaceBaseline;
  readonly changedFiles: readonly string[];
  readonly openRisks: readonly string[];
  readonly nextAction: string;
  readonly pendingApproval?: ApprovalRequestBinding | undefined;
}

export interface CheckpointRecord {
  readonly checkpointId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stepIndex: number;
  readonly stateVersion: number;
  readonly timestamp: string;
  readonly state: TaskState;
  readonly checksum: string;
}

/* Operation result discriminant types */
export type OperationDiscriminator =
  | 'ok'
  | 'held'
  | 'invalid'
  | 'denied'
  | 'conflict'
  | 'exhausted'
  | 'unavailable'
  | 'uncertain';

export interface BaseOperationResult {
  readonly status: OperationDiscriminator;
  readonly safeReason?: string | undefined;
  readonly nextAction?: string | undefined;
}

export interface RegisterTaskInput {
  readonly schemaVersion: string;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly taskType: 'feature' | 'bugfix' | 'refactor';
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly plan: readonly PlanStep[];
  readonly budgetLedgers: readonly BudgetLedger[];
  readonly workspaceBaseline: WorkspaceBaseline;
}

export interface ClaimDispatchInput {
  readonly taskId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly actionId: string;
  readonly expectedEpoch: number;
  readonly expectedStateVersion: number;
  readonly requiredEvidenceRefs: readonly string[];
  readonly reservationRefs: readonly string[];
  readonly repoDigest: string;
  readonly policyVersion: string;
}

export interface PauseTaskInput {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly pauseKey: string;
  readonly operatorRef: string;
  readonly reason?: string | undefined;
}

export interface ResumeTaskInput {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly resumeKey: string;
  readonly operatorRef: string;
}

export interface RecordAndSettleInput {
  readonly taskId: string;
  readonly runId: string;
  readonly claimId: string;
  readonly requestId: string;
  readonly observedOutcome: 'success' | 'failure' | 'uncertain';
  readonly observedUsage: ProviderUsage;
  readonly evidenceRefs: readonly string[];
  readonly changedFiles?: readonly string[] | undefined;
  readonly nextAction?: string | undefined;
}

export interface RecoverTaskInput {
  readonly taskId: string;
  readonly newRunId: string;
  readonly repoEvidence: WorkspaceBaseline;
  readonly trustedOutcomeEvidence?: readonly unknown[] | undefined;
}

/* Validators */

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export function validateStepStatus(status: unknown, path = 'status'): ValidationResult<StepStatus> {
  if (status === 'todo' || status === 'doing' || status === 'done' || status === 'failed') {
    return { ok: true, value: status };
  }
  return {
    ok: false,
    errors: [{ path, message: 'Expected canonical status: todo, doing, done, failed', code: 'INVALID_STEP_STATUS' }],
  };
}

export function validatePlanStep(val: unknown, path = 'step'): ValidationResult<PlanStep> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (typeof val.id !== 'string' || !val.id.trim()) {
    errors.push({ path: `${path}.id`, message: 'Step id must be a non-empty string', code: 'INVALID_ID' });
  }
  if (typeof val.title !== 'string' || !val.title.trim()) {
    errors.push({ path: `${path}.title`, message: 'Step title must be a non-empty string', code: 'INVALID_TITLE' });
  }
  if (typeof val.description !== 'string') {
    errors.push({ path: `${path}.description`, message: 'Step description must be a string', code: 'INVALID_DESCRIPTION' });
  }
  const statusRes = validateStepStatus(val.status, `${path}.status`);
  if (!statusRes.ok) {
    errors.push(...statusRes.errors);
  }
  if (val.predecessorIds !== undefined && !Array.isArray(val.predecessorIds)) {
    errors.push({ path: `${path}.predecessorIds`, message: 'predecessorIds must be an array of strings', code: 'INVALID_PREDECESSORS' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as PlanStep };
}

export function validateWorkspaceBaseline(val: unknown, path = 'workspaceBaseline'): ValidationResult<WorkspaceBaseline> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (typeof val.commitHash !== 'string' || val.commitHash.length < 7) {
    errors.push({ path: `${path}.commitHash`, message: 'commitHash must be a valid commit hash string', code: 'INVALID_COMMIT' });
  }
  if (typeof val.branch !== 'string' || !val.branch.trim()) {
    errors.push({ path: `${path}.branch`, message: 'branch must be a non-empty string', code: 'INVALID_BRANCH' });
  }
  if (typeof val.isClean !== 'boolean') {
    errors.push({ path: `${path}.isClean`, message: 'isClean must be a boolean', code: 'INVALID_CLEAN_STATUS' });
  }
  if (typeof val.trackedFilesHash !== 'string' || !val.trackedFilesHash.trim()) {
    errors.push({ path: `${path}.trackedFilesHash`, message: 'trackedFilesHash must be a non-empty string', code: 'INVALID_FILES_HASH' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as WorkspaceBaseline };
}

export function validateBudgetLedger(val: unknown, path = 'ledger'): ValidationResult<BudgetLedger> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (val.scope !== 'task' && val.scope !== 'run') {
    errors.push({ path: `${path}.scope`, message: 'Ledger scope must be task or run', code: 'INVALID_SCOPE' });
  }
  if (!['tokens', 'token', 'cost', 'repair', 'reviewer'].includes(val.kind as string)) {
    errors.push({ path: `${path}.kind`, message: 'Invalid ledger kind', code: 'INVALID_KIND' });
  }
  if (typeof val.limit !== 'number' || val.limit < 0) {
    errors.push({ path: `${path}.limit`, message: 'Ledger limit must be a non-negative number', code: 'INVALID_LIMIT' });
  }
  if (typeof val.consumed !== 'number' || val.consumed < 0) {
    errors.push({ path: `${path}.consumed`, message: 'Ledger consumed must be a non-negative number', code: 'INVALID_CONSUMED' });
  }
  if (!Array.isArray(val.reservations)) {
    errors.push({ path: `${path}.reservations`, message: 'Ledger reservations must be an array', code: 'INVALID_RESERVATIONS' });
  }
  if (typeof val.version !== 'number' || val.version < 1) {
    errors.push({ path: `${path}.version`, message: 'Ledger version must be >= 1', code: 'INVALID_VERSION' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as BudgetLedger };
}

export function validateReservationBundle(val: unknown, path = 'bundle'): ValidationResult<ReservationBundle> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (typeof val.bundleId !== 'string' || !val.bundleId.trim()) {
    errors.push({ path: `${path}.bundleId`, message: 'bundleId must be a non-empty string', code: 'INVALID_BUNDLE_ID' });
  }
  if (typeof val.transactionRef !== 'string' || !val.transactionRef.trim()) {
    errors.push({ path: `${path}.transactionRef`, message: 'transactionRef must be a non-empty string', code: 'INVALID_TX_REF' });
  }
  if (!Array.isArray(val.reservations)) {
    errors.push({ path: `${path}.reservations`, message: 'reservations must be an array', code: 'INVALID_RESERVATIONS' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as ReservationBundle };
}

export function validateDeliberatePauseRecord(val: unknown, path = 'deliberatePause'): ValidationResult<DeliberatePauseRecord> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (val.schemaVersion !== UC04_SCHEMA_VERSION) {
    errors.push({ path: `${path}.schemaVersion`, message: `Expected schema version ${UC04_SCHEMA_VERSION}`, code: 'INCOMPATIBLE_VERSION' });
  }
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) {
    errors.push({ path: `${path}.taskId`, message: 'taskId must be non-empty', code: 'INVALID_TASK_ID' });
  }
  if (typeof val.active !== 'boolean') {
    errors.push({ path: `${path}.active`, message: 'active must be a boolean', code: 'INVALID_ACTIVE' });
  }
  if (typeof val.pauseKey !== 'string' || !val.pauseKey.trim()) {
    errors.push({ path: `${path}.pauseKey`, message: 'pauseKey must be non-empty', code: 'INVALID_PAUSE_KEY' });
  }
  if (typeof val.operatorRef !== 'string' || !val.operatorRef.trim()) {
    errors.push({ path: `${path}.operatorRef`, message: 'operatorRef must be non-empty', code: 'INVALID_OPERATOR_REF' });
  }
  if (typeof val.acceptedAt !== 'string' || !val.acceptedAt.trim()) {
    errors.push({ path: `${path}.acceptedAt`, message: 'acceptedAt must be a valid timestamp string', code: 'INVALID_TIMESTAMP' });
  }
  if (typeof val.revision !== 'number' || val.revision < 1) {
    errors.push({ path: `${path}.revision`, message: 'revision must be >= 1', code: 'INVALID_REVISION' });
  }
  if (typeof val.epoch !== 'number' || val.epoch < 1) {
    errors.push({ path: `${path}.epoch`, message: 'epoch must be >= 1', code: 'INVALID_EPOCH' });
  }
  if (val.resumeKey !== null && typeof val.resumeKey !== 'string') {
    errors.push({ path: `${path}.resumeKey`, message: 'resumeKey must be null or string', code: 'INVALID_RESUME_KEY' });
  }
  if (!Array.isArray(val.outstandingAttemptRefs)) {
    errors.push({ path: `${path}.outstandingAttemptRefs`, message: 'outstandingAttemptRefs must be array', code: 'INVALID_ATTEMPTS' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as DeliberatePauseRecord };
}

export function validateCompactSummary(val: unknown, path = 'summary'): ValidationResult<CompactSummary> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) {
    errors.push({ path: `${path}.taskId`, message: 'taskId must be non-empty', code: 'INVALID_TASK_ID' });
  }
  if (typeof val.sourceStateVersion !== 'number' || val.sourceStateVersion < 1) {
    errors.push({ path: `${path}.sourceStateVersion`, message: 'sourceStateVersion must be >= 1', code: 'INVALID_VERSION' });
  }
  if (typeof val.goal !== 'string' || !val.goal.trim()) {
    errors.push({ path: `${path}.goal`, message: 'goal must be non-empty', code: 'INVALID_GOAL' });
  }
  if (!Array.isArray(val.constraints)) {
    errors.push({ path: `${path}.constraints`, message: 'constraints must be an array', code: 'INVALID_CONSTRAINTS' });
  }
  if (!Array.isArray(val.completedWork)) {
    errors.push({ path: `${path}.completedWork`, message: 'completedWork must be an array', code: 'INVALID_COMPLETED_WORK' });
  }
  if (typeof val.currentState !== 'string' || !val.currentState.trim()) {
    errors.push({ path: `${path}.currentState`, message: 'currentState must be non-empty', code: 'INVALID_CURRENT_STATE' });
  }
  if (!Array.isArray(val.openRisks)) {
    errors.push({ path: `${path}.openRisks`, message: 'openRisks must be an array', code: 'INVALID_OPEN_RISKS' });
  }
  if (typeof val.nextAction !== 'string' || !val.nextAction.trim()) {
    errors.push({ path: `${path}.nextAction`, message: 'nextAction must be non-empty', code: 'INVALID_NEXT_ACTION' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as CompactSummary };
}

export function validateRegisterTaskInput(val: unknown, path = 'input'): ValidationResult<RegisterTaskInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (val.schemaVersion !== UC04_SCHEMA_VERSION) {
    errors.push({ path: `${path}.schemaVersion`, message: `Expected schema version ${UC04_SCHEMA_VERSION}`, code: 'INCOMPATIBLE_VERSION' });
  }
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) {
    errors.push({ path: `${path}.taskId`, message: 'taskId must be non-empty', code: 'INVALID_TASK_ID' });
  }
  if (typeof val.repositoryId !== 'string' || !val.repositoryId.trim()) {
    errors.push({ path: `${path}.repositoryId`, message: 'repositoryId must be non-empty', code: 'INVALID_REPO_ID' });
  }
  if (typeof val.workspaceId !== 'string' || !val.workspaceId.trim()) {
    errors.push({ path: `${path}.workspaceId`, message: 'workspaceId must be non-empty', code: 'INVALID_WORKSPACE_ID' });
  }
  if (!['feature', 'bugfix', 'refactor'].includes(val.taskType as string)) {
    errors.push({ path: `${path}.taskType`, message: 'taskType must be feature, bugfix, or refactor', code: 'INVALID_TASK_TYPE' });
  }
  if (typeof val.goal !== 'string' || !val.goal.trim()) {
    errors.push({ path: `${path}.goal`, message: 'goal must be non-empty', code: 'INVALID_GOAL' });
  }
  if (!Array.isArray(val.acceptanceCriteria)) {
    errors.push({ path: `${path}.acceptanceCriteria`, message: 'acceptanceCriteria must be an array', code: 'INVALID_CRITERIA' });
  }
  if (!Array.isArray(val.constraints)) {
    errors.push({ path: `${path}.constraints`, message: 'constraints must be an array', code: 'INVALID_CONSTRAINTS' });
  }
  if (!Array.isArray(val.plan) || val.plan.length === 0) {
    errors.push({ path: `${path}.plan`, message: 'plan must be a non-empty array', code: 'INVALID_PLAN' });
  } else {
    const stepIds = new Set<string>();
    for (let i = 0; i < val.plan.length; i++) {
      const stepRes = validatePlanStep(val.plan[i], `${path}.plan[${i}]`);
      if (!stepRes.ok) {
        errors.push(...stepRes.errors);
      } else {
        stepIds.add(stepRes.value.id);
      }
    }
    // Verify predecessor integrity: must be internal and acyclic
    const adj = new Map<string, string[]>();
    for (let i = 0; i < val.plan.length; i++) {
      const s = val.plan[i] as PlanStep;
      if (s && s.id) {
        const preds = s.predecessorIds ?? [];
        for (const pred of preds) {
          if (!stepIds.has(pred)) {
            errors.push({ path: `${path}.plan[${i}].predecessorIds`, message: `Unknown predecessor ${pred}`, code: 'FOREIGN_PREDECESSOR' });
          }
        }
        adj.set(s.id, [...preds]);
      }
    }
    // Check cycle using DFS
    const visited = new Map<string, number>(); // 0: unvisited, 1: visiting, 2: visited
    function hasCycle(node: string): boolean {
      visited.set(node, 1);
      const neighbors = adj.get(node) ?? [];
      for (const n of neighbors) {
        const state = visited.get(n) ?? 0;
        if (state === 1) return true;
        if (state === 0 && hasCycle(n)) return true;
      }
      visited.set(node, 2);
      return false;
    }
    for (const id of stepIds) {
      if ((visited.get(id) ?? 0) === 0) {
        if (hasCycle(id)) {
          errors.push({ path: `${path}.plan`, message: 'Plan steps contain cyclic dependency', code: 'CYCLIC_DEPENDENCY' });
          break;
        }
      }
    }
  }

  if (!Array.isArray(val.budgetLedgers)) {
    errors.push({ path: `${path}.budgetLedgers`, message: 'budgetLedgers must be an array', code: 'INVALID_LEDGERS' });
  } else {
    for (let i = 0; i < val.budgetLedgers.length; i++) {
      const lRes = validateBudgetLedger(val.budgetLedgers[i], `${path}.budgetLedgers[${i}]`);
      if (!lRes.ok) errors.push(...lRes.errors);
    }
  }

  const wsRes = validateWorkspaceBaseline(val.workspaceBaseline, `${path}.workspaceBaseline`);
  if (!wsRes.ok) errors.push(...wsRes.errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as RegisterTaskInput };
}

export function validateTaskState(val: unknown, path = 'state'): ValidationResult<TaskState> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (val.schemaVersion !== UC04_SCHEMA_VERSION) {
    errors.push({ path: `${path}.schemaVersion`, message: `Expected schema version ${UC04_SCHEMA_VERSION}`, code: 'INCOMPATIBLE_VERSION' });
  }
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) {
    errors.push({ path: `${path}.taskId`, message: 'taskId must be non-empty', code: 'INVALID_TASK_ID' });
  }
  if (typeof val.runId !== 'string' || !val.runId.trim()) {
    errors.push({ path: `${path}.runId`, message: 'runId must be non-empty', code: 'INVALID_RUN_ID' });
  }
  if (typeof val.stateVersion !== 'number' || val.stateVersion < 1) {
    errors.push({ path: `${path}.stateVersion`, message: 'stateVersion must be >= 1', code: 'INVALID_VERSION' });
  }
  if (!Array.isArray(val.plan)) {
    errors.push({ path: `${path}.plan`, message: 'plan must be an array', code: 'INVALID_PLAN' });
  }
  if (!Array.isArray(val.budgetLedgers)) {
    errors.push({ path: `${path}.budgetLedgers`, message: 'budgetLedgers must be an array', code: 'INVALID_LEDGERS' });
  }
  const wsRes = validateWorkspaceBaseline(val.workspaceBaseline, `${path}.workspaceBaseline`);
  if (!wsRes.ok) errors.push(...wsRes.errors);

  if (val.pendingApproval !== undefined) {
    const appRes = validateApprovalRequestBinding(val.pendingApproval, `${path}.pendingApproval`);
    if (!appRes.ok) errors.push(...appRes.errors);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as TaskState };
}

export function validateApprovalRequestBinding(val: unknown, path = 'approval'): ValidationResult<ApprovalRequestBinding> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (typeof val.requestId !== 'string' || !val.requestId.trim()) {
    errors.push({ path: `${path}.requestId`, message: 'requestId required', code: 'INVALID_REQUEST_ID' });
  }
  if (typeof val.actionType !== 'string' || !val.actionType.trim()) {
    errors.push({ path: `${path}.actionType`, message: 'actionType required', code: 'INVALID_ACTION_TYPE' });
  }
  if (!Array.isArray(val.targetFiles)) {
    errors.push({ path: `${path}.targetFiles`, message: 'targetFiles must be array', code: 'INVALID_TARGET_FILES' });
  }
  if (typeof val.normalizedActionDigest !== 'string' || !val.normalizedActionDigest.trim()) {
    errors.push({ path: `${path}.normalizedActionDigest`, message: 'normalizedActionDigest required', code: 'INVALID_DIGEST' });
  }
  if (typeof val.repoCommit !== 'string' || val.repoCommit.length < 7) {
    errors.push({ path: `${path}.repoCommit`, message: 'repoCommit required', code: 'INVALID_COMMIT' });
  }
  if (typeof val.policyVersion !== 'string' || !val.policyVersion.trim()) {
    errors.push({ path: `${path}.policyVersion`, message: 'policyVersion required', code: 'INVALID_POLICY_VERSION' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as ApprovalRequestBinding };
}

export function validateCheckpointRecord(val: unknown, path = 'checkpoint'): ValidationResult<CheckpointRecord> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (typeof val.checkpointId !== 'string' || !val.checkpointId.trim()) {
    errors.push({ path: `${path}.checkpointId`, message: 'checkpointId must be a non-empty string', code: 'INVALID_CHECKPOINT_ID' });
  }
  if (typeof val.checksum !== 'string' || !val.checksum.trim()) {
    errors.push({ path: `${path}.checksum`, message: 'checksum must be a non-empty string', code: 'INVALID_CHECKSUM' });
  }
  const stateRes = validateTaskState(val.state, `${path}.state`);
  if (!stateRes.ok) errors.push(...stateRes.errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as CheckpointRecord };
}

export function validateClaimDispatchInput(val: unknown, path = 'claim'): ValidationResult<ClaimDispatchInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) errors.push({ path: `${path}.taskId`, message: 'taskId required', code: 'INVALID_TASK_ID' });
  if (typeof val.runId !== 'string' || !val.runId.trim()) errors.push({ path: `${path}.runId`, message: 'runId required', code: 'INVALID_RUN_ID' });
  if (typeof val.stepId !== 'string' || !val.stepId.trim()) errors.push({ path: `${path}.stepId`, message: 'stepId required', code: 'INVALID_STEP_ID' });
  if (typeof val.actionId !== 'string' || !val.actionId.trim()) errors.push({ path: `${path}.actionId`, message: 'actionId required', code: 'INVALID_ACTION_ID' });
  if (typeof val.expectedEpoch !== 'number' || val.expectedEpoch < 1) errors.push({ path: `${path}.expectedEpoch`, message: 'expectedEpoch >= 1', code: 'INVALID_EPOCH' });
  if (typeof val.expectedStateVersion !== 'number' || val.expectedStateVersion < 1) errors.push({ path: `${path}.expectedStateVersion`, message: 'expectedStateVersion >= 1', code: 'INVALID_VERSION' });
  if (!Array.isArray(val.requiredEvidenceRefs)) errors.push({ path: `${path}.requiredEvidenceRefs`, message: 'must be array', code: 'INVALID_REFS' });
  if (!Array.isArray(val.reservationRefs)) errors.push({ path: `${path}.reservationRefs`, message: 'must be array', code: 'INVALID_REFS' });
  if (typeof val.repoDigest !== 'string' || !val.repoDigest.trim()) errors.push({ path: `${path}.repoDigest`, message: 'repoDigest required', code: 'INVALID_DIGEST' });
  if (typeof val.policyVersion !== 'string' || !val.policyVersion.trim()) errors.push({ path: `${path}.policyVersion`, message: 'policyVersion required', code: 'INVALID_VERSION' });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as ClaimDispatchInput };
}

export function validatePauseTaskInput(val: unknown, path = 'pause'): ValidationResult<PauseTaskInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be object`, code: 'INVALID_TYPE' }] };
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) errors.push({ path: `${path}.taskId`, message: 'taskId required', code: 'INVALID_TASK_ID' });
  if (typeof val.expectedRevision !== 'number' || val.expectedRevision < 1) errors.push({ path: `${path}.expectedRevision`, message: 'expectedRevision >= 1', code: 'INVALID_REVISION' });
  if (typeof val.pauseKey !== 'string' || !val.pauseKey.trim()) errors.push({ path: `${path}.pauseKey`, message: 'pauseKey required', code: 'INVALID_PAUSE_KEY' });
  if (typeof val.operatorRef !== 'string' || !val.operatorRef.trim()) errors.push({ path: `${path}.operatorRef`, message: 'operatorRef required', code: 'INVALID_OPERATOR_REF' });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as PauseTaskInput };
}

export function validateResumeTaskInput(val: unknown, path = 'resume'): ValidationResult<ResumeTaskInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be object`, code: 'INVALID_TYPE' }] };
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) errors.push({ path: `${path}.taskId`, message: 'taskId required', code: 'INVALID_TASK_ID' });
  if (typeof val.expectedRevision !== 'number' || val.expectedRevision < 1) errors.push({ path: `${path}.expectedRevision`, message: 'expectedRevision >= 1', code: 'INVALID_REVISION' });
  if (typeof val.resumeKey !== 'string' || !val.resumeKey.trim()) errors.push({ path: `${path}.resumeKey`, message: 'resumeKey required', code: 'INVALID_RESUME_KEY' });
  if (typeof val.operatorRef !== 'string' || !val.operatorRef.trim()) errors.push({ path: `${path}.operatorRef`, message: 'operatorRef required', code: 'INVALID_OPERATOR_REF' });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as ResumeTaskInput };
}

export function validateRecordAndSettleInput(val: unknown, path = 'settle'): ValidationResult<RecordAndSettleInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be object`, code: 'INVALID_TYPE' }] };
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) errors.push({ path: `${path}.taskId`, message: 'taskId required', code: 'INVALID_TASK_ID' });
  if (typeof val.runId !== 'string' || !val.runId.trim()) errors.push({ path: `${path}.runId`, message: 'runId required', code: 'INVALID_RUN_ID' });
  if (typeof val.claimId !== 'string' || !val.claimId.trim()) errors.push({ path: `${path}.claimId`, message: 'claimId required', code: 'INVALID_CLAIM_ID' });
  if (typeof val.requestId !== 'string' || !val.requestId.trim()) errors.push({ path: `${path}.requestId`, message: 'requestId required', code: 'INVALID_REQUEST_ID' });
  if (!['success', 'failure', 'uncertain'].includes(val.observedOutcome as string)) {
    errors.push({ path: `${path}.observedOutcome`, message: 'outcome must be success, failure, or uncertain', code: 'INVALID_OUTCOME' });
  }
  if (!isObject(val.observedUsage)) {
    errors.push({ path: `${path}.observedUsage`, message: 'observedUsage required', code: 'INVALID_USAGE' });
  }
  if (!Array.isArray(val.evidenceRefs)) errors.push({ path: `${path}.evidenceRefs`, message: 'evidenceRefs must be array', code: 'INVALID_REFS' });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as RecordAndSettleInput };
}

export function validateRecoverTaskInput(val: unknown, path = 'recover'): ValidationResult<RecoverTaskInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be object`, code: 'INVALID_TYPE' }] };
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) errors.push({ path: `${path}.taskId`, message: 'taskId required', code: 'INVALID_TASK_ID' });
  if (typeof val.newRunId !== 'string' || !val.newRunId.trim()) errors.push({ path: `${path}.newRunId`, message: 'newRunId required', code: 'INVALID_RUN_ID' });
  const wsRes = validateWorkspaceBaseline(val.repoEvidence, `${path}.repoEvidence`);
  if (!wsRes.ok) errors.push(...wsRes.errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as RecoverTaskInput };
}
