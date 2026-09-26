import { z } from "zod";

import { checkTaskDeadline, consumeAgentStep, consumeRetry } from "./budget.js";
import type { BudgetExhaustion, TaskUsage } from "./budget.js";
import { TaskState } from "./task.js";
import type { TaskContext, TaskOutcome, TaskState as TaskStateType } from "./task.js";
import { advanceTask, changeTaskMode, finishTask, isTerminal } from "./transitions.js";

export type TaskEvent =
  | {
      readonly kind: "MODEL_PROPOSAL";
      readonly action: "PLAN" | "COMPLETE" | "INVALID";
    }
  | { readonly kind: "MODE_CHANGE"; readonly mode: "Ask" | "Edit" }
  | { readonly kind: "PROGRESS" }
  | { readonly kind: "REPLACE_OBJECTIVE"; readonly objective: string }
  | { readonly kind: "TICK" }
  | { readonly kind: "CANCEL" }
  | { readonly kind: "POLICY_DENIAL"; readonly authorizedRouteRemains: boolean }
  | { readonly kind: "TRUSTED_TRANSITION"; readonly target: TaskStateType }
  | { readonly kind: "VERIFICATION_RESULT"; readonly passed: boolean }
  | { readonly kind: "RETRY" }
  | { readonly kind: "NO_CHANGE" };

export type TaskProcessingStatus =
  "ACCEPTED" | "ACTION_REJECTED" | "ALREADY_TERMINAL" | "PAUSED" | "BUDGET_EXHAUSTED";

export interface TaskProcessingResult {
  readonly status: TaskProcessingStatus;
  readonly task: TaskContext;
  readonly oldState: TaskStateType;
  readonly newState: TaskStateType;
  readonly usage: Readonly<TaskUsage>;
  readonly reason?:
    | "ACTION_NOT_ALLOWED"
    | "INVALID_MODEL_PROPOSAL"
    | "OBJECTIVE_IMMUTABLE"
    | "INTENT_RESTRICTED"
    | "ALREADY_TERMINAL"
    | TaskOutcome["reason"];
}

type TaskProcessingCore = Pick<TaskProcessingResult, "status" | "task" | "reason">;

const modelProposalSchema = z.strictObject({
  action: z.enum(["PLAN", "COMPLETE"]),
});

function exhausted(task: TaskContext, evidence: BudgetExhaustion): TaskProcessingCore {
  return {
    status: "BUDGET_EXHAUSTED",
    task: finishTask(task, { state: TaskState.FAILED, reason: "BUDGET_EXHAUSTED", evidence }),
  };
}

