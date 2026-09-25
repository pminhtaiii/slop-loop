import { z } from "zod";

import { TaskState } from "./task.js";
import type { TaskContext, TaskMode, TaskOutcome, TaskState as TaskStateType } from "./task.js";

const transitions: Readonly<Partial<Record<TaskStateType, readonly TaskStateType[]>>> = {
  ADMITTED: [TaskState.INSPECTING],
  INSPECTING: [TaskState.ANSWERING, TaskState.PLANNING],
  ANSWERING: [TaskState.PLANNING],
  PLANNING: [TaskState.WAITING_FOR_FILE_PERMISSION],
  WAITING_FOR_FILE_PERMISSION: [TaskState.IMPLEMENTING],
  IMPLEMENTING: [TaskState.SANDBOX_READY],
  SANDBOX_READY: [TaskState.VERIFYING],
  VERIFYING: [TaskState.REVIEWING, TaskState.REPAIRING],
  REPAIRING: [TaskState.WAITING_FOR_FILE_PERMISSION, TaskState.IMPLEMENTING],
  REVIEWING: [TaskState.REPAIRING],
};

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
      resource: z.enum(["AGENT_STEPS", "RETRIES", "TASK_TIME"]),
      limit: z.number().finite().nonnegative(),
      observed: z.number().finite().nonnegative(),
      attempted: z.number().finite().nonnegative(),
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
      ? { ...evidence, evidence: Object.freeze({ ...evidence.evidence }) }
      : evidence;

  return Object.freeze({
    ...task,
    state: outcome.state,
    outcome: Object.freeze(sealedOutcome),
  });
}

export function changeTaskMode(task: TaskContext, mode: TaskMode): TaskContext {
  if (isTerminal(task.state) || task.mode === mode) return task;
  if (mode !== "Ask" && mode !== "Edit") return task;
  if (mode === "Edit" && task.intent !== "CHANGE") return task;

  if (task.mode === "Edit" && mode === "Ask") {
    if (task.state === TaskState.RECEIVED) {
      return Object.freeze({ ...task, mode });
    }
    return Object.freeze({
      ...task,
      mode,
      state: TaskState.PAUSED_FOR_MODE,
      pausedFrom: task.state,
      retryAuthorized: false,
    });
  }

  if (task.state === TaskState.PAUSED_FOR_MODE) {
    return Object.freeze({
      ...task,
      mode,
      state: TaskState.INSPECTING,
      pausedFrom: null,
      verification: "NOT_RUN",
      retryAuthorized: false,
    });
  }

  return Object.freeze({
    ...task,
    mode,
    state: task.state === TaskState.ANSWERING ? TaskState.PLANNING : task.state,
  });
}
