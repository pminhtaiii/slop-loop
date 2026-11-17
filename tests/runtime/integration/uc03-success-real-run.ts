/**
 * T028 real success campaign runner (real-tier contract §(f) T028 row, §(h); T059).
 *
 * `runCampaign(options)` is the campaign: the T060 operational preflight, exactly one conformance
 * call, then the case stage. Every external edge is injectable — `fetch`, `spawn`, the clock and the
 * case stage — so the CI-safe gate drives this file with doubles and no live call; the operator entry
 * at the bottom wires the real values.
 *
 * The conformance receipt binds `{candidateSha, profileDigest, endpointDigest, model}` and nothing
 * else. `--case` refuses with zero fetches unless the newest campaign on that exact binding
 * conformed. Records carry digests, bounded reason codes and bounded workflow facts only: never the
 * endpoint, its host or the credential.
 *
 * The case stage drives `runUC03GraphV02` on a task bound by `bindRealTierTask` — never the
 * evaluation service or `evaluate run`, which are T011's path. It records what the graph observed; a
 * case id with no predicate this runner can judge is recorded `not-run`, never a pass.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StructuredSpawn } from '../../../src/foundation/docker-controller.ts';
import { structuredSpawn } from '../../../src/foundation/docker-spawn.ts';
import { observeDockerReadiness, type DockerReadiness } from '../../../src/foundation/docker-readiness.ts';
import { gitHead } from '../../../src/runtime/git-head.ts';
import { REAL_TIER_DELIVERY_CONTRACT, resolveRealTierAssembly, type RealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import type { RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { bindRealTierTask } from '../../../src/runtime/real-tier-task-binding.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { runUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import type { UC03HostInputs } from '../../../src/runtime/uc03-host-bootstrap.ts';

const TEMPLATE_PROFILE_ID = 'uc03-runtime-evaluation-v1';
/** The T028 case plan, in contract order. */
export const CAMPAIGN_CASES = ['C01', 'C02', 'C16', 'C10'] as const;
/** The only case predicates this runner can judge without T054's grader payload. */
const PINS: Readonly<Record<string, readonly string[]>> = Object.freeze({ C01: ['COMPLETED'], C02: ['needs-info'] });

export type CampaignMode = 'campaign' | 'case' | 'resume';

/** One stage. `pass`/`fail` are judged facts; `not-run` is never a pass. */
export interface StageRecord {
  readonly stage: 'assembly' | 'preflight' | 'conformance' | 'receipt' | 'recovery' | 'case';
  readonly outcome: 'pass' | 'fail' | 'not-run';
  readonly reasonCode?: string | undefined;
  readonly caseId?: string | undefined;
  readonly facts?: Readonly<Record<string, string | number>> | undefined;
}

export interface CampaignResult {
  /** 0 only when every stage passed; 2 for a prerequisite refusal or a failed stage. */
  readonly exitCode: 0 | 2;
  readonly records: readonly StageRecord[];
  readonly output: string;
  readonly campaignId: string;
}

export interface CaseStageOptions {
  readonly caseIds: readonly string[];
  readonly repositoryRoot: string;
  readonly pins: UC03HostInputs['pins'];
  readonly identity: Readonly<Record<string, string>>;
}

export interface CampaignOptions {
  readonly mode: CampaignMode;
  /** Required for `case`; refused when absent. */
  readonly caseId?: string | undefined;
  /** Required for `resume`: the uncertain effect's owner operation ref. */
  readonly resumeRef?: string | undefined;
  readonly env: RealTierEnvironment;
  readonly repositoryRoot: string;
  readonly evidenceDir: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly spawn?: StructuredSpawn | undefined;
  /** Injected clock: receipt ordering is a fact the gate must control. */
  readonly clock?: (() => number) | undefined;
  readonly preflight?: (() => Promise<DockerReadiness>) | undefined;
  /** Pinned delivery revision; the operator's host.json supplies it in T054. */
  readonly candidateSha?: string | undefined;
  readonly stateRoot?: string | undefined;
  /** Case stage seam; the operator entry wires `runCampaignCases`. */
  readonly runCases?: ((assembly: RealTierAssembly, options: CaseStageOptions) => Promise<readonly StageRecord[]>) | undefined;
}

