/**
 * T061 — per-task real-tier binding (host contract §1 second stage, real-tier contract §(a)
 * "Production task binding").
 *
 * `createHostAssembly()` builds the task-independent set and refusing unbound producers. This module
 * takes one operator-resolved catalog entry, loads its digest-pinned fixture, seeds the task through
 * the public owner path (`StatePortV02.transition(state, 0)` exactly once) and builds the four
 * task-bound producers, the per-task owner instances and `config.trustedExpectedContext`. It then
 * re-runs the unchanged `prepareUC03Host`. Every refusal happens before any write.
 *
 * Task facts come only from the pinned fixture: never argv, a model, or submitted JSON. The profile
 * and host.json schemas are unchanged, because the catalog is already operator-resolved.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { computeCanonicalSha256, computeCheckSetDigest, validateBugTask } from '../contracts/foundation/uc03.ts';
import type { BugTask, TaskState } from '../contracts/foundation/uc03.ts';
import { createGuardedReadCapability } from '../foundation/guarded-read-capability.ts';
import { createExecutionGuardV02 } from '../foundation/execution-guard.ts';
import { WorkspaceFilesystemPort } from '../foundation/host-filesystem-port.ts';
import { createDurableAttemptStartRecoveryHandoff, createDurableUnattemptedClaimClosureHandoff, createRefusingPatchRecoveryHandoff } from '../foundation/durable-recovery-handoffs.ts';
import { createRepositoryReceiverV02 } from '../foundation/repository-tools.ts';
import type { TrustedFilesystemPort } from '../foundation/repository-types.ts';
import { stateReadPolicyDigest } from '../persistence/adapters/state-port-v02-read-fence.ts';
import { MAX_TASK_REPLANS } from '../uc03/replan-accounting.ts';
import { resolveExpectedTestFiles } from '../uc03/graph-validation.ts';
import type { UC03GraphConfigV02, UC03GraphPortsV02 } from '../uc03/graph-types-v02.ts';
import type { TrustedHostExpectedContext } from '../uc03/investigation-types.ts';
import { sha256Text } from '../uc01/contracts.ts';
import { createHostActionContext } from './host-action-context.ts';
import { createTrustedHostSnapshot } from './trusted-host-snapshot.ts';
import { seedTaskState } from './real-tier-task-seed.ts';
import type { SeededTaskIds } from './real-tier-task-seed.ts';
import type { RealTierAssembly } from './real-tier-assembly.ts';
import { hostDeliveries } from './real-tier-assembly.ts';
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
  /** The catalog file the profile names; the entry and its fixture are never named by argv. */
  readonly catalogPath: string;
  /** The catalog entry to bind, by `caseId`. */
  readonly caseId: string;
  /** Host.json pins and identity, so binding re-runs `prepareUC03Host` on the bound inputs. */
  readonly pins: UC03HostInputs['pins'];
  readonly identity: Readonly<Record<string, string>>;
  /** Injectable safe-id source for the run and workspace the binding allocates itself. */
  readonly ids?: ((kind: 'run' | 'workspace', caseId: string) => string) | undefined;
  /** Reads both files; a test seam that proves the refusal precedes any read of owner state. */
  readonly readTextFile?: ((path: string) => string) | undefined;
  /** Provider/approval policy identity; defaults to the task's own configuration identity. */
  readonly policyIdentity?: Readonly<{ policyId: string; policyVersion: string; configId: string; configVersion: string }> | undefined;
  readonly actionTtlMs?: number | undefined;
  readonly maxReadPathLength?: number | undefined;
  readonly maxQueryLength?: number | undefined;
  readonly maxFileBytes?: number | undefined;
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
 * Reads, validates, seeds once and binds. A refusal returns no ports; nothing before the seed writes.
 */
