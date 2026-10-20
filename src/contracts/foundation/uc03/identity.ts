/** Canonical identity, repository path, and protected-path rules. */

import { createHash } from 'node:crypto';
import type { CheckDefinition, CommandView, NormalizedAction } from './types.ts';

export function canonicalJsonStringify(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const k of sortedKeys) {
    if (obj[k] !== undefined) {
      entries.push(`${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`);
    }
  }
  return `{${entries.join(',')}}`;
}

export function computeCanonicalSha256(val: unknown): string {
  const json = canonicalJsonStringify(val);
  const hash = createHash('sha256').update(json, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

export function computeActionDigest(action: NormalizedAction): string {
  return computeCanonicalSha256(action);
}

export function computeCommandViewDigest(view: Omit<CommandView, 'viewDigest'> | CommandView): string {
  const rest = { ...(view as Record<string, unknown>) };
  delete rest['viewDigest'];
  return computeCanonicalSha256(rest);
}

export function computeCheckSetDigest(checks: readonly CheckDefinition[]): string {
  if (!Array.isArray(checks)) {
    throw new Error('computeCheckSetDigest requires an array of CheckDefinition');
  }
  const sorted = [...checks].sort((a, b) => {
    if (a.checkId !== b.checkId) {
      return a.checkId < b.checkId ? -1 : 1;
    }
    const aJson = canonicalJsonStringify(a);
    const bJson = canonicalJsonStringify(b);
    return aJson < bJson ? -1 : aJson > bJson ? 1 : 0;
  });
  return computeCanonicalSha256(sorted);
}

export function isCanonicalRelativePath(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  if (filePath.includes('\0')) return false;
  if (filePath.includes('\\')) return false;
  if (filePath.startsWith('/') || /^[a-zA-Z]:/.test(filePath)) return false;
  if (filePath.startsWith('./') || filePath === '.') return false;
  if (filePath.startsWith('../') || filePath === '..') return false;
  if (filePath.endsWith('/')) return false;
  if (filePath.endsWith('/..') || filePath.endsWith('/.')) return false;
  if (filePath.includes('//') || filePath.includes('/./') || filePath.includes('/../')) return false;
  return true;
}

export function normalizeLexicalPath(filePath: string): string | null {
  if (typeof filePath !== 'string' || filePath.includes('\0')) return null;
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;

  const segments = normalized.split('/');
  const stack: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return stack.join('/');
}

/* ------------------------------------------------------------------
 * Port Signatures
 * ------------------------------------------------------------------ */

export function isProtectedPath(filePath: string): boolean {
  const lex = normalizeLexicalPath(filePath);
  const target = (lex ?? filePath.replace(/\\/g, '/')).toLowerCase();
  const segments = target.split('/');
  const baseName = segments[segments.length - 1] ?? target;

  // .env files
  if (baseName === '.env' || baseName.startsWith('.env.')) {
    return true;
  }
  // SSH keys & private keys / certificates
  if (
    baseName === 'id_rsa' ||
    baseName === 'id_ed25519' ||
    baseName === 'id_dsa' ||
    baseName === 'id_ecdsa' ||
    baseName.endsWith('.pem') ||
    baseName.endsWith('.key') ||
    baseName.endsWith('.pkcs12') ||
    baseName.endsWith('.pfx')
  ) {
    return true;
  }
  // Credentials & secret configurations
  if (
    baseName === 'credentials.json' ||
    baseName === 'secrets.json' ||
    /^(password|passwords|token|tokens)(\.(txt|json|ya?ml|env))?$/.test(baseName)
  ) {
    return true;
  }
  // Git metadata
  if (segments.includes('.git') || target.startsWith('.git/') || target === '.git') {
    return true;
  }
  // Agent files (.agents, .codex, AGENTS.md, CLAUDE.md)
  if (segments.includes('.agents') || target.startsWith('.agents/') || target === '.agents') {
    return true;
  }
  if (segments.includes('.codex') || target.startsWith('.codex/') || target === '.codex') {
    return true;
  }
  if (baseName === 'agents.md' || baseName === 'claude.md') {
    return true;
  }
  // Hidden evaluation / grading
  const isPrivateGrading = segments.some((segment, index) => segment === 'private' && segments[index + 1] === 'grading');
  if (target === 'eval/uc03/private' || target.startsWith('eval/uc03/private/') || isPrivateGrading) {
    return true;
  }
  return false;
}
