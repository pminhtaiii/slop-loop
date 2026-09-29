import { isTerminal } from "../orchestration/transitions.js";
import type { TaskContext } from "../orchestration/task.js";
import { createPolicyDecisionContext, PolicyEngine } from "../policy/engine.js";
import type {
  FileGrantView,
  PolicyDecision,
  TaskCapabilityCeiling,
  TrustedExecutionFacts,
  TrustedPathFacts,
} from "../policy/engine.js";
import { validateToolCall } from "./registry.js";
import type { ToolName, ValidatedToolCall, ValidationResult } from "./registry.js";

export interface WorkspaceFactsPort {
  factsFor(
    call: ValidatedToolCall,
    ceiling: TaskCapabilityCeiling,
  ): TrustedPathFacts | readonly TrustedPathFacts[] | undefined;
}

export interface FileGrantPort {
  grantFor(path: TrustedPathFacts, ceiling: TaskCapabilityCeiling): FileGrantView | undefined;
}

export interface ExecutionFactsPort {
  factsFor(
    call: ValidatedToolCall,
    ceiling: TaskCapabilityCeiling,
  ): TrustedExecutionFacts | undefined;
}

export interface ToolExecutionAuthority {
  readonly paths: readonly TrustedPathFacts[];
}

export interface ToolExecutor {
  execute(call: ValidatedToolCall, authority: ToolExecutionAuthority): unknown;
}

export interface ToolGatewayDependencies {
  readonly workspace: WorkspaceFactsPort;
  readonly grants: FileGrantPort;
  readonly execution?: ExecutionFactsPort;
  readonly executors: Readonly<Partial<Record<ToolName, ToolExecutor>>>;
}

export type ToolGatewayResult =
  | { readonly kind: "EXECUTED"; readonly invocationId: string; readonly result: unknown }
  | {
      readonly kind: "NEEDS_FILE_PERMISSION";
      readonly invocationId: string;
      readonly reason: "MISSING_FILE_GRANT";
    }
  | {
      readonly kind: "DENY";
      readonly invocationId: string;
      readonly reason:
        | "INVALID_CALL"
        | "UNKNOWN_TOOL"
        | "INVALID_ARGUMENTS"
        | "TOOL_NOT_ELIGIBLE"
        | "CAPABILITY_MISSING"
        | "TASK_STATE_NOT_ELIGIBLE"
        | "PROFILE_NOT_APPROVED"
        | "EXECUTOR_NOT_READY"
        | "FORBIDDEN_PATH"
        | "GRANT_INVALIDATED"
        | "EXECUTOR_UNAVAILABLE"
        | "TASK_UNAVAILABLE";
    }
  | {
      readonly kind: "FAILED";
      readonly invocationId: string;
      readonly reason: "POLICY_FAILURE" | "EXECUTION_FAILURE";
    };

function deniedValidation(
  result: Exclude<ValidationResult, { readonly ok: true }>,
  invocationId: string,
) {
  return { kind: "DENY" as const, invocationId, reason: result.code };
}

function normalizePaths(
  facts: TrustedPathFacts | readonly TrustedPathFacts[] | undefined,
): readonly TrustedPathFacts[] {
  if (facts === undefined) return Object.freeze([]);
  return Object.freeze(isPathList(facts) ? [...facts] : [facts]);
}

function isPathList(
  facts: TrustedPathFacts | readonly TrustedPathFacts[],
): facts is readonly TrustedPathFacts[] {
  return Array.isArray(facts);
}

function writePaths(paths: readonly TrustedPathFacts[]): readonly TrustedPathFacts[] {
  return paths.filter((path) => path.operation === "update" || path.operation === "create");
}

function deniedDecision(
  decision: Extract<PolicyDecision, { readonly kind: "DENY" }>,
): ToolGatewayResult {
  return decision;
}

export class ToolGateway {
  private nextInvocation = 0;
  private readonly workspace: WorkspaceFactsPort;
  private readonly grants: FileGrantPort;
  private readonly execution: ExecutionFactsPort | undefined;
  private readonly executors: Readonly<Partial<Record<ToolName, ToolExecutor>>>;

  constructor(dependencies: ToolGatewayDependencies) {
    this.workspace = dependencies.workspace;
    this.grants = dependencies.grants;
    this.execution = dependencies.execution;
    this.executors = Object.freeze({ ...dependencies.executors });
  }

  invoke(task: TaskContext, proposedCall: unknown, responsePosition: number): ToolGatewayResult {
    const ceiling = task.capabilityCeiling;
    const invocationId = `${task.taskId}:${responsePosition}:${this.nextInvocation++}`;
    if (
      ceiling === null ||
      task.taskId !== ceiling.taskId ||
      task.mode !== ceiling.mode ||
      task.budget === null ||
      isTerminal(task.state)
    ) {
      return { kind: "DENY", invocationId, reason: "TASK_UNAVAILABLE" };
    }

    const validated = validateToolCall(proposedCall);
    if (!validated.ok) return deniedValidation(validated, invocationId);

    let decision: PolicyDecision;
    let paths: readonly TrustedPathFacts[];
    try {
      paths = normalizePaths(this.workspace.factsFor(validated.call, ceiling));
      const execution = this.execution?.factsFor(validated.call, ceiling);
      const grants = Object.freeze(
        writePaths(paths)
          .map((path) => this.grants.grantFor(path, ceiling))
          .filter((grant): grant is FileGrantView => grant !== undefined),
      );
      decision = PolicyEngine.evaluate(
        validated.call,
        createPolicyDecisionContext({
          invocationId,
          taskId: task.taskId,
          sessionId: ceiling.sessionId,
          workspaceId: ceiling.workspaceId,
          taskState: task.state,
          ceiling,
          paths,
          grants,
          ...(execution === undefined ? {} : { execution }),
        }),
      );
    } catch {
      return { kind: "FAILED", invocationId, reason: "POLICY_FAILURE" };
    }
    if (decision.kind === "DENY") return deniedDecision(decision);
    if (decision.kind === "NEEDS_FILE_PERMISSION") return decision;

    const executor = this.executors[validated.call.name];
    if (executor === undefined) {
      return { kind: "DENY", invocationId, reason: "EXECUTOR_UNAVAILABLE" };
    }
    try {
      return {
        kind: "EXECUTED",
        invocationId,
        result: executor.execute(validated.call, Object.freeze({ paths })),
      };
    } catch {
      return { kind: "FAILED", invocationId, reason: "EXECUTION_FAILURE" };
    }
  }
}
