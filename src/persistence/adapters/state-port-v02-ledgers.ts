/**
 * Budget-ledger staging for the durable UC-03 v0.2 state port: which reservations an admission
 * implies, and how a reserve/consume/settle/release moves them. Pure; the caller persists.
 */
import type { AdmissionContextV02, BudgetLedger, ProviderUsage, TaskState } from '../../contracts/foundation/uc03.ts';
import { validateBudgetLedger } from '../../contracts/foundation/uc03.ts';
import type { ReservationSpecV02, StoredClaimV02 } from './state-port-v02-types.ts';
import { equal, isRepairPatch } from './state-port-v02-admission.ts';
import type { AttemptOutcomeReceiptV02 } from '../../contracts/foundation/uc03.ts';

export function stageReservation(
  ledger: BudgetLedger | undefined,
  spec: { readonly reservationId: string; readonly keyedId: string; readonly amount: number },
  operation: 'reserve' | 'consume' | 'settle' | 'release',
  usage?: ProviderUsage,
): BudgetLedger | null {
  if (!ledger) return null;
  const matching = ledger.reservations.filter(item => item.reservationId === spec.reservationId || item.keyedId === spec.keyedId);
  if (operation === 'reserve') {
    if (matching.length) return null;
    const reserved = ledger.reservations.reduce((sum, item) => sum + item.amount, 0);
    if (ledger.limit - ledger.consumed - reserved < spec.amount) return null;
    const candidate = { ...ledger, reservations: [...ledger.reservations, { reservationId: spec.reservationId, keyedId: spec.keyedId, amount: spec.amount }], version: ledger.version + 1 };
    return validateBudgetLedger(candidate).ok ? candidate : null;
  }
  const held = matching[0];
  if (matching.length !== 1 || !held || held.reservationId !== spec.reservationId || held.keyedId !== spec.keyedId || held.amount !== spec.amount) return null;
  const increment =
    operation === 'consume'
      ? spec.amount
      : operation === 'settle'
        ? usage === undefined
          ? spec.amount
          : ledger.kind === 'cost'
            ? usage.costUsd
            : (usage.billableTokens ?? usage.inputTokens + usage.outputTokens)
        : 0;
  if (increment === undefined || (operation === 'settle' && increment > spec.amount) || ledger.consumed + increment > ledger.limit) return null;
  const candidate = {
    ...ledger,
    consumed: ledger.consumed + increment,
    reservations: ledger.reservations.filter(item => item.reservationId !== spec.reservationId),
    version: ledger.version + 1,
  };
  return validateBudgetLedger(candidate).ok ? candidate : null;
}

export function reviewerIterationSpecs(context: AdmissionContextV02, ledgers: readonly BudgetLedger[]): readonly ReservationSpecV02[] | null {
  if (context.subjectKind !== 'provider-request' || context.role !== 'reviewer') return [];
  const taskRows = ledgers.filter(ledger => ledger.scope === 'task' && (ledger.kind === 'iteration' || ledger.kind === 'review_iteration'));
  const runRows = ledgers.filter(ledger => ledger.scope === 'run' && (ledger.kind === 'iteration' || ledger.kind === 'review_iteration'));
  const maxReviewerIterations = context.finiteBounds.maxReviewerIterations;
  const taskLedger = taskRows[0];
  if (taskRows.length !== 1 || runRows.length > 1 || typeof maxReviewerIterations !== 'number' || !Number.isSafeInteger(maxReviewerIterations) || maxReviewerIterations <= 0 || !taskLedger)
    return null;
  return [taskLedger, ...runRows].map((ledger, index) => ({
    scope: ledger.scope as 'task' | 'run',
    kind: ledger.kind,
    amount: 1,
    reservationId: context.budgetRefs[index + 4] ?? '',
    keyedId: context.providerRequestId,
  }));
}

