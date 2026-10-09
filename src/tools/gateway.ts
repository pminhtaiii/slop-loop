import { isTerminal } from "../orchestration/transitions.js";
import type { TaskContext } from "../orchestration/task.js";
import type { ToolCleanupTracker } from "../orchestration/runner.js";
import { createPolicyDecisionContext, PolicyEngine } from "../policy/engine.js";
import type {
  FileGrantView,
  PolicyDecision,
  TaskCapabilityCeiling,
  TrustedExecutionFacts,
  TrustedPathFacts,
} from "../policy/engine.js";
import { outputContractForName, toolMetadataForName, validateToolCall } from "./registry.js";
import type { ToolName, ValidatedToolCall } from "./registry.js";

const RESULT_APPEND_ATTEMPTS = 3;

export interface WorkspaceFactsPort {
  factsFor(
    call: ValidatedToolCall,
    ceiling: TaskCapabilityCeiling,
  ):
    | TrustedPathFacts
    | readonly TrustedPathFacts[]
    | undefined
    | Promise<TrustedPathFacts | readonly TrustedPathFacts[] | undefined>;
}
export interface FileGrantPort {
  grantFor(
    path: TrustedPathFacts,
    ceiling: TaskCapabilityCeiling,
  ): FileGrantView | undefined | Promise<FileGrantView | undefined>;
}
export interface ExecutionFactsPort {
  factsFor(
    call: ValidatedToolCall,
    ceiling: TaskCapabilityCeiling,
  ): TrustedExecutionFacts | undefined | Promise<TrustedExecutionFacts | undefined>;
}
export interface ToolExecutionAuthority {
  readonly paths: readonly TrustedPathFacts[];
  readonly signal: AbortSignal;
  readonly cleanup?: ToolCleanupTracker;
}
export interface ToolExecutor {
  execute(call: ValidatedToolCall, authority: ToolExecutionAuthority): unknown;
}
export interface AuditEvent {
  readonly eventId: string;
  readonly kind: "REQUEST_DECISION" | "RESULT";
  readonly taskId: string;
  readonly invocationId: string;
  readonly tool: string;
  readonly decision: string;
  readonly effect: "NONE" | "COMPLETED" | "POSSIBLE";
  readonly bytes?: number;
}
export type AuditAppendResult =
  | { readonly status: "COMMITTED"; readonly eventId: string }
  | { readonly status: "UNAVAILABLE" | "INTEGRITY_FAILURE" };
export interface AuditSink {
  appendIfAbsent(event: AuditEvent): Promise<AuditAppendResult>;
}
export interface InvocationFence {
  readonly signal: AbortSignal;
  canStart(): boolean;
  readonly cleanup?: ToolCleanupTracker;
}
export interface ToolGatewayDependencies {
  readonly workspace: WorkspaceFactsPort;
  readonly grants: FileGrantPort;
  readonly execution?: ExecutionFactsPort;
  readonly audit?: AuditSink;
  readonly executors: Readonly<Partial<Record<ToolName, ToolExecutor>>>;
}

export type ToolGatewayResult =
  | {
      readonly kind: "EXECUTED";
      readonly invocationId: string;
      readonly result: unknown;
      readonly effect: "COMPLETED";
    }
  | {
      readonly kind: "NEEDS_FILE_PERMISSION";
      readonly invocationId: string;
      readonly reason: "MISSING_FILE_GRANT";
    }
  | { readonly kind: "DENY"; readonly invocationId: string; readonly reason: string }
  | {
      readonly kind: "FAILED";
      readonly invocationId: string;
      readonly reason: "POLICY_FAILURE" | "EXECUTION_FAILURE";
      readonly effect?: "POSSIBLE";
    }
  | {
      readonly kind: "BLOCKED";
      readonly invocationId: string;
      readonly reason:
        | "AUDIT_UNAVAILABLE"
        | "AUDIT_INCOMPLETE"
        | "PREPARATION_REQUIRED"
        | "IMAGE_STALE"
        | "RUNTIME_UNAVAILABLE"
        | "CLEANUP_UNCONFIRMED";
      readonly effect: "NONE" | "COMPLETED" | "POSSIBLE";
    }
  | {
      readonly kind: "TOOL_CONTRACT_FAILURE";
      readonly invocationId: string;
      readonly effect: "COMPLETED" | "POSSIBLE";
    }
  | { readonly kind: "CANCELLED"; readonly invocationId: string };

