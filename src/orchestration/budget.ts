import { z } from "zod";

export type BudgetProfile = "Small" | "Medium" | "Large";
export type RetryReason = "VERIFICATION_REPAIR" | "MODEL_RECOVERY" | "DENIAL_RECOVERY";

export interface TaskBudget {
  readonly initialProfile: BudgetProfile;
  readonly activeProfile: BudgetProfile;
  readonly promotionSchedule: readonly BudgetProfile[];
  readonly maxModelTurns: number;
  readonly maxToolAttempts: number;
  readonly maxRetries: number;
  readonly maxActiveWorkSeconds: number;
}

export interface TaskUsage {
  readonly modelTurns: number;
  readonly toolAttempts: number;
  readonly retries: number;
  readonly retryReasons: readonly RetryReason[];
  readonly activeWorkMs: number;
}

export interface BudgetExhaustion {
  readonly resource: "MODEL_TURNS" | "TOOL_ATTEMPTS" | "RETRIES" | "ACTIVE_WORK_TIME";
  readonly limit: number;
  readonly observed: number;
  readonly attempted: number;
}

export type BudgetDecision =
  | {
      readonly allowed: true;
      readonly budget: Readonly<TaskBudget>;
      readonly usage: Readonly<TaskUsage>;
    }
  | { readonly allowed: false; readonly evidence: Readonly<BudgetExhaustion> };

const profileSchema = z.enum(["Small", "Medium", "Large"]);
const limits = Object.freeze({
  Small: Object.freeze({ modelTurns: 30, toolAttempts: 60, retries: 3 }),
  Medium: Object.freeze({ modelTurns: 60, toolAttempts: 120, retries: 5 }),
  Large: Object.freeze({ modelTurns: 120, toolAttempts: 240, retries: 8 }),
});

const promotionSchedules = Object.freeze({
  Small: Object.freeze(["Medium", "Large"] as const),
  Medium: Object.freeze(["Large"] as const),
  Large: Object.freeze([] as const),
});

export const EMPTY_TASK_USAGE: Readonly<TaskUsage> = Object.freeze({
  modelTurns: 0,
  toolAttempts: 0,
  retries: 0,
  retryReasons: Object.freeze([]),
  activeWorkMs: 0,
});

export function createTaskBudget(profile: unknown = "Medium"): Readonly<TaskBudget> {
  const initialProfile = profileSchema.parse(profile);
  return Object.freeze({
    initialProfile,
    activeProfile: initialProfile,
    promotionSchedule: promotionSchedules[initialProfile],
    maxModelTurns: limits[initialProfile].modelTurns,
    maxToolAttempts: limits[initialProfile].toolAttempts,
    maxRetries: limits[initialProfile].retries,
    maxActiveWorkSeconds: 1_800,
  });
}

function promoteForCapacity(
  budget: Readonly<TaskBudget>,
  attempted: number,
  resource: "MODEL_TURNS" | "TOOL_ATTEMPTS",
): Readonly<TaskBudget> | Readonly<BudgetExhaustion> {
  const currentLimit = resource === "MODEL_TURNS" ? budget.maxModelTurns : budget.maxToolAttempts;
  if (attempted <= currentLimit) return budget;
  const next = budget.promotionSchedule.find(
    (candidate) =>
      (resource === "MODEL_TURNS"
        ? limits[candidate].modelTurns
        : limits[candidate].toolAttempts) >= attempted,
  );
  if (next === undefined) {
    return Object.freeze({ resource, limit: currentLimit, observed: attempted - 1, attempted });
  }
  return Object.freeze({
    ...budget,
    activeProfile: next,
    maxModelTurns: limits[next].modelTurns,
    maxToolAttempts: limits[next].toolAttempts,
  });
}

export function consumeModelTurn(budget: TaskBudget, usage: TaskUsage): BudgetDecision {
  const attempted = usage.modelTurns + 1;
  const next = promoteForCapacity(budget, attempted, "MODEL_TURNS");
  if ("resource" in next) return { allowed: false, evidence: next };
  return {
    allowed: true,
    budget: next,
    usage: Object.freeze({ ...usage, modelTurns: attempted }),
  };
}

export function consumeToolAttempt(budget: TaskBudget, usage: TaskUsage): BudgetDecision {
  const attempted = usage.toolAttempts + 1;
  const next = promoteForCapacity(budget, attempted, "TOOL_ATTEMPTS");
  if ("resource" in next) return { allowed: false, evidence: next };
  return {
    allowed: true,
    budget: next,
    usage: Object.freeze({ ...usage, toolAttempts: attempted }),
  };
}

export function consumeRetry(
  budget: TaskBudget,
  usage: TaskUsage,
  reason: RetryReason,
): BudgetDecision {
  const attempted = usage.retries + 1;
  if (attempted > budget.maxRetries) {
    return {
      allowed: false,
      evidence: Object.freeze({
        resource: "RETRIES",
        limit: budget.maxRetries,
        observed: usage.retries,
        attempted,
      }),
    };
  }
  return {
    allowed: true,
    budget,
    usage: Object.freeze({
      ...usage,
      retries: attempted,
      retryReasons: Object.freeze([...usage.retryReasons, reason]),
    }),
  };
}

export function recordActiveWork(
  budget: TaskBudget,
  usage: TaskUsage,
  elapsedMs: number,
): BudgetDecision {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new TypeError("Invalid active-work time");
  }
  const attemptedMs = usage.activeWorkMs + elapsedMs;
  const limitMs = budget.maxActiveWorkSeconds * 1_000;
  if (attemptedMs >= limitMs) {
    return {
      allowed: false,
      evidence: Object.freeze({
        resource: "ACTIVE_WORK_TIME",
        limit: budget.maxActiveWorkSeconds,
        observed: attemptedMs / 1_000,
        attempted: attemptedMs / 1_000,
      }),
    };
  }
  return { allowed: true, budget, usage: Object.freeze({ ...usage, activeWorkMs: attemptedMs }) };
}
