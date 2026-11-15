/**
 * G-PRIVACY quiet endpoint and credential leak scanner (T057, contract §(d) "Privacy").
 *
 * `scanStaged` reads exactly the candidate index (`git diff --cached --name-only -z --diff-filter=ACMR`
 * plus `git show :<path>`), `scanAll` audits the whole index, `scanRange` walks every commit a base does
 * not contain, and `scanDirectory` walks retained evidence; all scan the relative paths and the contents
 * against needles derived in memory from `loadRealTierProfile`. Output is only
 * `<location>:<line> ENDPOINT_LEAK|CREDENTIAL_LEAK|DIGEST_KEY_LEAK` lines and a final verdict, with
 * `<location>` hashed when the path itself would reveal a needle, so a needle, a matched line and a
 * child-process error are never echoed. Exit codes: 0 clean, 1 leak, 2 scan error.
 */
import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { sha256Text } from '../uc01/contracts.ts';
import { DEFAULT_REAL_TIER_ENDPOINT, loadRealTierProfile, type RealTierEnvironment, type RealTierProfile } from './real-tier-profile.ts';

/** 0 clean, 1 leak, 2 scan error. Any nonzero result blocks a commit or a publication. */
export type ScanResult = Readonly<{ readonly exitCode: 0 | 1 | 2; readonly output: string }>;

/** Structured-argv git: no shell ever parses a path. Failures carry no child output. */
export type ScanGit = (args: readonly string[]) => Promise<Readonly<{ ok: true; stdout: string | Buffer }> | Readonly<{ ok: false }>>;

export type ScanOptions = Readonly<{ env: RealTierEnvironment; repositoryRoot: string; cwd?: string | undefined; git?: ScanGit | undefined }>;

type LeakKind = 'ENDPOINT_LEAK' | 'CREDENTIAL_LEAK' | 'DIGEST_KEY_LEAK';

/** `key` is the HMAC key for the hashed location; empty when the public default endpoint needs none. */
type Needles = Readonly<{ endpoint: readonly RegExp[]; credential: RegExp | undefined; digestKey: RegExp | undefined; key: string }>;

type ProfileLoad = Readonly<{ ok: true; profile: RealTierProfile }> | Readonly<{ ok: false; result: ScanResult }>;

/** The profile loader refuses an absent key, but an unchecked scan still has to resolve the endpoint. */
const UNCHECKED_CREDENTIAL = 'credential-unchecked';

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Host matches need a non-host character on each side, so `192.0.2.7` cannot match `192.0.2.70`. */
const bounded = (value: string): RegExp => new RegExp(`(?<![A-Za-z0-9.-])${escape(value)}(?![A-Za-z0-9.-])`, 'u');

/** The raw and once-encoded spellings of a host-bearing token, both under the same boundary rule. */
const boundedForms = (value: string): readonly RegExp[] => [value, encodeURIComponent(value)].map(bounded);

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

