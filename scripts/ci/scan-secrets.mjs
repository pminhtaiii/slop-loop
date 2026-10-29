import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Adapter around one pinned Gitleaks CLI release. Everything here reports only rule id, path, line
// and commit; raw matches, secret fields and scanner stdout/stderr never leave this module.
export const GITLEAKS_VERSION = '8.30.1';
export const RELEASE = Object.freeze({
  version: GITLEAKS_VERSION,
  baseUrl: `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}`,
  checksums: `gitleaks_${GITLEAKS_VERSION}_checksums.txt`,
  asset: `gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`,
});
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;
export const SCAN_TIMEOUT_MS = 120_000;
const VERSION = /^(\d+\.\d+\.\d+)$/;
const REVISION = /^[0-9a-f]{7,64}$/i;
const ZERO = /^0+$/;
const RULE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const PRINTABLE = /^[\x20-\x7e]{1,512}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// A local binary from another release (for example 8.18.4) must never satisfy the adapter.
export function assertPinnedVersion(version) {
  const match = typeof version === 'string' ? VERSION.exec(version.trim().replace(/^v/, '')) : null;
  if (!match || match[1] !== GITLEAKS_VERSION) {
    throw new Error(`This adapter requires exactly ${GITLEAKS_VERSION}; refusing ${typeof version === 'string' ? 'an unpinned binary' : 'an unknown binary'}.`);
  }
  return match[1];
}

export function verifyChecksum({ bytes, expected }) {
  return createHash('sha256').update(bytes).digest('hex') === String(expected).toLowerCase();
}

function manifestDigest(manifest, asset) {
  for (const line of String(manifest).split('\n')) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (match && match[2] === asset) return match[1].toLowerCase();
  }
  throw new Error(`Release checksum manifest does not list ${asset}.`);
}

export function installGitleaks({ release = RELEASE, download, readChecksums }) {
  if (!release || release.version !== GITLEAKS_VERSION || release.baseUrl !== RELEASE.baseUrl || release.asset !== RELEASE.asset) {
    throw new Error(`Unsupported Gitleaks release; only v${GITLEAKS_VERSION} is admissible.`);
  }
  let bytes;
  try {
    bytes = download(`${release.baseUrl}/${release.asset}`);
  } catch (error) {
    throw new Error(`Pinned Gitleaks download failed: ${error.code ?? 'network error'}`, { cause: error });
  }
  let manifest;
  try {
    manifest = readChecksums(`${release.baseUrl}/${release.checksums}`);
  } catch (error) {
    throw new Error(`Pinned Gitleaks checksum manifest failed: ${error.code ?? 'network error'}`, { cause: error });
  }
  const sha256 = manifestDigest(manifest, release.asset);
  if (!verifyChecksum({ bytes, expected: sha256 })) throw new Error(`Gitleaks release checksum mismatch for ${release.asset}.`);
  return { asset: release.asset, sha256, version: release.version };
}

// Admitted range or an explicit unavailable-range fallback; the tree scan is never skipped.
export function planScanRanges({ event, head, base, before, available = () => true }) {
  const target = revision(head, 'head');
  if (event === 'pull_request') {
    if (typeof base !== 'string' || !base) throw new Error('A pull request scan requires an admitted base revision.');
    // Validate before any probe: the availability callback hands the value to git argv.
    const from = revision(base, 'base');
    if (ZERO.test(from) || !available(from)) throw new Error('The admitted base revision is unavailable; the pull request range cannot be scanned.');
    return { mode: 'tree-plus-range', ranges: [{ from, to: target }] };
  }
  if (typeof before !== 'string' || !before || ZERO.test(before)) return { mode: 'tree-only-with-range-unavailable', ranges: [] };
  const from = revision(before, 'before');
  if (!available(from)) return { mode: 'tree-only-with-range-unavailable', ranges: [] };
  return { mode: 'tree-plus-range', ranges: [{ from, to: target }] };
}

function revision(value, field) {
  if (typeof value !== 'string' || !REVISION.test(value) || ZERO.test(value)) {
    throw new Error(`Rejected unsafe ${field} revision; admitted scans accept only hexadecimal object names.`);
  }
  return value;
}

