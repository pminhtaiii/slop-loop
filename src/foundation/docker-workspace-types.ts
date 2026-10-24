import type { CommandView, ExecutionLimits, RunCommandAction, TaskWorkspace } from '../contracts/foundation/uc03.ts';
import type { AttemptReceiptV02, RepositoryAdmissionContextV02 } from '../contracts/foundation/uc03/ports-v02.ts';

export interface DockerResourceLimits {
  readonly maxMemoryBytes: number;
  readonly maxCpuCores: number;
  readonly maxPids: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number | undefined;
}

export interface DockerMountConfig {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

export interface DockerProfile {
  readonly profileId: string;
  readonly image: string;
  readonly imageDigest: string;
  readonly user: string;
  readonly readOnlyRootFilesystem: boolean;
  readonly network: 'none';
  readonly limits: DockerResourceLimits;
  readonly mounts: readonly DockerMountConfig[];
}

export type CanonicalFileKind = 'regular' | 'file' | 'symlink' | 'link' | string;

export interface CanonicalSnapshotEntry {
  readonly path: string;
  readonly kind: 'regular' | 'file' | 'symlink' | 'link' | string;
  readonly content?: string | Uint8Array;
  readonly digest: string;
  readonly linkTarget?: string;
}

export interface CanonicalRepositorySnapshot {
  readonly canonicalRevisionDigest: string;
  readonly entries: readonly CanonicalSnapshotEntry[];
  readonly requiredFiles?: readonly string[];
  readonly exclusionsPolicyVersion?: string;
}

export interface MaterializeViewParams {
  readonly view: CommandView;
  readonly files: Readonly<Record<string, string | Uint8Array>>;
}

export interface DockerContainerPlan {
  readonly image: string;
  readonly imageDigest: string;
  readonly user: string;
  readonly readOnlyRootFilesystem: true;
  readonly network: 'none';
  readonly dropCapabilities: readonly string[];
  readonly noNewPrivileges: true;
  readonly mounts: readonly DockerMountConfig[];
  readonly executable: string;
  readonly argv: readonly string[];
  readonly workingDirectory: string;
  readonly env: Readonly<Record<string, string>>;
  readonly limits: ExecutionLimits;
}

export interface ContainerExecutionOutput {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface StructuredExecutionResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly outcome: 'success' | 'failure' | 'timeout' | 'error';
  readonly plan: DockerContainerPlan;
  readonly truncated: boolean;
}

export type WorkspaceLeaseKind = 'read' | 'write';

export interface WorkspaceLease {
  readonly leaseId: string;
  readonly workspaceId: string;
  readonly kind: WorkspaceLeaseKind;
  readonly fencingGeneration: number;
  readonly canonicalRevision: string;
  release(): Promise<void> | void;
}

export interface ExecuteCommandParams {
  readonly workspaceId: string;
  readonly action?: RunCommandAction | undefined;
  readonly executable?: string | undefined;
  readonly argv?: readonly string[] | undefined;
  readonly workingDirectory?: string | undefined;
  readonly limits: ExecutionLimits;
  readonly view?: CommandView | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly profile?: DockerProfile | undefined;
  readonly context?: RepositoryAdmissionContextV02 | undefined;
  readonly attempt?: AttemptReceiptV02 | undefined;
  readonly preInvokeBarrier?: (() => Promise<void> | void) | undefined;
}

export interface DockerLifecycleController {
  readonly provenance: 'mock' | 'real';
  createVolume(volumeId: string): Promise<void>;
  hasVolume(volumeId: string): Promise<boolean>;
  removeVolume(volumeId: string): Promise<void>;
  getCanonicalSnapshot?(workspaceId: string): Promise<CanonicalRepositorySnapshot>;
  materializeView?(params: MaterializeViewParams): Promise<void>;
  executeContainer?(plan: DockerContainerPlan): Promise<ContainerExecutionOutput>;
  executePlan?(plan: DockerContainerPlan): Promise<ContainerExecutionOutput>;
  cleanup?(): Promise<void> | void;
}

export interface CreateWorkspaceParams {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly initialRevisionDigest: string;
  readonly profile: DockerProfile;
}

export interface ResumeWorkspaceParams {
  readonly workspace: TaskWorkspace;
  readonly profile: DockerProfile;
  readonly expectedRevisionDigest?: string;
}

export interface AdmitCommandViewParams {
  readonly workspaceId: string;
  readonly expectedRevisionDigest?: string;
  readonly canonicalRevisionDigest?: string;
  readonly requiredFiles?: readonly string[];
  readonly exclusionsPolicyVersion?: string;
}

export interface DockerEnvironmentPolicy {
  readonly allowedKeys?: readonly string[] | ReadonlySet<string> | undefined;
}
