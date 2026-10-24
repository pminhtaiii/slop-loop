/** Stable public entry point retained for existing callers. */
export type { AdmitCommandViewParams, CanonicalFileKind, CanonicalRepositorySnapshot, CanonicalSnapshotEntry, ContainerExecutionOutput, CreateWorkspaceParams, DockerContainerPlan, DockerEnvironmentPolicy, DockerLifecycleController, DockerMountConfig, DockerProfile, DockerResourceLimits, ExecuteCommandParams, MaterializeViewParams, ResumeWorkspaceParams, StructuredExecutionResult, WorkspaceLease, WorkspaceLeaseKind } from './docker-workspace-types.ts';
export type { StructuredCommandExecutorOptions } from './docker-command-executor.ts';
export { ALLOWED_EXECUTABLES, DEFAULT_CONTAINER_ENV, IMMUTABLE_CONTAINER_ENV_KEYS, computeFileDigest, computeWorkspaceVolumeIds, containsProtectedContent, isImmutableEnvKey, isLoaderHook, truncateUtf8, validateDockerProfile } from './docker-workspace-policy.ts';
export { DockerWorkspaceManager } from './docker-workspace-manager.ts';
export { DockerCommandExecutor, StructuredCommandExecutor } from './docker-command-executor.ts';
