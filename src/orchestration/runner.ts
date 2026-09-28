import { z } from "zod";

import { consumeModelTurn, consumeRetry, consumeToolAttempt, recordActiveWork } from "./budget.js";
import type { BudgetDecision, BudgetExhaustion, RetryReason, TaskUsage } from "./budget.js";
import { TaskState } from "./task.js";
import type { TaskContext, TaskOutcome, TaskState as TaskStateType } from "./task.js";
import { advanceTask, finishTask, isTerminal } from "./transitions.js";

export type TaskEvent =
  | { readonly kind: "MODEL_PROPOSAL"; readonly action: "PLAN" | "COMPLETE" | "INVALID" }
  | { readonly kind: "TOOL_ATTEMPT" }
  | { readonly kind: "RECOVER"; readonly reason: "MODEL_RECOVERY" | "DENIAL_RECOVERY" }
  | { readonly kind: "MODE_CHANGE"; readonly mode: "Ask" | "Edit" }
  | {
      readonly kind: "PROGRESS";
      readonly report?: {
        readonly completedAction?: string;
        readonly changedPath?: string;
        readonly blocker?: string;
        readonly remainingStep?: string;
      };
    }
  | { readonly kind: "REPLACE_OBJECTIVE"; readonly objective: string }
  | { readonly kind: "TICK" }
  | { readonly kind: "CANCEL" }
  | { readonly kind: "POLICY_DENIAL"; readonly authorizedRouteRemains: boolean }
  | { readonly kind: "TRUSTED_TRANSITION"; readonly target: TaskStateType }
  | { readonly kind: "VERIFICATION_RESULT"; readonly passed: boolean }
  | { readonly kind: "RETRY" }
  | { readonly kind: "NO_CHANGE" };

export type TaskProcessingStatus =
  "ACCEPTED" | "ACTION_REJECTED" | "ALREADY_TERMINAL" | "BUDGET_EXHAUSTED";

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
    | "TASK_MODE_FIXED"
    | "TASK_STOPPING"
    | "TOOL_IN_FLIGHT"
    | "INVALID_PROGRESS"
    | "ALREADY_TERMINAL"
    | TaskOutcome["reason"];
}

type TaskProcessingCore = Pick<TaskProcessingResult, "status" | "task" | "reason">;

const modelProposalSchema = z.strictObject({
  action: z.enum(["PLAN", "COMPLETE"]),
});

const progressReportSchema = z.strictObject({
  completedAction: z.string().trim().min(1).max(256).optional(),
  changedPath: z.string().trim().min(1).max(256).optional(),
  blocker: z.string().trim().min(1).max(256).optional(),
  remainingStep: z.string().trim().min(1).max(256).optional(),
});

function exhausted(task: TaskContext, evidence: BudgetExhaustion): TaskProcessingCore {
  const changedPaths = task.progress.changedPaths;
  const blockers =
    task.changed && changedPaths.length === 0 && task.progress.blockers.length < 32
      ? Object.freeze([
          ...task.progress.blockers,
          "Review the current checkout to identify changed paths.",
        ])
      : task.progress.blockers;
  return {
    status: "BUDGET_EXHAUSTED",
    task: finishTask(task, {
      state: TaskState.FAILED,
      reason: "BUDGET_EXHAUSTED",
      evidence,
      handoff: {
        exhaustedBudget: evidence.resource,
        limit: evidence.limit,
        observed: evidence.observed,
        objective: task.objective,
        completedActions: task.progress.completedActions,
        changedPaths,
        verification: task.verification,
        blockers,
        stopReason: `${evidence.resource} limit reached`,
        remainingSteps:
          task.progress.remainingSteps.length > 0
            ? task.progress.remainingSteps
            : Object.freeze(["Review this handoff before starting a new task."]),
      },
    }),
  };
}

function applyCharge(task: TaskContext, decision: BudgetDecision): TaskProcessingCore {
  if (!decision.allowed) return exhausted(task, decision.evidence);
  return {
    status: "ACCEPTED",
    task: Object.freeze({ ...task, budget: decision.budget, usage: decision.usage }),
  };
}

