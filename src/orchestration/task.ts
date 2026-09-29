import { z } from "zod";

import { EMPTY_TASK_USAGE, createTaskBudget } from "./budget.js";
import type { BudgetExhaustion, TaskBudget, TaskUsage } from "./budget.js";
import { createTaskCapabilityCeiling } from "../policy/engine.js";
import type { TaskCapabilityCeiling } from "../policy/engine.js";
import { selectedToolNamesForMode } from "../tools/selection.js";
import type { ToolCapability, ToolName } from "../tools/registry.js";

export interface BudgetHandoff {
  readonly exhaustedBudget: BudgetExhaustion["resource"];
  readonly limit: number;
  readonly observed: number;
  readonly objective: string;
  readonly completedActions: readonly string[];
  readonly changedPaths: readonly string[];
  readonly verification: "NOT_RUN" | "PASSED" | "FAILED";
  readonly blockers: readonly string[];
  readonly stopReason: string;
  readonly remainingSteps: readonly string[];
}

export interface TaskProgress {
  readonly completedActions: readonly string[];
  readonly changedPaths: readonly string[];
  readonly blockers: readonly string[];
  readonly remainingSteps: readonly string[];
}

export interface TaskAdmissionAuthority {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly eligibleTools?: readonly ToolName[];
  readonly capabilities?: readonly ToolCapability[];
}

export const TaskState = {
  RECEIVED: "RECEIVED",
  ADMITTED: "ADMITTED",
  INSPECTING: "INSPECTING",
  ANSWERING: "ANSWERING",
  PLANNING: "PLANNING",
  WAITING_FOR_FILE_PERMISSION: "WAITING_FOR_FILE_PERMISSION",
  IMPLEMENTING: "IMPLEMENTING",
  SANDBOX_READY: "SANDBOX_READY",
  VERIFYING: "VERIFYING",
  REPAIRING: "REPAIRING",
  REVIEWING: "REVIEWING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  BLOCKED: "BLOCKED",
  CANCELLED: "CANCELLED",
} as const;

export type TaskState = (typeof TaskState)[keyof typeof TaskState];
export type TerminalTaskState =
  | typeof TaskState.COMPLETED
  | typeof TaskState.FAILED
  | typeof TaskState.BLOCKED
  | typeof TaskState.CANCELLED;

export type TaskOutcome =
  | { readonly state: typeof TaskState.COMPLETED; readonly reason: "ANSWERED" }
  | {
      readonly state: typeof TaskState.COMPLETED;
      readonly reason: "EDIT_VERIFIED";
      readonly verification?: "PASSED";
    }
  | {
      readonly state: typeof TaskState.COMPLETED;
      readonly reason: "NO_CHANGE_NEEDED";
      readonly verification?: "NOT_RUN";
    }
  | {
      readonly state: typeof TaskState.FAILED;
      readonly reason: "BUDGET_EXHAUSTED";
      readonly evidence: Readonly<BudgetExhaustion>;
      readonly handoff: Readonly<BudgetHandoff>;
    }
  | {
      readonly state: typeof TaskState.FAILED;
      readonly reason:
        | "INVALID_TRANSITION"
        | "INTERNAL_ERROR"
        | "VERIFICATION_FAILED"
        | "POLICY_FAILURE"
        | "EXECUTION_FAILURE";
      readonly verification?: "FAILED";
    }
  | {
      readonly state: typeof TaskState.BLOCKED;
      readonly reason: "DEPENDENCY_UNAVAILABLE" | "POLICY_DENIED";
    }
  | {
      readonly state: typeof TaskState.CANCELLED;
      readonly reason: "CANCELLED_BY_DEVELOPER";
    };

export type TaskMode = "Ask" | "Edit";
export type TaskIntent = "INFORMATIONAL" | "CHANGE";

export interface TaskContext {
  readonly taskId: string;
  readonly objective: string;
  readonly intent: TaskIntent;
  readonly mode: TaskMode;
  readonly state: TaskState;
  readonly budget: Readonly<TaskBudget> | null;
  readonly capabilityCeiling: Readonly<TaskCapabilityCeiling> | null;
  readonly usage: Readonly<TaskUsage>;
  readonly admittedAt: number | null;
  readonly lastObservedAt: number | null;
  readonly changed: boolean;
  readonly progress: Readonly<TaskProgress>;
  readonly verification: "NOT_RUN" | "PASSED" | "FAILED";
  readonly retryAuthorized: boolean;
  readonly outcome: TaskOutcome | null;
}

const taskInputSchema = z.strictObject({
  taskId: z.string().trim().min(1).max(128),
  objective: z.string().trim().min(1).max(4_096),
  intent: z.enum(["INFORMATIONAL", "CHANGE"]).optional(),
  mode: z.enum(["Ask", "Edit"]),
});

export function createTask(input: z.input<typeof taskInputSchema>): TaskContext {
  const parsed = taskInputSchema.parse(input);
  const intent = parsed.intent ?? (parsed.mode === "Edit" ? "CHANGE" : "INFORMATIONAL");
  if (parsed.mode === "Edit" && intent !== "CHANGE") {
    throw new Error("An informational task cannot start in Edit mode");
  }
  return Object.freeze({
    taskId: parsed.taskId,
    objective: parsed.objective,
    intent,
    mode: parsed.mode,
    state: TaskState.RECEIVED,
    budget: null,
    capabilityCeiling: null,
    usage: EMPTY_TASK_USAGE,
    admittedAt: null,
    lastObservedAt: null,
    changed: false,
    progress: Object.freeze({
      completedActions: Object.freeze([]),
      changedPaths: Object.freeze([]),
      blockers: Object.freeze([]),
      remainingSteps: Object.freeze([]),
    }),
    verification: "NOT_RUN",
    retryAuthorized: false,
    outcome: null,
  });
}

export function admitTask(
  task: TaskContext,
  now: number,
  requestedProfile: unknown = "Medium",
  authority?: TaskAdmissionAuthority,
): TaskContext {
  if (
    task.state === TaskState.COMPLETED ||
    task.state === TaskState.FAILED ||
    task.state === TaskState.BLOCKED ||
    task.state === TaskState.CANCELLED
  ) {
    return task;
  }
  const failed = (reason: "INVALID_TRANSITION" | "INTERNAL_ERROR"): TaskContext =>
    Object.freeze({
      ...task,
      state: TaskState.FAILED,
      outcome: Object.freeze({ state: TaskState.FAILED, reason }),
    });
  if (task.state !== TaskState.RECEIVED) return failed("INVALID_TRANSITION");
  if (!Number.isFinite(now) || now < 0) return failed("INTERNAL_ERROR");

  let budget: Readonly<TaskBudget>;
  let capabilityCeiling: Readonly<TaskCapabilityCeiling> | null = null;
  try {
    budget = createTaskBudget(requestedProfile);
    if (authority !== undefined) {
      capabilityCeiling = createTaskCapabilityCeiling({
        taskId: task.taskId,
        sessionId: authority.sessionId,
        workspaceId: authority.workspaceId,
        mode: task.mode,
        eligibleTools: authority.eligibleTools ?? selectedToolNamesForMode(task.mode),
        ...(authority.capabilities === undefined ? {} : { capabilities: authority.capabilities }),
        resources: budget,
      });
    }
  } catch {
    return failed("INTERNAL_ERROR");
  }
  return Object.freeze({
    ...task,
    state: TaskState.ADMITTED,
    budget,
    capabilityCeiling,
    admittedAt: now,
    lastObservedAt: now,
  });
}
