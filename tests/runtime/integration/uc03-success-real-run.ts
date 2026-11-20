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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
import {
  SAFE_ID,
  RECEIPT_SCHEMA,
  parseReceipt,
  sameBinding,
  writeCampaign,
  writeReceipt,
  type ArtifactBinding,
  type ConformanceReceipt,
  type PendingArtifact,
  type StageRecord,
} from './uc03-success-real-record.ts';
import { createOperatorDecisionSource, type OperatorIo } from './uc03-success-real-operator.ts';
import { pinnedGraderOf, type GraderCapability } from './uc03-success-real-grader.ts';
import { PINNED_MODEL, PINNED_RETURNED_MODEL } from './uc03-success-real-provider.ts';

const TEMPLATE_PROFILE_ID = 'uc03-runtime-evaluation-v1';
/** The T028 case plan, in contract order. */
const CAMPAIGN_CASES = ['C01', 'C02', 'C16', 'C10'] as const;

export type CampaignMode = 'campaign' | 'case' | 'resume';

export interface CampaignResult {
  /** 0 only when every stage passed; 2 for a prerequisite refusal or a failed stage. */
  readonly exitCode: 0 | 2;
  readonly records: readonly StageRecord[];
  readonly output: string;
  readonly campaignId: string;
  /** The exact directory this invocation wrote; the evidence checker accepts it or its parent. */
  readonly evidenceDir: string;
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
  /** The evidence directory. Every invocation creates its own fresh subdirectory here and never reuses one (SPEC-W5-105/207). */
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
  /** The operator's stdin/stdout, so a real campaign can present and record an explicit decision. */
  readonly operators?: OperatorIo | undefined;
  /** The live grader capabilities no pinned input can carry; absent keeps C01/C02 not-run. */
  readonly graderCapability?: GraderCapability | undefined;
  /** The graph entry the default case stage drives; the gate injects a double because no live model runs a controlled campaign. */
  readonly runGraph?: CaseStageOptions['runGraph'];
  /** Case stage seam; the operator entry wires the default stage. */
  readonly runCases?: ((assembly: RealTierAssembly, options: CaseStageOptions) => Promise<readonly CaseOutcome[]>) | undefined;
}

const RECEIPT = /^conformance-[A-Za-z0-9._-]+\.json$/u;

const stage = (name: StageRecord['stage'], outcome: StageRecord['outcome'], reasonCode?: string, extra: Partial<StageRecord> = {}): StageRecord => ({
  stage: name,
  outcome,
  ...(reasonCode === undefined ? {} : { reasonCode }),
  ...extra,
});

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

/**
 * An id no earlier invocation in this evidence directory used. The case or resume reference enters the
 * id only as a digest prefix: a reference is not a safe file name, and nothing may echo it.
 */
function freshCampaignId(options: CampaignOptions, startedAt: number): string {
  const subject = options.mode === 'campaign' ? 'all' : options.mode === 'case' ? (options.caseId ?? 'none') : sha256Text(options.resumeRef ?? '').slice(0, 12);
  const base = `campaign-${startedAt}-${options.mode}-${subject}`;
  let id = base;
  for (let n = 2; existsSync(join(options.evidenceDir, id)); n += 1) id = `${base}-${n}`;
  return id;
}

function dependenciesOf(options: CampaignOptions, candidateSha: string, fetchFn: typeof globalThis.fetch): RealTierDependencies {
  return {
    env: options.env,
    repositoryRoot: options.repositoryRoot,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
    fetch: fetchFn,
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    ...(candidateSha === '' ? {} : { revision: candidateSha }),
  };
}

