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

export interface BudgetTrackerSnapshot {
  readonly ledgers: BudgetLedger[];
  readonly owners: Map<string, string>;
  readonly consumed: Map<string, Map<string, number>>;
  readonly tasks: Set<string>;
}

export class BudgetTracker {
  private ledgers = new Map<string, BudgetLedger>();
  private owners = new Map<string, string>();
  private consumedByTask = new Map<string, Map<string, number>>();
  private restoredTasks = new Set<string>();

  constructor(ledgers: readonly BudgetLedger[]) {
    this.replaceLedgers(ledgers);
  }

  replaceLedgers(ledgers: readonly BudgetLedger[]): void {
    this.setLedgers(ledgers);
    this.owners.clear();
    this.consumedByTask.clear();
    this.restoredTasks.clear();
  }

  private setLedgers(ledgers: readonly BudgetLedger[]): void {
    this.ledgers = new Map();
    for (const l of ledgers) {
      const key = `${l.scope}:${l.kind}`;
      this.ledgers.set(key, structuredClone(l));
    }
  }

  snapshot(): BudgetTrackerSnapshot {
    return {
      ledgers: this.getLedgers(),
      owners: new Map(this.owners),
      consumed: new Map([...this.consumedByTask].map(([task, values]) => [task, new Map(values)])),
      tasks: new Set(this.restoredTasks),
    };
  }

  restoreSnapshot(snapshot: BudgetTrackerSnapshot): void {
    this.setLedgers(snapshot.ledgers);
    this.owners = new Map(snapshot.owners);
    this.consumedByTask = new Map([...snapshot.consumed].map(([task, values]) => [task, new Map(values)]));
    this.restoredTasks = new Set(snapshot.tasks);
  }

  /** Merge one task's journal into the aggregate without losing other owners. */
  restoreTask(taskId: string, journal?: readonly BudgetLedger[]): void {
    if (this.restoredTasks.has(taskId)) return;
    const first = this.restoredTasks.size === 0;
    if (first && journal) {
      // The initial tracker may itself be a stale or already restored task snapshot.
      const journalIds = new Set(journal.flatMap((ledger) => ledger.reservations.map((r) => r.reservationId)));
      const previous = this.getLedgers();
      const restored = journal.map((ledger) => {
        const key = `${ledger.scope}:${ledger.kind}`;
        const old = previous.find((item) => item.scope === ledger.scope && item.kind === ledger.kind);
        const foreignConsumed = [...this.consumedByTask].reduce(
          (sum, [owner, amounts]) => sum + (owner === taskId ? 0 : amounts.get(key) ?? 0), 0
        );
        return {
          ...ledger,
          consumed: ledger.consumed + foreignConsumed,
          reservations: [...ledger.reservations, ...(old?.reservations.filter((r) => this.owners.has(r.keyedId) && this.owners.get(r.keyedId) !== taskId && !journalIds.has(r.reservationId)) ?? [])],
        };
      });
      const restoredKeys = new Set(restored.map((ledger) => `${ledger.scope}:${ledger.kind}`));
      this.setLedgers([...restored, ...previous.filter((ledger) => !restoredKeys.has(`${ledger.scope}:${ledger.kind}`))]);
    } else if (journal) {
      for (const incoming of journal) {
        const key = `${incoming.scope}:${incoming.kind}`;
        const current = this.ledgers.get(key);
        if (!current) {
          this.ledgers.set(key, structuredClone(incoming));
          continue;
        }
        const present = new Set(current.reservations.map((r) => r.reservationId));
        this.ledgers.set(key, {
          ...current,
          consumed: current.consumed + incoming.consumed,
          reservations: [...current.reservations, ...incoming.reservations.filter((r) => !present.has(r.reservationId))],
          version: Math.max(current.version, incoming.version),
        });
      }
    }
    const source = journal ?? (first ? this.getLedgers() : []);
    this.consumedByTask.set(taskId, new Map(source.map((ledger) => [`${ledger.scope}:${ledger.kind}`, ledger.consumed])));
    for (const ledger of source) {
      for (const reservation of ledger.reservations) this.owners.set(reservation.keyedId, taskId);
    }
    this.restoredTasks.add(taskId);
  }

  getTaskLedgers(taskId: string): BudgetLedger[] {
    const consumed = this.consumedByTask.get(taskId);
    return this.getLedgers().map((ledger) => ({
      ...ledger,
      consumed: consumed?.get(`${ledger.scope}:${ledger.kind}`) ?? 0,
      reservations: ledger.reservations.filter((r) => this.owners.get(r.keyedId) === taskId),
    }));
  }

  getTaskConsumed(taskId: string, scope: 'task' | 'run', kind: string): number {
    return this.consumedByTask.get(taskId)?.get(`${scope}:${kind}`) ?? 0;
  }

  private chargeOwner(keyedId: string, key: string, amount: number): void {
    const owner = this.owners.get(keyedId);
    if (!owner) return;
    const amounts = this.consumedByTask.get(owner) ?? new Map<string, number>();
    amounts.set(key, (amounts.get(key) ?? 0) + amount);
    this.consumedByTask.set(owner, amounts);
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

    if (owner?.taskId) this.owners.set(requestId, owner.taskId);

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
      const reservation = ledger.reservations.find((r) => r.reservationId === reservationId);
      if (reservation) this.chargeOwner(reservation.keyedId, key, amount);
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
        this.chargeOwner(matchingRes.keyedId, key, increment);
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
