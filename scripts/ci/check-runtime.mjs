import { spawnSync } from 'node:child_process';
import { realpathSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Clean-build-only exists so a CI lane can compile from source without re-running the whole local
// publication gate. The default stays the complete gate, so nothing can loosen it by accident.
export const FULL_STEPS = Object.freeze(['typecheck', 'lint', 'build', 'test:runtime']);
export const CLEAN_BUILD_STEPS = Object.freeze(['build']);
const USAGE = 'Usage: node scripts/ci/check-runtime.mjs [--clean-build-only]';

export function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new Error(USAGE);
  if (argv.length === 0) return FULL_STEPS;
  if (argv.length === 1 && argv[0] === '--clean-build-only') return CLEAN_BUILD_STEPS;
  throw new Error(USAGE);
}

export function runGate({ argv = [], root, platform = process.platform, spawn = spawnSync, remove = rmSync, log = console.log, timeout = 600_000 } = {}) {
  // Parse before touching the filesystem: an unknown option must leave no trace.
  const steps = parseArgs(argv);
  // Always compile from source; stale emitted output must never satisfy this gate.
  const dist = resolve(root, 'dist');
  remove(dist, { recursive: true, force: true });
  for (const script of steps) {
    log(`Runtime gate: ${script}`);
    // Windows pnpm is a command shim; only the fixed script names above reach cmd.
    const windows = platform === 'win32';
    const result = spawn(windows ? 'cmd.exe' : 'pnpm', windows ? ['/d', '/s', '/c', `pnpm run ${script}`] : ['run', script], { cwd: root, stdio: 'inherit', windowsHide: true, timeout });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || `Runtime ${script} failed (${result.status})`);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    runGate({ argv: process.argv.slice(2), root: resolve(dirname(fileURLToPath(import.meta.url)), '../..') });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
