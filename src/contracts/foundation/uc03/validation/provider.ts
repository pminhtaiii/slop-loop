/** Model request, usage, reservation, and dispatch admission. */

import type { ModelProposal, ModelResult } from '../ports.ts';
import type { BudgetLedger, NormalizedAction, ProviderRequest, ProviderRequestValidationContext, ProviderUsage, ReservationBundle, ReservationBundleItem, ValidationError, ValidationResult } from '../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonEmptyString, validateNonNegativeInteger, validateNonNegativeNumber, validatePositiveInteger } from './common.ts';
import { validateNormalizedAction } from './intake.ts';
import { validateBudgetLedger } from './state.ts';

const PROVIDER_USAGE_ALLOWED_KEYS = [
  'inputTokens',
  'outputTokens',
  'costUsd',
  'billableTokens',
] as const;

const MODEL_PROPOSAL_ALLOWED_KEYS = [
  'proposalId',
  'content',
  'actions',
] as const;

const MODEL_RESULT_ALLOWED_KEYS = [
  'proposal',
  'observedUsage',
] as const;

const PROVIDER_REQUEST_ALLOWED_KEYS = [
  'providerRequestId',
  'taskId',
  'runId',
  'role',
  'purpose',
  'providerId',
  'modelId',
  'configId',
  'pricingPolicyId',
  'contextDigest',
  'timeoutMs',
  'maxInputTokens',
  'maxOutputTokens',
  'maxBillableTokens',
  'maxCostUsd',
  'reservationRef',
  'dispatchState',
  'observedUsage',
  'uncertainReason',
] as const;

const RESERVATION_BUNDLE_ITEM_ALLOWED_KEYS = [
  'ledgerIdentity',
  'scope',
  'kind',
  'configurationId',
  'version',
  'requestId',
  'amount',
] as const;

const RESERVATION_BUNDLE_ALLOWED_KEYS = [
  'bundleId',
  'transactionRef',
  'taskId',
  'runId',
  'reservations',
] as const;

export function validateProviderUsage(input: unknown): ValidationResult<ProviderUsage> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'providerUsage', message: 'ProviderUsage must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, PROVIDER_USAGE_ALLOWED_KEYS, '', errors);

  const inputTokens = validateNonNegativeInteger(input['inputTokens'], 'inputTokens', errors);
  const outputTokens = validateNonNegativeInteger(input['outputTokens'], 'outputTokens', errors);
  const costUsd = validateNonNegativeNumber(input['costUsd'], 'costUsd', errors);

  let billableTokens: number | undefined;
  if (input['billableTokens'] !== undefined) {
    billableTokens = validateNonNegativeInteger(input['billableTokens'], 'billableTokens', errors);
    if (
      billableTokens !== undefined &&
      inputTokens !== undefined &&
      outputTokens !== undefined &&
      billableTokens < inputTokens + outputTokens
    ) {
      errors.push({
        path: 'billableTokens',
        message: `billableTokens (${billableTokens}) cannot be less than sum of input and output tokens (${inputTokens + outputTokens})`,
        code: 'INVALID_BILLABLE_TOKENS',
      });
    }
  }

  if (typeof input['inputTokens'] === 'number' && typeof input['outputTokens'] === 'number' && !Number.isSafeInteger(input['inputTokens'] + input['outputTokens'])) errors.push({ path: 'inputTokens', code: 'UNSAFE_COUNT_SUM', message: 'Token totals must remain safe integers' });
  if (
    errors.length > 0 ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    costUsd === undefined
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      inputTokens,
      outputTokens,
      costUsd,
      ...(billableTokens !== undefined ? { billableTokens } : {}),
    },
  };
}

