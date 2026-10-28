import { computeCanonicalSha256 } from '../identity.ts';
import { parseApprovalBinding } from '../v01/validation/intake/actions.ts';
import type {
  RecordVerificationApprovalRequestV02,
  VerificationApprovalResolutionV02,
  VerificationApprovalContextV02,
  VerificationAuthoritySnapshotV02,
  VerificationPolicyIdentityV02,
} from './verification-authority.ts';

const CONTEXT_KEYS = ['purpose', 'expectedIssuerKeyRef', 'expectedDecisionAuthorityGeneration', 'approvalContext'] as const;
const APPROVAL_CONTEXT_KEYS = [
  'currentTaskId', 'currentWorkspaceId', 'currentRepositoryRevisionDigest', 'currentPolicyId',
  'currentPolicyVersion', 'currentNormalizedActionDigest', 'currentPlanVersion', 'currentStrategyDigest',
  'currentBaselineRef', 'currentEvidenceRefs', 'currentCriteriaDigest', 'currentCheckSetDigest',
] as const;
const POLICY_KEYS = ['policyId', 'policyVersion', 'configId', 'configVersion', 'issuerKeyRef'] as const;
const REQUEST_KEYS = [
  'taskId', 'runId', 'workspaceId', 'repositoryId', 'originalDecisionId', 'decisionId',
  'expectedStateVersion', 'expectedRepositoryRevisionDigest', 'expectedPlanVersion',
  'expectedPlanMaterialDigest', 'expectedControlVersion', 'expectedEpoch',
  'expectedDecisionAuthorityGeneration', 'policyIdentity', 'requestIdentity',
] as const;

function plainRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
  } catch { return false; }
}

function safeIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function safeVersion(value: unknown, allowZero = false): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1);
}

export function isVerificationPolicyIdentityV02(value: unknown): value is VerificationPolicyIdentityV02 {
  try { return plainRecord(value, POLICY_KEYS) && POLICY_KEYS.every((key) => safeIdentity(value[key])); }
  catch { return false; }
}

export function isVerificationApprovalContextV02(value: unknown): value is VerificationApprovalContextV02 {
  try {
    if (!plainRecord(value, CONTEXT_KEYS) || (value['purpose'] !== 'historical-patch' && value['purpose'] !== 'current-verification') ||
        !safeIdentity(value['expectedIssuerKeyRef']) || !safeVersion(value['expectedDecisionAuthorityGeneration'])) return false;
    const context = value['approvalContext'];
    if (!plainRecord(context, APPROVAL_CONTEXT_KEYS)) return false;
    return safeIdentity(context['currentTaskId']) && safeIdentity(context['currentWorkspaceId']) &&
      digest(context['currentRepositoryRevisionDigest']) && safeIdentity(context['currentPolicyId']) &&
      safeIdentity(context['currentPolicyVersion']) && digest(context['currentNormalizedActionDigest']) &&
      safeVersion(context['currentPlanVersion'], true) && digest(context['currentStrategyDigest']) &&
      safeIdentity(context['currentBaselineRef']) && Array.isArray(context['currentEvidenceRefs']) &&
      context['currentEvidenceRefs'].every((entry: unknown) => safeIdentity(entry)) && digest(context['currentCriteriaDigest']) && digest(context['currentCheckSetDigest']);
  } catch { return false; }
}

export function expectedVerificationRequestIdentityV02(
  request: Pick<RecordVerificationApprovalRequestV02,
    'taskId' | 'runId' | 'originalDecisionId' | 'expectedPlanMaterialDigest' | 'expectedRepositoryRevisionDigest' | 'policyIdentity'>,
): string {
  return computeCanonicalSha256({
    purpose: 'post-patch-verification-approval',
    taskId: request.taskId,
    runId: request.runId,
    originalDecisionId: request.originalDecisionId,
    expectedPlanMaterialDigest: request.expectedPlanMaterialDigest,
    settledRepositoryRevisionDigest: request.expectedRepositoryRevisionDigest,
    policyIdentity: request.policyIdentity,
  });
}

