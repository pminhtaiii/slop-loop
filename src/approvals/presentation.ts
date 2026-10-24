import type { ApprovalBinding, ApprovalBindingContext, NormalizedAction, ProviderRequest } from '../contracts/foundation/uc03.ts';
import type { PolicyProfile, ProviderRole, SafePresentation } from '../contracts/approvals/contracts.ts';
import { UC05_APPROVAL_SCHEMA_VERSION_V02 } from '../contracts/approvals/contracts.ts';
import { computeActionDigest, computeCanonicalSha256, computeRequestContentDigest, validateApprovalBinding, validateNormalizedAction, validateProviderRequest } from '../contracts/foundation/uc03.ts';
import { validatePolicyProfile, validateSafePresentation } from '../contracts/approvals/contracts.ts';
import { containsProtectedContent } from '../foundation/repository-tools.ts';
import { isBoundedSafeDataV02, validateSafePresentationV02 } from './presentation-v02-validation.ts';
import type { PresentationBundleV02, PresentationInputV02, SafePresentationV02 } from './presentation-v02-validation.ts';

export { isBoundedSafeDataV02, validateSafePresentationV02 } from './presentation-v02-validation.ts';
export type { PresentationSubjectKindV02, PresentationPlanApplicabilityV02, SafePresentationV02Base, SafePresentationV02RepositoryActionPrePlan, SafePresentationV02RepositoryActionApprovedPlan, SafePresentationV02ProviderRequestPrePlan, SafePresentationV02ProviderRequestApprovedPlan, SafePresentationV02, PresentationBundleV02, PresentationInputV02Base, PresentationInputV02RepositoryActionPrePlan, PresentationInputV02RepositoryActionApprovedPlan, PresentationInputV02ProviderRequestPrePlan, PresentationInputV02ProviderRequestApprovedPlan, PresentationInputV02 } from './presentation-v02-validation.ts';

export interface PresentationInput {
  readonly requestVersion: number;
  readonly binding: ApprovalBinding;
  readonly freshness: ApprovalBindingContext;
  readonly action: NormalizedAction;
  readonly repositoryId: string;
  readonly continuationRef: string;
  readonly policyIdentity: PolicyProfile['policyIdentity'];
  readonly elements: SafePresentation['elements'];
}
export interface PresentationBundle {
  readonly summary: SafePresentation;
  readonly pages: readonly string[];
}
export function buildPresentation(input: PresentationInput, profile: PolicyProfile): PresentationBundle {
  try { return admittedPresentation(input, profile); }
  catch { throw new Error('unsafe-presentation'); }
}

export function buildPresentationCompatibilityV01(input: PresentationInput, profile: PolicyProfile): PresentationBundle {
  return buildPresentation(input, profile);
}