/** Needles for one endpoint: the URL forms, their once-encoded forms, the host and the port rule. */
function endpointNeedles(href: string): readonly RegExp[] {
  // The pinned default is a public host, so it carries no needle and never blocks a publication.
  if (href === DEFAULT_REAL_TIER_ENDPOINT || href === new URL(DEFAULT_REAL_TIER_ENDPOINT).href) return [];
  const url = new URL(href);
  const host = url.hostname;
  const port = url.port;
  // Every raw form first, then its once-encoded equivalent: an encoded IPv6 host appears in no raw form.
  const raw = [href, href.replace(/\/messages$/u, ''), href.replace(/^[a-z]+:\/\//u, '')];
  const needles = [...new Set([...raw, ...raw.map(form => encodeURIComponent(form))])].map(form => new RegExp(escape(form), 'u'));
  if (port !== '') needles.push(...boundedForms(`${host}:${port}`));
  // A loopback host (SSH tunnel) is too common to be a needle of its own; only its port and URL forms are.
  if (!LOOPBACK.has(host)) needles.push(...boundedForms(host));
  if (port !== '' && port !== '80' && port !== '443') needles.push(portRule(port));
  return needles;
}

/** Resolves the profile through T047, then derives the needles in memory. Absent key means unchecked. */
export function resolveScanProfile(env: RealTierEnvironment, repositoryRoot: string): ProfileLoad {
  const credential = env.ANTHROPIC_API_KEY?.trim() ? env.ANTHROPIC_API_KEY : undefined;
  const loaded = loadRealTierProfile({ ...env, ANTHROPIC_API_KEY: credential ?? UNCHECKED_CREDENTIAL }, { repositoryRoot });
  return loaded.ok ? { ok: true, profile: loaded.value } : { ok: false, result: scanError(loaded.reasonCode) };
}

const isLoopback = (href: string): boolean => LOOPBACK.has(new URL(href).hostname);

/**
 * The needle set: the resolved endpoint, each additional private endpoint, the credential and the
 * digest key. A loopback endpoint hides the remote host, so it is only scannable when the profile
 * lists the remote private endpoint.
 */
function needlesOf(env: RealTierEnvironment, repositoryRoot: string): Readonly<{ ok: true; needles: Needles }> | Readonly<{ ok: false; result: ScanResult }> {
  const resolved = resolveScanProfile(env, repositoryRoot);
  if (!resolved.ok) return resolved;
  const profile = resolved.profile;
  const privateEndpoints = profile.privacy.additionalPrivateEndpoints;
  if (isLoopback(profile.endpoint.href) && privateEndpoints.length === 0) return { ok: false, result: scanError('tunnel-endpoint-missing') };
  const credential = env.ANTHROPIC_API_KEY?.trim() ? env.ANTHROPIC_API_KEY : undefined;
  const digestKey = profile.endpointDigestKey === '' ? undefined : profile.endpointDigestKey;
  return {
    ok: true,
    needles: {
      endpoint: [profile.endpoint.href, ...privateEndpoints].flatMap(endpointNeedles),
      credential: credential === undefined ? undefined : new RegExp(escape(credential), 'u'),
      digestKey: digestKey === undefined ? undefined : new RegExp(escape(digestKey), 'u'),
      key: digestKey ?? '',
    },
  };
}

function leakAt(line: string, needles: Needles): LeakKind | undefined {
  if (needles.endpoint.some(needle => needle.test(line))) return 'ENDPOINT_LEAK';
  if (needles.credential?.test(line) === true) return 'CREDENTIAL_LEAK';
  return needles.digestKey?.test(line) === true ? 'DIGEST_KEY_LEAK' : undefined;
}

/**
 * The guard for a value the scanner derives rather than reads, such as the host template: `undefined`
 * when `text` carries no needle, otherwise the scan error to return instead of printing. The host
 * template is built, so it gets this one check rather than a leak report.
 */
export function needleGuard(text: string, env: RealTierEnvironment, repositoryRoot: string): ScanResult | undefined {
  const resolved = needlesOf(env, repositoryRoot);
  if (!resolved.ok) return resolved.result;
  return text.split(/\r?\n/u).some(line => leakAt(line, resolved.needles) !== undefined) ? scanError('template-needle') : undefined;
}

/** A path hit is a leak even when its content is clean: consult the raw and the decoded path. */
function pathLeak(path: string, needles: Needles): LeakKind | undefined {
  const direct = leakAt(path, needles);
  if (direct !== undefined) return direct;
  const decoded = percentDecoded(path);
  return decoded === path ? undefined : leakAt(decoded, needles);
}

/**
 * Decodes each segment on its own, so a malformed `%` in one segment cannot discard the valid
 * encoding of another: decoding a whole path would throw and lose every segment with it.
 */
function percentDecoded(path: string): string {
  return path
    .split('/')
    .map(segment => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment; // A stray `%` is not an encoding; the raw form was already scanned.
      }
    })
    .join('/');
}

/**
 * The plain relative path only when it reveals nothing and is printable; otherwise a location the
 * operator can match locally. The HMAC key exists exactly when a private-host needle does, so an
 * unkeyed digest never confirms a guessable path.
 */
function locationOf(path: string, needles: Needles): string {
  if (PRINTABLE.test(path) && pathLeak(path, needles) === undefined) return path;
  const key = needles.key;
  return `path-${key === '' ? 'sha256' : 'hmac'}:${(key === '' ? sha256Text(path) : createHmac('sha256', key).update(path, 'utf8').digest('hex')).slice(0, 12)}`;
}

