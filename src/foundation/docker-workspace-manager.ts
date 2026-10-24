import type { CommandView, TaskWorkspace } from '../contracts/foundation/uc03.ts';
import { validateTaskWorkspace } from '../contracts/foundation/uc03.ts';
import { buildDockerCommandView } from './docker-view-builder.ts';
import { StructuredCommandExecutor } from './docker-command-executor.ts';
import { computeWorkspaceVolumeIds, isValidFencingGeneration, SHA256_HEX_REGEX, validateDockerProfile } from './docker-workspace-policy.ts';
import type { AdmitCommandViewParams, CreateWorkspaceParams, DockerEnvironmentPolicy, DockerLifecycleController, DockerProfile, ResumeWorkspaceParams, WorkspaceLease } from './docker-workspace-types.ts';
export class DockerWorkspaceManager {
  private readonly controller: DockerLifecycleController;
  private readonly workspaces = new Map<string, TaskWorkspace>();
  private readonly canonicalVolumes = new Map<string, { readonly repoVolumeId: string; readonly scratchVolumeId: string }>();
  private readonly canonicalRevisions = new Map<string, string>();
  private readonly activeViews = new Map<string, CommandView>();
  private readonly activeWriterLeases = new Map<string, WorkspaceLease>();
  private readonly activeReaderLeases = new Map<string, Set<WorkspaceLease>>();
  private readonly leaseWaiters = new Map<string, (() => void)[]>();
  private readonly fencingGenerations = new Map<string, number>();

  private wakeNextLeaseWaiter(workspaceId: string): void {
    if (this.activeWriterLeases.has(workspaceId)) return;
    const waiters = this.leaseWaiters.get(workspaceId);
    if (!waiters) return;
    this.leaseWaiters.delete(workspaceId);
    for (const wake of waiters) wake();
  }

  constructor(options: { readonly controller: DockerLifecycleController }) {
    if (!options || typeof options !== 'object' || !options.controller) {
      throw new Error('CONTROLLER_REQUIRED: Injected DockerLifecycleController is required');
    }
    this.controller = options.controller;
  }

  getCanonicalRevision(workspaceId: string): string | undefined {
    return this.canonicalRevisions.get(workspaceId);
  }

  getWorkspace(workspaceId: string): TaskWorkspace | undefined {
    return this.workspaces.get(workspaceId);
  }

  getController(): DockerLifecycleController {
    return this.controller;
  }

  getFencingGeneration(workspaceId: string): number {
    return this.fencingGenerations.get(workspaceId) ?? 1;
  }

  setFencingGeneration(workspaceId: string, generation: number): void {
    if (!isValidFencingGeneration(generation)) {
      throw new Error('INVALID_FENCING_GENERATION: Fencing generation must be a positive safe integer');
    }
    if (generation < this.getFencingGeneration(workspaceId)) {
      throw new Error('STALE_FENCING_GENERATION: Workspace fencing generation cannot move backwards');
    }
    this.fencingGenerations.set(workspaceId, generation);
  }

  hasActiveWriterLease(workspaceId: string): boolean {
    return this.activeWriterLeases.has(workspaceId);
  }

  hasActiveReaderLease(workspaceId: string): boolean {
    const readers = this.activeReaderLeases.get(workspaceId);
    return readers !== undefined && readers.size > 0;
  }

