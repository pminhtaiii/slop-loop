/**
 * Real-tier assembly (real-tier contract §(a), §(i); host contract §1 first stage; T050 + T061).
 *
 * `createHostAssembly()` takes no arguments because the operator CLI calls it that way
 * (`src/cli/evaluate.ts`), and returns `{ host, metadata[ , preflight] }` for the CLI loader. It is
 * synchronous and effect-free: it loads the profile, reads the credential, pins the endpoint and model,
 * and builds the real adapters. It never fetches, spawns, writes a task or touches the filesystem.
 *
 * The host is assembly-ready: the task-bound producers and per-task host ports are unbound (full
 * surface, `TASK_UNBOUND` on every call) and the config names no task, so `prepareUC03Host` is `ready`
 * while nothing can act. Binding them to one task is T061 (`real-tier-task-binding.ts`).
 *
 * `dependencies` is the test seam: `{ env, fetch, spawn, stateRoot, revision, components }`, each
 * defaulting to the real value. Every refusal is a `RealTierUnavailable` with a bounded reason code,
 * and never carries the endpoint URL, the host or the credential.
 *
 * A complete set is a prerequisite, not G-OWNERS evidence.
 */
import { randomUUID } from 'node:crypto';
import { DEEPSEEK_REVIEW_PROMPT } from '../foundation/deepseek-review-profile.ts';
import { createRuntimeReviewer, type RuntimeReviewer } from '../foundation/reviewer.ts';
import { HostModelPortV02, type DispatchAuthorityFacts } from '../foundation/model-v02.ts';
import { authorityFor, equal } from '../persistence/adapters/state-port-v02-admission.ts';
import { createRunUsageLimiter } from '../foundation/run-usage-limit.ts';
import { createDeepSeekTransport } from '../foundation/deepseek-transport.ts';
import type { StructuredCommandExecutor } from '../foundation/docker-command-executor.ts';
import { DockerLifecycleController, type StructuredSpawn } from '../foundation/docker-controller.ts';
import { DockerWorkspaceManager } from '../foundation/docker-workspace-manager.ts';
import { observeDockerReadiness } from '../foundation/docker-readiness.ts';
import { structuredSpawn } from '../foundation/docker-spawn.ts';
import { validateDockerProfile } from '../foundation/docker-workspace-policy.ts';
import type { DockerProfile } from '../foundation/docker-workspace-types.ts';
import { gitHead } from './git-head.ts';
import { loadRealTierProfile, type RealTierEnvironment, type RealTierProfile } from './real-tier-profile.ts';
import { createRealTierOwners, type RealTierOwners, type RealTierOwnersOptions } from './real-tier-owners.ts';
import type { UC03GraphConfigV02, UC03GraphPortsV02 } from '../uc03/graph-types-v02.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../uc03/graph-types-v02.ts';
import type { UC03HostInputs, UC03HostProducers } from './uc03-host-bootstrap.ts';
import { REAL_TIER_DELIVERY_CONTRACT } from './real-tier-owners.ts';
import type { OwnerDelivery } from './evaluation-composition.ts';
import { UNBOUND_CONFIG, unboundHostPorts, unboundProducers, type RealTierHostPorts } from './real-tier-task-producers.ts';

export { UNBOUND_CONFIG, TASK_UNBOUND, unboundHostPorts, unboundProducers } from './real-tier-task-producers.ts';
export type { RealTierHostPorts } from './real-tier-task-producers.ts';

/** Partial review profile: the pinned identity plus the two byte bounds the transport needs. */
const REVIEW_PROMPT = Object.freeze({ ...DEEPSEEK_REVIEW_PROMPT, maxOutputBytes: 16_384, maxResponseBytes: 131_072 });

