/** Bind/resume the real tier's canonical volume and mirror settled host patches under its writer lease. */
import { computeCanonicalSha256, isProtectedPath } from '../contracts/foundation/uc03.ts';
import { containsProtectedContent } from '../foundation/docker-workspace-policy.ts';
import type { WorkspaceFilesystemPort } from '../foundation/host-filesystem-port.ts';
import { dockerProfileOf, type RealTierAssembly } from './real-tier-assembly.ts';
import type { SeededTaskIds } from './real-tier-task-seed.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';

const MAX_ENTRIES = 100_000;
const MAX_BYTES = 4 * 1024 * 1024;

function controlOf(assembly: RealTierAssembly): QuestionRepositoryOperationControl {
  return { signal: new AbortController().signal, deadlineEpochMs: Date.now() + assembly.profile.limits.commandTimeoutMs };
}

function hostRevision(filesystem: WorkspaceFilesystemPort, control: QuestionRepositoryOperationControl): Promise<string> {
  return filesystem.getCurrentRevisionDigestBounded({ maxEntries: MAX_ENTRIES, maxFiles: MAX_ENTRIES, maxBytes: 2 * MAX_BYTES }, control);
}

function protectedEntry(path: string): boolean {
  let prefix = '';
  return path.split('/').some(segment => {
    prefix = prefix ? `${prefix}/${segment}` : segment;
    return isProtectedPath(prefix);
  });
}

/** A measured mismatch never advances the manager. The caller retains the patch writer lease on failure. */
export async function mirrorRealTierWorkspace(assembly: RealTierAssembly, ids: SeededTaskIds, filesystem: WorkspaceFilesystemPort, revision: string, maxFileBytes: number): Promise<void> {
  const workspace = assembly.workspaceManager.getWorkspace(ids.workspaceId);
  if (!workspace || workspace.taskId !== ids.taskId) throw new Error('MIRROR_WORKSPACE_MISSING');
  const control = controlOf(assembly);
  // Pin the full host tree and derive the permitted inventory from the very same reads.
  const files: Record<string, Uint8Array> = Object.create(null);
  const permitted: string[] = [];
  let total = 0;
  const host = await filesystem.getCurrentRevisionDigestBounded({ maxEntries: MAX_ENTRIES, maxFiles: MAX_ENTRIES, maxBytes: 2 * MAX_BYTES }, control, (path, bytes, digest) => {
    if (protectedEntry(path)) return;
    total += Buffer.byteLength(path) + bytes.byteLength;
    if (bytes.byteLength > maxFileBytes || total > MAX_BYTES) throw new Error('MIRROR_PAYLOAD_TOO_LARGE');
    if (containsProtectedContent(bytes.toString('utf8'))) return;
    files[path] = bytes;
    permitted.push(`${path}\0${digest}\n`);
  });
  if (host !== revision) throw new Error('MIRROR_REVISION_MISMATCH');
  const measured = await assembly.controller.mirrorRepository(workspace.repoVolumeId, files);
  if (measured !== computeCanonicalSha256(permitted.sort().join('')) || (await hostRevision(filesystem, control)) !== revision) throw new Error('MIRROR_REVISION_MISMATCH');
  assembly.workspaceManager.setCanonicalRevision(ids.workspaceId, revision);
}

const initializing = new WeakMap<RealTierAssembly['workspaceManager'], Map<string, Promise<void>>>();

/** Rebinds resume without filling twice; failed initial fills release their entire allocation. */
export async function bindRealTierWorkspace(assembly: RealTierAssembly, ids: SeededTaskIds, filesystem: WorkspaceFilesystemPort, revision: string, maxFileBytes: number): Promise<void> {
  const profile = dockerProfileOf(assembly.profile);
  if ('status' in profile) throw new Error('MIRROR_PROFILE_INVALID');
  const manager = assembly.workspaceManager;
  const fills = initializing.get(manager) ?? new Map<string, Promise<void>>();
  initializing.set(manager, fills);
  const pending = fills.get(ids.workspaceId);
  if (pending) await pending;
  const existing = assembly.workspaceManager.getWorkspace(ids.workspaceId);
  if (existing) {
    if (existing.taskId !== ids.taskId) throw new Error('MIRROR_WORKSPACE_MISMATCH');
    await assembly.workspaceManager.resumeWorkspace({ workspace: existing, profile, expectedRevisionDigest: revision });
    if ((await hostRevision(filesystem, controlOf(assembly))) !== revision) throw new Error('MIRROR_REVISION_MISMATCH');
    return;
  }
  const initialize = async (): Promise<void> => {
    try {
      await assembly.workspaceManager.createWorkspace({ ...ids, profile, initialRevisionDigest: revision });
      await mirrorRealTierWorkspace(assembly, ids, filesystem, revision, maxFileBytes);
    } catch (error) {
      await assembly.workspaceManager.releaseWorkspace(ids.taskId, ids.workspaceId);
      throw error;
    }
  };
  const fill = initialize();
  fills.set(ids.workspaceId, fill);
  try {
    await fill;
  } finally {
    fills.delete(ids.workspaceId);
  }
}
