import {
  type StatePort,
  type StatePortV02,
  type AdmissionContextV02,
  type ClaimReceiptV02,
  type AttemptReceiptV02,
  type AttemptOutcomeReceiptV02,
  type AttemptReconciliationReceiptV02,
  type ClaimClosureReceiptV02,
  type OutcomeRecordResultV02,
  type ReconciliationResultV02,
  type ClaimClosureResultV02,
  type ExecutorIdentityV02,
  type StateTransitionOptions,
  type TaskState,
  type TaskNode,
  type ProviderUsage,
  type ReservationBundle,
  type ReservationBundleItem,
  type PortProvenance,
  type BudgetLedger,
  type ProviderRequest,
  BudgetExhaustionError,
  BudgetConflictError,
  validateTaskState,
  validateStateTransition,
  validateBudgetLedger,
  validateReservationBundle,
  validateProviderUsage,
  computeCanonicalSha256,
  validateAdmissionV02,
  validateAttemptReceiptV02,
  validateProtocolVersionProgressionV02,
  validateAttemptOutcomeReceiptV02,
  validateAttemptReconciliationReceiptV02,
  validateClaimClosureReceiptV02,
} from '../../../../src/contracts/foundation/uc03.ts';
import type {
  AdmissionTrustedContextV02,
  PolicyAuthorityRefV02,
  SafeReferenceV02,
} from '../../../../src/contracts/foundation/uc03/ports-v02.ts';
import type {
  AttemptOutcomeValidationContextV02,
  AttemptReconciliationValidationContextV02,
  ClaimClosureValidationContextV02,
} from '../../../../src/contracts/foundation/uc03/attempt-v02.ts';
import {
  createTestProviderAdmissionTrustedContextV02,
  createTestRepositoryAdmissionTrustedContextV02,
} from './state-fixtures.ts';

export class StateConflictError extends Error {
  readonly code = 'CAS_CONFLICT' as const;
  readonly details?: { readonly expectedVersion: number; readonly actualVersion: number; readonly currentVersion: number } | undefined;
  constructor(
    message: string,
    details?: {
      readonly expectedVersion: number;
      readonly actualVersion: number;
      readonly currentVersion: number;
    }
  ) {
    super(message);
    this.name = 'StateConflictError';
    this.details = details;
  }
}

export interface MemoryStatePortOptions {
  readonly transitionContexts?: Readonly<Record<number, NonNullable<StateTransitionOptions['trusted']>>> | undefined;
  readonly initialBundles?: Readonly<Record<string, ReservationBundle>> | undefined;
  readonly reconciliationUsage?: Readonly<Record<string, ProviderUsage>> | undefined;
  readonly initialTaskState?: TaskState | undefined;
  readonly initialLedgers?: readonly BudgetLedger[] | undefined;
  readonly initialStoredRequests?: readonly ProviderRequest[] | undefined;
  readonly currentTaskId?: string | undefined;
  readonly currentRunId?: string | undefined;
  readonly neutral?: boolean | undefined;
}

export class MemoryStatePort implements StatePort {
  readonly provenance: PortProvenance = 'mock';

  protected readonly tasks = new Map<string, TaskState>();
  protected readonly checkpoints = new Map<string, TaskState>();
  protected readonly ledgers = new Map<string, BudgetLedger>();
  protected readonly ledgerIdentities = new Map<string, string>();
  protected readonly reservationIds: Record<string, string> = {};
  protected readonly reservationBundles = new Map<string, ReservationBundle>();
  protected readonly storedRequests = new Map<string, ProviderRequest>();

  protected readonly transitionContexts: Readonly<Record<number, NonNullable<StateTransitionOptions['trusted']>>>;
  protected readonly reconciliationUsage: Readonly<Record<string, ProviderUsage>>;
  protected readonly uncertain = new Set<string>();
  protected readonly terminal = new Map<string, ProviderUsage>();

  protected currentTaskId?: string | undefined;
  protected currentRunId?: string | undefined;

  constructor(options?: MemoryStatePortOptions) {
    for (const key of Object.keys(options?.transitionContexts ?? {})) {
      if (!Number.isSafeInteger(Number(key)) || Number(key) < 1 || String(Number(key)) !== key) throw new Error('Transition script requires exact positive safe-integer versions');
    }
    this.transitionContexts = structuredClone(options?.transitionContexts ?? {});
    this.reconciliationUsage = structuredClone(options?.reconciliationUsage ?? {});
    if (options?.initialTaskState) {
      const val = validateTaskState(options.initialTaskState);
      if (!val.ok) {
        throw new Error(`Invalid initial task state: ${val.errors.map((e) => e.message).join(', ')}`);
      }
      const cloned = structuredClone(val.value);
      this.tasks.set(cloned.taskId, cloned);
      this.checkpoints.set(cloned.taskId, structuredClone(cloned));
      this.currentTaskId = cloned.taskId;
      this.currentRunId = cloned.runId;

      if (cloned.budgetLedgers) {
        for (const l of cloned.budgetLedgers) {
          const lVal = validateBudgetLedger(l);
          if (lVal.ok) {
            const key = `${l.scope}:${l.kind}`;
            if (this.ledgers.has(key)) throw new Error('Duplicate ledger identity');
            this.ledgers.set(key, structuredClone(lVal.value));
            const id = `ledger-${l.scope}-${l.kind}`;
            this.ledgerIdentities.set(key, id);
          }
        }
      }
    }

    if (options?.initialLedgers) {
      for (const l of options.initialLedgers) {
        const lVal = validateBudgetLedger(l);
        if (!lVal.ok) {
          throw new Error(`Invalid initial ledger: ${lVal.errors.map((e) => e.message).join(', ')}`);
        }
        const key = `${l.scope}:${l.kind}`;
        if (this.ledgers.has(key)) throw new Error('Duplicate ledger identity');
        this.ledgers.set(key, structuredClone(lVal.value));
        const id = `ledger-${l.scope}-${l.kind}`;
        this.ledgerIdentities.set(key, id);
      }
    }

    const restoredReservationIds = new Set<string>();
    for (const [key, ledger] of this.ledgers) {
      for (const reservation of ledger.reservations) {
        if (restoredReservationIds.has(reservation.reservationId)) throw new Error('Duplicate restored reservation identity');
        restoredReservationIds.add(reservation.reservationId);
        this.reservationIds[this.ledgerIdentities.get(key) ?? `ledger-${key}`] = reservation.reservationId;
      }
    }
    if (options?.initialStoredRequests) {
      for (const req of options.initialStoredRequests) {
        if (this.storedRequests.has(req.providerRequestId)) throw new Error('Duplicate stored request identity');
        this.storedRequests.set(req.providerRequestId, structuredClone(req));
      }
    }

    for (const [requestId, bundle] of Object.entries(options?.initialBundles ?? {})) {
      const checked = validateReservationBundle(bundle);
      const restoredItems = [...this.ledgers.values()].flatMap(ledger => ledger.reservations.filter(res => res.keyedId === requestId));
      if (!checked.ok || restoredItems.length !== bundle.reservations.length || bundle.taskId !== (options?.currentTaskId ?? this.currentTaskId) || bundle.runId !== (options?.currentRunId ?? this.currentRunId) || !bundle.reservations.every(item => {
        const ledger = this.ledgers.get(`${item.scope}:${item.kind}`);
        return item.requestId === requestId && item.ledgerIdentity === this.ledgerIdentities.get(`${item.scope}:${item.kind}`) &&
          ledger?.configurationId === item.configurationId && ledger.version === item.version &&
          ledger.reservations.some(res => res.keyedId === requestId && res.amount === item.amount && res.reservationId === `${bundle.bundleId}:${item.ledgerIdentity}`);
      })) throw new Error('Restored bundle does not match current ledger receipts');
      if ([...this.reservationBundles.values()].some(old => old.bundleId === bundle.bundleId || old.transactionRef === bundle.transactionRef)) throw new Error('Restored bundle identity collision');
      this.reservationBundles.set(requestId, structuredClone(bundle));
    }
    for (const req of this.storedRequests.values()) {
      if (req.dispatchState === 'uncertain') this.uncertain.add(req.providerRequestId);
      if (req.dispatchState === 'settled') {
        if (!req.observedUsage) throw new Error('Settled restore requires usage');
        this.terminal.set(req.providerRequestId, structuredClone(req.observedUsage));
      }
    }
    if (options?.currentTaskId) {
      if (this.currentTaskId && this.currentTaskId !== options.currentTaskId) throw new Error('Task identity mismatch');
      this.currentTaskId = options.currentTaskId;
    }
    if (options?.currentRunId) {
      if (this.currentRunId && this.currentRunId !== options.currentRunId) throw new Error('Run change unsupported by this mock');
      this.currentRunId = options.currentRunId;
    }
  }

  internalSetTask(state: TaskState): void {
    const cloned = structuredClone(state);
    this.tasks.set(cloned.taskId, cloned);
  }

  internalSetLedger(ledger: BudgetLedger): void {
    const key = `${ledger.scope}:${ledger.kind}`;
    this.ledgers.set(key, structuredClone(ledger));
    const id = this.ledgerIdentities.get(key) ?? `ledger-${key}`;
    const latest = ledger.reservations.at(-1);
    if (latest) this.reservationIds[id] = latest.reservationId;
    else Reflect.deleteProperty(this.reservationIds, id);
  }

  getLedgers(): readonly BudgetLedger[] {
    return Array.from(this.ledgers.values()).map((l) => structuredClone(l));
  }

  getLedgerIdentities(): readonly string[] {
    return Array.from(this.ledgers.keys()).map((k) => this.ledgerIdentities.get(k) ?? `ledger-${k}`);
  }

  getReservationIds(): Readonly<Record<string, string>> {
    return structuredClone(this.reservationIds);
  }

  getStoredRequests(): readonly ProviderRequest[] {
    return Array.from(this.storedRequests.values()).map((r) => structuredClone(r));
  }

