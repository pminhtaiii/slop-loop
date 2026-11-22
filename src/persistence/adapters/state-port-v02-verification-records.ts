/**
 * Shared reads and records for the durable verification-approval authority
 * (`state-port-v02-verification-authority.ts`). They are split out only to keep each file within
 * the source-size budget; they hold no authority and perform no write except the decision-binding
 * record the owner itself issues when it consumes a human decision.
 *
 * Two rules keep this file honest:
 * - A persisted resolution is used only after the same validation the UC-05 reader applies: the
 *   terminal row, the trusted operator channel, the request version, and the committed journal event.
 * - A persisted decision is bound to the owner authority and generation that consumed it, so an
 *   advanced generation cannot re-label the old record as current.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { computeCanonicalSha256 } from '../../contracts/foundation/uc03.ts';
import type {
  ApprovalBinding,
  CompleteApprovalBindingContextV02,
  PolicyAuthorityRefV02,
  TaskState,
  VerificationApprovalContextV02,
  VerificationPolicyIdentityV02,
} from '../../contracts/foundation/uc03.ts';
import type { ApprovalRequestRecord, HumanResolution, TrustedOperatorIdentity } from '../../contracts/approvals/contracts.ts';
import { validateApprovalRequestRecord, validateHumanResolution } from '../../contracts/approvals/contracts.ts';
import { readEvents } from './approval-events.ts';
import { decisionDir, taskDir } from './approval-types.ts';
import { readSettledPatchAncestry } from './state-port-v02-journal.ts';
import type { StatePortStore } from './state-port-v02-storage.ts';
import type { ControlRecordV02 } from './state-port-v02-types.ts';

const DECISION_BINDINGS_FILE = 'verification-decisions.json';
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function requestRecord(approvalStorageDir: string, decisionId: string): ApprovalRequestRecord | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(decisionId)) return null;
  const checked = validateApprovalRequestRecord(readJson<unknown>(join(decisionDir(approvalStorageDir, decisionId), 'request.json')));
  return checked.ok ? checked.value : null;
}

function dataRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * The recorded terminal resolution for `decisionId`: `absent` when the history has no row for it,
 * `invalid` when any row fails the UC-05 validation (a malformed row fails closed), and `recorded`
 * only for a fully validated row whose committed journal event agrees. Every history row is checked
 * before any row is selected, exactly as `readApprovalResolution` does.
 */
export type RecordedResolutionV02 = { readonly status: 'absent' } | { readonly status: 'invalid' } | { readonly status: 'recorded'; readonly resolution: HumanResolution };

export function recordedResolution(approvalStorageDir: string, taskId: string, decisionId: string, operator: TrustedOperatorIdentity | undefined): RecordedResolutionV02 {
  if (!operator) return { status: 'invalid' };
  const history = readJson<unknown>(join(taskDir(approvalStorageDir, taskId), 'history.json'));
  if (history === null) return { status: 'absent' };
  if (!dataRecord(history)) return { status: 'invalid' };
  const rows = history['resolutions'];
  if (!Array.isArray(rows) || rows.length > 128) return { status: 'invalid' };
  const events = readEvents(approvalStorageDir, taskId);
  if (events.safe.outcome !== 'ok' || !Array.isArray(events.value)) return { status: 'invalid' };
  const unique = new Set<string>();
  let selected: HumanResolution | undefined;
  for (const row of rows) {
    if (!dataRecord(row) || typeof row['decisionId'] !== 'string' || unique.has(row['decisionId'])) return { status: 'invalid' };
    unique.add(row['decisionId']);
    const record = requestRecord(approvalStorageDir, row['decisionId']);
    if (!record) return { status: 'invalid' };
    const checked = validateHumanResolution(row, { expectedDecisionId: record.decisionId, expectedRequestVersion: record.requestVersion, trustedOperator: operator });
    if (!checked.ok) return { status: 'invalid' };
    const resolution = checked.value;
    const event = events.value.find(entry => entry.eventId === resolution.eventId);
    if (
      !event ||
      event.type !== 'human-resolution-recorded' ||
      event.decisionId !== resolution.decisionId ||
      event.claimId !== null ||
      event.directionId !== null ||
      event.timestamp !== resolution.decidedAt ||
      event.safeReasonCode !== resolution.safeReasonCode ||
      event.outcome !== (resolution.decision === 'approved' ? 'ok' : 'paused') ||
      !isDeepStrictEqual(event.policyRef, { policyId: record.policyId, policyVersion: record.policyVersion, configId: record.configId, configVersion: record.configVersion })
    )
      return { status: 'invalid' };
    if (resolution.decisionId === decisionId) selected = resolution;
  }
  return selected ? { status: 'recorded', resolution: selected } : { status: 'absent' };
}

