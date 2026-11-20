/**
 * Disposable Docker grader executor for real final-snapshot grading (real-tier contract §(f) T062).
 *
 * Runs one admitted check in a disposable container from the pinned image over a separate read-only
 * copy of the frozen final tree, with a host-only private grader mount, `--network=none` and finite
 * resource bounds. It dispatches only after a current, registry-verified admission and a matching
 * measurement, settles exactly one attempt, and turns any drift or cleanup failure into not-run.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EvaluationGraderExecutionRequest, EvaluationGraderExecutor, EvaluationGradingBounds } from '../../eval/uc03/types.ts';
import { isHostAdmission } from '../../eval/uc03/grading.ts';
import type { StructuredSpawn, StructuredSpawnResult } from './docker-controller.ts';
import { structuredSpawn } from './docker-spawn.ts';

export interface DockerGraderArgvSpec {
  readonly containerName: string;
  readonly imageId: string;
  readonly snapshotMountPath: string;
  readonly graderMountPath: string;
  readonly bounds: EvaluationGradingBounds;
  readonly command: readonly string[];
  readonly workingDirectory?: string | undefined;
  readonly platform: string;
  readonly user: string;
}

/** Builds the docker run argv for one isolated attempt: no network, read-only root, dropped caps, finite limits. */
export function buildDockerGraderArgv(spec: DockerGraderArgvSpec): string[] {
  const cpus = Math.max(1, Math.round(spec.bounds.maxCpuMs / spec.bounds.timeoutMs));
  const args = [
    'run',
    '--rm',
    '--network=none',
    '--read-only',
    `--user=${spec.user}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--platform=${spec.platform}`,
    `--memory=${spec.bounds.maxMemoryBytes}`,
    `--cpus=${cpus}`,
    `--pids-limit=${spec.bounds.maxProcesses}`,
    '--pull=never',
    `--name=${spec.containerName}`,
    `--mount=type=bind,source=${spec.snapshotMountPath},target=/workspace/repo,readonly`,
    `--mount=type=bind,source=${spec.graderMountPath},target=/grader,readonly`,
  ];
  if (spec.workingDirectory !== undefined) args.push('-w', spec.workingDirectory);
  args.push(spec.imageId, ...spec.command);
  return args;
}

export interface DockerGraderExecutorAuthority {
  isCurrentAdmission(admission: unknown): boolean;
}

/** The host's view of the bound case: the frozen tree, its measurement and the pinned image. */
export interface GraderCaseHost {
  /** The files the final-tree port froze for the bound task. */
  frozen(): { readonly files: readonly { readonly path: string; readonly content: string | Uint8Array }[] } | undefined;
  /** Digest of a directory measured like the frozen tree. */
  measure(directory: string): string | undefined;
  /** Digest of the live final tree, re-frozen now. */
  measureLive(): string | undefined;
  image(): { readonly imageId: string; readonly platform: string; readonly user: string } | undefined;
}

export interface DockerGraderExecutorOptions {
  readonly executorId: string;
  readonly spawn?: StructuredSpawn | undefined;
  readonly authority: DockerGraderExecutorAuthority;
  readonly host: GraderCaseHost;
}

export interface DockerGraderExecutorResult {
  readonly checkId?: string | undefined;
  readonly finalSnapshot: EvaluationGraderExecutionRequest['finalSnapshot'];
  readonly profile: EvaluationGraderExecutionRequest['profile'];
  readonly executorId: string;
  readonly status: 'pass' | 'fail';
  readonly actualOutcome: 'COMPLETED' | 'FAILED';
  readonly durationMs: number;
  readonly cpuMs: number;
  readonly outputBytes: number;
  readonly exitReason: string;
  readonly killReason?: string | undefined;
}

export interface DockerGraderExecutorInstance extends EvaluationGraderExecutor {
  readonly executorId: string;
  execute(request: EvaluationGraderExecutionRequest): Promise<DockerGraderExecutorResult | undefined>;
}

interface GraderPayload {
  readonly files: readonly (readonly [string, string])[];
  readonly argv: readonly string[];
}

function safeRelativePath(path: string): boolean {
  return path !== '' && !/[\0\\]/u.test(path) && !path.startsWith('/') && !/^[A-Za-z]:/u.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function payloadOf(value: unknown): GraderPayload | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { files, argv } = value as { files?: unknown; argv?: unknown };
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return undefined;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(part => typeof part === 'string' && !part.includes('\0')) || argv[0] === '') return undefined;
  const entries = Object.entries(files);
  if (!entries.every(([path, body]) => safeRelativePath(path) && typeof body === 'string')) return undefined;
  return { files: entries as [string, string][], argv: argv as string[] };
}