/**
 * One conformance call through the injected fetch. It is an identity probe, not a graph dispatch:
 * the returned `model` must equal the pinned returned identity exactly, and every failure path yields one bounded
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
  return returned === PINNED_RETURNED_MODEL ? stage('conformance', 'pass') : stage('conformance', 'fail', 'conformance-model-mismatch');
}

/** A missing directory is no receipts; a present-but-unreadable or unshaped file is `malformed`. */
function readReceipts(evidenceDir: string): ConformanceReceipt[] | 'malformed' {
  if (!existsSync(evidenceDir)) return [];
  const receipts: ConformanceReceipt[] = [];
  for (const name of readdirSync(evidenceDir)
    .filter(entry => RECEIPT.test(entry))
    .sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(evidenceDir, name), 'utf8'));
    } catch {
      return 'malformed';
    }
    const receipt = parseReceipt(parsed);
    if (receipt === undefined) return 'malformed';
    receipts.push(receipt);
  }
  return receipts;
}

/**
 * The newest campaign for exactly this binding. A failed campaign supersedes an earlier passing one on
 * the same binding; a campaign on any other binding never decides.
 */
function latestFor(receipts: readonly ConformanceReceipt[], binding: ArtifactBinding): ConformanceReceipt | undefined {
  return receipts
    .filter(entry => sameBinding(entry.binding, binding))
    .sort((left, right) => left.finishedAt - right.finishedAt || (left.campaignId < right.campaignId ? -1 : 1))
    .at(-1);
}

/** The `--case` gate: no fetch and no preflight happens unless this returns `undefined`. */
function receiptGate(evidenceDir: string, binding: ArtifactBinding): string | undefined {
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
  const campaignId = freshCampaignId(options, startedAt);
  // Every invocation keeps its own directory under the evidence directory, so a later `--campaign`,
  // `--case` or `--resume` never overwrites an earlier observation (SPEC-W5-105/207). The receipts a
  // `--case` binds to stay in the evidence directory itself.
  const dir = join(options.evidenceDir, campaignId);
  const assemble = options.assemble ?? resolveRealTierAssembly;
  // Every dispatch through the assembled transport is counted here, so the C10 witness can disprove one.
  let dispatches = 0;
  const countedFetch: typeof globalThis.fetch = (...args) => {
    dispatches += 1;
    return (options.fetch ?? globalThis.fetch)(...args);
  };
  let bindings: Readonly<Record<string, string>> = {};
  const done = (records: readonly StageRecord[], passed: boolean, artifacts: readonly PendingArtifact[] = []): CampaignResult => {
    const record = writeCampaign(dir, { campaignId, candidateSha, mode: options.mode, passed, startedAt, finishedAt: clock(), bindings, records }, artifacts);
    return {
      exitCode: passed ? 0 : 2,
      records,
      output: JSON.stringify({ campaignId, candidateSha, evidenceDir: dir, records, caseArtifacts: record.caseArtifacts }, null, 2),
      campaignId,
      evidenceDir: dir,
    };
  };

  const resolved = assemble(dependenciesOf(options, candidateSha, countedFetch));
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

  const binding: ArtifactBinding = {
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
      schemaVersion: RECEIPT_SCHEMA,
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
    binding,
    fetches: () => dispatches,
    ...(options.runGraph === undefined ? {} : { runGraph: options.runGraph }),
    ...(grade === undefined ? {} : { grade }),
    ...(decideApproval === undefined ? {} : { decideApproval }),
    ...(options.mode === 'campaign' ? { clarificationHold: (id: string) => id === 'C02' } : {}),
  };
  const runCases = options.runCases ?? ((_: RealTierAssembly, stageOpts: CaseStageOptions) => defaultCaseStage(() => assemble(dependenciesOf(options, candidateSha, countedFetch)), stageOpts));
  const cases = await runCases(resolved, stageOptions);
  const records = cases.map(entry => entry.record);
  const artifacts = artifactsOf(cases);
  // Fail closed: every scheduled row must pass. A C16/C10 row this runner cannot observe stays
  // not-run, so the campaign is honest-incomplete and the checker refuses it — never a pass.
  const passed = records.length > 0 && records.every(entry => entry.outcome === 'pass');
  return done([stage('preflight', 'pass', undefined, { facts: graderFacts }), conformance, ...records], passed, artifacts);
}

function isDirectExecution(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && resolve(invoked) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  void import('./uc03-success-real-entry.ts').then(entry => entry.runOperatorEntry(process.argv.slice(2)));
}
