/** Provider dispatch admission. */

import type { BudgetLedger, ProviderRequest, ValidationError, ValidationResult } from '../../types.ts';
import { isPlainObject } from '../common.ts';
import { validateBudgetLedger } from '../state.ts';

import { validateReservationBundle } from './records.ts';
import { PROVIDER_REQUEST_ALLOWED_KEYS, validateProviderRequest } from './request.ts';

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
