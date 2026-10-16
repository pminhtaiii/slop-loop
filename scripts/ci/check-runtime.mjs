import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/ci/check-runtime.mjs');
  // Always compile from source; stale emitted tests must never satisfy this gate.
  const dist = resolve(root, 'dist');
  if (dirname(dist) !== root) throw new Error('Build output must stay inside the checkout.');
  rmSync(dist, { recursive: true, force: true });
  for (const script of ['typecheck', 'lint', 'build', 'test:runtime']) {
    console.log(`Runtime gate: ${script}`);
    // Windows pnpm is a command shim; only the fixed script names above reach cmd.
    const windows = process.platform === 'win32';
    const result = spawnSync(windows ? 'cmd.exe' : 'pnpm', windows ? ['/d', '/s', '/c', `pnpm run ${script}`] : ['run', script], { cwd: root, stdio: 'inherit', windowsHide: true, timeout: 600_000 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || `Runtime ${script} failed (${result.status})`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
