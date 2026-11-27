/** Owns in-memory task identity, serialized turns and advisory context; run effects stay behind the injected boundary. */
import type { QuestionBudgetProfileV1, QuestionResultV1, RepositoryBindingV1 } from '../contracts/questions/contracts.ts';
import { validateQuestionBudgetProfile, validateQuestionIdentity, validateQuestionResult, validateRepositoryBinding } from '../contracts/questions/validation.ts';
import { validateId, validateDigest, isRecord } from '../contracts/questions/validation/shared.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import { createQuestionBudgetLedger, type QuestionBudgetLedger } from './budget.ts';
import { copySessionConstraints, projectQuestionSession, safeSessionText } from './session-projection.ts';
import { copyQuestionSourceReferences } from './graph-continuation.ts';
import type { QuestionSourceReference } from './graph-types.ts';
import { sameBinding } from './retrieval-admission.ts';
import { withRetrievalControl } from './retrieval-control.ts';
import type { OpenQuestionSessionOptions, QuestionSessionCreation, QuestionSessionProjection, QuestionSessionRefusal, QuestionSessionTurn } from './session-types.ts';
export type {
  OpenQuestionSessionOptions,
  QuestionSession,
  QuestionSessionCreation,
  QuestionSessionRunRequest,
  QuestionSessionProjection,
  QuestionSessionSnapshot,
  QuestionSessionTurn,
} from './session-types.ts';

interface Task {
  readonly id: string;
  readonly configDigest: string;
  readonly profile: QuestionBudgetProfileV1;
  readonly budget: QuestionBudgetLedger;
  readonly binding: RepositoryBindingV1;
  projection: QuestionSessionProjection;
  turnId: string | null;
  result: QuestionResultV1 | null;
  contextBlocked: boolean;
  sourceReferences: readonly QuestionSourceReference[];
  ownerBlocked: boolean;
}
interface PreparedTask {
  readonly task: Task;
  readonly control: QuestionRepositoryOperationControl;
}
const refused = (reasonCode: QuestionSessionRefusal): Extract<QuestionSessionTurn, { status: 'refused' }> => Object.freeze({ status: 'refused', reasonCode });
const onlyKeys = (input: Record<string, unknown>, allowed: readonly string[]) => Object.keys(input).every(key => allowed.includes(key));

