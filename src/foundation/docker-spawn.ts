import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { StructuredSpawn } from './docker-controller.ts';
import { truncateUtf8 } from './docker-workspace-policy.ts';

// Longest UTF-8 character is 4 bytes, so 3 spare bytes keep a character split by the cap decodable for truncateUtf8.
const CAPTURE_SLACK_BYTES = 3;

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
    // argv array only: no shell ever parses an argument.
    const child = spawn(command, [...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const limit = options.maxOutputBytes;
    const stdout = capture(child.stdout, limit);
    const stderr = capture(child.stderr, limit);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // shortcut: kills only the direct child; a Windows .cmd shim's grandchild survives, add a tree kill when docker is launched through a shim.
      child.kill();
    }, options.timeoutMs);

    child.on('spawn', () => child.stdin?.end(options.stdin));
    child.on('close', code => {
      clearTimeout(timer);
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
      reject(new Error(`SPAWN_FAILED: could not start '${command}': ${error.message}`, { cause: error }));
    });
  });