/** A directory name no other path spells out is reported like a path hit. */
function scanPath(path: string, needles: Needles, lines: string[]): void {
  const kind = pathLeak(path, needles);
  if (kind !== undefined) lines.push(`${locationOf(path, needles)}:0 ${kind}`);
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
  // An ancestor name and a child path can spell the same hit; identical reports carry identical
  // information, so each is printed once. Distinct lines at one location stay distinct.
  const unique = [...new Set(lines)];
  if (unique.length > 0) return { exitCode: 1, output: [...unique, 'SCAN_LEAK'].join('\n') };
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

/** Every entry under `dir`, sorted so the report is stable; `undefined` on a failed walk. */
function entriesUnder(root: string): readonly Readonly<{ path: string; isFile: boolean }>[] | undefined {
  try {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .map(entry => ({ path: POSIX(relative(root, join(entry.parentPath, entry.name))), isFile: entry.isFile() }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  } catch {
    return undefined;
  }
}

const dirPrefix = (path: string): string => `${path}/`;

/**
 * Scans a directory of retained evidence recursively. Every file path and every file's contents are
 * checked, so each ancestor directory name is scanned (raw and per-segment decoded) as part of a
 * child's path, and a leaf directory name — one no other path spells out — is checked on its own. A
 * path hit is reported at line 0.
 */
export function scanDirectory(dir: string, options: ScanOptions): ScanResult {
  const resolved = needlesOf(options.env, options.repositoryRoot);
  if (!resolved.ok) return resolved.result;
  const root = resolve(dir);
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory() !== true) return scanError('directory-unreadable');
  const entries = entriesUnder(root);
  if (entries === undefined) return scanError('directory-unreadable');
  const paths = entries.map(entry => entry.path);
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile) {
      // A directory with any entry under it is spelled by that entry's path already.
      if (!paths.some(path => path.startsWith(dirPrefix(entry.path)))) scanPath(entry.path, resolved.needles, lines);
      continue;
    }
    const content = readOrError(join(root, entry.path));
    if (content === undefined) return scanError('file-unreadable');
    scanEntry(entry.path, content, resolved.needles, lines);
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

/** A `-z` listing, POSIX-normalized and sorted so the report is stable. */
function nulPaths(stdout: string | Buffer): readonly string[] {
  return textOf(stdout)
    .split('\0')
    .filter(path => path !== '')
    .map(POSIX)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Reads each path's blob at `revision` (`:` for the index, `<sha>:` for a commit) and scans it. */
async function scanBlobs(git: ScanGit, paths: readonly string[], revision: string, needles: Needles, lines: string[]): Promise<ScanResult | undefined> {
  for (const path of paths) {
    const blob = await git(['show', `${revision}${path}`]);
    if (!blob.ok) return scanError('blob-unreadable');
    scanEntry(path, textOf(blob.stdout), needles, lines);
  }
  return undefined;
}

/**
 * The one index pipeline: `--staged` and `--all` differ only in the listing that names the paths.
 * A blob read or git failure is a scan error, never a pass, and its raw child output is dropped.
 */
async function scanIndex(options: ScanOptions, listing: readonly string[]): Promise<ScanResult> {
  const resolved = needlesOf(options.env, options.repositoryRoot);
  if (!resolved.ok) return resolved.result;
  const git = options.git ?? createScanGit(options.cwd ?? process.cwd());
  const listed = await git(listing);
  if (!listed.ok) return scanError('git-failure');
  const lines: string[] = [];
  const failure = await scanBlobs(git, nulPaths(listed.stdout), ':', resolved.needles, lines);
  return failure ?? verdict(lines, resolved.needles.credential !== undefined);
}

/**
 * Scans exactly the candidate index. Deletions are skipped (their bytes are not in the candidate), and a
 * rename or copy is scanned under its new path only.
 */
export function scanStaged(options: ScanOptions): Promise<ScanResult> {
  return scanIndex(options, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
}

/**
 * Audits the whole index, which `--staged` cannot see: a needle added to the profile after a file was
 * committed is invisible to the per-commit check. Same needles, path rules and output contract.
 */
export function scanAll(options: ScanOptions): Promise<ScanResult> {
  return scanIndex(options, ['ls-files', '-z']);
}

/**
 * Scans every commit `base` does not contain, so a host removed by a later commit is still reported and a
 * commit message is scanned too. A merge commit's paths come from every parent (`-m`), deduplicated.
 */
export async function scanRange(options: ScanOptions, base: string): Promise<ScanResult> {
  const resolved = needlesOf(options.env, options.repositoryRoot);
  if (!resolved.ok) return resolved.result;
  const git = options.git ?? createScanGit(options.cwd ?? process.cwd());
  const listing = await git(['rev-list', `${base}..HEAD`]);
  if (!listing.ok) return scanError('git-failure');
  const lines: string[] = [];
  for (const sha of textOf(listing.stdout)
    .split('\n')
    .map(line => line.trim())
    .filter(sha => sha !== '')) {
    const message = await git(['log', '-1', '--format=%B', sha]);
    if (!message.ok) return scanError('git-failure');
    textOf(message.stdout)
      .split(/\r?\n/u)
      .forEach((line, index) => {
        const kind = leakAt(line, resolved.needles);
        if (kind !== undefined) lines.push(`commit-message:${sha}:${index + 1} ${kind}`);
      });
    // `-m` makes a merge list its blobs against each parent; without it a merge contributes no paths.
    const changed = await git(['diff-tree', '-m', '--root', '-r', '--no-commit-id', '--diff-filter=ACMR', '-z', '--name-only', sha]);
    if (!changed.ok) return scanError('git-failure');
    const failure = await scanBlobs(git, [...new Set(nulPaths(changed.stdout))], `${sha}:`, resolved.needles, lines);
    if (failure !== undefined) return failure;
  }
  return verdict(lines, resolved.needles.credential !== undefined);
}
