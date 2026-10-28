/** Provider result, usage, and reservation validation. */

import type { ModelProposal, ModelResult } from '../../ports.ts';
import type { NormalizedAction, ProviderUsage, ReservationBundle, ReservationBundleItem, ValidationError, ValidationResult } from '../../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonEmptyString, validateNonNegativeInteger, validateNonNegativeNumber } from '../common.ts';
import { validateNormalizedAction } from '../intake.ts';

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