/** The receipt's binding: exactly the four pinned identities the contract names. */
export interface ConformanceBinding {
  readonly candidateSha: string;
  readonly profileDigest: string;
  readonly endpointDigest: string;
  readonly model: string;
}

export interface ConformanceReceipt {
  readonly schemaVersion: 'uc03-conformance-receipt/1';
  readonly campaignId: string;
  readonly binding: ConformanceBinding;
  readonly outcome: 'conformed' | 'failed';
  readonly reasonCode?: string;
  readonly finishedAt: number;
}

const RECEIPT = /^conformance-[A-Za-z0-9._-]+\.json$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/** An owner operation ref, in the canonical safe-reference shape (`uc04-journal:<id>` and friends). */
const OPERATION_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;

const stage = (name: StageRecord['stage'], outcome: StageRecord['outcome'], reasonCode?: string, extra: Partial<StageRecord> = {}): StageRecord => ({
  stage: name,
  outcome,
  ...(reasonCode === undefined ? {} : { reasonCode }),
  ...extra,
});

function defaultEvidenceDir(now: number): string {
  return join('.agent-work', new Date(now).toISOString().slice(0, 10), 'uc03-real-tier', 'evidence', 'T054');
}

/** Host pins and identity the T057 template derives, so a campaign binds without a host file. */
function hostPinsOf(assembly: RealTierAssembly): Pick<CaseStageOptions, 'pins' | 'identity'> {
  const { profile } = assembly;
  return {
    pins: {
      contractVersion: REAL_TIER_DELIVERY_CONTRACT,
      revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, assembly.revision])),
    },
    identity: {
      profileId: TEMPLATE_PROFILE_ID,
      profileDigest: `sha256:${profile.profileDigest}`,
      configDigest: `sha256:${sha256Text(JSON.stringify({ limits: profile.limits, runLimits: profile.runLimits }))}`,
      pricingDigest: `sha256:${sha256Text(JSON.stringify(profile.pricing))}`,
    },
  };
}

function dependenciesOf(options: CampaignOptions, candidateSha: string): Parameters<typeof resolveRealTierAssembly>[0] {
  return {
    env: options.env,
    repositoryRoot: options.repositoryRoot,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    ...(candidateSha === '' ? {} : { revision: candidateSha }),
  };
}

/**
 * One conformance call through the injected fetch. It is an identity probe, not a graph dispatch:
 * the returned `model` must equal the pinned id exactly, and every failure path yields one bounded
 * reason code — never the endpoint, the status body or the credential.
 */
async function conformanceCall(assembly: RealTierAssembly, fetchFn: typeof globalThis.fetch): Promise<StageRecord> {
  const { endpoint, credential, limits } = assembly.profile;
  const body = JSON.stringify({
    model: endpoint.model,
    max_tokens: 16,
    stream: false,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
  });
  let response: Response;
  try {
    response = await fetchFn(endpoint.href, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': credential },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(limits.providerTimeoutMs),
    });
  } catch (error) {
    // A throw here may follow a dispatch, so it is classified, never retried.
    const timeout = typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TimeoutError';
    return stage('conformance', 'fail', timeout ? 'conformance-timeout' : 'conformance-unreachable');
  }
  if (response.status >= 300 && response.status < 400) return stage('conformance', 'fail', 'conformance-redirect');
  if (response.status === 429) return stage('conformance', 'fail', 'conformance-rate-limited');
  if (!response.ok) return stage('conformance', 'fail', 'conformance-http-error', { facts: { status: response.status } });
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    return stage('conformance', 'fail', 'conformance-malformed');
  }
  const returned = typeof parsed === 'object' && parsed !== null ? (parsed as { model?: unknown }).model : undefined;
  // A different identity string is the operator's to resolve, so the campaign stops rather than adapting.
  return typeof returned === 'string' && returned.trim() === endpoint.model ? stage('conformance', 'pass') : stage('conformance', 'fail', 'conformance-model-mismatch');
}

