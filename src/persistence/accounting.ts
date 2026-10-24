import { randomUUID } from 'node:crypto';
import type {
  BudgetLedger,
  BudgetReservationItem,
  ReservationBundle,
  ReservationBundleItem,
  ProviderUsage,
  ClaimDispatchInput,
  DispatchClaimRecord,
} from './contracts.ts';
import {
  validateBudgetLedger,
  validateClaimDispatchInput,
} from './contracts.ts';

export class BudgetExhaustionError extends Error {
  readonly details: {
    readonly scope: string;
    readonly kind: string;
    readonly limit: number;
    readonly requested: number;
    readonly available: number;
  };

  constructor(message: string, details: { scope: string; kind: string; limit: number; requested: number; available: number }) {
    super(message);
    this.name = 'BudgetExhaustionError';
    this.details = details;
  }
}

export class BudgetTracker {
  private ledgers: Map<string, BudgetLedger>;

  constructor(ledgers: readonly BudgetLedger[]) {
    this.ledgers = new Map();
    for (const l of ledgers) {
      const key = `${l.scope}:${l.kind}`;
      this.ledgers.set(key, structuredClone(l));
    }
  }

  static forNewRun(currentLedgers: readonly BudgetLedger[]): BudgetTracker {
    const updated = currentLedgers.map((l) => {
      if (l.scope === 'run') {
        return {
          ...l,
          consumed: 0,
          reservations: [],
          version: l.version + 1,
        };
      }
      return structuredClone(l);
    });
    return new BudgetTracker(updated);
  }

  getLedgers(): BudgetLedger[] {
    return Array.from(this.ledgers.values()).map((l) => structuredClone(l));
  }

  getLedger(scope: 'task' | 'run', kind: string): BudgetLedger | undefined {
    return this.ledgers.get(`${scope}:${kind}`);
  }

  getAvailable(scope: 'task' | 'run', kind: string): number {
    const ledger = this.getLedger(scope, kind);
    if (!ledger) return 0;
    const reservedTotal = ledger.reservations.reduce((sum, r) => sum + r.amount, 0);
    return Math.max(0, ledger.limit - ledger.consumed - reservedTotal);
  }

  getConsumed(scope: 'task' | 'run', kind: string): number {
    return this.getLedger(scope, kind)?.consumed ?? 0;
  }

  reserve(
    requestId: string,
    items: readonly { scope: 'task' | 'run'; kind: 'tokens' | 'token' | 'cost' | 'repair' | 'reviewer'; amount: number }[],
    owner?: { readonly taskId?: string; readonly runId?: string }
  ): ReservationBundle {
    // Pre-validate amounts and detect duplicate keys
    for (const ledger of this.ledgers.values()) {
      if (ledger.reservations.some((r) => r.keyedId === requestId)) {
        throw new Error(`Reservation already exists for requestId: ${requestId}`);
      }
    }

    const requestedByKey = new Map<string, number>();
    for (const item of items) {
      if (typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount <= 0) {
        throw new Error(`Invalid reservation amount: ${item.amount}`);
      }
      const key = `${item.scope}:${item.kind}`;
      if (requestedByKey.has(key)) {
        throw new Error(`Duplicate reservation key in request: ${key}`);
      }
      requestedByKey.set(key, item.amount);
    }

    // Phase 1: Pre-flight check all items
    for (const [key, requestedAmount] of requestedByKey.entries()) {
      const ledger = this.ledgers.get(key);
      if (!ledger) {
        throw new Error(`Ledger not found for ${key}`);
      }
      const reservedTotal = ledger.reservations.reduce((sum, r) => sum + r.amount, 0);
      const available = ledger.limit - ledger.consumed - reservedTotal;
      if (available < requestedAmount) {
        const [scope = '', kind = ''] = key.split(':');
        throw new BudgetExhaustionError(
          `Budget exhausted on ${scope} ${kind}: requested ${requestedAmount}, available ${available} (limit ${ledger.limit}, consumed ${ledger.consumed})`,
          {
            scope,
            kind,
            limit: ledger.limit,
            requested: requestedAmount,
            available,
          }
        );
      }
    }

    // Phase 2: Atomically apply all reservations
    const bundleItems: ReservationBundleItem[] = [];
    const bundleId = `bundle-${randomUUID()}`;

    for (const item of items) {
      const key = `${item.scope}:${item.kind}`;
      const ledger = this.ledgers.get(key);
      if (!ledger) {
        throw new Error(`Ledger not found for ${key}`);
      }
      const reservationId = `${bundleId}:${key}`;

      const resItem: BudgetReservationItem = {
        reservationId,
        keyedId: requestId,
        amount: item.amount,
      };

      const updatedLedger: BudgetLedger = {
        ...ledger,
        reservations: [...ledger.reservations, resItem],
        version: ledger.version + 1,
      };

      const val = validateBudgetLedger(updatedLedger);
      if (!val.ok) throw new Error(`Invalid budget ledger state: ${val.errors.map((e) => e.message).join(', ')}`);

      this.ledgers.set(key, updatedLedger);

      bundleItems.push({
        ledgerIdentity: key,
        scope: item.scope,
        kind: item.kind,
        configurationId: ledger.configurationId,
        version: updatedLedger.version,
        requestId,
        amount: item.amount,
      });
    }

    return {
      bundleId,
      transactionRef: requestId,
      taskId: owner?.taskId ?? 'active-task',
      runId: owner?.runId ?? 'active-run',
      reservations: bundleItems,
    };
  }

