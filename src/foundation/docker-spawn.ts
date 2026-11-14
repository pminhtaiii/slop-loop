import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { StructuredSpawn } from './docker-controller.ts';
import { truncateUtf8 } from './docker-workspace-policy.ts';

// Longest UTF-8 character is 4 bytes, so 3 spare bytes keep a character split by the cap decodable for truncateUtf8.
const CAPTURE_SLACK_BYTES = 3;
// A timed-out child that ignores or lags SIGTERM still has to settle the promise.
const SIGKILL_GRACE_MS = 2_000;

/** The only parent variables the Docker CLI receives; everything else, including provider credentials, stays in this process. */
export const SPAWN_ENV_ALLOWLIST: readonly string[] = ['PATH', 'SystemRoot', 'DOCKER_HOST', 'DOCKER_CONFIG', 'HOME', 'USERPROFILE', 'TEMP', 'TMP'];

function allowlistedEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SPAWN_ENV_ALLOWLIST) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface Capture {
  readonly chunks: Buffer[];
  received: number;
  kept: number;
}

function capture(stream: Readable | null, maxBytes: number): Capture {
  const state: Capture = { chunks: [], received: 0, kept: 0 };
  stream?.on('data', (chunk: Buffer) => {
    state.received += chunk.length;
    const room = maxBytes + CAPTURE_SLACK_BYTES - state.kept;
    if (room <= 0) return; // Drain the rest of the stream without buffering it.
    const kept = chunk.subarray(0, room);
    state.chunks.push(kept);
    state.kept += kept.length;
  });
  return state;
}

function capturedText(state: Capture, maxBytes: number): string {
  return truncateUtf8(Buffer.concat(state.chunks).toString('utf8'), maxBytes).text;
}

export const structuredSpawn: StructuredSpawn = (command, args, options) =>
  new Promise((resolve, reject) => {
    // argv array only: no shell ever parses an argument; the child gets an allowlisted environment, never the host's.
    const child = spawn(command, [...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: allowlistedEnv(process.env) });
    const limit = options.maxOutputBytes;
    const stdout = capture(child.stdout, limit);
    const stderr = capture(child.stderr, limit);

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      // shortcut: kills only the direct child; a Windows .cmd shim's grandchild survives, add a tree kill when docker is launched through a shim.
      child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS);
    }, options.timeoutMs);

    child.on('spawn', () => {
      // A child that exits before reading a large stdin emits EPIPE; the close handler reports the exit code.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.stdin);
    });
    child.on('close', code => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        exitCode: code,
        stdout: capturedText(stdout, limit),
        stderr: capturedText(stderr, limit),
        timedOut,
        truncated: stdout.received > limit || stderr.received > limit,
      });
    });
    child.on('error', error => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(new Error(`SPAWN_FAILED: could not start '${command}': ${error.message}`, { cause: error }));
    });
  });