export function buildPresentationV02(input: PresentationInputV02, profile: PolicyProfile): PresentationBundleV02 {
  if (!isBoundedSafeDataV02(input) || !Number.isSafeInteger(input.requestVersion) || input.requestVersion < 1) {
    throw new Error('unsafe-presentation');
  }
  if (!validatePolicyProfile(profile).ok) {
    throw new Error('unsafe-presentation');
  }

  const raw = input as unknown as Record<string, unknown>;
  if (raw['schemaVersion'] !== undefined && raw['schemaVersion'] !== UC05_APPROVAL_SCHEMA_VERSION_V02) {
    throw new Error('unsafe-presentation');
  }

  const subjectKind = raw['subjectKind'];
  const planApplicability = raw['planApplicability'];

  if (subjectKind !== 'repository-action' && subjectKind !== 'provider-request') {
    throw new Error('unsafe-presentation');
  }
  if (planApplicability !== 'pre-plan-diagnostic' && planApplicability !== 'approved-plan') {
    throw new Error('unsafe-presentation');
  }

  if (subjectKind === 'repository-action') {
    if (raw['providerRequestId'] !== undefined || raw['role'] !== undefined || raw['providerRequest'] !== undefined || raw['requestContentDigest'] !== undefined) {
      throw new Error('unsafe-presentation');
    }
  } else {
    if (raw['actionId'] !== undefined || raw['actionDigest'] !== undefined || raw['action'] !== undefined) {
      throw new Error('unsafe-presentation');
    }
  }

  if (planApplicability === 'pre-plan-diagnostic') {
    if (raw['planBindingDigest'] !== undefined || raw['planDecisionRef'] !== undefined) {
      throw new Error('unsafe-presentation');
    }
  } else {
    if (raw['diagnosticPurpose'] !== undefined || raw['taskCriteriaDigest'] !== undefined) {
      throw new Error('unsafe-presentation');
    }
  }

  let actionId = '';
  let actionDigest = '';
  let providerRequestId = '';
  let requestContentDigest = '';
  let role: ProviderRole | undefined;
  let details = '';

  if (subjectKind === 'repository-action') {
    const action = raw['action'] as NormalizedAction | undefined;
    if (!action || !validateNormalizedAction(action).ok) throw new Error('unsafe-presentation');
    actionId = action.actionId;
    actionDigest = computeActionDigest(action);
    details = JSON.stringify(action);
  } else {
    const provReq = raw['providerRequest'] as ProviderRequest | undefined;
    const validatedRequest = validateProviderRequest(provReq);
    if (!validatedRequest.ok) {
      throw new Error('unsafe-presentation');
    }
    providerRequestId = validatedRequest.value.providerRequestId;
    role = validatedRequest.value.role;
    requestContentDigest = computeRequestContentDigest(validatedRequest.value);
    details = JSON.stringify(validatedRequest.value);
  }

  let diagnosticPurpose: string | undefined;
  let taskCriteriaDigest: string | undefined;
  let planBindingDigest: string | undefined;
  let planDecisionRef: string | undefined;

  if (planApplicability === 'pre-plan-diagnostic') {
    if (typeof raw['diagnosticPurpose'] !== 'string' || !raw['diagnosticPurpose']) throw new Error('unsafe-presentation');
    if (typeof raw['taskCriteriaDigest'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(raw['taskCriteriaDigest'])) throw new Error('unsafe-presentation');
    diagnosticPurpose = raw['diagnosticPurpose'];
    taskCriteriaDigest = raw['taskCriteriaDigest'];
  } else {
    if (typeof raw['planBindingDigest'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(raw['planBindingDigest'])) throw new Error('unsafe-presentation');
    if (typeof raw['planDecisionRef'] !== 'string' || !raw['planDecisionRef']) throw new Error('unsafe-presentation');
    planBindingDigest = raw['planBindingDigest'];
    planDecisionRef = raw['planDecisionRef'];
  }

  const content = JSON.stringify(input);
  if (containsProtectedContent(content)) throw new Error('unsafe-presentation');

  const elementBytes = Buffer.byteLength(JSON.stringify(input.elements));
  const totalBytes = Buffer.byteLength(details) + elementBytes;
  if (totalBytes > profile.maxPresentationTotalBytes) throw new Error('unsafe-presentation');

  const pages: string[] = [];
  let page = '';
  for (const point of details) {
    if (Buffer.byteLength(page + point) > profile.maxPresentationPageBytes) { pages.push(page); page = ''; }
    if (Buffer.byteLength(point) > profile.maxPresentationPageBytes) throw new Error('unsafe-presentation');
    page += point;
  }
  if (page) pages.push(page);
  if (pages.length > profile.maxPresentationPages) throw new Error('unsafe-presentation');

  const bindingFingerprintObj = subjectKind === 'repository-action'
    ? {
        subjectKind,
        planApplicability,
        actionId,
        actionDigest,
        repositoryId: input.repositoryId,
        continuationRef: input.continuationRef,
        policyIdentity: input.policyIdentity,
        requestVersion: input.requestVersion,
        ...(planApplicability === 'pre-plan-diagnostic' ? { diagnosticPurpose, taskCriteriaDigest } : { planBindingDigest, planDecisionRef }),
      }
    : {
        subjectKind,
        planApplicability,
        providerRequestId,
        requestContentDigest,
        role,
        repositoryId: input.repositoryId,
        continuationRef: input.continuationRef,
        policyIdentity: input.policyIdentity,
        requestVersion: input.requestVersion,
        ...(planApplicability === 'pre-plan-diagnostic' ? { diagnosticPurpose, taskCriteriaDigest } : { planBindingDigest, planDecisionRef }),
      };

  const bindingFingerprint = computeCanonicalSha256(bindingFingerprintObj);
  const presentationDigest = computeCanonicalSha256({ bindingFingerprint, elements: input.elements, details });

  const baseSummary = {
    schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
    decisionId: input.decisionId,
    requestVersion: input.requestVersion,
    bindingFingerprint,
    elements: structuredClone(input.elements),
    inspectionRef: input.decisionId,
    presentationDigest,
    page: {
      pageNumber: 1,
      pageCount: pages.length,
      pageBytes: Math.max(elementBytes, Buffer.byteLength(pages[0] ?? '')),
      totalBytes,
      truncated: false,
    },
  };

  let summary: SafePresentationV02;
  if (subjectKind === 'repository-action') {
    if (planApplicability === 'pre-plan-diagnostic') {
      if (!diagnosticPurpose || !taskCriteriaDigest) throw new Error('unsafe-presentation');
      summary = { ...baseSummary, subjectKind: 'repository-action', planApplicability: 'pre-plan-diagnostic', actionId, actionDigest, diagnosticPurpose, taskCriteriaDigest };
    } else {
      if (!planBindingDigest || !planDecisionRef) throw new Error('unsafe-presentation');
      summary = { ...baseSummary, subjectKind: 'repository-action', planApplicability: 'approved-plan', actionId, actionDigest, planBindingDigest, planDecisionRef };
    }
  } else {
    if (!role) throw new Error('unsafe-presentation');
    if (planApplicability === 'pre-plan-diagnostic') {
      if (!diagnosticPurpose || !taskCriteriaDigest) throw new Error('unsafe-presentation');
      summary = { ...baseSummary, subjectKind: 'provider-request', planApplicability: 'pre-plan-diagnostic', providerRequestId, requestContentDigest, role, diagnosticPurpose, taskCriteriaDigest };
    } else {
      if (!planBindingDigest || !planDecisionRef) throw new Error('unsafe-presentation');
      summary = { ...baseSummary, subjectKind: 'provider-request', planApplicability: 'approved-plan', providerRequestId, requestContentDigest, role, planBindingDigest, planDecisionRef };
    }
  }

  const validation = validateSafePresentationV02(summary, profile);
  if (!validation.ok) throw new Error('unsafe-presentation');

  return { summary, pages };
}


function admittedPresentation(input: PresentationInput, profile: PolicyProfile): PresentationBundle {
  if (!isBoundedSafeDataV02(input) || !Number.isSafeInteger(input.requestVersion) || input.requestVersion < 1) throw new Error('unsafe-presentation');
  if (!validatePolicyProfile(profile).ok || !validateNormalizedAction(input.action).ok ||
    !validateApprovalBinding({ ...input.binding, status: 'approved' }, input.freshness).ok ||
    computeActionDigest(input.action) !== input.binding.normalizedActionDigest) throw new Error('unsafe-presentation');
  const details = JSON.stringify(input.action);
  const content = JSON.stringify(input);
  if (containsProtectedContent(content)) throw new Error('unsafe-presentation');
  const elementBytes = Buffer.byteLength(JSON.stringify(input.elements));
  const totalBytes = Buffer.byteLength(details) + elementBytes;
  if (totalBytes > profile.maxPresentationTotalBytes) throw new Error('unsafe-presentation');
  const pages: string[] = [];
  let page = '';
  for (const point of details) {
    if (Buffer.byteLength(page + point) > profile.maxPresentationPageBytes) { pages.push(page); page = ''; }
    if (Buffer.byteLength(point) > profile.maxPresentationPageBytes) throw new Error('unsafe-presentation');
    page += point;
  }
  if (page) pages.push(page);
  if (pages.length > profile.maxPresentationPages) throw new Error('unsafe-presentation');
  const bindingFingerprint = computeCanonicalSha256({ binding: input.binding, freshness: input.freshness, repositoryId: input.repositoryId, continuationRef: input.continuationRef, policyIdentity: input.policyIdentity, requestVersion: input.requestVersion });
  const summary: SafePresentation = {
    schemaVersion: 'uc05-approval/0.1-draft', decisionId: input.binding.decisionId, requestVersion: input.requestVersion,
    bindingFingerprint, elements: structuredClone(input.elements), inspectionRef: input.binding.decisionId,
    presentationDigest: computeCanonicalSha256({ bindingFingerprint, elements: input.elements, details }),
    page: { pageNumber: 1, pageCount: pages.length, pageBytes: Math.max(elementBytes, Buffer.byteLength(pages[0] ?? '')), totalBytes, truncated: false },
  };
  if (!validateSafePresentation(summary, profile).ok || Buffer.byteLength(JSON.stringify(summary)) > profile.maxPresentationPageBytes) throw new Error('unsafe-presentation');
  return { summary, pages };
}