export interface RealTierDependencies {
  readonly env?: RealTierEnvironment | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly spawn?: StructuredSpawn | undefined;
  /** Overrides the profile's `stateRoot`; tests point it at a temp directory. */
  readonly stateRoot?: string | undefined;
  /** Pinned revision every delivery declares; host.json supplies it (T060). */
  readonly revision?: string | undefined;
  readonly repositoryRoot?: string | undefined;
  /** UC-05 direction authority for the material replan transaction; absent means it verifies nothing. */
  readonly verifyDirection?: RealTierOwnersOptions['verifyDirection'];
  /** Test seam: a substituted delivery (for example a `mock` one) is refused, never reached. */
  readonly components?: Partial<RealTierComponents> | undefined;
}

/** Safe, allowlisted projection of the pinned identity (contract §(i)); validated by the CLI in T060. */
export interface RealTierMetadata {
  readonly profileDigest: string;
  readonly endpointDigest: string;
  readonly endpointScheme: 'https' | 'http';
  readonly insecureHttpAcknowledged: boolean;
  readonly model: string;
  readonly imageId: string;
}

/** The refusing half: a bounded reason and no component, so nothing can be built from a gap. */
export interface RealTierUnavailable {
  readonly status: 'unavailable';
  readonly reasonCode: string;
  readonly path: string;
}

/** The six task-independent components; each must declare `provenance: 'real'`. */
export const REAL_TIER_COMPONENTS = ['statePort', 'approvalPort', 'baselineEvidence', 'replanPort', 'modelPort', 'reviewerModelPort'] as const;

export type RealTierComponent = (typeof REAL_TIER_COMPONENTS)[number];

export interface RealTierComponents {
  readonly statePort: UC03GraphPortsV02['statePort'];
  readonly approvalPort: UC03GraphPortsV02['approvalPort'];
  readonly baselineEvidence: UC03GraphPortsV02['baselineEvidence'];
  readonly replanPort: UC03GraphPortsV02['replanPort'];
  readonly modelPort: UC03GraphPortsV02['modelPort'];
  readonly reviewerModelPort: HostModelPortV02 & { readonly providerRole: 'reviewer' };
}

/** A substituted delivery is named, refused, and never reached: the row asserts this code. */
function mockSwap(candidate: Partial<RealTierComponents>): RealTierUnavailable | undefined {
  const component = REAL_TIER_COMPONENTS.find(name => (candidate[name] as { readonly provenance?: unknown } | undefined)?.provenance !== 'real');
  return component === undefined ? undefined : unavailable('mock-delivery', `$.components.${component}`);
}

/** The built half. Everything below `owners` is task-independent. */
export interface RealTierAssembly {
  readonly status: 'assembly-ready';
  readonly profile: RealTierProfile;
  readonly metadata: RealTierMetadata;
  readonly owners: RealTierOwners;
  readonly components: RealTierComponents;
  readonly controller: DockerLifecycleController;
  readonly workspaceManager: DockerWorkspaceManager;
  readonly executor: StructuredCommandExecutor;
  /** The canonical reviewer ingress over the same transport; its own port is `components.reviewerModelPort`. */
  readonly reviewer: RuntimeReviewer;
  /** The four task-bound producers, unbound: full surface, real provenance, every call `TASK_UNBOUND`. */
  readonly producers: UC03HostProducers;
  readonly revision: string;
  /** The three per-task host ports, unbound until a task is seeded. */
  readonly hostPorts: RealTierHostPorts;
  /** Task-less wiring: `trustedExpectedContext()` refuses a context that names no task (§1). */
  readonly config: UC03GraphConfigV02;
  /** Not G-OWNERS, not an owner delivery, not real execution: a prerequisite only. */
  readonly evidenceTier: 'controlled-prerequisite';
}

export type RealTierResolution = RealTierAssembly | RealTierUnavailable;

const unavailable = (reasonCode: string, path = '$'): RealTierUnavailable => Object.freeze({ status: 'unavailable', reasonCode, path });

/**
 * The four owner components this host never takes from an owner: `baselineEvidence` is a host producer
 * (host contract §3), and the other three are T061's task-bound producers. Listing one twice denies all.
 */
const PRODUCER_COMPONENTS = ['guardedRead', 'baselineEvidence', 'hostAuthority', 'contextSource'] as const;

