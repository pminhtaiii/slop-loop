import { z } from "zod";

import { TaskState } from "./task.js";
import type { TaskContext, TaskOutcome, TaskState as TaskStateType } from "./task.js";

const transitions: Readonly<Partial<Record<TaskStateType, readonly TaskStateType[]>>> = {
  ADMITTED: [TaskState.INSPECTING],
  INSPECTING: [TaskState.ANSWERING, TaskState.PLANNING],
  PLANNING: [TaskState.WAITING_FOR_FILE_PERMISSION],
  WAITING_FOR_FILE_PERMISSION: [TaskState.IMPLEMENTING],
  IMPLEMENTING: [TaskState.SANDBOX_READY],
  SANDBOX_READY: [TaskState.VERIFYING],
  VERIFYING: [TaskState.REVIEWING, TaskState.REPAIRING],
  REPAIRING: [TaskState.WAITING_FOR_FILE_PERMISSION, TaskState.IMPLEMENTING],
  REVIEWING: [TaskState.REPAIRING],
};

const handoffList = z.array(z.string().max(256)).max(32);

const outcomeSchema = z.union([
  z.strictObject({
    state: z.literal(TaskState.COMPLETED),
    reason: z.literal("ANSWERED"),
  }),
  z.strictObject({
    state: z.literal(TaskState.COMPLETED),
    reason: z.literal("EDIT_VERIFIED"),
    verification: z.literal("PASSED").optional(),
  }),
  z.strictObject({
    state: z.literal(TaskState.COMPLETED),
    reason: z.literal("NO_CHANGE_NEEDED"),
    verification: z.literal("NOT_RUN").optional(),
  }),
  z.strictObject({
    state: z.literal(TaskState.FAILED),
    reason: z.literal("BUDGET_EXHAUSTED"),
    evidence: z.strictObject({
      resource: z.enum(["MODEL_TURNS", "TOOL_ATTEMPTS", "RETRIES", "ACTIVE_WORK_TIME"]),
      limit: z.number().finite().nonnegative(),
      observed: z.number().finite().nonnegative(),
      attempted: z.number().finite().nonnegative(),
    }),
    handoff: z.strictObject({
      exhaustedBudget: z.enum(["MODEL_TURNS", "TOOL_ATTEMPTS", "RETRIES", "ACTIVE_WORK_TIME"]),
      limit: z.number().finite().nonnegative(),
      observed: z.number().finite().nonnegative(),
      objective: z.string().max(4_096),
      completedActions: handoffList,
      changedPaths: handoffList,
      verification: z.enum(["NOT_RUN", "PASSED", "FAILED"]),
      blockers: handoffList,
      stopReason: z.string().max(128),
      remainingSteps: handoffList,
    }),
  }),
  z.strictObject({
    state: z.literal(TaskState.FAILED),
    reason: z.enum(["INVALID_TRANSITION", "INTERNAL_ERROR", "VERIFICATION_FAILED"]),
    verification: z.literal("FAILED").optional(),
  }),
  z.strictObject({
    state: z.literal(TaskState.BLOCKED),
    reason: z.enum(["DEPENDENCY_UNAVAILABLE", "POLICY_DENIED"]),
  }),
  z.strictObject({
    state: z.literal(TaskState.CANCELLED),
    reason: z.literal("CANCELLED_BY_DEVELOPER"),
  }),
]);

export function isTerminal(state: TaskStateType): boolean {
  return (
    state === TaskState.COMPLETED ||
    state === TaskState.FAILED ||
    state === TaskState.BLOCKED ||
    state === TaskState.CANCELLED
  );
}

function invalidTransition(task: TaskContext): TaskContext {
  return Object.freeze({
    ...task,
    state: TaskState.FAILED,
    outcome: Object.freeze({ state: TaskState.FAILED, reason: "INVALID_TRANSITION" }),
  });
}

