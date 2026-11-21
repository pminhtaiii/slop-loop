/**
 * T061 — the unbound static producers and the retained-source diff wiring (host contract §1, §7).
 *
 * The unbound set is what lets `prepareUC03Host` be ready before a task exists: the full callable
 * surface and `provenance: 'real'`, with `TASK_UNBOUND` on every call. The diff source measures a
 * retained copy of the catalog's repository, taken once when a task is bound, so a later edit is
 * measurable against the initial bytes rather than against themselves.
 */
import { randomUUID } from 'node:crypto';
import { createRealTierAdmissions } from './real-tier-admissions.ts';
import { realTierPlanApproval } from './real-tier-plan-approval.ts';
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { computeFileDigest } from '../foundation/docker-workspace-policy.ts';
import { WorkspaceFilesystemPort } from '../foundation/host-filesystem-port.ts';
import type { TrustedFilesystemPort } from '../foundation/repository-types.ts';
import type { RepositoryBaselineManifestEntry, RepositoryBaselineSource, RepositoryDiffSourceOptions } from '../foundation/repository-diff-types.ts';
import { computeCanonicalSha256, computeCheckSetDigest, isProtectedPath } from '../contracts/foundation/uc03.ts';
import type { BugTask, PolicyAuthorityRefV02 } from '../contracts/foundation/uc03.ts';
import { createGuardedReadCapability } from '../foundation/guarded-read-capability.ts';
import { createExecutionGuardV02 } from '../foundation/execution-guard.ts';
import { createDurableAttemptStartRecoveryHandoff, createDurableUnattemptedClaimClosureHandoff, createRefusingPatchRecoveryHandoff } from '../foundation/durable-recovery-handoffs.ts';
import { createRepositoryReceiverV02 } from '../foundation/repository-tools.ts';
import { createTrustedHostSnapshot } from './trusted-host-snapshot.ts';
import type { TrustedHostExpectedContext } from '../uc03/investigation-types.ts';
import { resolveExpectedTestFiles } from '../uc03/graph-validation.ts';
import type { UC03GraphConfigV02, UC03GraphPortsV02 } from '../uc03/graph-types-v02.ts';
import type { UC03HostProducers } from './uc03-host-bootstrap.ts';
import { createRepositoryBaselineSource } from './repository-baseline-source.ts';
import type { RealTierAssembly } from './real-tier-assembly.ts';
import type { SeededTaskIds } from './real-tier-task-seed.ts';
import { mirrorRealTierWorkspace } from './real-tier-workspace.ts';
import { patchAdmission } from './real-tier-patch-admission.ts';
import { applyAdmittedPatch } from './real-tier-patch-receiver.ts';

/** The one refusal an unbound producer makes: named, bounded, and with no effect. */
export const TASK_UNBOUND = 'TASK_UNBOUND' as const;
const unbound = (): never => {
  throw new Error(TASK_UNBOUND);
};

/** The three host-built ports whose binding is per task; unbound they refuse, bound they act. */
export interface RealTierHostPorts {
  readonly repositoryPort: UC03GraphPortsV02['repositoryPort'];
  readonly executionGuard: UC03GraphPortsV02['executionGuard'];
  readonly configPort: UC03GraphPortsV02['configPort'];
}

/**
 * The four task-bound producers before a task exists. Each one has the complete callable surface and
 * `provenance: 'real'`, so the production port check admits them, and every call refuses.
 */
export function unboundProducers(): UC03HostProducers {
  return Object.freeze({
    guardedRead: Object.freeze({
      provenance: 'real' as const,
      capabilityId: 'unbound-read',
      taskId: '',
      workspaceId: '',
      mediateRead: async (): Promise<never> => unbound(),
    }),
    baselineEvidence: Object.freeze({ provenance: 'real' as const, persistBaselineEvidence: async (): Promise<never> => unbound(), loadBaselineEvidence: async (): Promise<never> => unbound() }),
    hostAuthority: Object.freeze({ loadSnapshot: async (): Promise<never> => unbound() }),
    contextSource: Object.freeze({ provenance: 'real' as const, observe: (): never => unbound() }),
  }) as unknown as UC03HostProducers;
}

