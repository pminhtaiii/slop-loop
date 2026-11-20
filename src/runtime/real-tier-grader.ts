/**
 * Host-owned isolation authority and production final-tree port for real final-snapshot grading
 * (real-tier contract §(f) T062; UC-03 T028).
 *
 * The authority fails closed: it admits a hidden check only after a per-case bind has pinned the
 * grading profile, and only for the exact snapshot the final-tree port froze for that task, the pinned
 * profile and bounds, and the executor identity. Provenance is registered in the module-private
 * registry in `eval/uc03/grading.ts`. A new bind invalidates every earlier admission.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type {
  EvaluationGraderExecutor,
  EvaluationGradingAdmission,
  EvaluationGradingAdmissionRequest,
  EvaluationGradingProfile,
  EvaluationIsolationAuthority,
  EvaluationSnapshotIdentity,
} from '../../eval/uc03/types.ts';
import { registerHostAdmission } from '../../eval/uc03/grading.ts';
import { FINAL_TREE_MAX_FILES, FINAL_TREE_MAX_TOTAL_BYTES, parseWorkflowFinalTree, type FinalTreeBinding, type TrustedFinalTreeSnapshotPort } from '../../eval/uc03/workflow-evidence-facts.ts';
import { createDockerGraderExecutor, type DockerGraderExecutorInstance, type GraderCaseHost } from '../foundation/docker-grader-executor.ts';
import type { StructuredSpawn } from '../foundation/docker-controller.ts';

const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BOUND_KEYS = ['timeoutMs', 'maxCpuMs', 'maxOutputBytes', 'maxMemoryBytes', 'maxProcesses'] as const;

/** What the entry binds per case: the task, the live root, the pinned profile and the pinned image. */
export interface GraderCasePins {
  readonly taskId: string;
  readonly repositoryRoot: string;
  readonly profile: unknown;
  readonly image: { readonly imageId: string; readonly platform: string; readonly user: string };
}

interface AuthorityPins {
  readonly profile: unknown;
  readonly finalSnapshot: () => EvaluationSnapshotIdentity | undefined;
}

export interface HostIsolationAuthorityInstance extends EvaluationIsolationAuthority {
  readonly currentAdmission: EvaluationGradingAdmission | null;
  isCurrentAdmission(admission: unknown): boolean;
  /** Pins a new case; every earlier admission becomes stale. */
  bind(pins: AuthorityPins): void;
  admit(request: EvaluationGradingAdmissionRequest): EvaluationGradingAdmission | undefined;
}

function profileOf(value: unknown): EvaluationGradingProfile | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { profileId, digest, bounds } = value as Record<string, unknown>;
  if (typeof profileId !== 'string' || typeof digest !== 'string' || typeof bounds !== 'object' || bounds === null) return undefined;
  const limits = bounds as Record<string, unknown>;
  return BOUND_KEYS.every(key => typeof limits[key] === 'number') ? (value as EvaluationGradingProfile) : undefined;
}

function sameProfile(left: EvaluationGradingProfile, right: EvaluationGradingProfile): boolean {
  return left.profileId === right.profileId && left.digest === right.digest && BOUND_KEYS.every(key => left.bounds[key] === right.bounds[key]);
}