export function bindingMatchesContext(binding: ApprovalBinding, context: CompleteApprovalBindingContextV02): boolean {
  return (
    binding.actionKind === 'fix_plan' &&
    binding.taskId === context.currentTaskId &&
    binding.workspaceId === context.currentWorkspaceId &&
    binding.repositoryRevisionDigest === context.currentRepositoryRevisionDigest &&
    binding.policyId === context.currentPolicyId &&
    binding.policyVersion === context.currentPolicyVersion &&
    binding.normalizedActionDigest === context.currentNormalizedActionDigest &&
    binding.planVersion === context.currentPlanVersion &&
    binding.strategyDigest === context.currentStrategyDigest &&
    binding.baselineRef === context.currentBaselineRef &&
    computeCanonicalSha256(binding.evidenceRefs ?? []) === computeCanonicalSha256(context.currentEvidenceRefs) &&
    binding.criteriaDigest === context.currentCriteriaDigest &&
    binding.checkSetDigest === context.currentCheckSetDigest
  );
}

export function policyIdentityOf(authority: PolicyAuthorityRefV02): VerificationPolicyIdentityV02 {
  return { policyId: authority.policyId, policyVersion: authority.policyVersion, configId: authority.configId, configVersion: authority.configVersion, issuerKeyRef: authority.issuerKeyRef };
}

/** The exact context a plan decision is re-issued in; same fields as `createVerificationApprovalContext`. */
export function approvalContextOf(decisionId: string, plan: NonNullable<TaskState['plan']>, task: TaskState, authority: PolicyAuthorityRefV02): VerificationApprovalContextV02 {
  return verificationContextOf(decisionId, plan, task, authority, 'current-verification');
}

/** The owner-derived context for either purpose; the historical branch reuses the same fields. */
export function verificationContextOf(
  decisionId: string,
  plan: NonNullable<TaskState['plan']>,
  task: TaskState,
  authority: PolicyAuthorityRefV02,
  purpose: VerificationApprovalContextV02['purpose'],
): VerificationApprovalContextV02 {
  const action = {
    actionId: decisionId,
    kind: 'approve_fix_plan' as const,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    diagnosisEvidenceRefs: plan.evidenceRefs,
    checkSetDigest: plan.checkSetDigest,
  };
  return {
    purpose,
    expectedIssuerKeyRef: authority.issuerKeyRef,
    expectedDecisionAuthorityGeneration: authority.decisionAuthorityGeneration,
    approvalContext: {
      currentTaskId: task.taskId,
      currentWorkspaceId: task.workspaceId,
      currentRepositoryRevisionDigest: task.repositoryRevisionDigest,
      currentPolicyId: authority.policyId,
      currentPolicyVersion: authority.policyVersion,
      currentNormalizedActionDigest: computeCanonicalSha256(action),
      currentPlanVersion: plan.planVersion,
      currentStrategyDigest: plan.strategyDigest,
      currentBaselineRef: plan.baselineRef,
      currentEvidenceRefs: [...plan.evidenceRefs],
      currentCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
      currentCheckSetDigest: plan.checkSetDigest,
    },
  };
}

export function planMaterialDigest(task: TaskState): string {
  const plan = task.plan;
  if (!plan) return '';
  return computeCanonicalSha256({
    taskId: task.taskId,
    planVersion: plan.planVersion,
    diagnosis: plan.diagnosis,
    suspectedCauseLocations: plan.suspectedCauseLocations,
    evidenceRefs: plan.evidenceRefs,
    strategy: plan.strategy,
    scopedChanges: plan.scopedChanges,
    checkSetDigest: plan.checkSetDigest,
    baselineRef: plan.baselineRef,
    strategyDigest: plan.strategyDigest,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
  });
}

