/** Bind/resume the real tier's canonical volume and mirror settled host patches under its writer lease. */
import { isCanonicalRelativePath, isProtectedPath } from '../contracts/foundation/uc03.ts';
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

/** Never traverse links or protected directories, and bound both individual reads and the total payload. */
async function exposedFiles(filesystem: WorkspaceFilesystemPort, maxFileBytes: number, control: QuestionRepositoryOperationControl): Promise<Readonly<Record<string, Uint8Array>>> {
  const files: Record<string, Uint8Array> = {};
  let byteCount = 0;
  let entries = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await filesystem.readDirBounded(dir, MAX_ENTRIES - entries, control)) {
      if (++entries > MAX_ENTRIES) throw new Error('MIRROR_SCAN_TOO_LARGE');
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (!isCanonicalRelativePath(path) || isProtectedPath(path) || entry.isSymbolicLink) continue;
      if ((await filesystem.realpath(path, control)) !== path) throw new Error('MIRROR_PATH_CHANGED');
      if (entry.isDirectory) await walk(path);
      else if (entry.isFile) {
        const bytes = await filesystem.readBytes(path, Math.min(maxFileBytes, MAX_BYTES - byteCount), control);
        byteCount += bytes.byteLength + Buffer.byteLength(path);
        if (byteCount > MAX_BYTES) throw new Error('MIRROR_PAYLOAD_TOO_LARGE');
        if (!containsProtectedContent(bytes.toString('utf8'))) files[path] = bytes;
      }
    }
  };
  await walk('');
  return files;
}

/** A measured mismatch never advances the manager. The caller retains the patch writer lease on failure. */
export async function mirrorRealTierWorkspace(assembly: RealTierAssembly, ids: SeededTaskIds, filesystem: WorkspaceFilesystemPort, revision: string, maxFileBytes: number): Promise<void> {
  const workspace = assembly.workspaceManager.getWorkspace(ids.workspaceId);
  if (!workspace || workspace.taskId !== ids.taskId) throw new Error('MIRROR_WORKSPACE_MISSING');
  const control = controlOf(assembly);
  const files = await exposedFiles(filesystem, maxFileBytes, control);
  const measured = await assembly.controller.mirrorRepository(workspace.repoVolumeId, files);
  if (measured !== revision || (await hostRevision(filesystem, control)) !== revision) throw new Error('MIRROR_REVISION_MISMATCH');
  assembly.workspaceManager.setCanonicalRevision(ids.workspaceId, revision);
}

/** Rebinds resume without filling twice; failed initial fills release their entire allocation. */
export async function bindRealTierWorkspace(assembly: RealTierAssembly, ids: SeededTaskIds, filesystem: WorkspaceFilesystemPort, revision: string, maxFileBytes: number): Promise<void> {
  const profile = dockerProfileOf(assembly.profile);
  if ('status' in profile) throw new Error('MIRROR_PROFILE_INVALID');
  const existing = assembly.workspaceManager.getWorkspace(ids.workspaceId);
  if (existing) {
    await assembly.workspaceManager.resumeWorkspace({ workspace: existing, profile, expectedRevisionDigest: revision });
    if ((await hostRevision(filesystem, controlOf(assembly))) !== revision) throw new Error('MIRROR_REVISION_MISMATCH');
    return;
  }
  try {
    await assembly.workspaceManager.createWorkspace({ ...ids, profile, initialRevisionDigest: revision });
    await mirrorRealTierWorkspace(assembly, ids, filesystem, revision, maxFileBytes);
  } catch (error) {
    await assembly.workspaceManager.releaseWorkspace(ids.taskId, ids.workspaceId);
    throw error;
  }
}
