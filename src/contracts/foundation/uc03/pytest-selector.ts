/** Shared pytest selector syntax for UC-03 checks and admission bindings. */
import { isCanonicalRelativePath, isProtectedPath } from './identity.ts';

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
  if (token.includes('\0') || token.includes('\\') || token.startsWith('/') || /^[a-zA-Z]:/.test(token)) {
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
    if (nodeParts.length === 0 || nodeParts.some(p => p.length === 0 || p.includes('/') || p.includes('\\'))) {
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

/** Match a literal path or the file in a positional pytest node ID. */
export function matchesPytestFileArgument(token: string, filePath: string): boolean {
  if (token === filePath) return true;
  if (token.startsWith('-')) return false;
  const selector = normalizePytestSelector(token);
  return selector !== null && !selector.isDirectory && selector.nodeSelector !== undefined && selector.filePath === filePath;
}
