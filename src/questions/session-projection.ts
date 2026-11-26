/** Deterministic user-intent projection. Source-bearing assistant prose is deliberately excluded. */
import type { QuestionSessionProjection } from './session-types.ts';
import { containsProtectedContent } from '../foundation/docker-workspace-policy.ts';

export function safeSessionText(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.isWellFormed() &&
    Buffer.byteLength(value) <= limit &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) &&
    !containsProtectedContent(value)
  );
}

/** Read each borrowed element once before validation, size checks or projection can inspect it again. */
export function copySessionConstraints(input: unknown, maxBytes: number): readonly string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const length = input.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > 64) return undefined;
  const captured: unknown[] = [];
  for (let index = 0; index < length; index++) captured.push(input[index]);
  const checked: string[] = [];
  for (const value of captured) {
    if (!safeSessionText(value, maxBytes)) return undefined;
    checked.push(value);
  }
  return Object.freeze(checked);
}

/** Returns no projection if mandatory intent cannot fit; optional turns are dropped whole, newest first. */
export function projectQuestionSession(input: QuestionSessionProjection, maxBytes: number): QuestionSessionProjection | undefined {
  const mandatory = { taskId: input.taskId, binding: input.binding, intent: input.intent, constraints: input.constraints, pendingClarification: input.pendingClarification };
  const turns: { readonly role: 'user'; readonly text: string }[] = [];
  if (Buffer.byteLength(JSON.stringify({ ...mandatory, conversation: turns })) > maxBytes) return undefined;
  for (let i = input.conversation.length - 1; i >= 0; i--) {
    const turn = input.conversation[i];
    if (!turn) continue;
    const candidate = [turn, ...turns];
    if (Buffer.byteLength(JSON.stringify({ ...mandatory, conversation: candidate })) <= maxBytes) turns.unshift(Object.freeze({ role: 'user', text: turn.text }));
  }
  return Object.freeze({ ...mandatory, constraints: Object.freeze([...input.constraints]), conversation: Object.freeze(turns) });
}
