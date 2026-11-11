import { randomUUID } from 'node:crypto';
import { isCanonicalRelativePath, isProtectedPath } from '../contracts/foundation/uc03.ts';
import type { ExecutionLimits } from '../contracts/foundation/uc03.ts';
import { computeFileDigest, DEFAULT_MAX_OUTPUT_BYTES, SHA256_HEX_REGEX, truncateUtf8, validateDockerProfile } from './docker-workspace-policy.ts';
import { assertPlan, assertVolumeName, runArguments, type RunArgumentSpec } from './docker-controller-argv.ts';
import type {
  CanonicalRepositorySnapshot,
  CanonicalSnapshotEntry,
  ContainerExecutionOutput,
  DockerContainerPlan,
  DockerLifecycleController as DockerLifecycleControllerPort,
  DockerProfile,
  MaterializeViewParams,
} from './docker-workspace-types.ts';

/** Structured process spawn: argv array plus options, never a shell string. */
export interface StructuredSpawnOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly stdin?: string | undefined;
}

export interface StructuredSpawnResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** True when the captured output hit maxOutputBytes. */
  readonly truncated?: boolean | undefined;
}

export type StructuredSpawn = (command: string, args: readonly string[], options: StructuredSpawnOptions) => Promise<StructuredSpawnResult>;

export interface DockerControllerOptions {
  readonly profile: DockerProfile;
  readonly platform: string;
  readonly spawn: StructuredSpawn;
  /**
   * Trusted host binding from workspace to its canonical repository volume and revision digest.
   * The lifecycle port keys snapshots by workspaceId only, so this association cannot be derived here.
   */
  readonly resolveWorkspace: (workspaceId: string) => { readonly repoVolumeId: string; readonly canonicalRevisionDigest: string } | undefined;
}