/**
 * The owner delivery list the host bootstrap composes: the T050 owner deliveries, plus a host delivery
 * for every other non-producer component, pinned by `revisionOf`. Producers are excluded because they
 * arrive through `producers`, and the owner's own `baselineEvidence` (a producer, §3) is dropped too.
 */
export function hostDeliveries(owner: RealTierOwners['deliveries'], components: RealTierComponents, ports: RealTierHostPorts, revisionOf: (component: string) => string): readonly OwnerDelivery[] {
  const adapters: Record<string, unknown> = { ...components, ...ports };
  const covered = new Set(owner.map(delivery => delivery.component));
  const built = UC03_PRODUCTION_COMPONENTS_V02.filter(component => !covered.has(component) && !(PRODUCER_COMPONENTS as readonly string[]).includes(component)).map(
    component =>
      ({
        component,
        id: `host-${component}`,
        contractVersion: REAL_TIER_DELIVERY_CONTRACT,
        revision: revisionOf(component),
        provenance: 'real',
        adapter: adapters[component],
      }) as OwnerDelivery,
  );
  return Object.freeze([...owner.filter(delivery => !(PRODUCER_COMPONENTS as readonly string[]).includes(delivery.component)), ...built]);
}

/** The profile's image as the pinned Docker profile the controller and executor both validate. */
export function dockerProfileOf(profile: RealTierProfile): DockerProfile | RealTierUnavailable {
  const candidate: DockerProfile = {
    profileId: profile.image.label,
    image: profile.image.base,
    imageDigest: profile.image.imageId,
    user: profile.image.user,
    readOnlyRootFilesystem: true,
    network: 'none',
    limits: {
      timeoutMs: profile.limits.commandTimeoutMs,
      maxMemoryBytes: profile.limits.memoryBytes,
      maxCpuCores: profile.limits.cpus,
      maxPids: profile.limits.processes,
      maxOutputBytes: profile.limits.outputBytes,
    },
    // shortcut: the trusted profile carries no mounts, because volume ids are per (task, workspace)
    // and only T061 knows them. The plan's own two mounts are still validated per execution; add the
    // bound mounts here if a caller ever passes `profile` into the executor.
    mounts: [],
  };
  const validated = validateDockerProfile(candidate);
  return validated.ok ? validated.value : unavailable('profile-image-invalid', '$.image');
}

function metadataOf(profile: RealTierProfile): RealTierMetadata {
  return Object.freeze({
    profileDigest: `sha256:${profile.profileDigest}`,
    endpointDigest: `sha256:${profile.endpoint.endpointDigest}`,
    endpointScheme: profile.endpoint.scheme,
    insecureHttpAcknowledged: profile.endpoint.insecureHttpAcknowledged,
    model: profile.endpoint.model,
    imageId: profile.image.imageId,
  });
}

/**
 * The assembly itself. A `catch` here is deliberate: a transport, limiter or Docker profile that
 * refuses construction (invalid run limits, an invalid pinned image) is exactly the `unavailable`
 * outcome the contract asks for, and its message is translated to a bounded code, never echoed.
 */