/** Creates a fresh process-local capability. No serialized session, summary or result can reopen it. */
export function openSession(options: OpenQuestionSessionOptions): QuestionSessionCreation {
  const { sessionId: suppliedId, run: runner, pricing: suppliedPricing, now, expiresAtEpochMs: expiry } = options ?? {};
  if (
    validateId(suppliedId, 'sessionId') ||
    typeof runner !== 'function' ||
    (now !== undefined && typeof now !== 'function') ||
    (expiry !== undefined && (!Number.isFinite(expiry) || expiry <= Date.now()))
  )
    return { ok: false, reasonCode: 'invalid-config' };
  const sessionId = suppliedId as string;
  const pricing = isRecord(suppliedPricing) ? Object.freeze({ ...suppliedPricing }) : suppliedPricing;
  let closed = false;
  let busy = false;
  let compacting = false;
  let preparing = false;
  let switching = false;
  let inFlight: Promise<QuestionSessionTurn> | undefined;
  let sequence = 0;
  let active: Task | undefined;
  let controller: AbortController | undefined;
  const usedTasks = new Set<string>();
  function isClosed() {
    if (expiry !== undefined && Date.now() >= expiry) closeSession();
    return closed;
  }
  function closeSession(): void {
    closed = true;
    controller?.abort();
    active?.budget.cancel();
    active = undefined;
  }
  function gate() {
    return isClosed() ? refused('closed') : busy || switching || preparing ? refused('busy') : undefined;
  }
  function captureControl(control: QuestionRepositoryOperationControl): QuestionRepositoryOperationControl | undefined {
    const { signal, deadlineEpochMs, work } = control ?? {};
    return signal instanceof AbortSignal && Number.isFinite(deadlineEpochMs) && !signal.aborted && Date.now() < deadlineEpochMs
      ? Object.freeze({ signal, deadlineEpochMs, ...(work ? { work } : {}) })
      : undefined;
  }
  async function execute(task: Task, question: string, control: QuestionRepositoryOperationControl): Promise<QuestionSessionTurn> {
    busy = true;
    const current = new AbortController();
    controller = current;
    const deadlineEpochMs = Math.min(control.deadlineEpochMs, expiry ?? Infinity);
    let interruption: 'cancelled' | 'deadline' | undefined;
    const abort = () => {
      current.abort();
      task.budget.cancel();
    };
    control.signal.addEventListener('abort', abort, { once: true });
    const turnId = 'turn:' + ++sequence;
    const identity = validateQuestionIdentity({ sessionId, taskId: task.id, runId: 'run:' + sequence, questionId: 'question:' + sequence, binding: task.binding, configDigest: task.configDigest });
    if (!identity.ok) {
      busy = false;
      return refused('invalid-request');
    }
    task.turnId = turnId;
    const stop = (): QuestionSessionTurn | undefined => {
      if (control.signal.aborted) abort();
      if (isClosed()) return refused('closed');
      const deadline = interruption === 'deadline' || Date.now() >= deadlineEpochMs;
      if (!deadline && interruption !== 'cancelled' && !current.signal.aborted) return undefined;
      abort();
      const result: QuestionResultV1 = Object.freeze({
        schemaVersion: 'repository-question/1',
        identity: identity.value,
        usage: { status: 'missing' as const },
        ...(deadline ? { kind: 'budget-exhausted' as const, reasonCode: 'elapsed-deadline' as const } : { kind: 'cancelled' as const, reasonCode: 'cancelled' as const }),
      });
      task.result = result;
      task.sourceReferences = [];
      return Object.freeze({ status: 'completed', turnId, result, retrieval: null });
    };
    try {
      const before = stop();
      if (before) return before;
      const run = await withRetrievalControl<Awaited<ReturnType<typeof runner>> | null>(
        Object.freeze({ ...control, deadlineEpochMs, signal: current.signal }),
        bounded =>
          stop()
            ? Promise.resolve(null)
            : runner(Object.freeze({ identity: identity.value, question, profile: task.profile, budget: task.budget, context: task.projection, sourceReferences: task.sourceReferences }), bounded),
        failure => {
          interruption = failure.reasonCode === 'deadline' ? 'deadline' : 'cancelled';
          if (expiry !== undefined && Date.now() >= expiry) closeSession();
          else abort();
          return null;
        },
      );
      const after = stop();
      if (after) return after;
      if (!run) return refused('accounting-pending');
      const checked = validateQuestionResult(run.result);
      const result: QuestionResultV1 = current.signal.aborted
        ? Object.freeze({ schemaVersion: 'repository-question/1', identity: identity.value, usage: { status: 'missing' as const }, kind: 'cancelled', reasonCode: 'cancelled' })
        : checked.ok && JSON.stringify(checked.value.identity) === JSON.stringify(identity.value)
          ? checked.value
          : Object.freeze({ schemaVersion: 'repository-question/1', identity: identity.value, usage: { status: 'missing' as const }, kind: 'failed', reasonCode: 'invalid-decision' });
      task.result = result;
      task.sourceReferences = copyQuestionSourceReferences(run.sourceReferences ?? [], identity.value, task.profile) ?? [];
      const pending = result.kind === 'awaiting-clarification' ? result.clarification.question : null;
      const projected = projectQuestionSession({ ...task.projection, pendingClarification: pending }, task.profile.runtime.maxConversationBytes);
      if (!projected) {
        task.contextBlocked = true;
        return Object.freeze({
          status: 'completed',
          turnId,
          result: Object.freeze({ schemaVersion: 'repository-question/1', identity: identity.value, usage: result.usage, kind: 'blocked', reasonCode: 'context-limit' }),
          retrieval: null,
        });
      }
      task.projection = projected;
      return stop() ?? Object.freeze({ status: 'completed', turnId, result, retrieval: run.retrieval });
    } catch {
      const stopped = stop();
      if (stopped) return stopped;
      task.ownerBlocked = true;
      task.budget.cancel();
      return refused('accounting-pending');
    } finally {
      control.signal.removeEventListener('abort', abort);
      if (controller === current) controller = undefined;
      busy = false;
    }
  }
  function prepareTask(input: unknown, control: QuestionRepositoryOperationControl): PreparedTask | Extract<QuestionSessionTurn, { status: 'refused' }> {
    if (!isRecord(input) || !onlyKeys(input, ['taskId', 'question', 'constraints', 'binding', 'configDigest', 'profile'])) return refused('invalid-request');
    const { taskId, question, constraints: suppliedConstraints, binding: suppliedBinding, configDigest, profile: suppliedProfile } = input;
    const capturedControl = captureControl(control);
    if (!capturedControl || validateId(taskId, 'taskId') || usedTasks.has(taskId as string) || validateDigest(configDigest, 'configDigest')) return refused('invalid-request');
    const profile = validateQuestionBudgetProfile(suppliedProfile);
    const binding = validateRepositoryBinding(isRecord(suppliedBinding) ? { ...suppliedBinding } : suppliedBinding);
    if (!profile.ok || !binding.ok || !safeSessionText(question, profile.value.repository.maxQueryBytes)) return refused('invalid-request');
    const constraints = copySessionConstraints(suppliedConstraints ?? [], profile.value.runtime.maxConversationBytes);
    if (!constraints) return refused('invalid-request');
    const projection = projectQuestionSession(
      { taskId: taskId as string, binding: binding.value, intent: question, constraints, pendingClarification: null, conversation: [] },
      profile.value.runtime.maxConversationBytes,
    );
    if (!projection) return refused('context-limit');
    const budget = createQuestionBudgetLedger(profile.value, { pricing, ...(now ? { now } : {}) });
    if (!budget.ok) return refused('invalid-request');
    const task: Task = {
      id: projection.taskId,
      configDigest: configDigest as string,
      profile: profile.value,
      binding: binding.value,
      budget: budget.value,
      projection,
      turnId: null,
      result: null,
      contextBlocked: false,
      sourceReferences: [],
      ownerBlocked: false,
    };
    return { task, control: capturedControl };
  }
  function accountingPending(task: Task): boolean {
    const state = task.budget.snapshot();
    return task.ownerBlocked || state.status === 'blocked' || Object.values(state.reserved).some(value => value > 0);
  }
  function launch(task: Task, question: string, control: QuestionRepositoryOperationControl): Promise<QuestionSessionTurn> {
    active = task;
    usedTasks.add(task.id);
    const operation = execute(task, question, control);
    inFlight = operation;
    return operation.finally(() => {
      if (inFlight === operation) inFlight = undefined;
    });
  }
  async function startTask(input: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionSessionTurn> {
    const denial = gate();
    if (denial) return denial;
    preparing = true;
    try {
      const prepared = prepareTask(input, control);
      if ('status' in prepared) return prepared;
      if (active && accountingPending(active)) return refused('accounting-pending');
      if (active && (active.binding.repositoryId !== prepared.task.binding.repositoryId || active.binding.workspaceId !== prepared.task.binding.workspaceId)) return refused('switch-required');
      return launch(prepared.task, prepared.task.projection.intent, prepared.control);
    } finally {
      preparing = false;
    }
  }
  async function switchRepository(input: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionSessionTurn> {
    if (isClosed()) return refused('closed');
    if (switching || compacting || preparing) return refused('busy');
    switching = true;
    try {
      let prepared: ReturnType<typeof prepareTask>;
      preparing = true;
      try {
        prepared = prepareTask(input, control);
      } finally {
        preparing = false;
      }
      if ('status' in prepared) return prepared;
      const old = active;
      if (old) {
        controller?.abort();
        old.budget.cancel();
      }
      const pending = inFlight;
      if (pending) {
        const settled = await withRetrievalControl(
          prepared.control,
          async () => {
            await pending;
            return true;
          },
          () => false,
        );
        if (!settled) return refused(isClosed() ? 'closed' : 'accounting-pending');
      }
      if (isClosed()) return refused('closed');
      if (old && accountingPending(old)) return refused('accounting-pending');
      if (!captureControl(prepared.control)) return refused('invalid-request');
      return launch(prepared.task, prepared.task.projection.intent, prepared.control);
    } finally {
      switching = false;
    }
  }
  async function continueTask(input: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionSessionTurn> {
    const denial = gate();
    if (denial) return denial;
    if (!active || !isRecord(input) || !onlyKeys(input, ['taskId', 'turnId', 'question', 'clarificationId', 'rebind'])) return refused('invalid-request');
    const { taskId, turnId, question, clarificationId, rebind } = input;
    const capturedControl = captureControl(control);
    if (!capturedControl) return refused('invalid-request');
    if (taskId !== active.id) return refused(usedTasks.size > 1 && taskId === undefined ? 'clarification-required' : 'task-mismatch');
    if (turnId !== active.turnId) return refused('turn-mismatch');
    if (active.contextBlocked) return refused('context-limit');
    if (active.result?.kind === 'awaiting-clarification' && clarificationId !== active.result.clarification.clarificationId) return refused('clarification-required');
    if (!safeSessionText(question, active.profile.repository.maxQueryBytes)) return refused('invalid-request');
    if (active.result?.kind === 'stale-repository' && rebind === undefined) return refused('rebind-required');
    if (active.budget.snapshot().status !== 'open') return refused('budget-closed');
    let task = active;
    if (rebind !== undefined) {
      if (!isRecord(rebind) || !onlyKeys(rebind, ['binding'])) return refused('invalid-request');
      const rawBinding = rebind['binding'];
      const binding = validateRepositoryBinding(isRecord(rawBinding) ? { ...rawBinding } : rawBinding);
      if (!binding.ok) return refused('invalid-request');
      if (binding.value.repositoryId !== task.binding.repositoryId || binding.value.workspaceId !== task.binding.workspaceId || binding.value.policyDigest !== task.binding.policyDigest)
        return refused('switch-required');
      task = { ...task, binding: binding.value, sourceReferences: [], projection: { ...task.projection, binding: binding.value, conversation: [] } };
    }
    if (!sameBinding(task.binding, task.projection.binding)) return refused('rebind-required');
    const projection = projectQuestionSession({ ...task.projection, conversation: [...task.projection.conversation, { role: 'user', text: question }] }, task.profile.runtime.maxConversationBytes);
    if (!projection) return refused('context-limit');
    task.projection = projection;
    return launch(task, question, capturedControl);
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      startTask,
      submitQuestion: startTask,
      continueTask,
      switchRepository,
      closeSession,
      async compactSession() {
        const denial = gate();
        if (denial) return denial;
        compacting = true;
        busy = true;
        try {
          if (!active) return refused('invalid-request');
          if (active.contextBlocked) return refused('context-limit');
          const task = active;
          const projection = projectQuestionSession(task.projection, task.profile.runtime.maxConversationBytes);
          if (!projection) return refused('context-limit');
          const admission = task.budget.reserveSummary(Buffer.byteLength(JSON.stringify(projection)));
          if (!admission.ok) return refused('budget-closed');
          const result = await admission.value.execute(
            async () => projection,
            () => ({ kind: 'work', work: { conversationBytes: Buffer.byteLength(JSON.stringify(projection)) } }),
          );
          if (isClosed()) return refused('closed');
          if (!result.ok) return refused('budget-closed');
          task.projection = projection;
          return Object.freeze({ status: 'compacted' as const, projection });
        } finally {
          compacting = false;
          busy = false;
        }
      },
      cancelTask(input: unknown) {
        if (isClosed()) return refused('closed');
        if (!active || !isRecord(input) || !onlyKeys(input, ['taskId']) || input['taskId'] !== active.id) return refused('task-mismatch');
        controller?.abort();
        active.budget.cancel();
        return Object.freeze({ status: 'cancelled' as const });
      },
      snapshot() {
        isClosed();
        return Object.freeze({
          sessionId,
          closed,
          busy: busy || switching || preparing,
          taskId: active?.id ?? null,
          turnId: active?.turnId ?? null,
          projection: active?.projection ?? null,
          budget: active?.budget.snapshot() ?? null,
        });
      },
    }),
  });
}