/** The authority the validated head carries; `null` fails closed exactly as `readVerificationAuthoritySnapshot`. */
export function authorityOf(control: ControlRecordV02): PolicyAuthorityRefV02 | null {
  const authority = control.activeAuthorityRef;
  if (!authority) return null;
  if (![authority.policyId, authority.policyVersion, authority.configId, authority.configVersion, authority.issuerKeyRef].every(value => typeof value === 'string' && value.trim().length > 0))
    return null;
  if (!Number.isSafeInteger(authority.decisionAuthorityGeneration) || authority.decisionAuthorityGeneration <= 0) return null;
  return authority;
}

/** The control-event digest `setTaskControl` writes, so a rejection hold is the same durable fact. */
export function holdEventDigest(control: ControlRecordV02, task: TaskState, holdRef: string): string {
  return computeCanonicalSha256({
    schemaVersion: 'uc04-control-event/0.2-draft',
    taskId: task.taskId,
    runId: task.runId,
    taskStateVersion: task.stateVersion,
    eventKind: 'denial',
    mode: 'rejected',
    eventRef: holdRef,
    controlVersion: control.controlVersion + 1,
    epoch: control.epoch,
  });
}

export function rejectionHoldRef(requestIdentity: string): string {
  return `verification-rejected-${requestIdentity.slice('sha256:'.length)}`;
}

/** `current-verification` resolves only while the head is pre-rebind or already rebound to this decision. */
export function currentVerificationMatches(task: TaskState, decisionId: string): boolean {
  if (!task.plan) return false;
  const pendingBeforeRebind = task.node === 'Verify' && task.activeDecisionId === undefined;
  const currentPointer = task.plan.decisionRef === decisionId && (task.activeDecisionId === undefined || task.activeDecisionId === decisionId);
  return pendingBeforeRebind || currentPointer;
}

/** A decision's identity, independent of its terminal status and reason. */
export function bindingIdentityDigest(binding: ApprovalBinding): string {
  const identity: Record<string, unknown> = { ...binding };
  delete identity['status'];
  delete identity['reason'];
  return computeCanonicalSha256(identity);
}

/** The owner authority and generation that consumed one persisted human decision. */
export interface IssuedDecisionBindingV02 {
  readonly decisionId: string;
  readonly issuerKeyRef: string;
  readonly decisionAuthorityGeneration: number;
  readonly bindingDigest: string;
}

/** Every bound decision, or `null` when the file is present but malformed or parsed null (fail closed). */
export function readDecisionBindings(store: StatePortStore, taskId: string): ReadonlyMap<string, IssuedDecisionBindingV02> | null {
  if (!SAFE_TASK_ID.test(taskId)) return null;
  const filePath = store.statePath(taskId, DECISION_BINDINGS_FILE);
  if (!existsSync(filePath)) return new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (raw === null || !dataRecord(raw) || raw['schemaVersion'] !== 1 || !Array.isArray(raw['decisions'])) return null;
  const bindings = new Map<string, IssuedDecisionBindingV02>();
  for (const row of raw['decisions']) {
    if (!dataRecord(row)) return null;
    const { decisionId, issuerKeyRef, decisionAuthorityGeneration, bindingDigest } = row;
    if (typeof decisionId !== 'string' || typeof issuerKeyRef !== 'string') return null;
    if (!Number.isSafeInteger(decisionAuthorityGeneration) || (decisionAuthorityGeneration as number) <= 0) return null;
    if (typeof bindingDigest !== 'string' || !SHA256.test(bindingDigest) || bindings.has(decisionId)) return null;
    bindings.set(decisionId, { decisionId, issuerKeyRef, decisionAuthorityGeneration: decisionAuthorityGeneration as number, bindingDigest });
  }
  return bindings;
}

