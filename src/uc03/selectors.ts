/**
 * UC-03 Verified Code Repair - Test Selector Utilities
 *
 * Owned path: src/uc03/selectors.ts
 * Feature: specs/001-verified-code-repair
 *
 * Canonical test selector extraction and normalization shared across
 * investigation (T013) and verification (T014).
 */

import {
  isCanonicalRelativePath,
  isProtectedPath,
  type CheckDefinition,
} from '../contracts/foundation/uc03.ts';

export interface PytestSelector {
  readonly rawToken: string;
  readonly filePath: string;
  readonly nodeSelector?: string | undefined;
  readonly isDirectory: boolean;
}

/**
 * Normalizes a pytest selector token into its underlying file or directory path.
 * Supports:
 * - tests/foo.py
 * - tests/foo.py::test_a
 * - tests/foo.py::TestClass::test_a
 * - tests/unit (directory selector)
 * - --test-file=tests/foo.py
 *
 * Strict validation:
 * - Rejects path traversal (e.g. ../), absolute paths, null bytes.
 * - Rejects protected paths (.env, .git, credentials, etc.).
 * - Rejects invalid node ID syntax (empty segments, segments with slashes).
 */
export function normalizePytestSelector(token: string): PytestSelector | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  if (
    token.includes('\0') ||
    token.includes('\\') ||
    token.startsWith('/') ||
    /^[a-zA-Z]:/.test(token)
  ) {
    return null;
  }

  let raw = token;
  if (raw.startsWith('--') && raw.includes('=')) {
    raw = raw.slice(raw.indexOf('=') + 1);
  }
  if (raw.startsWith('-')) return null;

  let filePath = raw;
  let nodeSelector: string | undefined;

  if (raw.includes('::')) {
    const parts = raw.split('::');
    filePath = parts[0] ?? '';
    const nodeParts = parts.slice(1);
    if (
      nodeParts.length === 0 ||
      nodeParts.some((p) => p.length === 0 || p.includes('/') || p.includes('\\'))
    ) {
      return null;
    }
    nodeSelector = nodeParts.join('::');
  }

  if (!isCanonicalRelativePath(filePath) || isProtectedPath(filePath)) {
    return null;
  }

  // A directory selector has no file extension (e.g. tests/unit, tests)
  const lastSlash = filePath.lastIndexOf('/');
  const baseName = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const isDirectory = !baseName.includes('.');

  // A directory selector must be a recognizable test path (contains '/' or is 'tests'/'test')
  if (isDirectory && !filePath.includes('/') && filePath !== 'tests' && filePath !== 'test') {
    return null;
  }

  return {
    rawToken: token,
    filePath,
    nodeSelector,
    isDirectory,
  };
}

/** Known pytest options that consume a subsequent argument value */
export const PYTEST_OPTIONS_WITH_ARG: ReadonlySet<string> = new Set([
  '-k',
  '-m',
  '-o',
  '-c',
  '-W',
  '-n',
  '-p',
  '-r',
  '--override-ini',
  '--rootdir',
  '--import-mode',
  '--junit-xml',
  '--junitxml',
  '--cov',
  '--ignore',
  '--capture',
  '--tb',
  '--color',
  '--pythonwarnings',
  '--maxfail',
  '--dist',
  '--log-level',
  '--log-file',
  '--durations',
  '--durations-min',
  '--basetemp',
  '--confcutdir',
  '--deselect',
  '--timeout',
  '--cov-report',
]);

/**
 * Resolves the first pytest argument for direct and Python module invocations.
 */
export function resolvePytestInvocation(
  check: CheckDefinition
): { readonly argStart: number } | null {
  const executable = (check.executable?.split(/[\\/]/).pop() ?? '')
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (executable === 'pytest' || executable === 'py.test') return { argStart: 0 };
  if (
    /^python(?:\d+(?:\.\d+)*)?$/.test(executable) &&
    check.argv[0] === '-m' && check.argv[1] === 'pytest'
  ) {
    return { argStart: 2 };
  }
  return null;
}

/**
 * Extracts target test selectors from a check definition's argv.
 * Understands pytest option syntax and skips flag parameters like -k, -m.
 */
export function extractCheckTestSelectors(
  check: CheckDefinition
): readonly PytestSelector[] {
  const invocation = resolvePytestInvocation(check);
  if (!invocation) return Object.freeze([]);

  const results: PytestSelector[] = [];
  const argv = check.argv ?? [];

  for (let i = invocation.argStart; i < argv.length; i++) {
    let arg = argv[i];
    if (typeof arg !== 'string') continue;

    if (arg === '--deselect') {
      arg = argv[++i] ?? '';
    } else if (PYTEST_OPTIONS_WITH_ARG.has(arg)) {
      i++; // skip next argument value
      continue;
    } else if (arg.startsWith('-') && !arg.startsWith('--test-file=') && !arg.startsWith('--deselect=')) {
      continue;
    }
    const parsed = normalizePytestSelector(arg);
    if (parsed) {
      results.push(parsed);
    }
  }

  return Object.freeze(results);
}
