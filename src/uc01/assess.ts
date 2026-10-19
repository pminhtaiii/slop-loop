import { isProtectedPathRef, isProtectedPayload } from '../foundation/telemetry.ts';
import { validateSourceEvidence } from '../contracts/foundation/uc03.ts';
import { fixtureLimits, sha256Text, validateIntake, validateModelResponse, validateOutcome, type Assessment, type Catalog, type Failure,
  type Invocation, type Limits, type Outcome, type Question, type Usage } from './contracts.ts';
import { IntakeBinder, type ExcerptAdmission, type ModelEvidence } from './intake.ts';
import { bindClarification, projectClarification } from './clarify.ts';
import { projectRecommendation } from './recommend.ts';

export type OperationContext = Readonly<{ taskId: string; runId: string; invocationId: string; repositoryId: string; workspaceId: string;
  repositorySnapshotDigest: string; configId: string; configVersion: string; policyId: string; policyVersion: string;
  operationId: string; requestId: string; accountingRef: string; deadlineEpochMs: number; limits: Limits }>;
export type Admission = Readonly<{ kind: 'admitted'; admissionRef: string; requestId: string; contextDigest: string }>;
export type ReserveCeiling = Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number; costUnits: number; pricingId: string }>;
export type ModelRequest = Readonly<{ role: 'triage'; invocation: Invocation; evidence: readonly ModelEvidence[];
  priorQuestions: readonly Question[]; catalog: Catalog; reservationRef: string }>;
export type SafeEvent = Readonly<{ eventId: string; type: string; outcome: string; durationMs: number;
  counts: Readonly<{ modelCalls: number; toolCalls: number; evidenceItems: number; questions: number }>; configRef: string }>;
/** Approved consumer requirements, not a production adapter or full RepositoryPort. */
export interface AssessmentPorts {
  readonly provenance: 'mock' | 'real';
  guard(context: OperationContext, action: Readonly<{ kind: 'model' | 'read' | 'search'; inputDigest: string }>): Promise<unknown>;
  reserve(context: OperationContext, admission: Admission, ceiling: ReserveCeiling): Promise<unknown>;
  settle(context: OperationContext, reservationRef: string, usage: Usage): Promise<unknown>;
  proposeAssessment(context: OperationContext, admission: Admission, request: ModelRequest): Promise<unknown>;
  readEvidence(context: OperationContext, admission: Admission, path: string): Promise<unknown>;
  searchEvidence(context: OperationContext, admission: Admission, query: string): Promise<unknown>;
  bindContinuation(context: OperationContext, assessment: Assessment): Promise<unknown>;
  resolveContinuation(context: OperationContext, continuationRef: string): Promise<unknown>;
  emitSafeEvent(event: SafeEvent): Promise<unknown>;
}
export type AssessmentDependencies = Readonly<{ ports: AssessmentPorts; excerpts: ExcerptAdmission; now: () => number;
  profileId: 'uc01-fixture-v1'; ceiling: ReserveCeiling }>;
