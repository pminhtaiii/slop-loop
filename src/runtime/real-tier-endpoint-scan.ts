/**
 * G-PRIVACY quiet endpoint and credential leak scanner (T057, contract §(d) "Privacy").
 *
 * `scanStaged` reads exactly the candidate index (`git diff --cached --name-only -z --diff-filter=ACMR`
 * plus `git show :<path>`) and `scanDirectory` walks retained evidence; both scan the relative paths and
 * the contents against needles derived in memory from `loadRealTierProfile`. Output is only
 * `<location>:<line> ENDPOINT_LEAK|CREDENTIAL_LEAK` lines and a final verdict, with `<location>` hashed
 * when the path itself would reveal a needle, so a needle, a matched line and a child-process error are
 * never echoed. Exit codes: 0 clean, 1 leak, 2 scan error.
 */
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { sha256Text } from '../uc01/contracts.ts';
import { DEFAULT_REAL_TIER_ENDPOINT, loadRealTierProfile, type RealTierEnvironment, type RealTierProfile } from './real-tier-profile.ts';

/** 0 clean, 1 leak, 2 scan error. Any nonzero result blocks a commit or a publication. */
export type ScanResult = Readonly<{ readonly exitCode: 0 | 1 | 2; readonly output: string }>;

/** Structured-argv git: no shell ever parses a path. Failures carry no child output. */
export type ScanGit = (args: readonly string[]) => Promise<Readonly<{ ok: true; stdout: string | Buffer }> | Readonly<{ ok: false }>>;

export type ScanOptions = Readonly<{ env: RealTierEnvironment; repositoryRoot: string; cwd?: string | undefined; git?: ScanGit | undefined }>;

type Needles = Readonly<{ endpoint: readonly RegExp[]; credential: RegExp | undefined }>;

type ProfileLoad = Readonly<{ ok: true; profile: RealTierProfile }> | Readonly<{ ok: false; result: ScanResult }>;

/** The profile loader refuses an absent key, but an unchecked scan still has to resolve the endpoint. */
const UNCHECKED_CREDENTIAL = 'credential-unchecked';

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Host matches need a non-host character on each side, so `192.0.2.7` cannot match `192.0.2.70`. */
const bounded = (value: string): RegExp => new RegExp(`(?<![A-Za-z0-9.-])${escape(value)}(?![A-Za-z0-9.-])`, 'u');

const HOST_LIKE = '(?:[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+|localhost|\\[[0-9A-Fa-f:.]+\\])';
const PORT_KEY = '["\']?[A-Za-z0-9_.-]*port[A-Za-z0-9_.-]*["\']?';