/** The task-bound repository port before a task exists: every method of the v0.2 surface, refusing. */
function unboundRepositoryPort(): UC03GraphPortsV02['repositoryPort'] {
  return Object.freeze({
    provenance: 'real' as const,
    listDir: async (): Promise<never> => unbound(),
    readFile: async (): Promise<never> => unbound(),
    searchCode: async (): Promise<never> => unbound(),
    applyPatch: async (): Promise<never> => unbound(),
    runCommand: async (): Promise<never> => unbound(),
    runTests: async (): Promise<never> => unbound(),
    inspectDiff: async (): Promise<never> => unbound(),
  }) as unknown as UC03GraphPortsV02['repositoryPort'];
}

/** The v0.2 execution guard and config port, likewise refusing until a task is bound. */
export function unboundHostPorts(): RealTierHostPorts {
  return Object.freeze({
    repositoryPort: unboundRepositoryPort(),
    executionGuard: Object.freeze({
      provenance: 'real' as const,
      executionGuardApiVersion: '0.2.0' as const,
      validateAndExecute: async (): Promise<never> => unbound(),
    }) as unknown as UC03GraphPortsV02['executionGuard'],
    configPort: Object.freeze({ loadConfig: (): never => unbound() }),
  });
}

/** A context that names no task, so `trustedExpectedContext()` refuses it rather than guessing one. */
export const UNBOUND_CONFIG: UC03GraphConfigV02 = Object.freeze({
  trustedExpectedContext: Object.freeze({ taskId: '', workspaceId: '', repositoryId: '', revisionDigest: '', criteriaDigest: '', checkSetDigest: '', expectedTestFiles: Object.freeze([]) }),
});

/** The full admitted inventory of one tree, in the shape the retained baseline source accepts. */
async function measureManifest(port: TrustedFilesystemPort, maxFileBytes: number): Promise<readonly RepositoryBaselineManifestEntry[]> {
  const entries: RepositoryBaselineManifestEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await port.readDir(dir)) {
      const child = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (isProtectedPath(child)) continue;
      if (entry.isSymbolicLink) throw new Error('RETAINED_LINK: the retained tree must not contain symbolic links');
      if (entry.isDirectory) await walk(child);
      else if (entry.isFile) {
        const content = await port.readTextFile(child, maxFileBytes);
        entries.push({ path: child, digest: computeFileDigest(content), sizeBytes: Buffer.byteLength(content, 'utf8') });
      } else throw new Error('RETAINED_ENTRY: the retained tree must contain only files and directories');
    }
  };
  await walk('');
  return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export interface RetainedDiffSourceOptions {
  /** An immutable copy of the catalog's repository, outside writable task authority. */
  readonly retainedRoot: string;
  readonly repositoryRoot: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly baseRevision: string;
  readonly maxFileBytes: number;
  readonly maxDiffBytes: number;
}

export interface RetainedDiff {
  readonly source: RepositoryDiffSourceOptions;
  /** Captures the retained tree once (if absent) and measures its manifest. */
  prepare(): Promise<void>;
}

/**
 * The §7 diff source for one bound task. The retained tree is captured once, before any execution;
 * a bind that finds it already retained measures the retained bytes unchanged.
 * shortcut: retention is a full copy under the artifact root, taken at first bind; move it behind an
 * operator-prepared immutable root when a repository is too large to copy once per task.
 */