const committedAudit: AuditSink = Object.freeze({
  appendIfAbsent(event: AuditEvent) {
    return Promise.resolve({ status: "COMMITTED" as const, eventId: event.eventId });
  },
});

function normalizePaths(
  facts: TrustedPathFacts | readonly TrustedPathFacts[] | undefined,
): readonly TrustedPathFacts[] {
  if (facts === undefined) return Object.freeze([]);
  if (Array.isArray(facts)) return Object.freeze(Array.from(facts as readonly TrustedPathFacts[]));
  return Object.freeze([facts as TrustedPathFacts]);
}
function expectedReadPath(call: ValidatedToolCall): string | null {
  switch (call.name) {
    case "read_file":
      return call.arguments.path;
    case "list_files":
      return call.arguments.path ?? ".";
    case "search_code":
      return call.arguments.scope ?? ".";
    default:
      return null;
  }
}

function assertExactPathCoverage(
  call: ValidatedToolCall,
  paths: readonly TrustedPathFacts[],
  workspaceId: string,
): void {
  const expected = expectedReadPath(call);
  if (expected === null) return;
  if (
    paths.length !== 1 ||
    paths[0]?.workspaceId !== workspaceId ||
    paths[0].requestedPath !== expected ||
    paths[0].operation !== "read"
  )
    throw new TypeError("Required trusted path facts are inconsistent");
}
function eventFor(
  task: TaskContext,
  invocationId: string,
  kind: AuditEvent["kind"],
  tool: string,
  decision: string,
  effect: AuditEvent["effect"],
  bytes?: number,
): AuditEvent {
  return Object.freeze({
    eventId: `${invocationId}:${kind}`,
    kind,
    taskId: task.taskId,
    invocationId,
    tool: tool.slice(0, 64),
    decision,
    effect,
    ...(bytes === undefined ? {} : { bytes }),
  });
}
function redact(value: unknown): unknown {
  if (typeof value === "string")
    return value.replaceAll(/(token|secret|password)=[^\s&]+/gi, "$1=[REDACTED]");
  if (Array.isArray(value)) return Object.freeze((value as readonly unknown[]).map(redact));
  if (value !== null && typeof value === "object")
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          /token|secret|password/i.test(key) ? "[REDACTED]" : redact(item),
        ]),
      ),
    );
  return value;
}
function safeOutput(
  value: unknown,
  tool: ToolName,
  paths: readonly TrustedPathFacts[],
): { readonly ok: true; readonly value: unknown; readonly bytes: number } | { readonly ok: false } {
  try {
    const normalized = value === undefined ? null : value;
    const encoded = JSON.stringify(normalized);
    if (encoded === undefined) return { ok: false };
    const sanitized = redact(JSON.parse(encoded));
    const contract = outputContractForName(tool);
    if (!contract.schema.safeParse(sanitized).success) return { ok: false };
    if (
      tool === "read_file" &&
      (paths.length !== 1 ||
        typeof sanitized !== "object" ||
        sanitized === null ||
        !("path" in sanitized) ||
        sanitized.path !== paths[0]?.canonicalPath)
    )
      return { ok: false };
    const sanitizedEncoded = JSON.stringify(sanitized);
    if (sanitizedEncoded === undefined) return { ok: false };
    if ((tool === "read_file" || tool === "search_code") && sanitizedEncoded !== encoded)
      return { ok: false };
    const bytes = new TextEncoder().encode(sanitizedEncoded).byteLength;
    return bytes > contract.maxBytes ? { ok: false } : { ok: true, value: sanitized, bytes };
  } catch {
    return { ok: false };
  }
}

export class ToolGateway {
  private nextInvocation = 0;
  private readonly audit: AuditSink;
  private readonly workspace: WorkspaceFactsPort;
  private readonly grants: FileGrantPort;
  private readonly execution: ExecutionFactsPort | undefined;
  private readonly executors: Readonly<Partial<Record<ToolName, ToolExecutor>>>;

  constructor(dependencies: ToolGatewayDependencies) {
    this.workspace = dependencies.workspace;
    this.grants = dependencies.grants;
    this.execution = dependencies.execution;
    this.audit = dependencies.audit ?? committedAudit;
    this.executors = Object.freeze({ ...dependencies.executors });
  }

  private async appendCommitted(event: AuditEvent): Promise<boolean> {
    try {
      const result = await this.audit.appendIfAbsent(event);
      return result.status === "COMMITTED" && result.eventId === event.eventId;
    } catch {
      return false;
    }
  }