/** The port matches only after a host-like token or as a port-key value, both digit-bounded. */
function portRule(port: string): RegExp {
  const digits = `(?<!\\d)${port}(?!\\d)`;
  return new RegExp(`(?:${HOST_LIKE}(?::|%3A)${digits}|${PORT_KEY}\\s*(?::|=)\\s*["\']?${digits})`, 'iu');
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const PRINTABLE = /^[\x20-\x7e]+$/u;
const POSIX = (path: string): string => path.split(sep).join('/');
const textOf = (value: string | Buffer): string => (typeof value === 'string' ? value : value.toString('utf8'));

export function scanError(code: string): ScanResult {
  return { exitCode: 2, output: `SCAN_ERROR ${code}` };
}

/** Needles for one endpoint: the URL forms, the encoded forms, the host and the port rule. */
function endpointNeedles(href: string): readonly RegExp[] {
  // The pinned default is a public host, so it carries no needle and never blocks a publication.
  if (href === DEFAULT_REAL_TIER_ENDPOINT || href === new URL(DEFAULT_REAL_TIER_ENDPOINT).href) return [];
  const url = new URL(href);
  const host = url.hostname;
  const port = url.port;
  const forms = [href, href.replace(/\/messages$/u, ''), href.replace(/^[a-z]+:\/\//u, '')];
  const encoded = port === '' ? [] : [encodeURIComponent(`${host}:${port}`)];
  const needles = forms.map(form => new RegExp(escape(form), 'u')).concat([...forms, ...encoded].map(form => new RegExp(escape(encodeURIComponent(form)), 'u')));
  if (port !== '') needles.push(bounded(`${host}:${port}`));
  // A loopback host (SSH tunnel) is too common to be a needle of its own; only its port and URL forms are.
  if (!LOOPBACK.has(host)) needles.push(bounded(host));
  if (port !== '' && port !== '80' && port !== '443') needles.push(portRule(port));
  return needles;
}

/** Resolves the profile through T047, then derives the needles in memory. Absent key means unchecked. */
export function resolveScanProfile(env: RealTierEnvironment, repositoryRoot: string): ProfileLoad {
  const credential = env.ANTHROPIC_API_KEY?.trim() ? env.ANTHROPIC_API_KEY : undefined;
  const loaded = loadRealTierProfile({ ...env, ANTHROPIC_API_KEY: credential ?? UNCHECKED_CREDENTIAL }, { repositoryRoot });
  return loaded.ok ? { ok: true, profile: loaded.value } : { ok: false, result: scanError(loaded.reasonCode) };
}

function needlesOf(env: RealTierEnvironment, repositoryRoot: string): Readonly<{ ok: true; needles: Needles }> | Readonly<{ ok: false; result: ScanResult }> {
  const resolved = resolveScanProfile(env, repositoryRoot);
  if (!resolved.ok) return resolved;
  const credential = env.ANTHROPIC_API_KEY?.trim() ? env.ANTHROPIC_API_KEY : undefined;
  return {
    ok: true,
    needles: { endpoint: endpointNeedles(resolved.profile.endpoint.href), credential: credential === undefined ? undefined : new RegExp(escape(credential), 'u') },
  };
}

function leakAt(line: string, needles: Needles): 'ENDPOINT_LEAK' | 'CREDENTIAL_LEAK' | undefined {
  if (needles.endpoint.some(needle => needle.test(line))) return 'ENDPOINT_LEAK';
  return needles.credential?.test(line) ? 'CREDENTIAL_LEAK' : undefined;
}

/** A path hit is a leak even when its content is clean: consult the raw and the percent-decoded path. */
function pathLeak(path: string, needles: Needles): 'ENDPOINT_LEAK' | 'CREDENTIAL_LEAK' | undefined {
  const direct = leakAt(path, needles);
  if (direct !== undefined) return direct;
  const decoded = percentDecoded(path);
  return decoded === path ? undefined : leakAt(decoded, needles);
}

function percentDecoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value; // A stray `%` is not an encoding; the raw form was already scanned.
  }
}

/** The plain relative path only when it reveals nothing and is printable; otherwise a local-matchable hash. */
function locationOf(path: string, needles: Needles): string {
  return PRINTABLE.test(path) && pathLeak(path, needles) === undefined ? path : `path-sha256:${sha256Text(path).slice(0, 12)}`;
}

function scanEntry(path: string, content: string, needles: Needles, lines: string[]): void {
  const pathKind = pathLeak(path, needles);
  const location = locationOf(path, needles);
  if (pathKind !== undefined) lines.push(`${location}:0 ${pathKind}`);
  content.split(/\r?\n/u).forEach((line, index) => {
    const kind = leakAt(line, needles);
    if (kind !== undefined) lines.push(`${location}:${index + 1} ${kind}`);
  });
}

function verdict(lines: readonly string[], credentialChecked: boolean): ScanResult {
  if (lines.length > 0) return { exitCode: 1, output: [...lines, 'SCAN_LEAK'].join('\n') };
  return { exitCode: 0, output: credentialChecked ? 'SCAN_CLEAN' : 'SCAN_CLEAN credential-unchecked' };
}

/** An unreadable candidate is a scan error, never a pass: its bytes were not checked. */
function readOrError(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** One file entry per relative path under `dir`, sorted so the report is stable; `undefined` on a failed walk. */
function filesUnder(root: string): readonly string[] | undefined {
  try {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => POSIX(relative(root, join(entry.parentPath, entry.name))))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  } catch {
    return undefined;
  }
}

/**
 * Scans a directory of retained evidence recursively. Every file's relative path (so each directory
 * name too) and contents are checked; a path hit is reported at line 0.
 *
 * shortcut: an empty directory whose own name leaks is not reported, add an entry walk if evidence
 * ever retains empty directories.
 */
export function scanDirectory(dir: string, options: ScanOptions): ScanResult {
  const resolved = needlesOf(options.env, options.repositoryRoot);
  if (!resolved.ok) return resolved.result;
  const root = resolve(dir);
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory() !== true) return scanError('directory-unreadable');
  const files = filesUnder(root);
  if (files === undefined) return scanError('directory-unreadable');
  const lines: string[] = [];
  for (const path of files) {
    const content = readOrError(join(root, path));
    if (content === undefined) return scanError('file-unreadable');
    scanEntry(path, content, resolved.needles, lines);
  }
  return verdict(lines, resolved.needles.credential !== undefined);
}

/** Structured-argv git bound to one working tree. */
export function createScanGit(cwd: string): ScanGit {
  return args =>
    new Promise(resolve => {
      execFile('git', [...args], { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => resolve(error ? { ok: false } : { ok: true, stdout }));
    });
}

/**
 * Scans exactly the candidate index. Deletions are skipped (their bytes are not in the candidate), and a
 * rename or copy is scanned under its new path only. A blob read or git failure is a scan error, never a
 * pass, and its raw child output is dropped.
 */
export async function scanStaged(options: ScanOptions): Promise<ScanResult> {
  const resolved = needlesOf(options.env, options.repositoryRoot);
  if (!resolved.ok) return resolved.result;
  const git = options.git ?? createScanGit(options.cwd ?? process.cwd());
  const listing = await git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
  if (!listing.ok) return scanError('git-failure');
  const paths = textOf(listing.stdout)
    .split('\0')
    .filter(path => path !== '')
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const lines: string[] = [];
  for (const path of paths) {
    const blob = await git(['show', `:${path}`]);
    if (!blob.ok) return scanError('blob-unreadable');
    scanEntry(POSIX(path), textOf(blob.stdout), resolved.needles, lines);
  }
  return verdict(lines, resolved.needles.credential !== undefined);
}
