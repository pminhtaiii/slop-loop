/** UC-03 runtime port interfaces and provenance admission. */

import type { ActivityEvent, ApplyPatchAction, ApprovalBinding, BugTask, CheckDefinition, CheckResult, EnvelopeOutcome, NormalizedAction, PermissionClass, ProviderRequest, ProviderUsage, ReservationBundle, ReviewResult, RunCommandAction, SourceEvidence, TaskState, ValidationError } from './types.ts';

export interface ModelProposal {
  readonly proposalId: string;
  readonly content: string;
  readonly actions?: readonly NormalizedAction[] | undefined;
}

export interface ModelResult {
  readonly proposal: ModelProposal;
  readonly observedUsage: ProviderUsage;
}

export type ModelPortOutcome = 'observed' | 'uncertain' | 'denied' | 'invalid';

export interface ModelPortObserved {
  readonly outcome: 'observed';
  readonly result: ModelResult;
}

export interface ModelPortUncertain {
  readonly outcome: 'uncertain';
  readonly reason: string;
  readonly observedUsage?: ProviderUsage | undefined;
}

export interface ModelPortDenied {
  readonly outcome: 'denied';
  readonly reason: string;
}

export interface ModelPortInvalid {
  readonly outcome: 'invalid';
  readonly errors: readonly ValidationError[];
  readonly observedUsage?: ProviderUsage | undefined;
}

export type ModelPortResult =
  | ModelPortObserved
  | ModelPortUncertain
  | ModelPortDenied
  | ModelPortInvalid;

export type PortProvenance = 'real' | 'mock';

export interface PortIdentity {
  readonly provenance: PortProvenance;
}

export function isAdmittedForProduction(ports: readonly unknown[]): boolean {
  try {
    return Array.isArray(ports) && ports.length > 0 && ports.every((port) => {
      if (!port || typeof port !== 'object' || Array.isArray(port)) return false;
      const provenance = Object.getOwnPropertyDescriptor(port, 'provenance');
      return provenance !== undefined && 'value' in provenance && provenance.value === 'real';
    });
  } catch {
    return false;
  }
}

export interface ModelPort extends PortIdentity {
  propose(
    state: TaskState,
    evidence: readonly SourceEvidence[],
    request: ProviderRequest
  ): Promise<ModelPortResult>;
}

export interface RepositoryPort extends PortIdentity {
  listDir(path: string): Promise<readonly string[]>;
  readFile(path: string): Promise<SourceEvidence>;
  searchCode(query: string): Promise<readonly SourceEvidence[]>;
  applyPatch(patch: ApplyPatchAction): Promise<{ readonly applied: boolean; readonly newRevisionDigest: string }>;
  runCommand(action: RunCommandAction): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  runTests(check: CheckDefinition): Promise<CheckResult>;
  inspectDiff(baseRevisionDigest: string): Promise<{ readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] }>;
}

export interface ExecutionGuard extends PortIdentity {
  validateAndExecute(
    action: NormalizedAction,
    state: TaskState
  ): Promise<{ readonly outcome: EnvelopeOutcome; readonly result?: unknown }>;
}

export interface StatePort extends PortIdentity {
  loadTask(taskId: string): Promise<TaskState | null>;
  transition(state: TaskState, expectedVersion: number): Promise<TaskState>;
  reserve(scope: 'task' | 'run', kind: string, amount: number, actionId: string): Promise<string>;
  reserveMany(
    reservations: readonly {
      readonly scope: 'task' | 'run';
      readonly kind: string;
      readonly amount: number;
    }[],
    requestId: string,
    transactionRef?: string
  ): Promise<ReservationBundle>;
  settle(actionId: string, observed: ProviderUsage): Promise<void>;
  reconcileUncertain(
    requestId: string,
    reconciliation: {
      readonly observedUsage?: ProviderUsage | undefined;
      readonly reason: string;
    }
  ): Promise<void>;
  checkpoint(state: TaskState): Promise<void>;
  recover(taskId: string): Promise<TaskState>;
}

export interface ApprovalPort extends PortIdentity {
  classify(action: NormalizedAction): Promise<PermissionClass>;
  requestDecision(binding: ApprovalBinding): Promise<ApprovalBinding>;
  validateBinding(binding: ApprovalBinding): Promise<boolean>;
  resolve(decisionId: string): Promise<ApprovalBinding>;
}

export interface ReviewerPort extends PortIdentity {
  review(
    task: BugTask,
    diff: string,
    evidence: readonly SourceEvidence[],
    request: ProviderRequest
  ): Promise<ReviewResult>;
}

export interface TelemetryPort extends PortIdentity {

  emitActivity(event: ActivityEvent): Promise<void>;
  recordUsage(taskId: string, runId: string, usage: ProviderUsage): Promise<void>;
}
