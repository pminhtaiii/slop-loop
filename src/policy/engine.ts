import type { TaskBudget } from "../orchestration/budget.js";
import type { TaskMode, TaskState } from "../orchestration/task.js";
import { selectedToolNamesForMode } from "../tools/selection.js";
import { toolMetadataForName } from "../tools/registry.js";
import type { ToolCapability, ToolName, ValidatedToolCall } from "../tools/registry.js";

export type TrustedPathOperation = "read" | "update" | "create";
export type TrustedPathStatus = "ALLOWED" | "FORBIDDEN";
export type FileGrantStatus = "GRANTED" | "MISSING" | "INVALIDATED";

export interface TrustedPathFacts {
  readonly workspaceId: string;
  readonly requestedPath: string;
  readonly operation: TrustedPathOperation;
  readonly canonicalPath: string;
  readonly status: TrustedPathStatus;
}

export interface FileGrantView {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly canonicalPath: string;
  readonly operation: "update" | "create";
  readonly status: FileGrantStatus;
}

export type TrustedReadiness =
  | { readonly status: "READY" }
  | {
      readonly status: "EXTERNAL_BLOCKER";
      readonly reason:
        "PREPARATION_REQUIRED" | "IMAGE_STALE" | "RUNTIME_UNAVAILABLE" | "CLEANUP_UNCONFIRMED";
    };

export interface TrustedExecutionFacts {
  readonly approvedProfiles: readonly string[];
  readonly executorReady: boolean;
  readonly readiness?: TrustedReadiness | "READY" | "EXTERNAL_BLOCKER";
  readonly blockerReason?:
    "PREPARATION_REQUIRED" | "IMAGE_STALE" | "RUNTIME_UNAVAILABLE" | "CLEANUP_UNCONFIRMED";
}

export interface TaskCapabilityCeiling {
  readonly taskId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly mode: TaskMode;
  readonly eligibleTools: readonly ToolName[];
  readonly capabilities: readonly ToolCapability[];
  readonly resources: Readonly<TaskResourceCeiling>;
}

/** Admission-sealed resource authority; usage remains owned by the runner. */
export interface TaskResourceCeiling {
  readonly initialProfile: TaskBudget["initialProfile"];
  readonly promotionSchedule: readonly TaskBudget["initialProfile"][];
  readonly maxModelTurns: number;
  readonly maxToolAttempts: number;
  readonly maxRetries: number;
  readonly maxActiveWorkSeconds: number;
}

export interface PolicyDecisionContext {
  readonly invocationId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly taskState: TaskState;
  readonly ceiling: TaskCapabilityCeiling;
  readonly paths: readonly TrustedPathFacts[];
  readonly grants: readonly FileGrantView[];
  readonly execution?: TrustedExecutionFacts;
}

export type PolicyDecision =
  | { readonly kind: "ALLOW"; readonly invocationId: string }
  | {
      readonly kind: "BLOCKED";
      readonly invocationId: string;
      readonly reason:
        "PREPARATION_REQUIRED" | "IMAGE_STALE" | "RUNTIME_UNAVAILABLE" | "CLEANUP_UNCONFIRMED";
      readonly effect: "NONE";
    }
  | {
      readonly kind: "NEEDS_FILE_PERMISSION";
      readonly invocationId: string;
      readonly reason: "MISSING_FILE_GRANT";
    }
  | {
      readonly kind: "DENY";
      readonly invocationId: string;
      readonly reason:
        | "TOOL_NOT_ELIGIBLE"
        | "CAPABILITY_MISSING"
        | "TASK_STATE_NOT_ELIGIBLE"
        | "PROFILE_NOT_APPROVED"
        | "EXECUTOR_NOT_READY"
        | "FORBIDDEN_PATH"
        | "GRANT_INVALIDATED";
    };

export interface TaskCapabilityCeilingInput {
  readonly taskId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly mode: TaskMode;
  readonly eligibleTools: readonly ToolName[];
  readonly capabilities?: readonly ToolCapability[];
  readonly resources: Readonly<TaskBudget>;
}

