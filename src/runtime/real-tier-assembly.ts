/**
 * T050 — task-independent real-tier component set (real-tier contract §(a) "Production assembly
 * module", §(i) metadata, host contract §1 first stage).
 *
 * `createHostAssembly()` takes no arguments because the operator CLI calls it that way
 * (`src/cli/evaluate.ts`), and returns `{ host, metadata }` for the CLI loader. It is synchronous and
 * effect-free: it loads the profile, reads the credential, pins the endpoint and model, and builds the
 * real adapters. It never fetches, spawns, writes a task or touches the filesystem.
 *
 * `dependencies` is the test seam: `{ env, fetch, spawn, stateRoot, revision, components }`, each
 * defaulting to the real value. Every refusal is a `RealTierUnavailable` with a bounded reason code,
 * and never carries the endpoint URL, the host or the credential.
 *
 * It deliberately does NOT build the four task-bound producers (guarded read, host authority, context
 * source, repository port) or `config.trustedExpectedContext`, and never claims `prepareUC03Host`
 * returns `ready` — those are T061. `metadata` is inert until T060 wires it into the CLI.
 *
 * A complete set is a prerequisite, not G-OWNERS evidence.
 */
import { DEEPSEEK_REVIEW_PROMPT } from '../foundation/deepseek-review-profile.ts';
import { createRuntimeReviewer, type RuntimeReviewer } from '../foundation/reviewer.ts';
import { HostModelPortV02 } from '../foundation/model-v02.ts';
import { createRunUsageLimiter } from '../foundation/run-usage-limit.ts';
import { createDeepSeekTransport } from '../foundation/deepseek-transport.ts';
import type { StructuredCommandExecutor } from '../foundation/docker-command-executor.ts';
import { DockerLifecycleController, type StructuredSpawn } from '../foundation/docker-controller.ts';
import { DockerWorkspaceManager } from '../foundation/docker-workspace-manager.ts';
import { observeDockerReadiness } from '../foundation/docker-readiness.ts';
import { structuredSpawn } from '../foundation/docker-spawn.ts';
import { validateDockerProfile } from '../foundation/docker-workspace-policy.ts';
import type { DockerProfile } from '../foundation/docker-workspace-types.ts';
import { loadRealTierProfile, type RealTierEnvironment, type RealTierProfile } from './real-tier-profile.ts';
import { createRealTierOwners, type RealTierOwners } from './real-tier-owners.ts';
import type { UC03GraphPortsV02 } from '../uc03/graph-types-v02.ts';
import type { OwnerDelivery } from './evaluation-composition.ts';

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
  /** Not G-OWNERS, not an owner delivery, not real execution: a prerequisite only. */
  readonly evidenceTier: 'controlled-prerequisite';
}

export type RealTierResolution = RealTierAssembly | RealTierUnavailable;

const unavailable = (reasonCode: string, path = '$'): RealTierUnavailable => Object.freeze({ status: 'unavailable', reasonCode, path });

/** The profile's image as the pinned Docker profile the controller and executor both validate. */
function dockerProfileOf(profile: RealTierProfile): DockerProfile | RealTierUnavailable {
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
  const revision = dependencies.revision ?? profile.profileDigest;
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
  const owners = createRealTierOwners({ stateRoot, revision, approvalProfileVersion: profile.approvalPolicy.profileVersion });
  // The reviewer ingress is the same transport in a distinct role; the marker is required by
  // `PORT_DECLARATIONS_V02`, and provenance still derives from the branded transport alone.
  const reviewerModelPort = Object.assign(new HostModelPortV02({ transport, statePort: owners.components.statePort }), { providerRole: 'reviewer' as const });
  // The published revision is the owner state's own fact, keyed by the task the caller supplies, so
  // the reviewer needs no binding of its own.
  const reviewer = createRuntimeReviewer({ model: reviewerModelPort, resolveRepoDigest: async task => (await owners.components.statePort.loadTask(task.taskId))?.repositoryRevisionDigest });
  const built: RealTierComponents = { ...owners.components, modelPort: new HostModelPortV02({ transport, statePort: owners.components.statePort }), reviewerModelPort };
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
    evidenceTier: 'controlled-prerequisite',
  });
}

/** Resolves the operator profile and builds the task-independent set, or refuses with a bounded code. */
export function resolveRealTierAssembly(dependencies: RealTierDependencies = {}): RealTierResolution {
  const env = dependencies.env ?? process.env;
  const loaded = loadRealTierProfile(env, dependencies.repositoryRoot === undefined ? {} : { repositoryRoot: dependencies.repositoryRoot });
  if (!loaded.ok) return unavailable(loaded.reasonCode, loaded.path);
  const profile = loaded.value;
  const stateRoot = dependencies.stateRoot ?? profile.stateRoot;
  if (dependencies.stateRoot !== undefined && !stateRoot.trim()) return unavailable('state-root-invalid', '$.stateRoot');
  return build(profile, dependencies, stateRoot);
}

/**
 * The name the CLI loader requires. `metadata` and `preflight` sit beside `host` because that is where
 * T060 lifts them from (contract §(i)): the metadata is the frozen safe projection, and the preflight
 * is the operational Docker observation over the injected `spawn`, delegating to
 * `observeDockerReadiness`. Both are absent from the returned host wiring, so `createHostAssembly`
 * still makes no ready claim and leaves `prepareUC03Host` the only readiness authority.
 */
export function createHostAssembly(dependencies: RealTierDependencies = {}):
  | {
      readonly host: { readonly owner: readonly OwnerDelivery[] };
      readonly metadata: RealTierMetadata;
      readonly preflight: () => ReturnType<typeof observeDockerReadiness>;
      readonly assembly: RealTierAssembly;
    }
  | RealTierUnavailable {
  const resolved = resolveRealTierAssembly(dependencies);
  if (resolved.status === 'unavailable') return resolved;
  const spawn = dependencies.spawn ?? structuredSpawn;
  const { imageId } = resolved.metadata;
  // Assembly-ready only: the four task-bound producers and trustedExpectedContext arrive with T061,
  // so the host carries the real owner deliveries and the built adapters, and makes no ready claim.
  return {
    host: Object.freeze({ owner: resolved.owners.deliveries }),
    metadata: resolved.metadata,
    preflight: () => observeDockerReadiness(spawn, imageId),
    assembly: resolved,
  };
}

export { REAL_TIER_DELIVERY_CONTRACT } from './real-tier-owners.ts';