class Stopped extends Error {
  readonly status: Failure; readonly code: string;
  constructor(status: Failure, code: string) { super('Assessment stopped'); this.status = status; this.code = code; }
}
function stop(status: Failure, code: string): never { throw new Stopped(status, code); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) stop('error', 'invalid-shared-output');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) stop('error', 'invalid-shared-output');
  }
  return value as Record<string, unknown>; // Every key above is a plain own data property.
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 512 || isProtectedPayload(value)) stop('error', 'invalid-shared-output');
  return value;
}
function canonical(value: unknown, ancestors = new Set<object>(), depth = 0): string {
  if (depth > 32) stop('error', 'invalid-shared-output');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || ancestors.has(value)) stop('error', 'invalid-shared-output');
  ancestors.add(value); let result: string;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) stop('error', 'invalid-shared-output');
    const entries: string[] = [];
    for (let index = 0; index < value.length; index++) {
      const field = Object.getOwnPropertyDescriptor(value, String(index));
      if (!field?.enumerable || !('value' in field)) stop('error', 'invalid-shared-output');
      entries.push(canonical(field.value, ancestors, depth + 1));
    }
    result = `[${entries.join(',')}]`;
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) stop('error', 'invalid-shared-output');
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) stop('error', 'invalid-shared-output');
    result = `{${(keys as string[]).sort().map(key => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field?.enumerable || !('value' in field)) stop('error', 'invalid-shared-output');
      return `${JSON.stringify(key)}:${canonical(field.value, ancestors, depth + 1)}`;
    }).join(',')}}`;
  }
  ancestors.delete(value); return result;
}
function sharedFailure(value: unknown): void {
  if (value && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'kind')?.value === 'failure') {
    const result = record(value, ['kind', 'status', 'reasonCode', 'eventRef']);
    const status = result.status;
    if (typeof status !== 'string' || !['invalid-input', 'denied', 'pending-approval', 'conflict', 'exhausted', 'timeout', 'uncertain', 'error'].includes(status)) stop('error', 'invalid-shared-output');
    const code = id(result.reasonCode); id(result.eventRef);
    if (!/^[a-z0-9][a-z0-9-]{0,95}$/u.test(code)) stop('error', 'invalid-shared-output');
    stop(status as Failure, code); // Checked against the complete failure union above.
  }
}
function failed(status: Failure, code: string, eventRef = 'telemetry-unavailable'): Outcome {
  return { status, reasonCode: code, safeMessage: 'Assessment could not be completed safely.', nextAction: 'Review the failure and trusted configuration before a new invocation.', eventRef };
}
function observedUsage(raw: unknown, reservationRef: string, ceiling: ReserveCeiling): Usage {
  const uncertain: Usage = { inputTokens: ceiling.inputTokens, outputTokens: ceiling.outputTokens, totalTokens: ceiling.totalTokens,
    costUnits: ceiling.costUnits, state: 'uncertain', reservationRef };
  try {
    const field: unknown = raw && typeof raw === 'object' ? Object.getOwnPropertyDescriptor(raw, 'usage')?.value : undefined;
    const value = record(field, ['inputTokens', 'outputTokens', 'totalTokens', 'costUnits', 'state', 'reservationRef']);
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'costUnits'] as const) {
      if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > ceiling[key]) return uncertain;
    }
    if (value.state !== 'settled' || value.reservationRef !== reservationRef || value.totalTokens !== Number(value.inputTokens) + Number(value.outputTokens)
      || value.costUnits !== value.totalTokens) return uncertain;
    return value as Usage; // Closed usage fields, arithmetic, fixture pricing and binding checked above.
  } catch { return uncertain; }
}
function clock(now: () => number): number {
  const result = now();
  if (!Number.isSafeInteger(result) || result < 0) stop('invalid-input', 'invalid-clock');
  return result;
}
async function bounded(call: () => Promise<unknown>, timeoutMs: number): Promise<unknown> {
  if (timeoutMs <= 0) stop('timeout', 'deadline-exceeded');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(call), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Stopped('timeout', 'operation-timeout')), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Controlled assessment, clarification and configured recommendation without workflow dispatch. */
export class IssueAssessor {
  private readonly dependencies: AssessmentDependencies;
  constructor(dependencies: AssessmentDependencies) { this.dependencies = dependencies; }