function writeReceipt(evidenceDir: string, receipt: ConformanceReceipt): void {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, `conformance-${receipt.campaignId}.json`), JSON.stringify(receipt, null, 2), 'utf8');
}

function isBinding(value: unknown): value is ConformanceBinding {
  const v = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  return v !== undefined && ['candidateSha', 'profileDigest', 'endpointDigest', 'model'].every(key => typeof v[key] === 'string');
}

/** A missing directory is no receipts; a present-but-unreadable or unshaped file is `malformed`. */
function readReceipts(evidenceDir: string): ConformanceReceipt[] | 'malformed' {
  let names: string[];
  try {
    names = readdirSync(evidenceDir);
  } catch {
    return [];
  }
  const receipts: ConformanceReceipt[] = [];
  for (const name of names.filter(entry => RECEIPT.test(entry)).sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(evidenceDir, name), 'utf8'));
    } catch {
      return 'malformed';
    }
    const value = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    if (
      value?.['schemaVersion'] !== 'uc03-conformance-receipt/1' ||
      typeof value['campaignId'] !== 'string' ||
      !SAFE_ID.test(value['campaignId']) ||
      (value['outcome'] !== 'conformed' && value['outcome'] !== 'failed') ||
      typeof value['finishedAt'] !== 'number' ||
      !Number.isSafeInteger(value['finishedAt']) ||
      !isBinding(value['binding'])
    ) {
      return 'malformed';
    }
    receipts.push({
      schemaVersion: 'uc03-conformance-receipt/1',
      campaignId: value['campaignId'],
      binding: value['binding'] as ConformanceBinding,
      outcome: value['outcome'],
      ...(typeof value['reasonCode'] === 'string' ? { reasonCode: value['reasonCode'] } : {}),
      finishedAt: value['finishedAt'],
    });
  }
  return receipts;
}

/**
 * The newest campaign for exactly this binding. A failed campaign supersedes an earlier passing one on
 * the same binding; a campaign on any other binding never decides.
 */
function latestFor(receipts: readonly ConformanceReceipt[], binding: ConformanceBinding): ConformanceReceipt | undefined {
  const wanted = JSON.stringify(binding);
  return receipts
    .filter(entry => JSON.stringify(entry.binding) === wanted)
    .sort((left, right) => left.finishedAt - right.finishedAt || (left.campaignId < right.campaignId ? -1 : 1))
    .at(-1);
}

/** The `--case` gate: no fetch and no preflight happens unless this returns `undefined`. */
function receiptGate(evidenceDir: string, binding: ConformanceBinding): string | undefined {
  const receipts = readReceipts(evidenceDir);
  if (receipts === 'malformed') return 'receipt-malformed';
  const latest = latestFor(receipts, binding);
  if (latest === undefined) return 'receipt-missing';
  return latest.outcome === 'conformed' ? undefined : 'receipt-stale';
}

/** `not-run` for a binding refusal or an unpinned case id; otherwise the pinned predicate decides. */
function predicateOf(caseId: string, workflow: string): StageRecord['outcome'] {
  const expected = PINS[caseId];
  return expected === undefined ? 'not-run' : expected.includes(workflow) ? 'pass' : 'fail';
}

/**
 * The operator case stage: one bound task per case, the v0.2 graph entry, and the journal counts the
 * C10 row needs. C01 gets at most two attempts; because an assembly claims one task for its life,
 * the retry needs a fresh assembly from `retryAssembly`, and without one the second attempt is not
 * run rather than replayed on a bound assembly.
 */