export function advanceTask(task: TaskContext, target: TaskStateType): TaskContext {
  if (isTerminal(task.state)) return task;

  const allowed = transitions[task.state]?.includes(target) ?? false;
  const modeAllowed =
    target === TaskState.ANSWERING
      ? task.mode === "Ask"
      : target === TaskState.PLANNING ||
          target === TaskState.WAITING_FOR_FILE_PERMISSION ||
          target === TaskState.IMPLEMENTING ||
          target === TaskState.SANDBOX_READY ||
          target === TaskState.VERIFYING ||
          target === TaskState.REPAIRING ||
          target === TaskState.REVIEWING
        ? task.mode === "Edit" && task.intent === "CHANGE"
        : true;

  if (!allowed || !modeAllowed) {
    return invalidTransition(task);
  }

  if (target === TaskState.REVIEWING && task.verification !== "PASSED") {
    return invalidTransition(task);
  }
  if (target === TaskState.REPAIRING && !task.retryAuthorized) {
    return invalidTransition(task);
  }

  return Object.freeze({
    ...task,
    state: target,
    changed: target === TaskState.SANDBOX_READY ? true : task.changed,
    verification:
      target === TaskState.IMPLEMENTING || target === TaskState.REPAIRING
        ? "NOT_RUN"
        : task.verification,
    retryAuthorized: false,
  });
}

export function finishTask(task: TaskContext, outcome: TaskOutcome): TaskContext {
  if (isTerminal(task.state)) return task;
  const parsed = outcomeSchema.safeParse(outcome);
  if (!parsed.success) return invalidTransition(task);
  outcome = parsed.data;

  if (
    outcome.state === TaskState.FAILED &&
    outcome.reason === "BUDGET_EXHAUSTED" &&
    (outcome.handoff.exhaustedBudget !== outcome.evidence.resource ||
      outcome.handoff.limit !== outcome.evidence.limit ||
      outcome.handoff.observed !== outcome.evidence.observed ||
      outcome.handoff.objective !== task.objective ||
      outcome.handoff.verification !== task.verification)
  ) {
    return invalidTransition(task);
  }

  if (outcome.state === TaskState.COMPLETED) {
    const answered =
      outcome.reason === "ANSWERED" && task.mode === "Ask" && task.state === TaskState.ANSWERING;
    const noChange =
      outcome.reason === "NO_CHANGE_NEEDED" &&
      task.mode === "Edit" &&
      task.intent === "CHANGE" &&
      !task.changed &&
      (task.state === TaskState.INSPECTING || task.state === TaskState.PLANNING);
    const verifiedEdit =
      outcome.reason === "EDIT_VERIFIED" &&
      task.mode === "Edit" &&
      task.state === TaskState.REVIEWING &&
      task.changed &&
      task.verification === "PASSED";
    if (!answered && !noChange && !verifiedEdit) {
      return invalidTransition(task);
    }
  }

  if (
    outcome.state === TaskState.FAILED &&
    outcome.reason === "VERIFICATION_FAILED" &&
    (task.state !== TaskState.VERIFYING || task.verification !== "FAILED")
  ) {
    return invalidTransition(task);
  }

  const evidence =
    outcome.state === TaskState.COMPLETED && outcome.reason === "NO_CHANGE_NEEDED"
      ? { ...outcome, verification: "NOT_RUN" as const }
      : outcome.state === TaskState.COMPLETED && outcome.reason === "EDIT_VERIFIED"
        ? { ...outcome, verification: "PASSED" as const }
        : outcome.state === TaskState.FAILED && outcome.reason === "VERIFICATION_FAILED"
          ? { ...outcome, verification: "FAILED" as const }
          : outcome;
  const sealedOutcome =
    evidence.state === TaskState.FAILED && evidence.reason === "BUDGET_EXHAUSTED"
      ? {
          ...evidence,
          evidence: Object.freeze({ ...evidence.evidence }),
          handoff: Object.freeze({
            ...evidence.handoff,
            completedActions: Object.freeze([...evidence.handoff.completedActions]),
            changedPaths: Object.freeze([...evidence.handoff.changedPaths]),
            blockers: Object.freeze([...evidence.handoff.blockers]),
            remainingSteps: Object.freeze([...evidence.handoff.remainingSteps]),
          }),
        }
      : evidence;

  return Object.freeze({
    ...task,
    state: outcome.state,
    outcome: Object.freeze(sealedOutcome),
  });
}
