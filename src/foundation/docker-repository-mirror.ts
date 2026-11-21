/** Bounded canonical-volume writes through the controller's pinned helper runner. */
import { computeCanonicalSha256, isCanonicalRelativePath, isProtectedPath } from '../contracts/foundation/uc03.ts';
import type { StructuredSpawn, StructuredSpawnOptions, StructuredSpawnResult } from './docker-controller.ts';
import type { RunArgumentSpec } from './docker-controller-argv.ts';
import { computeFileDigest, containsProtectedContent, DEFAULT_MAX_OUTPUT_BYTES } from './docker-workspace-policy.ts';
import type { DockerProfile } from './docker-workspace-types.ts';

const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MIRROR_SCRIPT = [
  'import base64,json,os,sys,hashlib',
  "root='/workspace/repo'",
  'payload=json.load(sys.stdin)',
  "wanted={item['path']:base64.b64decode(item['b64'],validate=True) for item in payload['files']}",
  'for path in wanted:',
  "  if path.startswith('/') or any(p in ('','..','.') for p in path.split('/')):",
  '    raise SystemExit(2)',
  'for base,dirs,files in os.walk(root):',
  '  for name in dirs+files:',
  '    if os.path.islink(os.path.join(base,name)):',
  '      raise SystemExit(2)',
  'for base,dirs,files in os.walk(root,topdown=False):',
  '  for name in files:',
  '    full=os.path.join(base,name)',
  "    if os.path.relpath(full,root).replace(os.sep,'/') not in wanted:",
  '      os.unlink(full)',
  '  for name in dirs:',
  '    full=os.path.join(base,name)',
  '    if not os.listdir(full):',
  '      os.rmdir(full)',
  'for path,content in wanted.items():',
  '  full=os.path.join(root,path)',
  '  os.makedirs(os.path.dirname(full),exist_ok=True)',
  "  if not os.path.isfile(full) or open(full,'rb').read()!=content:",
  "    with open(full,'wb') as handle:",
  '      handle.write(content)',
  'entries=[]',
  'for base,dirs,files in os.walk(root):',
  '  for name in files:',
  '    full=os.path.join(base,name)',
  "    path=os.path.relpath(full,root).replace(os.sep,'/')",
  "    entries.append({'path':path,'digest':'sha256:'+hashlib.sha256(open(full,'rb').read()).hexdigest()})",
  "print(json.dumps({'entries':entries}))",
].join('\n');

export type RepositoryHelperRunner = (spec: Omit<RunArgumentSpec, 'name'>, options: StructuredSpawnOptions) => Promise<StructuredSpawnResult>;

/** Only a completed removal or an explicit daemon response for this exact name proves absence. */
export function confirmedContainerRemoval(result: StructuredSpawnResult, name: string): boolean {
  if (result.timedOut || result.exitCode === null) return false;
  return result.exitCode === 0 || (result.truncated !== true && result.stderr.trim() === `Error response from daemon: No such container: ${name}`);
}

/** Force-removal also stops a helper whose Docker client timed out before setup is rolled back. */
export async function runRepositoryHelper(spawn: StructuredSpawn, args: readonly string[], options: StructuredSpawnOptions, onTerminated: () => void): Promise<StructuredSpawnResult> {
  const name = args.find(arg => arg.startsWith('--name='))?.slice(7);
  if (!name) throw new Error('MIRROR_HELPER_NAME_REQUIRED');
  const remove = async (): Promise<void> => {
    const removed = await spawn('docker', ['rm', '-f', name], { timeoutMs: 30_000, maxOutputBytes: 4096 });
    if (!confirmedContainerRemoval(removed, name)) throw new Error('MIRROR_HELPER_CLEANUP_FAILED');
  };
  let result: StructuredSpawnResult;
  try {
    result = await spawn('docker', args, options);
  } catch (error) {
    await remove();
    onTerminated();
    throw error;
  }
  // Completed helpers remove themselves through --rm; an indeterminate client needs force-removal.
  if (result.timedOut || result.exitCode === null || [125, 126, 127].includes(result.exitCode)) await remove();
  onTerminated();
  return result;
}

/** Writes only safe bytes, removes stale paths, and measures the resulting volume independently. */
export async function mirrorRepositoryVolume(volumeId: string, files: Readonly<Record<string, Uint8Array>>, profile: DockerProfile, run: RepositoryHelperRunner): Promise<string> {
  const payload = Object.entries(files).map(([path, bytes]) => {
    if (!isCanonicalRelativePath(path) || isProtectedPath(path) || containsProtectedContent(Buffer.from(bytes).toString('utf8'))) throw new Error('UNSAFE_MIRROR_FILE');
    return { path, b64: Buffer.from(bytes).toString('base64') };
  });
  const stdin = JSON.stringify({ files: payload });
  if (Buffer.byteLength(stdin) > MAX_PAYLOAD_BYTES) throw new Error('MIRROR_PAYLOAD_TOO_LARGE');
  const limits = profile.limits;
  const result = await run(
    {
      user: profile.user,
      memoryBytes: limits.maxMemoryBytes,
      cpus: limits.maxCpuCores,
      pids: limits.maxPids,
      mounts: [{ source: volumeId, target: '/workspace/repo', readOnly: false }],
      stdin: true,
      tail: ['python3', '-c', MIRROR_SCRIPT],
    },
    { timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, stdin },
  );
  if (result.timedOut || result.truncated === true || result.exitCode !== 0) throw new Error('MIRROR_HELPER_FAILED');
  const parsed: unknown = JSON.parse(result.stdout);
  if (!parsed || typeof parsed !== 'object' || !('entries' in parsed) || !Array.isArray(parsed.entries)) throw new Error('MIRROR_MEASUREMENT_INVALID');
  const observed = new Map<string, string>();
  for (const entry of parsed.entries as readonly unknown[]) {
    if (!entry || typeof entry !== 'object' || !('path' in entry) || !('digest' in entry) || typeof entry.path !== 'string' || typeof entry.digest !== 'string')
      throw new Error('MIRROR_MEASUREMENT_INVALID');
    if (!Object.hasOwn(files, entry.path)) throw new Error('MIRROR_MEASUREMENT_MISMATCH');
    const bytes = files[entry.path];
    if (bytes === undefined || observed.has(entry.path) || computeFileDigest(bytes) !== entry.digest) throw new Error('MIRROR_MEASUREMENT_MISMATCH');
    observed.set(entry.path, entry.digest);
  }
  if (observed.size !== payload.length) throw new Error('MIRROR_MEASUREMENT_MISMATCH');
  return computeCanonicalSha256(
    [...observed]
      .map(([path, digest]) => `${path}\0${digest}\n`)
      .sort()
      .join(''),
  );
}
