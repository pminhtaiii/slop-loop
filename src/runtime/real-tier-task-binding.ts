/**
 * T061 — per-task real-tier binding (host contract §1 second stage, real-tier contract §(a)
 * "Production task binding").
 *
 * `createHostAssembly()` builds the task-independent set and refusing unbound producers. This module
 * takes one operator-resolved catalog entry, loads its digest-pinned fixture, seeds the task through
 * the public owner path (`StatePortV02.transition(state, 0)` exactly once) and builds the four
 * task-bound producers, the per-task owner instances and `config.trustedExpectedContext`. It then
 * re-runs the unchanged `prepareUC03Host`. Every refusal that can be decided before the seed happens
 * before it, so a stale pin, a foreign catalog or a bad bound never writes a task record.
 *
 * Task facts come only from the pinned fixture: never argv, a model, or submitted JSON. The profile
 * and host.json schemas are unchanged, because the catalog is already operator-resolved and the
 * catalog path is the loaded profile's own `catalog.path`, never a caller-supplied one.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { computeCanonicalSha256, validateBugTask } from '../contracts/foundation/uc03.ts';
import type { BugTask, PolicyAuthorityRefV02, TaskState } from '../contracts/foundation/uc03.ts';
import { WorkspaceFilesystemPort } from '../foundation/host-filesystem-port.ts';
import type { TrustedFilesystemPort } from '../foundation/repository-types.ts';
import { stateReadPolicyDigest } from '../persistence/adapters/state-port-v02-read-fence.ts';
import { MAX_TASK_REPLANS } from '../uc03/replan-accounting.ts';
import type { UC03GraphConfigV02, UC03GraphPortsV02 } from '../uc03/graph-types-v02.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../uc03/graph-types-v02.ts';
import { sha256Text } from '../uc01/contracts.ts';
import { createHostActionContext } from './host-action-context.ts';
import type { RealContextSource } from '../approvals/real-context-provider.ts';
import { seedTaskState } from './real-tier-task-seed.ts';
import type { SeededTaskIds } from './real-tier-task-seed.ts';
import type { RealTierAssembly } from './real-tier-assembly.ts';
import { hostDeliveries } from './real-tier-assembly.ts';
import { REAL_TIER_DELIVERY_CONTRACT } from './real-tier-owners.ts';
import { buildBoundCapabilities, type BoundCapabilities } from './real-tier-task-producers.ts';
import { prepareUC03Host, type UC03HostInputs, type UC03HostReadiness } from './uc03-host-bootstrap.ts';

/** One catalog entry, as the T047 profile's catalog file already declares it. */
interface RealTierCatalogEntry {
  readonly fixturePath: string;
  readonly fixtureDigest: string;
  readonly initialRepositoryDigest: string;
}

/** The fixture document: a pinned task plus the target repository root. */
export interface RealTierFixture {
  readonly task: BugTask;
  readonly repositoryRoot: string;
}

export interface RealTierBindingOptions {
  /** The catalog entry to bind, by `caseId`; the catalog itself is the profile's `catalog.path`. */
  readonly caseId: string;
  /** Host.json pins and identity, so binding re-runs `prepareUC03Host` on the bound inputs. */
  readonly pins: UC03HostInputs['pins'];
  readonly identity: Readonly<Record<string, string>>;
  /** Injectable safe-id source for the run and workspace a new task allocates. */
  readonly ids?: ((kind: 'run' | 'workspace', caseId: string) => string) | undefined;
  /** Reads both files; a test seam that proves the refusal precedes any read of owner state. */
  readonly readTextFile?: ((path: string) => string) | undefined;
  /** Provider/approval policy identity; defaults to the task's own configuration identity. */
  readonly policyIdentity?: Readonly<{ policyId: string; policyVersion: string; configId: string; configVersion: string }> | undefined;
  readonly actionTtlMs?: number | undefined;
  readonly maxReadPathLength?: number | undefined;
  readonly maxQueryLength?: number | undefined;
  readonly maxFileBytes?: number | undefined;
  /** Overrides the profile's `artifacts.retainRoot`; tests point it at a temp directory. */
  readonly retainedRoot?: string | undefined;
}