export function scanArgs({ snapshot, from, to, reportPath, configPath, ignorePath }) {
  // The config and ignore inputs are trusted workspace paths, never candidate content. A missing value
  // would silently restore the candidate-controlled defaults (its .gitleaks.toml, allow comments), so it
  // fails closed instead of omitting the flag.
  for (const path of [configPath, ignorePath]) {
    if (typeof path !== 'string' || !path) throw new Error('A trusted Gitleaks config and ignore path are required.');
  }
  const common = ['--config', configPath, '--gitleaks-ignore-path', ignorePath, '--ignore-gitleaks-allow', '--report-format', 'json', '--report-path', reportPath, '--redact=100', '--no-banner', '--exit-code', '1'];
  return from && to ? ['git', snapshot, '--log-opts', `${from}..${to}`, ...common] : ['dir', snapshot, ...common];
}

export function readReport(path, maxBytes = MAX_REPORT_BYTES) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new Error('Gitleaks report could not be read.');
  }
  if (stats.size > maxBytes) throw new Error(`Gitleaks report exceeded the bounded size limit of ${maxBytes} bytes.`);
  return readFileSync(path, 'utf8');
}

function defaultExecute({ binary, args, cwd, reportPath }) {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', windowsHide: true, shell: false, timeout: SCAN_TIMEOUT_MS, maxBuffer: MAX_REPORT_BYTES });
  if (result.error) throw result.error;
  return { status: result.status, report: existsSync(reportPath) ? readReport(reportPath) : undefined, args };
}

export function scanOnce({ kind, snapshot, range, binary, workdir, reportDir = workdir, configPath, ignorePath, execute }) {
  // The report name is derived from the scan kind, not passed in: both scans share one workspace, and
  // a caller that reused one name would let a failed range scan read the tree scan's stale report.
  const reportPath = join(reportDir, `${kind}.json`);
  const args = scanArgs({ snapshot, from: range?.from, to: range?.to, reportPath, configPath, ignorePath });
  let outcome;
  try {
    outcome = (execute ?? defaultExecute)({ binary, args, cwd: workdir, reportPath });
  } catch (error) {
    if (error.code === 'ETIMEDOUT' || error.code === 'ABORT_ERR') throw new Error(`Gitleaks ${kind} scan timed out after ${SCAN_TIMEOUT_MS}ms.`, { cause: error });
    if (error.code === 'ENOENT' || error.code === 'EACCES') throw new Error('Gitleaks could not be executed.', { cause: error });
    throw new Error(`Gitleaks ${kind} scan failed to execute: ${error.code ?? 'unknown error'}`, { cause: error });
  }
  return { status: outcome.status, report: outcome.report, args };
}

// A `dir` scan prefixes every File with the snapshot argument while a `git` scan reports repo-relative
// paths, so the snapshot is stripped before reporting. A path that still leaves the scanned snapshot is
// a scanner anomaly, not an exemptable finding, so it fails closed.
function snapshotPath(path, snapshot) {
  if (typeof snapshot === 'string' && snapshot) {
    for (const separator of ['/', '\\']) {
      if (path.startsWith(snapshot + separator)) { path = path.slice(snapshot.length + 1); break; }
    }
  }
  if (!path || isAbsolute(path) || path.startsWith('/') || path.includes('..') || !PRINTABLE.test(path)) throw new Error('Gitleaks produced malformed output; refusing to report it.');
  return path;
}

function summary(finding, snapshot) {
  const ruleId = finding?.RuleID;
  const path = finding?.File;
  const line = finding?.StartLine;
  const commit = finding?.Commit ?? '';
  const secret = finding?.Secret;
  const leak = typeof secret === 'string' && secret.length > 0 && [ruleId, path, commit, finding?.Description].some((value) => typeof value === 'string' && value.includes(secret));
  if (leak) throw new Error('Gitleaks output failed redaction; refusing to report it.');
  if (typeof ruleId !== 'string' || !RULE_ID.test(ruleId)) throw new Error('Gitleaks produced malformed output; refusing to report it.');
  if (typeof path !== 'string') throw new Error('Gitleaks produced malformed output; refusing to report it.');
  const reported = snapshotPath(path, snapshot);
  if (!Number.isInteger(line) || line < 1 || line > 1_000_000) throw new Error('Gitleaks produced malformed output; refusing to report it.');
  if (typeof commit !== 'string' || (commit !== '' && !COMMIT.test(commit))) throw new Error('Gitleaks produced malformed output; refusing to report it.');
  return { ruleId, path: reported, line, commit };
}

