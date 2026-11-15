/**
 * Operator entry for the G-PRIVACY endpoint scanner (T057, contract §(d)/§(i)).
 *
 * Modes: `--staged` scans the candidate index, `--all` audits the whole index, `--range <base>` scans
 * every commit the base does not contain, `--dir <path>` scans retained evidence, and
 * `--print-host-template` prints the host.json template with computed digests. Every mode resolves
 * the endpoint through `loadRealTierProfile`, so no argument supplies a needle. Output is the
 * scanner's quiet report only; nothing here echoes argv, the profile or a child-process error.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createScanGit,
  needleGuard,
  resolveScanProfile,
  scanAll,
  scanDirectory,
  scanError,
  scanRange,
  scanStaged,
  type ScanGit,
  type ScanOptions,
  type ScanResult,
} from '../runtime/real-tier-endpoint-scan.ts';
import type { RealTierProfile } from '../runtime/real-tier-profile.ts';
import { sha256Text } from '../uc01/contracts.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../uc03/graph-types-v02.ts';

export type RealTierScanCliOptions = Readonly<{ env: ScanOptions['env']; repositoryRoot: string; cwd?: string | undefined; git?: ScanGit | undefined }>;

const TEMPLATE_PROFILE_ID = 'uc03-runtime-evaluation-v1';
const TEMPLATE_ASSEMBLY = 'dist/src/runtime/real-tier-assembly.js';
const TEMPLATE_ADAPTERS = ['uc03-real-tier/1'];
const TEMPLATE_CONTRACT = 'uc03-host-composition/2';

function parse(args: readonly string[]): Readonly<{ mode: 'staged' | 'all' | 'template' } | { mode: 'dir'; path: string } | { mode: 'range'; base: string }> | undefined {
  if (args.length === 1 && (args[0] === '--staged' || args[0] === '--all' || args[0] === '--print-host-template')) {
    const mode = args[0] === '--print-host-template' ? 'template' : args[0] === '--all' ? 'all' : 'staged';
    return { mode };
  }
  if (args.length === 2 && args[0] === '--dir' && args[1] !== undefined && args[1] !== '' && !args[1].startsWith('--')) return { mode: 'dir', path: args[1] };
  if (args.length === 2 && args[0] === '--range' && args[1] !== undefined && args[1] !== '' && !args[1].startsWith('--')) return { mode: 'range', base: args[1] };
  return undefined;
}

/**
 * The contract §(i) host.json. Digests come from the loaded profile and the revisions from
 * `git rev-parse HEAD`; the endpoint itself never appears, only its digest inside `profileDigest`.
 * A model id may itself be a URL or a credential, so the serialized template is checked against the
 * scanner's needles and refused as a fixed error code rather than printed.
 */
async function hostTemplate(profile: RealTierProfile, git: ScanGit, scan: ScanOptions): Promise<ScanResult> {
  const head = await git(['rev-parse', 'HEAD']);
  if (!head.ok) return scanError('git-failure');
  const revision = (typeof head.stdout === 'string' ? head.stdout : head.stdout.toString('utf8')).trim();
  const template = {
    profileId: TEMPLATE_PROFILE_ID,
    profileDigest: `sha256:${profile.profileDigest}`,
    // The configuration identity covers the numeric limits and the run limits; the endpoint stays in profileDigest.
    configDigest: `sha256:${sha256Text(JSON.stringify({ limits: profile.limits, runLimits: profile.runLimits }))}`,
    pricingDigest: `sha256:${sha256Text(JSON.stringify(profile.pricing))}`,
    requestedModel: profile.endpoint.model,
    adapterVersions: TEMPLATE_ADAPTERS,
    contractVersion: TEMPLATE_CONTRACT,
    revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, revision])),
    assembly: TEMPLATE_ASSEMBLY,
  };
  const serialized = JSON.stringify(template, null, 2);
  // The guard uses the profile the template was built from, never a reopen: a profile rewritten between
  // the git call and the guard would otherwise be checked against needles that do not cover this output.
  return needleGuard(serialized, profile, scan.env) ?? { exitCode: 0, output: serialized };
}

/** Parses one mode and runs it. A malformed mode is a scan error, never a default pass. */
export async function runRealTierScanCli(args: readonly string[], options: RealTierScanCliOptions): Promise<ScanResult> {
  const parsed = parse(args);
  if (parsed === undefined) return scanError('arguments');
  const scanOptions: ScanOptions = {
    env: options.env,
    repositoryRoot: options.repositoryRoot,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.git === undefined ? {} : { git: options.git }),
  };
  if (parsed.mode === 'dir') return scanDirectory(parsed.path, scanOptions);
  if (parsed.mode === 'staged') return scanStaged(scanOptions);
  if (parsed.mode === 'all') return scanAll(scanOptions);
  if (parsed.mode === 'range') return scanRange(scanOptions, parsed.base);
  const resolved = resolveScanProfile(options.env, options.repositoryRoot);
  if (!resolved.ok) return resolved.result;
  return hostTemplate(resolved.profile, options.git ?? createScanGit(options.cwd ?? process.cwd()), scanOptions);
}

function isDirectExecution(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && resolve(invokedPath) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  void runRealTierScanCli(process.argv.slice(2), { env: process.env, repositoryRoot: process.cwd() })
    .then(result => {
      process.stdout.write(`${result.output}\n`);
      process.exitCode = result.exitCode;
    })
    .catch(() => {
      process.stderr.write('real-tier scan failed; exception details are not included\n');
      process.exitCode = 2;
    });
}