function writeFiles(directory: string, files: readonly { readonly path: string; readonly content: string | Uint8Array }[]): void {
  for (const file of files) {
    const target = join(directory, ...file.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
}

const CLEANUP_BOUNDS = { timeoutMs: 30_000, maxOutputBytes: 4096 } as const;

/** Removes the container (a killed `docker run` client does not stop it) and both host directories. */
async function cleanUp(spawnFn: StructuredSpawn, containerName: string | undefined, directories: readonly string[]): Promise<boolean> {
  let clean = true;
  if (containerName !== undefined) {
    try {
      const removed = await spawnFn('docker', ['rm', '-f', containerName], CLEANUP_BOUNDS);
      if (removed.timedOut || (removed.exitCode !== 0 && !/No such container/iu.test(removed.stderr))) clean = false;
    } catch {
      clean = false;
    }
  }
  for (const directory of directories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      clean = false;
    }
  }
  return clean;
}

export function createDockerGraderExecutor(options: DockerGraderExecutorOptions): DockerGraderExecutorInstance {
  const settledAdmissions = new WeakSet<object>();
  const { host, authority } = options;

  return {
    executorId: options.executorId,

    async execute(request: EvaluationGraderExecutionRequest): Promise<DockerGraderExecutorResult | undefined> {
      // 1. Exact admission and identity checks before any filesystem or spawn work.
      if (request.executorId !== options.executorId) return undefined;
      const admission = request.admission;
      if (!admission || typeof admission !== 'object' || admission.kind !== 'host-isolation-admission') return undefined;
      if (admission.executorId !== options.executorId || request.checkId !== admission.checkId) return undefined;
      if (request.finalSnapshot.snapshotId !== admission.finalSnapshot.snapshotId || request.finalSnapshot.digest !== admission.finalSnapshot.digest) return undefined;
      if (request.profile.profileId !== admission.profile.profileId || request.profile.digest !== admission.profile.digest) return undefined;
      const rb = request.profile.bounds;
      const ab = admission.profile.bounds;
      if (rb.timeoutMs !== ab.timeoutMs || rb.maxCpuMs !== ab.maxCpuMs || rb.maxOutputBytes !== ab.maxOutputBytes || rb.maxMemoryBytes !== ab.maxMemoryBytes || rb.maxProcesses !== ab.maxProcesses)
        return undefined;
      if (!isHostAdmission(authority, admission) || !authority.isCurrentAdmission(admission) || settledAdmissions.has(admission)) return undefined;

      const frozen = host.frozen();
      const image = host.image();
      const payload = payloadOf(request.graderPayload);
      if (frozen === undefined || image === undefined || payload === undefined) return undefined;
      // The live tree must still be the admitted snapshot before anything is copied.
      if (host.measureLive() !== request.finalSnapshot.digest) return undefined;

      const spawnFn = options.spawn ?? structuredSpawn;
      const directories: string[] = [];
      let containerName: string | undefined;
      let outcome: DockerGraderExecutorResult | undefined;
      try {
        // 2. A fresh isolated copy of the frozen tree, re-measured against the admission.
        const copy = mkdtempSync(join(tmpdir(), 'grader-copy-'));
        directories.push(copy);
        writeFiles(copy, frozen.files);
        if (host.measure(copy) !== request.finalSnapshot.digest) return undefined;
        // 3. The private grader payload in a separate host-only directory.
        const privateDir = mkdtempSync(join(tmpdir(), 'grader-private-'));
        directories.push(privateDir);
        writeFiles(
          privateDir,
          payload.files.map(([path, content]) => ({ path, content })),
        );

        settledAdmissions.add(admission);
        containerName = `grader-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const argv = buildDockerGraderArgv({
          containerName,
          imageId: image.imageId,
          snapshotMountPath: copy,
          graderMountPath: privateDir,
          bounds: rb,
          command: payload.argv,
          workingDirectory: '/workspace/repo',
          platform: image.platform,
          user: image.user,
        });
        const start = Date.now();
        let spawnResult: StructuredSpawnResult;
        try {
          spawnResult = await spawnFn('docker', argv, { timeoutMs: rb.timeoutMs, maxOutputBytes: rb.maxOutputBytes });
        } catch {
          return undefined;
        }
        const durationMs = Math.min(rb.timeoutMs, Math.max(0, Date.now() - start));

        // 4. Drift in the live tree or the copy during the attempt turns the grade into not-run.
        if (host.measureLive() !== request.finalSnapshot.digest || host.measure(copy) !== request.finalSnapshot.digest) return undefined;

        const isPass = spawnResult.exitCode === 0 && !spawnResult.timedOut;
        const outputBytes = Math.min(Buffer.byteLength(spawnResult.stdout + spawnResult.stderr, 'utf8'), rb.maxOutputBytes);
        const exitReason = spawnResult.timedOut ? 'timeout' : spawnResult.exitCode === 0 ? 'clean-exit' : `exit-${spawnResult.exitCode ?? 'unknown'}`;
        const killReason = spawnResult.timedOut ? 'timeout' : spawnResult.exitCode === 137 ? 'oom-or-sigkill' : spawnResult.exitCode === 0 ? undefined : 'failed-check';
        outcome = Object.freeze({
          ...(request.checkId === undefined ? {} : { checkId: request.checkId }),
          finalSnapshot: request.finalSnapshot,
          profile: request.profile,
          executorId: options.executorId,
          status: isPass ? 'pass' : 'fail',
          actualOutcome: isPass ? 'COMPLETED' : 'FAILED',
          durationMs,
          cpuMs: Math.min(durationMs, rb.maxCpuMs),
          outputBytes,
          exitReason,
          ...(killReason === undefined ? {} : { killReason }),
        });
      } finally {
        // A cleanup failure is reported as not-run below, never swallowed.
        if (!(await cleanUp(spawnFn, containerName, directories))) outcome = undefined;
      }
      return outcome;
    },
  };
}