export function retainedDiffSource(options: RetainedDiffSourceOptions): RetainedDiff {
  const { retainedRoot, repositoryRoot } = options;
  let baseline: RepositoryBaselineSource | undefined;
  const unprepared = (): never => {
    throw new Error('RETAINED_BASELINE_UNPREPARED: prepare() must run before the diff source is used');
  };
  // A stable object with the full surface: the port asserts its shape at construction, while the
  // measurement behind it only exists once the retained tree has been captured.
  const source: RepositoryDiffSourceOptions = Object.freeze({
    baseline: Object.freeze({
      loadManifest: async (binding: never) => (baseline ?? unprepared()).loadManifest(binding),
      readBaselineFile: async (binding: never, path: string) => (baseline ?? unprepared()).readBaselineFile(binding, path),
    }),
    taskId: options.taskId,
    workspaceId: options.workspaceId,
    repositoryId: options.repositoryId,
    maxFileBytes: options.maxFileBytes,
    maxDiffBytes: options.maxDiffBytes,
  });
  const prepare = async (): Promise<void> => {
    // A first capture goes into a temporary sibling and is renamed into place, so a failure mid-copy
    // leaves no partial tree that a retry would then skip as already retained. An existing tree is the
    // immutable initial copy and is never re-captured over.
    const temp = existsSync(retainedRoot) ? undefined : `${retainedRoot}.tmp-${randomUUID()}`;
    try {
      if (temp !== undefined) cpSync(repositoryRoot, temp, { recursive: true });
      const filesystem = new WorkspaceFilesystemPort({ root: temp ?? retainedRoot });
      // §7 requires the exact immutable base: a retention mutated since the first bind is refused here,
      // before it can stand in for the task's initial revision.
      if ((await filesystem.getCurrentRevisionDigest(options.maxFileBytes)) !== options.baseRevision) {
        throw new Error('RETAINED_REVISION_MISMATCH: the retained tree is not the task initial revision');
      }
      const manifest = await measureManifest(filesystem, options.maxFileBytes);
      if (temp !== undefined) renameSync(temp, retainedRoot);
      baseline = createRepositoryBaselineSource({
        root: retainedRoot,
        taskId: options.taskId,
        workspaceId: options.workspaceId,
        repositoryId: options.repositoryId,
        baseRevision: options.baseRevision,
        manifest,
        maxFileBytes: options.maxFileBytes,
      });
    } catch (error) {
      // Only the temporary copy is discarded: an existing retained tree is never touched.
      if (temp !== undefined) rmSync(temp, { recursive: true, force: true });
      throw error;
    }
  };
  return { source, prepare };
}

export interface BoundCapabilities {
  readonly ports: UC03GraphPortsV02;
  readonly config: UC03GraphConfigV02;
  readonly hostPorts: { repositoryPort: UC03GraphPortsV02['repositoryPort']; executionGuard: UC03GraphPortsV02['executionGuard']; configPort: UC03GraphPortsV02['configPort'] };
  readonly guardedRead: UC03GraphPortsV02['guardedRead'];
  readonly hostAuthority: UC03GraphPortsV02['hostAuthority'];
  readonly contextSource: UC03GraphPortsV02['contextSource'];
  readonly diff: RetainedDiff;
}

/**
 * The four task-bound producers, the three host ports and the §7 diff source for one seeded task.
 * Throws on a bad input; the caller translates that to the bounded `binding-unavailable`.
 */