export function validateModelProposal(input: unknown): ValidationResult<ModelProposal> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'modelProposal', message: 'ModelProposal must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, MODEL_PROPOSAL_ALLOWED_KEYS, '', errors);

  const proposalId = validateNonEmptyString(input['proposalId'], 'proposalId', errors);
  let content: string | undefined;
  if (typeof input['content'] !== 'string') {
    errors.push({
      path: 'content',
      message: 'content must be a string',
      code: 'INVALID_TYPE',
    });
  } else {
    content = input['content'];
  }

  let actions: NormalizedAction[] | undefined;
  if (input['actions'] !== undefined) {
    if (!Array.isArray(input['actions'])) {
      errors.push({
        path: 'actions',
        message: 'actions must be an array of NormalizedAction',
        code: 'INVALID_TYPE',
      });
    } else {
      actions = [];
      const acts = input['actions'] as readonly unknown[];
      for (let i = 0; i < acts.length; i++) {
        const act = acts[i];
        const actionRes = validateNormalizedAction(act);
        if (!actionRes.ok) {
          errors.push(
            ...actionRes.errors.map((e) => ({
              ...e,
              path: e.path ? `actions[${i}].${e.path}` : `actions[${i}]`,
            }))
          );
        } else {
          actions.push(actionRes.value);
        }
      }
    }
  }

  if (errors.length > 0 || !proposalId || content === undefined) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      proposalId,
      content,
      ...(actions !== undefined ? { actions } : {}),
    },
  };
}

export function validateModelResult(input: unknown): ValidationResult<ModelResult> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'modelResult', message: 'ModelResult must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, MODEL_RESULT_ALLOWED_KEYS, '', errors);

  let proposal: ModelProposal | undefined;
  if (input['proposal'] === undefined) {
    errors.push({
      path: 'proposal',
      message: 'proposal is required in ModelResult',
      code: 'MISSING_PROPOSAL',
    });
  } else {
    const propRes = validateModelProposal(input['proposal']);
    if (!propRes.ok) {
      errors.push(...propRes.errors);
    } else {
      proposal = propRes.value;
    }
  }

  let observedUsage: ProviderUsage | undefined;
  if (input['observedUsage'] === undefined) {
    errors.push({
      path: 'observedUsage',
      message: 'observedUsage is required in ModelResult',
      code: 'MISSING_OBSERVED_USAGE',
    });
  } else {
    const usageRes = validateProviderUsage(input['observedUsage']);
    if (!usageRes.ok) {
      errors.push(...usageRes.errors);
    } else {
      observedUsage = usageRes.value;
    }
  }

  if (errors.length > 0 || !proposal || !observedUsage) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      proposal,
      observedUsage,
    },
  };
}

export function validateReservationBundle(input: unknown): ValidationResult<ReservationBundle> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'reservationBundle', message: 'ReservationBundle must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, RESERVATION_BUNDLE_ALLOWED_KEYS, '', errors);

  const bundleId = validateNonEmptyString(input['bundleId'], 'bundleId', errors);
  const transactionRef = validateNonEmptyString(input['transactionRef'], 'transactionRef', errors);
  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const runId = validateNonEmptyString(input['runId'], 'runId', errors);

  const reservations: ReservationBundleItem[] = [];
  if (!Array.isArray(input['reservations'])) {
    errors.push({
      path: 'reservations',
      message: 'reservations must be an array of reservation items',
      code: 'INVALID_TYPE',
    });
  } else if (input['reservations'].length === 0) {
    errors.push({
      path: 'reservations',
      message: 'reservations must not be empty',
      code: 'EMPTY_RESERVATIONS',
    });
  } else {
    const items = input['reservations'] as readonly unknown[];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemPath = `reservations[${i}]`;
      if (!isPlainObject(item)) {
        errors.push({
          path: itemPath,
          message: `${itemPath} must be an object`,
          code: 'INVALID_TYPE',
        });
        continue;
      }
      rejectUnknownKeys(item, RESERVATION_BUNDLE_ITEM_ALLOWED_KEYS, itemPath, errors);
      const ledgerIdentity = validateNonEmptyString(item['ledgerIdentity'], `${itemPath}.ledgerIdentity`, errors);
      const scope = item['scope'];
      if (scope !== 'task' && scope !== 'run') {
        errors.push({
          path: `${itemPath}.scope`,
          message: `${itemPath}.scope must be "task" or "run"`,
          code: 'INVALID_SCOPE',
        });
      }
      const kind = validateNonEmptyString(item['kind'], `${itemPath}.kind`, errors);
      const configurationId = validateNonEmptyString(item['configurationId'], `${itemPath}.configurationId`, errors);
      const version = validateNonNegativeInteger(item['version'], `${itemPath}.version`, errors);
      const requestId = validateNonEmptyString(item['requestId'], `${itemPath}.requestId`, errors);
      const amount = (kind === 'cost' ? validateNonNegativeNumber : validateNonNegativeInteger)(item['amount'], `${itemPath}.amount`, errors);

      if (
        ledgerIdentity &&
        (scope === 'task' || scope === 'run') &&
        kind &&
        configurationId &&
        version !== undefined &&
        requestId &&
        amount !== undefined
      ) {
        reservations.push({
          ledgerIdentity,
          scope,
          kind,
          configurationId,
          version,
          requestId,
          amount,
        });
      }
    }
  }

  if (
    errors.length > 0 ||
    !bundleId ||
    !transactionRef ||
    !taskId ||
    !runId ||
    !Array.isArray(input['reservations']) ||
    input['reservations'].length === 0
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      bundleId,
      transactionRef,
      taskId,
      runId,
      reservations,
    },
  };
}