export interface PolicyDecisionContextInput {
  readonly invocationId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly taskState: TaskState;
  readonly ceiling: TaskCapabilityCeiling;
  readonly path?: TrustedPathFacts;
  readonly grant?: FileGrantView;
  readonly paths?: readonly TrustedPathFacts[];
  readonly grants?: readonly FileGrantView[];
  readonly execution?: TrustedExecutionFacts;
}

function requiredPathOperation(call: ValidatedToolCall): TrustedPathOperation | null {
  const metadata = toolMetadataForName(call.name);
  if (metadata.mutation === "workspace") return "update";
  return call.name === "read_file" || call.name === "list_files" || call.name === "search_code"
    ? "read"
    : null;
}

function ensureIdentifier(value: string, label: string): void {
  if (value.trim().length === 0 || value.length > 256) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function clonePath(path: TrustedPathFacts): TrustedPathFacts {
  ensureIdentifier(path.workspaceId, "workspace ID");
  if (
    typeof path.requestedPath !== "string" ||
    path.requestedPath.length === 0 ||
    path.requestedPath.length > 1_024
  ) {
    throw new TypeError("Invalid requested path");
  }
  if (path.canonicalPath.length === 0 || path.canonicalPath.length > 1_024) {
    throw new TypeError("Invalid canonical path");
  }
  if (!["read", "update", "create"].includes(path.operation)) {
    throw new TypeError("Invalid path operation");
  }
  if (path.status !== "ALLOWED" && path.status !== "FORBIDDEN") {
    throw new TypeError("Invalid path status");
  }
  return Object.freeze({ ...path });
}

function cloneGrant(grant: FileGrantView): FileGrantView {
  ensureIdentifier(grant.sessionId, "session ID");
  ensureIdentifier(grant.workspaceId, "workspace ID");
  if (grant.canonicalPath.length === 0 || grant.canonicalPath.length > 1_024) {
    throw new TypeError("Invalid grant path");
  }
  if (grant.operation !== "update" && grant.operation !== "create") {
    throw new TypeError("Invalid grant operation");
  }
  if (grant.status !== "GRANTED" && grant.status !== "MISSING" && grant.status !== "INVALIDATED") {
    throw new TypeError("Invalid grant status");
  }
  return Object.freeze({ ...grant });
}

function cloneExecution(execution: TrustedExecutionFacts): TrustedExecutionFacts {
  if (
    execution.approvedProfiles.length === 0 ||
    execution.approvedProfiles.some((profile) => profile.trim().length === 0 || profile.length > 64)
  ) {
    throw new TypeError("Invalid approved profiles");
  }
  if (typeof execution.executorReady !== "boolean") {
    throw new TypeError("Invalid executor readiness");
  }
  const readiness =
    typeof execution.readiness === "string" ? { status: execution.readiness } : execution.readiness;
  const blockerReason =
    readiness?.status === "EXTERNAL_BLOCKER"
      ? "reason" in readiness
        ? readiness.reason
        : execution.blockerReason
      : undefined;
  if (readiness !== undefined) {
    if (readiness.status === "READY") {
      if (!execution.executorReady) throw new TypeError("Invalid trusted readiness");
    } else if (readiness.status === "EXTERNAL_BLOCKER") {
      if (
        execution.executorReady ||
        blockerReason === undefined ||
        ![
          "PREPARATION_REQUIRED",
          "IMAGE_STALE",
          "RUNTIME_UNAVAILABLE",
          "CLEANUP_UNCONFIRMED",
        ].includes(blockerReason)
      )
        throw new TypeError("Invalid trusted readiness");
    } else {
      throw new TypeError("Invalid trusted readiness");
    }
  }
  return Object.freeze({
    approvedProfiles: Object.freeze([...new Set(execution.approvedProfiles)]),
    executorReady: execution.executorReady,
    ...(readiness === undefined
      ? {}
      : {
          readiness: Object.freeze(
            readiness.status === "READY"
              ? { status: "READY" as const }
              : { status: "EXTERNAL_BLOCKER" as const, reason: blockerReason! },
          ),
        }),
  });
}

function cloneResources(resources: Readonly<TaskBudget>): Readonly<TaskResourceCeiling> {
  return Object.freeze({
    initialProfile: resources.initialProfile,
    promotionSchedule: Object.freeze([...resources.promotionSchedule]),
    maxModelTurns: resources.maxModelTurns,
    maxToolAttempts: resources.maxToolAttempts,
    maxRetries: resources.maxRetries,
    maxActiveWorkSeconds: resources.maxActiveWorkSeconds,
  });
}

export function createTaskCapabilityCeiling(
  input: TaskCapabilityCeilingInput,
): TaskCapabilityCeiling {
  ensureIdentifier(input.taskId, "task ID");
  ensureIdentifier(input.sessionId, "session ID");
  ensureIdentifier(input.workspaceId, "workspace ID");

  const allowedInMode = new Set(selectedToolNamesForMode(input.mode));
  const eligibleTools = [...new Set(input.eligibleTools)];
  if (eligibleTools.length === 0 || eligibleTools.some((name) => !allowedInMode.has(name))) {
    throw new TypeError("Ceiling includes a tool unavailable in the task mode");
  }
  const capabilities = [
    ...new Set(
      input.capabilities ??
        eligibleTools.map((name) => toolMetadataForName(name).requiredCapability),
    ),
  ];

  return Object.freeze({
    taskId: input.taskId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    mode: input.mode,
    eligibleTools: Object.freeze(eligibleTools),
    capabilities: Object.freeze(capabilities),
    resources: cloneResources(input.resources),
  });
}

export function createPolicyDecisionContext(
  input: PolicyDecisionContextInput,
): PolicyDecisionContext {
  ensureIdentifier(input.invocationId, "invocation ID");
  ensureIdentifier(input.taskId, "task ID");
  ensureIdentifier(input.sessionId, "session ID");
  ensureIdentifier(input.workspaceId, "workspace ID");
  if (input.path !== undefined && input.paths !== undefined) {
    throw new TypeError("Decision context cannot contain both path and paths");
  }
  if (input.grant !== undefined && input.grants !== undefined) {
    throw new TypeError("Decision context cannot contain both grant and grants");
  }
  const paths = input.paths ?? (input.path === undefined ? [] : [input.path]);
  const grants = input.grants ?? (input.grant === undefined ? [] : [input.grant]);
  return Object.freeze({
    invocationId: input.invocationId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    taskState: input.taskState,
    ceiling: input.ceiling,
    paths: Object.freeze(paths.map(clonePath)),
    grants: Object.freeze(grants.map(cloneGrant)),
    ...(input.execution === undefined ? {} : { execution: cloneExecution(input.execution) }),
  });
}

function assertContextMatchesCeiling(context: PolicyDecisionContext): void {
  if (
    context.taskId !== context.ceiling.taskId ||
    context.sessionId !== context.ceiling.sessionId ||
    context.workspaceId !== context.ceiling.workspaceId
  ) {
    throw new TypeError("Trusted decision context does not match the sealed ceiling");
  }
}

function decidePathAuthority(
  call: ValidatedToolCall,
  context: PolicyDecisionContext,
): PolicyDecision | null {
  const requiredOperation = requiredPathOperation(call);
  if (requiredOperation === null) return null;
  if (
    context.paths.length === 0 ||
    context.paths.some((path) => path.workspaceId !== context.workspaceId)
  ) {
    throw new TypeError("Required trusted path facts are unavailable");
  }
  if (context.paths.some((path) => path.operation === "read" && requiredOperation !== "read")) {
    throw new TypeError("Trusted path facts use the wrong operation");
  }
  if (context.paths.some((path) => path.status === "FORBIDDEN")) {
    return { kind: "DENY", invocationId: context.invocationId, reason: "FORBIDDEN_PATH" };
  }
  if (requiredOperation === "read") return null;

  for (const path of context.paths) {
    const grant = context.grants.find(
      (candidate) =>
        candidate.sessionId === context.sessionId &&
        candidate.workspaceId === context.workspaceId &&
        candidate.canonicalPath === path.canonicalPath &&
        candidate.operation === path.operation,
    );
    if (grant === undefined || grant.status === "MISSING") {
      return {
        kind: "NEEDS_FILE_PERMISSION",
        invocationId: context.invocationId,
        reason: "MISSING_FILE_GRANT",
      };
    }
    if (grant.status === "INVALIDATED") {
      return { kind: "DENY", invocationId: context.invocationId, reason: "GRANT_INVALIDATED" };
    }
  }
  return null;
}

function isStateEligible(call: ValidatedToolCall, state: TaskState): boolean {
  const metadata = toolMetadataForName(call.name);
  if (metadata.mutation === "workspace") {
    return state === "IMPLEMENTING" || state === "REPAIRING";
  }
  if (metadata.execution === "trusted_profile") return state === "VERIFYING";
  return ["INSPECTING", "ANSWERING", "PLANNING", "IMPLEMENTING", "REPAIRING", "REVIEWING"].includes(
    state,
  );
}

function decideExecutionAuthority(
  call: ValidatedToolCall,
  context: PolicyDecisionContext,
): PolicyDecision | null {
  if (toolMetadataForName(call.name).execution !== "trusted_profile") return null;
  if (context.execution === undefined) {
    throw new TypeError("Required trusted execution facts are unavailable");
  }
  if (!context.execution.executorReady) {
    const readiness = context.execution.readiness;
    const blockerReason =
      typeof readiness === "object" && readiness.status === "EXTERNAL_BLOCKER"
        ? readiness.reason
        : context.execution.blockerReason;
    if (
      (typeof readiness === "object" && readiness.status === "EXTERNAL_BLOCKER") ||
      readiness === "EXTERNAL_BLOCKER"
    ) {
      if (blockerReason === undefined)
        return { kind: "DENY", invocationId: context.invocationId, reason: "EXECUTOR_NOT_READY" };
      return {
        kind: "BLOCKED",
        invocationId: context.invocationId,
        reason: blockerReason,
        effect: "NONE",
      };
    }
    return { kind: "DENY", invocationId: context.invocationId, reason: "EXECUTOR_NOT_READY" };
  }
  if (!("profile" in call.arguments)) {
    throw new TypeError("Trusted-profile tool has no profile argument");
  }
  if (!context.execution.approvedProfiles.includes(call.arguments.profile)) {
    return { kind: "DENY", invocationId: context.invocationId, reason: "PROFILE_NOT_APPROVED" };
  }
  return null;
}

export const PolicyEngine = Object.freeze({
  evaluate(call: ValidatedToolCall, context: PolicyDecisionContext): PolicyDecision {
    assertContextMatchesCeiling(context);
    if (!context.ceiling.eligibleTools.includes(call.name)) {
      return { kind: "DENY", invocationId: context.invocationId, reason: "TOOL_NOT_ELIGIBLE" };
    }
    const metadata = toolMetadataForName(call.name);
    if (!context.ceiling.capabilities.includes(metadata.requiredCapability)) {
      return { kind: "DENY", invocationId: context.invocationId, reason: "CAPABILITY_MISSING" };
    }
    if (!isStateEligible(call, context.taskState)) {
      return {
        kind: "DENY",
        invocationId: context.invocationId,
        reason: "TASK_STATE_NOT_ELIGIBLE",
      };
    }
    const executionDecision = decideExecutionAuthority(call, context);
    if (executionDecision !== null) return executionDecision;
    const pathDecision = decidePathAuthority(call, context);
    return pathDecision ?? { kind: "ALLOW", invocationId: context.invocationId };
  },
});