/** Creates the host-owned authority. Real grading requires the registered executor instance; an ID alone cannot confer host provenance. */
export function createHostIsolationAuthority(options: { readonly executorId: string; readonly executor?: () => EvaluationGraderExecutor | undefined }): HostIsolationAuthorityInstance {
  let currentAdmission: EvaluationGradingAdmission | null = null;
  let pinned: { readonly profile: EvaluationGradingProfile; readonly finalSnapshot: AuthorityPins['finalSnapshot'] } | undefined;

  const authority = {
    admit(request: EvaluationGradingAdmissionRequest): EvaluationGradingAdmission | undefined {
      if (pinned === undefined || !request || typeof request !== 'object') return undefined;
      if (typeof request.checkId !== 'string' || !CHECK_ID.test(request.checkId)) return undefined;
      const expected = pinned.finalSnapshot();
      if (expected === undefined || !request.finalSnapshot) return undefined;
      if (request.finalSnapshot.snapshotId !== expected.snapshotId || request.finalSnapshot.digest !== expected.digest) return undefined;
      const profile = profileOf(request.profile);
      if (profile === undefined || !sameProfile(profile, pinned.profile)) return undefined;
      if (request.executorId !== options.executorId) return undefined;

      const admission: EvaluationGradingAdmission = Object.freeze({
        ...request,
        kind: 'host-isolation-admission' as const,
        admissionId: `adm-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      });
      registerHostAdmission(authority, admission, options.executor?.());
      currentAdmission = admission;
      return admission;
    },
  };

  Object.defineProperties(authority, {
    currentAdmission: { get: () => currentAdmission, enumerable: false },
    isCurrentAdmission: { value: (admission: unknown): boolean => currentAdmission !== null && currentAdmission === admission, enumerable: false },
    bind: {
      value(pins: AuthorityPins): void {
        currentAdmission = null;
        const profile = profileOf(pins.profile);
        pinned = profile === undefined ? undefined : { profile, finalSnapshot: pins.finalSnapshot };
      },
      enumerable: false,
    },
  });

  return authority as HostIsolationAuthorityInstance;
}

interface TreeFile {
  readonly path: string;
  readonly content: Buffer;
}

/** Dirent-compatible interface for directory traversal. */
export interface TreeDirent {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export type TreeEntryReader = (directory: string) => readonly TreeDirent[];

/** Walks without following links: fail closed if a symlink, non-file/non-directory entry, or (POSIX) executable regular file is found. `.git` is skipped. */
function walkTree(rootDir: string, readEntries: TreeEntryReader = (dir: string) => readdirSync(dir, { withFileTypes: true })): readonly TreeFile[] | undefined {
  const files: TreeFile[] = [];
  let totalBytes = 0;
  function walk(currentDir: string): boolean {
    for (const entry of readEntries(currentDir)) {
      if (entry.name === '.git') continue;
      const fullPath = join(currentDir, entry.name);
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        const stat = lstatSync(fullPath, { throwIfNoEntry: false });
        if (!stat?.isDirectory() || !walk(fullPath)) return false;
      } else if (entry.isFile()) {
        if (files.length >= FINAL_TREE_MAX_FILES) return false;
        let fd: number;
        try {
          fd = openSync(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        } catch (error) {
          if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))) return false;
          throw error;
        }
        try {
          const stat = fstatSync(fd);
          const remaining = FINAL_TREE_MAX_TOTAL_BYTES - totalBytes;
          if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o111) !== 0) || stat.size > remaining) return false;
          const chunks: Buffer[] = [];
          let length = 0;
          // Probe one byte beyond the remaining budget, including when a file grows after fstat.
          while (true) {
            const chunk = Buffer.alloc(Math.min(64 * 1024, remaining - length + 1));
            const count = readSync(fd, chunk, 0, chunk.length, null);
            if (count === 0) break;
            length += count;
            if (length > remaining) return false;
            chunks.push(chunk.subarray(0, count));
          }
          totalBytes += length;
          files.push({ path: relative(rootDir, fullPath).split(sep).join('/'), content: Buffer.concat(chunks, length) });
        } finally {
          closeSync(fd);
        }
      } else {
        return false;
      }
    }
    return true;
  }
  if (!walk(rootDir)) return undefined;
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function treeOf(binding: FinalTreeBinding, files: readonly TreeFile[]) {
  return {
    ...binding,
    snapshotId: `snapshot-${
      binding.finalRevisionDigest
        .replace(/^sha256:/u, '')
        .replace(/[^A-Za-z0-9]/gu, '')
        .slice(0, 16) || 'tree'
    }`,
    complete: true as const,
    files: Object.freeze(files),
  };
}

interface BoundCase {
  readonly pins: GraderCasePins;
  frozen?: { readonly binding: FinalTreeBinding; readonly files: readonly TreeFile[]; readonly snapshot: EvaluationSnapshotIdentity };
}

/** The tree for `binding` if its task is the bound one and the root exists; otherwise nothing. */
function walkBound(
  bound: BoundCase | undefined,
  binding: FinalTreeBinding,
  readEntries?: TreeEntryReader,
): { readonly files: readonly TreeFile[]; readonly tree: ReturnType<typeof treeOf> } | undefined {
  if (bound === undefined || bound.pins.taskId !== binding.taskId) return undefined;
  const stat = lstatSync(bound.pins.repositoryRoot, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) return undefined;
  const files = walkTree(bound.pins.repositoryRoot, readEntries);
  if (files === undefined) return undefined;
  return { files, tree: treeOf(binding, files) };
}

export interface RealTierGraderCapability {
  readonly tier: 'real-tier';
  readonly isolationAuthority: HostIsolationAuthorityInstance;
  readonly executor: DockerGraderExecutorInstance;
  readonly finalTree: TrustedFinalTreeSnapshotPort;
  bindCase(pins: GraderCasePins): void;
}

export interface RealTierGraderOptions {
  readonly executorId?: string | undefined;
  readonly spawn?: StructuredSpawn | undefined;
  readonly readEntries?: TreeEntryReader | undefined;
  /** Host uid lookup; a test seam, defaulting to the process uid (POSIX) or none (Windows). */
  readonly getuid?: (() => number | undefined) | undefined;
}

/**
 * Creates the real-tier capability: host authority, docker executor and the production final-tree port.
 * Nothing is pinned until `bindCase`; an unbound task or a missing root freezes to nothing (not-run).
 */
export function createRealTierGraderCapability(options: RealTierGraderOptions = {}): RealTierGraderCapability {
  const executorId = options.executorId ?? 'docker-grader-executor';
  const authority = createHostIsolationAuthority({ executorId, executor: () => executor });
  let bound: BoundCase | undefined;

  const finalTree: TrustedFinalTreeSnapshotPort = {
    freezeFinalTree(binding: FinalTreeBinding) {
      const walked = walkBound(bound, binding, options.readEntries);
      const parsed = walked === undefined ? undefined : parseWorkflowFinalTree(walked.tree, binding);
      if (bound === undefined || walked === undefined || parsed === undefined) return undefined;
      bound.frozen = { binding, files: walked.files, snapshot: parsed.snapshot };
      return walked.tree;
    },
    // The grader compares the rechecked identity with the expected one, so a drifted tree is returned as-is.
    recheckCurrentFinalTree(binding: FinalTreeBinding) {
      try {
        return walkBound(bound, binding, options.readEntries)?.tree;
      } catch (error) {
        if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'EIO', 'ESTALE'].includes(String(error.code))) return undefined;
        throw error;
      }
    },
  };

  const host: GraderCaseHost = {
    frozen: () => bound?.frozen,
    measure(directory) {
      const frozen = bound?.frozen;
      if (frozen === undefined) return undefined;
      const files = walkTree(directory, options.readEntries);
      return files === undefined ? undefined : parseWorkflowFinalTree(treeOf(frozen.binding, files), frozen.binding)?.snapshot.digest;
    },
    measureLive() {
      const frozen = bound?.frozen;
      const walked = frozen === undefined ? undefined : walkBound(bound, frozen.binding, options.readEntries);
      return frozen === undefined || walked === undefined ? undefined : parseWorkflowFinalTree(walked.tree, frozen.binding)?.snapshot.digest;
    },
    image: () => bound?.pins.image,
  };

  const executor = createDockerGraderExecutor({ executorId, spawn: options.spawn, authority, host, getuid: options.getuid });
  return {
    tier: 'real-tier',
    isolationAuthority: authority,
    executor,
    finalTree,
    bindCase(pins: GraderCasePins): void {
      const current: BoundCase = { pins };
      bound = current;
      authority.bind({ profile: pins.profile, finalSnapshot: () => (bound === current ? current.frozen?.snapshot : undefined) });
    },
  };
}
