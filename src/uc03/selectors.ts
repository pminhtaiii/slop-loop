/**
 * UC-03 Verified Code Repair - Test Selector Utilities
 *
 * Owned path: src/uc03/selectors.ts
 * Feature: specs/001-verified-code-repair
 *
 * Canonical test selector extraction and normalization shared across
 * investigation (T013) and verification (T014).
 */

import type { CheckDefinition } from '../contracts/foundation/uc03.ts';
import { normalizePytestSelector, type PytestSelector } from '../contracts/foundation/uc03/pytest-selector.ts';

export { normalizePytestSelector, type PytestSelector };

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
export function resolvePytestInvocation(check: CheckDefinition): { readonly argStart: number } | null {
  const executable = (check.executable?.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
  if (executable === 'pytest' || executable === 'py.test') return { argStart: 0 };
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(executable) && check.argv[0] === '-m' && check.argv[1] === 'pytest') {
    return { argStart: 2 };
  }
  return null;
}

/**
 * Extracts target test selectors from a check definition's argv.
 * Understands pytest option syntax and skips flag parameters like -k, -m.
 */
export function extractCheckTestSelectors(check: CheckDefinition): readonly PytestSelector[] {
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