export async function runCampaignCases(assembly: RealTierAssembly, options: CaseStageOptions, retryAssembly?: () => RealTierAssembly): Promise<readonly StageRecord[]> {
  const records: StageRecord[] = [];
  for (const caseId of options.caseIds) {
    if (!SAFE_ID.test(caseId)) {
      records.push(stage('case', 'not-run', 'case-id-invalid'));
      continue;
    }
    const attempts = caseId === 'C01' ? 2 : 1;
    let latest: StageRecord | undefined;
    let retryNotice: StageRecord | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1 && retryAssembly === undefined) {
        retryNotice = stage('case', 'not-run', 'retry-unavailable', { caseId, facts: { attempt } });
        break;
      }
      const current = attempt === 1 || retryAssembly === undefined ? assembly : retryAssembly();
      const binding = await bindRealTierTask(current, { caseId, pins: options.pins, identity: options.identity });
      if (binding.status !== 'task-bound') {
        records.push(stage('case', 'not-run', binding.reasonCode, { caseId, facts: { attempt } }));
        break;
      }
      const result = await runUC03GraphV02(binding.task, binding.ports, binding.config);
      const owners = current.owners.taskOwners({ taskId: binding.ids.taskId, workspaceId: binding.ids.workspaceId, repositoryId: binding.task.repositoryId });
      const journal = owners.statePort.getJournalSnapshot(binding.ids.taskId) as { readonly claims?: readonly unknown[]; readonly attempts?: readonly unknown[]; readonly outcomes?: readonly unknown[] };
      latest = stage('case', predicateOf(caseId, result.outcome), undefined, {
        caseId,
        facts: {
          attempt,
          workflow: result.outcome,
          node: result.state?.node ?? 'none',
          claims: journal.claims?.length ?? 0,
          attempts: journal.attempts?.length ?? 0,
          outcomes: journal.outcomes?.length ?? 0,
        },
      });
      if (latest.outcome === 'pass') break;
    }
    // The observed attempt comes first; a refused retry is reported after it, never in its place.
    if (latest !== undefined) records.push(latest);
    if (retryNotice !== undefined) records.push(retryNotice);
  }
  return records;
}

/**
 * One campaign stage sequence. It stops at the first refusing prerequisite, so a preflight or
 * conformance failure leaves zero case dispatches behind it.
 */
export async function runCampaign(options: CampaignOptions): Promise<CampaignResult> {
  const clock = options.clock ?? Date.now;
  const candidateSha = options.candidateSha ?? gitHead(options.repositoryRoot);
  const startedAt = clock();
  const campaignId = `campaign-${startedAt}-${options.mode}-${options.caseId ?? options.resumeRef ?? 'all'}`;
  const done = (records: readonly StageRecord[], passed: boolean): CampaignResult => ({
    exitCode: passed ? 0 : 2,
    records,
    output: JSON.stringify({ campaignId, candidateSha, records }, null, 2),
    campaignId,
  });

  const resolved = resolveRealTierAssembly(dependenciesOf(options, candidateSha));
  if (resolved.status !== 'assembly-ready') return done([stage('assembly', 'fail', resolved.reasonCode)], false);
  const assembly = resolved;

  // A resume consults its owner before anything else; a blocked uncertain effect performs nothing.
  if (options.mode === 'resume') {
    const decision = await assembly.owners.recoveryGate.decide(options.resumeRef ?? '');
    return decision === 'resume' ? done([stage('recovery', 'pass')], false) : done([stage('recovery', 'fail', `continuation-${decision}`)], false);
  }

  const binding: ConformanceBinding = {
    candidateSha,
    profileDigest: assembly.metadata.profileDigest,
    endpointDigest: assembly.metadata.endpointDigest,
    model: assembly.metadata.model,
  };
  if (options.mode === 'case') {
    const refused = receiptGate(options.evidenceDir, binding);
    if (refused !== undefined) return done([stage('receipt', 'fail', refused)], false);
  }

  const spawn = options.spawn ?? structuredSpawn;
  const preflight = options.preflight ?? (() => observeDockerReadiness(spawn, assembly.metadata.imageId));
  const observed = await preflight();
  if (!observed.ok) return done([stage('preflight', 'fail', observed.reasonCode)], false);

  let conformance: StageRecord;
  if (options.mode === 'campaign') {
    conformance = await conformanceCall(assembly, options.fetch ?? globalThis.fetch);
    writeReceipt(options.evidenceDir, {
      schemaVersion: 'uc03-conformance-receipt/1',
      campaignId,
      binding,
      outcome: conformance.outcome === 'pass' ? 'conformed' : 'failed',
      ...(conformance.reasonCode === undefined ? {} : { reasonCode: conformance.reasonCode }),
      finishedAt: clock(),
    });
    if (conformance.outcome !== 'pass') return done([stage('preflight', 'pass'), conformance], false);
  } else {
    conformance = stage('conformance', 'pass', undefined, { facts: { binding: 'receipt' } });
  }

  const caseIds = options.mode === 'campaign' ? CAMPAIGN_CASES : options.caseId === undefined ? [] : [options.caseId];
  if (caseIds.length === 0 || caseIds.some(id => !SAFE_ID.test(id))) return done([stage('preflight', 'pass'), conformance, stage('case', 'not-run', 'case-id-invalid')], false);
  const runCases = options.runCases ?? ((host: RealTierAssembly, stageOptions: CaseStageOptions) => runCampaignCases(host, stageOptions));
  const cases = await runCases(assembly, { caseIds, repositoryRoot: options.repositoryRoot, ...hostPinsOf(assembly) });
  return done([stage('preflight', 'pass'), conformance, ...cases], cases.length > 0 && cases.every(entry => entry.outcome === 'pass'));
}