export async function buildBoundCapabilities(
  assembly: RealTierAssembly,
  task: BugTask,
  ids: SeededTaskIds,
  filesystem: WorkspaceFilesystemPort,
  owners: ReturnType<RealTierAssembly['owners']['taskOwners']>,
  contextSource: UC03GraphPortsV02['contextSource'],
  bounds: Readonly<{
    currentRevision: string;
    authorityRef: PolicyAuthorityRefV02;
    repositoryRoot: string;
    policyDigest: string;
    maxReadPathLength: number;
    maxQueryLength: number;
    maxFileBytes: number;
    retainedRoot: string;
  }>,
): Promise<BoundCapabilities> {
  const expectedTestFiles = resolveExpectedTestFiles(task);
  const guardedRead = createGuardedReadCapability({
    capabilityId: `read-${ids.taskId}`,
    taskId: ids.taskId,
    workspaceId: ids.workspaceId,
    repositoryId: task.repositoryId,
    expectedRevisionDigest: bounds.currentRevision,
    // A bound task owns and patches its own tree, so post-patch reads must follow the owner-observed
    // revision; the owner fence still matches the whole observation under the writers' lock.
    pinRevision: false,
    policyDigest: bounds.policyDigest,
    bounds: { maxPathLength: bounds.maxReadPathLength, maxQueryLength: bounds.maxQueryLength },
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
    maxFileBytes: bounds.maxFileBytes,
  });
  // §7's retained-source diff producer. `source` is a stable shape; `prepare()` captures the bytes.
  const diff = retainedDiffSource({
    retainedRoot: join(bounds.retainedRoot, 'repository', ids.taskId),
    repositoryRoot: bounds.repositoryRoot,
    taskId: ids.taskId,
    workspaceId: ids.workspaceId,
    repositoryId: task.repositoryId,
    baseRevision: task.initialRevisionDigest,
    maxFileBytes: bounds.maxFileBytes,
    maxDiffBytes: Math.min(task.limits.maxOutputBytes, 1_048_576),
  });
  const repositoryPort = createRepositoryReceiverV02({
    guardCapability: guardedRead,
    fsPort: filesystem,
    limits: { maxExcerptBytes: Math.min(task.limits.maxOutputBytes, 65_536), maxResultCount: 32 },
    expectedRevisionDigest: bounds.currentRevision,
    provenance: 'real',
    workspaceRoot: bounds.repositoryRoot,
    statePort: owners.statePort,
    taskControl: { getJournalSnapshot: () => owners.statePort.getJournalSnapshot(ids.taskId) },
    commandExecutor: assembly.executor,
    workspaceManager: assembly.workspaceManager,
    trustedCommandResourcePolicy: { isolationProfileRef: assembly.profile.image.label, limits: task.limits },
    adapterIdentity: assembly.executor.getAdapterIdentity(),
    processIncarnation: assembly.executor.getProcessIncarnation(),
    fencingGeneration: assembly.executor.getFencingGeneration() || 1,
    unattemptedClaimClosureHandoff: createDurableUnattemptedClaimClosureHandoff(owners.statePort),
    attemptStartRecoveryHandoff: createDurableAttemptStartRecoveryHandoff(owners.statePort),
    patchRecoveryHandoff: createRefusingPatchRecoveryHandoff(),
    patchReceiver: async admittedPatch => {
      const result = await applyAdmittedPatch(filesystem, admittedPatch, bounds.maxFileBytes);
      // The manager's canonical revision is what `repository-outcome.ts` re-checks; advance it here,
      // then the settled-patch hook re-copies the host tree into the volume under the writer lease.
      assembly.workspaceManager.setCanonicalRevision(ids.workspaceId, result.newRevisionDigest);
      return result;
    },
    onSettledPatch: revision => mirrorRealTierWorkspace(assembly, ids, filesystem, revision, bounds.maxFileBytes),
    repositoryDiff: diff.source,
  });
  const executionGuard = createExecutionGuardV02({ ports: { statePort: owners.statePort, repositoryPort }, config: { provenance: 'real' } });
  const configPort = { provenance: 'real' as const, loadConfig: () => ({ configId: task.configId, configVersion: task.configVersion }) };
  const admissions = createRealTierAdmissions(assembly, task, owners.statePort);
  // One resolver for every check admission: Investigate diagnostics take the pre-plan branch, while
  // the approved-plan Verify/Repair re-checks take the plan-bound branch. The node decides which.
  const admissionContextForCheck: NonNullable<TrustedHostExpectedContext['admissionContextForCheck']> = request =>
    request.currentState.node === 'Verify' || request.currentState.node === 'Repair' ? admissions.admissionContextForVerifyCheck(request) : admissions.admissionContextForCheck(request);
  const trustedExpectedContext: TrustedHostExpectedContext = {
    admissionContextForCheck,
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
    approvalPort: realTierPlanApproval(owners),
    statePort: owners.statePort,
    guardedRead,
    hostAuthority,
    contextSource,
    repositoryPort,
    executionGuard,
    configPort,
  };
  return {
    ports,
    config: {
      trustedExpectedContext,
      coderAdmission: admissions.coderAdmission,
      admissionContext: request => patchAdmission(assembly, task, owners.statePort, request),
    },
    hostPorts: { repositoryPort, executionGuard, configPort: configPort as UC03GraphPortsV02['configPort'] },
    guardedRead,
    hostAuthority,
    contextSource,
    diff,
  };
}