const PLATFORM_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/;
const VOLUME_OP_OPTIONS: StructuredSpawnOptions = Object.freeze({ timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
// shortcut: 8 MiB view payload ceiling, raise when a pinned case repository legitimately exceeds it.
const MAX_VIEW_PAYLOAD_BYTES = 8 * 1024 * 1024;

// Runs inside the pinned image; prints one JSON record per regular file with base64 bytes.
// shortcut: symlink entries omitted (the view builder binds a link's digest to its target's content), add when a pinned case repo contains symlinks.
const SNAPSHOT_SCRIPT = [
  'import base64,json,os',
  "root='/workspace/repo'",
  'entries=[]',
  'for base,dirs,files in os.walk(root):',
  '  dirs.sort()',
  '  for name in sorted(files):',
  '    full=os.path.join(base,name)',
  '    if os.path.islink(full):',
  '      continue',
  "    rel=os.path.relpath(full,root).replace(os.sep,'/')",
  "    with open(full,'rb') as handle:",
  "      entries.append({'path':rel,'content':base64.b64encode(handle.read()).decode('ascii')})",
  "print(json.dumps({'entries':entries}))",
].join('\n');

// Writes trusted host bytes into the admitted view volume only; execution later mounts it read-only.
const WRITE_SCRIPT = [
  'import base64,json,os,sys',
  "root='/workspace/repo'",
  'payload=json.load(sys.stdin)',
  "for item in payload['files']:",
  "  path=item['path']",
  "  if path.startswith('/') or '..' in path.split('/'):",
  '    raise SystemExit(2)',
  '  full=os.path.join(root,path)',
  '  parent=os.path.dirname(full)',
  '  if parent:',
  '    os.makedirs(parent,exist_ok=True)',
  "  with open(full,'wb') as handle:",
  "    handle.write(base64.b64decode(item['b64']))",
  "print(json.dumps({'written':len(payload['files'])}))",
].join('\n');

interface ContainerRecord {
  readonly name: string;
  readonly kind: 'execution' | 'helper';
  /** Unknown effects (timeout / no exit code): preserved for reconciliation instead of deleted. */
  uncertain: boolean;
}

function failureDetail(stderr: string): string {
  return truncateUtf8(stderr, 2048).text;
}

function parseSnapshotEntries(stdout: string): readonly CanonicalSnapshotEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Translation only: volume output is untrusted, so a parse failure must surface as a refusal.
    throw new Error(`INVALID_SNAPSHOT_OUTPUT: volume snapshot is not valid JSON: ${truncateUtf8(stdout, 256).text}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>)['entries'])) {
    throw new Error('INVALID_SNAPSHOT_OUTPUT: expected { entries: [...] }');
  }
  const entries: CanonicalSnapshotEntry[] = [];
  for (const item of (parsed as { entries: readonly unknown[] }).entries) {
    if (typeof item !== 'object' || item === null) throw new Error('INVALID_SNAPSHOT_OUTPUT: entry must be an object');
    const record = item as Record<string, unknown>;
    const filePath = record['path'];
    const content = record['content'];
    if (typeof filePath !== 'string' || !isCanonicalRelativePath(filePath)) {
      throw new Error(`INVALID_SNAPSHOT_OUTPUT: path '${String(filePath)}' is not a canonical relative path`);
    }
    if (typeof content !== 'string') throw new Error(`INVALID_SNAPSHOT_OUTPUT: entry '${filePath}' is missing base64 content`);
    const bytes = Buffer.from(content, 'base64');
    entries.push({ path: filePath, kind: 'regular', content: bytes, digest: computeFileDigest(bytes) });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export class DockerLifecycleController implements DockerLifecycleControllerPort {
  readonly provenance = 'real' as const;

  private readonly trustedProfile: DockerProfile;
  private readonly platform: string;
  private readonly spawnProcess: StructuredSpawn;
  private readonly resolveWorkspaceBinding: DockerControllerOptions['resolveWorkspace'];
  private readonly createdVolumes = new Set<string>();
  private readonly volumeOwners = new Map<string, string>();
  private readonly uncertainWorkspaces = new Set<string>();
  private readonly containers: ContainerRecord[] = [];
  private readonly supersededVolumes = new Set<string>();
  private readonly currentViewVolume = new Map<string, string>();
  private unattributedUncertainty = false;

  constructor(options: DockerControllerOptions) {
    if (!options || typeof options !== 'object') throw new Error('INVALID_CONTROLLER_OPTIONS: options must be an object');
    if (typeof options.spawn !== 'function') throw new Error('SPAWN_REQUIRED: an injected structured process spawn is required');
    if (typeof options.resolveWorkspace !== 'function') throw new Error('WORKSPACE_RESOLVER_REQUIRED: an injected workspace volume/revision resolver is required');
    if (typeof options.platform !== 'string' || !PLATFORM_RE.test(options.platform.trim())) {
      throw new Error(`INVALID_PLATFORM: '${String(options.platform)}' is not a pinned engine platform such as linux/amd64`);
    }
    const profileRes = validateDockerProfile(options.profile);
    if (!profileRes.ok) throw new Error(`INVALID_DOCKER_PROFILE: ${profileRes.errors.map(e => e.message).join('; ')}`);
    this.trustedProfile = Object.freeze(profileRes.value);
    this.platform = options.platform.trim();
    this.spawnProcess = options.spawn;
    this.resolveWorkspaceBinding = options.resolveWorkspace;
  }

  get platformPin(): string {
    return this.platform;
  }

  /** Workspaces whose last execution ended with unknown effects; their containers and volumes are preserved. */
  getUncertainWorkspaces(): readonly string[] {
    return [...this.uncertainWorkspaces].sort();
  }

  /** Idempotent: creating a volume this controller already created is a no-op. */
  async createVolume(volumeId: string): Promise<void> {
    assertVolumeName(volumeId);
    if (this.createdVolumes.has(volumeId)) return;
    const result = await this.spawnProcess('docker', ['volume', 'create', volumeId], VOLUME_OP_OPTIONS);
    if (result.timedOut || result.exitCode !== 0) throw new Error(`VOLUME_CREATE_FAILED: '${volumeId}': ${failureDetail(result.stderr)}`);
    this.createdVolumes.add(volumeId);
  }

  async hasVolume(volumeId: string): Promise<boolean> {
    assertVolumeName(volumeId);
    const result = await this.spawnProcess('docker', ['volume', 'inspect', volumeId], VOLUME_OP_OPTIONS);
    if (result.timedOut) throw new Error(`VOLUME_INSPECT_TIMEOUT: '${volumeId}'`);
    return result.exitCode === 0;
  }

  async removeVolume(volumeId: string): Promise<void> {
    assertVolumeName(volumeId);
    const result = await this.spawnProcess('docker', ['volume', 'rm', volumeId], VOLUME_OP_OPTIONS);
    if (result.timedOut || result.exitCode !== 0) throw new Error(`VOLUME_REMOVE_FAILED: '${volumeId}': ${failureDetail(result.stderr)}`);
    this.createdVolumes.delete(volumeId);
    this.volumeOwners.delete(volumeId);
  }

  async getCanonicalSnapshot(workspaceId: string): Promise<CanonicalRepositorySnapshot> {
    const binding = this.resolveWorkspaceBinding(workspaceId);
    if (!binding) throw new Error(`WORKSPACE_NOT_FOUND: no canonical repository volume is bound to workspace '${workspaceId}'`);
    assertVolumeName(binding.repoVolumeId);
    if (!SHA256_HEX_REGEX.test(binding.canonicalRevisionDigest)) {
      throw new Error(`INVALID_REVISION_DIGEST: workspace '${workspaceId}' revision '${binding.canonicalRevisionDigest}' must be a sha256 hex digest`);
    }

    const limits = this.trustedProfile.limits;
    const result = await this.spawnProcess(
      'docker',
      this.runArguments({
        user: this.trustedProfile.user,
        memoryBytes: limits.maxMemoryBytes,
        cpus: limits.maxCpuCores,
        pids: limits.maxPids,
        name: this.trackContainer('helper').name,
        mounts: [{ source: binding.repoVolumeId, target: '/workspace/repo', readOnly: true }],
        tail: ['python3', '-c', SNAPSHOT_SCRIPT],
      }),
      { timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES },
    );
    if (result.timedOut) throw new Error(`SNAPSHOT_READ_TIMEOUT: workspace '${workspaceId}'`);
    if (result.truncated === true) throw new Error(`SNAPSHOT_OUTPUT_TOO_LARGE: workspace '${workspaceId}' exceeded the output ceiling`);
    if (result.exitCode !== 0) throw new Error(`SNAPSHOT_READ_FAILED: workspace '${workspaceId}': ${failureDetail(result.stderr)}`);

    const entries = parseSnapshotEntries(result.stdout);
    if (entries.length === 0) throw new Error(`EMPTY_CANONICAL_SNAPSHOT: workspace '${workspaceId}' has no canonical repository entries`);
    return { canonicalRevisionDigest: binding.canonicalRevisionDigest, entries };
  }

  async materializeView(params: MaterializeViewParams): Promise<void> {
    const view = params?.view;
    if (!view || typeof view !== 'object') throw new Error('INVALID_MATERIALIZE_PARAMS: view is required');
    if (view.mountedReadOnly !== true) throw new Error('COMMAND_VIEW_NOT_READONLY: admitted views must be mounted read-only');
    if (typeof view.workspaceId !== 'string' || view.workspaceId.length === 0) throw new Error('INVALID_MATERIALIZE_PARAMS: view.workspaceId is required');
    assertVolumeName(view.viewId);
    assertVolumeName(view.scratchIdentity);

    // Only bytes the view builder already admitted may reach the view volume.
    const admitted = new Map(view.admittedFiles.map(file => [file.path, file.digest]));
    const files = Object.entries(params.files ?? {});
    if (files.length === 0) throw new Error('EMPTY_MATERIALIZE_FILES: no permitted files were supplied for the view');
    // The volume must be exactly the admitted set, so an omitted admitted file cannot be silently absent.
    if (files.length !== admitted.size) {
      throw new Error(`VIEW_FILE_SET_MISMATCH: view '${view.viewId}' admits ${admitted.size} file(s) but ${files.length} were supplied`);
    }

    const payload: { path: string; b64: string }[] = [];
    for (const [filePath, content] of files) {
      if (!isCanonicalRelativePath(filePath) || isProtectedPath(filePath)) {
        throw new Error(`UNSAFE_VIEW_PATH: '${filePath}' cannot be written into an admitted view`);
      }
      const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
      if (admitted.get(filePath) !== computeFileDigest(bytes)) {
        throw new Error(`UNADMITTED_VIEW_FILE: '${filePath}' is not an admitted file of view '${view.viewId}'`);
      }
      payload.push({ path: filePath, b64: bytes.toString('base64') });
    }
    const stdin = JSON.stringify({ files: payload });
    if (Buffer.byteLength(stdin, 'utf8') > MAX_VIEW_PAYLOAD_BYTES) throw new Error('VIEW_PAYLOAD_TOO_LARGE: admitted view exceeds the materialization ceiling');

    // The view volume must be exactly the admitted set, so a volume left from an earlier
    // materialization is replaced rather than written over (WRITE_SCRIPT never deletes files).
    if (await this.hasVolume(view.viewId)) await this.removeVolume(view.viewId);
    await this.createVolume(view.viewId);
    const limits = this.trustedProfile.limits;
    const result = await this.spawnProcess(
      'docker',
      this.runArguments({
        user: this.trustedProfile.user,
        memoryBytes: limits.maxMemoryBytes,
        cpus: limits.maxCpuCores,
        pids: limits.maxPids,
        name: this.trackContainer('helper').name,
        // This view volume is the only writable target here; execution re-mounts it read-only.
        mounts: [{ source: view.viewId, target: '/workspace/repo', readOnly: false }],
        stdin: true,
        tail: ['python3', '-c', WRITE_SCRIPT],
      }),
      { timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, stdin },
    );
    if (result.timedOut || result.exitCode !== 0) throw new Error(`VIEW_MATERIALIZATION_FAILED: ${failureDetail(result.stderr)}`);

    const previous = this.currentViewVolume.get(view.workspaceId);
    if (previous !== undefined && previous !== view.viewId) this.supersededVolumes.add(previous);
    // A re-activated volume is live again, so cleanup must not remove it as superseded.
    this.supersededVolumes.delete(view.viewId);
    this.currentViewVolume.set(view.workspaceId, view.viewId);
    this.volumeOwners.set(view.viewId, view.workspaceId);
    this.volumeOwners.set(view.scratchIdentity, view.workspaceId);
  }

  async executeContainer(plan: DockerContainerPlan): Promise<ContainerExecutionOutput> {
    const limits = this.assertPlan(plan);
    const repoMount = plan.mounts[0];
    const scratchMount = plan.mounts[1];
    if (!repoMount || !scratchMount) throw new Error('INVALID_MOUNTS: a container plan requires both workspace mounts');

    const workspaceId = this.volumeOwners.get(repoMount.source) ?? this.volumeOwners.get(scratchMount.source);
    const record = this.trackContainer('execution');

    const started = performance.now();
    const result = await this.spawnProcess(
      'docker',
      this.runArguments({
        user: plan.user,
        memoryBytes: limits.maxMemoryBytes,
        cpus: limits.maxCpuCores,
        pids: limits.maxPids,
        name: record.name,
        mounts: plan.mounts,
        workingDirectory: plan.workingDirectory,
        env: plan.env,
        tail: [plan.executable, ...plan.argv],
      }),
      { timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxOutputBytes },
    );
    const durationMs = Math.round(performance.now() - started);

    if (result.timedOut || result.exitCode === null) {
      record.uncertain = true;
      // A plan mounting an unmaterialized volume has no owner; treat the effect scope as unknown
      // rather than assuming no workspace was touched.
      if (workspaceId !== undefined) this.uncertainWorkspaces.add(workspaceId);
      else this.unattributedUncertainty = true;
    }
    if (!result.timedOut && result.exitCode === null) {
      throw new Error('INDETERMINATE_EXECUTION: docker run ended without an exit code or timeout; the effect is uncertain');
    }

    const stdout = truncateUtf8(result.stdout, limits.maxOutputBytes);
    const stderr = truncateUtf8(result.stderr, Math.max(0, limits.maxOutputBytes - stdout.byteLength));
    return { exitCode: result.exitCode, stdout: stdout.text, stderr: stderr.text, durationMs, timedOut: result.timedOut };
  }

  /** Removes containers it created and superseded view volumes; preserves anything tied to unknown effects. */
  async cleanup(): Promise<void> {
    const preserved: ContainerRecord[] = [];
    for (const container of this.containers) {
      if (container.uncertain) {
        preserved.push(container);
        continue;
      }
      const result = await this.spawnProcess('docker', ['rm', '-f', container.name], VOLUME_OP_OPTIONS);
      // A failed removal keeps the record so the next cleanup retries instead of leaking the container.
      if (result.timedOut || result.exitCode !== 0) preserved.push(container);
    }
    this.containers.length = 0;
    this.containers.push(...preserved);

    for (const volumeId of [...this.supersededVolumes]) {
      const owner = this.volumeOwners.get(volumeId);
      if (this.unattributedUncertainty) continue;
      if (owner !== undefined && this.uncertainWorkspaces.has(owner)) continue;
      const result = await this.spawnProcess('docker', ['volume', 'rm', volumeId], VOLUME_OP_OPTIONS);
      if (result.timedOut || result.exitCode !== 0) continue;
      this.supersededVolumes.delete(volumeId);
      this.createdVolumes.delete(volumeId);
      this.volumeOwners.delete(volumeId);
    }
  }

  private trackContainer(kind: ContainerRecord['kind']): ContainerRecord {
    const record: ContainerRecord = { name: `${kind === 'execution' ? 'ctr' : 'helper'}-${randomUUID()}`, kind, uncertain: false };
    this.containers.push(record);
    return record;
  }

  /** Validates a plan against the pinned trusted profile and limits before anything is spawned. */
  private assertPlan(plan: DockerContainerPlan): ExecutionLimits {
    return assertPlan(plan, this.trustedProfile);
  }

  /** Docker argv array; each element is one argument, so no shell ever parses it. */
  private runArguments(spec: RunArgumentSpec): string[] {
    return runArguments(spec, this.platform, this.trustedProfile.image, this.trustedProfile.imageDigest);
  }
}