function recover(task: TaskContext, reason: RetryReason): TaskProcessingCore {
  if (task.budget === null) {
    return {
      status: "ACCEPTED",
      task: finishTask(task, { state: TaskState.FAILED, reason: "INTERNAL_ERROR" }),
    };
  }
  return applyCharge(task, consumeRetry(task.budget, task.usage, reason));
}

function processTaskEvent(task: TaskContext, event: TaskEvent, now: number): TaskProcessingCore {
  if (isTerminal(task.state)) {
    return { status: "ALREADY_TERMINAL", task, reason: "ALREADY_TERMINAL" };
  }
  if (task.budget === null || task.lastObservedAt === null) {
    return {
      status: "ACCEPTED",
      task: finishTask(task, { state: TaskState.FAILED, reason: "INVALID_TRANSITION" }),
    };
  }

  if (event.kind === "CANCEL") {
    return {
      status: "ACCEPTED",
      task: finishTask(task, { state: TaskState.CANCELLED, reason: "CANCELLED_BY_DEVELOPER" }),
    };
  }

  if (!Number.isFinite(now) || now < task.lastObservedAt) {
    return {
      status: "ACCEPTED",
      task: finishTask(task, { state: TaskState.FAILED, reason: "INTERNAL_ERROR" }),
    };
  }
  const delta =
    task.state === TaskState.WAITING_FOR_FILE_PERMISSION ? 0 : now - task.lastObservedAt;
  let timed: BudgetDecision;
  try {
    timed = recordActiveWork(task.budget, task.usage, delta);
  } catch {
    return {
      status: "ACCEPTED",
      task: finishTask(task, { state: TaskState.FAILED, reason: "INTERNAL_ERROR" }),
    };
  }
  if (!timed.allowed) return exhausted(task, timed.evidence);
  const observed = Object.freeze({ ...task, usage: timed.usage, lastObservedAt: now });

  if (event.kind === "TICK") {
    return { status: "ACCEPTED", task: observed };
  }
  if (event.kind === "PROGRESS") {
    if (event.report === undefined) return { status: "ACCEPTED", task: observed };
    const parsed = progressReportSchema.safeParse(event.report);
    if (!parsed.success) {
      return { status: "ACTION_REJECTED", task: observed, reason: "INVALID_PROGRESS" };
    }
    if (parsed.data.changedPath !== undefined && (!observed.changed || observed.mode !== "Edit")) {
      return { status: "ACTION_REJECTED", task: observed, reason: "INVALID_PROGRESS" };
    }
    const next = {
      completedActions:
        parsed.data.completedAction === undefined
          ? observed.progress.completedActions
          : [...observed.progress.completedActions, parsed.data.completedAction],
      changedPaths:
        parsed.data.changedPath === undefined
          ? observed.progress.changedPaths
          : [...observed.progress.changedPaths, parsed.data.changedPath],
      blockers:
        parsed.data.blocker === undefined
          ? observed.progress.blockers
          : [...observed.progress.blockers, parsed.data.blocker],
      remainingSteps:
        parsed.data.remainingStep === undefined
          ? observed.progress.remainingSteps
          : [...observed.progress.remainingSteps, parsed.data.remainingStep],
    };
    if (Object.values(next).some((items) => items.length > 32)) {
      return { status: "ACTION_REJECTED", task: observed, reason: "INVALID_PROGRESS" };
    }
    return {
      status: "ACCEPTED",
      task: Object.freeze({
        ...observed,
        progress: Object.freeze({
          completedActions: Object.freeze(next.completedActions),
          changedPaths: Object.freeze(next.changedPaths),
          blockers: Object.freeze(next.blockers),
          remainingSteps: Object.freeze(next.remainingSteps),
        }),
      }),
    };
  }
  if (event.kind === "REPLACE_OBJECTIVE") {
    return { status: "ACTION_REJECTED", task: observed, reason: "OBJECTIVE_IMMUTABLE" };
  }
  if (event.kind === "MODE_CHANGE") {
    return event.mode === task.mode
      ? { status: "ACCEPTED", task: observed }
      : { status: "ACTION_REJECTED", task: observed, reason: "TASK_MODE_FIXED" };
  }
  if (event.kind === "TOOL_ATTEMPT") {
    return applyCharge(observed, consumeToolAttempt(task.budget, observed.usage));
  }
  if (event.kind === "RECOVER") {
    return recover(observed, event.reason);
  }
  if (event.kind === "POLICY_DENIAL") {
    return event.authorizedRouteRemains
      ? { status: "ACTION_REJECTED", task: observed, reason: "POLICY_DENIED" }
      : {
          status: "ACCEPTED",
          task: finishTask(observed, { state: TaskState.BLOCKED, reason: "POLICY_DENIED" }),
        };
  }
  if (event.kind === "TRUSTED_TRANSITION") {
    return { status: "ACCEPTED", task: advanceTask(observed, event.target) };
  }
  if (event.kind === "NO_CHANGE") {
    return {
      status: "ACCEPTED",
      task: finishTask(observed, { state: TaskState.COMPLETED, reason: "NO_CHANGE_NEEDED" }),
    };
  }
  if (event.kind === "VERIFICATION_RESULT") {
    if (observed.state !== TaskState.VERIFYING) {
      return { status: "ACCEPTED", task: advanceTask(observed, TaskState.REVIEWING) };
    }
    if (!event.passed) {
      return {
        status: "ACCEPTED",
        task: Object.freeze({ ...observed, verification: "FAILED" as const }),
      };
    }
    const verified = Object.freeze({ ...observed, verification: "PASSED" as const });
    return { status: "ACCEPTED", task: advanceTask(verified, TaskState.REVIEWING) };
  }
  if (event.kind === "RETRY") {
    if (
      observed.state !== TaskState.REVIEWING &&
      !(observed.state === TaskState.VERIFYING && observed.verification === "FAILED")
    ) {
      return { status: "ACCEPTED", task: advanceTask(observed, TaskState.REPAIRING) };
    }
    const retry = recover(observed, "VERIFICATION_REPAIR");
    if (retry.status === "BUDGET_EXHAUSTED") return retry;
    return {
      status: "ACCEPTED",
      task: advanceTask(
        Object.freeze({ ...retry.task, retryAuthorized: true }),
        TaskState.REPAIRING,
      ),
    };
  }

  const modelTurn = applyCharge(observed, consumeModelTurn(task.budget, observed.usage));
  if (modelTurn.status === "BUDGET_EXHAUSTED") return modelTurn;
  const charged = modelTurn.task;
  if (
    event.action === "PLAN" &&
    charged.mode === "Edit" &&
    charged.state === TaskState.INSPECTING
  ) {
    return { status: "ACCEPTED", task: advanceTask(charged, TaskState.PLANNING) };
  }
  if (
    event.action === "COMPLETE" &&
    charged.mode === "Ask" &&
    charged.state === TaskState.ANSWERING
  ) {
    return {
      status: "ACCEPTED",
      task: finishTask(charged, { state: TaskState.COMPLETED, reason: "ANSWERED" }),
    };
  }
  if (
    event.action === "COMPLETE" &&
    charged.mode === "Edit" &&
    charged.state === TaskState.REVIEWING &&
    charged.verification === "PASSED" &&
    charged.changed
  ) {
    return {
      status: "ACCEPTED",
      task: finishTask(charged, { state: TaskState.COMPLETED, reason: "EDIT_VERIFIED" }),
    };
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

export class TaskCheckoutSlot {
  private owner: string | null = null;

  get heldBy(): string | null {
    return this.owner;
  }

  claim(taskId: string): void {
    if (this.owner !== null) throw new Error("Checkout already has an active task");
    this.owner = taskId;
  }

  release(taskId: string): void {
    if (this.owner !== taskId) throw new Error("Checkout slot ownership mismatch");
    this.owner = null;
  }
}

export class TaskRunner {
  private currentTask: TaskContext;
  private readonly slot: TaskCheckoutSlot;
  private inFlightGeneration: number | null = null;
  private generation = 0;
  private abortController: AbortController | null = null;
  private stopping = false;

  constructor(task: TaskContext, slot: TaskCheckoutSlot) {
    if (task.budget === null || isTerminal(task.state)) {
      throw new Error("Only an admitted active task can claim a checkout slot");
    }
    slot.claim(task.taskId);
    this.currentTask = task;
    this.slot = slot;
  }

  get task(): TaskContext {
    return this.currentTask;
  }

  private reject(
    status: TaskProcessingStatus,
    reason: TaskProcessingResult["reason"],
  ): TaskProcessingResult {
    return Object.freeze({
      status,
      task: this.currentTask,
      oldState: this.currentTask.state,
      newState: this.currentTask.state,
      usage: this.currentTask.usage,
      reason,
    });
  }

  process(event: TaskEvent, now: number): TaskProcessingResult {
    if (isTerminal(this.currentTask.state)) return runTaskEvent(this.currentTask, event, now);
    if (this.stopping) return this.reject("ACTION_REJECTED", "TASK_STOPPING");
    if (
      this.inFlightGeneration !== null &&
      event.kind !== "CANCEL" &&
      event.kind !== "PROGRESS" &&
      event.kind !== "TICK"
    ) {
      return this.reject("ACTION_REJECTED", "TOOL_IN_FLIGHT");
    }
    if (event.kind === "CANCEL") {
      const oldState = this.currentTask.state;
      this.stop(now);
      return Object.freeze({
        status: "ACCEPTED",
        task: this.currentTask,
        oldState,
        newState: this.currentTask.state,
        usage: this.currentTask.usage,
        ...(this.currentTask.outcome === null ? {} : { reason: this.currentTask.outcome.reason }),
      });
    }
    const result = runTaskEvent(this.currentTask, event, now);
    this.currentTask = result.task;
    if (isTerminal(this.currentTask.state)) {
      if (this.inFlightGeneration === null) {
        this.slot.release(this.currentTask.taskId);
      } else {
        this.stopping = true;
        this.generation += 1;
        this.abortController?.abort();
      }
    }
    return result;
  }

  beginToolAttempt(
    now: number,
  ): { readonly generation: number; readonly signal: AbortSignal } | null {
    if (this.stopping || this.inFlightGeneration !== null) return null;
    const result = this.process({ kind: "TOOL_ATTEMPT" }, now);
    if (result.status !== "ACCEPTED" || isTerminal(this.currentTask.state)) return null;
    this.inFlightGeneration = ++this.generation;
    this.abortController = new AbortController();
    return Object.freeze({
      generation: this.inFlightGeneration,
      signal: this.abortController.signal,
    });
  }

  canStart(generation: number): boolean {
    return (
      !this.stopping &&
      this.inFlightGeneration === generation &&
      this.slot.heldBy === this.currentTask.taskId &&
      this.abortController?.signal.aborted === false
    );
  }

  stop(now: number): void {
    if (this.stopping || isTerminal(this.currentTask.state)) return;
    this.stopping = true;
    this.generation += 1;
    this.abortController?.abort();
    if (this.inFlightGeneration === null) {
      this.currentTask = runTaskEvent(this.currentTask, { kind: "CANCEL" }, now).task;
      this.slot.release(this.currentTask.taskId);
    }
  }

  settleToolAttempt(generation: number, now: number): void {
    if (this.inFlightGeneration !== generation) throw new Error("Unknown in-flight tool attempt");
    this.inFlightGeneration = null;
    this.abortController = null;
    if (this.stopping) {
      if (!isTerminal(this.currentTask.state)) {
        this.currentTask = runTaskEvent(this.currentTask, { kind: "CANCEL" }, now).task;
      }
      this.slot.release(this.currentTask.taskId);
    }
  }
}