/**
 * Binds one consumed decision to the owner authority/generation that issued it. An identical replay
 * is a no-op; a different binding under the same decision id, or an unreadable record, refuses.
 */
export async function bindIssuedDecision(store: StatePortStore, taskId: string, binding: IssuedDecisionBindingV02): Promise<boolean> {
  const bindings = readDecisionBindings(store, taskId);
  if (!bindings) return false;
  const prior = bindings.get(binding.decisionId);
  if (prior) {
    return prior.issuerKeyRef === binding.issuerKeyRef && prior.decisionAuthorityGeneration === binding.decisionAuthorityGeneration && prior.bindingDigest === binding.bindingDigest;
  }
  const decisions = [...bindings.values(), binding].sort((left, right) => (left.decisionId < right.decisionId ? -1 : left.decisionId > right.decisionId ? 1 : 0));
  await store.writeJson(store.statePath(taskId, DECISION_BINDINGS_FILE), { schemaVersion: 1, decisions });
  return true;
}

/** Read one issued decision binding from the durable owner record, or null when absent or malformed. */
export function readIssuedDecisionBinding(store: StatePortStore, taskId: string, decisionId: string): IssuedDecisionBindingV02 | null {
  return readDecisionBindings(store, taskId)?.get(decisionId) ?? null;
}

/** Whether the persisted binding for `decisionId` names the same authority, generation and identity. */
export function issuedBindingMatches(store: StatePortStore, taskId: string, decisionId: string, issuerKeyRef: string, generation: number, binding: ApprovalBinding): boolean {
  const bindings = readDecisionBindings(store, taskId);
  const issued = bindings?.get(decisionId);
  return !!issued && issued.issuerKeyRef === issuerKeyRef && issued.decisionAuthorityGeneration === generation && issued.bindingDigest === bindingIdentityDigest(binding);
}

/** Compare the request's full policy identity (policyId, policyVersion, configId, configVersion, issuerKeyRef) with the authority. */
export function requestMatchesAuthority(record: ApprovalRequestRecord, authority: PolicyAuthorityRefV02): boolean {
  if (record.policyId !== authority.policyId || record.policyVersion !== authority.policyVersion || record.configId !== authority.configId || record.configVersion !== authority.configVersion) {
    return false;
  }
  const issuerKeyRef = (record as { issuerKeyRef?: unknown })['issuerKeyRef'];
  if (typeof issuerKeyRef === 'string' && issuerKeyRef !== authority.issuerKeyRef) {
    return false;
  }
  return true;
}

/**
 * The complete owner-derived context for one decision: the current head and plan for a current
 * verification, or the plan and authority the one settled approved-plan patch ran under for the
 * historical branch.
 */
const HISTORICAL_PATCH_NODES: ReadonlySet<string> = new Set(['Verify', 'Review', 'Deliver', 'Repair']);

export async function ownerContext(
  store: StatePortStore,
  taskId: string,
  decisionId: string,
  purpose: VerificationApprovalContextV02['purpose'],
  controlFallback: ControlRecordV02,
): Promise<{ readonly authority: PolicyAuthorityRefV02; readonly context: VerificationApprovalContextV02 } | null> {
  const task = await store.readTask(taskId);
  if (purpose === 'historical-patch') {
    // The historical branch also serves the post-verification nodes that still name this patch.
    if (!task || !HISTORICAL_PATCH_NODES.has(task.node)) return null;
    const ancestry = await readSettledPatchAncestry(store, { taskId, runId: task.runId, resultingRepositoryRevisionDigest: task.repositoryRevisionDigest });
    const original = ancestry?.originalTaskState;
    const authority = ancestry?.originalAuthorityRef;
    if (!original?.plan || !authority || original.plan.decisionRef !== decisionId) return null;
    return { authority, context: verificationContextOf(decisionId, original.plan, original, authority, 'historical-patch') };
  }
  const control = await store.readControl(taskId, controlFallback);
  const authority = authorityOf(control);
  if (!task || !authority || !currentVerificationMatches(task, decisionId) || !task.plan) return null;
  return { authority, context: approvalContextOf(decisionId, task.plan, task, authority) };
}