export type RealTierBindingRefusal = Readonly<{ status: 'unavailable'; reasonCode: string; path: string }>;

/** The bound half: graph ports, config, readiness, and the seeded identities a runner drives. */
export interface RealTierBoundTask {
  readonly status: 'task-bound';
  /** A prerequisite, never G-OWNERS evidence, and not a real execution claim. */
  readonly evidenceTier: 'controlled-prerequisite';
  readonly task: BugTask;
  readonly ids: SeededTaskIds;
  readonly repositoryRoot: string;
  readonly ports: UC03GraphPortsV02;
  readonly config: UC03GraphConfigV02;
  readonly readiness: Extract<UC03HostReadiness, { status: 'ready' }>;
}

export type RealTierBinding = RealTierBoundTask | RealTierBindingRefusal;

const refused = (reasonCode: string, path = '$'): RealTierBindingRefusal => Object.freeze({ status: 'unavailable', reasonCode, path });
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BOUND = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined);

let sequence = 0;
/** Safe and unique per process: the allocator used when the caller supplies no id source. */
const defaultIds = (kind: 'run' | 'workspace', caseId: string): string => `${kind}-${caseId}-${(sequence += 1)}`;

/** The catalog entry for one case id, or a bounded refusal. */
function entryOf(source: string, caseId: string): RealTierCatalogEntry | RealTierBindingRefusal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return refused('catalog-invalid', '$.catalog');
  }
  const entries = (parsed as { readonly catalog?: unknown } | null)?.catalog;
  if (!Array.isArray(entries)) return refused('catalog-invalid', '$.catalog');
  const entry = entries.find((candidate: unknown) => typeof candidate === 'object' && candidate !== null && (candidate as { caseId?: unknown }).caseId === caseId);
  if (entry === undefined) return refused('catalog-entry-missing', '$.catalog');
  const record = entry as Readonly<Record<string, unknown>>;
  if (typeof record['fixturePath'] !== 'string' || typeof record['fixtureDigest'] !== 'string') return refused('catalog-invalid', '$.catalog');
  return {
    fixturePath: record['fixturePath'],
    fixtureDigest: record['fixtureDigest'],
    initialRepositoryDigest: typeof record['initialRepositoryDigest'] === 'string' ? record['initialRepositoryDigest'] : '',
  };
}

/**
 * The fixture and its containment. It must digest to the entry's `fixtureDigest`, its task must
 * validate, its revision must equal the entry's, and `repositoryRoot` must resolve, under realpath,
 * inside the catalog's own directory. This is the only place a task fact enters the binding.
 */
function loadFixture(readText: (path: string) => string, entry: RealTierCatalogEntry, catalogPath: string): RealTierFixture | RealTierBindingRefusal {
  if (!isAbsolute(entry.fixturePath)) return refused('fixture-path-invalid', '$.fixturePath');
  let text: string;
  try {
    text = readText(entry.fixturePath);
  } catch {
    return refused('fixture-unreadable', '$.fixturePath');
  }
  if (sha256Text(text) !== entry.fixtureDigest) return refused('fixture-digest-mismatch', '$.fixtureDigest');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refused('fixture-invalid', '$.fixture');
  }
  if (typeof parsed !== 'object' || parsed === null) return refused('fixture-invalid', '$.fixture');
  const document = parsed as Readonly<Record<string, unknown>>;
  const task = validateBugTask(document['task']);
  if (!task.ok) return refused('task-invalid', '$.task');
  // The carried prerequisite: the replan ledger is three slots, so a fixture that disagrees is refused.
  if (task.value.budgetLimits.maxReplanCount !== MAX_TASK_REPLANS) return refused('replan-count-unsupported', '$.task.budgetLimits.maxReplanCount');
  if (task.value.initialRevisionDigest.replace(/^sha256:/u, '') !== entry.initialRepositoryDigest) return refused('revision-mismatch', '$.initialRepositoryDigest');

  const declared = document['repositoryRoot'];
  if (typeof declared !== 'string' || !declared.trim()) return refused('repository-root-missing', '$.repositoryRoot');
  const catalogDir = realpathSync(dirname(catalogPath));
  let resolved: string;
  try {
    resolved = realpathSync(isAbsolute(declared) ? declared : join(dirname(entry.fixturePath), declared));
  } catch {
    return refused('repository-root-unresolvable', '$.repositoryRoot');
  }
  const within = relative(catalogDir, resolved);
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) return refused('repository-root-escapes-catalog', '$.repositoryRoot');

  return { task: task.value, repositoryRoot: resolved };
}

