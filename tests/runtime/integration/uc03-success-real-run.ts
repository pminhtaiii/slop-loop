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
import { REAL_TIER_DELIVERY_CONTRACT, resolveRealTierAssembly, type RealTierAssembly, type RealTierDependencies } from '../../../src/runtime/real-tier-assembly.ts';
import type { RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { bindRealTierTask } from '../../../src/runtime/real-tier-task-binding.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { runUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import type { UC03HostInputs } from '../../../src/runtime/uc03-host-bootstrap.ts';
import type { SnapshotGradeResult, SnapshotPredicate } from '../../../eval/uc03/workflow-grade.ts';

const TEMPLATE_PROFILE_ID = 'uc03-runtime-evaluation-v1';
/** The one model identity the T028 campaign may certify: compared by exact equality, never trimmed. */
const PINNED_MODEL = 'po/deepseek-ai/deepseek-v4.1-flash-1017';
/** The T028 case plan, in contract order. */
export const CAMPAIGN_CASES = ['C01', 'C02', 'C16', 'C10'] as const;
/** The C01/C02 case predicates a pinned snapshot criterion supplies; C16/C10 are derived, never pinned. */
const PINS: Readonly<Record<string, SnapshotPredicate>> = Object.freeze({ C01: 'repair-success', C02: 'clarification' });

export type CampaignMode = 'campaign' | 'case' | 'resume';

/** One stage. `pass`/`fail` are judged facts; `not-run` is never a pass. */
export interface StageRecord {
  readonly stage: 'assembly' | 'preflight' | 'conformance' | 'receipt' | 'recovery' | 'case';
  readonly outcome: 'pass' | 'fail' | 'not-run';
  readonly reasonCode?: string | undefined;
  readonly caseId?: string | undefined;
  readonly facts?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

export interface CampaignResult {
  /** 0 only when every stage passed; 2 for a prerequisite refusal or a failed stage. */
  readonly exitCode: 0 | 2;
  readonly records: readonly StageRecord[];
  readonly output: string;
  readonly campaignId: string;
}

/**
 * One case's own evidence, host-only until projected. A graded case carries the independent receipt;
 * the approval trace records that a decision was explicit and through the T046 port, never automatic.
 */
export interface CaseEvidence {
  readonly snapshot?: Readonly<{ snapshotId: string; digest: string }> | undefined;
  readonly evidenceDigest?: string | undefined;
  readonly grade?: SnapshotGradeResult | undefined;
  readonly diffDigest?: string | undefined;
  readonly 'command-view-digest'?: string | undefined;
  readonly usage?: Readonly<Record<string, string | number>> | undefined;
  readonly 'owner-revisions'?: Readonly<Record<string, string>> | undefined;
  readonly approval?: Readonly<{ decisionId: string; decided: 'approve' | 'reject' }> | undefined;
}

export interface CaseOutcome {
  readonly record: StageRecord;
  readonly evidence?: CaseEvidence | undefined;
}

export interface CaseStageOptions {
  readonly caseIds: readonly string[];
  readonly repositoryRoot: string;
  readonly pins: UC03HostInputs['pins'];
  readonly identity: Readonly<Record<string, string>>;
  /** One case's evidence, from the catalog's own pinned grader material (SPEC-W5-003). */
  readonly grade?: ((assembly: RealTierAssembly, caseId: string) => Promise<SnapshotGradeResult | undefined>) | undefined;
  /**
   * The explicit T046 decision source (SPEC-W5-002): it presents the pause and returns the operator's
   * choice, or `undefined` when none was made. It never approves on its own.
   */
  readonly decideApproval?: ((assembly: RealTierAssembly, caseId: string) => Promise<'approve' | 'reject' | undefined>) | undefined;
  /** A task held for an expected clarification pause stays terminal (C02). */
  readonly clarificationHold?: ((caseId: string) => boolean) | undefined;
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
  /** Assembles one fresh host per case (SPEC-W5-004): an assembly holds one task for its life. */
  readonly assemble?: ((dependencies: RealTierDependencies) => ReturnType<typeof resolveRealTierAssembly>) | undefined;
  /** The catalog's pinned grader material (SPEC-W5-003); absent keeps a case not-run, never a pass. */
  readonly grade?: CaseStageOptions['grade'];
  /** The explicit T046 decision source (SPEC-W5-002); absent keeps a plan pause terminal. */
  readonly decideApproval?: CaseStageOptions['decideApproval'];
  /** Case stage seam; the operator entry wires `runCaseStage`. */
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

/** `assembly`/`not-run` with a bounded reason, shared by every case-stage refusal. */
const caseNotRun = (caseId: string, reasonCode: string, facts: StageRecord['facts'] = {}): CaseOutcome => ({ record: stage('case', 'not-run', reasonCode, { caseId, facts }) });

/**
 * One case attempt on its own fresh assembly, driven through the v0.2 graph entry. C01's plan pause is
 * presented and decided explicitly through the injected T046 decision source before the same bound task
 * continues (SPEC-W5-002, SPEC-W5-004); C02's expected clarification pause stays terminal. The case's
 * outcome is judged by the pinned snapshot grader over its own catalogue grader material
 * (SPEC-W5-003), never by the workflow status string alone.
 */
async function runCaseAttempt(
  assembly: RealTierAssembly,
  caseId: string,
  attempt: number,
  options: CaseStageOptions,
): Promise<CaseOutcome> {
  const binding = await bindRealTierTask(assembly, { caseId, pins: options.pins, identity: options.identity });
  if (binding.status !== 'task-bound') return caseNotRun(caseId, binding.reasonCode, { attempt });
  let result = await runUC03GraphV02(binding.task, binding.ports, binding.config);
  let approval: CaseEvidence['approval'];
  if (result.outcome === 'pending-approval' && !options.clarificationHold?.(caseId)) {
    // Nothing approves automatically: an absent source leaves the pause recorded, not passed.
    const decision = await options.decideApproval?.(assembly, caseId);
    if (decision === undefined) return { record: stage('case', 'fail', 'approval-required', { caseId, facts: { attempt, workflow: result.outcome, node: result.state?.node ?? 'none' } }) };
    approval = { decisionId: result.state?.activeDecisionId ?? '', decided: decision };
    // A rejection ends the case on its own hold; only approval continues the bound task.
    if (decision === 'approve') result = await runUC03GraphV02(binding.task, binding.ports, binding.config, result.state ?? undefined);
  }
  const owners = assembly.owners.taskOwners({ taskId: binding.ids.taskId, workspaceId: binding.ids.workspaceId, repositoryId: binding.task.repositoryId });
  const journal = owners.statePort.getJournalSnapshot(binding.ids.taskId) as { readonly claims?: readonly unknown[]; readonly attempts?: readonly unknown[]; readonly outcomes?: readonly unknown[] };
  const grade = PINS[caseId] === undefined ? undefined : await options.grade?.(assembly, caseId);
  const evidence: CaseEvidence = {
    ...(grade?.snapshot ? { snapshot: grade.snapshot } : {}),
    ...(grade?.evidenceDigest ? { evidenceDigest: grade.evidenceDigest } : {}),
    ...(grade ? { grade } : {}),
    ...(approval ? { approval } : {}),
  };
  const facts: Record<string, string | number | boolean | null> = {
    attempt,
    workflow: result.outcome,
    node: result.state?.node ?? 'none',
    claims: journal.claims?.length ?? 0,
    attempts: journal.attempts?.length ?? 0,
    outcomes: journal.outcomes?.length ?? 0,
    ...(approval ? { approval: approval.decided, decision: approval.decisionId } : {}),
    ...(grade ? { grade: grade.grade, 'grade-reason': grade.reason, 'grader-digest': grade.criteriaDigest } : {}),
  };
  // A pinned predicate is the independent grade, never the status string; an unpinned id is not-run.
  if (PINS[caseId] !== undefined && grade === undefined) return { record: stage('case', 'not-run', 'grader-unavailable', { caseId, facts }), evidence };
  const outcome: StageRecord['outcome'] = PINS[caseId] === undefined ? 'not-run' : grade?.grade === 'pass' ? 'pass' : grade?.grade === 'fail' ? 'fail' : 'not-run';
  return { record: stage('case', outcome, PINS[caseId] === undefined ? 'unpinned' : undefined, { caseId, facts }), evidence };
}

/**
 * The operator case stage: one fresh host assembly per case, so every case gets its own task/workspace
 * (SPEC-W5-004). C01 and C02 run real tasks once each (a failed attempt is retained, never replayed);
 * C16 is derived from the C01 run and C10 from its accounting (SPEC-W5-003). A derived row this stage
 * cannot judge from the C01 observation stays `not-run`, so the campaign is honest-incomplete.
 */
export async function runCaseStage(
  assemble: () => ReturnType<typeof resolveRealTierAssembly>,
  options: CaseStageOptions,
): Promise<readonly CaseOutcome[]> {
  const outcomes: CaseOutcome[] = [];
  const derivedFromC01 = new Map<string, CaseOutcome>();
  for (const caseId of options.caseIds) {
    if (!SAFE_ID.test(caseId)) {
      outcomes.push(caseNotRun(caseId, 'case-id-invalid'));
      continue;
    }
    if (caseId === 'C16' || caseId === 'C10') {
      outcomes.push(derivedFromC01.get(caseId) ?? caseNotRun(caseId, 'c01-unavailable', { derivedFrom: 'C01' }));
      continue;
    }
    const assembled = assemble();
    const outcome = assembled.status === 'assembly-ready' ? await runCaseAttempt(assembled, caseId, 1, options) : caseNotRun(caseId, assembled.reasonCode, { attempt: 1 });
    outcomes.push(outcome);
    if (caseId !== 'C01') continue;
    // C16: the safe report from the C01 run — its evidence digest and a bounded grade, never a payload.
    const c01Facts = outcome.record.facts ?? {};
    derivedFromC01.set('C16', {
      record: stage('case', outcome.record.outcome === 'pass' ? 'pass' : 'not-run', outcome.record.outcome === 'pass' ? undefined : 'c16-c01-unavailable', {
        caseId: 'C16',
        facts: { derivedFrom: 'C01', grade: c01Facts['grade'] ?? 'none', 'evidence-digest': outcome.evidence?.evidenceDigest ?? 'none' },
      }),
      ...(outcome.evidence ? { evidence: { ...outcome.evidence } } : {}),
    });
    // C10 needs a dedicated zero-dispatch-on-exhaustion witness that the C01 run does not produce, so
    // this stage reports it not-run with the observed accounting counts; it is never a guessed pass.
    derivedFromC01.set('C10', {
      record: stage('case', 'not-run', 'c10-not-observed', { caseId: 'C10', facts: { derivedFrom: 'C01', claims: c01Facts['claims'] ?? 0, outcomes: c01Facts['outcomes'] ?? 0 } }),
    });
  }
  return outcomes;
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
  const assemble = options.assemble ?? resolveRealTierAssembly;
  let bindings: Readonly<Record<string, string>> = {};
  const done = (records: readonly StageRecord[], passed: boolean, evidence: readonly CaseEvidence[] = []): CampaignResult => {
    const attemptIds = records.filter(entry => entry.stage === 'case' && entry.caseId !== undefined).map((entry, index) => `${entry.caseId ?? 'case'}-${index + 1}`);
    writeCampaignRecord(options.evidenceDir, { campaignId, candidateSha, mode: options.mode, passed, finishedAt: clock(), bindings, records, evidence, attemptIds });
    return { exitCode: passed ? 0 : 2, records, output: JSON.stringify({ campaignId, candidateSha, records }, null, 2), campaignId };
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
  // The real stage assembles a fresh host per case (SPEC-W5-004); an injected seam replaces the whole stage.
  const stageOptions: CaseStageOptions = {
    ...pins,
    caseIds,
    ...(options.grade === undefined ? {} : { grade: options.grade }),
    ...(options.decideApproval === undefined ? {} : { decideApproval: options.decideApproval }),
    ...(options.mode === 'campaign' ? { clarificationHold: (id: string) => id === 'C02' } : {}),
  };
  const runCases = options.runCases ?? ((_: RealTierAssembly, stageOpts: CaseStageOptions) => runCaseStage(() => assemble(dependenciesOf(options, candidateSha)), stageOpts));
  const cases = await runCases(resolved, stageOptions);
  const records = cases.map(entry => entry.record);
  const evidence = cases.map(entry => entry.evidence).filter((entry): entry is CaseEvidence => entry !== undefined);
  // Fail closed: every scheduled row must pass. A C16/C10 row this runner cannot observe stays
  // not-run, so the campaign is honest-incomplete and the checker refuses it — never a pass.
  const passed = records.length > 0 && records.every(entry => entry.outcome === 'pass');
  return done([stage('preflight', 'pass'), conformance, ...records], passed, evidence);
}

/** One sanitized, versioned campaign record plus its per-attempt case artifacts (SPEC-W5-005). */
function writeCampaignRecord(dir: string, input: Record<string, unknown> & { readonly attemptIds: readonly string[]; readonly records: readonly StageRecord[]; readonly evidence: readonly CaseEvidence[] }): void {
  mkdirSync(dir, { recursive: true });
  // The per-attempt artifacts carry each case's own evidence; the record carries only the run's facts.
  input.evidence.forEach((evidence, index) => writeFileSync(join(dir, `case-${input.attemptIds[index] ?? index}.json`), JSON.stringify(evidence, null, 2), 'utf8'));
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify({ ...input, schemaVersion: 'uc03-campaign-record/1', attemptIds: undefined, evidence: undefined }, null, 2), 'utf8');
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