function processTaskEvent(task: TaskContext, event: TaskEvent, now: number): TaskProcessingCore {
  if (isTerminal(task.state)) {
    return { status: "ALREADY_TERMINAL", task, reason: "ALREADY_TERMINAL" };
  }
  if (task.budget === null || task.admittedAt === null) {
    return {
      status: "ACCEPTED",
      task: finishTask(task, { state: TaskState.FAILED, reason: "INVALID_TRANSITION" }),
    };
  }

  const budget = task.budget;
  let deadline: BudgetExhaustion | null;
  try {
    deadline = checkTaskDeadline(budget, task.admittedAt, now);
  } catch {
    return {
      status: "ACCEPTED",
      task: finishTask(task, { state: TaskState.FAILED, reason: "INTERNAL_ERROR" }),
    };
  }
  if (deadline !== null) return exhausted(task, deadline);

  if (event.kind === "TICK" || event.kind === "PROGRESS") {
    return { status: "ACCEPTED", task };
  }
  if (event.kind === "REPLACE_OBJECTIVE") {
    return { status: "ACTION_REJECTED", task, reason: "OBJECTIVE_IMMUTABLE" };
  }
  if (event.kind === "CANCEL") {
    return {
      status: "ACCEPTED",
      task: finishTask(task, { state: TaskState.CANCELLED, reason: "CANCELLED_BY_DEVELOPER" }),
    };
  }
  if (event.kind === "MODE_CHANGE") {
    const changed = changeTaskMode(task, event.mode);
    return {
      status:
        changed === task && event.mode !== task.mode
          ? "ACTION_REJECTED"
          : changed.state === TaskState.PAUSED_FOR_MODE
            ? "PAUSED"
            : "ACCEPTED",
      task: changed,
      reason: changed === task && event.mode !== task.mode ? "INTENT_RESTRICTED" : undefined,
    };
  }

  const step = consumeAgentStep(budget, task.usage);
  if (!step.allowed) return exhausted(task, step.evidence);
  const charged = Object.freeze({ ...task, usage: step.usage });

  if (event.kind === "POLICY_DENIAL") {
    return event.authorizedRouteRemains
      ? { status: "ACTION_REJECTED", task: charged, reason: "POLICY_DENIED" }
      : {
          status: "ACCEPTED",
          task: finishTask(charged, { state: TaskState.BLOCKED, reason: "POLICY_DENIED" }),
        };
  }
  if (event.kind === "TRUSTED_TRANSITION") {
    return { status: "ACCEPTED", task: advanceTask(charged, event.target) };
  }
  if (event.kind === "NO_CHANGE") {
    return {
      status: "ACCEPTED",
      task: finishTask(charged, { state: TaskState.COMPLETED, reason: "NO_CHANGE_NEEDED" }),
    };
  }
  if (event.kind === "VERIFICATION_RESULT") {
    if (charged.state !== TaskState.VERIFYING) {
      return { status: "ACCEPTED", task: advanceTask(charged, TaskState.REVIEWING) };
    }
    if (!event.passed) {
      const failedCheck = Object.freeze({ ...charged, verification: "FAILED" as const });
      if (charged.usage.retries >= budget.maxRetries) {
        return {
          status: "ACCEPTED",
          task: finishTask(failedCheck, { state: TaskState.FAILED, reason: "VERIFICATION_FAILED" }),
        };
      }
      return {
        status: "ACCEPTED",
        task: failedCheck,
      };
    }
    const verified = Object.freeze({ ...charged, verification: "PASSED" as const });
    return { status: "ACCEPTED", task: advanceTask(verified, TaskState.REVIEWING) };
  }
  if (event.kind === "RETRY") {
    if (
      charged.state !== TaskState.REVIEWING &&
      !(charged.state === TaskState.VERIFYING && charged.verification === "FAILED")
    ) {
      return { status: "ACCEPTED", task: advanceTask(charged, TaskState.REPAIRING) };
    }
    const retry = consumeRetry(budget, charged.usage);
    if (!retry.allowed) return exhausted(charged, retry.evidence);
    return {
      status: "ACCEPTED",
      task: advanceTask(
        Object.freeze({ ...charged, usage: retry.usage, retryAuthorized: true }),
        TaskState.REPAIRING,
      ),
    };
  }

  if (event.action === "PLAN" && charged.mode === "Edit" && charged.state === "INSPECTING") {
    return { status: "ACCEPTED", task: advanceTask(charged, TaskState.PLANNING) };
  }

  if (event.action === "COMPLETE" && charged.mode === "Ask" && charged.state === "ANSWERING") {
    return {
      status: "ACCEPTED",
      task: finishTask(charged, { state: TaskState.COMPLETED, reason: "ANSWERED" }),
    };
  }

  if (event.action === "COMPLETE" && charged.mode === "Edit" && charged.state === "REVIEWING") {
    if (charged.verification === "PASSED" && charged.changed) {
      return {
        status: "ACCEPTED",
        task: finishTask(charged, { state: TaskState.COMPLETED, reason: "EDIT_VERIFIED" }),
      };
    }
  }

  return {
    status: "ACTION_REJECTED",
    task: charged,
    reason: event.action === "INVALID" ? "INVALID_MODEL_PROPOSAL" : "ACTION_NOT_ALLOWED",
  };
}

export function runTaskEvent(
  task: TaskContext,
  event: TaskEvent,
  now: number,
): TaskProcessingResult {
  const result = processTaskEvent(task, event, now);
  const reason = result.reason ?? (result.task !== task ? result.task.outcome?.reason : undefined);
  return Object.freeze({
    status: result.status,
    task: result.task,
    oldState: task.state,
    newState: result.task.state,
    usage: result.task.usage,
    ...(reason === undefined ? {} : { reason }),
  });
}

export function runModelProposal(
  task: TaskContext,
  rawProposal: unknown,
  now: number,
): TaskProcessingResult {
  const parsed = modelProposalSchema.safeParse(rawProposal);
  return runTaskEvent(
    task,
    { kind: "MODEL_PROPOSAL", action: parsed.success ? parsed.data.action : "INVALID" },
    now,
  );
}

export function runTaskScript(
  initial: TaskContext,
  script: readonly { readonly event: TaskEvent; readonly now: number }[],
): { readonly task: TaskContext; readonly results: readonly TaskProcessingResult[] } {
  let task = initial;
  const results: TaskProcessingResult[] = [];
  for (const entry of script) {
    if (isTerminal(task.state)) break;
    const result = runTaskEvent(task, entry.event, entry.now);
    results.push(result);
    task = result.task;
  }
  return Object.freeze({ task, results: Object.freeze(results) });
}