// Exit 0 is clean, exit 1 means the report holds findings; anything else is an execution failure.
export function parseFindings({ status, report }, snapshot) {
  if (status !== 0 && status !== 1) throw new Error(`Gitleaks exited with non-report exit status ${String(status)}.`);
  if (typeof report !== 'string') throw new Error('Gitleaks did not produce a report.');
  let parsed;
  try {
    parsed = JSON.parse(report);
  } catch {
    throw new Error('Gitleaks produced malformed output; refusing to report it.');
  }
  if (!Array.isArray(parsed)) throw new Error('Gitleaks produced malformed output; refusing to report it.');
  return parsed.map((finding) => summary(finding, snapshot));
}

const keyOf = (finding) => `${finding.ruleId}\0${finding.path}\0${finding.line}\0${finding.commit}`;

function validateExemption(exemption) {
  const fail = (detail) => {
    throw new Error(`Reviewed exemption is invalid: ${detail}`);
  };
  if (!exemption || typeof exemption !== 'object') fail('not an object');
  if (typeof exemption.ruleId !== 'string' || !RULE_ID.test(exemption.ruleId)) fail('rule id must be exact');
  if (typeof exemption.path !== 'string' || !PRINTABLE.test(exemption.path) || !exemption.path.includes('/') || /[*?]/.test(exemption.path) || exemption.path.startsWith('/') || exemption.path.includes('..') || exemption.path.endsWith('/')) {
    fail('path must name one exact file, never a directory or glob');
  }
  if (!Number.isInteger(exemption.line) || exemption.line < 1) fail('line must be a positive integer');
  if (typeof exemption.commit !== 'string' || (exemption.commit !== '' && !COMMIT.test(exemption.commit))) fail('commit must be empty or a full hexadecimal object name');
  if (typeof exemption.reason !== 'string' || exemption.reason.trim().length < 10) fail('reason must record the review');
  return keyOf(exemption);
}

// Exemptions are fingerprinted to one exact finding; a nearby unapproved finding still fails.
export function applyExemptions(findings, exemptions = []) {
  const exempt = new Set();
  for (const exemption of exemptions) {
    const key = validateExemption(exemption);
    if (exempt.has(key)) throw new Error('Duplicate reviewed exemption for the same finding.');
    exempt.add(key);
  }
  return findings.filter((finding) => !exempt.has(keyOf(finding)));
}

export function runSecretScan({ plan, snapshot, scan, exemptions = [] }) {
  const findings = [];
  findings.push(...parseFindings(scan({ kind: 'tree', snapshot }), snapshot));
  for (const range of plan.ranges) findings.push(...parseFindings(scan({ kind: 'range', snapshot, range }), snapshot));
  const unique = [...new Map(findings.map((finding) => [keyOf(finding), finding])).values()];
  return { mode: plan.mode, findings: applyExemptions(unique, exemptions) };
}

function git(root, args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, ...options });
}

// The scan reads an isolated checkout of the admitted head, not the author's working tree.
export function createSnapshot({ root, head, directory }) {
  git(root, ['worktree', 'add', '--detach', directory, revision(head, 'head')]);
  // A checked-out .gitleaksignore is read by Gitleaks regardless of --gitleaks-ignore-path, so a
  // candidate that adds one would suppress its own findings. The snapshot is a throwaway detached
  // worktree, so deleting from it changes nothing in the candidate's repository.
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if ((entry.isFile() || entry.isSymbolicLink()) && entry.name === '.gitleaksignore') rmSync(join(entry.parentPath, entry.name), { force: true });
  }
  return directory;
}

export function removeSnapshot({ root, directory }) {
  try {
    git(root, ['worktree', 'remove', '--force', directory]);
  } catch {
    git(root, ['worktree', 'prune']);
  }
}

