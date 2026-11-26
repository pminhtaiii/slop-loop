/**
 * Write a controlled UC-03 evaluation console `host.json` into a git-ignored directory
 * (`.agent-work/` by default) and print the exact `evaluate.js serve` command.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_OUT = join('.agent-work', 'controlled-console-host.json');
const DEFAULT_ASSEMBLY = 'dist/tests/runtime/support/uc03/controlled-console-assembly.js';

function resolveRepoRoot() {
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(cursor, 'package.json')) && existsSync(join(cursor, 'eval', 'uc03', 'manifest.json'))) {
      return cursor;
    }
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error('Could not locate repository root.');
}

function parseArgs(argv) {
  let out = DEFAULT_OUT;
  let assembly = DEFAULT_ASSEMBLY;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out requires a file path');
      out = value;
      i += 1;
    } else if (arg === '--assembly') {
      const value = argv[i + 1];
      if (!value) throw new Error('--assembly requires a module path');
      assembly = value;
      i += 1;
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  return { out, assembly };
}

async function main() {
  const repoRoot = resolveRepoRoot();
  const { out, assembly } = parseArgs(process.argv.slice(2));
  const outPath = isAbsolute(out) ? out : resolve(repoRoot, out);
  const assemblyDiskPath = isAbsolute(assembly) ? assembly : resolve(repoRoot, assembly);

  if (!existsSync(assemblyDiskPath)) {
    process.stderr.write(`Controlled assembly module not found at ${assemblyDiskPath}. Run "pnpm run build" first.\n`);
    process.exitCode = 1;
    return;
  }

  const mod = await import(pathToFileURL(assemblyDiskPath).href);
  if (typeof mod.buildControlledHostConfiguration !== 'function') {
    process.stderr.write(`Module ${assemblyDiskPath} does not export buildControlledHostConfiguration.\n`);
    process.exitCode = 1;
    return;
  }

  const hostConfig = mod.buildControlledHostConfiguration(assembly);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(hostConfig, null, 2)}\n`, 'utf8');

  const displayOut = isAbsolute(out) ? outPath : relative(repoRoot, outPath).replaceAll('\\', '/');
  process.stdout.write(`Host file: ${displayOut}\n`);
  process.stdout.write(`Serve command: node dist/src/cli/evaluate.js serve --host ${displayOut}\n`);
  process.stdout.write('Operator token: set UC03_CONSOLE_OPERATOR_TOKEN (16..512 printable ASCII chars) or copy the generated token printed once to stderr on startup.\n');
}

await main();