/** Flags whose value is the next argument; anything else is rejected rather than defaulted. */
const FLAGS = new Set(['--campaign', '--case', '--resume', '--evidence']);

export interface ParsedCampaignArgs {
  readonly mode: CampaignMode;
  readonly caseId?: string | undefined;
  readonly resumeRef?: string | undefined;
  readonly evidenceDir: string;
}

/** The operator's argv. A malformed invocation is a `refused` reason, never a default campaign. */
export function parseCampaignArgs(args: readonly string[]): ParsedCampaignArgs | { readonly refused: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] as string;
    if (!FLAGS.has(flag)) return { refused: 'arguments' };
    if (values.has(flag)) return { refused: 'arguments' };
    if (flag === '--campaign') {
      values.set(flag, '');
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) return { refused: 'arguments' };
    values.set(flag, value);
    index += 1;
  }
  const caseId = values.get('--case');
  const resumeRef = values.get('--resume');
  const mode: CampaignMode | undefined = values.has('--campaign') ? 'campaign' : resumeRef !== undefined ? 'resume' : caseId !== undefined ? 'case' : undefined;
  // Exactly one mode: a campaign with a case/resume flag is ambiguous, and so is a case with a resume ref.
  const flags = [values.has('--campaign'), caseId !== undefined, resumeRef !== undefined].filter(Boolean).length;
  if (mode === undefined || flags !== 1) return { refused: 'arguments' };
  if (mode === 'resume' && !OPERATION_REF.test(resumeRef ?? '')) return { refused: 'arguments' };
  if (mode === 'case' && !SAFE_ID.test(caseId ?? '')) return { refused: 'arguments' };
  return {
    mode,
    ...(caseId === undefined ? {} : { caseId }),
    ...(resumeRef === undefined ? {} : { resumeRef }),
    evidenceDir: values.get('--evidence') ?? defaultEvidenceDir(Date.now()),
  };
}

function isDirectExecution(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && resolve(invoked) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  const parsed = parseCampaignArgs(process.argv.slice(2));
  if ('refused' in parsed) {
    process.stdout.write(`CAMPAIGN_REFUSED ${parsed.refused}\n`);
    process.exitCode = 2;
  } else {
    void runCampaign({ ...parsed, env: process.env, repositoryRoot: process.cwd() }).then(result => {
      process.stdout.write(`${result.output}\n`);
      process.exitCode = result.exitCode;
    });
  }
}