function policyOf(task: BugTask, options: RealTierBindingOptions): Readonly<{ policyId: string; policyVersion: string; configId: string; configVersion: string }> {
  return options.policyIdentity ?? { policyId: task.configId, policyVersion: task.configVersion, configId: task.configId, configVersion: task.configVersion };
}

/**
 * Reads, validates, binds and seeds once. The catalog is the loaded profile's own `catalog.path`.
 *
 * Everything the binding can decide on its own — the fixture, the ids, the finite bounds, the host
 * pins against this assembly — is decided before the seed, so those refusals leave no task record.
 * The per-task capability construction happens after it, because a construction failure is a
 * documented recover/translate case: the task is already allocated and named, so it stays persisted
 * and the binding reports a bounded `unavailable` rather than rejecting.
 */
export async function bindRealTierTask(assembly: RealTierAssembly, options: RealTierBindingOptions): Promise<RealTierBinding> {
  const readText = options.readTextFile ?? ((path: string): string => readFileSync(path, 'utf8'));
  const catalogPath = assembly.profile.catalog.path;
  let catalogText: string;
  try {
    catalogText = readText(catalogPath);
  } catch {
    return refused('catalog-unreadable', '$.catalog');
  }
  const found = entryOf(catalogText, options.caseId);
  if ('status' in found) return found;
  const fixture = loadFixture(readText, found, catalogPath);
  if ('status' in fixture) return fixture;
  const { task, repositoryRoot } = fixture;

  // Every finite bound is validated here, before any effect: a zero TTL or path bound is a bad
  // binding, not a task that should stay half-built.
  const actionTtlMs = options.actionTtlMs ?? 60_000;
  const maxReadPathLength = options.maxReadPathLength ?? 512;
  const maxQueryLength = options.maxQueryLength ?? 256;
  const maxFileBytes = options.maxFileBytes ?? 1_048_576;
  if ([actionTtlMs, maxReadPathLength, maxQueryLength, maxFileBytes].some(value => BOUND(value) === undefined)) return refused('options-invalid', '$.options');

  // Static pins before any write: every delivery this binding emits declares the assembly's own
  // revision and the host contract, so a drifted host file is named here, not discovered after a seed.
  if (options.pins.contractVersion !== REAL_TIER_DELIVERY_CONTRACT) return refused('host-incompatible-delivery', '$');
  if (UC03_PRODUCTION_COMPONENTS_V02.some(component => options.pins.revisions[component] !== assembly.revision)) return refused('host-stale-revision', '$');
  // Identity too is pre-checkable, so it is decided here rather than after the task has been persisted
  // (STD-W4-003): the unchanged bootstrap over the task-independent inputs validates it with no effect.
  const staticReadiness = prepareUC03Host({
    owner: hostDeliveries(assembly.owners.deliveries, assembly.components, assembly.hostPorts, () => assembly.revision),
    producers: assembly.producers,
    config: assembly.config,
    pins: options.pins,
    identity: options.identity,
  });
  if (staticReadiness.status !== 'ready')
    return refused(`host-${staticReadiness.reasons.find(reason => reason.kind === 'identity')?.reasonCode ?? staticReadiness.reasons[0]?.reasonCode ?? 'unavailable'}`, '$');

  // An existing task is loaded before anything is allocated, and its persisted identity is
  // authoritative (§(g), §1): a rebind returns the same run and workspace, or it is refused.
  const existing = await assembly.owners.components.statePort.loadTask(task.taskId);
  if (existing !== null) {
    if (existing.taskContext !== undefined && computeCanonicalSha256(existing.taskContext) !== computeCanonicalSha256(task)) return refused('task-identity-mismatch', '$.task');
    if (existing.repositoryId !== task.repositoryId) return refused('task-repository-mismatch', '$.task.repositoryId');
    if (existing.repositoryRevisionDigest !== task.initialRevisionDigest) return refused('task-revision-mismatch', '$.task.initialRevisionDigest');
  }
  const allocate = options.ids ?? defaultIds;
  const ids: SeededTaskIds =
    existing === null
      ? { taskId: task.taskId, runId: allocate('run', options.caseId), workspaceId: allocate('workspace', options.caseId) }
      : { taskId: task.taskId, runId: existing.runId, workspaceId: existing.workspaceId };
  if (![ids.taskId, ids.runId, ids.workspaceId].every(id => SAFE_ID.test(id) && !id.includes('..'))) return refused('task-id-invalid', '$.ids');

  const policy = policyOf(task, options);
  // The authority ref the read fence will see: seeded as the task's control head, so a bound read is
  // admitted rather than refused, and digesting to exactly the policy the capability was built with.
  const authorityRef: PolicyAuthorityRefV02 = { ...policy, issuerKeyRef: `host-${task.configId}`, decisionAuthorityGeneration: 1 };
  const policyDigest = stateReadPolicyDigest(ids.taskId, authorityRef);

  // The observed-action source is built lazily by the owners, once per task: `taskOwners` caches by
  // task id, so a second bind must reuse the first bind's source rather than orphan its registry.
  const filesystem: TrustedFilesystemPort = new WorkspaceFilesystemPort({ root: repositoryRoot });
  const createContext = (): RealContextSource => createHostActionContext({ filesystem, workspaceId: ids.workspaceId, repositoryId: task.repositoryId, policyIdentity: policy, ttlMs: actionTtlMs });
  const owners = assembly.owners.taskOwners({ taskId: ids.taskId, workspaceId: ids.workspaceId, repositoryId: task.repositoryId, policyIdentity: policy, authorityRef, createContext });
  const contextSource = owners.contextSource;
  if (existing === null) {
    try {
      await owners.statePort.transition(seedTaskState(task, ids), 0);
    } catch {
      return refused('seed-refused', '$.task');
    }
  }
  const seeded: TaskState | null = await owners.statePort.loadTask(ids.taskId);
  if (seeded === null) return refused('seed-missing', '$.task');

  // From here the task is persisted. A capability that cannot be constructed is the documented
  // recover/translate case: a bounded refusal, never a rejection, and never a silent success.
  let bound: BoundCapabilities;
  try {
    bound = await buildBoundCapabilities(assembly, task, ids, filesystem, owners, contextSource, {
      authorityRef,
      repositoryRoot,
      policyDigest,
      maxReadPathLength,
      maxQueryLength,
      maxFileBytes,
      retainedRoot: options.retainedRoot ?? assembly.profile.artifacts.retainRoot,
    });
    // The one genuinely post-seed effect: capturing the retained initial tree (§7).
    await bound.diff.prepare();
  } catch {
    return refused('binding-unavailable', '$');
  }

  // The unchanged bootstrap over the bound inputs and the host's own pins (§1 second stage). Its pins
  // were checked above, so only identity or a substitution can refuse here.
  const readiness = prepareUC03Host({
    owner: hostDeliveries(assembly.owners.deliveries, assembly.components, bound.hostPorts, () => assembly.revision),
    producers: { guardedRead: bound.guardedRead, hostAuthority: bound.hostAuthority, contextSource: bound.contextSource, baselineEvidence: assembly.components.baselineEvidence },
    config: bound.config,
    pins: options.pins,
    identity: options.identity,
  });
  if (readiness.status !== 'ready') return refused(`host-${readiness.reasons[0]?.reasonCode ?? 'unavailable'}`, '$');

  return Object.freeze({
    status: 'task-bound',
    evidenceTier: 'controlled-prerequisite',
    task,
    ids,
    repositoryRoot,
    ports: bound.ports,
    config: bound.config,
    readiness,
  });
}