export async function bindRealTierTask(assembly: RealTierAssembly, options: RealTierBindingOptions): Promise<RealTierBinding> {
  const readText = options.readTextFile ?? ((path: string): string => readFileSync(path, 'utf8'));
  let catalogText: string;
  try {
    catalogText = readText(options.catalogPath);
  } catch {
    return refused('catalog-unreadable', '$.catalog');
  }
  const found = entryOf(catalogText, options.caseId);
  if ('status' in found) return found;
  const fixture = loadFixture(readText, found, options.catalogPath);
  if ('status' in fixture) return fixture;
  const { task, repositoryRoot } = fixture;

  // `validateTaskState` fixes `state.taskId` to the pinned task's own id (`TASK_CONTEXT_MISMATCH`),
  // so the allocator owns the run and workspace names; the task id is the fixture's identity.
  const allocate = options.ids ?? defaultIds;
  const ids: SeededTaskIds = { taskId: task.taskId, runId: allocate('run', options.caseId), workspaceId: allocate('workspace', options.caseId) };
  if (![ids.taskId, ids.runId, ids.workspaceId].every(id => SAFE_ID.test(id) && !id.includes('..'))) return refused('task-id-invalid', '$.ids');

  const owners = assembly.owners.taskOwners({ taskId: ids.taskId, workspaceId: ids.workspaceId, repositoryId: task.repositoryId });
  // An existing task is loaded and never re-seeded or overwritten (§(g)); it must be this task.
  const existing = await owners.statePort.loadTask(ids.taskId);
  if (existing === null) {
    try {
      await owners.statePort.transition(seedTaskState(task, ids), 0);
    } catch {
      return refused('seed-refused', '$.task');
    }
  } else if (existing.taskContext !== undefined && computeCanonicalSha256(existing.taskContext) !== computeCanonicalSha256(task)) {
    return refused('task-identity-mismatch', '$.task');
  }
  const seeded: TaskState | null = await owners.statePort.loadTask(ids.taskId);
  if (seeded === null) return refused('seed-missing', '$.task');

  const policy = policyOf(task, options);
  const filesystem: TrustedFilesystemPort = new WorkspaceFilesystemPort({ root: repositoryRoot });
  const expectedTestFiles = resolveExpectedTestFiles(task);
  // The digest names the authority ref UC-05 publishes; until then every read is refused by the fence,
  // which is the intended state rather than a permissive default.
  const policyDigest = stateReadPolicyDigest(ids.taskId, {
    ...policy,
    issuerKeyRef: `host-${task.configId}`,
    decisionAuthorityGeneration: 1,
  });
  const guardedRead = createGuardedReadCapability({
    capabilityId: `read-${ids.taskId}`,
    taskId: ids.taskId,
    workspaceId: ids.workspaceId,
    repositoryId: task.repositoryId,
    expectedRevisionDigest: task.initialRevisionDigest,
    policyDigest,
    bounds: { maxPathLength: options.maxReadPathLength ?? 512, maxQueryLength: options.maxQueryLength ?? 256 },
    provenance: 'real',
    owner: owners.readFence,
  });
  const hostAuthority = createTrustedHostSnapshot({
    filesystem,
    workspaceId: ids.workspaceId,
    repositoryId: task.repositoryId,
    acceptanceCriteria: task.acceptanceCriteria,
    requiredChecks: task.requiredChecks,
    expectedTestFiles,
    maxFileBytes: options.maxFileBytes ?? 1_048_576,
  });
  const contextSource = createHostActionContext({ filesystem, workspaceId: ids.workspaceId, repositoryId: task.repositoryId, policyIdentity: policy, ttlMs: options.actionTtlMs ?? 60_000 });
  const repositoryPort = createRepositoryReceiverV02({
    guardCapability: guardedRead,
    fsPort: filesystem,
    limits: { maxExcerptBytes: Math.min(task.limits.maxOutputBytes, 65_536), maxResultCount: 32 },
    expectedRevisionDigest: task.initialRevisionDigest,
    provenance: 'real',
    workspaceRoot: repositoryRoot,
    statePort: owners.statePort,
    commandExecutor: assembly.executor,
    workspaceManager: assembly.workspaceManager,
    trustedCommandResourcePolicy: { isolationProfileRef: assembly.profile.image.label, limits: task.limits },
    adapterIdentity: assembly.executor.getAdapterIdentity(),
    processIncarnation: assembly.executor.getProcessIncarnation(),
    fencingGeneration: assembly.executor.getFencingGeneration() || 1,
    unattemptedClaimClosureHandoff: createDurableUnattemptedClaimClosureHandoff(owners.statePort),
    attemptStartRecoveryHandoff: createDurableAttemptStartRecoveryHandoff(owners.statePort),
    patchRecoveryHandoff: createRefusingPatchRecoveryHandoff(),
  });
  const executionGuard = createExecutionGuardV02({ ports: { statePort: owners.statePort, repositoryPort }, config: { provenance: 'real' } });
  const configPort = { provenance: 'real' as const, loadConfig: () => ({ configId: task.configId, configVersion: task.configVersion }) };
  const trustedExpectedContext: TrustedHostExpectedContext = {
    taskId: ids.taskId,
    workspaceId: ids.workspaceId,
    repositoryId: task.repositoryId,
    revisionDigest: task.initialRevisionDigest,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    expectedTestFiles,
    executionGuard,
    statePort: owners.statePort,
  };
  const ports: UC03GraphPortsV02 = {
    ...assembly.components,
    statePort: owners.statePort,
    guardedRead,
    hostAuthority,
    contextSource,
    repositoryPort,
    executionGuard,
    configPort,
  };
  const config: UC03GraphConfigV02 = { trustedExpectedContext };

  // The unchanged bootstrap over the bound inputs and the host's own pins (§1 second stage).
  const readiness = prepareUC03Host({
    owner: hostDeliveries(assembly.owners.deliveries, assembly.components, { repositoryPort, executionGuard, configPort: configPort as UC03GraphPortsV02['configPort'] }, () => assembly.revision),
    producers: { guardedRead, hostAuthority, contextSource, baselineEvidence: assembly.components.baselineEvidence },
    config,
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
    ports,
    config,
    readiness,
  });
}