  async assessIssue(invocation: unknown, trustedContext: unknown): Promise<Outcome> {
    const { ports, now, ceiling } = this.dependencies;
    let start = 0; let modelCalls = 0; let toolCalls = 0; let evidenceItems = 0; let questions = 0;
    let configRef = 'unvalidated-config'; let eventId = 'uc01-invalid-input'; let timeout = 1000; let result: Outcome;
    let validFinal: (outcome: Outcome) => boolean = () => true;
    let invocationDeadline: number | undefined;
    const successExpired = (outcome: Outcome): boolean => (outcome.status === 'assessed' || outcome.status === 'needs-info')
      && invocationDeadline !== undefined && clock(now) >= invocationDeadline;
    try {
      start = clock(now);
      const binder = new IntakeBinder(this.dependencies.excerpts);
      const intake = bindClarification(invocation, trustedContext);
      if (!intake.ok) stop(intake.status, intake.reasonCode);
      const { invocation: input, context } = intake.value; let currentContext = context;
      validFinal = outcome => validateOutcome(outcome, input, currentContext).ok;
      configRef = `${context.configId}:${context.configVersion}`; eventId = `${input.invocationId}:assessment-event`;
      timeout = context.limits.perCallTimeoutMs;
      if (this.dependencies.profileId !== 'uc01-fixture-v1' || ports.provenance !== 'mock'
        || canonical(context.limits) !== canonical(fixtureLimits)) stop('denied', 'fixture-profile-required');
      const configured = record(ceiling, ['inputTokens', 'outputTokens', 'totalTokens', 'costUnits', 'pricingId']);
      if (configured.inputTokens !== 500 || configured.outputTokens !== 250 || configured.totalTokens !== 750 || configured.costUnits !== 750
        || configured.pricingId !== 'uc01-fixture-token-units-v1') stop('invalid-input', 'invalid-reservation-profile');
      const evidence: ModelEvidence[] = [];
      const researchUncertainties: string[] = [];
      let sequence = 0; let inputBytes = 0; let outputBytes = 0;
      const deadline = start + context.limits.wallTimeMs;
      if (!Number.isSafeInteger(deadline)) stop('invalid-input', 'invalid-clock');
      invocationDeadline = deadline;
      const remaining = (): number => Math.min(timeout, deadline - clock(now));
      const call = (operation: OperationContext, fn: () => Promise<unknown>): Promise<unknown> => bounded(async () => {
        const value = await fn();
        if (clock(now) >= operation.deadlineEpochMs) stop('timeout', 'deadline-exceeded');
        return value;
      }, Math.min(remaining(), operation.deadlineEpochMs - clock(now)));
      if (input.continuationRef) {
        const continuationRef = input.continuationRef;
        const resolveId = `${input.invocationId}:resolve`;
        const resolveOperation: OperationContext = { taskId: context.taskId, runId: context.runId, invocationId: input.invocationId,
          repositoryId: context.repositoryId, workspaceId: context.workspaceId, repositorySnapshotDigest: context.repositorySnapshotDigest,
          configId: context.configId, configVersion: context.configVersion, policyId: context.policyId, policyVersion: context.policyVersion,
          operationId: resolveId, requestId: resolveId, accountingRef: context.accountingRef,
          deadlineEpochMs: Math.min(deadline, clock(now) + timeout), limits: context.limits };
        const raw = await call(resolveOperation, () => ports.resolveContinuation(resolveOperation, continuationRef));
        sharedFailure(raw); const resolved = record(raw, ['kind', 'continuation']);
        if (resolved.kind !== 'resolved') stop('error', 'invalid-shared-output');
        const checked = bindClarification(input, { ...context, continuation: resolved.continuation });
        if (!checked.ok || canonical(checked.value.context.continuation) !== canonical(context.continuation)) stop('conflict', 'continuation-binding');
      }
      for (const entry of context.evidenceRegistry) {
        const admitted = binder.admit(entry, context.limits.inputBytes);
        if (!admitted.ok) stop(admitted.status, admitted.reasonCode);
        evidence.push(admitted.value);
      }
      evidenceItems = evidence.length;
      const { continuationRef: controlRef, ...visibleInput } = input;
      void controlRef; // The opaque storage reference remains outside provider-visible content.
      // The wire schema permits omission; its mapped TS type represents optional fields as required undefined unions.
      const modelInput = visibleInput as Invocation;
      const countBytes = (value: unknown, direction: 'input' | 'output'): void => {
        const size = Buffer.byteLength(canonical(value));
        if (direction === 'input') inputBytes += size; else outputBytes += size;
        if (inputBytes > context.limits.inputBytes || outputBytes > context.limits.outputBytes) stop('exhausted', 'byte-budget-exhausted');
      };
      const guarded = async (kind: 'model' | 'read' | 'search', payload: Record<string, unknown>): Promise<Readonly<{ operation: OperationContext; admission: Admission }>> => {
        if (remaining() <= 0) stop('timeout', 'deadline-exceeded');
        countBytes(payload, 'input'); sequence += 1;
        const requestId = `${input.invocationId}:${kind}:${sequence}`;
        const operation: OperationContext = { taskId: context.taskId, runId: context.runId, invocationId: input.invocationId,
          repositoryId: context.repositoryId, workspaceId: context.workspaceId, repositorySnapshotDigest: context.repositorySnapshotDigest,
          configId: context.configId, configVersion: context.configVersion, policyId: context.policyId, policyVersion: context.policyVersion,
          operationId: requestId, requestId, accountingRef: context.accountingRef, deadlineEpochMs: Math.min(deadline, clock(now) + timeout), limits: context.limits };
        const raw = await call(operation, () => ports.guard(operation, { kind, inputDigest: sha256Text(canonical({ kind, ...payload })) }));
        sharedFailure(raw); const receipt = record(raw, ['kind', 'admissionRef', 'requestId', 'contextDigest']);
        if (receipt.kind !== 'admitted' || receipt.requestId !== requestId || receipt.contextDigest !== sha256Text(canonical(operation))) stop('conflict', 'admission-binding');
        return { operation, admission: { kind: 'admitted', admissionRef: id(receipt.admissionRef), requestId, contextDigest: String(receipt.contextDigest) } };
      };
      while (true) {
        if (modelCalls >= context.limits.modelCalls) stop('exhausted', 'call-budget-exhausted');
        const payload = { role: 'triage' as const, invocation: modelInput, evidence: [...evidence], priorQuestions: intake.value.priorQuestions, catalog: context.catalog };
        const { operation, admission } = await guarded('model', payload);
        const reserved = await call(operation, () => ports.reserve(operation, admission, ceiling));
        sharedFailure(reserved); const reservation = record(reserved, ['kind', 'reservationRef', 'requestId']);
        if (reservation.kind !== 'reserved' || reservation.requestId !== operation.requestId) stop('conflict', 'reservation-binding');
        const reservationRef = id(reservation.reservationRef); let raw: unknown;
        // Once reserved, even transport/shape/deadline failures must reconcile or retain the ceiling.
        try {
          modelCalls += 1;
          raw = await call(operation, () => ports.proposeAssessment(operation, admission, { ...payload, reservationRef }));
        } catch { raw = undefined; }
        const usage = observedUsage(raw, reservationRef, ceiling);
        let settled: unknown;
        try { settled = await bounded(() => ports.settle(operation, reservationRef, usage), timeout); }
        catch { stop('uncertain', 'settlement-uncertain'); }
        if (usage.state === 'uncertain') stop('uncertain', 'usage-uncertain');
        try {
          sharedFailure(settled); const settlement = record(settled, ['kind', 'accountingRef']);
          if (settlement.kind !== 'settled' || settlement.accountingRef !== context.accountingRef) stop('uncertain', 'settlement-binding');
        } catch { stop('uncertain', 'settlement-uncertain'); }
        if (remaining() <= 0) stop('timeout', 'deadline-exceeded');
        const response = validateModelResponse(raw, currentContext);
        if (!response.ok) stop('error', 'invalid-model-output');
        countBytes(raw, 'output');
        if (isProtectedPayload(response.value)) stop('error', 'protected-model-output');
        if (response.value.kind === 'failure') {
          sharedFailure({ kind: 'failure', status: response.value.status, reasonCode: response.value.reasonCode, eventRef: response.value.eventRef });
          stop('error', 'invalid-model-output');
        }
        if (response.value.kind === 'assessment') {
          const clarified = projectClarification(response.value.proposal, intake.value, currentContext);
          if (!clarified.ok) stop(clarified.reasonCode === 'question-budget-exhausted' ? 'exhausted' : 'error', clarified.reasonCode);
          const projected = projectRecommendation(clarified.value, currentContext);
          if (!projected.ok) stop(projected.reasonCode === 'question-budget-exhausted' ? 'exhausted' : 'error', projected.reasonCode);
          const assessment: Assessment = { ...projected.value, assessmentId: `${input.invocationId}:assessment`, issueId: input.issue.id,
            reportDigest: input.issue.reportDigest, repositoryId: context.repositoryId, repositorySnapshotDigest: context.repositorySnapshotDigest,
            catalogId: context.catalog.id, catalogVersion: context.catalog.version, provenance: 'mock',
            uncertainties: [...new Set([...projected.value.uncertainties, ...researchUncertainties])] };
          questions = assessment.questions.length;
          if (questions) {
            // Validate the complete assessment before making a durable binding request.
            const preview = validateOutcome({ status: 'needs-info', assessment, continuationRef: 'pending', eventRef: 'pending' }, input, currentContext);
            if (!preview.ok) stop('error', 'invalid-model-output');
            sequence += 1;
            const bindingId = `${input.invocationId}:bind:${sequence}`;
            const bindingOperation = { ...operation, operationId: bindingId, requestId: bindingId,
              deadlineEpochMs: Math.min(deadline, clock(now) + timeout) };
            const bound = await call(bindingOperation, () => ports.bindContinuation(bindingOperation, assessment));
            if (remaining() <= 0) stop('timeout', 'deadline-exceeded');
            sharedFailure(bound); const binding = record(bound, ['kind', 'continuationRef']);
            if (binding.kind !== 'bound') stop('error', 'continuation-bind-failed');
            result = { status: 'needs-info', assessment, continuationRef: id(binding.continuationRef), eventRef: 'pending' };
          } else result = { status: 'assessed', assessment, eventRef: 'pending' };
          const checked = validateOutcome(result, input, currentContext);
          if (!checked.ok) stop('error', 'invalid-model-output');
          break;
        }
        if (toolCalls >= context.limits.toolCalls) stop('exhausted', 'call-budget-exhausted');
        const request = response.value.request;
        if (request.kind === 'read' && isProtectedPathRef(request.path)) stop('denied', 'protected-read-path');
        const action = request.kind === 'read' ? { path: request.path } : { query: request.query };
        const tool = await guarded(request.kind, action); toolCalls += 1;
        const retrieved = await call(tool.operation, () => request.kind === 'read'
          ? ports.readEvidence(tool.operation, tool.admission, request.path) : ports.searchEvidence(tool.operation, tool.admission, request.query));
        sharedFailure(retrieved); countBytes(retrieved, 'output');
        const toolResult = record(retrieved, request.kind === 'read' ? ['kind', 'finding'] : ['kind', 'findings', 'truncated']);
        if (toolResult.kind !== request.kind) stop('error', 'invalid-shared-output');
        const findings: unknown = request.kind === 'read' ? [toolResult.finding] : toolResult.findings;
        if (!Array.isArray(findings) || findings.length > context.limits.searchResults || (request.kind === 'search' && typeof toolResult.truncated !== 'boolean')) stop('error', 'invalid-shared-output');
        if (request.kind === 'search' && (!findings.length || toolResult.truncated)) researchUncertainties.push('Search was empty or truncated; it cannot establish absence.');
        if (evidence.length + findings.length > context.limits.evidenceItems) stop('exhausted', 'evidence-budget-exhausted');
        for (const finding of findings) {
          const item = record(finding, ['source', 'location', 'safeExcerptRef', 'provenance']);
          const source = record(item.source, ['path', 'revisionDigest', 'boundedExcerpt', 'resultCount', 'truncated']);
          const parsedSource = validateSourceEvidence(source);
          if (!parsedSource.ok || !source.resultCount || item.provenance !== 'mock' || source.revisionDigest !== context.repositorySnapshotDigest
            || (request.kind === 'read' && source.path !== request.path)) stop('error', 'invalid-repository-evidence');
          if (source.truncated) researchUncertainties.push('A source excerpt is truncated; uninspected content remains unknown.');
          const location = record(item.location, ['repositoryId', 'snapshotDigest', 'path', 'fileDigest', 'startLine', 'endLine']);
          if (location.path !== source.path || location.snapshotDigest !== source.revisionDigest) stop('conflict', 'evidence-snapshot-conflict');
          let evidenceId = `${input.invocationId}:evidence:${evidence.length + 1}`;
          while (evidence.some(entry => entry.evidence.id === evidenceId)) evidenceId += '-next';
          const candidate = { id: evidenceId, kind: 'repository', sourceRef: `${tool.operation.requestId}:${evidence.length + 1}`,
            contentDigest: sha256Text(parsedSource.value.boundedExcerpt), safeExcerptRef: id(item.safeExcerptRef), provenance: 'mock', repository: location };
          const extended = validateIntake(input, { ...currentContext, evidenceRegistry: [...currentContext.evidenceRegistry, candidate] });
          if (!extended.ok) stop('error', 'invalid-repository-evidence');
          const added = extended.value.context.evidenceRegistry.at(-1);
          if (!added) stop('error', 'invalid-repository-evidence');
          const admitted = binder.admit(added, context.limits.inputBytes);
          if (!admitted.ok) stop('denied', 'evidence-not-admitted');
          currentContext = extended.value.context; evidence.push(admitted.value); evidenceItems = evidence.length;
        }
      }
    } catch (error) {
      result = error instanceof Stopped ? failed(error.status, error.code) : failed('error', 'shared-operation-failed');
    }
    try {
      if (successExpired(result)) result = failed('timeout', 'deadline-exceeded');
      const emitted = await bounded(() => ports.emitSafeEvent({ eventId, type: 'uc01-assessment', outcome: result.status,
        durationMs: Math.max(0, clock(now) - start), counts: { modelCalls, toolCalls, evidenceItems, questions }, configRef }), timeout);
      const event = record(emitted, ['eventRef']);
      const final = { ...result, eventRef: id(event.eventRef) };
      const valid = validFinal(final);
      if (successExpired(final)) return failed('timeout', 'deadline-exceeded', final.eventRef);
      return valid ? final : failed('exhausted', 'output-budget-exhausted', final.eventRef);
    } catch { return failed('error', 'telemetry-unavailable'); }
  }
}