  async loadTask(taskId: string): Promise<TaskState | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return structuredClone({...task, budgetLedgers: this.getLedgers()});
  }

  async transition(state: TaskState, expectedVersion: number): Promise<TaskState> {
    const val = validateTaskState(state);
    if (!val.ok) {
      throw new Error(`Invalid transition state: ${val.errors.map((e) => e.message).join(', ')}`);
    }

    const prior = this.tasks.get(state.taskId);
    if (!prior) {
      if (expectedVersion === 0 && state.stateVersion === 1) {
        if (this.tasks.size > 0 || (this.currentTaskId && this.currentTaskId !== state.taskId) || (this.currentRunId && this.currentRunId !== state.runId)) throw new Error('Only the configured task/run is supported');
        if (this.ledgers.size && computeCanonicalSha256(state.budgetLedgers) !== computeCanonicalSha256(this.getLedgers())) throw new StateConflictError('Stale creation accounting');
        const staged = new Map<string,BudgetLedger>();
        for (const ledger of state.budgetLedgers ?? []) {
          const key = `${ledger.scope}:${ledger.kind}`;
          if (staged.has(key)) throw new Error('Duplicate ledger identity');
          staged.set(key, structuredClone(ledger));
        }
        for (const [key, ledger] of staged) {
          this.ledgers.set(key, ledger);
          this.ledgerIdentities.set(key, `ledger-${ledger.scope}-${ledger.kind}`);
        }
        this.currentTaskId = state.taskId;
        this.currentRunId = state.runId;
        const saved = structuredClone(val.value);
        this.tasks.set(state.taskId, saved);
        return structuredClone(saved);
      }
      throw new StateConflictError(`Task ${state.taskId} not found`);
    }

    if (expectedVersion !== prior.stateVersion || state.stateVersion !== expectedVersion + 1) {
      throw new StateConflictError(
        `CAS conflict: expected stateVersion ${prior.stateVersion + 1}, got ${state.stateVersion} (expectedVersion: ${expectedVersion})`,
        {
          expectedVersion,
          actualVersion: state.stateVersion,
          currentVersion: prior.stateVersion,
        }
      );
    }

    if (computeCanonicalSha256(state.budgetLedgers) !== computeCanonicalSha256(this.getLedgers())) throw new StateConflictError('Transition must retain current authoritative accounting');
    const currentPrior = {...prior, budgetLedgers: prior.budgetLedgers?.map(ledger => {
      if (ledger.kind !== 'tokens' && ledger.kind !== 'token' && ledger.kind !== 'cost') return ledger;
      let consumed = ledger.consumed;
      const reservations = ledger.reservations.filter(reservation => {
        const usage = this.terminal.get(reservation.keyedId);
        if (!usage) return true;
        consumed += ledger.kind === 'cost' ? usage.costUsd : usage.billableTokens ?? usage.inputTokens + usage.outputTokens;
        return false;
      });
      return {...ledger, consumed, reservations};
    })};
    const transitionRes = validateStateTransition(currentPrior, state, { allowSameNode: false, trusted: this.transitionContexts[state.stateVersion] });
    if (!transitionRes.ok) {
      const isCas = transitionRes.errors.some((e) => e.code === 'CAS_CONFLICT');
      if (isCas) {
        throw new StateConflictError(
          transitionRes.errors.map((e) => e.message).join(', '),
          {
            expectedVersion,
            actualVersion: state.stateVersion,
            currentVersion: prior.stateVersion,
          }
        );
      }
      throw new Error(`State transition validation failed: ${transitionRes.errors.map((e) => `${e.path}: ${e.message}`).join(', ')}`);
    }

    if (state.runId !== prior.runId) throw new Error('Run changes are unsupported by this finite mock');
    const saved = structuredClone({...transitionRes.value, budgetLedgers: this.getLedgers()});
    this.tasks.set(state.taskId, saved);
    return structuredClone(saved);
  }

  async reserve(scope: 'task' | 'run', kind: string, amount: number, actionId: string): Promise<string> {
    if (this.uncertain.has(actionId) || this.terminal.has(actionId) || this.reservationBundles.has(actionId)) throw new BudgetConflictError('Terminal or bundled action cannot reserve');
    if (!actionId.trim()) throw new Error('Empty action identity');
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Reservation amount must be a finite positive number: ${amount}`);
    }
    if (kind !== 'cost' && !Number.isSafeInteger(amount)) {
      throw new Error(`Reservation count amount must be a safe integer: ${amount}`);
    }

    const key = `${scope}:${kind}`;
    const ledger = this.ledgers.get(key);
    if (!ledger) {
      throw new Error(`Ledger not found for scope "${scope}" and kind "${kind}"`);
    }

    const existing = ledger.reservations.find((r) => r.keyedId === actionId);
    if (existing) {
      if (existing.amount === amount) {
        return existing.reservationId;
      }
      throw new BudgetConflictError(
        `Conflicting reservation for action ${actionId}: existing amount ${existing.amount} !== requested ${amount}`,
        { scope, kind, version: ledger.version }
      );
    }

    const reservedSum = ledger.reservations.reduce((sum, r) => sum + r.amount, 0);
    const available = ledger.limit - ledger.consumed - reservedSum;
    if (available < amount) {
      throw new BudgetExhaustionError(
        `Budget exhausted on ${scope} ${kind} ledger (limit: ${ledger.limit}, consumed: ${ledger.consumed}, reserved: ${reservedSum}, requested: ${amount}, available: ${available})`,
        { scope, kind, limit: ledger.limit, requested: amount }
      );
    }

    const reservationId = `res-${scope}-${kind}-${actionId}`;
    const updatedLedger: BudgetLedger = {
      ...ledger,
      reservations: [...ledger.reservations, { reservationId, keyedId: actionId, amount }],
      version: ledger.version + 1,
    };

    const val = validateBudgetLedger(updatedLedger);
    if (!val.ok) {
      throw new Error(`Updated ledger validation failed: ${val.errors.map((e) => e.message).join(', ')}`);
    }

    this.ledgers.set(key, updatedLedger);
    const ledgerId = this.ledgerIdentities.get(key) ?? `ledger-${key}`;
    this.reservationIds[ledgerId] = reservationId;

    return reservationId;
  }

  async reserveMany(
    reservations: readonly {
      readonly scope: 'task' | 'run';
      readonly kind: string;
      readonly amount: number;
    }[],
    requestId: string,
    transactionRef?: string
  ): Promise<ReservationBundle> {
    if (!requestId || typeof requestId !== 'string' || !requestId.trim()) {
      throw new Error('reserveMany requires a valid non-empty requestId');
    }

    if (!this.currentTaskId || !this.currentRunId) throw new Error('Explicit task/run identity required');
    const txRef = transactionRef ?? `tx-${requestId}`;
    const bundleId = transactionRef ? `bundle-${transactionRef}` : `bundle-${requestId}`;
    if (!txRef.trim()) throw new Error('Empty transaction identity');
    const seenKeys = new Set<string>();
    for (const item of reservations) {
      const key = `${item.scope}:${item.kind}`;
      if (seenKeys.has(key)) throw new BudgetConflictError('Duplicate reservation item');
      seenKeys.add(key);
    }
    if (this.terminal.has(requestId) || this.uncertain.has(requestId)) throw new BudgetConflictError('Terminal or uncertain request cannot reserve');
    const existingBundle = this.reservationBundles.get(requestId);
    if (existingBundle) {
      if (existingBundle.transactionRef !== txRef || existingBundle.reservations.length !== reservations.length ||
        !reservations.every(item => existingBundle.reservations.some(old => old.scope === item.scope && old.kind === item.kind && old.amount === item.amount))) {
        throw new BudgetConflictError('Conflicting bundle identity');
      }
      return structuredClone(existingBundle);
    }
    if ([...this.reservationBundles.values()].some(bundle => bundle.transactionRef === txRef || bundle.bundleId === bundleId)) throw new BudgetConflictError('Transaction identity collision');
    if ([...this.ledgers.values()].some(ledger => ledger.reservations.some(res => res.keyedId === requestId))) throw new BudgetConflictError('Existing reservation identity collision');

    for (const item of reservations) {
      const key = `${item.scope}:${item.kind}`;
      const ledger = this.ledgers.get(key);
      if (!ledger) {
        throw new Error(`Ledger not found for scope "${item.scope}" and kind "${item.kind}"`);
      }
      if (!Number.isFinite(item.amount) || item.amount <= 0) {
        throw new Error(`Reservation amount must be a finite positive number: ${item.amount}`);
      }
      if (item.kind !== 'cost' && !Number.isSafeInteger(item.amount)) {
        throw new Error(`Reservation count amount must be a safe integer: ${item.amount}`);
      }

      const reservedSum = ledger.reservations.reduce((sum, r) => sum + r.amount, 0);
      const available = ledger.limit - ledger.consumed - reservedSum;
      if (available < item.amount) {
        throw new BudgetExhaustionError(
          `Budget exhausted on ${item.scope} ${item.kind} ledger (limit: ${ledger.limit}, consumed: ${ledger.consumed}, reserved: ${reservedSum}, requested: ${item.amount}, available: ${available})`,
          { scope: item.scope, kind: item.kind, limit: ledger.limit, requested: item.amount }
        );
      }
    }

    const bundleItems: ReservationBundleItem[] = [];
    const staged = new Map<string, BudgetLedger>();
    const stagedIds: Record<string,string> = {};

    for (const item of reservations) {
      const key = `${item.scope}:${item.kind}`;
      const ledger = this.ledgers.get(key);
      if (!ledger) {
        throw new Error(`Ledger not found for scope "${item.scope}" and kind "${item.kind}"`);
      }
      const ledgerIdentity = this.ledgerIdentities.get(key) ?? `ledger-${item.scope}-${item.kind}`;
      const reservationId = `${bundleId}:${ledgerIdentity}`;
      const newVersion = ledger.version + 1;

      const updatedLedger: BudgetLedger = {
        ...ledger,
        reservations: [...ledger.reservations, { reservationId, keyedId: requestId, amount: item.amount }],
        version: newVersion,
      };

      const val = validateBudgetLedger(updatedLedger);
      if (!val.ok) {
        throw new Error(`Atomic ledger validation failed: ${val.errors.map((e) => e.message).join(', ')}`);
      }

      staged.set(key, updatedLedger);
      stagedIds[ledgerIdentity] = reservationId;

      bundleItems.push({
        ledgerIdentity,
        scope: item.scope,
        kind: item.kind,
        configurationId: ledger.configurationId,
        version: newVersion,
        requestId,
        amount: item.amount,
      });
    }

    const bundle: ReservationBundle = {
      bundleId,
      transactionRef: txRef,
      taskId: this.currentTaskId,
      runId: this.currentRunId,
      reservations: bundleItems,
    };

    const bundleValidation = validateReservationBundle(bundle);
    if (!bundleValidation.ok) {
      throw new Error(`Generated bundle invalid: ${bundleValidation.errors.map((e) => e.message).join(', ')}`);
    }

    for (const [key, ledger] of staged) this.ledgers.set(key, ledger);
    Object.assign(this.reservationIds, stagedIds);
    this.reservationBundles.set(requestId, bundle);
    return structuredClone(bundle);
  }

  async settle(actionId: string, observed: ProviderUsage): Promise<void> {
    const val = validateProviderUsage(observed);
    if (!val.ok) {
      throw new Error(`Invalid observed provider usage: ${val.errors.map((e) => e.message).join(', ')}`);
    }

    const usage = val.value;
    const priorUsage = this.terminal.get(actionId);
    if (priorUsage) {
      if (computeCanonicalSha256(priorUsage) === computeCanonicalSha256(usage)) return;
      throw new BudgetConflictError('Conflicting terminal settlement');
    }
    const staged = new Map<string, BudgetLedger>();
    let matchedReservations = 0;

    for (const [key, ledger] of this.ledgers.entries()) {
      const matchingRes = ledger.reservations.find((r) => r.keyedId === actionId);
      if (matchingRes) {
        matchedReservations++;
        const remaining = ledger.reservations.filter((r) => r.keyedId !== actionId);
        let consumedIncrement = 0;

        if (ledger.kind === 'tokens' || ledger.kind === 'token') {
          consumedIncrement = usage.billableTokens ?? (usage.inputTokens + usage.outputTokens);
        } else if (ledger.kind === 'cost') {
          consumedIncrement = usage.costUsd;
        } else {
          consumedIncrement = matchingRes.amount;
        }

        const updatedLedger: BudgetLedger = {
          ...ledger,
          consumed: ledger.consumed + consumedIncrement,
          reservations: remaining,
          version: ledger.version + 1,
        };

        const ledgerVal = validateBudgetLedger(updatedLedger);
        if (!ledgerVal.ok) {
          throw new Error(`Settled ledger validation failed: ${ledgerVal.errors.map((e) => e.message).join(', ')}`);
        }
        staged.set(key, updatedLedger);
      }
    }

    if (matchedReservations === 0) {
      throw new Error(`No reservation found to settle for actionId: ${actionId}`);
    }

    for (const [key, ledger] of staged) this.ledgers.set(key, ledger);
    this.terminal.set(actionId, structuredClone(usage));
    this.uncertain.delete(actionId);
    const storedReq = this.storedRequests.get(actionId);
    if (storedReq) {
      this.storedRequests.set(actionId, {
        ...storedReq,
        dispatchState: 'settled',
        observedUsage: usage,
      });
    }
  }

  async reconcileUncertain(
    requestId: string,
    reconciliation: {
      readonly observedUsage?: ProviderUsage | undefined;
      readonly reason: string;
    }
  ): Promise<void> {
    if (!reconciliation.reason || typeof reconciliation.reason !== 'string' || !reconciliation.reason.trim()) {
      throw new Error('reconcileUncertain requires a non-empty reason explaining the outcome');
    }

    if (reconciliation.observedUsage !== undefined) {
      const scripted = this.reconciliationUsage[requestId];
      if (!scripted || computeCanonicalSha256(scripted) !== computeCanonicalSha256(reconciliation.observedUsage)) throw new Error('Unscripted reconciliation evidence');
      await this.settle(requestId, reconciliation.observedUsage);
      const req = this.storedRequests.get(requestId);
      if (req) {
        this.storedRequests.set(requestId, {
          ...req,
          dispatchState: 'settled',
          observedUsage: reconciliation.observedUsage,
        });
      }
    } else {
      if (this.terminal.has(requestId)) throw new BudgetConflictError('Terminal request cannot become uncertain');
      if (![...this.ledgers.values()].some(ledger => ledger.reservations.some(res => res.keyedId === requestId))) throw new Error('Unknown reconciliation request');
      this.uncertain.add(requestId);
      const req = this.storedRequests.get(requestId);
      if (req) {
        this.storedRequests.set(requestId, {
          ...req,
          dispatchState: 'uncertain',
          uncertainReason: reconciliation.reason,
        });
      }
    }
  }

  async checkpoint(state: TaskState): Promise<void> {
    const val = validateTaskState(state);
    if (!val.ok) {
      throw new Error(`Invalid checkpoint state: ${val.errors.map((e) => e.message).join(', ')}`);
    }
    const prior = this.tasks.get(state.taskId);
    if (!prior) throw new Error('Checkpoint requires an existing task');
    if (computeCanonicalSha256(state.budgetLedgers) !== computeCanonicalSha256(this.getLedgers())) throw new StateConflictError('Stale checkpoint accounting');
    if (state.stateVersion === prior.stateVersion) {
      const current = {...prior, budgetLedgers: this.getLedgers()};
      if (computeCanonicalSha256(state) !== computeCanonicalSha256(current)) throw new StateConflictError('Conflicting same-version checkpoint');
      this.checkpoints.set(state.taskId, structuredClone(current));
      return;
    }
    await this.transition(state, prior.stateVersion);
    const saved = this.tasks.get(state.taskId);
    if (!saved) throw new Error('Missing transitioned task');
    this.checkpoints.set(state.taskId, structuredClone(saved));
  }

  async recover(taskId: string): Promise<TaskState> {
    const cp = this.checkpoints.get(taskId);
    if (!cp) {
      throw new Error(`No checkpoint found for task ${taskId}`);
    }

    const currentLedgers = this.getLedgers();
    const recovered: TaskState = {
      ...cp,
      budgetLedgers: currentLedgers.length > 0 ? currentLedgers : cp.budgetLedgers,
    };

    const val = validateTaskState(recovered);
    if (!val.ok) {
      throw new Error(`Recovered task state invalid: ${val.errors.map((e) => e.message).join(', ')}`);
    }
    return structuredClone(val.value);
  }
}

/* ------------------------------------------------------------------
 * UC-03 v0.2.0 StatePortV02 Neutral RED Scaffolding (T041)
 * ------------------------------------------------------------------ */

export const NEUTRAL_CLAIM_RECEIPT_V02: ClaimReceiptV02 = Object.freeze({
  claimId: '',
  claimDigest: '',
  taskId: '',
  runId: '',
  subjectKind: 'repository-action',
  planApplicability: 'pre-plan-diagnostic',
  preClaimTaskStateVersion: 0,
  preClaimControlVersion: 0,
  postClaimControlVersion: 0,
  epoch: 0,
  status: 'claimed',
  reservationRefs: Object.freeze([]),
});

export const NEUTRAL_ATTEMPT_RECEIPT_V02: AttemptReceiptV02 = Object.freeze({
  attemptId: '',
  claimId: '',
  taskId: '',
  executorIdentity: Object.freeze({
    adapterIdentity: '',
    processIncarnation: '',
    fencingGeneration: 0,
    payloadDigest: '',
  }),
  preAttemptTaskStateVersion: 0,
  postBeginTaskStateVersion: 0,
  preAttemptControlVersion: 0,
  postBeginControlVersion: 0,
  epoch: 0,
  status: 'attempting',
});

export const NEUTRAL_OUTCOME_RECORD_RESULT_V02: OutcomeRecordResultV02 = Object.freeze({
  outcome: 'uncertain',
  receiptId: '',
});

export const NEUTRAL_RECONCILIATION_RESULT_V02: ReconciliationResultV02 = Object.freeze({
  outcome: 'blocked',
  receiptId: '',
});

export const NEUTRAL_CLAIM_CLOSURE_RESULT_V02: ClaimClosureResultV02 = Object.freeze({
  closed: false,
  receiptId: '',
});

export function isNeutralClaimReceiptV02(receipt: ClaimReceiptV02): boolean {
  return receipt === NEUTRAL_CLAIM_RECEIPT_V02 || receipt.claimId === '' || receipt.claimDigest === '';
}

export function isNeutralAttemptReceiptV02(receipt: AttemptReceiptV02): boolean {
  return receipt === NEUTRAL_ATTEMPT_RECEIPT_V02 || receipt.attemptId === '' || receipt.claimId === '';
}

export function isNeutralOutcomeRecordResultV02(result: OutcomeRecordResultV02): boolean {
  return result === NEUTRAL_OUTCOME_RECORD_RESULT_V02 || (result.outcome === 'uncertain' && result.receiptId === '');
}

export function isNeutralReconciliationResultV02(result: ReconciliationResultV02): boolean {
  return result === NEUTRAL_RECONCILIATION_RESULT_V02 || (result.outcome === 'blocked' && result.receiptId === '');
}

export function isNeutralClaimClosureResultV02(result: ClaimClosureResultV02): boolean {
  return result === NEUTRAL_CLAIM_CLOSURE_RESULT_V02 || (!result.closed && result.receiptId === '');
}

interface StoredClaimRecordV02 {
  readonly receipt: ClaimReceiptV02;
  readonly context: AdmissionContextV02;
  readonly taskSnapshot: TaskState;
  readonly authorityRef: PolicyAuthorityRefV02;
  status: 'claimed' | 'attempting' | 'dispatched' | 'outcome-recorded' | 'settled' | 'uncertain' | 'observed-unsettled' | 'closed';
  attemptId?: string | undefined;
}

interface StoredAttemptRecordV02 {
  readonly receipt: AttemptReceiptV02;
  readonly claimId: string;
  status: 'attempting' | 'dispatched' | 'outcome-recorded' | 'settled' | 'uncertain' | 'observed-unsettled';
  outcomeReceiptId?: string | undefined;
}

export type MemoryTaskControlModeV02 = 'runnable' | 'paused' | 'rejected' | 'ended' | 'recovery';

export interface MemoryAuthorityPublicationReceiptV02 {
  readonly schemaVersion: 'uc05-approval/0.2-draft';
  readonly publicationId: string;
  readonly publicationDigest: string;
  readonly authorityRef: PolicyAuthorityRefV02;
  readonly generation: number;
  readonly status: 'published' | 'stale' | 'conflict';
}

export interface MemoryFenceProofV02 {
  readonly claimId: string;
  readonly claimDigest: string;
  readonly taskId: string;
  readonly recipientIdentity: ExecutorIdentityV02;
  readonly fencedExecutorIdentity: ExecutorIdentityV02;
  readonly fencingGeneration: number;
  readonly proofRef: SafeReferenceV02;
  readonly adapterEvidenceRefs: readonly SafeReferenceV02[];
  readonly holdRef: string;
  readonly controlVersion: number;
  readonly epoch: number;
}

export interface MemoryJournalSnapshotV02 {
  readonly controlVersion: number;
  readonly epoch: number;
  readonly mode: MemoryTaskControlModeV02;
  readonly holdRef: string | null;
  readonly holdEventDigest: string | null;
  readonly activeClaimId: string | null;
  readonly activeAuthorityRef: PolicyAuthorityRefV02 | null;
  readonly claims: readonly { readonly claimId: string; readonly status: string; readonly attemptId: string | null }[];
  readonly attempts: readonly { readonly attemptId: string; readonly claimId: string; readonly status: string; readonly outcomeReceiptId: string | null }[];
  readonly outcomes: readonly { readonly receiptId: string; readonly claimId: string; readonly attemptId: string; readonly outcome: string; readonly receiptDigest: string }[];
  readonly reconciliations: readonly { readonly reconciliationId: string; readonly claimId: string; readonly attemptId: string; readonly predecessorReceiptId: string; readonly receiptDigest: string }[];
  readonly closures: readonly { readonly receiptId: string; readonly claimId: string; readonly receiptDigest: string }[];
  readonly authorityPublications: readonly { readonly publicationId: string; readonly publicationDigest: string; readonly generation: number }[];
  readonly controlEventRefs: readonly string[];
  readonly fenceProofs: readonly { readonly claimId: string; readonly proofRef: SafeReferenceV02; readonly fencingGeneration: number; readonly holdRef: string; readonly controlVersion: number; readonly epoch: number }[];
  readonly recoveryEvidencePredecessorReceiptIds: readonly string[];
  readonly fencedIncarnations: readonly string[];
}

export interface MemoryRecoveryEvidenceV02 {
  readonly predecessorReceiptId: string;
  readonly effectEvidenceRef: SafeReferenceV02;
  readonly accountingEvidenceRefs: readonly SafeReferenceV02[];
  readonly observedUsage?: ProviderUsage | undefined;
  readonly observedRevisionDigest?: string | undefined;
  readonly invalidatedEvidence?: readonly SafeReferenceV02[] | undefined;
}

interface MemoryControlEventV02 {
  readonly eventRef: string;
  readonly taskId: string;
  readonly runId: string;
  readonly taskStateVersion: number;
  readonly eventKind: 'pause' | 'denial' | 'resume' | 'ended' | 'recovery';
  readonly mode: MemoryTaskControlModeV02;
  readonly controlVersion: number;
  readonly epoch: number;
  readonly digest: string;
}

interface MemoryReservationSpecV02 {
  readonly scope: 'task' | 'run';
  readonly kind: string;
  readonly amount: number;
  readonly reservationId: string;
  readonly keyedId: string;
}

export interface MemoryStatePortV02Options extends MemoryStatePortOptions {
  readonly initialControlVersion?: number | undefined;
  readonly initialEpoch?: number | undefined;
  readonly initialMode?: MemoryTaskControlModeV02 | undefined;
  readonly initialAuthorityRef?: PolicyAuthorityRefV02 | undefined;
}

export class MemoryStatePortV02 implements StatePortV02 {
  readonly provenance: PortProvenance = 'mock';
  private readonly underlying: MemoryStatePort;
  private readonly neutral: boolean;
  private currentControlVersion: number;
  private currentEpoch: number;
  private mode: MemoryTaskControlModeV02;
  private holdRef: string | null;
  private activeAuthorityRef: PolicyAuthorityRefV02 | null;
  private readonly claims = new Map<string, StoredClaimRecordV02>();
  private activeClaimId?: string | undefined;
  private readonly attempts = new Map<string, StoredAttemptRecordV02>();
  private readonly outcomeReceipts = new Map<string, AttemptOutcomeReceiptV02>();
  private readonly reconciliationReceipts = new Map<string, AttemptReconciliationReceiptV02>();
  private readonly claimClosureReceipts = new Map<string, ClaimClosureReceiptV02>();
  private readonly publications = new Map<string, MemoryAuthorityPublicationReceiptV02>();
  private readonly controlEvents = new Map<string, MemoryControlEventV02>();
  private readonly fenceProofs = new Map<string, MemoryFenceProofV02>();
  private readonly recoveryEvidence = new Map<string, MemoryRecoveryEvidenceV02>();
  private readonly fenceAfterAttempt = new Map<string, boolean>();
  private readonly fencedActors = new Map<string, number>();
  private readonly fencedIncarnationKeys = new Set<string>();
  private lockTail: Promise<void> = Promise.resolve();

  constructor(options?: MemoryStatePortV02Options) {
    this.underlying = new MemoryStatePort(options);
    this.neutral = options?.neutral ?? false;
    this.currentControlVersion = options?.initialControlVersion ?? 0;
    this.currentEpoch = options?.initialEpoch ?? 0;
    this.mode = options?.initialMode ?? 'runnable';
    this.holdRef = this.mode === 'runnable' ? null : 'initial-hold';
    this.activeAuthorityRef = options?.initialAuthorityRef ? structuredClone(options.initialAuthorityRef) : null;
    if (this.holdRef) {
      const initialTask = options?.initialTaskState;
      this.controlEvents.set(this.holdRef, this.controlEvent(
        this.holdRef,
        initialTask?.taskId ?? options?.currentTaskId ?? '',
        initialTask?.runId ?? '',
        initialTask?.stateVersion ?? 0,
        this.mode,
        this.currentControlVersion,
        this.currentEpoch,
      ));
    }
  }

  private async exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const prior = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); }
    finally { release(); }
  }

  getUnderlying(): MemoryStatePort {
    return this.underlying;
  }

  getJournalSnapshot(): MemoryJournalSnapshotV02 {
    return {
      controlVersion: this.currentControlVersion,
      epoch: this.currentEpoch,
      mode: this.mode,
      holdRef: this.holdRef,
      holdEventDigest: this.holdRef ? this.controlEvents.get(this.holdRef)?.digest ?? null : null,
      activeClaimId: this.activeClaimId ?? null,
      activeAuthorityRef: this.activeAuthorityRef ? structuredClone(this.activeAuthorityRef) : null,
      claims: [...this.claims.values()].map((claim) => ({ claimId: claim.receipt.claimId, status: claim.status, attemptId: claim.attemptId ?? null })),
      attempts: [...this.attempts.values()].map((attempt) => ({ attemptId: attempt.receipt.attemptId, claimId: attempt.claimId, status: attempt.status, outcomeReceiptId: attempt.outcomeReceiptId ?? null })),
      outcomes: [...this.outcomeReceipts.values()].map((receipt) => ({ receiptId: receipt.receiptId, claimId: receipt.claimId, attemptId: receipt.attemptId, outcome: receipt.outcome, receiptDigest: receipt.receiptDigest })),
      reconciliations: [...this.reconciliationReceipts.values()].map((receipt) => ({ reconciliationId: receipt.reconciliationId, claimId: receipt.claimId, attemptId: receipt.attemptId, predecessorReceiptId: receipt.predecessorReceiptId, receiptDigest: receipt.reconciliationDigest })),
      closures: [...this.claimClosureReceipts.values()].map((receipt) => ({ receiptId: receipt.receiptId, claimId: receipt.claimId, receiptDigest: receipt.receiptDigest })),
      authorityPublications: [...this.publications.values()].map((receipt) => ({ publicationId: receipt.publicationId, publicationDigest: receipt.publicationDigest, generation: receipt.generation })),
      controlEventRefs: [...this.controlEvents.keys()],
      fenceProofs: [...this.fenceProofs.values()].map((proof) => ({ claimId: proof.claimId, proofRef: structuredClone(proof.proofRef), fencingGeneration: proof.fencingGeneration, holdRef: proof.holdRef, controlVersion: proof.controlVersion, epoch: proof.epoch })),
      recoveryEvidencePredecessorReceiptIds: [...this.recoveryEvidence.keys()],
      fencedIncarnations: [...this.fencedIncarnationKeys].sort(),
    };
  }

  async publishAuthority(options: { readonly authorityRef: PolicyAuthorityRefV02; readonly effectiveAt?: string }): Promise<MemoryAuthorityPublicationReceiptV02> {
    let snapshot: typeof options;
    try { snapshot = structuredClone(options); }
    catch { return this.publicationReceipt({ policyId: '', policyVersion: '', configId: '', configVersion: '', issuerKeyRef: '', decisionAuthorityGeneration: 0 }, 'conflict'); }
    return this.exclusive(() => {
      const authorityRef = structuredClone(snapshot.authorityRef);
      if (!this.validAuthority(authorityRef)) return this.publicationReceipt(authorityRef, 'conflict');
      const publicationId = `pub-${authorityRef.policyId}-${authorityRef.decisionAuthorityGeneration}`;
      const prior = this.publications.get(publicationId);
      const publicationDigest = computeCanonicalSha256({ publicationId, authorityRef, effectiveAt: snapshot.effectiveAt });
      if (prior) return prior.publicationDigest === publicationDigest ? structuredClone(prior) : this.publicationReceipt(authorityRef, 'conflict');
      if (this.activeAuthorityRef && authorityRef.decisionAuthorityGeneration <= this.activeAuthorityRef.decisionAuthorityGeneration) {
        return this.publicationReceipt(authorityRef, 'stale');
      }
      const receipt: MemoryAuthorityPublicationReceiptV02 = {
        schemaVersion: 'uc05-approval/0.2-draft', publicationId, publicationDigest,
        authorityRef, generation: authorityRef.decisionAuthorityGeneration, status: 'published',
      };
      this.activeAuthorityRef = authorityRef;
      this.currentControlVersion++;
      this.publications.set(publicationId, structuredClone(receipt));
      return structuredClone(receipt);
    });
  }

  async setTaskControl(taskId: string, mode: MemoryTaskControlModeV02, eventRef: string): Promise<boolean> {
    return this.exclusive(async () => {
      if (typeof taskId !== 'string' || typeof eventRef !== 'string' || !['runnable', 'paused', 'rejected', 'ended', 'recovery'].includes(mode) || !eventRef.trim()) return false;
      const task = await this.underlying.loadTask(taskId);
      if (!task) return false;
      const prior = this.controlEvents.get(eventRef);
      if (prior) return prior.taskId === taskId && prior.mode === mode && this.mode === mode && (mode === 'runnable' ? this.holdRef === null : this.holdRef === eventRef);
      const alreadyCurrent = this.mode === mode && (mode === 'runnable' ? this.holdRef === null : this.holdRef === eventRef);
      if (!alreadyCurrent) {
        this.mode = mode;
        this.holdRef = mode === 'runnable' ? null : eventRef;
        this.currentControlVersion++;
      }
      this.controlEvents.set(eventRef, this.controlEvent(eventRef, taskId, task.runId, task.stateVersion, mode, this.currentControlVersion, this.currentEpoch));
      return true;
    });
  }

  private controlEvent(
    eventRef: string,
    taskId: string,
    runId: string,
    taskStateVersion: number,
    mode: MemoryTaskControlModeV02,
    controlVersion: number,
    epoch: number,
  ): MemoryControlEventV02 {
    const eventKind: MemoryControlEventV02['eventKind'] = mode === 'paused' ? 'pause'
      : mode === 'rejected' ? 'denial' : mode === 'runnable' ? 'resume'
        : mode === 'ended' ? 'ended' : 'recovery';
    const metadata = {
      schemaVersion: 'uc04-control-event/0.2-draft',
      taskId,
      runId,
      taskStateVersion,
      eventKind,
      mode,
      eventRef,
      controlVersion,
      epoch,
    };
    return { ...metadata, digest: computeCanonicalSha256(metadata) };
  }

  async fenceClaimRecipient(claimId: string, recipientIdentity: ExecutorIdentityV02): Promise<MemoryFenceProofV02 | null> {
    let identity: ExecutorIdentityV02;
    try { identity = structuredClone(recipientIdentity); } catch { return null; }
    return this.exclusive(() => this.fenceRecipient(claimId, identity, false));
  }

  async fenceAttemptRecipient(claimId: string, recipientIdentity: ExecutorIdentityV02): Promise<MemoryFenceProofV02 | null> {
    let identity: ExecutorIdentityV02;
    try { identity = structuredClone(recipientIdentity); } catch { return null; }
    return this.exclusive(() => this.fenceRecipient(claimId, identity, true));
  }

  async publishRecoveryEvidence(evidence: MemoryRecoveryEvidenceV02): Promise<boolean> {
    let snapshot: MemoryRecoveryEvidenceV02;
    try { snapshot = structuredClone(evidence); } catch { return false; }
    return this.exclusive(() => {
      const predecessor = this.outcomeReceipts.get(snapshot.predecessorReceiptId);
      const claim = predecessor && this.claims.get(predecessor.claimId);
      if (!predecessor || predecessor.outcome !== 'uncertain' || claim?.status !== 'uncertain' || !this.isValidRecoveryEvidence(snapshot)) return false;
      const frozen = structuredClone(snapshot);
      const prior = this.recoveryEvidence.get(snapshot.predecessorReceiptId);
      if (prior) return this.equal(prior, frozen);
      this.recoveryEvidence.set(snapshot.predecessorReceiptId, frozen);
      this.currentControlVersion++;
      return true;
    });
  }

  private publicationReceipt(authorityRef: PolicyAuthorityRefV02, status: 'stale' | 'conflict'): MemoryAuthorityPublicationReceiptV02 {
    const publicationId = `pub-${authorityRef.policyId}-${authorityRef.decisionAuthorityGeneration}`;
    return {
      schemaVersion: 'uc05-approval/0.2-draft', publicationId,
      publicationDigest: computeCanonicalSha256({ publicationId, authorityRef }),
      authorityRef: structuredClone(authorityRef), generation: authorityRef.decisionAuthorityGeneration, status,
    };
  }

  private validAuthority(ref: PolicyAuthorityRefV02): boolean {
    if (!ref || Object.getPrototypeOf(ref) !== Object.prototype || Object.keys(ref).length !== 6 ||
      Object.keys(ref).some((key) => !['policyId', 'policyVersion', 'configId', 'configVersion', 'issuerKeyRef', 'decisionAuthorityGeneration'].includes(key))) return false;
    return [ref.policyId, ref.policyVersion, ref.configId, ref.configVersion, ref.issuerKeyRef].every((value) => typeof value === 'string' && value.trim().length > 0) &&
      Number.isSafeInteger(ref.decisionAuthorityGeneration) && ref.decisionAuthorityGeneration > 0;
  }

  private equal(left: unknown, right: unknown): boolean {
    try { return computeCanonicalSha256(left) === computeCanonicalSha256(right); }
    catch { return false; }
  }

  private safeRef(ref: SafeReferenceV02): boolean {
    return Boolean(ref && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(ref.reference) && /^sha256:[0-9a-f]{64}$/u.test(ref.digest));
  }

  private validExecutorIdentity(value: unknown): value is ExecutorIdentityV02 {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 4 && Object.keys(record).every((key) => ['adapterIdentity', 'processIncarnation', 'fencingGeneration', 'payloadDigest'].includes(key)) &&
      typeof record['adapterIdentity'] === 'string' && !!record['adapterIdentity'].trim() &&
      typeof record['processIncarnation'] === 'string' && !!record['processIncarnation'].trim() &&
      Number.isSafeInteger(record['fencingGeneration']) && Number(record['fencingGeneration']) > 0 &&
      typeof record['payloadDigest'] === 'string' && /^sha256:[0-9a-f]{64}$/u.test(record['payloadDigest']);
  }

  private isValidRecoveryEvidence(evidence: MemoryRecoveryEvidenceV02): boolean {
    const predecessor = this.outcomeReceipts.get(evidence.predecessorReceiptId);
    const claim = predecessor && this.claims.get(predecessor.claimId);
    if (!claim || !this.safeRef(evidence.effectEvidenceRef) || !evidence.accountingEvidenceRefs.length || !evidence.accountingEvidenceRefs.every((ref) => this.safeRef(ref))) return false;
    if (claim.context.subjectKind === 'provider-request') {
      return evidence.observedUsage !== undefined && validateProviderUsage(evidence.observedUsage).ok &&
        evidence.observedRevisionDigest === undefined && evidence.invalidatedEvidence === undefined;
    }
    if (this.isRepositoryPatch(claim.context)) {
      if (evidence.observedUsage !== undefined || typeof evidence.observedRevisionDigest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/u.test(evidence.observedRevisionDigest) || !Array.isArray(evidence.invalidatedEvidence) ||
        !evidence.invalidatedEvidence.every((ref) => this.safeRef(ref)) ||
        new Set(evidence.invalidatedEvidence.map((ref) => ref.reference)).size !== evidence.invalidatedEvidence.length) return false;
      return evidence.effectEvidenceRef.digest === computeCanonicalSha256({
        schemaVersion: 'uc03-observed-patch-recovery/0.2-draft',
        predecessorReceiptId: evidence.predecessorReceiptId,
        observedRevisionDigest: evidence.observedRevisionDigest,
        invalidatedEvidence: evidence.invalidatedEvidence,
        accountingEvidenceRefs: evidence.accountingEvidenceRefs,
      });
    }
    return evidence.observedUsage === undefined && evidence.observedRevisionDigest === undefined && evidence.invalidatedEvidence === undefined;
  }

  private async fenceRecipient(claimId: string, recipient: ExecutorIdentityV02, afterAttempt: boolean): Promise<MemoryFenceProofV02 | null> {
    if (!this.validExecutorIdentity(recipient)) return null;
    const claim = this.claims.get(claimId);
    if (!claim) return null;
    const old = this.fenceProofs.get(claimId);
    if (old) {
      return this.fenceAfterAttempt.get(claimId) === afterAttempt &&
        this.equal(old.recipientIdentity, recipient) && old.claimDigest === claim.receipt.claimDigest && old.taskId === claim.receipt.taskId
        ? structuredClone(old)
        : null;
    }
    if (!this.holdRef || this.mode === 'runnable') return null;
    const expectedStatus = afterAttempt ? 'uncertain' : 'claimed';
    const attempt = claim.attemptId ? this.attempts.get(claim.attemptId) : undefined;
    if (claim.status !== expectedStatus || (afterAttempt && (!attempt || !this.equal(attempt.receipt.executorIdentity, recipient))) || (!afterAttempt && attempt)) return null;
    if (this.actorPayloadDigest(claim.context) !== recipient.payloadDigest || this.fencedIncarnationKeys.has(this.incarnationKey(recipient))) return null;
    const generation = Math.max(recipient.fencingGeneration + 1, (this.fencedActors.get(recipient.adapterIdentity) ?? 0) + 1);
    const fencedExecutorIdentity = { ...structuredClone(recipient), fencingGeneration: generation };
    const proofRef = this.makeRef(`fence-${claimId}`, { claimId, recipient, generation, holdRef: this.holdRef });
    const adapterEvidenceRefs = [this.makeRef(`adapter-fence-${claimId}`, { recipient, generation, holdRef: this.holdRef })];
    const proof: MemoryFenceProofV02 = {
      claimId, claimDigest: claim.receipt.claimDigest, taskId: claim.receipt.taskId,
      recipientIdentity: structuredClone(recipient), fencedExecutorIdentity,
      fencingGeneration: generation, proofRef, adapterEvidenceRefs,
      holdRef: this.holdRef, controlVersion: this.currentControlVersion + 1, epoch: this.currentEpoch,
    };
    this.fenceProofs.set(claimId, structuredClone(proof));
    this.fenceAfterAttempt.set(claimId, afterAttempt);
    this.fencedActors.set(recipient.adapterIdentity, generation);
    this.fencedIncarnationKeys.add(this.incarnationKey(recipient));
    this.currentControlVersion++;
    return structuredClone(proof);
  }

  private makeRef(reference: string, evidence: unknown): SafeReferenceV02 {
    return { reference, digest: computeCanonicalSha256(evidence) };
  }

  private incarnationKey(identity: ExecutorIdentityV02): string {
    return `${identity.adapterIdentity}\u0000${identity.processIncarnation}`;
  }

  private actorPayloadDigest(context: AdmissionContextV02): string {
    return context.subjectKind === 'repository-action' ? context.actionDigest : context.requestContentDigest;
  }

  private authorityFor(context: AdmissionContextV02): PolicyAuthorityRefV02 {
    if (context.subjectKind === 'repository-action') return context.policyAuthorityRef;
    return {
      policyId: context.providerIdentity.pricingPolicyId,
      policyVersion: context.providerIdentity.pricingPolicyVersion,
      configId: context.providerIdentity.configId,
      configVersion: context.providerIdentity.configVersion,
      issuerKeyRef: context.providerIdentity.issuerKeyRef,
      decisionAuthorityGeneration: context.providerIdentity.decisionAuthorityGeneration,
    };
  }

  private trustedAdmission(context: AdmissionContextV02): AdmissionTrustedContextV02 {
    return context.subjectKind === 'repository-action'
      ? createTestRepositoryAdmissionTrustedContextV02(context)
      : createTestProviderAdmissionTrustedContextV02(context);
  }

  private validateAdmission(context: AdmissionContextV02): boolean {
    try { return validateAdmissionV02(context, this.trustedAdmission(context)).ok; }
    catch { return false; }
  }

  private planDigest(task: TaskState): string | undefined {
    const plan = task.plan;
    if (!plan) return undefined;
    return computeCanonicalSha256({
      taskId: task.taskId, planVersion: plan.planVersion, strategyDigest: plan.strategyDigest,
      baselineRef: plan.baselineRef, evidenceRefs: plan.evidenceRefs,
      criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
      checkSetDigest: plan.checkSetDigest, decisionRef: plan.decisionRef,
    });
  }

  private contextMatchesTask(context: AdmissionContextV02, task: TaskState): boolean {
    if (!this.validateAdmission(context) || task.taskId !== context.taskId || task.runId !== context.runId ||
      task.stateVersion !== context.expectedTaskStateVersion || task.node !== context.runnableNode) return false;
    if (context.subjectKind === 'repository-action' &&
      (task.workspaceId !== context.workspaceId || task.repositoryId !== context.repositoryId || task.repositoryRevisionDigest !== context.canonicalRevision)) return false;
    if (context.planApplicability === 'pre-plan-diagnostic') {
      if (task.node !== 'Investigate' || task.plan !== undefined || task.activeDecisionId !== undefined) return false;
    } else if (!task.plan || task.plan.decisionRef !== context.planDecisionRef || task.activeDecisionId !== context.planDecisionRef || this.planDigest(task) !== context.planBindingDigest) return false;
    return true;
  }

  private taskSemantic(task: TaskState): Record<string, unknown> {
    const clone = structuredClone(task) as unknown as Record<string, unknown>;
    delete clone['stateVersion'];
    delete clone['budgetLedgers'];
    return clone;
  }

  private taskMatchesAttempt(claim: StoredClaimRecordV02, task: TaskState, isRepairPatch: boolean, expectedRevision?: string): boolean {
    const expected: TaskState = {
      ...structuredClone(claim.taskSnapshot),
      ...(isRepairPatch ? { node: 'Patch' as TaskNode } : {}),
      ...(expectedRevision !== undefined ? { repositoryRevisionDigest: expectedRevision } : {}),
    };
    return this.equal(this.taskSemantic(task), this.taskSemantic(expected));
  }

  private observedPatchTaskState(task: TaskState, invalidatedEvidence: readonly SafeReferenceV02[], revisionDigest: string, repairPatch: boolean): TaskState {
    const invalidatedRefs = new Set(invalidatedEvidence.map((reference) => reference.reference));
    return {
      ...task,
      ...(repairPatch ? { node: 'Verify' as TaskNode } : {}),
      stateVersion: task.stateVersion + 1,
      repositoryRevisionDigest: revisionDigest,
      evidenceRefs: task.evidenceRefs.filter((reference) => !invalidatedRefs.has(reference)),
      activeDecisionId: undefined,
      reviewRefs: [],
      latestReviewRef: undefined,
      budgetLedgers: [...this.underlying.getLedgers()],
    };
  }

  private isRepairPatch(context: AdmissionContextV02): boolean {
    return context.subjectKind === 'repository-action' && context.planApplicability === 'approved-plan' && context.action.kind === 'apply_patch';
  }

  private isDiagnosticPatch(context: AdmissionContextV02): boolean {
    return context.subjectKind === 'repository-action' && context.planApplicability === 'pre-plan-diagnostic' && context.action.kind === 'apply_patch';
  }

  private isRepositoryPatch(context: AdmissionContextV02): boolean {
    return this.isRepairPatch(context) || this.isDiagnosticPatch(context);
  }

  private reviewerIterationSpecs(context: AdmissionContextV02): readonly MemoryReservationSpecV02[] | null {
    if (context.subjectKind !== 'provider-request' || context.role !== 'reviewer') return [];
    const ledgers = this.underlying.getLedgers();
    const taskRows = ledgers.filter((ledger) => ledger.scope === 'task' && (ledger.kind === 'iteration' || ledger.kind === 'review_iteration'));
    const runRows = ledgers.filter((ledger) => ledger.scope === 'run' && (ledger.kind === 'iteration' || ledger.kind === 'review_iteration'));
    const maxReviewerIterations = context.finiteBounds.maxReviewerIterations;
    const taskLedger = taskRows[0];
    if (taskRows.length !== 1 || runRows.length > 1 || typeof maxReviewerIterations !== 'number' || !Number.isSafeInteger(maxReviewerIterations) || maxReviewerIterations <= 0 || !taskLedger) return null;
    const rows = [taskLedger, ...runRows];
    return rows.map((ledger, index) => ({
      scope: ledger.scope,
      kind: ledger.kind,
      amount: 1,
      reservationId: context.budgetRefs[index + 4] ?? '',
      keyedId: context.providerRequestId,
    }));
  }

  private providerSpecs(context: AdmissionContextV02): readonly MemoryReservationSpecV02[] | null {
    if (context.subjectKind !== 'provider-request' || new Set(context.budgetRefs).size !== context.budgetRefs.length) return null;
    const reviewerSpecs = this.reviewerIterationSpecs(context);
    if (!reviewerSpecs) return null;
    const expectedRefCount = 4 + reviewerSpecs.length;
    if (context.budgetRefs.length !== expectedRefCount) return null;
    const expected = [
      { scope: 'task', kind: 'tokens', amount: context.finiteBounds.maxBillableTokens },
      { scope: 'task', kind: 'cost', amount: context.finiteBounds.maxCostUsd },
      { scope: 'run', kind: 'tokens', amount: context.finiteBounds.maxBillableTokens },
      { scope: 'run', kind: 'cost', amount: context.finiteBounds.maxCostUsd },
    ] as const;
    const resolved = expected.map((item, index) => ({ ...item, reservationId: context.budgetRefs[index] as string, keyedId: context.providerRequestId }));
    // The protocol order is task tokens, task cost, run tokens, run cost.
    const ledgers = this.underlying.getLedgers();
    for (const spec of resolved) {
      const ledger = ledgers.find((candidate) => candidate.scope === spec.scope && candidate.kind === spec.kind);
      if (!ledger) return null;
    }
    if (reviewerSpecs.some((spec, index) => !spec.reservationId || spec.reservationId !== context.budgetRefs[index + 4])) return null;
    return [...resolved, ...reviewerSpecs];
  }

  private repositoryResourceSpecs(context: AdmissionContextV02): readonly MemoryReservationSpecV02[] | null {
    if (context.subjectKind !== 'repository-action' || context.action.kind !== 'run_command' || !context.finiteBounds) return null;
    const bounds = context.finiteBounds as unknown as Record<string, unknown>;
    const configuredKinds = ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'] as const;
    const order = new Map(configuredKinds.map((kind, index) => [kind, index]));
    const configured = this.underlying.getLedgers()
      .filter((ledger) => (ledger.scope === 'task' || ledger.scope === 'run') && order.has(ledger.kind as typeof configuredKinds[number]))
      .sort((left, right) => left.scope === right.scope
        ? (order.get(left.kind as typeof configuredKinds[number]) ?? 0) - (order.get(right.kind as typeof configuredKinds[number]) ?? 0)
        : left.scope === 'task' ? -1 : 1);
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
    return specs.every((spec) => Number.isFinite(spec.amount) && spec.amount > 0) ? specs : null;
  }

  private stageReservation(
    ledger: BudgetLedger | undefined,
    spec: { readonly reservationId: string; readonly keyedId: string; readonly amount: number },
    operation: 'reserve' | 'consume' | 'settle' | 'release',
    usage?: ProviderUsage,
  ): BudgetLedger | null {
    if (!ledger) return null;
    const matching = ledger.reservations.filter((item) => item.reservationId === spec.reservationId || item.keyedId === spec.keyedId);
    if (operation === 'reserve') {
      if (matching.length) return null;
      const reserved = ledger.reservations.reduce((sum, item) => sum + item.amount, 0);
      if (ledger.limit - ledger.consumed - reserved < spec.amount) return null;
      const candidate = { ...ledger, reservations: [...ledger.reservations, { reservationId: spec.reservationId, keyedId: spec.keyedId, amount: spec.amount }], version: ledger.version + 1 };
      return validateBudgetLedger(candidate).ok ? candidate : null;
    }
    if (matching.length !== 1 || matching[0]?.reservationId !== spec.reservationId || matching[0]?.keyedId !== spec.keyedId || matching[0]?.amount !== spec.amount) return null;
    const increment = operation === 'consume' ? spec.amount
      : operation === 'settle' ? usage === undefined ? spec.amount : ledger.kind === 'cost' ? usage.costUsd : usage.billableTokens ?? (usage.inputTokens + usage.outputTokens)
        : 0;
    if (increment === undefined || (operation === 'settle' && increment > spec.amount) || ledger.consumed + increment > ledger.limit) return null;
    const candidate = {
      ...ledger,
      consumed: ledger.consumed + increment,
      reservations: ledger.reservations.filter((item) => item.reservationId !== spec.reservationId),
      version: ledger.version + 1,
    };
    return validateBudgetLedger(candidate).ok ? candidate : null;
  }

  private stageClaimReservations(
    context: AdmissionContextV02,
    operation: 'reserve' | 'settle' | 'release',
    usage?: ProviderUsage,
    releaseUnattempted = false,
  ): Map<string, BudgetLedger> | null {
    const staged = new Map<string, BudgetLedger>();
    const add = (spec: MemoryReservationSpecV02, stageOperation = operation): boolean => {
      const { scope, kind, reservationId, keyedId, amount } = spec;
      const key = `${scope}:${kind}`;
      const ledger = staged.get(key) ?? this.underlying.getLedgers().find((item) => item.scope === scope && item.kind === kind);
      const next = this.stageReservation(ledger, { reservationId, keyedId, amount }, stageOperation, usage);
      if (!next) return false;
      staged.set(key, next);
      return true;
    };
    if (context.subjectKind === 'provider-request') {
      const specs = this.providerSpecs(context);
      if (!specs) return null;
      const iterationSpecs = specs.filter((spec) => spec.kind === 'iteration' || spec.kind === 'review_iteration');
      const budgetSpecs = specs.filter((spec) => spec.kind === 'tokens' || spec.kind === 'cost');
      const operationSpecs = operation === 'reserve' || (operation === 'release' && releaseUnattempted)
        ? [...budgetSpecs, ...iterationSpecs]
        : budgetSpecs;
      if (operation === 'reserve') {
        const allReservations = this.underlying.getLedgers().flatMap((ledger) => ledger.reservations);
        if (operationSpecs.some((spec) => allReservations.some((reservation) => reservation.reservationId === spec.reservationId || reservation.keyedId === spec.keyedId))) return null;
        if (iterationSpecs.some((spec) => {
          const ledger = this.underlying.getLedgers().find((item) => item.scope === spec.scope && item.kind === spec.kind);
          const reserved = ledger?.reservations.reduce((sum, item) => sum + item.amount, 0) ?? 0;
          return !ledger || ledger.consumed + reserved + spec.amount > (context.finiteBounds.maxReviewerIterations ?? 0);
        })) return null;
      } else {
        const allLedgers = this.underlying.getLedgers();
        const allMatching = allLedgers.flatMap((ledger) => ledger.reservations.filter((reservation) => reservation.keyedId === context.providerRequestId || context.budgetRefs.includes(reservation.reservationId))
          .map((reservation) => ({ scope: ledger.scope, kind: ledger.kind, ...reservation })));
        if (allMatching.length !== operationSpecs.length || operationSpecs.some((spec) => !allMatching.some((reservation) =>
          reservation.scope === spec.scope && reservation.kind === spec.kind && reservation.reservationId === spec.reservationId &&
          reservation.keyedId === spec.keyedId && reservation.amount === spec.amount))) return null;
      }
      for (const spec of operationSpecs) if (!add(spec)) return null;
    } else if (this.isRepairPatch(context)) {
      if (context.reservationRefs.length !== 1 || !add({ scope: 'task', kind: 'repair', reservationId: context.reservationRefs[0] as string, keyedId: context.action.actionId, amount: 1 })) return null;
    } else if (context.action.kind === 'run_command') {
      const specs = this.repositoryResourceSpecs(context);
      if (!specs) return null;
      const allLedgers = this.underlying.getLedgers();
      if (operation === 'reserve') {
        const allReservations = allLedgers.flatMap((ledger) => ledger.reservations);
        if (specs.some((spec) => allReservations.some((reservation) => reservation.reservationId === spec.reservationId || reservation.keyedId === spec.keyedId))) return null;
      } else {
        const allMatching = allLedgers.flatMap((ledger) => ledger.reservations.filter((reservation) => reservation.keyedId === context.action.actionId || context.reservationRefs.includes(reservation.reservationId))
          .map((reservation) => ({ scope: ledger.scope, kind: ledger.kind, ...reservation })));
        if (allMatching.length !== specs.length || specs.some((spec) => !allMatching.some((reservation) =>
          reservation.scope === spec.scope && reservation.kind === spec.kind && reservation.reservationId === spec.reservationId &&
          reservation.keyedId === spec.keyedId && reservation.amount === spec.amount))) return null;
      }
      for (const spec of specs) if (!add(spec)) return null;
    }
    return staged;
  }

  private commitLedgers(staged: ReadonlyMap<string, BudgetLedger>): void {
    for (const ledger of staged.values()) this.underlying.internalSetLedger(ledger);
  }

  private releaseClaimReservations(claim: StoredClaimRecordV02): Map<string, BudgetLedger> | null {
    return this.stageClaimReservations(claim.context, 'release', undefined, true);
  }

  private outcomeContext(claim: StoredClaimRecordV02, attempt: StoredAttemptRecordV02, task: TaskState): AttemptOutcomeValidationContextV02 {
    return {
      trustedAdmission: claim.context, trustedClaim: claim.receipt, trustedAttempt: attempt.receipt,
      currentClaimStatus: 'attempting', currentTaskStateVersion: task.stateVersion,
      currentControlVersion: this.currentControlVersion, currentEpoch: this.currentEpoch,
    };
  }

  private reconciliationContext(
    claim: StoredClaimRecordV02,
    attempt: StoredAttemptRecordV02,
    predecessor: AttemptOutcomeReceiptV02,
    receipt: AttemptReconciliationReceiptV02,
    task: TaskState,
    evidenceRefs: readonly SafeReferenceV02[],
    evidence?: MemoryRecoveryEvidenceV02,
    fence?: MemoryFenceProofV02,
  ): AttemptReconciliationValidationContextV02 {
    const status = receipt.reconciliationKind === 'uncertain-attempt' ? 'uncertain' : 'observed-unsettled';
    return {
      trustedAdmission: claim.context, trustedClaim: claim.receipt, currentClaimStatus: status,
      predecessorJournalStatus: status, trustedAttempt: attempt.receipt, trustedPredecessor: predecessor,
      predecessorReceiptDigest: predecessor.receiptDigest, currentTaskStateVersion: task.stateVersion,
      currentControlVersion: this.currentControlVersion, currentEpoch: this.currentEpoch,
      trustedEvidenceRefs: evidenceRefs,
      trustedAccountingIdentityDigest: computeCanonicalSha256({ predecessorReceiptDigest: predecessor.receiptDigest, reservationRefs: claim.receipt.reservationRefs }),
      ...(evidence ? {
        trustedObservedEffectRef: evidence.effectEvidenceRef,
        trustedAccountingEvidenceRefs: evidence.accountingEvidenceRefs,
        ...(evidence.observedUsage ? { trustedObservedUsage: evidence.observedUsage } : {}),
      } : {}),
      ...(fence ? { trustedFencingProof: {
        fencedRecipientIdentity: fence.recipientIdentity,
        fencingGeneration: fence.fencingGeneration,
        proofRef: fence.proofRef,
      } } : {}),
    };
  }

  getLedgers(): readonly BudgetLedger[] {
    return this.underlying.getLedgers();
  }

  getLedgerIdentities(): readonly string[] {
    return this.underlying.getLedgerIdentities();
  }

  getReservationIds(): Readonly<Record<string, string>> {
    return this.underlying.getReservationIds();
  }

  getStoredRequests(): readonly ProviderRequest[] {
    return this.underlying.getStoredRequests();
  }

  async loadTask(taskId: string): Promise<TaskState | null> {
    return this.underlying.loadTask(taskId);
  }

  async transition(state: TaskState, expectedVersion: number): Promise<TaskState> {
    const snapshot = structuredClone(state);
    return this.exclusive(() => this.underlying.transition(snapshot, expectedVersion));
  }

  async checkpoint(state: TaskState): Promise<void> {
    const snapshot = structuredClone(state);
    return this.exclusive(() => this.underlying.checkpoint(snapshot));
  }

  async recover(taskId: string): Promise<TaskState> {
    return this.underlying.recover(taskId);
  }

  async claim(context: AdmissionContextV02): Promise<ClaimReceiptV02> {
    let snapshot: AdmissionContextV02;
    try { snapshot = structuredClone(context); } catch { return NEUTRAL_CLAIM_RECEIPT_V02; }
    return this.exclusive(async () => {
      context = snapshot;
      if (this.neutral || this.mode !== 'runnable' || !this.validateAdmission(context)) return NEUTRAL_CLAIM_RECEIPT_V02;
      if (this.activeClaimId) {
        const active = this.claims.get(this.activeClaimId);
        if (active && active.status !== 'settled' && active.status !== 'closed') {
          return this.equal(context, active.context) && active.status === 'claimed' ? structuredClone(active.receipt) : NEUTRAL_CLAIM_RECEIPT_V02;
        }
      }
      const task = await this.underlying.loadTask(context.taskId);
      if (!task || !this.contextMatchesTask(context, task) || this.currentControlVersion !== context.expectedControlVersion || this.currentEpoch !== context.expectedEpoch) return NEUTRAL_CLAIM_RECEIPT_V02;
      const authorityRef = this.authorityFor(context);
      if (!this.activeAuthorityRef || !this.equal(this.activeAuthorityRef, authorityRef)) return NEUTRAL_CLAIM_RECEIPT_V02;

      const subjectId = context.subjectKind === 'repository-action' ? context.action.actionId : context.providerRequestId;
      const claimId = `claim-${subjectId}`;
      const existing = this.claims.get(claimId);
      if (existing) return existing.status === 'claimed' && this.equal(existing.context, context) ? structuredClone(existing.receipt) : NEUTRAL_CLAIM_RECEIPT_V02;
      const staged = this.stageClaimReservations(context, 'reserve');
      if (!staged) return NEUTRAL_CLAIM_RECEIPT_V02;
      const postClaimControlVersion = this.currentControlVersion + 1;
      const progression = validateProtocolVersionProgressionV02({
        kind: 'claim', pre: { taskStateVersion: task.stateVersion, controlVersion: this.currentControlVersion, epoch: this.currentEpoch },
        post: { taskStateVersion: task.stateVersion, controlVersion: postClaimControlVersion, epoch: this.currentEpoch },
      });
      if (!progression.ok) return NEUTRAL_CLAIM_RECEIPT_V02;
      const reservationRefs = context.subjectKind === 'repository-action' ? [...context.reservationRefs] : [context.requestReservationReceipt, ...context.budgetRefs];
      const rawReceipt: ClaimReceiptV02 = {
        claimId, claimDigest: '', taskId: context.taskId, runId: context.runId,
        subjectKind: context.subjectKind, planApplicability: context.planApplicability,
        preClaimTaskStateVersion: task.stateVersion, preClaimControlVersion: this.currentControlVersion,
        postClaimControlVersion, epoch: this.currentEpoch, status: 'claimed', reservationRefs,
      };
      const claimReceipt: ClaimReceiptV02 = { ...rawReceipt, claimDigest: computeCanonicalSha256({ ...rawReceipt, claimDigest: undefined }) };
      this.commitLedgers(staged);
      this.currentControlVersion = postClaimControlVersion;
      this.claims.set(claimId, {
        receipt: structuredClone(claimReceipt), context: structuredClone(context), taskSnapshot: structuredClone(task),
        authorityRef: structuredClone(authorityRef), status: 'claimed',
      });
      this.activeClaimId = claimId;
      return structuredClone(claimReceipt);
    });
  }

  async beginAttempt(claimId: string, executor: ExecutorIdentityV02): Promise<AttemptReceiptV02> {
    let actor: ExecutorIdentityV02;
    try { actor = structuredClone(executor); } catch { return NEUTRAL_ATTEMPT_RECEIPT_V02; }
    if (!this.validExecutorIdentity(actor)) return NEUTRAL_ATTEMPT_RECEIPT_V02;
    return this.exclusive(async () => {
      executor = actor;
      if (this.neutral) return NEUTRAL_ATTEMPT_RECEIPT_V02;
      const claim = this.claims.get(claimId);
      if (!claim || claim.status !== 'claimed' || this.activeClaimId !== claimId || this.mode !== 'runnable' ||
        this.currentEpoch !== claim.receipt.epoch || this.currentControlVersion !== claim.receipt.postClaimControlVersion ||
        !this.activeAuthorityRef || !this.equal(this.activeAuthorityRef, claim.authorityRef)) return NEUTRAL_ATTEMPT_RECEIPT_V02;
      const minGeneration = this.fencedActors.get(executor.adapterIdentity) ?? 0;
      if (this.fencedIncarnationKeys.has(this.incarnationKey(executor)) || executor.fencingGeneration < Math.max(1, minGeneration) ||
        executor.payloadDigest !== this.actorPayloadDigest(claim.context)) return NEUTRAL_ATTEMPT_RECEIPT_V02;
      const task = await this.underlying.loadTask(claim.receipt.taskId);
      if (!task || !this.contextMatchesTask(claim.context, task) || !this.equal(this.taskSemantic(task), this.taskSemantic(claim.taskSnapshot))) return NEUTRAL_ATTEMPT_RECEIPT_V02;

      const repairPatch = this.isRepairPatch(claim.context);
      const nextTaskVersion = task.stateVersion + (repairPatch ? 1 : 0);
      const nextControlVersion = this.currentControlVersion + 1;
      const progression = validateProtocolVersionProgressionV02({
        kind: 'begin-attempt', isRepairPatch: repairPatch,
        pre: { taskStateVersion: task.stateVersion, controlVersion: this.currentControlVersion, epoch: this.currentEpoch },
        post: { taskStateVersion: nextTaskVersion, controlVersion: nextControlVersion, epoch: this.currentEpoch },
      });
      if (!progression.ok) return NEUTRAL_ATTEMPT_RECEIPT_V02;

      const attemptId = `att-${claimId}`;
      const receipt: AttemptReceiptV02 = {
        attemptId, claimId, taskId: claim.receipt.taskId, executorIdentity: structuredClone(executor),
        preAttemptTaskStateVersion: task.stateVersion, postBeginTaskStateVersion: nextTaskVersion,
        preAttemptControlVersion: this.currentControlVersion, postBeginControlVersion: nextControlVersion,
        epoch: this.currentEpoch, status: 'attempting',
      };
      if (!validateAttemptReceiptV02(receipt, {
        expectedTaskId: claim.receipt.taskId, expectedClaimId: claimId, expectedAttemptId: attemptId,
        expectedEpoch: this.currentEpoch, isRepairPatch: repairPatch,
      }).ok) return NEUTRAL_ATTEMPT_RECEIPT_V02;

      const staged = new Map<string, BudgetLedger>();
      if (repairPatch) {
        if (claim.context.subjectKind !== 'repository-action') return NEUTRAL_ATTEMPT_RECEIPT_V02;
        const ledger = this.underlying.getLedgers().find((item) => item.scope === 'task' && item.kind === 'repair');
        const next = this.stageReservation(ledger, { reservationId: claim.context.reservationRefs[0] ?? '', keyedId: claim.context.action.actionId, amount: 1 }, 'consume');
        if (!next) return NEUTRAL_ATTEMPT_RECEIPT_V02;
        staged.set('task:repair', next);
      }
      if (claim.context.subjectKind === 'provider-request' && claim.context.role === 'reviewer') {
        const iterationSpecs = this.reviewerIterationSpecs(claim.context);
        if (!iterationSpecs?.length) return NEUTRAL_ATTEMPT_RECEIPT_V02;
        for (const spec of iterationSpecs) {
          const key = `${spec.scope}:${spec.kind}`;
          const ledger = staged.get(key) ?? this.underlying.getLedgers().find((item) => item.scope === spec.scope && item.kind === spec.kind);
          const next = this.stageReservation(ledger, spec, 'consume');
          if (!next) return NEUTRAL_ATTEMPT_RECEIPT_V02;
          staged.set(key, next);
        }
      }
      let nextTask: TaskState | undefined;
      if (repairPatch) {
        nextTask = { ...task, node: 'Patch', stateVersion: nextTaskVersion, budgetLedgers: [...this.underlying.getLedgers()] };
        if (!validateTaskState(nextTask).ok) return NEUTRAL_ATTEMPT_RECEIPT_V02;
      }
      this.commitLedgers(staged);
      if (nextTask) this.underlying.internalSetTask({ ...nextTask, budgetLedgers: [...this.underlying.getLedgers()] });
      this.currentControlVersion = nextControlVersion;
      claim.status = 'attempting';
      claim.attemptId = attemptId;
      this.attempts.set(attemptId, { receipt: structuredClone(receipt), claimId, status: 'attempting' });
      return structuredClone(receipt);
    });
  }

  async recordOutcome(receipt: AttemptOutcomeReceiptV02): Promise<OutcomeRecordResultV02> {
    let snapshot: AttemptOutcomeReceiptV02;
    try { snapshot = structuredClone(receipt); } catch { return NEUTRAL_OUTCOME_RECORD_RESULT_V02; }
    if (!snapshot || typeof snapshot !== 'object') return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
    return this.exclusive(async () => {
      receipt = snapshot;
      if (this.neutral) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
      const priorReceipt = this.outcomeReceipts.get(receipt.receiptId);
      if (priorReceipt) return this.equal(priorReceipt, receipt) ? { outcome: 'already-recorded', receiptId: receipt.receiptId } : NEUTRAL_OUTCOME_RECORD_RESULT_V02;
      const attempt = this.attempts.get(receipt.attemptId);
      const claim = this.claims.get(receipt.claimId);
      if (!attempt || attempt.claimId !== receipt.claimId || !claim || claim.status !== 'attempting' || claim.attemptId !== attempt.receipt.attemptId ||
        attempt.status !== 'attempting' || attempt.outcomeReceiptId !== undefined || this.currentEpoch !== claim.receipt.epoch) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
      const task = await this.underlying.loadTask(claim.receipt.taskId);
      if (!task || !validateAttemptOutcomeReceiptV02(receipt, this.outcomeContext(claim, attempt, task)).ok || receipt.outcome === 'proven-not-dispatched') return NEUTRAL_OUTCOME_RECORD_RESULT_V02;

      let stagedLedgers = new Map<string, BudgetLedger>();
      if (receipt.outcome === 'observed' && receipt.subjectKind === 'provider-request') {
        if (!receipt.observedUsage || !validateProviderUsage(receipt.observedUsage).ok) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
        const budgetRefs = claim.context.subjectKind === 'provider-request' ? claim.context.budgetRefs : [];
        const specs = this.providerSpecs(claim.context);
        if (!specs || specs.some((spec) => !budgetRefs.includes(spec.reservationId))) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
        const settled = this.stageClaimReservations(claim.context, 'settle', receipt.observedUsage);
        if (!settled) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
        stagedLedgers = settled;
      } else if (receipt.outcome === 'observed' && receipt.subjectKind === 'repository-action' && receipt.repositoryOperation === 'run-command') {
        const settled = this.stageClaimReservations(claim.context, 'settle');
        if (!settled) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
        stagedLedgers = settled;
      }

      let nextTask: TaskState | undefined;
      let isUnsettled = false;
      if (receipt.outcome === 'observed' && receipt.subjectKind === 'repository-action') {
        const transition = receipt.proposedEffects.taskTransition;
        const repairPatch = this.isRepairPatch(claim.context);
        const diagnosticPatch = this.isDiagnosticPatch(claim.context);
        const expectedFromNode = repairPatch ? 'Patch' : claim.context.runnableNode;
        const expectedToNode = repairPatch ? 'Verify' : undefined;
        if (repairPatch && (transition.kind !== 'transition' || transition.fromNode !== expectedFromNode || transition.toNode !== expectedToNode)) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
        if (diagnosticPatch && transition.kind !== 'none') return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
        if (!repairPatch && transition.kind === 'transition') return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
        const expectedRevision = claim.taskSnapshot.repositoryRevisionDigest;
        if (task.stateVersion !== attempt.receipt.postBeginTaskStateVersion || !this.taskMatchesAttempt(claim, task, repairPatch, expectedRevision)) {
          isUnsettled = true;
        } else if (this.isRepositoryPatch(claim.context)) {
          if (!receipt.observedResultRevisionDigest) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
          nextTask = this.observedPatchTaskState(task, receipt.proposedEffects.invalidatedEvidence, receipt.observedResultRevisionDigest, repairPatch);
          if (!validateTaskState(nextTask).ok) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
        }
      }

      this.commitLedgers(stagedLedgers);
      if (nextTask) this.underlying.internalSetTask({ ...nextTask, budgetLedgers: [...this.underlying.getLedgers()] });
      this.outcomeReceipts.set(receipt.receiptId, structuredClone(receipt));
      attempt.outcomeReceiptId = receipt.receiptId;
      if (receipt.outcome === 'uncertain') {
        claim.status = 'uncertain';
        attempt.status = 'uncertain';
        this.currentControlVersion++;
        return { outcome: 'uncertain', receiptId: receipt.receiptId };
      }
      if (isUnsettled) {
        claim.status = 'observed-unsettled';
        attempt.status = 'observed-unsettled';
        this.currentControlVersion++;
        return { outcome: 'recorded-unsettled', receiptId: receipt.receiptId };
      }
      claim.status = 'settled';
      attempt.status = 'settled';
      this.currentControlVersion++;
      if (this.activeClaimId === receipt.claimId) this.activeClaimId = undefined;
      return { outcome: 'settled', receiptId: receipt.receiptId };
    });
  }

  async reconcileObservedOutcome(receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02> {
    let snapshot: AttemptReconciliationReceiptV02;
    try { snapshot = structuredClone(receipt); } catch { return NEUTRAL_RECONCILIATION_RESULT_V02; }
    if (!snapshot || typeof snapshot !== 'object') return NEUTRAL_RECONCILIATION_RESULT_V02;
    return this.exclusive(async () => {
      receipt = snapshot;
      if (this.neutral) return NEUTRAL_RECONCILIATION_RESULT_V02;
      const replay = this.reconciliationReplay(receipt);
      if (replay) return replay;
      const predecessor = this.outcomeReceipts.get(receipt.predecessorReceiptId);
      const claim = this.claims.get(receipt.claimId);
      const attempt = claim?.attemptId ? this.attempts.get(claim.attemptId) : undefined;
      if (!predecessor || predecessor.outcome !== 'observed' || predecessor.receiptDigest !== receipt.predecessorReceiptDigest ||
        !claim || claim.status !== 'observed-unsettled' || claim.attemptId !== receipt.attemptId || !attempt || attempt.outcomeReceiptId !== predecessor.receiptId ||
        this.currentEpoch !== claim.receipt.epoch) return { outcome: 'conflict', receiptId: receipt.reconciliationId };
      const task = await this.underlying.loadTask(claim.receipt.taskId);
      if (!task) return { outcome: 'conflict', receiptId: receipt.reconciliationId };
      const evidenceRefs = predecessor.evidenceRefs;
      const validation = validateAttemptReconciliationReceiptV02(receipt, this.reconciliationContext(claim, attempt, predecessor, receipt, task, evidenceRefs));
      if (!validation.ok) return { outcome: 'conflict', receiptId: receipt.reconciliationId };

      const repairPatch = this.isRepairPatch(claim.context);
      const diagnosticPatch = this.isDiagnosticPatch(claim.context);
      let nextTask: TaskState | undefined;
      if (repairPatch || diagnosticPatch) {
        if (claim.context.subjectKind !== 'repository-action' || predecessor.subjectKind !== 'repository-action') return { outcome: 'conflict', receiptId: receipt.reconciliationId };
        const transition = predecessor.proposedEffects.taskTransition;
        const resultRevision = predecessor.observedResultRevisionDigest;
        const transitionMatches = repairPatch
          ? transition.kind === 'transition' && transition.fromNode === 'Patch' && transition.toNode === 'Verify'
          : transition.kind === 'none';
        if (!resultRevision || !transitionMatches ||
          !this.taskMatchesAttempt(claim, task, repairPatch, resultRevision)) return { outcome: 'conflict', receiptId: receipt.reconciliationId };
        nextTask = this.observedPatchTaskState(task, predecessor.proposedEffects.invalidatedEvidence, resultRevision, repairPatch);
        if (!validateTaskState(nextTask).ok) return { outcome: 'conflict', receiptId: receipt.reconciliationId };
      } else if (!this.taskMatchesAttempt(claim, task, false, claim.taskSnapshot.repositoryRevisionDigest)) {
        return { outcome: 'conflict', receiptId: receipt.reconciliationId };
      }

      let staged = new Map<string, BudgetLedger>();
      if (claim.context.subjectKind === 'repository-action' && claim.context.action.kind === 'run_command') {
        const settled = this.stageClaimReservations(claim.context, 'settle');
        if (!settled) return { outcome: 'conflict', receiptId: receipt.reconciliationId };
        staged = settled;
      }
      this.commitLedgers(staged);
      if (nextTask) this.underlying.internalSetTask({ ...nextTask, budgetLedgers: [...this.underlying.getLedgers()] });
      this.currentControlVersion++;
      claim.status = 'settled';
      attempt.status = 'settled';
      if (this.activeClaimId === receipt.claimId) this.activeClaimId = undefined;
      this.reconciliationReceipts.set(receipt.reconciliationId, structuredClone(receipt));
      return { outcome: 'settled', receiptId: receipt.reconciliationId };
    });
  }

  async reconcileUncertain(receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02> {
    let snapshot: AttemptReconciliationReceiptV02;
    try { snapshot = structuredClone(receipt); } catch { return NEUTRAL_RECONCILIATION_RESULT_V02; }
    if (!snapshot || typeof snapshot !== 'object') return NEUTRAL_RECONCILIATION_RESULT_V02;
    return this.exclusive(async () => {
      receipt = snapshot;
      if (this.neutral) return NEUTRAL_RECONCILIATION_RESULT_V02;
      const replay = this.reconciliationReplay(receipt);
      if (replay) return replay;
      const predecessor = this.outcomeReceipts.get(receipt.predecessorReceiptId);
      const claim = this.claims.get(receipt.claimId);
      const attempt = claim?.attemptId ? this.attempts.get(claim.attemptId) : undefined;
      if (!predecessor || predecessor.outcome !== 'uncertain' || predecessor.receiptDigest !== receipt.predecessorReceiptDigest ||
        !claim || claim.status !== 'uncertain' || claim.attemptId !== receipt.attemptId || !attempt || attempt.outcomeReceiptId !== predecessor.receiptId ||
        this.currentEpoch !== claim.receipt.epoch) return { outcome: 'conflict', receiptId: receipt.reconciliationId };
      const task = await this.underlying.loadTask(claim.receipt.taskId);
      if (!task) return { outcome: 'conflict', receiptId: receipt.reconciliationId };
      const data = receipt as unknown as Record<string, unknown>;
      const disposition = data['disposition'];
      const evidence = disposition === 'observed-and-accounted' ? this.recoveryEvidence.get(predecessor.receiptId) : undefined;
      const fence = this.fenceProofs.get(claim.receipt.claimId);
      if (!fence || (disposition === 'observed-and-accounted' && !evidence)) return { outcome: 'conflict', receiptId: receipt.reconciliationId };
      if (fence.holdRef !== this.holdRef || this.mode === 'runnable') return { outcome: 'blocked', receiptId: receipt.reconciliationId };
      const trustedEvidence = evidence
        ? [evidence.effectEvidenceRef, ...evidence.accountingEvidenceRefs]
        : fence.adapterEvidenceRefs;
      const validation = validateAttemptReconciliationReceiptV02(receipt, this.reconciliationContext(claim, attempt, predecessor, receipt, task, trustedEvidence, evidence, fence));
      if (!validation.ok) return { outcome: 'conflict', receiptId: receipt.reconciliationId };

      let staged = new Map<string, BudgetLedger>();
      let nextTask: TaskState | undefined;
      if (claim.context.subjectKind === 'provider-request') {
        if (disposition === 'observed-and-accounted') {
          if (!evidence?.observedUsage) return { outcome: 'conflict', receiptId: receipt.reconciliationId };
          const next = this.stageClaimReservations(claim.context, 'settle', evidence.observedUsage);
          if (!next) return { outcome: 'conflict', receiptId: receipt.reconciliationId };
          staged = next;
        } else if (disposition === 'proven-not-dispatched') {
          const next = this.stageClaimReservations(claim.context, 'release');
          if (!next) return { outcome: 'conflict', receiptId: receipt.reconciliationId };
          staged = next;
        }
      } else if (disposition === 'observed-and-accounted') {
        const repairPatch = this.isRepairPatch(claim.context);
        if (this.isRepositoryPatch(claim.context)) {
          if (!evidence?.observedRevisionDigest || !evidence.invalidatedEvidence ||
            !this.taskMatchesAttempt(claim, task, repairPatch, claim.taskSnapshot.repositoryRevisionDigest)) {
            return { outcome: 'blocked', receiptId: receipt.reconciliationId };
          }
          nextTask = this.observedPatchTaskState(task, evidence.invalidatedEvidence, evidence.observedRevisionDigest, repairPatch);
          if (!validateTaskState(nextTask).ok) return { outcome: 'conflict', receiptId: receipt.reconciliationId };
        } else if (!this.taskMatchesAttempt(claim, task, false, claim.taskSnapshot.repositoryRevisionDigest)) {
          return { outcome: 'blocked', receiptId: receipt.reconciliationId };
        }
        if (claim.context.action.kind === 'run_command') {
          const next = this.stageClaimReservations(claim.context, 'settle');
          if (!next) return { outcome: 'conflict', receiptId: receipt.reconciliationId };
          staged = next;
        }
      } else if (disposition === 'proven-not-dispatched' && claim.context.action.kind === 'run_command') {
        const next = this.stageClaimReservations(claim.context, 'release');
        if (!next) return { outcome: 'conflict', receiptId: receipt.reconciliationId };
        staged = next;
      }

      this.commitLedgers(staged);
      if (nextTask) this.underlying.internalSetTask({ ...nextTask, budgetLedgers: [...this.underlying.getLedgers()] });
      if (fence) {
        this.fencedActors.set(fence.recipientIdentity.adapterIdentity, fence.fencingGeneration);
        this.fencedIncarnationKeys.add(this.incarnationKey(fence.recipientIdentity));
      }
      this.currentControlVersion++;
      claim.status = 'settled';
      attempt.status = 'settled';
      if (this.activeClaimId === receipt.claimId) this.activeClaimId = undefined;
      this.reconciliationReceipts.set(receipt.reconciliationId, structuredClone(receipt));
      return { outcome: 'settled', receiptId: receipt.reconciliationId };
    });
  }

  async closeUnattemptedClaim(receipt: ClaimClosureReceiptV02): Promise<ClaimClosureResultV02> {
    let snapshot: ClaimClosureReceiptV02;
    try { snapshot = structuredClone(receipt); } catch { return NEUTRAL_CLAIM_CLOSURE_RESULT_V02; }
    if (!snapshot || typeof snapshot !== 'object') return NEUTRAL_CLAIM_CLOSURE_RESULT_V02;
    return this.exclusive(async () => {
      receipt = snapshot;
      if (this.neutral) return NEUTRAL_CLAIM_CLOSURE_RESULT_V02;
      const prior = this.claimClosureReceipts.get(receipt.receiptId);
      if (prior) return this.equal(prior, receipt) ? { closed: true, receiptId: receipt.receiptId } : { closed: false, receiptId: receipt.receiptId };
      const claim = this.claims.get(receipt.claimId);
      const fence = claim && this.fenceProofs.get(receipt.claimId);
      if (!claim || claim.status !== 'claimed' || claim.attemptId || this.attempts.size && [...this.attempts.values()].some((attempt) => attempt.claimId === receipt.claimId) ||
        this.activeClaimId !== receipt.claimId || !fence || this.mode === 'runnable' || !this.holdRef || fence.holdRef !== this.holdRef ||
        receipt.reason !== this.holdRef || !this.equal(receipt.fencedExecutorIdentity, fence.fencedExecutorIdentity) || !this.equal(receipt.unconsumedReservations, claim.receipt.reservationRefs)) {
        return { closed: false, receiptId: receipt.receiptId };
      }
      const validationContext: ClaimClosureValidationContextV02 = {
        expectedTaskId: claim.receipt.taskId, expectedClaimId: claim.receipt.claimId,
        claim: { ...claim.receipt, hasCommittedAttempt: false }, hasCommittedAttempt: false,
        expectedAdapterIdentity: fence.fencedExecutorIdentity.adapterIdentity,
        expectedMinFencingGeneration: fence.fencingGeneration,
        expectedFencedExecutorIdentity: fence.fencedExecutorIdentity,
      };
      if (!validateClaimClosureReceiptV02(receipt, validationContext).ok) return { closed: false, receiptId: receipt.receiptId };
      const task = await this.underlying.loadTask(claim.receipt.taskId);
      if (!task || !this.contextMatchesTask(claim.context, task)) return { closed: false, receiptId: receipt.receiptId };
      const staged = this.releaseClaimReservations(claim);
      if (!staged) return { closed: false, receiptId: receipt.receiptId };
      this.commitLedgers(staged);
      claim.status = 'closed';
      if (this.activeClaimId === receipt.claimId) this.activeClaimId = undefined;
      this.currentControlVersion++;
      this.claimClosureReceipts.set(receipt.receiptId, structuredClone(receipt));
      return { closed: true, receiptId: receipt.receiptId };
    });
  }

  private reconciliationReplay(receipt: AttemptReconciliationReceiptV02): ReconciliationResultV02 | null {
    const prior = this.reconciliationReceipts.get(receipt.reconciliationId);
    if (!prior) return null;
    return this.equal(prior, receipt)
      ? { outcome: 'settled', receiptId: receipt.reconciliationId }
      : { outcome: 'conflict', receiptId: receipt.reconciliationId };
  }
}
