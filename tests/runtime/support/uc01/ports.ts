import { isDeepStrictEqual } from 'node:util';
import type { SourceEvidence } from '../../../../src/contracts/uc03.ts';
import { fixtureLimits, sha256Text, type Assessment, type Catalog, type Continuation, type Evidence, type Failure,
  type Invocation, type Limits, type Proposal, type Question, type Usage } from '../../../../src/uc01/contracts.ts';

export type OperationContext = Readonly<{
  taskId: string; runId: string; invocationId: string; repositoryId: string; workspaceId: string; repositorySnapshotDigest: string;
  configId: string; configVersion: string; policyId: string; policyVersion: string; operationId: string; requestId: string;
  accountingRef: string; deadlineEpochMs: number; limits: Limits;
}>;
export type SharedFailure = Readonly<{ kind: 'failure'; status: Failure; reasonCode: string; eventRef: string }>;
export type Admission = Readonly<{ kind: 'admitted'; admissionRef: string; requestId: string; contextDigest: string }>;
export type GuardAction = Readonly<{ kind: 'model' | 'read' | 'search'; inputDigest: string }>;
export type ReserveCeiling = Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number; costUnits: number; pricingId: string }>;
export type Reserved = Readonly<{ kind: 'reserved'; reservationRef: string; requestId: string }>;
export type RepositoryFinding = Readonly<{ source: SourceEvidence; location: Readonly<{
  repositoryId: string; snapshotDigest: string; path: string; fileDigest: string; startLine: number; endLine: number;
}>; safeExcerptRef: string; provenance: 'mock' | 'real' }>;
export type ModelEvidence = Readonly<{ evidence: Evidence; boundedExcerpt: string }>;
export type ReadOrSearch = Readonly<{ kind: 'read'; path: string }> | Readonly<{ kind: 'search'; query: string }>;
export type ModelRequest = Readonly<{ role: 'triage'; invocation: Invocation; evidence: readonly ModelEvidence[];
  priorQuestions: readonly Question[]; catalog: Catalog; reservationRef: string }>;
export type ModelResponse = Readonly<{ kind: 'assessment'; proposal: Proposal; usage: Usage }>
  | Readonly<{ kind: 'tool-request'; request: ReadOrSearch; usage: Usage }>
  | (SharedFailure & Readonly<{ usage: Usage }>);
export type ReadResponse = Readonly<{ kind: 'read'; finding: RepositoryFinding }> | SharedFailure;
export type SearchResponse = Readonly<{ kind: 'search'; findings: readonly RepositoryFinding[]; truncated: boolean }> | SharedFailure;
export type SettleResponse = Readonly<{ kind: 'settled'; accountingRef: string }> | SharedFailure;
export type ContinuationBindResponse = Readonly<{ kind: 'bound'; continuationRef: string }> | SharedFailure;
export type ContinuationResolveResponse = Readonly<{ kind: 'resolved'; continuation: Continuation }> | SharedFailure;
export type TelemetryEvent = Readonly<{ eventId: string; type: string; outcome: string; durationMs: number;
  counts: Readonly<{ modelCalls: number; toolCalls: number; evidenceItems: number; questions: number }>; configRef: string }>;
export type TelemetryResponse = Readonly<{ eventRef: string }>;

export type FixtureTaskLimits = Readonly<{ wallTimeMs: 30000; modelCalls: 8; toolCalls: 12; inputBytes: 32768; outputBytes: 16384;
  evidenceItems: 48; searchResults: 96; questions: 12; inputTokens: 4000; outputTokens: 2000; totalTokens: 6000; costUnits: 6000; invocations: 3 }>;
export type FixtureProfile = Readonly<{ profileId: 'uc01-fixture-v1'; provenance: 'mock'; perInvocation: Limits; perTask: FixtureTaskLimits }>;
const taskLimits: FixtureTaskLimits = Object.freeze({ wallTimeMs: 30000, modelCalls: 8, toolCalls: 12, inputBytes: 32768, outputBytes: 16384,
  evidenceItems: 48, searchResults: 96, questions: 12, inputTokens: 4000, outputTokens: 2000, totalTokens: 6000, costUnits: 6000, invocations: 3 });
export const UC01_FIXTURE_PROFILE: FixtureProfile = Object.freeze({ profileId: 'uc01-fixture-v1', provenance: 'mock', perInvocation: fixtureLimits, perTask: taskLimits });