const USAGE = 'Usage: node scripts/ci/scan-secrets.mjs --event <pull_request|push|workflow_dispatch> --head <sha> [--base <sha>] [--before <sha>] [--root <checkout>] [--exemptions <json>] [--gitleaks <binary>] [--install-dir <dir>]';
const FLAGS = new Set(['--event', '--head', '--base', '--before', '--root', '--exemptions', '--gitleaks', '--install-dir']);

export function parseScanArgs(argv) {
  const args = {};
  if (!Array.isArray(argv) || argv.length === 0 || argv.length % 2 !== 0) throw new Error(USAGE);
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!FLAGS.has(flag) || typeof value !== 'string' || !value) throw new Error(USAGE);
    args[flag.slice(2)] = value;
  }
  if (!['pull_request', 'push', 'workflow_dispatch'].includes(args.event) || !args.head) throw new Error(USAGE);
  return args;
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw Object.assign(new Error('download failed'), { code: `HTTP ${response.status}` });
  return Buffer.from(await response.arrayBuffer());
}

async function setupGitleaks(directory) {
  const bytes = await download(`${RELEASE.baseUrl}/${RELEASE.asset}`);
  const manifest = (await download(`${RELEASE.baseUrl}/${RELEASE.checksums}`)).toString('utf8');
  installGitleaks({ release: RELEASE, download: () => bytes, readChecksums: () => manifest });
  const archive = join(directory, RELEASE.asset);
  writeFileSync(archive, bytes);
  // ponytail: relies on the CI image's tar; add an archive dependency only if the Linux job lacks it.
  execFileSync('tar', ['-xzf', archive, '-C', directory, 'gitleaks'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 60_000 });
  const binary = join(directory, 'gitleaks');
  chmodSync(binary, 0o755);
  return binary;
}

async function main(argv) {
  const args = parseScanArgs(argv);
  const root = resolve(args.root ?? process.cwd());
  const binary = args.gitleaks ? pinnedLocalBinary(args.gitleaks) : await setupGitleaks(args['install-dir'] ?? mkdtempSync(join(tmpdir(), 'gitleaks-')));
  const plan = planScanRanges({
    event: args.event,
    head: args.head,
    base: args.base,
    before: args.before,
    available: (rev) => revisionExists(root, rev),
  });
  const exemptions = args.exemptions ? JSON.parse(readFileSync(args.exemptions, 'utf8')) : [];
  if (!Array.isArray(exemptions)) throw new Error('Reviewed exemptions must be a JSON array.');
  const workspace = mkdtempSync(join(tmpdir(), 'gitleaks-scan-'));
  const directory = join(workspace, 'tree');
  try {
    // Trusted scanner inputs live beside the tree, never inside it: the tree is the candidate snapshot.
    // Extending the default config reproduces the default rule set, so the flags only take away the
    // candidate's ability to override rules, ignore findings or allow them inline.
    const configPath = join(workspace, 'gitleaks.toml');
    writeFileSync(configPath, '[extend]\nuseDefault = true\n');
    const ignorePath = join(workspace, 'gitleaks-ignore');
    writeFileSync(ignorePath, '');
    createSnapshot({ root, head: args.head, directory });
    // Reports live outside the scanned tree so analyzer output cannot become candidate content.
    const scan = (spec) => scanOnce({ ...spec, binary, workdir: directory, reportDir: workspace, configPath, ignorePath });
    const result = runSecretScan({ plan, snapshot: directory, scan, exemptions });
    console.log(JSON.stringify(result));
    if (result.findings.length) process.exitCode = 1;
  } finally {
    removeSnapshot({ root, directory });
    rmSync(workspace, { recursive: true, force: true });
  }
}

// A provided binary is admissible only when it actually reports the pinned release.
function pinnedLocalBinary(path) {
  let version;
  try {
    version = execFileSync(path, ['version'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000 });
  } catch (error) {
    throw new Error('Gitleaks could not be executed.', { cause: error });
  }
  assertPinnedVersion(version);
  return path;
}

export function revisionExists(root, from) {
  // Existence, not ancestry: on a pull_request event BASE_SHA is the base branch tip, so a PR branch
  // that is behind has a valid base..head range without being a descendant of the base.
  try {
    git(root, ['cat-file', '-e', `${from}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