export function validateProviderRequest(
  input: unknown,
  options?: ProviderRequestValidationContext
): ValidationResult<ProviderRequest> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'providerRequest', message: 'ProviderRequest must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, PROVIDER_REQUEST_ALLOWED_KEYS, '', errors);

  const providerRequestId = validateNonEmptyString(input['providerRequestId'], 'providerRequestId', errors);
  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const runId = validateNonEmptyString(input['runId'], 'runId', errors);

  const role = input['role'];
  if (role !== 'coder' && role !== 'reviewer') {
    errors.push({
      path: 'role',
      message: 'role must be either "coder" or "reviewer"',
      code: 'INVALID_ROLE',
    });
  }

  const purpose = validateNonEmptyString(input['purpose'], 'purpose', errors);
  const providerId = validateNonEmptyString(input['providerId'], 'providerId', errors);
  const modelId = validateNonEmptyString(input['modelId'], 'modelId', errors);
  const configId = validateNonEmptyString(input['configId'], 'configId', errors);
  const pricingPolicyId = validateNonEmptyString(input['pricingPolicyId'], 'pricingPolicyId', errors);
  const contextDigest = validateNonEmptyString(input['contextDigest'], 'contextDigest', errors);

  const timeoutMs = validatePositiveInteger(input['timeoutMs'], 'timeoutMs', errors);
  const maxInputTokens = validateNonNegativeInteger(input['maxInputTokens'], 'maxInputTokens', errors);
  const maxOutputTokens = validateNonNegativeInteger(input['maxOutputTokens'], 'maxOutputTokens', errors);
  const maxBillableTokens = validateNonNegativeInteger(input['maxBillableTokens'], 'maxBillableTokens', errors);
  const maxCostUsd = validateNonNegativeNumber(input['maxCostUsd'], 'maxCostUsd', errors);

  if (
    maxBillableTokens !== undefined &&
    maxInputTokens !== undefined &&
    maxOutputTokens !== undefined &&
    maxBillableTokens < maxInputTokens + maxOutputTokens
  ) {
    errors.push({
      path: 'maxBillableTokens',
      message: `maxBillableTokens (${maxBillableTokens}) must include finite conservative overhead and cannot be less than maxInputTokens + maxOutputTokens (${maxInputTokens + maxOutputTokens})`,
      code: 'INVALID_BILLABLE_CEILING',
    });
  }

  const reservationRef = validateNonEmptyString(input['reservationRef'], 'reservationRef', errors);

  const validDispatchStates = ['reserved', 'dispatched', 'settled', 'uncertain'] as const;
  const dispatchState = input['dispatchState'] as 'reserved' | 'dispatched' | 'settled' | 'uncertain';
  if (!validDispatchStates.includes(dispatchState)) {
    errors.push({
      path: 'dispatchState',
      message: `dispatchState must be one of: ${validDispatchStates.join(', ')}`,
      code: 'INVALID_DISPATCH_STATE',
    });
  }

  let observedUsage: ProviderUsage | undefined;
  if (input['observedUsage'] !== undefined) {
    const usageRes = validateProviderUsage(input['observedUsage']);
    if (!usageRes.ok) {
      errors.push(...usageRes.errors);
    } else {
      observedUsage = usageRes.value;
    }
  }

  let uncertainReason: string | undefined;
  if (input['uncertainReason'] !== undefined) {
    uncertainReason = validateNonEmptyString(input['uncertainReason'], 'uncertainReason', errors);
  }

  // State-specific discrimination
  if (dispatchState === 'reserved') {
    if (input['observedUsage'] !== undefined) {
      errors.push({
        path: 'observedUsage',
        message: 'A reserved ProviderRequest cannot have observedUsage set prior to dispatch and return',
        code: 'RESERVED_CANNOT_HAVE_USAGE',
      });
    }
    if (input['uncertainReason'] !== undefined) {
      errors.push({
        path: 'uncertainReason',
        message: 'A reserved ProviderRequest cannot have uncertainReason set',
        code: 'RESERVED_CANNOT_HAVE_UNCERTAIN_REASON',
      });
    }
  } else if (dispatchState === 'dispatched') {
    if (input['observedUsage'] !== undefined) {
      errors.push({
        path: 'observedUsage',
        message: 'A dispatched ProviderRequest cannot have observedUsage set while in flight',
        code: 'DISPATCHED_CANNOT_HAVE_USAGE',
      });
    }
    if (input['uncertainReason'] !== undefined) {
      errors.push({
        path: 'uncertainReason',
        message: 'A dispatched ProviderRequest cannot have uncertainReason set',
        code: 'DISPATCHED_CANNOT_HAVE_UNCERTAIN_REASON',
      });
    }
  } else if (dispatchState === 'settled') {
    if (input['observedUsage'] === undefined) {
      errors.push({
        path: 'observedUsage',
        message: 'A settled ProviderRequest requires observedUsage to be recorded',
        code: 'SETTLED_REQUIRES_USAGE',
      });
    }
    if (input['uncertainReason'] !== undefined) {
      errors.push({
        path: 'uncertainReason',
        message: 'A settled ProviderRequest cannot have uncertainReason set',
        code: 'SETTLED_CANNOT_HAVE_UNCERTAIN_REASON',
      });
    }
  } else if (dispatchState === 'uncertain') {
    if (input['uncertainReason'] === undefined) {
      errors.push({
        path: 'uncertainReason',
        message: 'An uncertain ProviderRequest requires uncertainReason explaining the interruption or timeout',
        code: 'UNCERTAIN_REQUIRES_REASON',
      });
    }
  }

  // Trusted expected request identity comparison
  if (options) {
    if (options.expectedTaskId !== undefined && options.expectedTaskId !== taskId) {
      errors.push({
        path: 'taskId',
        message: `Request taskId (${taskId}) does not match expected taskId (${options.expectedTaskId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedRunId !== undefined && options.expectedRunId !== runId) {
      errors.push({
        path: 'runId',
        message: `Request runId (${runId}) does not match expected runId (${options.expectedRunId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedRole !== undefined && options.expectedRole !== role) {
      errors.push({
        path: 'role',
        message: `Request role (${role}) does not match expected role (${options.expectedRole})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedPurpose !== undefined && options.expectedPurpose !== purpose) {
      errors.push({
        path: 'purpose',
        message: `Request purpose (${purpose}) does not match expected purpose (${options.expectedPurpose})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedProviderId !== undefined && options.expectedProviderId !== providerId) {
      errors.push({
        path: 'providerId',
        message: `Request providerId (${providerId}) does not match expected providerId (${options.expectedProviderId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedModelId !== undefined && options.expectedModelId !== modelId) {
      errors.push({
        path: 'modelId',
        message: `Request modelId (${modelId}) does not match expected modelId (${options.expectedModelId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedConfigId !== undefined && options.expectedConfigId !== configId) {
      errors.push({
        path: 'configId',
        message: `Request configId (${configId}) does not match expected configId (${options.expectedConfigId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedPricingPolicyId !== undefined && options.expectedPricingPolicyId !== pricingPolicyId) {
      errors.push({
        path: 'pricingPolicyId',
        message: `Request pricingPolicyId (${pricingPolicyId}) does not match expected pricingPolicyId (${options.expectedPricingPolicyId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedContextDigest !== undefined && options.expectedContextDigest !== contextDigest) {
      errors.push({
        path: 'contextDigest',
        message: `Request contextDigest (${contextDigest}) does not match expected contextDigest (${options.expectedContextDigest})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedProviderRequestId !== undefined && options.expectedProviderRequestId !== providerRequestId) {
      errors.push({
        path: 'providerRequestId',
        message: `Request providerRequestId (${providerRequestId}) does not match expected providerRequestId (${options.expectedProviderRequestId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
  }

  if (typeof input['maxInputTokens'] === 'number' && typeof input['maxOutputTokens'] === 'number' && !Number.isSafeInteger(input['maxInputTokens'] + input['maxOutputTokens'])) errors.push({ path: 'maxBillableTokens', code: 'UNSAFE_COUNT_SUM', message: 'Token ceilings must remain safe integers' });
  if (
    errors.length > 0 ||
    !providerRequestId ||
    !taskId ||
    !runId ||
    (role !== 'coder' && role !== 'reviewer') ||
    !purpose ||
    !providerId ||
    !modelId ||
    !configId ||
    !pricingPolicyId ||
    !contextDigest ||
    timeoutMs === undefined ||
    maxInputTokens === undefined ||
    maxOutputTokens === undefined ||
    maxBillableTokens === undefined ||
    maxCostUsd === undefined ||
    !reservationRef ||
    !validDispatchStates.includes(dispatchState)
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      providerRequestId,
      taskId,
      runId,
      role,
      purpose,
      providerId,
      modelId,
      configId,
      pricingPolicyId,
      contextDigest,
      timeoutMs,
      maxInputTokens,
      maxOutputTokens,
      maxBillableTokens,
      maxCostUsd,
      reservationRef,
      dispatchState,
      ...(observedUsage !== undefined ? { observedUsage } : {}),
      ...(uncertainReason !== undefined ? { uncertainReason } : {}),
    },
  };
}

export function validateDispatchAdmission(
  request: unknown,
  context: unknown
): ValidationResult<ProviderRequest> {
  const reqRes = validateProviderRequest(request);
  if (!reqRes.ok) {
    return reqRes;
  }
  const req = reqRes.value;
  const errors: ValidationError[] = [];

  // 1. Dispatch State Check: Only 'reserved' requests can be dispatched
  if (req.dispatchState === 'uncertain') {
    errors.push({
      path: 'dispatchState',
      message: 'Uncertain requests retain charge and cannot be replayed or dispatched',
      code: 'UNCERTAIN_CANNOT_REPLAY',
    });
    return { ok: false, errors };
  }
  if (req.dispatchState !== 'reserved') {
    errors.push({
      path: 'dispatchState',
      message: `Request in state "${req.dispatchState}" cannot be admitted for dispatch (must be "reserved")`,
      code: 'INVALID_DISPATCH_STATE',
    });
    return { ok: false, errors };
  }

  // 2. Context verification
  if (!isPlainObject(context)) {
    errors.push({
      path: 'context',
      message: 'Dispatch admission requires trusted validated context (a bare reservation ref cannot authorize dispatch)',
      code: 'UNTRUSTED_DISPATCH_AUTHORIZATION',
    });
    return { ok: false, errors };
  }

  // 3. Telemetry estimate prohibition: telemetry estimates or projections must NOT authorize
  if (context['isTelemetryEstimate'] === true) {
    errors.push({
      path: 'isTelemetryEstimate',
      message: 'A telemetry estimate or client projection must NOT authorize dispatch',
      code: 'TELEMETRY_ESTIMATE_CANNOT_AUTHORIZE',
    });
    return { ok: false, errors };
  }

  // Schema parsing alone does not authorize a network request. The host must supply
  // a complete trusted identity and the persisted task accounting snapshot.
  const fail = (code: string, message: string): void => { errors.push({ path: 'context', code, message }); };
  const expected = validateProviderRequest(context['expectedRequest']);
  if (!expected.ok || !Array.isArray(context['storedRequests']) ||
      context['taskAccountingStatus'] !== 'healthy' ||
      typeof context['requireRunReviewIteration'] !== 'boolean' ||
      typeof context['transactionRef'] !== 'string' || !context['transactionRef'].trim() ||
      !Array.isArray(context['ledgerIdentities']) || !isPlainObject(context['reservationIds'])) {
    fail('UNTRUSTED_DISPATCH_AUTHORIZATION', 'Complete trusted identity, receipt and healthy task accounting are required');
    return { ok: false, errors };
  }
  const identityKeys = PROVIDER_REQUEST_ALLOWED_KEYS;
  if (identityKeys.some(key => (req as unknown as Record<string, unknown>)[key] !==
      (expected.value as unknown as Record<string, unknown>)[key])) {
    fail('PROVIDER_IDENTITY_MISMATCH', 'Request differs from the complete trusted reserved envelope');
  }
  const seenRequestIds = new Set<string>();
  let storedMatches = 0;
  for (const raw of context['storedRequests']) {
    const stored = validateProviderRequest(raw);
    if (!stored.ok) { fail('INVALID_ACCOUNTING_HISTORY', 'Stored request history must be valid'); continue; }
    const value = stored.value;
    if (seenRequestIds.has(value.providerRequestId)) fail('DUPLICATE_REQUEST_ID', 'History contains duplicate request identity');
    seenRequestIds.add(value.providerRequestId);
    if (value.taskId === req.taskId && (value.dispatchState === 'uncertain' || value.dispatchState === 'dispatched')) {
      fail('UNRESOLVED_ACCOUNTING', 'Outstanding provider accounting prevents constrained dispatch');
    }
    if (value.providerRequestId === req.providerRequestId) {
      storedMatches++;
      if (identityKeys.some(key => (value as unknown as Record<string, unknown>)[key] !==
          (req as unknown as Record<string, unknown>)[key])) fail('REQUEST_REPLAY', 'Persisted request is not the same undispatched reservation');
    }
  }
  if (storedMatches !== 1) fail('MISSING_STORED_REQUEST', 'Exactly one persisted reserved request is required');

  // 4. Reservation bundle presence and validation
  const rawBundle = context['reservationBundle'];
  if (!rawBundle) {
    errors.push({
      path: 'reservationBundle',
      message: 'Missing reservation bundle in trusted context',
      code: 'ABSENT_RESERVATION_BUNDLE',
    });
    return { ok: false, errors };
  }

  const bundleRes = validateReservationBundle(rawBundle);
  if (!bundleRes.ok) {
    errors.push(...bundleRes.errors);
    return { ok: false, errors };
  }
  const bundle = bundleRes.value;

  if (req.reservationRef !== bundle.bundleId || context['transactionRef'] !== bundle.transactionRef) {
    fail('RESERVATION_MISMATCH', 'Request and atomic StatePort receipt must bind this exact bundle');
  }
  const itemIds = new Set<string>();
  for (const item of bundle.reservations) {
    const key = `${item.scope}:${item.kind}`;
    if (itemIds.has(key)) fail('DUPLICATE_RESERVATION', 'Duplicate budget entries cannot authorize dispatch');
    itemIds.add(key);
    if (item.configurationId !== req.configId) fail('LEDGER_CONFIG_MISMATCH', 'Reservation must use the trusted request configuration');
  }
  // 5. Bundle identity comparison
  if (bundle.taskId !== req.taskId) {
    errors.push({
      path: 'reservationBundle.taskId',
      message: `Reservation bundle taskId (${bundle.taskId}) does not match request taskId (${req.taskId})`,
      code: 'RESERVATION_MISMATCH',
    });
  }
  if (bundle.runId !== req.runId) {
    errors.push({
      path: 'reservationBundle.runId',
      message: `Reservation bundle runId (${bundle.runId}) does not match request runId (${req.runId})`,
      code: 'RESERVATION_MISMATCH',
    });
  }
  if (!bundle.transactionRef) {
    errors.push({
      path: 'reservationBundle.transactionRef',
      message: 'Reservation bundle requires an atomic transaction reference',
      code: 'MISSING_TRANSACTION_REF',
    });
  }

  // All reservations in the bundle must be tied to this request
  for (const item of bundle.reservations) {
    if (item.requestId !== req.providerRequestId) {
      errors.push({
        path: 'reservationBundle.reservations',
        message: `Reservation item requestId (${item.requestId}) does not match providerRequestId (${req.providerRequestId})`,
        code: 'RESERVATION_MISMATCH',
      });
    }
  }

  // 6. Required multi-budget ceilings in reservation bundle
  // Must have:
  // - task tokens (amount >= req.maxBillableTokens)
  // - task cost (amount >= req.maxCostUsd)
  // - run tokens (amount >= req.maxBillableTokens)
  // - run cost (amount >= req.maxCostUsd)
  // - if reviewer: iteration (amount >= 1)
  const taskTokenRes = bundle.reservations.find(
    (r) => r.scope === 'task' && (r.kind === 'tokens' || r.kind === 'token')
  );
  if (!taskTokenRes || taskTokenRes.amount < req.maxBillableTokens) {
    errors.push({
      path: 'reservationBundle',
      message: `Missing or insufficient task tokens reservation (required: ${req.maxBillableTokens}, reserved: ${taskTokenRes?.amount ?? 0})`,
      code: 'PARTIAL_RESERVATION',
    });
  }

  const taskCostRes = bundle.reservations.find(
    (r) => r.scope === 'task' && r.kind === 'cost'
  );
  if (!taskCostRes || taskCostRes.amount < req.maxCostUsd) {
    errors.push({
      path: 'reservationBundle',
      message: `Missing or insufficient task cost reservation (required: ${req.maxCostUsd}, reserved: ${taskCostRes?.amount ?? 0})`,
      code: 'PARTIAL_RESERVATION',
    });
  }

  const runTokenRes = bundle.reservations.find(
    (r) => r.scope === 'run' && (r.kind === 'tokens' || r.kind === 'token')
  );
  if (!runTokenRes || runTokenRes.amount < req.maxBillableTokens) {
    errors.push({
      path: 'reservationBundle',
      message: `Missing or insufficient run tokens reservation (required: ${req.maxBillableTokens}, reserved: ${runTokenRes?.amount ?? 0})`,
      code: 'PARTIAL_RESERVATION',
    });
  }

  const runCostRes = bundle.reservations.find(
    (r) => r.scope === 'run' && r.kind === 'cost'
  );
  if (!runCostRes || runCostRes.amount < req.maxCostUsd) {
    errors.push({
      path: 'reservationBundle',
      message: `Missing or insufficient run cost reservation (required: ${req.maxCostUsd}, reserved: ${runCostRes?.amount ?? 0})`,
      code: 'PARTIAL_RESERVATION',
    });
  }

  if (req.role === 'reviewer') {
    const iterationRes = bundle.reservations.find(
      (r) => r.scope === 'task' && (r.kind === 'iteration' || r.kind === 'review_iteration')
    );
    if (!iterationRes || iterationRes.amount < 1) {
      errors.push({
        path: 'reservationBundle',
        message: 'Reviewer provider requests require an iteration reservation (amount >= 1) before dispatch',
        code: 'PARTIAL_RESERVATION',
      });
    }
  }

  if (req.role === 'reviewer' && context['requireRunReviewIteration'] === true &&
      !bundle.reservations.some(item => item.scope === 'run' && (item.kind === 'iteration' || item.kind === 'review_iteration') && item.amount >= 1)) {
    fail('PARTIAL_RESERVATION', 'Trusted profile also requires a run review iteration');
  }
  // 7. Ledgers validation and capacity check
  const rawLedgers = context['ledgers'];
  if (!Array.isArray(rawLedgers)) {
    errors.push({
      path: 'ledgers',
      message: 'Dispatch admission requires an array of trusted ledgers',
      code: 'ABSENT_LEDGERS',
    });
    return { ok: false, errors };
  }

  const validatedLedgers: BudgetLedger[] = [];
  const ledgersList = rawLedgers as readonly unknown[];
  for (let i = 0; i < ledgersList.length; i++) {
    const item = ledgersList[i];
    const lRes = validateBudgetLedger(item, `ledgers[${i}]`);
    if (!lRes.ok) {
      errors.push(...lRes.errors);
    } else {
      validatedLedgers.push(lRes.value);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const ledgerIds = context['ledgerIdentities'] as unknown[];
  if (ledgerIds.length !== validatedLedgers.length || ledgerIds.some(id => typeof id !== 'string' || !id.trim()) ||
      new Set(ledgerIds).size !== ledgerIds.length ||
      new Set(validatedLedgers.map(ledger => `${ledger.scope}:${ledger.kind}`)).size !== validatedLedgers.length) {
    fail('INVALID_LEDGER_IDENTITIES', 'Every authoritative ledger needs a unique identity and budget slot');
    return { ok: false, errors };
  }
  // Match each bundle reservation against a ledger
  for (const item of bundle.reservations) {
    const matchingLedger = validatedLedgers.find(
      (l, index) => ledgerIds[index] === item.ledgerIdentity && l.scope === item.scope && l.kind === item.kind
    );
    if (!matchingLedger) {
      errors.push({
        path: 'ledgers',
        message: `No ledger found for scope "${item.scope}" and kind "${item.kind}"`,
        code: 'LEDGER_NOT_FOUND',
      });
      continue;
    }

    if (matchingLedger.configurationId !== item.configurationId) {
      errors.push({
        path: 'ledgers',
        message: `Ledger configurationId (${matchingLedger.configurationId}) does not match reservation configurationId (${item.configurationId})`,
        code: 'LEDGER_CONFIG_MISMATCH',
      });
      continue;
    }

    const persisted = matchingLedger.reservations.filter(reservation => reservation.keyedId === req.providerRequestId);
    if (matchingLedger.version !== item.version || persisted.length !== 1 ||
        persisted[0]?.amount !== item.amount ||
        typeof context['reservationIds'][item.ledgerIdentity] !== 'string' ||
        persisted[0]?.reservationId !== context['reservationIds'][item.ledgerIdentity]) {
      fail('MISSING_PERSISTED_RESERVATION', 'Exact reserved amount, ID, ledger version and bundle identity must exist in StatePort');
    }
    // Capacity calculation: limit - consumed - sum(other reservations)
    const otherReservationsSum = matchingLedger.reservations
      .filter((r) => r.keyedId !== req.providerRequestId)
      .reduce((sum, r) => sum + r.amount, 0);

    const available = matchingLedger.limit - matchingLedger.consumed - otherReservationsSum;
    if (available < item.amount) {
      errors.push({
        path: 'ledgers',
        message: `Budget exhausted on ${item.scope} ${item.kind} ledger (limit: ${matchingLedger.limit}, consumed: ${matchingLedger.consumed}, other reserved: ${otherReservationsSum}, requested: ${item.amount}, available: ${available})`,
        code: 'BUDGET_EXHAUSTED',
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: req };
}

export function isAdmittedForDispatch(
  request: unknown,
  context: unknown
): boolean {
  const res = validateDispatchAdmission(request, context);
  return res.ok;
}


/* ------------------------------------------------------------------
 * Slice 4: Evidence, Baseline, Verification, Review, and Exported Records
 * ------------------------------------------------------------------ */
