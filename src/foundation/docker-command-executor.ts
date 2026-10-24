import { computeActionDigest } from '../contracts/foundation/uc03.ts';
import { createDockerCommandPlan } from './docker-command-plan.ts';
import { FORBIDDEN_ENV_KEYS, isImmutableEnvKey, isLoaderHook, isValidFencingGeneration, normalizeDockerExecutionOutput, validateDockerProfile } from './docker-workspace-policy.ts';
import type { DockerWorkspaceManager } from './docker-workspace-manager.ts';
import type { DockerEnvironmentPolicy, DockerLifecycleController, DockerMountConfig, DockerProfile, DockerResourceLimits, ExecuteCommandParams, StructuredExecutionResult, WorkspaceLease } from './docker-workspace-types.ts';
export interface StructuredCommandExecutorOptions {
  readonly manager: DockerWorkspaceManager;
  readonly controller?: DockerLifecycleController | undefined;
  readonly profile?: DockerProfile | undefined;
  readonly environmentPolicy?: DockerEnvironmentPolicy | readonly string[] | ReadonlySet<string> | undefined;
  readonly allowedEnvKeys?: readonly string[] | ReadonlySet<string> | undefined;
  readonly adapterIdentity?: string | undefined;
  readonly processIncarnation?: string | undefined;
  readonly fencingGeneration?: number | undefined;
}

export class StructuredCommandExecutor {
  private readonly manager: DockerWorkspaceManager;
  private readonly controller: DockerLifecycleController;
  private readonly trustedProfile?: DockerProfile | undefined;
  private readonly allowedEnvKeys: ReadonlySet<string>;
  private readonly adapterIdentity: string;
  private readonly processIncarnation: string;
  private fencingGeneration: number;
  private readonly consumedAttempts = new Set<string>();
  private readonly inFlightAttempts = new Set<string>();