  private async appendResult(event: AuditEvent): Promise<boolean> {
    for (let attempt = 0; attempt < RESULT_APPEND_ATTEMPTS; attempt += 1) {
      if (await this.appendCommitted(event)) return true;
    }
    return false;
  }

  async invoke(
    task: TaskContext,
    proposedCall: unknown,
    responsePosition: number,
    fence?: InvocationFence,
  ): Promise<ToolGatewayResult> {
    const invocationId = `${task.taskId}:${responsePosition}:${this.nextInvocation++}`;
    const ceiling = task.capabilityCeiling;
    if (
      ceiling === null ||
      task.taskId !== ceiling.taskId ||
      task.mode !== ceiling.mode ||
      task.budget === null ||
      isTerminal(task.state)
    )
      return { kind: "DENY", invocationId, reason: "TASK_UNAVAILABLE" };
    const validated = validateToolCall(proposedCall);
    const tool =
      typeof proposedCall === "object" &&
      proposedCall !== null &&
      "name" in proposedCall &&
      typeof proposedCall.name === "string"
        ? proposedCall.name
        : "invalid";
    let decision: PolicyDecision | ToolGatewayResult;
    let paths: readonly TrustedPathFacts[] = Object.freeze([]);
    if (!validated.ok) decision = { kind: "DENY", invocationId, reason: validated.code };
    else {
      try {
        paths = normalizePaths(await this.workspace.factsFor(validated.call, ceiling));
        if (
          ceiling.eligibleTools.includes(validated.call.name) &&
          ceiling.capabilities.includes(toolMetadataForName(validated.call.name).requiredCapability)
        )
          assertExactPathCoverage(validated.call, paths, ceiling.workspaceId);
        const grants: FileGrantView[] = [];
        for (const path of paths) {
          if (path.operation === "read") continue;
          const grant = await this.grants.grantFor(path, ceiling);
          if (grant !== undefined) grants.push(grant);
        }
        const execution =
          this.execution === undefined
            ? undefined
            : await this.execution.factsFor(validated.call, ceiling);
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
            grants: Object.freeze(grants),
            ...(execution === undefined ? {} : { execution }),
          }),
        );
      } catch {
        decision = { kind: "FAILED", invocationId, reason: "POLICY_FAILURE" };
      }
    }
    const pre = eventFor(
      task,
      invocationId,
      "REQUEST_DECISION",
      tool,
      decision.kind === "DENY" ? decision.reason : decision.kind,
      "NONE",
    );
    if (!(await this.appendCommitted(pre)))
      return { kind: "BLOCKED", invocationId, reason: "AUDIT_UNAVAILABLE", effect: "NONE" };
    if (decision.kind !== "ALLOW") return decision;
    if (fence !== undefined && (!fence.canStart() || fence.signal.aborted))
      return { kind: "CANCELLED", invocationId };
    if (!validated.ok) throw new Error("Validated call missing after allow decision");
    const executor = this.executors[validated.call.name];
    if (executor === undefined)
      return { kind: "DENY", invocationId, reason: "EXECUTOR_UNAVAILABLE" };
    let output: unknown;
    try {
      output = await executor.execute(
        validated.call,
        Object.freeze({
          paths,
          signal: fence?.signal ?? new AbortController().signal,
          ...(fence?.cleanup ? { cleanup: fence.cleanup } : {}),
        }),
      );
    } catch {
      const failureEvent = eventFor(
        task,
        invocationId,
        "RESULT",
        tool,
        "EXECUTION_FAILURE",
        "POSSIBLE",
      );
      if (!(await this.appendResult(failureEvent)))
        return { kind: "BLOCKED", invocationId, reason: "AUDIT_INCOMPLETE", effect: "POSSIBLE" };
      return { kind: "FAILED", invocationId, reason: "EXECUTION_FAILURE", effect: "POSSIBLE" };
    }
    const checked = safeOutput(output, validated.call.name, paths);
    const resultEvent = eventFor(
      task,
      invocationId,
      "RESULT",
      tool,
      checked.ok ? "EXECUTED" : "TOOL_CONTRACT_FAILURE",
      "COMPLETED",
      checked.ok ? checked.bytes : undefined,
    );
    if (!(await this.appendResult(resultEvent)))
      return { kind: "BLOCKED", invocationId, reason: "AUDIT_INCOMPLETE", effect: "COMPLETED" };
    if (!checked.ok) return { kind: "TOOL_CONTRACT_FAILURE", invocationId, effect: "COMPLETED" };
    return { kind: "EXECUTED", invocationId, result: checked.value, effect: "COMPLETED" };
  }
}
