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
} from '../../../../src/contracts/foundation/uc03.ts';

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
}

export class MemoryStatePort implements StatePort {
  readonly provenance: PortProvenance = 'mock';

  private readonly tasks = new Map<string, TaskState>();
  private readonly checkpoints = new Map<string, TaskState>();
  private readonly ledgers = new Map<string, BudgetLedger>();
  private readonly ledgerIdentities = new Map<string, string>();
  private readonly reservationIds: Record<string, string> = {};
  private readonly reservationBundles = new Map<string, ReservationBundle>();
  private readonly storedRequests = new Map<string, ProviderRequest>();

  private readonly transitionContexts: Readonly<Record<number, NonNullable<StateTransitionOptions['trusted']>>>;
  private readonly reconciliationUsage: Readonly<Record<string, ProviderUsage>>;
  private readonly uncertain = new Set<string>();
  private readonly terminal = new Map<string, ProviderUsage>();

  private currentTaskId?: string | undefined;
  private currentRunId?: string | undefined;

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
    // Project only observed provider settlement of reservations recorded in this task version.
    // Fresh reservations must remain a next-state delta, especially one-use replan slots.
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

    // Idempotency: exact request reservation reuse
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
    // Atomic ALL or NONE capacity check BEFORE any mutations
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

    // ALL checks passed: atomically apply updates
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
      // Explicit evidence provided: settle against verified usage
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
      // Unknown evidence never releases charge or revives a terminal request.
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

export class MemoryStatePortV02 implements StatePortV02 {
  readonly provenance: PortProvenance = 'mock';
  private readonly underlying: MemoryStatePort;

  constructor(options?: MemoryStatePortOptions) {
    this.underlying = new MemoryStatePort(options);
  }

  getUnderlying(): MemoryStatePort {
    return this.underlying;
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
    return this.underlying.transition(state, expectedVersion);
  }

  async checkpoint(state: TaskState): Promise<void> {
    return this.underlying.checkpoint(state);
  }

  async recover(taskId: string): Promise<TaskState> {
    return this.underlying.recover(taskId);
  }

  async claim(context: AdmissionContextV02): Promise<ClaimReceiptV02> {
    void context;
    return NEUTRAL_CLAIM_RECEIPT_V02;
  }

  async beginAttempt(claimId: string, executor: ExecutorIdentityV02): Promise<AttemptReceiptV02> {
    void claimId;
    void executor;
    return NEUTRAL_ATTEMPT_RECEIPT_V02;
  }

  async recordOutcome(receipt: AttemptOutcomeReceiptV02): Promise<OutcomeRecordResultV02> {
    void receipt;
    return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
  }

  async reconcileObservedOutcome(receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02> {
    void receipt;
    return NEUTRAL_RECONCILIATION_RESULT_V02;
  }

  async reconcileUncertain(receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02> {
    void receipt;
    return NEUTRAL_RECONCILIATION_RESULT_V02;
  }

  async closeUnattemptedClaim(receipt: ClaimClosureReceiptV02): Promise<ClaimClosureResultV02> {
    void receipt;
    return NEUTRAL_CLAIM_CLOSURE_RESULT_V02;
  }
}