  settleReservation(reservationId: string, amount: number): void {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`Invalid settlement amount: ${amount}`);
    }
    for (const [key, ledger] of this.ledgers.entries()) {
      if (!ledger.reservations.some((r) => r.reservationId === reservationId)) continue;
      const updated: BudgetLedger = {
        ...ledger,
        consumed: ledger.consumed + amount,
        reservations: ledger.reservations.filter((r) => r.reservationId !== reservationId),
        version: ledger.version + 1,
      };
      const val = validateBudgetLedger(updated);
      if (!val.ok) throw new Error(`Invalid ledger state after settle: ${val.errors.map((e) => e.message).join(', ')}`);
      this.ledgers.set(key, updated);
      return;
    }
    throw new Error(`No reservation found for reservationId: ${reservationId}`);
  }

  settle(requestId: string, observed: ProviderUsage | { amount: number }): void {
    let matched = 0;
    for (const [key, ledger] of this.ledgers.entries()) {
      const matchingRes = ledger.reservations.find((r) => r.keyedId === requestId);
      if (matchingRes) {
        matched++;
        const remaining = ledger.reservations.filter((r) => r.keyedId !== requestId);
        let increment = 0;

        if (ledger.kind === 'tokens' || ledger.kind === 'token') {
          if ('billableTokens' in observed && observed.billableTokens !== undefined) {
            increment = observed.billableTokens;
          } else if ('inputTokens' in observed) {
            increment = observed.inputTokens + observed.outputTokens;
          } else {
            increment = observed.amount;
          }
        } else if (ledger.kind === 'cost') {
          if ('costUsd' in observed) {
            increment = observed.costUsd;
          } else {
            increment = observed.amount;
          }
        } else {
          increment = 'amount' in observed ? observed.amount : matchingRes.amount;
        }

        const updated: BudgetLedger = {
          ...ledger,
          consumed: ledger.consumed + increment,
          reservations: remaining,
          version: ledger.version + 1,
        };

        const val = validateBudgetLedger(updated);
        if (!val.ok) throw new Error(`Invalid ledger state after settle: ${val.errors.map((e) => e.message).join(', ')}`);
        this.ledgers.set(key, updated);
      }
    }

    if (matched === 0) {
      throw new Error(`No reservation found to settle for requestId: ${requestId}`);
    }
  }

  reconcileUncertain(
    requestId: string,
    reconciliation: {
      readonly observedUsage?: ProviderUsage;
      readonly reason: string;
    }
  ): void {
    if (!reconciliation.reason || !reconciliation.reason.trim()) {
      throw new Error('reconcileUncertain requires a non-empty explanation reason');
    }

    if (reconciliation.observedUsage !== undefined) {
      this.settle(requestId, reconciliation.observedUsage);
    }
  }
}

export function createDispatchClaim(input: ClaimDispatchInput): DispatchClaimRecord {
  const val = validateClaimDispatchInput(input);
  if (!val.ok) {
    throw new Error(`Invalid ClaimDispatchInput: ${val.errors.map((e) => e.message).join(', ')}`);
  }

  const claimId = `claim-${Date.now()}-${input.actionId}`;
  return {
    claimId,
    taskId: input.taskId,
    runId: input.runId,
    stepId: input.stepId,
    actionId: input.actionId,
    epoch: input.expectedEpoch,
    stateVersion: input.expectedStateVersion,
    phase: 'claimed',
    reservationRefs: input.reservationRefs,
    createdAt: new Date().toISOString(),
  };
}
