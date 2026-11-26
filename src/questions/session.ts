/** Owns in-memory task identity, serialized turns and advisory context; run effects stay behind the injected boundary. */
import type { QuestionBudgetProfileV1, QuestionResultV1, RepositoryBindingV1 } from '../contracts/questions/contracts.ts';
import { validateQuestionBudgetProfile, validateQuestionIdentity, validateQuestionResult, validateRepositoryBinding } from '../contracts/questions/validation.ts';
import { validateId, validateDigest, isRecord } from '../contracts/questions/validation/shared.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import { createQuestionBudgetLedger, type QuestionBudgetLedger } from './budget.ts';
import { projectQuestionSession, safeSessionText } from './session-projection.ts';
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
    return isClosed() ? refused('closed') : busy ? refused('busy') : undefined;
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
    try {
      const run = await runner(
        Object.freeze({ identity: identity.value, question, profile: task.profile, budget: task.budget, context: task.projection }),
        Object.freeze({ ...control, signal: current.signal }),
      );
      if (isClosed()) return refused('closed');
      const checked = validateQuestionResult(run.result);
      const result: QuestionResultV1 = current.signal.aborted
        ? Object.freeze({ schemaVersion: 'repository-question/1', identity: identity.value, usage: { status: 'missing' as const }, kind: 'cancelled', reasonCode: 'cancelled' })
        : checked.ok && JSON.stringify(checked.value.identity) === JSON.stringify(identity.value)
          ? checked.value
          : Object.freeze({ schemaVersion: 'repository-question/1', identity: identity.value, usage: { status: 'missing' as const }, kind: 'failed', reasonCode: 'invalid-decision' });
      task.result = result;
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
      return Object.freeze({ status: 'completed', turnId, result, retrieval: run.retrieval });
    } catch {
      if (isClosed()) return refused('closed');
      task.budget.cancel();
      return refused('accounting-pending');
    } finally {
      control.signal.removeEventListener('abort', abort);
      if (controller === current) controller = undefined;
      busy = false;
    }
  }
  async function startTask(input: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionSessionTurn> {
    const denial = gate();
    if (denial) return denial;
    if (!isRecord(input) || !onlyKeys(input, ['taskId', 'question', 'constraints', 'binding', 'configDigest', 'profile'])) return refused('invalid-request');
    const { taskId, question, constraints: suppliedConstraints, binding: suppliedBinding, configDigest, profile: suppliedProfile } = input;
    const capturedControl = captureControl(control);
    if (!capturedControl || validateId(taskId, 'taskId') || usedTasks.has(taskId as string) || validateDigest(configDigest, 'configDigest')) return refused('invalid-request');
    const profile = validateQuestionBudgetProfile(suppliedProfile);
    const binding = validateRepositoryBinding(suppliedBinding);
    if (!profile.ok || !binding.ok || !safeSessionText(question, profile.value.repository.maxQueryBytes)) return refused('invalid-request');
    const constraints = suppliedConstraints ?? [];
    if (!Array.isArray(constraints) || constraints.length > 64 || !constraints.every(item => safeSessionText(item, profile.value.runtime.maxConversationBytes))) return refused('invalid-request');
    if (active && Object.values(active.budget.snapshot().reserved).some(value => value > 0)) return refused('accounting-pending');
    const projection = projectQuestionSession(
      { taskId: taskId as string, binding: binding.value, intent: question, constraints: constraints as string[], pendingClarification: null, conversation: [] },
      profile.value.runtime.maxConversationBytes,
    );
    if (!projection) return refused('context-limit');
    const budget = createQuestionBudgetLedger(profile.value, { pricing, ...(now ? { now } : {}) });
    if (!budget.ok) return refused('invalid-request');
    active = {
      id: projection.taskId,
      configDigest: configDigest as string,
      profile: profile.value,
      binding: binding.value,
      budget: budget.value,
      projection,
      turnId: null,
      result: null,
      contextBlocked: false,
    };
    usedTasks.add(active.id);
    return execute(active, projection.intent, capturedControl);
  }
  async function continueTask(input: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionSessionTurn> {
    const denial = gate();
    if (denial) return denial;
    if (!active || !isRecord(input) || !onlyKeys(input, ['taskId', 'turnId', 'question', 'clarificationId'])) return refused('invalid-request');
    const { taskId, turnId, question, clarificationId } = input;
    const capturedControl = captureControl(control);
    if (!capturedControl) return refused('invalid-request');
    if (taskId !== active.id) return refused(usedTasks.size > 1 && taskId === undefined ? 'clarification-required' : 'task-mismatch');
    if (turnId !== active.turnId) return refused('turn-mismatch');
    if (active.contextBlocked) return refused('context-limit');
    if (active.result?.kind === 'awaiting-clarification' && clarificationId !== active.result.clarification.clarificationId) return refused('clarification-required');
    if (!safeSessionText(question, active.profile.repository.maxQueryBytes)) return refused('invalid-request');
    if (active.result?.kind === 'stale-repository') return refused('rebind-required');
    if (active.budget.snapshot().status !== 'open') return refused('budget-closed');
    const projection = projectQuestionSession(
      { ...active.projection, conversation: [...active.projection.conversation, { role: 'user', text: question }] },
      active.profile.runtime.maxConversationBytes,
    );
    if (!projection) return refused('context-limit');
    active.projection = projection;
    return execute(active, question, capturedControl);
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      startTask,
      submitQuestion: startTask,
      continueTask,
      closeSession,
      async compactSession() {
        const denial = gate();
        if (denial) return denial;
        if (!active) return refused('invalid-request');
        if (active.contextBlocked) return refused('context-limit');
        const task = active;
        const projection = projectQuestionSession(task.projection, task.profile.runtime.maxConversationBytes);
        if (!projection) return refused('context-limit');
        const admission = task.budget.reserveSummary(Buffer.byteLength(JSON.stringify(projection)));
        if (!admission.ok) return refused('budget-closed');
        busy = true;
        try {
          const result = await admission.value.execute(
            async () => projection,
            () => ({ kind: 'work', work: { conversationBytes: Buffer.byteLength(JSON.stringify(projection)) } }),
          );
          if (isClosed()) return refused('closed');
          if (!result.ok) return refused('budget-closed');
          task.projection = projection;
          return Object.freeze({ status: 'compacted' as const, projection });
        } finally {
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
          busy,
          taskId: active?.id ?? null,
          turnId: active?.turnId ?? null,
          projection: active?.projection ?? null,
          budget: active?.budget.snapshot() ?? null,
        });
      },
    }),
  });
}