export function isRecordVerificationApprovalRequestV02(value: unknown): value is RecordVerificationApprovalRequestV02 {
  try {
    if (!plainRecord(value, REQUEST_KEYS) || !REQUEST_KEYS.every((key) => value[key] !== undefined)) return false;
    const taskId = value['taskId'], runId = value['runId'], workspaceId = value['workspaceId'], repositoryId = value['repositoryId'];
    const originalDecisionId = value['originalDecisionId'], decisionId = value['decisionId'];
    const expectedRepositoryRevisionDigest = value['expectedRepositoryRevisionDigest'];
    const expectedPlanMaterialDigest = value['expectedPlanMaterialDigest'];
    const requestIdentity = value['requestIdentity'], policyIdentity = value['policyIdentity'];
    if (!safeIdentity(taskId) || !safeIdentity(runId) || !safeIdentity(workspaceId) || !safeIdentity(repositoryId) ||
        !safeIdentity(originalDecisionId) || !safeIdentity(decisionId) || !digest(expectedRepositoryRevisionDigest) ||
        !digest(expectedPlanMaterialDigest) || !digest(requestIdentity) ||
        !safeVersion(value['expectedStateVersion'], true) || !safeVersion(value['expectedPlanVersion']) ||
        !safeVersion(value['expectedControlVersion'], true) || !safeVersion(value['expectedEpoch'], true) ||
        !safeVersion(value['expectedDecisionAuthorityGeneration']) || !isVerificationPolicyIdentityV02(policyIdentity) ||
        decisionId === originalDecisionId) return false;
    const expected = expectedVerificationRequestIdentityV02({
      taskId, runId, originalDecisionId, expectedPlanMaterialDigest, expectedRepositoryRevisionDigest, policyIdentity,
    });
    return decisionId === `dec-verify-${expected.slice('sha256:'.length)}` && requestIdentity === expected;
  } catch { return false; }
}

export function isVerificationAuthoritySnapshotV02(value: unknown): value is VerificationAuthoritySnapshotV02 {
  try {
    const keys = ['taskId', 'runId', 'stateVersion', 'repositoryRevisionDigest', 'controlVersion', 'epoch', 'decisionAuthorityGeneration', 'policyIdentity', 'controlMode', 'holdRef', 'activeClaimId'] as const;
    return plainRecord(value, keys) && safeIdentity(value['taskId']) && safeIdentity(value['runId']) &&
      safeVersion(value['stateVersion'], true) && digest(value['repositoryRevisionDigest']) &&
      safeVersion(value['controlVersion'], true) && safeVersion(value['epoch'], true) &&
      safeVersion(value['decisionAuthorityGeneration']) && isVerificationPolicyIdentityV02(value['policyIdentity']) &&
      safeIdentity(value['controlMode']) && (value['holdRef'] === null || safeIdentity(value['holdRef'])) &&
      (value['activeClaimId'] === null || safeIdentity(value['activeClaimId']));
  } catch { return false; }
}

export function isVerificationApprovalResolutionV02(value: unknown): value is VerificationApprovalResolutionV02 {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const outcome = Object.getOwnPropertyDescriptor(value, 'outcome');
    if (!outcome || !('value' in outcome)) return false;
    if (outcome.value === 'resolved') {
      const keys = ['outcome', 'decisionId', 'binding', 'issuerKeyRef', 'decisionAuthorityGeneration', 'contextDigest'] as const;
      if (!plainRecord(value, keys)) return false;
      const parsed = parseApprovalBinding(value['binding']);
      return parsed.ok && safeIdentity(value['decisionId']) && parsed.value.decisionId === value['decisionId'] &&
        safeIdentity(value['issuerKeyRef']) && safeVersion(value['decisionAuthorityGeneration']) && digest(value['contextDigest']);
    }
    if (outcome.value === 'unavailable' || outcome.value === 'denied' || outcome.value === 'stale') {
      const keys = ['outcome', 'reasonCode'] as const;
      return plainRecord(value, keys) && safeIdentity(value['reasonCode']);
    }
    return false;
  } catch { return false; }
}
