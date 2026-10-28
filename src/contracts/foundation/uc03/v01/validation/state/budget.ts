/** Budget reservation and ledger validation. */

import type { BudgetLedger, BudgetReservation, ValidationError, ValidationResult } from '../../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonEmptyString, validateNonNegativeInteger, validateNonNegativeNumber } from '../common.ts';

const BUDGET_RESERVATION_ALLOWED_KEYS = ['reservationId', 'keyedId', 'amount'] as const;

const BUDGET_LEDGER_ALLOWED_KEYS = [
  'scope',
  'kind',
  'limit',
  'consumed',
  'reservations',
  'unit',
  'configurationId',
  'version',
] as const;

export function validateBudgetLedger(
  input: unknown,
  path = 'budgetLedger'
): ValidationResult<BudgetLedger> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, BUDGET_LEDGER_ALLOWED_KEYS, path, errors);

  const scope = input['scope'];
  if (scope !== 'task' && scope !== 'run') {
    errors.push({
      path: `${path}.scope`,
      message: `${path}.scope must be "task" or "run"`,
      code: 'INVALID_SCOPE',
    });
  }

  const kind = validateNonEmptyString(input['kind'], `${path}.kind`, errors);
  const limit = validateNonNegativeNumber(input['limit'], `${path}.limit`, errors);
  const consumed = validateNonNegativeNumber(input['consumed'], `${path}.consumed`, errors);
  const unit = validateNonEmptyString(input['unit'], `${path}.unit`, errors);
  const configurationId = validateNonEmptyString(input['configurationId'], `${path}.configurationId`, errors);
  const version = validateNonNegativeInteger(input['version'], `${path}.version`, errors);

  const reservations: BudgetReservation[] = [];
  if (!Array.isArray(input['reservations'])) {
    errors.push({
      path: `${path}.reservations`,
      message: `${path}.reservations must be an array of reservations`,
      code: 'INVALID_TYPE',
    });
  } else {
    for (let i = 0; i < input['reservations'].length; i++) {
      const resItem = input['reservations'][i];
      const resPath = `${path}.reservations[${i}]`;
      if (!isPlainObject(resItem)) {
        errors.push({
          path: resPath,
          message: `${resPath} must be an object`,
          code: 'INVALID_TYPE',
        });
        continue;
      }
      rejectUnknownKeys(resItem, BUDGET_RESERVATION_ALLOWED_KEYS, resPath, errors);
      const resId = validateNonEmptyString(resItem['reservationId'], `${resPath}.reservationId`, errors);
      const keyedId = validateNonEmptyString(resItem['keyedId'], `${resPath}.keyedId`, errors);
      const amount = validateNonNegativeNumber(resItem['amount'], `${resPath}.amount`, errors);
      if (resId && keyedId && amount !== undefined) {
        reservations.push({ reservationId: resId, keyedId, amount });
      }
    }
  }

  const ledgerTotal = (consumed ?? 0) + reservations.reduce((sum, reservation) => sum + reservation.amount, 0);
  if (!Number.isFinite(ledgerTotal)) errors.push({ path, code: 'INVALID_ACCOUNTING_TOTAL', message: 'Ledger totals must remain finite' });
  if (kind !== 'cost') {
    const amounts = [limit, consumed, ...reservations.map(reservation => reservation.amount)];
    const total = (consumed ?? 0) + reservations.reduce((sum, reservation) => sum + reservation.amount, 0);
    if (amounts.some(amount => !Number.isSafeInteger(amount)) || !Number.isSafeInteger(total)) {
      errors.push({ path, code: 'UNSAFE_COUNT_SUM', message: 'Count ledger amounts and totals must be safe integers' });
    }
  }
  if (new Set(reservations.map(reservation => reservation.reservationId)).size !== reservations.length ||
      new Set(reservations.map(reservation => reservation.keyedId)).size !== reservations.length) {
    errors.push({ path, code: 'DUPLICATE_RESERVATION', message: 'Ledger reservation IDs and keys must be unique' });
  }

  if (
    errors.length > 0 ||
    (scope !== 'task' && scope !== 'run') ||
    !kind ||
    limit === undefined ||
    consumed === undefined ||
    !unit ||
    !configurationId ||
    version === undefined ||
    !Array.isArray(input['reservations'])
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      scope,
      kind,
      limit,
      consumed,
      reservations,
      unit,
      configurationId,
      version,
    },
  };
}