export function providerSpecs(context: AdmissionContextV02, ledgers: readonly BudgetLedger[]): readonly ReservationSpecV02[] | null {
  if (context.subjectKind !== 'provider-request' || new Set(context.budgetRefs).size !== context.budgetRefs.length) return null;
  const reviewerSpecs = reviewerIterationSpecs(context, ledgers);
  if (!reviewerSpecs) return null;
  if (context.budgetRefs.length !== 4 + reviewerSpecs.length) return null;
  const expected = [
    { scope: 'task' as const, kind: 'tokens', amount: context.finiteBounds.maxBillableTokens },
    { scope: 'task' as const, kind: 'cost', amount: context.finiteBounds.maxCostUsd },
    { scope: 'run' as const, kind: 'tokens', amount: context.finiteBounds.maxBillableTokens },
    { scope: 'run' as const, kind: 'cost', amount: context.finiteBounds.maxCostUsd },
  ];
  const resolved = expected.map((item, index) => ({ ...item, reservationId: context.budgetRefs[index] as string, keyedId: context.providerRequestId }));
  for (const spec of resolved) if (!ledgers.find(ledger => ledger.scope === spec.scope && ledger.kind === spec.kind)) return null;
  if (reviewerSpecs.some((spec, index) => !spec.reservationId || spec.reservationId !== context.budgetRefs[index + 4])) return null;
  return [...resolved, ...reviewerSpecs];
}

export function repositoryResourceSpecs(context: AdmissionContextV02, ledgers: readonly BudgetLedger[]): readonly ReservationSpecV02[] | null {
  if (context.subjectKind !== 'repository-action' || context.action.kind !== 'run_command' || !context.finiteBounds) return null;
  const bounds = context.finiteBounds as unknown as Record<string, unknown>;
  const configuredKinds = ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'] as const;
  const order = new Map(configuredKinds.map((kind, index) => [kind, index]));
  const configured = ledgers
    .filter(ledger => (ledger.scope === 'task' || ledger.scope === 'run') && order.has(ledger.kind as (typeof configuredKinds)[number]))
    .sort((left, right) =>
      left.scope === right.scope ? (order.get(left.kind as (typeof configuredKinds)[number]) ?? 0) - (order.get(right.kind as (typeof configuredKinds)[number]) ?? 0) : left.scope === 'task' ? -1 : 1,
    );
  if (context.reservationRefs.length !== configured.length || new Set(context.reservationRefs).size !== context.reservationRefs.length) return null;
  const specs = configured.map((ledger, index) => {
    const amount = bounds[ledger.kind];
    return {
      scope: ledger.scope as 'task' | 'run',
      kind: ledger.kind,
      amount: typeof amount === 'number' ? amount : Number.NaN,
      reservationId: context.reservationRefs[index] as string,
      keyedId: context.action.actionId,
    };
  });
  return specs.every(spec => Number.isFinite(spec.amount) && spec.amount > 0) ? specs : null;
}

