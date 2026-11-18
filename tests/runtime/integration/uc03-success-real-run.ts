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

import { structuredSpawn } from '../../../src/foundation/docker-spawn.ts';
import type { StructuredSpawn } from '../../../src/foundation/docker-controller.ts';
import { observeDockerReadiness, type DockerReadiness } from '../../../src/foundation/docker-readiness.ts';
import { gitHead } from '../../../src/runtime/git-head.ts';
import { REAL_TIER_DELIVERY_CONTRACT, resolveRealTierAssembly, type RealTierAssembly, type RealTierDependencies } from '../../../src/runtime/real-tier-assembly.ts';
import type { RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';

import { artifactsOf, runCaseStage as defaultCaseStage, type CaseOutcome, type CaseStageOptions } from './uc03-success-real-run-cases.ts';
import { SAFE_ID, type PendingArtifact, type StageRecord, writeCampaign } from './uc03-success-real-record.ts';
import { createOperatorDecisionSource, stdioOperator, type OperatorIo } from './uc03-success-real-operator.ts';
import { resolvePinnedGrader, type GraderCapability } from './uc03-success-real-grader.ts';

export type { CaseOutcome, CaseStageOptions } from './uc03-success-real-run-cases.ts';
export { runCaseStage } from './uc03-success-real-run-cases.ts';
export type { CaseEvidence, StageRecord } from './uc03-success-real-record.ts';

const TEMPLATE_PROFILE_ID = 'uc03-runtime-evaluation-v1';
/** The one model identity the T028 campaign may certify: compared by exact equality, never trimmed. */
const PINNED_MODEL = 'po/deepseek-ai/deepseek-v4.1-flash-1017';
/** The T028 case plan, in contract order. */
export const CAMPAIGN_CASES = ['C01', 'C02', 'C16', 'C10'] as const;

export type CampaignMode = 'campaign' | 'case' | 'resume';

export interface CampaignResult {
  /** 0 only when every stage passed; 2 for a prerequisite refusal or a failed stage. */
  readonly exitCode: 0 | 2;
  readonly records: readonly StageRecord[];
  readonly output: string;
  readonly campaignId: string;
}

/**
 * The campaign seam: what the run stage accepts. The case evidence types and the case stage itself
 * live in their own modules; this keeps the operator entry and the gate driving the same surface.
 */
export interface CampaignOptions {
  readonly mode: CampaignMode;
  /** Required for `case`; refused when absent. */
  readonly caseId?: string | undefined;
  /** Required for `resume`: the uncertain effect's owner operation ref. */
  readonly resumeRef?: string | undefined;
  readonly env: RealTierEnvironment;
  readonly repositoryRoot: string;
  /** The campaign directory. A `campaign` run creates a fresh subdirectory here (SPEC-W5-105). */
  readonly evidenceDir: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly spawn?: StructuredSpawn | undefined;
  /** Injected clock: receipt ordering is a fact the gate must control. */
  readonly clock?: (() => number) | undefined;
  readonly preflight?: (() => Promise<DockerReadiness>) | undefined;
  /** Pinned delivery revision; the operator's host.json supplies it in T054. */
  readonly candidateSha?: string | undefined;
  readonly stateRoot?: string | undefined;
  /** Assembles one fresh host per case (SPEC-W5-004): an assembly holds one task for its life. */
  readonly assemble?: ((dependencies: RealTierDependencies) => ReturnType<typeof resolveRealTierAssembly>) | undefined;
  /** The catalog's pinned grader material (SPEC-W5-003); absent keeps a case not-run, never a pass. */
  readonly grade?: CaseStageOptions['grade'];
  /** The explicit T046 decision source (SPEC-W5-002); absent keeps a plan pause terminal. */
  readonly decideApproval?: CaseStageOptions['decideApproval'];
  /** The case stage's fetch counter, so the C10 witness can prove the refusal made no dispatch. */
  readonly fetches?: (() => number) | undefined;
  /** The operator's stdin/stdout, so a real campaign can present and record an explicit decision. */
  readonly operators?: OperatorIo | undefined;
  /** The two live grader capabilities no pinned input can carry; absent keeps C01/C02 not-run. */
  readonly graderCapability?: GraderCapability | undefined;
  /** Case stage seam; the operator entry wires the default stage. */
  readonly runCases?: ((assembly: RealTierAssembly, options: CaseStageOptions) => Promise<readonly CaseOutcome[]>) | undefined;
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

function dependenciesOf(options: CampaignOptions, candidateSha: string): RealTierDependencies {
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
  // A profile that selects any identity but the contract's pinned one stops before the case stage.
  if (endpoint.model !== PINNED_MODEL) return stage('conformance', 'fail', 'conformance-model-mismatch');
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
  // Exact equality: a whitespace-wrapped or otherwise near-identical id is still a different identity.
  return returned === endpoint.model ? stage('conformance', 'pass') : stage('conformance', 'fail', 'conformance-model-mismatch');
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

/**
 * One campaign stage sequence. It stops at the first refusing prerequisite, so a preflight or
 * conformance failure leaves zero case dispatches behind it. Every terminal path writes the required
 * sanitized campaign record and its referenced artifacts into the evidence directory (SPEC-W5-005).
 */
export async function runCampaign(options: CampaignOptions): Promise<CampaignResult> {
  const clock = options.clock ?? Date.now;
  const candidateSha = options.candidateSha ?? gitHead(options.repositoryRoot);
  const startedAt = clock();
  const campaignId = `campaign-${startedAt}-${options.mode}-${options.caseId ?? options.resumeRef ?? 'all'}`;
  // Every campaign keeps its own directory, so a later run never overwrites an earlier observation
  // (SPEC-W5-105). A `case` run binds to the latest receipt, which stays in the directory it was found.
  const dir = options.mode === 'campaign' ? join(options.evidenceDir, campaignId) : options.evidenceDir;
  const assemble = options.assemble ?? resolveRealTierAssembly;
  let bindings: Readonly<Record<string, string>> = {};
  const done = (records: readonly StageRecord[], passed: boolean, artifacts: readonly PendingArtifact[] = []): CampaignResult => {
    const record = writeCampaign(
      dir,
      { campaignId, candidateSha, mode: options.mode, passed, startedAt, finishedAt: clock(), bindings, records },
      artifacts,
    );
    return { exitCode: passed ? 0 : 2, records, output: JSON.stringify({ campaignId, candidateSha, records, caseArtifacts: record.caseArtifacts }, null, 2), campaignId };
  };

  const resolved = assemble(dependenciesOf(options, candidateSha));
  if (resolved.status !== 'assembly-ready') return done([stage('assembly', 'fail', resolved.reasonCode)], false);
  bindings = {
    'candidate-sha': candidateSha,
    'profile-digest': resolved.metadata.profileDigest,
    'endpoint-digest': resolved.metadata.endpointDigest,
    model: resolved.metadata.model,
    image: resolved.metadata.imageId,
    scheme: resolved.metadata.endpointScheme,
  };

  // A resume is a read-only admission query over the owner record (§(h)): `resume` permits a later
  // continuation and exits 0; `fresh-attempt` is not replay authority and `blocked` stays nonzero.
  // Neither branch performs any effect.
  if (options.mode === 'resume') {
    const decision = await resolved.owners.recoveryGate.decide(options.resumeRef ?? '');
    if (decision === 'resume') return done([stage('recovery', 'pass', undefined, { facts: { decision } })], true);
    if (decision === 'fresh-attempt') return done([stage('recovery', 'not-run', 'continuation-fresh-attempt', { facts: { decision } })], false);
    return done([stage('recovery', 'fail', `continuation-${decision}`, { facts: { decision } })], false);
  }

  const binding: ConformanceBinding = {
    candidateSha,
    profileDigest: resolved.metadata.profileDigest,
    endpointDigest: resolved.metadata.endpointDigest,
    model: resolved.metadata.model,
  };
  if (options.mode === 'case') {
    const refused = receiptGate(options.evidenceDir, binding);
    if (refused !== undefined) return done([stage('receipt', 'fail', refused)], false);
  }

  const spawn = options.spawn ?? structuredSpawn;
  const preflight = options.preflight ?? (() => observeDockerReadiness(spawn, resolved.metadata.imageId));
  const observed = await preflight();
  if (!observed.ok) return done([stage('preflight', 'fail', observed.reasonCode)], false);

  let conformance: StageRecord;
  if (options.mode === 'campaign') {
    conformance = await conformanceCall(resolved, options.fetch ?? globalThis.fetch);
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
  const pins = { repositoryRoot: options.repositoryRoot, ...hostPinsOf(resolved) };
  // The operator entry wires the real decision source and grader; an injected seam replaces either.
  const decideApproval = options.decideApproval ?? (options.operators === undefined ? undefined : createOperatorDecisionSource(options.operators));
  const grader = options.grade === undefined ? pinnedGraderOf(options, resolved) : { grade: options.grade, facts: {} };
  const grade = grader.grade;
  // A grader this runner cannot build is a retained fact, not just a console line: the evidence
  // reader must see which pinned input was missing (SPEC-W5-102).
  const graderFacts = grader.facts;
  // The real stage assembles a fresh host per case (SPEC-W5-004); an injected seam replaces the whole stage.
  const stageOptions: CaseStageOptions = {
    ...pins,
    caseIds,
    campaignId,
    ...(grade === undefined ? {} : { grade }),
    ...(decideApproval === undefined ? {} : { decideApproval }),
    ...(options.mode === 'campaign' ? { clarificationHold: (id: string) => id === 'C02' } : {}),
    ...(options.fetches === undefined ? {} : { fetches: options.fetches }),
  };
  const runCases = options.runCases ?? ((_: RealTierAssembly, stageOpts: CaseStageOptions) => defaultCaseStage(() => assemble(dependenciesOf(options, candidateSha)), stageOpts));
  const cases = await runCases(resolved, stageOptions);
  const records = cases.map(entry => entry.record);
  const artifacts = artifactsOf(cases);
  // Fail closed: every scheduled row must pass. A C16/C10 row this runner cannot observe stays
  // not-run, so the campaign is honest-incomplete and the checker refuses it — never a pass.
  const passed = records.length > 0 && records.every(entry => entry.outcome === 'pass');
  return done([stage('preflight', 'pass', undefined, { facts: graderFacts }), conformance, ...records], passed, artifacts);
}

/**
 * The pinned grader and the facts that explain it. A ready grader yields the seam with no facts; an
 * unavailable one yields no seam and the bounded reason plus the exact missing inputs, which the
 * campaign record then carries so the refusal is visible to an evidence reader (SPEC-W5-102). No
 * grade is ever invented.
 */
function pinnedGraderOf(options: CampaignOptions, assembly: RealTierAssembly): { grade: CaseStageOptions['grade']; facts: Readonly<Record<string, string>> } {
  const resolution = resolvePinnedGrader(assembly, 'C01', options.graderCapability);
  if (resolution.status === 'ready') {
    // C02 is a different case with its own pinned criterion; resolve each from the same material.
    const c02 = resolvePinnedGrader(assembly, 'C02', options.graderCapability);
    return {
      grade: async (_assembly: RealTierAssembly, caseId: string) => (caseId === 'C01' ? resolution.grade(caseId) : c02.status === 'ready' ? c02.grade(caseId) : undefined),
      facts: {},
    };
  }
  options.operators?.write(`T054: grader unavailable (${resolution.reasonCode}); missing: ${resolution.missing.join(', ')}.`);
  return { grade: undefined, facts: { 'grader-status': 'unavailable', 'grader-reason': resolution.reasonCode, 'grader-missing': resolution.missing.join(',') } };
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
    // The operator entry wires the real one-everything: stdin decisions, the real fetch, and a
    // dispatch counter the C10 witness reads. The grader's two live capabilities are not wired here
    // because no production isolation authority or grader executor exists outside the controlled
    // tests; absent them, `pinnedGraderOf` prints the missing inputs and C01/C02 stay not-run.
    let fetches = 0;
    const countedFetch: typeof globalThis.fetch = async (...args) => {
      fetches += 1;
      return globalThis.fetch(...args);
    };
    void runCampaign({
      ...parsed,
      env: process.env,
      repositoryRoot: process.cwd(),
      fetch: countedFetch,
      fetches: () => fetches,
      operators: stdioOperator(),
    }).then(result => {
      process.stdout.write(`${result.output}\n`);
      process.exitCode = result.exitCode;
    });
  }
}