  constructor(options: StructuredCommandExecutorOptions) {
    if (!options || typeof options !== 'object' || !options.manager) {
      throw new Error('MANAGER_REQUIRED: DockerWorkspaceManager is required for StructuredCommandExecutor');
    }
    this.manager = options.manager;
    this.controller = options.controller ?? options.manager.getController();
    if (!this.controller) {
      throw new Error('CONTROLLER_REQUIRED: Injected DockerLifecycleController is required');
    }
    this.adapterIdentity = options.adapterIdentity ?? 'structured-command-executor';
    this.processIncarnation = options.processIncarnation ?? `cmd-inc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.fencingGeneration = options.fencingGeneration ?? 1;
    if (!isValidFencingGeneration(this.fencingGeneration)) {
      throw new Error('INVALID_FENCING_GENERATION: Fencing generation must be a positive safe integer');
    }

    let rawAllowed: unknown;
    if (options.environmentPolicy !== undefined) {
      if (Array.isArray(options.environmentPolicy) || options.environmentPolicy instanceof Set) {
        rawAllowed = options.environmentPolicy;
      } else if (typeof options.environmentPolicy === 'object' && options.environmentPolicy !== null) {
        rawAllowed = (options.environmentPolicy as DockerEnvironmentPolicy).allowedKeys;
      } else {
        throw new Error('INVALID_ENVIRONMENT_POLICY: environmentPolicy must be an object or collection of allowed keys');
      }
    } else if (options.allowedEnvKeys !== undefined) {
      rawAllowed = options.allowedEnvKeys;
    }

    if (rawAllowed !== undefined) {
      if (!Array.isArray(rawAllowed) && !(rawAllowed instanceof Set)) {
        throw new Error('INVALID_ENVIRONMENT_POLICY: allowedKeys must be an array or Set of strings');
      }
      const validatedSet = new Set<string>();
      for (const item of rawAllowed) {
        if (typeof item !== 'string' || item.trim().length === 0) {
          throw new Error('INVALID_ENVIRONMENT_POLICY: Environment key must be a non-empty string');
        }
        const key = item.trim();
        if (isImmutableEnvKey(key)) {
          throw new Error(`INVALID_ENVIRONMENT_POLICY: Cannot allowlist immutable runtime environment variable '${key}'`);
        }
        if (isLoaderHook(key)) {
          throw new Error(`INVALID_ENVIRONMENT_POLICY: Cannot allowlist loader/interpreter hook variable '${key}'`);
        }
        if (FORBIDDEN_ENV_KEYS.test(key)) {
          throw new Error(`INVALID_ENVIRONMENT_POLICY: Cannot allowlist forbidden secret or credential pattern '${key}'`);
        }
        validatedSet.add(key);
      }
      this.allowedEnvKeys = Object.freeze(validatedSet);
    } else {
      this.allowedEnvKeys = Object.freeze(new Set<string>());
    }
    if (options.profile !== undefined) {
      const profileRes = validateDockerProfile(options.profile);
      if (!profileRes.ok) {
        throw new Error(`INVALID_DOCKER_PROFILE: ${profileRes.errors.map((e) => e.message).join('; ')}`);
      }
      const val = profileRes.value;
      const trustedLimits: DockerResourceLimits = Object.freeze({
        timeoutMs: val.limits.timeoutMs,
        maxMemoryBytes: val.limits.maxMemoryBytes,
        maxCpuCores: val.limits.maxCpuCores,
        maxPids: val.limits.maxPids,
        ...(val.limits.maxOutputBytes !== undefined
          ? { maxOutputBytes: val.limits.maxOutputBytes }
          : {}),
      });

      const trustedMounts: readonly DockerMountConfig[] = Object.freeze(
        val.mounts.map((m) =>
          Object.freeze({
            source: m.source,
            target: m.target,
            readOnly: m.readOnly,
          })
        )
      );

      this.trustedProfile = Object.freeze({
        profileId: val.profileId,
        image: val.image,
        imageDigest: val.imageDigest,
        user: val.user,
        readOnlyRootFilesystem: true,
        network: 'none' as const,
        limits: trustedLimits,
        mounts: trustedMounts,
      });
    }
  }

  getAdapterIdentity(): string {
    return this.adapterIdentity;
  }

  getProcessIncarnation(): string {
    return this.processIncarnation;
  }

  getFencingGeneration(): number {
    return this.fencingGeneration;
  }

  setFencingGeneration(generation: number): void {
    if (!isValidFencingGeneration(generation)) {
      throw new Error('INVALID_FENCING_GENERATION: Fencing generation must be a positive safe integer');
    }
    if (generation < this.fencingGeneration) {
      throw new Error('STALE_FENCING_GENERATION: Executor fencing generation cannot move backwards');
    }
    this.fencingGeneration = generation;
  }

  fenceActor(generation?: number): void {
    this.setFencingGeneration((generation ?? this.fencingGeneration) + 1);
  }

  isAttemptConsumed(attemptId: string): boolean {
    return this.consumedAttempts.has(attemptId);
  }

  async execute(params: ExecuteCommandParams): Promise<StructuredExecutionResult> {
    if (!params || typeof params !== 'object') {
      throw new Error('INVALID_EXECUTE_PARAMS: params must be an object');
    }
    if (!params.workspaceId || typeof params.workspaceId !== 'string') {
      throw new Error('INVALID_WORKSPACE_ID: workspaceId must be a non-empty string');
    }

    // Check command view freshness BEFORE dispatch
    const activeView = this.manager.getActiveCommandView(params.workspaceId);
    if (!activeView) {
      throw new Error(`COMMAND_VIEW_REQUIRED: No active admitted command view for workspace '${params.workspaceId}'`);
    }
    if (activeView.mountedReadOnly !== true) {
      throw new Error('COMMAND_VIEW_NOT_READONLY: Admitted command view must be mounted read-only');
    }
    const currentRev = this.manager.getCanonicalRevision(params.workspaceId);
    if (!currentRev || activeView.canonicalRevisionDigest !== currentRev) {
      throw new Error(`STALE_COMMAND_VIEW: Active view revision '${activeView.canonicalRevisionDigest}' does not match canonical revision '${currentRev}'`);
    }
    if (params.view) {
      if (
        params.view.viewId !== activeView.viewId ||
        params.view.viewDigest !== activeView.viewDigest ||
        params.view.canonicalRevisionDigest !== activeView.canonicalRevisionDigest
      ) {
        throw new Error(`STALE_COMMAND_VIEW: Supplied view does not match current admitted command view for workspace '${params.workspaceId}'`);
      }
    }

    const workspace = this.manager.getWorkspace(params.workspaceId);
    if (!workspace) {
      throw new Error(`WORKSPACE_NOT_FOUND: Workspace '${params.workspaceId}' not found`);
    }

    // Absent constructor authority must deny even if command supplies a plausible profile
    if (!this.trustedProfile) {
      throw new Error(
        `PROFILE_REQUIRED: Trusted constructor DockerProfile is required for command execution on workspace '${params.workspaceId}'`
      );
    }
    const trustedProfile = this.trustedProfile;

    // Reject command-level profile overrides or modifications; accept only exact trusted equivalent if provided
    if (params.profile !== undefined) {
      const candidateRes = validateDockerProfile(params.profile);
      if (!candidateRes.ok) {
        throw new Error(`INVALID_DOCKER_PROFILE: ${candidateRes.errors.map((e) => e.message).join('; ')}`);
      }
      const p = candidateRes.value;
      const isExactMatch =
        p.profileId === trustedProfile.profileId &&
        p.image === trustedProfile.image &&
        p.imageDigest === trustedProfile.imageDigest &&
        p.user === trustedProfile.user &&
        p.readOnlyRootFilesystem === trustedProfile.readOnlyRootFilesystem &&
        p.network === trustedProfile.network &&
        p.limits.timeoutMs === trustedProfile.limits.timeoutMs &&
        p.limits.maxMemoryBytes === trustedProfile.limits.maxMemoryBytes &&
        p.limits.maxCpuCores === trustedProfile.limits.maxCpuCores &&
        p.limits.maxPids === trustedProfile.limits.maxPids &&
        p.limits.maxOutputBytes === trustedProfile.limits.maxOutputBytes &&
        p.mounts.length === trustedProfile.mounts.length &&
        p.mounts.every((m, idx) => {
          const tm = trustedProfile.mounts[idx];
          return (
            tm !== undefined &&
            m.source === tm.source &&
            m.target === tm.target &&
            m.readOnly === tm.readOnly
          );
        });

      if (!isExactMatch) {
        throw new Error(
          `COMMAND_PROFILE_OVERRIDE_FORBIDDEN: Command-supplied profile cannot override or differ from trusted constructor profile`
        );
      }
    }

    // Enforce workspace canonical image identity authority
    if (trustedProfile.imageDigest !== workspace.containerImageDigest) {
      throw new Error(`IMAGE_DIGEST_MISMATCH: Profile image digest '${trustedProfile.imageDigest}' does not match canonical workspace image digest '${workspace.containerImageDigest}'`);
    }

    const { action, limits, plan } = createDockerCommandPlan(params, trustedProfile, activeView, this.allowedEnvKeys);

    const execFn = this.controller.executeContainer ?? this.controller.executePlan;
    if (typeof execFn !== 'function') {
      throw new Error('CONTROLLER_EXECUTE_METHOD_REQUIRED: Injected controller missing executeContainer method');
    }

    let attemptId: string | undefined;
    let assertAttemptIdentity: ((lease?: WorkspaceLease) => void) | undefined;
    if (params.attempt) {
      const attempt = params.attempt;
      const actor = attempt.executorIdentity;
      if (!actor || typeof actor !== 'object') {
        throw new Error('AUTHENTICATION_FAILED: Missing executor identity in attempt');
      }
      const actorIdentity = {
        adapterIdentity: actor.adapterIdentity,
        processIncarnation: actor.processIncarnation,
        fencingGeneration: actor.fencingGeneration,
        payloadDigest: actor.payloadDigest,
      };
      const expectedPayloadDigest = computeActionDigest(action);
      attemptId = attempt.attemptId;
      if (!attemptId || typeof attemptId !== 'string') {
        throw new Error('INVALID_ATTEMPT_ID: Attempt receipt must have a valid attemptId');
      }

      assertAttemptIdentity = (lease) => {
        const currentActor = attempt.executorIdentity;
        if (
          params.attempt !== attempt ||
          attempt.attemptId !== attemptId ||
          !currentActor ||
          typeof currentActor !== 'object' ||
          currentActor.adapterIdentity !== actorIdentity.adapterIdentity ||
          currentActor.processIncarnation !== actorIdentity.processIncarnation ||
          !Object.is(currentActor.fencingGeneration, actorIdentity.fencingGeneration) ||
          currentActor.payloadDigest !== actorIdentity.payloadDigest
        ) {
          throw new Error('ATTEMPT_IDENTITY_CHANGED: Attempt or executor identity changed before invocation');
        }
        if (actorIdentity.adapterIdentity !== this.adapterIdentity) {
          throw new Error(`AUTHENTICATION_FAILED: Adapter identity mismatch: expected '${this.adapterIdentity}', got '${actorIdentity.adapterIdentity}'`);
        }
        if (actorIdentity.processIncarnation !== this.processIncarnation) {
          throw new Error(`RESTART_INCARNATION_MISMATCH: Process incarnation mismatch: expected '${this.processIncarnation}', got '${actorIdentity.processIncarnation}'`);
        }
        if (actorIdentity.payloadDigest !== expectedPayloadDigest) {
          throw new Error(`PAYLOAD_DIGEST_MISMATCH: Payload digest mismatch: expected '${expectedPayloadDigest}', got '${actorIdentity.payloadDigest}'`);
        }
        const managerGeneration = this.manager.getFencingGeneration(params.workspaceId);
        if (
          !isValidFencingGeneration(actorIdentity.fencingGeneration) ||
          !isValidFencingGeneration(this.fencingGeneration) ||
          !isValidFencingGeneration(managerGeneration) ||
          actorIdentity.fencingGeneration !== this.fencingGeneration ||
          actorIdentity.fencingGeneration !== managerGeneration ||
          (lease !== undefined && (
            !isValidFencingGeneration(lease.fencingGeneration) ||
            actorIdentity.fencingGeneration !== lease.fencingGeneration
          ))
        ) {
          throw new Error(`STALE_FENCING_GENERATION: Attempt generation ${actorIdentity.fencingGeneration} must match executor ${this.fencingGeneration}, manager ${managerGeneration}, and lease ${lease?.fencingGeneration ?? 'unavailable'}`);
        }
      };
      assertAttemptIdentity();
      if (this.consumedAttempts.has(attemptId) || this.inFlightAttempts.has(attemptId)) {
        throw new Error(`DUPLICATE_ATTEMPT_CONSUMED: Duplicate successful receipt to the same executor incarnation for attempt '${attemptId}'`);
      }
      this.inFlightAttempts.add(attemptId);
    }

    // Dispatch to trusted controller with cleanup in finally on rejection
    let rawOutput: unknown;
    let executionLease: WorkspaceLease | undefined;
    try {
      if (attemptId !== undefined && assertAttemptIdentity !== undefined) {
        executionLease = await this.manager.acquireReadLease(params.workspaceId, activeView.canonicalRevisionDigest);
        assertAttemptIdentity(executionLease);
        if (params.preInvokeBarrier) {
          await params.preInvokeBarrier();
        }
        assertAttemptIdentity(executionLease);
        this.consumedAttempts.add(attemptId);
      }
      rawOutput = await execFn.call(this.controller, plan);
    } finally {
      if (attemptId !== undefined) {
        this.inFlightAttempts.delete(attemptId);
      }
      try {
        if (typeof this.controller.cleanup === 'function') {
          await this.controller.cleanup();
        }
      } finally {
        if (executionLease !== undefined) {
          await executionLease.release();
        }
      }
    }

    // Enforce command view and workspace freshness AGAIN AFTER await; repo or workspace change invalidates cached views
    const activeViewAfter = this.manager.getActiveCommandView(params.workspaceId);
    const revAfter = this.manager.getCanonicalRevision(params.workspaceId);
    const wsAfter = this.manager.getWorkspace(params.workspaceId);
    if (
      !activeViewAfter ||
      activeViewAfter.viewDigest !== activeView.viewDigest ||
      revAfter !== activeView.canonicalRevisionDigest ||
      !wsAfter ||
      wsAfter.containerImageDigest !== workspace.containerImageDigest
    ) {
      this.manager.invalidateViews(params.workspaceId);
      throw new Error(`CANONICAL_REVISION_CHANGED: Canonical repository or workspace changed during command execution from '${activeView.canonicalRevisionDigest}' to '${revAfter}'`);
    }

    return normalizeDockerExecutionOutput(rawOutput, limits, plan);

  }
}

export { StructuredCommandExecutor as DockerCommandExecutor };
