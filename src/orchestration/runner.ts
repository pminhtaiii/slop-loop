import { z } from "zod";

import { consumeModelTurn, consumeRetry, consumeToolAttempt, recordActiveWork } from "./budget.js";
import type { BudgetDecision, BudgetExhaustion, RetryReason, TaskUsage } from "./budget.js";
import { TaskState } from "./task.js";
import type { TaskContext, TaskOutcome, TaskState as TaskStateType } from "./task.js";
import { advanceTask, finishTask, isTerminal } from "./transitions.js";
import type { ToolGateway, ToolGatewayResult } from "../tools/gateway.js";
import {
  observeVerificationCompletion,
  observeVerificationFreshness,
  verificationObservationStatus,
} from "../sandbox/verification.js";
import type {
  TrustedVerificationCompletion,
  TrustedVerificationObservation,
} from "../sandbox/verification.js";

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
  | { readonly kind: "POLICY_FAILURE" }
  | { readonly kind: "EXECUTION_FAILURE" }
  | { readonly kind: "AUDIT_UNAVAILABLE" }
  | { readonly kind: "AUDIT_INCOMPLETE" }
  | { readonly kind: "PREPARATION_REQUIRED" }
  | { readonly kind: "IMAGE_STALE" }
  | { readonly kind: "RUNTIME_UNAVAILABLE" }
  | { readonly kind: "CLEANUP_UNCONFIRMED" }
  | { readonly kind: "TOOL_CONTRACT_FAILURE" }
  | { readonly kind: "POLICY_DENIAL"; readonly authorizedRouteRemains: boolean }
  | { readonly kind: "TRUSTED_TRANSITION"; readonly target: TaskStateType }
  | { readonly kind: "VERIFICATION_RESULT"; readonly evidence: TrustedVerificationCompletion }
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

/**
 * Applies a task event with budget accounting and lifecycle checks.
 * Preserves terminal tasks and ends active tasks on policy or execution failure.
 */