export function stageClaimReservations(
  context: AdmissionContextV02,
  ledgers: readonly BudgetLedger[],
  operation: 'reserve' | 'settle' | 'release',
  usage?: ProviderUsage,
  releaseUnattempted = false,
): Map<string, BudgetLedger> | null {
  const staged = new Map<string, BudgetLedger>();
  const add = (spec: ReservationSpecV02, stageOperation = operation): boolean => {
    const key = `${spec.scope}:${spec.kind}`;
    const ledger = staged.get(key) ?? ledgers.find(item => item.scope === spec.scope && item.kind === spec.kind);
    const next = stageReservation(ledger, { reservationId: spec.reservationId, keyedId: spec.keyedId, amount: spec.amount }, stageOperation, usage);
    if (!next) return false;
    staged.set(key, next);
    return true;
  };
  if (context.subjectKind === 'provider-request') {
    const specs = providerSpecs(context, ledgers);
    if (!specs) return null;
    const iterationSpecs = specs.filter(spec => spec.kind === 'iteration' || spec.kind === 'review_iteration');
    const budgetSpecs = specs.filter(spec => spec.kind === 'tokens' || spec.kind === 'cost');
    const operationSpecs = operation === 'reserve' || (operation === 'release' && releaseUnattempted) ? [...budgetSpecs, ...iterationSpecs] : budgetSpecs;
    if (operation === 'reserve') {
      const allReservations = ledgers.flatMap(ledger => ledger.reservations);
      if (operationSpecs.some(spec => allReservations.some(reservation => reservation.reservationId === spec.reservationId || reservation.keyedId === spec.keyedId))) return null;
      if (
        iterationSpecs.some(spec => {
          const ledger = ledgers.find(item => item.scope === spec.scope && item.kind === spec.kind);
          const reserved = ledger?.reservations.reduce((sum, item) => sum + item.amount, 0) ?? 0;
          return !ledger || ledger.consumed + reserved + spec.amount > (context.finiteBounds.maxReviewerIterations ?? 0);
        })
      )
        return null;
    } else {
      const allMatching = ledgers.flatMap(ledger =>
        ledger.reservations
          .filter(reservation => reservation.keyedId === context.providerRequestId || context.budgetRefs.includes(reservation.reservationId))
          .map(reservation => ({ scope: ledger.scope, kind: ledger.kind, ...reservation })),
      );
      if (
        allMatching.length !== operationSpecs.length ||
        operationSpecs.some(
          spec =>
            !allMatching.some(
              reservation =>
                reservation.scope === spec.scope &&
                reservation.kind === spec.kind &&
                reservation.reservationId === spec.reservationId &&
                reservation.keyedId === spec.keyedId &&
                reservation.amount === spec.amount,
            ),
        )
      )
        return null;
    }
    for (const spec of operationSpecs) if (!add(spec)) return null;
  } else if (isRepairPatch(context)) {
    if (context.reservationRefs.length !== 1 || !add({ scope: 'task', kind: 'repair', reservationId: context.reservationRefs[0] as string, keyedId: context.action.actionId, amount: 1 })) return null;
  } else if (context.action.kind === 'run_command') {
    const specs = repositoryResourceSpecs(context, ledgers);
    if (!specs) return null;
    if (operation === 'reserve') {
      const allReservations = ledgers.flatMap(ledger => ledger.reservations);
      if (specs.some(spec => allReservations.some(reservation => reservation.reservationId === spec.reservationId || reservation.keyedId === spec.keyedId))) return null;
    } else {
      const allMatching = ledgers.flatMap(ledger =>
        ledger.reservations
          .filter(reservation => reservation.keyedId === context.action.actionId || context.reservationRefs.includes(reservation.reservationId))
          .map(reservation => ({ scope: ledger.scope, kind: ledger.kind, ...reservation })),
      );
      if (
        allMatching.length !== specs.length ||
        specs.some(
          spec =>
            !allMatching.some(
              reservation =>
                reservation.scope === spec.scope &&
                reservation.kind === spec.kind &&
                reservation.reservationId === spec.reservationId &&
                reservation.keyedId === spec.keyedId &&
                reservation.amount === spec.amount,
            ),
        )
      )
        return null;
    }
    for (const spec of specs) if (!add(spec)) return null;
  }
  return staged;
}

export function replaceLedgers(task: TaskState, staged: ReadonlyMap<string, BudgetLedger>): TaskState {
  return { ...task, budgetLedgers: (task.budgetLedgers ?? []).map(ledger => staged.get(`${ledger.scope}:${ledger.kind}`) ?? ledger) };
}

export function observedCommandAccountingMatches(claim: StoredClaimV02, predecessor: AttemptOutcomeReceiptV02, ledgers: readonly BudgetLedger[]): boolean {
  if (claim.context.subjectKind !== 'repository-action' || claim.context.action.kind !== 'run_command') return true;
  if (
    predecessor.subjectKind !== 'repository-action' ||
    predecessor.repositoryOperation !== 'run-command' ||
    predecessor.outcome !== 'observed' ||
    predecessor.proposedEffects.accounting.disposition !== 'settle' ||
    !equal(predecessor.proposedEffects.accounting.reservationRefs, claim.receipt.reservationRefs) ||
    !equal(claim.receipt.reservationRefs, claim.context.reservationRefs)
  )
    return false;
  const specs = repositoryResourceSpecs(claim.context, ledgers);
  const initialLedgers = claim.taskSnapshot.budgetLedgers ?? [];
  if (!specs) return false;
  return specs.every(spec => {
    const initial = initialLedgers.find(ledger => ledger.scope === spec.scope && ledger.kind === spec.kind);
    const reserved = initial && stageReservation(initial, spec, 'reserve');
    const expected = reserved && stageReservation(reserved, spec, 'settle');
    const current = ledgers.find(ledger => ledger.scope === spec.scope && ledger.kind === spec.kind);
    return Boolean(expected && current && equal(current, expected));
  });
}