function build(profile: RealTierProfile, dependencies: RealTierDependencies, stateRoot: string): RealTierResolution {
  const dockerProfile = dockerProfileOf(profile);
  if ('status' in dockerProfile) return dockerProfile;
  const spawn = dependencies.spawn ?? structuredSpawn;
  // The controller builds before the manager that resolves its per-workspace binding, so the
  // binding closure reads the manager once it exists; before that it has nothing to resolve.
  const wired: { manager?: DockerWorkspaceManager } = {};
  let controller: DockerLifecycleController;
  let workspaceManager: DockerWorkspaceManager;
  let executor: StructuredCommandExecutor;
  try {
    controller = new DockerLifecycleController({
      profile: dockerProfile,
      platform: profile.image.platform,
      spawn,
      resolveWorkspace: workspaceId => {
        const workspace = wired.manager?.getWorkspace(workspaceId);
        const revision = wired.manager?.getCanonicalRevision(workspaceId);
        return workspace === undefined || revision === undefined ? undefined : { repoVolumeId: workspace.repoVolumeId, canonicalRevisionDigest: revision };
      },
    });
    workspaceManager = new DockerWorkspaceManager({ controller });
    wired.manager = workspaceManager;
    executor = workspaceManager.createCommandExecutor(dockerProfile);
  } catch {
    return unavailable('docker-profile-invalid', '$.image');
  }
  // The template pins the Git HEAD as every delivery revision, so HEAD is the default: a profile
  // digest here would make the no-argument factory stale against the host file it is printed for.
  const revision = dependencies.revision ?? gitHead(dependencies.repositoryRoot ?? process.cwd());
  // No catch here: the profile already validated the credential, the endpoint, the pricing and both
  // run limits, so anything that throws is a programming error and must surface, not be relabelled.
  const transport = createDeepSeekTransport({
    apiKey: profile.credential,
    endpoint: profile.endpoint.href,
    allowInsecureHttp: profile.endpoint.insecureHttpAcknowledged,
    pricing: profile.pricing,
    reviewPrompt: REVIEW_PROMPT,
    runLimiter: createRunUsageLimiter({
      totalModelCalls: profile.limits.totalModelCalls,
      perRunInputTokens: profile.runLimits.perRunInputTokens,
      perRunOutputTokens: profile.runLimits.perRunOutputTokens,
    }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });
  const owners = createRealTierOwners({
    stateRoot,
    revision,
    approvalProfileVersion: profile.approvalPolicy.profileVersion,
    ...(dependencies.verifyDirection === undefined ? {} : { verifyDirection: dependencies.verifyDirection }),
  });
  // The reviewer ingress is the same transport in a distinct role; the marker is required by
  // `PORT_DECLARATIONS_V02`, and provenance still derives from the branded transport alone.
  // Both ports carry an explicit trusted actor: without one every dispatch is EXECUTOR_IDENTITY_REQUIRED.
  // shortcut: one incarnation per process, generation 1 (the seeded head's epoch); raise on re-fence.
  const incarnation = `real-tier-${randomUUID()}`;
  const actorOf = (adapterIdentity: string) => ({ adapterIdentity, processIncarnation: incarnation, fencingGeneration: 1 });
  /**
   * Last pre-transport check (SPEC-W5-001): the durable control head must still match the attempt's begin
   * facts, so a pause after `beginAttempt` (epoch unchanged) is refused. Missing/drifted head is `false`.
   *
   * shortcut: a pause ordered between this synchronous read and transport start still escapes; closing
   * that window needs the owner lock to serialize transport start too.
   */
  const ownerState = owners.components.statePort as { readonly readControlHead?: (taskId: string) => unknown };
  const currentDispatchAuthority = (facts: DispatchAuthorityFacts): boolean => {
    const control = ownerState.readControlHead?.(facts.taskId) as Partial<Record<'mode' | 'controlVersion' | 'epoch' | 'activeAuthorityRef' | 'activeClaimId', unknown>> | undefined;
    if (typeof control !== 'object' || control === null) return false;
    return (
      Object.is(control.mode, 'runnable') &&
      control.controlVersion === facts.attempt.postBeginControlVersion &&
      control.epoch === facts.attempt.epoch &&
      control.activeClaimId === facts.claimId &&
      equal(control.activeAuthorityRef, authorityFor(facts.context))
    );
  };
  const reviewerActor = actorOf('uc03-real-tier-reviewer');
  const reviewerModelPort = Object.assign(
    new HostModelPortV02({ transport, statePort: owners.components.statePort, executorIdentity: reviewerActor, currentExecutorIdentity: () => reviewerActor, currentDispatchAuthority }),
    { providerRole: 'reviewer' as const },
  );
  // The published revision is the owner state's own fact, keyed by the task the caller supplies, so
  // the reviewer needs no binding of its own.
  const reviewer = createRuntimeReviewer({ model: reviewerModelPort, resolveRepoDigest: async task => (await owners.components.statePort.loadTask(task.taskId))?.repositoryRevisionDigest });
  const coderActor = actorOf('uc03-real-tier-coder');
  const built: RealTierComponents = {
    ...owners.components,
    modelPort: new HostModelPortV02({ transport, statePort: owners.components.statePort, executorIdentity: coderActor, currentExecutorIdentity: () => coderActor, currentDispatchAuthority }),
    reviewerModelPort,
  };
  const merged = { ...built, ...dependencies.components };
  const refused = mockSwap(merged);
  if (refused !== undefined) return refused;

  return Object.freeze({
    status: 'assembly-ready',
    profile,
    metadata: metadataOf(profile),
    owners,
    components: Object.freeze(merged),
    controller,
    workspaceManager,
    executor,
    reviewer,
    producers: unboundProducers(),
    revision,
    hostPorts: unboundHostPorts(),
    config: UNBOUND_CONFIG,
    evidenceTier: 'controlled-prerequisite',
  });
}

/**
 * Resolves the operator profile and builds the task-independent set, or refuses with a bounded code.
 */
export function resolveRealTierAssembly(dependencies: RealTierDependencies = {}): RealTierResolution {
  const env = dependencies.env ?? process.env;
  const loaded = loadRealTierProfile(env, dependencies.repositoryRoot === undefined ? {} : { repositoryRoot: dependencies.repositoryRoot });
  if (!loaded.ok) return unavailable(loaded.reasonCode, loaded.path);
  const profile = loaded.value;
  const stateRoot = dependencies.stateRoot ?? profile.stateRoot;
  if (dependencies.stateRoot !== undefined && !stateRoot.trim()) return unavailable('state-root-invalid', '$.stateRoot');
  const resolved = build(profile, dependencies, stateRoot);
  // An empty default revision is reported where it is one: never as a built assembly with no pins.
  return resolved.status === 'assembly-ready' && resolved.revision === '' ? unavailable('delivery-revision-unresolved', '$.revision') : resolved;
}

/**
 * The name the CLI loader requires. `metadata` and `preflight` sit beside `host` because that is where
 * T060 lifts them from (contract §(i)): the metadata is the frozen safe projection, and the preflight
 * is the operational Docker observation over the injected `spawn`, delegating to
 * `observeDockerReadiness`.
 *
 * T061 completes the static host: the four producers are unbound (full surface, `TASK_UNBOUND` on every
 * call) and the config names no task, so `prepareUC03Host` through `resolveHostAssembly` then
 * `prepareAssembly` is `ready` with zero fetches, spawns and task writes. That is assembly-ready only.
 */
export function createHostAssembly(dependencies: RealTierDependencies = {}):
  | {
      readonly host: UC03HostInputs;
      readonly metadata: RealTierMetadata;
      readonly preflight: () => ReturnType<typeof observeDockerReadiness>;
      readonly assembly: RealTierAssembly;
    }
  | RealTierUnavailable {
  const resolved = resolveRealTierAssembly(dependencies);
  if (resolved.status === 'unavailable') return resolved;
  const spawn = dependencies.spawn ?? structuredSpawn;
  const { imageId } = resolved.metadata;
  // `prepareAssembly` spreads `pins` and `identity` from the host file over these, so the placeholders
  // here are never the ones the bootstrap validates.
  const host: UC03HostInputs = Object.freeze({
    owner: hostDeliveries(resolved.owners.deliveries, resolved.components, resolved.hostPorts, () => resolved.revision),
    producers: resolved.producers,
    config: resolved.config,
    pins: { contractVersion: '', revisions: {} },
    identity: {},
  });
  return {
    host,
    metadata: resolved.metadata,
    preflight: () => observeDockerReadiness(spawn, imageId),
    assembly: resolved,
  };
}

export { REAL_TIER_DELIVERY_CONTRACT } from './real-tier-owners.ts';