function processTaskEvent(
  task: TaskContext,
  event: TaskEvent,
  now: number,
  observation?: TrustedVerificationObservation,
): TaskProcessingCore {
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

  if (event.kind === "POLICY_FAILURE") {
    return {
      status: "ACCEPTED",
      task: finishTask(task, { state: TaskState.FAILED, reason: "POLICY_FAILURE" }),
    };
  }

  if (event.kind === "EXECUTION_FAILURE") {
    return {
      status: "ACCEPTED",
      task: finishTask(task, { state: TaskState.FAILED, reason: "EXECUTION_FAILURE" }),
    };
  }

  if (event.kind === "TOOL_CONTRACT_FAILURE") {
    return {
      status: "ACCEPTED",
      task: finishTask(task, { state: TaskState.FAILED, reason: "TOOL_CONTRACT_FAILURE" }),
    };
  }

  if (
    event.kind === "AUDIT_UNAVAILABLE" ||
    event.kind === "AUDIT_INCOMPLETE" ||
    event.kind === "PREPARATION_REQUIRED" ||
    event.kind === "IMAGE_STALE" ||
    event.kind === "RUNTIME_UNAVAILABLE" ||
    event.kind === "CLEANUP_UNCONFIRMED"
  ) {
    return {
      status: "ACCEPTED",
      task: finishTask(task, { state: TaskState.BLOCKED, reason: event.kind }),
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
      return { status: "ACTION_REJECTED", task: observed, reason: "ACTION_NOT_ALLOWED" };
    }
    const verdict = verificationObservationStatus(observation, task, now, "RESULT", event.evidence);
    if (verdict === undefined)
      return { status: "ACTION_REJECTED", task: observed, reason: "ACTION_NOT_ALLOWED" };
    if (verdict === "FAIL") {
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
    verificationObservationStatus(observation, task, now, "COMPLETE") === "PASS" &&
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

/** Pure transition: runtime authority is supplied as an immutable, authenticated observation. */
export function runTaskEvent(
  task: TaskContext,
  event: TaskEvent,
  now: number,
  observation?: TrustedVerificationObservation,
): TaskProcessingResult {
  const result = processTaskEvent(task, event, now, observation);
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

/** Stateful trusted ingress. Reducer preflight avoids consuming receipts for ineligible events. */
export function observeTaskEvent(
  task: TaskContext,
  event: TaskEvent,
  now: number,
): TrustedVerificationObservation | undefined {
  const resultEvent = event.kind === "VERIFICATION_RESULT" && task.state === TaskState.VERIFYING;
  const completionEvent =
    event.kind === "MODEL_PROPOSAL" &&
    event.action === "COMPLETE" &&
    task.mode === "Edit" &&
    task.state === TaskState.REVIEWING &&
    task.verification === "PASSED";
  if (!resultEvent && !completionEvent) return undefined;
  const preflight = runTaskEvent(task, event, now);
  if (preflight.status !== "ACTION_REJECTED" || preflight.reason !== "ACTION_NOT_ALLOWED")
    return undefined;
  return event.kind === "VERIFICATION_RESULT"
    ? observeVerificationCompletion(event.evidence, task, now)
    : observeVerificationFreshness(task, now);
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
  script: readonly {
    readonly event: TaskEvent;
    readonly now: number;
    readonly observation?: TrustedVerificationObservation;
  }[],
): { readonly task: TaskContext; readonly results: readonly TaskProcessingResult[] } {
  let task = initial;
  const results: TaskProcessingResult[] = [];
  for (const entry of script) {
    if (isTerminal(task.state)) break;
    const result = runTaskEvent(task, entry.event, entry.now, entry.observation);
    results.push(result);
    task = result.task;
  }
  return Object.freeze({ task, results: Object.freeze(results) });
}

export interface CleanupIdentity {
  readonly taskId: string;
  readonly resourceId: string;
  readonly generation: number;
}
export type CleanupAcknowledgement = CleanupIdentity & {
  readonly status: "CONFIRMED" | "UNCERTAIN";
};
export interface ToolCleanupTracker {
  hold(resourceId: string): (status: "CONFIRMED" | "UNCERTAIN") => boolean;
}

export class TaskCheckoutSlot {
  private owner: string | null = null;
  private readonly holds = new Map<string, CleanupIdentity>();
  private releasePending = false;
  private generation = 0;
  private readonly settled = new Set<string>();

  nextGeneration(): number {
    if (this.generation === Number.MAX_SAFE_INTEGER)
      throw new Error("Checkout generation exhausted");
    if (!this.isHeld) this.settled.clear();
    return ++this.generation;
  }

  get heldBy(): string | null {
    return this.owner;
  }

  get isHeld(): boolean {
    return this.holds.size > 0;
  }

  hold(identity: CleanupIdentity): void {
    if (
      identity.taskId !== this.owner ||
      !identity.resourceId ||
      !Number.isSafeInteger(identity.generation) ||
      identity.generation < 0
    )
      throw new Error("Invalid cleanup hold identity");
    if (this.holds.has(identity.resourceId)) throw new Error("Resource already held");
    if (this.settled.has(`${identity.generation}:${identity.resourceId}`))
      throw new Error("Resource identity already settled");
    this.holds.set(identity.resourceId, Object.freeze({ ...identity }));
  }

  settle(ack: CleanupAcknowledgement): boolean {
    const hold = this.holds.get(ack.resourceId);
    if (
      !hold ||
      ack.status !== "CONFIRMED" ||
      hold.taskId !== ack.taskId ||
      hold.generation !== ack.generation
    )
      return false;
    this.holds.delete(ack.resourceId);
    this.settled.add(`${ack.generation}:${ack.resourceId}`);
    if (!this.isHeld && this.releasePending) {
      this.owner = null;
      this.releasePending = false;
    }
    return true;
  }

  claim(taskId: string): void {
    if (this.owner !== null || this.isHeld) throw new Error("Checkout already has an active task");
    this.owner = taskId;
  }

  release(taskId: string): void {
    if (this.owner !== taskId) throw new Error("Checkout slot ownership mismatch");
    if (this.isHeld) this.releasePending = true;
    else this.owner = null;
  }
}

export class TaskRunner {
  private currentTask: TaskContext;
  private readonly slot: TaskCheckoutSlot;
  private inFlightGeneration: number | null = null;
  private generation = 0;
  private abortController: AbortController | null = null;
  private stopping = false;
  private attemptCleanup: CleanupIdentity | null = null;
  private trackedResources = false;

  constructor(task: TaskContext, slot: TaskCheckoutSlot) {
    if (task.budget === null || isTerminal(task.state)) {
      throw new Error("Only an admitted active task can claim a checkout slot");
    }
    slot.claim(task.taskId);
    this.generation = slot.nextGeneration();
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
      this.slot.isHeld &&
      this.inFlightGeneration === null &&
      event.kind !== "CANCEL" &&
      event.kind !== "TICK" &&
      event.kind !== "PROGRESS" &&
      ![
        "POLICY_FAILURE",
        "EXECUTION_FAILURE",
        "TOOL_CONTRACT_FAILURE",
        "AUDIT_UNAVAILABLE",
        "AUDIT_INCOMPLETE",
        "PREPARATION_REQUIRED",
        "IMAGE_STALE",
        "RUNTIME_UNAVAILABLE",
        "CLEANUP_UNCONFIRMED",
      ].includes(event.kind)
    )
      return this.reject("ACTION_REJECTED", "TASK_STOPPING");
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
    const result = runTaskEvent(
      this.currentTask,
      event,
      now,
      observeTaskEvent(this.currentTask, event, now),
    );
    this.currentTask = result.task;
    if (isTerminal(this.currentTask.state)) {
      if (this.currentTask.outcome?.reason === "CLEANUP_UNCONFIRMED" && !this.slot.isHeld) {
        this.slot.hold({
          taskId: this.currentTask.taskId,
          resourceId: "unconfirmed-cleanup",
          generation: this.generation,
        });
      }
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

  beginToolAttempt(now: number): {
    readonly generation: number;
    readonly signal: AbortSignal;
    readonly cleanupIdentity?: CleanupIdentity;
  } | null {
    if (this.stopping || this.inFlightGeneration !== null || this.slot.isHeld) return null;
    const result = this.process({ kind: "TOOL_ATTEMPT" }, now);
    if (result.status !== "ACCEPTED" || isTerminal(this.currentTask.state)) return null;
    this.generation = this.slot.nextGeneration();
    this.inFlightGeneration = this.generation;
    this.trackedResources = false;
    this.abortController = new AbortController();
    if (this.currentTask.mode === "Edit" && this.currentTask.state === TaskState.VERIFYING) {
      this.attemptCleanup = Object.freeze({
        taskId: this.currentTask.taskId,
        resourceId: `tool-attempt-${this.inFlightGeneration}`,
        generation: this.inFlightGeneration,
      });
      this.slot.hold(this.attemptCleanup);
    }
    return Object.freeze({
      generation: this.inFlightGeneration,
      signal: this.abortController.signal,
      ...(this.attemptCleanup === null ? {} : { cleanupIdentity: this.attemptCleanup }),
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

  /** Trusted adapter registers effects before creating resources; output is never authority. */
  cleanupTracker(generation: number): ToolCleanupTracker {
    return Object.freeze({
      hold: (resourceId: string) => {
        if (!this.canStart(generation)) throw new Error("Tool attempt is fenced");
        const identity = Object.freeze({ taskId: this.currentTask.taskId, generation, resourceId });
        this.slot.hold(identity);
        this.trackedResources = true;
        return (status: "CONFIRMED" | "UNCERTAIN") => this.slot.settle({ ...identity, status });
      },
    });
  }

  /**
   * Dispatches proposed calls in order, charging and settling each tool attempt.
   * Stops when an attempt cannot start or a call fails, is denied, or needs file
   * permission. Returns the results collected before dispatch stopped.
   */
  async dispatchProposals(
    gateway: ToolGateway,
    proposedCalls: readonly unknown[],
    now: number,
  ): Promise<readonly ToolGatewayResult[]> {
    const results: ToolGatewayResult[] = [];
    for (const [responsePosition, proposedCall] of proposedCalls.entries()) {
      const attempt = this.beginToolAttempt(now);
      if (attempt === null) break;
      let result: ToolGatewayResult | undefined;
      try {
        result = await gateway.invoke(this.currentTask, proposedCall, responsePosition, {
          signal: attempt.signal,
          canStart: () => this.canStart(attempt.generation),
          cleanup: this.cleanupTracker(attempt.generation),
        });
      } finally {
        // These gateway outcomes prove no executor ran. All other outcomes require
        // a trusted cleanup adapter acknowledgement, independent of tool output.
        if (
          attempt.cleanupIdentity &&
          result &&
          (result.kind === "DENY" ||
            result.kind === "CANCELLED" ||
            (result.kind === "FAILED" &&
              result.reason === "POLICY_FAILURE" &&
              result.effect === undefined) ||
            result.kind === "NEEDS_FILE_PERMISSION" ||
            (result.kind === "BLOCKED" && result.effect === "NONE"))
        ) {
          this.slot.settle({ ...attempt.cleanupIdentity, status: "CONFIRMED" });
        }
        this.settleToolAttempt(attempt.generation, now);
      }
      results.push(result);
      if (result.kind === "FAILED") {
        this.process({ kind: result.reason }, now);
        break;
      }
      if (result.kind === "BLOCKED") {
        this.process({ kind: result.reason }, now);
        break;
      }
      if (result.kind === "TOOL_CONTRACT_FAILURE") {
        this.process({ kind: "TOOL_CONTRACT_FAILURE" }, now);
        break;
      }
      if (result.kind === "DENY") {
        this.process({ kind: "RECOVER", reason: "DENIAL_RECOVERY" }, now);
        break;
      }
      if (result.kind === "NEEDS_FILE_PERMISSION" || result.kind === "CANCELLED") break;
    }
    return Object.freeze(results);
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
    if (this.attemptCleanup && this.trackedResources)
      this.slot.settle({ ...this.attemptCleanup, status: "CONFIRMED" });
    this.inFlightGeneration = null;
    this.abortController = null;
    this.attemptCleanup = null;
    if (this.stopping) {
      if (!isTerminal(this.currentTask.state)) {
        this.currentTask = runTaskEvent(this.currentTask, { kind: "CANCEL" }, now).task;
      }
      this.slot.release(this.currentTask.taskId);
    }
  }
}