  async acquireWriteLease(workspaceId: string, expectedRevision?: string): Promise<WorkspaceLease> {
    const currentRev = this.getCanonicalRevision(workspaceId);
    if (!currentRev) {
      throw new Error(`WORKSPACE_NOT_FOUND: Workspace '${workspaceId}' not found`);
    }
    if (expectedRevision !== undefined && currentRev !== expectedRevision) {
      throw new Error(`STALE_REVISION_DRIFT: Revision changed from '${expectedRevision}' to '${currentRev}' before acquiring write lease`);
    }

    while (this.activeWriterLeases.has(workspaceId) || (this.activeReaderLeases.get(workspaceId)?.size ?? 0) > 0) {
      await new Promise<void>((resolve) => {
        let waiters = this.leaseWaiters.get(workspaceId);
        if (!waiters) {
          waiters = [];
          this.leaseWaiters.set(workspaceId, waiters);
        }
        waiters.push(() => { resolve(); });
      });
      const revAfterWait = this.getCanonicalRevision(workspaceId);
      if (expectedRevision !== undefined && revAfterWait !== expectedRevision) {
        this.wakeNextLeaseWaiter(workspaceId);
        throw new Error(`STALE_REVISION_DRIFT: Revision changed from '${expectedRevision}' to '${revAfterWait}' while waiting for write lease`);
      }
    }

    const generation = this.fencingGenerations.get(workspaceId) ?? 1;
    const leaseId = `lease-w-${workspaceId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    let released = false;

    const lease: WorkspaceLease = {
      leaseId,
      workspaceId,
      kind: 'write',
      fencingGeneration: generation,
      canonicalRevision: currentRev,
      release: () => {
        if (released) return;
        released = true;
        this.activeWriterLeases.delete(workspaceId);
        this.wakeNextLeaseWaiter(workspaceId);
      },
    };

    this.activeWriterLeases.set(workspaceId, lease);
    return lease;
  }

  async acquireReadLease(workspaceId: string, expectedRevision?: string): Promise<WorkspaceLease> {
    const currentRev = this.getCanonicalRevision(workspaceId);
    if (!currentRev) {
      throw new Error(`WORKSPACE_NOT_FOUND: Workspace '${workspaceId}' not found`);
    }
    if (expectedRevision !== undefined && currentRev !== expectedRevision) {
      throw new Error(`STALE_REVISION_DRIFT: Revision changed from '${expectedRevision}' to '${currentRev}' before acquiring read lease`);
    }

    while (this.activeWriterLeases.has(workspaceId)) {
      await new Promise<void>((resolve) => {
        let waiters = this.leaseWaiters.get(workspaceId);
        if (!waiters) {
          waiters = [];
          this.leaseWaiters.set(workspaceId, waiters);
        }
        waiters.push(() => { resolve(); });
      });
      const revAfterWait = this.getCanonicalRevision(workspaceId);
      if (expectedRevision !== undefined && revAfterWait !== expectedRevision) {
        this.wakeNextLeaseWaiter(workspaceId);
        throw new Error(`STALE_REVISION_DRIFT: Revision changed from '${expectedRevision}' to '${revAfterWait}' while waiting for read lease`);
      }
    }

    const generation = this.fencingGenerations.get(workspaceId) ?? 1;
    const leaseId = `lease-r-${workspaceId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    let released = false;

    const lease: WorkspaceLease = {
      leaseId,
      workspaceId,
      kind: 'read',
      fencingGeneration: generation,
      canonicalRevision: currentRev,
      release: () => {
        if (released) return;
        released = true;
        const readers = this.activeReaderLeases.get(workspaceId);
        if (readers) {
          readers.delete(lease);
          if (readers.size === 0) {
            this.wakeNextLeaseWaiter(workspaceId);
          }
        }
      },
    };

    let readers = this.activeReaderLeases.get(workspaceId);
    if (!readers) {
      readers = new Set();
      this.activeReaderLeases.set(workspaceId, readers);
    }
    readers.add(lease);
    return lease;
  }

  createCommandExecutor(
    profile?: DockerProfile,
    environmentPolicy?:
      | DockerEnvironmentPolicy
      | readonly string[]
      | ReadonlySet<string>
      | {
          readonly environmentPolicy?: DockerEnvironmentPolicy | undefined;
          readonly allowedEnvKeys?: readonly string[] | ReadonlySet<string> | undefined;
        }
  ): StructuredCommandExecutor {
    let resolvedPolicy: DockerEnvironmentPolicy | readonly string[] | ReadonlySet<string> | undefined;
    let resolvedAllowedKeys: readonly string[] | ReadonlySet<string> | undefined;

    if (environmentPolicy !== undefined) {
      if (
        typeof environmentPolicy === 'object' &&
        environmentPolicy !== null &&
        !(environmentPolicy instanceof Set) &&
        !Array.isArray(environmentPolicy) &&
        ('environmentPolicy' in environmentPolicy || 'allowedEnvKeys' in environmentPolicy)
      ) {
        resolvedPolicy = environmentPolicy.environmentPolicy;
        resolvedAllowedKeys = environmentPolicy.allowedEnvKeys;
      } else {
        resolvedPolicy = environmentPolicy as DockerEnvironmentPolicy | readonly string[] | ReadonlySet<string>;
      }
    }

    return new StructuredCommandExecutor({
      manager: this,
      controller: this.controller,
      profile,
      environmentPolicy: resolvedPolicy,
      allowedEnvKeys: resolvedAllowedKeys,
    });
  }

  async createWorkspace(params: CreateWorkspaceParams): Promise<TaskWorkspace> {
    if (!params || typeof params !== 'object') {
      throw new Error('INVALID_WORKSPACE_PARAMS: params must be an object');
    }
    const profileRes = validateDockerProfile(params.profile);
    if (!profileRes.ok) throw new Error(`INVALID_DOCKER_PROFILE: ${profileRes.errors.map((e) => e.message).join('; ')}`);

    if (!SHA256_HEX_REGEX.test(params.initialRevisionDigest)) {
      throw new Error('INVALID_REVISION_DIGEST: initialRevisionDigest must be sha256 hex digest');
    }

    const { repoVolumeId, scratchVolumeId } = computeWorkspaceVolumeIds(params.taskId, params.workspaceId);

    const workspace: TaskWorkspace = {
      taskId: params.taskId,
      workspaceId: params.workspaceId,
      containerImageDigest: params.profile.imageDigest,
      repoVolumeId,
      scratchVolumeId,
      expectedRepoState: params.initialRevisionDigest,
    };
    const validWs = validateTaskWorkspace(workspace);
    if (!validWs.ok) throw new Error(`INVALID_TASK_WORKSPACE: ${validWs.errors.map((e) => e.message).join('; ')}`);

    if (this.workspaces.has(params.workspaceId)) {
      throw new Error(`WORKSPACE_ALREADY_EXISTS: Workspace '${params.workspaceId}' already exists; use resumeWorkspace`);
    }

    // Allocate volumes only after full parameter, profile, and workspace validation
    await this.controller.createVolume(repoVolumeId);
    await this.controller.createVolume(scratchVolumeId);

    this.workspaces.set(params.workspaceId, workspace);
    this.canonicalVolumes.set(params.workspaceId, { repoVolumeId, scratchVolumeId });
    this.canonicalRevisions.set(params.workspaceId, params.initialRevisionDigest);
    return workspace;
  }

  async resumeWorkspace(params: ResumeWorkspaceParams): Promise<TaskWorkspace> {
    if (!params || typeof params !== 'object') {
      throw new Error('INVALID_WORKSPACE_PARAMS: params must be an object');
    }
    const validWs = validateTaskWorkspace(params.workspace);
    if (!validWs.ok) throw new Error(`INVALID_TASK_WORKSPACE: ${validWs.errors.map((e) => e.message).join('; ')}`);
    const profileRes = validateDockerProfile(params.profile);
    if (!profileRes.ok) throw new Error(`INVALID_DOCKER_PROFILE: ${profileRes.errors.map((e) => e.message).join('; ')}`);

    if (params.expectedRevisionDigest !== undefined && !SHA256_HEX_REGEX.test(params.expectedRevisionDigest)) {
      throw new Error('INVALID_REVISION_DIGEST: expectedRevisionDigest must be sha256 hex digest');
    }

    if (params.workspace.containerImageDigest !== params.profile.imageDigest) {
      throw new Error(`IMAGE_DIGEST_MISMATCH: ${params.workspace.containerImageDigest} !== ${params.profile.imageDigest}`);
    }

    const expectedVolumeIds = computeWorkspaceVolumeIds(params.workspace.taskId, params.workspace.workspaceId);
    if (
      params.workspace.repoVolumeId !== expectedVolumeIds.repoVolumeId ||
      params.workspace.scratchVolumeId !== expectedVolumeIds.scratchVolumeId
    ) {
      throw new Error('VOLUME_IDENTITY_MISMATCH: Resumed workspace volume identities do not match canonical deterministic volume identities');
    }

    const recordedWs = this.workspaces.get(params.workspace.workspaceId);
    if (recordedWs && recordedWs.taskId !== params.workspace.taskId) {
      throw new Error(`VOLUME_IDENTITY_MISMATCH: Cross-task workspace identity drift detected: taskId '${params.workspace.taskId}' does not match recorded taskId '${recordedWs.taskId}'`);
    }
    const recorded = this.canonicalVolumes.get(params.workspace.workspaceId);
    if (recorded && (recorded.repoVolumeId !== params.workspace.repoVolumeId || recorded.scratchVolumeId !== params.workspace.scratchVolumeId)) {
      throw new Error('VOLUME_IDENTITY_MISMATCH: Resumed workspace volume identities do not match canonical recorded volumes');
    }
    if (!(await this.controller.hasVolume(params.workspace.repoVolumeId)) || !(await this.controller.hasVolume(params.workspace.scratchVolumeId))) {
      throw new Error('VOLUME_NOT_FOUND: Workspace volumes missing in lifecycle controller');
    }
    if (params.expectedRevisionDigest !== undefined && params.workspace.expectedRepoState !== params.expectedRevisionDigest) {
      throw new Error('REVISION_MISMATCH: Workspace repo state does not match expected revision');
    }

    const currentRev = this.canonicalRevisions.get(params.workspace.workspaceId);
    if (currentRev && currentRev !== params.workspace.expectedRepoState) this.invalidateViews(params.workspace.workspaceId);

    this.workspaces.set(params.workspace.workspaceId, params.workspace);
    this.canonicalVolumes.set(params.workspace.workspaceId, { repoVolumeId: params.workspace.repoVolumeId, scratchVolumeId: params.workspace.scratchVolumeId });
    this.canonicalRevisions.set(params.workspace.workspaceId, params.workspace.expectedRepoState);
    return params.workspace;
  }

  setCanonicalRevision(workspaceId: string, newRevisionDigest: string): void {
    this.canonicalRevisions.set(workspaceId, newRevisionDigest);
    this.invalidateViews(workspaceId);
  }

  invalidateViews(workspaceId: string): void {
    this.activeViews.delete(workspaceId);
  }

  getActiveCommandView(workspaceId: string): CommandView | null {
    const view = this.activeViews.get(workspaceId);
    if (!view) return null;
    const currentRev = this.canonicalRevisions.get(workspaceId);
    if (currentRev && view.canonicalRevisionDigest !== currentRev) {
      this.activeViews.delete(workspaceId);
      return null;
    }
    return view;
  }

  async admitCommandView(params: AdmitCommandViewParams): Promise<CommandView> {
    return buildDockerCommandView(params, this.controller, {
      getWorkspace: (workspaceId) => this.getWorkspace(workspaceId),
      getCanonicalRevision: (workspaceId) => this.getCanonicalRevision(workspaceId),
      acquireReadLease: (workspaceId, expectedRevision) =>
        this.acquireReadLease(workspaceId, expectedRevision),
      invalidateViews: (workspaceId) => this.invalidateViews(workspaceId),
      publishView: (workspaceId, view) => this.activeViews.set(workspaceId, view),
    });
  }
}