export type PortOperation = 'guard' | 'reserve' | 'settle' | 'read' | 'search' | 'model' | 'bindContinuation' | 'resolveContinuation' | 'telemetry';
export type PortDispatch = 'read' | 'search' | 'model';
export type PortCallRecord = Readonly<{ operation: PortOperation; ordinal: number; requestId: string; resultKind: string }>;
interface BudgetAmounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUnits: number;
}
export interface PortUsage extends BudgetAmounts {
  readonly invocations: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
}
export type CallSnapshot = Readonly<{
  attempts: Readonly<Record<PortOperation, number>>;
  dispatches: Readonly<Record<PortDispatch, number>>;
  taskUsage: PortUsage;
  calls: readonly PortCallRecord[];
  safeEvents: readonly TelemetryEvent[];
}>;

const zeroAttempts = (): Record<PortOperation, number> => ({ guard: 0, reserve: 0, settle: 0, read: 0, search: 0, model: 0, bindContinuation: 0,
  resolveContinuation: 0, telemetry: 0 });
const zeroDispatches = (): Record<PortDispatch, number> => ({ read: 0, search: 0, model: 0 });
const zeroUsage = () => ({ modelCalls: 0, toolCalls: 0 });
const zeroBudget = (): BudgetAmounts => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costUnits: 0 });
type InvocationUsage = ReturnType<typeof zeroUsage>;
interface AdmissionRecord {
  requestId: string;
  contextDigest: string;
  actionKind: GuardAction['kind'];
  inputDigest: string;
  reserved: boolean;
  used: boolean;
}
type ReservationRecord = Readonly<{ requestId: string; contextDigest: string; admissionRef: string; ceiling: ReserveCeiling; state: 'reserved' | 'uncertain' | 'settled' }>;
interface BoundContinuation {
  readonly taskId: string;
  readonly repositoryId: string;
  readonly repositorySnapshotDigest: string;
  readonly configId: string;
  readonly configVersion: string;
  readonly issueId: string;
  readonly reportDigest: string;
  readonly assessmentId: string;
  readonly questions: Assessment['questions'];
}
interface ReservationBudget {
  readonly invocationId: string;
  charge: BudgetAmounts;
  state: 'reserved' | 'uncertain' | 'settled';
}
type ScriptArrays = { [K in keyof PortScripts]-?: NonNullable<PortScripts[K]> extends readonly (infer T)[] ? T[] : never };

/** Stable JSON digest helper for logical actions; arrays retain order and object keys sort by ECMAScript order. */
function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : (() => { throw new TypeError('Invalid JSON number'); })();
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Unsupported JSON value');
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError('Invalid JSON array');
    const items = Array.from(value.keys(), index => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Invalid JSON array item');
      return canonicalJson(descriptor.value, ancestors);
    });
    ancestors.delete(value);
    return `[${items.join(',')}]`;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Invalid JSON object');
  const entries = Reflect.ownKeys(value).map(key => {
    if (typeof key !== 'string') throw new TypeError('Invalid JSON key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError('Invalid JSON property');
    return [key, descriptor.value] as const;
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const result = `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, ancestors)}`).join(',')}}`;
  ancestors.delete(value);
  return result;
}

export function operationContextDigest(context: OperationContext): string { return sha256Text(canonicalJson(context)); }
export function actionDigest(kind: GuardAction['kind'], payload: unknown): string {
  if (!isRecord(payload) || Object.hasOwn(payload, 'kind')) throw new TypeError('Action payload must be a plain record without a discriminator');
  return sha256Text(canonicalJson({ kind, ...payload }));
}
function failure(status: Failure, reasonCode: string, eventRef = 'mock-event'): SharedFailure { return { kind: 'failure', status, reasonCode, eventRef }; }
function budgetAmounts(value: ReserveCeiling | Usage): BudgetAmounts {
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens, costUnits: value.costUnits };
}
function addBudget(left: BudgetAmounts, right: BudgetAmounts): BudgetAmounts {
  return { inputTokens: left.inputTokens + right.inputTokens, outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens, costUnits: left.costUnits + right.costUnits };
}
function budgetWithin(value: BudgetAmounts, limits: Limits | FixtureTaskLimits): boolean {
  return value.inputTokens <= limits.inputTokens && value.outputTokens <= limits.outputTokens
    && value.totalTokens <= limits.totalTokens && value.costUnits <= limits.costUnits;
}
function resultKind(value: unknown): string {
  if (value === null || typeof value !== 'object') return 'invalid';
  const record = value as Record<string, unknown>;
  return typeof record.status === 'string' ? record.status : typeof record.kind === 'string' ? record.kind : 'ok';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function sameKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every(key => {
    if (typeof key !== 'string' || !expected.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor?.enumerable && 'value' in descriptor);
  }) && expected.every(key => Object.hasOwn(value, key));
}
function eventCheck(value: unknown): TelemetryEvent {
  if (!sameKeys(value, ['eventId', 'type', 'outcome', 'durationMs', 'counts', 'configRef'])
    || !sameKeys(value.counts, ['modelCalls', 'toolCalls', 'evidenceItems', 'questions'])) throw new TypeError('Unsafe telemetry event shape');
  for (const key of ['eventId', 'type', 'outcome', 'configRef']) if (typeof value[key] !== 'string' || !value[key].trim() || Buffer.byteLength(value[key]) > 512) {
    throw new TypeError('Unsafe telemetry text');
  }
  for (const key of ['durationMs'] as const) if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0) throw new TypeError('Unsafe telemetry duration');
  for (const count of Object.values(value.counts)) if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new TypeError('Unsafe telemetry count');
  return structuredClone(value) as TelemetryEvent;
}

/** Attempt history contains operation names and stable IDs only; it never retains request bodies. */
export class CallSpy {
  private readonly attempts = zeroAttempts();
  private readonly dispatches = zeroDispatches();
  private readonly invocations = new Set<string>();
  private readonly byInvocation = new Map<string, InvocationUsage>();
  private readonly calls: PortCallRecord[] = [];
  private readonly safeEvents: TelemetryEvent[] = [];
  private readonly reservationBudgets = new Map<string, ReservationBudget>();
  private taskModelCalls = 0;
  private taskToolCalls = 0;

  readonly profile: FixtureProfile;

  constructor(profile: FixtureProfile) {
    if (!isDeepStrictEqual(profile, UC01_FIXTURE_PROFILE)) throw new TypeError('Explicit uc01-fixture-v1 profile required');
    this.profile = profile;
  }

  registerInvocation(context: OperationContext): void { this.invocations.add(context.invocationId); }

  recordAttempt(operation: PortOperation, context: OperationContext, result: unknown): void {
    this.attempts[operation] += 1;
    this.calls.push({ operation, ordinal: this.attempts[operation], requestId: context.requestId, resultKind: resultKind(result) });
  }

  canDispatch(context: OperationContext, operation: PortDispatch): boolean {
    const usage = this.byInvocation.get(context.invocationId) ?? zeroUsage();
    const taskLimit = operation === 'model' ? this.profile.perTask.modelCalls : this.profile.perTask.toolCalls;
    const invocationLimit = operation === 'model' ? context.limits.modelCalls : context.limits.toolCalls;
    const invocationCalls = operation === 'model' ? usage.modelCalls : usage.toolCalls;
    const taskCalls = operation === 'model' ? this.taskModelCalls : this.taskToolCalls;
    return this.invocations.size <= this.profile.perTask.invocations && invocationCalls < invocationLimit && taskCalls < taskLimit;
  }

  recordDispatch(operation: PortDispatch, context: OperationContext): void {
    this.invocations.add(context.invocationId);
    const usage = this.byInvocation.get(context.invocationId) ?? zeroUsage();
    if (operation === 'model') { usage.modelCalls += 1; this.taskModelCalls += 1; }
    else { usage.toolCalls += 1; this.taskToolCalls += 1; }
    this.byInvocation.set(context.invocationId, usage);
    this.dispatches[operation] += 1;
  }

  canReserve(context: OperationContext, ceiling: ReserveCeiling): boolean {
    const requested = budgetAmounts(ceiling);
    return budgetWithin(addBudget(this.currentBudget(context.invocationId), requested), context.limits)
      && budgetWithin(addBudget(this.currentBudget(), requested), this.profile.perTask);
  }

  recordReservation(context: OperationContext, reservationRef: string, ceiling: ReserveCeiling): void {
    this.reservationBudgets.set(reservationRef, { invocationId: context.invocationId, charge: budgetAmounts(ceiling), state: 'reserved' });
  }

  recordSettlement(reservationRef: string, usage: Usage, state: 'uncertain' | 'settled'): void {
    const reservation = this.reservationBudgets.get(reservationRef);
    if (!reservation) return;
    if (state === 'settled') {
      reservation.charge = budgetAmounts(usage);
    } else {
      const actual = budgetAmounts(usage);
      reservation.charge = {
        inputTokens: Math.max(reservation.charge.inputTokens, actual.inputTokens),
        outputTokens: Math.max(reservation.charge.outputTokens, actual.outputTokens),
        totalTokens: Math.max(reservation.charge.totalTokens, actual.totalTokens),
        costUnits: Math.max(reservation.charge.costUnits, actual.costUnits),
      };
    }
    reservation.state = state;
  }

  private currentBudget(invocationId?: string): BudgetAmounts {
    return [...this.reservationBudgets.values()].filter(entry => invocationId === undefined || entry.invocationId === invocationId)
      .reduce((sum, entry) => addBudget(sum, entry.charge), zeroBudget());
  }

  recordSafeEvent(event: TelemetryEvent): void { this.safeEvents.push(structuredClone(event)); }

  snapshot(): CallSnapshot {
    const budget = this.currentBudget();
    return { attempts: { ...this.attempts }, dispatches: { ...this.dispatches },
      taskUsage: { invocations: this.invocations.size, modelCalls: this.taskModelCalls, toolCalls: this.taskToolCalls, ...budget },
      calls: this.calls.map(call => ({ ...call })), safeEvents: this.safeEvents.map(event => structuredClone(event)) };
  }
}

export type PortScripts = Readonly<{
  guard?: readonly (Admission | SharedFailure)[]; reserve?: readonly (Reserved | SharedFailure)[]; settle?: readonly SettleResponse[];
  read?: readonly ReadResponse[]; search?: readonly SearchResponse[]; model?: readonly ModelResponse[];
  bindContinuation?: readonly ContinuationBindResponse[]; resolveContinuation?: readonly ContinuationResolveResponse[];
  telemetry?: readonly TelemetryResponse[];
}>;
export type ScriptedPortsOptions = Readonly<{ taskId: string; profile: FixtureProfile; now: () => number; responses?: PortScripts }>;

/** Scripted UC-01 shared-port doubles. No filesystem, network, process, durable store or provider is reachable here. */
export class ScriptedUc01Ports {
  readonly provenance = 'mock' as const;
  readonly profile: FixtureProfile;
  readonly calls: CallSpy;
  private readonly scripts: ScriptArrays;
  private readonly cursors = new Map<keyof PortScripts, number>();
  private readonly admissions = new Map<string, AdmissionRecord>();
  private readonly reservations = new Map<string, ReservationRecord>();
  private readonly continuations = new Map<string, BoundContinuation>();
  private readonly options: ScriptedPortsOptions;

  constructor(options: ScriptedPortsOptions) {
    if (!options || !options.profile || !isDeepStrictEqual(options.profile, UC01_FIXTURE_PROFILE)) throw new TypeError('Explicit uc01-fixture-v1 profile required');
    if (!options.taskId.trim() || typeof options.now !== 'function') throw new TypeError('A bounded task ID and injected test clock are required');
    this.options = options;
    this.profile = UC01_FIXTURE_PROFILE;
    this.calls = new CallSpy(this.profile);
    const responses = options.responses ?? {};
    this.scripts = {
      guard: [...(responses.guard ?? [])].map(value => structuredClone(value)), reserve: [...(responses.reserve ?? [])].map(value => structuredClone(value)),
      settle: [...(responses.settle ?? [])].map(value => structuredClone(value)), read: [...(responses.read ?? [])].map(value => structuredClone(value)),
      search: [...(responses.search ?? [])].map(value => structuredClone(value)), model: [...(responses.model ?? [])].map(value => structuredClone(value)),
      bindContinuation: [...(responses.bindContinuation ?? [])].map(value => structuredClone(value)), resolveContinuation: [...(responses.resolveContinuation ?? [])].map(value => structuredClone(value)),
      telemetry: [...(responses.telemetry ?? [])].map(value => structuredClone(value)),
    };
  }

  private next<K extends keyof PortScripts, T>(key: K, fallback: T): T {
    const script = this.scripts[key] as T[];
    const index = this.cursors.get(key) ?? 0;
    this.cursors.set(key, index + 1);
    return script[index] === undefined ? fallback : script[index] as T;
  }

  private contextFailure(context: OperationContext): SharedFailure | undefined {
    if (context.taskId !== this.options.taskId) return failure('conflict', 'foreign-task');
    if (!Number.isSafeInteger(context.deadlineEpochMs) || context.deadlineEpochMs <= this.options.now()
      || context.deadlineEpochMs > this.options.now() + context.limits.wallTimeMs) return failure('timeout', 'deadline-outside-profile');
    if (!validateFixtureLimits(context.limits)) return failure('invalid-input', 'invalid-fixture-limits');
    return undefined;
  }

  async guard(context: OperationContext, action: GuardAction): Promise<Admission | SharedFailure> {
    const invalid = this.contextFailure(context);
    if (invalid) { this.calls.recordAttempt('guard', context, invalid); return invalid; }
    this.calls.registerInvocation(context);
    if (!/^[a-f0-9]{64}$/u.test(action.inputDigest)) {
      const invalidAction = failure('invalid-input', 'invalid-action-digest'); this.calls.recordAttempt('guard', context, invalidAction); return invalidAction;
    }
    const operation: PortDispatch = action.kind;
    if (!this.calls.canDispatch(context, operation)) {
      const exhausted = failure('exhausted', 'fixture-call-budget'); this.calls.recordAttempt('guard', context, exhausted); return exhausted;
    }
    const scripted = this.next<'guard', Admission | SharedFailure>('guard', failure('exhausted', 'guard-script-exhausted'));
    if (scripted.kind === 'failure') { this.calls.recordAttempt('guard', context, scripted); return scripted; }
    if (scripted.requestId !== context.requestId || scripted.contextDigest !== operationContextDigest(context) || !scripted.admissionRef.trim()
      || this.admissions.has(scripted.admissionRef)) {
      const stale = failure('conflict', 'stale-admission'); this.calls.recordAttempt('guard', context, stale); return stale;
    }
    this.admissions.set(scripted.admissionRef, { requestId: context.requestId, contextDigest: scripted.contextDigest,
      actionKind: action.kind, inputDigest: action.inputDigest, reserved: false, used: false });
    this.calls.recordAttempt('guard', context, scripted);
    return structuredClone(scripted);
  }

  private admissionFailure(context: OperationContext, admission: Admission, kind: GuardAction['kind'], inputDigest: string): SharedFailure | undefined {
    const stored = this.admissions.get(admission.admissionRef);
    if (!stored || stored.requestId !== context.requestId || stored.contextDigest !== operationContextDigest(context)
      || admission.requestId !== context.requestId || admission.contextDigest !== stored.contextDigest
      || stored.actionKind !== kind || stored.inputDigest !== inputDigest || stored.used) return failure('conflict', 'stale-or-reused-admission');
    return undefined;
  }

  async reserve(context: OperationContext, admission: Admission, ceiling: ReserveCeiling): Promise<Reserved | SharedFailure> {
    const storedAdmission = this.admissions.get(admission.admissionRef);
    const invalid = this.contextFailure(context) ?? (storedAdmission?.actionKind !== 'model' || storedAdmission.reserved
      ? failure('conflict', 'model-reservation-binding') : undefined) ?? this.admissionFailure(context, admission, this.admissions.get(admission.admissionRef)?.actionKind ?? 'model',
      this.admissions.get(admission.admissionRef)?.inputDigest ?? '');
    if (invalid) { this.calls.recordAttempt('reserve', context, invalid); return invalid; }
    if (!Number.isSafeInteger(ceiling.inputTokens) || !Number.isSafeInteger(ceiling.outputTokens) || !Number.isSafeInteger(ceiling.totalTokens)
      || !Number.isSafeInteger(ceiling.costUnits) || ceiling.inputTokens < 0 || ceiling.outputTokens < 0 || ceiling.costUnits < 0
      || ceiling.totalTokens !== ceiling.inputTokens + ceiling.outputTokens || ceiling.inputTokens > context.limits.inputTokens
      || ceiling.outputTokens > context.limits.outputTokens || ceiling.totalTokens > context.limits.totalTokens
      || ceiling.costUnits > context.limits.costUnits || !ceiling.pricingId.trim()) {
      const invalidCeiling = failure('invalid-input', 'invalid-reservation-ceiling'); this.calls.recordAttempt('reserve', context, invalidCeiling); return invalidCeiling;
    }
    if (!this.calls.canReserve(context, ceiling)) {
      const exhausted = failure('exhausted', 'fixture-usage-budget'); this.calls.recordAttempt('reserve', context, exhausted); return exhausted;
    }
    const scripted = this.next<'reserve', Reserved | SharedFailure>('reserve', failure('exhausted', 'reservation-script-exhausted'));
    if (scripted.kind === 'reserved') {
      if (scripted.requestId !== context.requestId || this.reservations.has(scripted.reservationRef)) {
        const conflict = failure('conflict', 'reservation-binding'); this.calls.recordAttempt('reserve', context, conflict); return conflict;
      }
      this.reservations.set(scripted.reservationRef, { requestId: context.requestId, contextDigest: operationContextDigest(context),
        admissionRef: admission.admissionRef, ceiling: structuredClone(ceiling), state: 'reserved' });
      this.calls.recordReservation(context, scripted.reservationRef, ceiling);
      if (storedAdmission) storedAdmission.reserved = true;
    }
    this.calls.recordAttempt('reserve', context, scripted);
    return structuredClone(scripted);
  }

  async settle(context: OperationContext, reservationRef: string, usage: Usage): Promise<SettleResponse> {
    const reservation = this.reservations.get(reservationRef);
    if (!reservation || reservation.state !== 'reserved' || reservation.requestId !== context.requestId || reservation.contextDigest !== operationContextDigest(context)
      || usage.reservationRef !== reservationRef || usage.totalTokens !== usage.inputTokens + usage.outputTokens
      || !Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens) || !Number.isSafeInteger(usage.totalTokens)
      || !Number.isSafeInteger(usage.costUnits) || usage.inputTokens < 0 || usage.outputTokens < 0 || usage.costUnits < 0) {
      const conflict = failure('conflict', 'reservation-settlement-binding'); this.calls.recordAttempt('settle', context, conflict); return conflict;
    }
    if (usage.inputTokens > reservation.ceiling.inputTokens || usage.outputTokens > reservation.ceiling.outputTokens
      || usage.totalTokens > reservation.ceiling.totalTokens || usage.costUnits > reservation.ceiling.costUnits || usage.state === 'uncertain') {
      this.reservations.set(reservationRef, { ...reservation, state: 'uncertain' });
      this.calls.recordSettlement(reservationRef, usage, 'uncertain');
      const uncertain = failure('uncertain', 'usage-exceeds-or-loses-reservation'); this.calls.recordAttempt('settle', context, uncertain); return uncertain;
    }
    const scripted = this.next<'settle', SettleResponse>('settle', failure('uncertain', 'settlement-script-exhausted'));
    if (scripted.kind === 'failure' && scripted.status === 'uncertain') {
      this.reservations.set(reservationRef, { ...reservation, state: 'uncertain' });
      this.calls.recordSettlement(reservationRef, usage, 'uncertain');
    } else if (scripted.kind === 'settled') {
      this.reservations.set(reservationRef, { ...reservation, state: 'settled' });
      this.calls.recordSettlement(reservationRef, usage, 'settled');
    }
    this.calls.recordAttempt('settle', context, scripted);
    return structuredClone(scripted);
  }

  private dispatchFailure(context: OperationContext, operation: PortDispatch): SharedFailure | undefined {
    const invalid = this.contextFailure(context);
    if (invalid) return invalid;
    if (!this.calls.canDispatch(context, operation)) return failure('exhausted', 'fixture-call-budget');
    return undefined;
  }

  async readEvidence(context: OperationContext, admission: Admission, path: string): Promise<ReadResponse> {
    const invalid = !safeRepositoryPath(path) ? failure('invalid-input', 'invalid-read-path')
      : this.admissionFailure(context, admission, 'read', actionDigest('read', { path })) ?? this.dispatchFailure(context, 'read');
    if (invalid) { this.calls.recordAttempt('read', context, invalid); return invalid; }
    const scripted = this.next<'read', ReadResponse>('read', failure('exhausted', 'read-script-exhausted'));
    this.calls.recordDispatch('read', context);
    const storedAdmission = this.admissions.get(admission.admissionRef); if (storedAdmission) storedAdmission.used = true;
    if (scripted.kind === 'read' && (!validMockFinding(scripted.finding, context) || scripted.finding.location.path !== path)) {
      const denied = failure('denied', 'real-provenance-in-mock-profile'); this.calls.recordAttempt('read', context, denied); return denied;
    }
    this.calls.recordAttempt('read', context, scripted);
    return structuredClone(scripted);
  }

  async searchEvidence(context: OperationContext, admission: Admission, query: string): Promise<SearchResponse> {
    const invalid = !query.trim() ? failure('invalid-input', 'empty-search-query')
      : this.admissionFailure(context, admission, 'search', actionDigest('search', { query })) ?? this.dispatchFailure(context, 'search');
    if (invalid) { this.calls.recordAttempt('search', context, invalid); return invalid; }
    const scripted = this.next<'search', SearchResponse>('search', failure('exhausted', 'search-script-exhausted'));
    this.calls.recordDispatch('search', context);
    const storedAdmission = this.admissions.get(admission.admissionRef); if (storedAdmission) storedAdmission.used = true;
    if (scripted.kind === 'search' && (scripted.findings.length > context.limits.searchResults || scripted.findings.some(finding => !validMockFinding(finding, context)))) {
      const rejected = failure(scripted.findings.length > context.limits.searchResults ? 'exhausted' : 'denied', 'unsafe-mock-search-result');
      this.calls.recordAttempt('search', context, rejected); return rejected;
    }
    this.calls.recordAttempt('search', context, scripted);
    return structuredClone(scripted);
  }

  async proposeAssessment(context: OperationContext, admission: Admission, request: ModelRequest): Promise<ModelResponse> {
    if (!sameKeys(request, ['role', 'invocation', 'evidence', 'priorQuestions', 'catalog', 'reservationRef'])) {
      const invalidRequest = failure('invalid-input', 'model-visible-extra-fields');
      this.calls.recordAttempt('model', context, invalidRequest);
      return { ...invalidRequest, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUnits: 0, state: 'settled', reservationRef: 'invalid-request' } };
    }
    const payload = { role: request.role, invocation: request.invocation, evidence: request.evidence, priorQuestions: request.priorQuestions, catalog: request.catalog };
    const invalid = this.admissionFailure(context, admission, 'model', actionDigest('model', payload)) ?? this.dispatchFailure(context, 'model');
    if (invalid) { this.calls.recordAttempt('model', context, invalid); return { ...invalid, usage: { inputTokens: 0, outputTokens: 0,
      totalTokens: 0, costUnits: 0, state: 'settled', reservationRef: request.reservationRef } }; }
    const reservation = this.reservations.get(request.reservationRef);
    const storedAdmission = this.admissions.get(admission.admissionRef);
    if (!reservation || reservation.state !== 'reserved' || !storedAdmission?.reserved || storedAdmission.used
      || reservation.requestId !== context.requestId || reservation.contextDigest !== operationContextDigest(context)
      || reservation.admissionRef !== admission.admissionRef) {
      const conflict = failure('conflict', 'model-reservation-binding'); this.calls.recordAttempt('model', context, conflict);
      return { ...conflict, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUnits: 0, state: 'settled', reservationRef: request.reservationRef } };
    }
    const scripted = this.next<'model', ModelResponse>('model', { ...failure('exhausted', 'model-script-exhausted'), usage: {
      inputTokens: 0, outputTokens: 0, totalTokens: 0, costUnits: 0, state: 'settled' as const, reservationRef: request.reservationRef,
    } });
    storedAdmission.used = true;
    this.calls.recordDispatch('model', context);
    if (scripted.usage.reservationRef !== request.reservationRef) {
      const conflict = failure('conflict', 'model-usage-reservation-binding'); this.calls.recordAttempt('model', context, conflict);
      return { ...conflict, usage: structuredClone(scripted.usage) };
    }
    this.calls.recordAttempt('model', context, scripted);
    return structuredClone(scripted);
  }

  async bindContinuation(context: OperationContext, assessment: Assessment): Promise<ContinuationBindResponse> {
    const invalid = this.contextFailure(context);
    if (invalid) { this.calls.recordAttempt('bindContinuation', context, invalid); return invalid; }
    if (assessment.repositoryId !== context.repositoryId || assessment.repositorySnapshotDigest !== context.repositorySnapshotDigest || !assessment.questions.length) {
      const conflict = failure('conflict', 'continuation-assessment-binding'); this.calls.recordAttempt('bindContinuation', context, conflict); return conflict;
    }
    const scripted = this.next<'bindContinuation', ContinuationBindResponse>('bindContinuation', failure('exhausted', 'continuation-bind-script-exhausted'));
    if (scripted.kind === 'bound') {
      if (!scripted.continuationRef.trim() || this.continuations.has(scripted.continuationRef)) {
        const conflict = failure('conflict', 'continuation-reference-binding'); this.calls.recordAttempt('bindContinuation', context, conflict); return conflict;
      }
      this.continuations.set(scripted.continuationRef, { taskId: context.taskId, repositoryId: context.repositoryId,
        repositorySnapshotDigest: context.repositorySnapshotDigest, configId: context.configId, configVersion: context.configVersion,
        issueId: assessment.issueId, reportDigest: assessment.reportDigest, assessmentId: assessment.assessmentId, questions: structuredClone(assessment.questions) });
    }
    this.calls.recordAttempt('bindContinuation', context, scripted);
    return structuredClone(scripted);
  }

  async resolveContinuation(context: OperationContext, continuationRef: string): Promise<ContinuationResolveResponse> {
    const invalid = this.contextFailure(context);
    if (invalid) { this.calls.recordAttempt('resolveContinuation', context, invalid); return invalid; }
    const scripted = this.next<'resolveContinuation', ContinuationResolveResponse>('resolveContinuation', failure('exhausted', 'continuation-resolve-script-exhausted'));
    if (scripted.kind === 'resolved') {
      const prior = scripted.continuation;
      const bound = this.continuations.get(continuationRef);
      if (!continuationRef.trim() || prior.taskId !== context.taskId || prior.repositoryId !== context.repositoryId
        || prior.repositorySnapshotDigest !== context.repositorySnapshotDigest || prior.configId !== context.configId || prior.configVersion !== context.configVersion
        || !bound || prior.taskId !== bound.taskId || prior.repositoryId !== bound.repositoryId || prior.repositorySnapshotDigest !== bound.repositorySnapshotDigest
        || prior.configId !== bound.configId || prior.configVersion !== bound.configVersion || prior.issueId !== bound.issueId
        || prior.reportDigest !== bound.reportDigest || prior.priorAssessmentId !== bound.assessmentId || !isDeepStrictEqual(prior.questions, bound.questions)) {
        const conflict = failure('conflict', 'continuation-binding'); this.calls.recordAttempt('resolveContinuation', context, conflict); return conflict;
      }
    }
    this.calls.recordAttempt('resolveContinuation', context, scripted);
    return structuredClone(scripted);
  }

  async emitSafeEvent(event: TelemetryEvent): Promise<TelemetryResponse> {
    const current = eventCheck(event);
    const context = { ...this.placeholderContext(), requestId: current.eventId };
    this.calls.recordAttempt('telemetry', context, { kind: 'emitted' });
    this.calls.recordSafeEvent(current);
    const scripted = this.next<'telemetry', TelemetryResponse>('telemetry', { eventRef: 'mock-event' });
    return structuredClone(scripted);
  }

  private placeholderContext(): OperationContext {
    return { taskId: this.options.taskId, runId: 'telemetry-run', invocationId: 'telemetry-invocation', repositoryId: 'telemetry-repository',
      workspaceId: 'telemetry-workspace', repositorySnapshotDigest: '0'.repeat(64), configId: 'telemetry-config', configVersion: '1',
      policyId: 'telemetry-policy', policyVersion: '1', operationId: 'telemetry-operation', requestId: 'telemetry-request', accountingRef: 'telemetry-account',
      deadlineEpochMs: Number.MAX_SAFE_INTEGER, limits: fixtureLimits };
  }
}

function validateFixtureLimits(value: unknown): value is Limits { return isDeepStrictEqual(value, fixtureLimits); }
function safeRepositoryPath(path: string): boolean {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !/[\\:\u0000-\u001f]/u.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function validMockFinding(finding: RepositoryFinding, context: OperationContext): boolean {
  const { source, location } = finding;
  return finding.provenance === 'mock' && source.path === location.path && source.revisionDigest === location.snapshotDigest
    && location.repositoryId === context.repositoryId && location.snapshotDigest === context.repositorySnapshotDigest
    && safeRepositoryPath(location.path) && /^[a-f0-9]{64}$/u.test(location.fileDigest)
    && Number.isSafeInteger(location.startLine) && location.startLine > 0 && Number.isSafeInteger(location.endLine) && location.endLine >= location.startLine
    && typeof finding.safeExcerptRef === 'string' && finding.safeExcerptRef.trim().length > 0
    && typeof source.boundedExcerpt === 'string' && Buffer.byteLength(source.boundedExcerpt) <= context.limits.outputBytes
    && Number.isSafeInteger(source.resultCount) && source.resultCount > 0 && typeof source.truncated === 'boolean';
}
