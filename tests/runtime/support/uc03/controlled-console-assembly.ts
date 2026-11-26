/**
 * Controlled runnable assembly for the UC-03 operator console (`evaluate.js serve --host <file>`).
 *
 * Composes an in-process, zero-credential, zero-Docker evaluation host with real port provenance
 * (`ready`) backed by an in-process DeepSeek transport `fetch`, isolated per-experiment `TaskSession`
 * state/repository/approval stores, owner material replan transactions, and catalog/custom routes.
 *
 * Operator token handling:
 * - Reads `UC03_CONSOLE_OPERATOR_TOKEN` when set (must be 16..512 printable ASCII characters), or
 *   generates a 48-hex-character (`randomBytes(24)`) token per assembly process.
 * - Prints the active operator token once to `process.stderr` when the console starts. Never writes
 *   the token to `stdout`, JSON reports, or `host.json`.
 */

// shortcut: duplicates small catalog/profile/completion builders from evaluation-console-journey.test.ts; deduplicate after PR #275 merges.

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  computeRequestContentDigest,
  CONTRACT_VERSION,
  type ApprovalBinding,
  type ApprovalBindingContext,
  type ApprovalPort,
  type BugTask,
  type ContextualApprovalVerifierV02,
  type NormalizedAction,
  type ProviderPricingIdentityV02,
  type ProviderRequest,
  type RepositoryPortV02,
  type StatePortV02,
  type StateTransitionOptions,
  type TaskState,
} from '../../../../src/contracts/foundation/uc03.ts';
import { createDeepSeekTransport, DEEPSEEK_REVIEW_PROMPT } from '../../../../src/foundation/deepseek-transport.ts';
import { createExecutionGuardV02 } from '../../../../src/foundation/execution-guard.ts';
import { createGuardedReadCapability, type GuardedReadControlObservation } from '../../../../src/foundation/guarded-read-capability.ts';
import { computeContextDigest } from '../../../../src/foundation/model.ts';
import { HostModelPortV02 } from '../../../../src/foundation/model-v02.ts';
import type { ExecutionGuardReadCapability } from '../../../../src/foundation/repository-types.ts';
import { reviewerContextDigest } from '../../../../src/foundation/reviewer.ts';
import type { HostAssembly } from '../../../../src/cli/evaluate.ts';
import { createBaselineEvidenceAdapter } from '../../../../src/runtime/baseline-evidence-adapter.ts';
import type { EvaluationConsoleAssembly, EvaluationConsoleConfiguration, EvaluationConsoleFactory } from '../../../../src/runtime/evaluation-console-host.ts';
import type { UC03EvaluationGraphRoute } from '../../../../src/runtime/evaluation-graph.ts';
import { admitEvaluationProfile, type CatalogEntry, type EvaluationProfile } from '../../../../src/runtime/evaluation-profile.ts';
import type { ServiceControlReceipt } from '../../../../src/runtime/evaluation-service.ts';
import type { UC03HostPins } from '../../../../src/runtime/uc03-host-bootstrap.ts';
import { sha256Text } from '../../../../src/uc01/contracts.ts';
import { currentPlanBindingDigest } from '../../../../src/uc03/graph-validation.ts';
import {
  UC03_PRODUCTION_COMPONENTS_V02,
  type MaterialReplanPortV02,
  type MaterialReplanRequestV02,
  type UC03GraphConfigV02,
  type UC03ProductionComponentV02,
  type UC03ReviewerModelPortV02,
} from '../../../../src/uc03/graph-types-v02.ts';
import type { UC03CompletionContextRequest, UC03TrustedCompletion } from '../../../../src/uc03/graph-types.ts';
import type { BaselineEvidenceAcknowledgement, BaselineEvidenceCandidate, TrustedHostExpectedContext, TrustedHostPort, TrustedHostSnapshot } from '../../../../src/uc03/investigation.ts';
import type { TrustedReplanDirection } from '../../../../src/uc03/repair-types.ts';
import { FakeRepositoryPort } from './fake-repository.ts';
import { createGraphRepositoryPort, createGraphTaskState, seedGraphTaskState } from './graph-fixtures.ts';
import { MemoryStatePortV02 } from './memory-state.ts';
import { createFixtureBugTask, createFixtureCheckDefinition, createFixtureExecutorIdentityV02, createFixturePolicyAuthorityRefV02, createFixtureProviderAdmissionReceiptV02 } from './port-fixtures.ts';
import { ScriptedApprovalPort } from './scripted-approval.ts';
import {
  createTestProviderAdmissionContextV02,
  createTestProviderAdmissionTrustedContextV02,
  createTestProviderRequest,
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryAdmissionTrustedContextV02,
  createTestRepositoryCommandAdmissionContextV02,
} from './state-fixtures.ts';

export const CONTROLLED_CONSOLE_REPOSITORY_ID = 'repo-calc';
export const CONTROLLED_CONSOLE_CHECK_SET = 'checks-configured';
export const CONTROLLED_CONSOLE_MODEL = 'controlled-model';
export const CONTROLLED_CONSOLE_CONTRACT_VERSION = 'uc03-owner-delivery/1';
export const CONTROLLED_CONSOLE_TOKEN_ENV = 'UC03_CONSOLE_OPERATOR_TOKEN';
export const CONTROLLED_CONSOLE_ENDPOINT = 'https://api.deepseek.com/v1/messages';
export const CONTROLLED_CONSOLE_ADAPTER_VERSION = 'controlled-console-adapter-1';

const TOKEN_PATTERN = /^[\x21-\x7e]{16,512}$/u;
const INITIAL_SOURCE_TEXT = 'def divide(a, b): return a / b\n';
const PROTECTED_TEST_TEXT = 'def test_divide(): pass\n';
const REPRO_COMMAND = 'pytest -q tests/test_calculator.py -k test_divide_zero';
const REGRESSION_COMMAND = 'pytest -q tests/test_calculator.py';

const PATCH_DIFF = [
  '--- a/src/calculator.py',
  '+++ b/src/calculator.py',
  '@@ -1,1 +1,3 @@',
  '-def divide(a, b): return a / b',
  '+def divide(a, b):',
  '+    if b == 0: raise CalculationError("denominator must be non-zero")',
  '+    return a / b',
  '',
].join('\n');

const REPAIR_DIFF = [
  '--- a/src/calculator.py',
  '+++ b/src/calculator.py',
  '@@ -1,3 +1,3 @@',
  ' def divide(a, b):',
  '     if b == 0: raise CalculationError("denominator must be non-zero")',
  '-    return a / b',
  '+    return a / b  # repair: guard reviewed',
  '',
].join('\n');

const DEFAULT_PROFILE_LIMITS: EvaluationProfile['limits'] = {
  totalModelCalls: 24,
  inputTokensPerRequest: 32768,
  outputTokensPerRequest: 8192,
  providerTimeoutMs: 60000,
  activeExecutionMs: 900000,
  repairs: 2,
  reviewerIterations: 2,
  materialReplans: 3,
  commandTimeoutMs: 30000,
  outputBytes: 1048576,
  memoryBytes: 2147483648,
  cpus: 2,
  processes: 64,
};

export const CONTROLLED_CONSOLE_PIN_REVISIONS: Readonly<Record<UC03ProductionComponentV02, string>> = Object.freeze(
  Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, sha256Text(`controlled-console-pin-${component}`)])) as Record<UC03ProductionComponentV02, string>,
);

export const CONTROLLED_CONSOLE_PINS: UC03HostPins = Object.freeze({
  contractVersion: CONTROLLED_CONSOLE_CONTRACT_VERSION,
  revisions: CONTROLLED_CONSOLE_PIN_REVISIONS,
});

export interface ControlledCatalogEntryOptions {
  readonly catalogEntryId: string;
  readonly caseId: string;
  readonly version?: string | undefined;
  readonly caseDigest: string;
  readonly publicTaskDigest: string;
  readonly initialRepositoryDigest: string;
  readonly fixturePath: string;
  readonly fixtureDigest: string;
  readonly graderVersion?: string | undefined;
  readonly graderDigest: string;
  readonly graderPath: string;
}

/** Build a deterministic admitted catalog entry for controlled console hosts and tests. */
export function createControlledCatalogEntry(options: ControlledCatalogEntryOptions): CatalogEntry {
  return {
    catalogEntryId: options.catalogEntryId,
    caseId: options.caseId,
    version: options.version ?? '1.0.0',
    caseDigest: options.caseDigest,
    publicTaskDigest: options.publicTaskDigest,
    initialRepositoryDigest: options.initialRepositoryDigest,
    fixturePath: options.fixturePath,
    fixtureDigest: options.fixtureDigest,
    grader: {
      version: options.graderVersion ?? '1.0.0',
      digest: options.graderDigest,
      path: options.graderPath,
    },
  };
}

export interface ControlledAdmittedProfileOptions {
  readonly catalog: readonly CatalogEntry[];
  readonly credentialRef: string;
  readonly codeDigest: string;
  readonly configDigest: string;
  readonly imageDigest: string;
  readonly adapterVersions: readonly string[];
  readonly pricingId?: string | undefined;
  readonly model?: string | undefined;
  readonly limits?: EvaluationProfile['limits'] | undefined;
}

export interface ControlledAdmittedProfile {
  readonly catalog: readonly CatalogEntry[];
  readonly profile: EvaluationProfile;
  readonly configuration: EvaluationConsoleConfiguration & { readonly identity: Readonly<Record<string, string>> };
}

/** Admit an evaluation profile and derive the matching console configuration projection. */
export function createControlledAdmittedProfile(options: ControlledAdmittedProfileOptions): ControlledAdmittedProfile {
  const admitted = admitEvaluationProfile({
    endpoint: CONTROLLED_CONSOLE_ENDPOINT,
    model: options.model ?? CONTROLLED_CONSOLE_MODEL,
    mode: 'nonstreaming',
    credentialRef: options.credentialRef,
    codeDigest: options.codeDigest,
    configDigest: options.configDigest,
    imageDigest: options.imageDigest,
    platform: 'linux/amd64',
    adapterVersions: options.adapterVersions,
    pricing: { pricingId: options.pricingId ?? 'controlled-price-1', inputRate: 1, outputRate: 1, cacheRate: 0, overheadRate: 0, denominator: 1 },
    limits: options.limits ?? DEFAULT_PROFILE_LIMITS,
    catalog: options.catalog,
  });
  if (!admitted.ok) {
    throw new Error(`Controlled evaluation profile admission failed: ${admitted.reasonCode}`);
  }
  const profile = admitted.value;
  return {
    catalog: options.catalog,
    profile,
    configuration: {
      identity: { profileId: profile.profileId, profileDigest: profile.profileDigest, configDigest: profile.configDigest, pricingDigest: profile.pricingDigest },
      profileDigest: profile.profileDigest,
      configDigest: profile.configDigest,
      pricingDigest: profile.pricingDigest,
      requestedModel: profile.model,
      adapterVersions: profile.adapterVersions,
    },
  };
}

/** Mint and store owner completion context for each Deliver transition stateVersion. */
export function createControlledCompletionContextFor(
  completionContexts: Map<number, NonNullable<StateTransitionOptions['trusted']>>,
): (input: UC03CompletionContextRequest) => Promise<UC03TrustedCompletion | undefined> {
  return async (input: UC03CompletionContextRequest): Promise<UC03TrustedCompletion | undefined> => {
    const record: UC03TrustedCompletion = {
      taskId: input.task.taskId,
      runId: input.state.runId,
      repositoryRevisionDigest: input.state.repositoryRevisionDigest,
      diffDigest: input.diffInfo.diffDigest,
      checkSetDigest: input.checkSetDigest,
      baselineRef: input.baseline.evidenceId,
      criteriaDigest: computeCanonicalSha256(input.task.acceptanceCriteria),
      authorizedDiffDigest: input.diffInfo.diffDigest,
      protectedTestsDigest: input.protectedTestsDigest,
      originalProtectedTestsDigest: input.originalProtectedTestsDigest,
      reviewerRoleConfigId: input.reviewResult.reviewerRoleConfigId,
      reviewIterationReservationRef: input.reviewRequest.reservationRef,
      checks: input.verificationResults,
      review: input.reviewResult,
    };
    const prior = completionContexts.get(input.state.stateVersion);
    if (prior) return structuredClone(prior.completion);
    completionContexts.set(input.state.stateVersion, { completion: structuredClone(record) });
    return record;
  };
}

function resolveRepoRoot(): string {
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(cursor, 'eval', 'uc03', 'manifest.json')) && existsSync(join(cursor, 'eval', 'uc03', 'workflow-grade.ts'))) {
      return cursor;
    }
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error('HOST_REPO_ROOT_NOT_FOUND');
}

function defaultCatalogEntries(initialRevisionDigest: string): readonly CatalogEntry[] {
  const repoRoot = resolveRepoRoot();
  const fixturePath = join(repoRoot, 'eval', 'uc03', 'manifest.json');
  const graderPath = join(repoRoot, 'eval', 'uc03', 'workflow-grade.ts');
  const cleanInitial = initialRevisionDigest.replace(/^sha256:/u, '');
  return Object.freeze([
    createControlledCatalogEntry({
      catalogEntryId: 'entry-C01-controlled',
      caseId: 'C01',
      caseDigest: sha256Text('controlled-case-C01'),
      publicTaskDigest: sha256Text('controlled-task-C01'),
      initialRepositoryDigest: cleanInitial,
      fixturePath,
      fixtureDigest: sha256Text('controlled-fixture-C01'),
      graderDigest: sha256Text('controlled-grader-C01'),
      graderPath,
    }),
    createControlledCatalogEntry({
      catalogEntryId: 'entry-C02-controlled',
      caseId: 'C02',
      caseDigest: sha256Text('controlled-case-C02'),
      publicTaskDigest: sha256Text('controlled-task-C02'),
      initialRepositoryDigest: cleanInitial,
      fixturePath,
      fixtureDigest: sha256Text('controlled-fixture-C02'),
      graderDigest: sha256Text('controlled-grader-C02'),
      graderPath,
    }),
  ]);
}

function defaultProfileBundle(): ControlledAdmittedProfile {
  const baseTask = createFixtureBugTask();
  return createControlledAdmittedProfile({
    catalog: defaultCatalogEntries(baseTask.initialRevisionDigest),
    credentialRef: 'controlled-console-ref',
    codeDigest: sha256Text('controlled-console-code'),
    configDigest: sha256Text('controlled-console-config'),
    imageDigest: `sha256:${sha256Text('controlled-console-image')}`,
    adapterVersions: [CONTROLLED_CONSOLE_ADAPTER_VERSION],
    pricingId: 'controlled-console-price-1',
  });
}

export interface ControlledHostConfigurationFile {
  readonly profileId: string;
  readonly profileDigest: string;
  readonly configDigest: string;
  readonly pricingDigest: string;
  readonly requestedModel: string;
  readonly adapterVersions: readonly string[];
  readonly contractVersion: string;
  readonly revisions: Readonly<Record<UC03ProductionComponentV02, string>>;
  readonly assembly: string;
}

/** Build a `host.json` configuration matching the runnable controlled assembly and its pins. */
export function buildControlledHostConfiguration(assembly: string): ControlledHostConfigurationFile {
  const { configuration } = defaultProfileBundle();
  return {
    profileId: configuration.identity['profileId'] ?? 'uc03-runtime-evaluation-v1',
    profileDigest: configuration.profileDigest,
    configDigest: configuration.configDigest,
    pricingDigest: configuration.pricingDigest,
    requestedModel: configuration.requestedModel,
    adapterVersions: [...configuration.adapterVersions],
    contractVersion: CONTROLLED_CONSOLE_CONTRACT_VERSION,
    revisions: { ...CONTROLLED_CONSOLE_PIN_REVISIONS },
    assembly,
  };
}

interface ApprovalPresentationRecord {
  readonly binding: ApprovalBinding;
  readonly version: number;
  readonly digest: string;
}

interface SessionDirectionRecord {
  readonly receipt: ServiceControlReceipt;
  readonly taskVersion: number;
  readonly feedback?: string | undefined;
}

interface TaskSession {
  readonly experimentId: string;
  readonly caseKind: 'C01' | 'C02' | 'custom';
  readonly task: BugTask;
  readonly workspaceId: string;
  readonly runId: string;
  readonly statePort: MemoryStatePortV02;
  readonly approvalPort: ScriptedApprovalPort;
  readonly wrappedApprovalPort: ApprovalPort & ContextualApprovalVerifierV02;
  readonly repositoryPort: FakeRepositoryPort;
  readonly ownerSettledRepositoryPort: RepositoryPortV02 & { readonly executionGuardApiVersion: '0.2.0' };
  readonly guardedRead: ExecutionGuardReadCapability;
  readonly hostAuthority: TrustedHostPort;
  readonly transitionContexts: Map<number, NonNullable<StateTransitionOptions['trusted']>>;
  readonly decided: Map<string, 'approved' | 'rejected'>;
  readonly knownDecisionIds: Set<string>;
  readonly decisionReplays: Map<string, Readonly<{ fingerprint: string; result: Readonly<Record<string, unknown>> }>>;
  readonly directionsByRef: Map<string, SessionDirectionRecord>;
  storedBaseline?: Readonly<{ content: BaselineEvidenceCandidate; acknowledgement: BaselineEvidenceAcknowledgement }> | undefined;
  currentPresentation?: ApprovalPresentationRecord | undefined;
  presentationVersion: number;
  controlVersion: number;
  replanSequence: number;
  clarificationAsked: boolean;
}

function buildDynamicApprovalContext(task: BugTask, state: TaskState, binding: ApprovalBinding): ApprovalBindingContext {
  const plan = state.plan;
  const planVersion = binding.planVersion ?? plan?.planVersion ?? state.planVersion;
  const strategyDigest = binding.strategyDigest ?? plan?.strategyDigest ?? computeCanonicalSha256(task.goal);
  const baselineRef = binding.baselineRef ?? plan?.baselineRef ?? '';
  const evidenceRefs = [...(binding.evidenceRefs ?? plan?.evidenceRefs ?? state.evidenceRefs)];
  const actionKind = binding.actionKind === 'action' && binding.decisionId.startsWith('dec-verify-') ? 'verify_patch' : 'approve_fix_plan';
  const normalizedActionDigest =
    binding.normalizedActionDigest ??
    computeCanonicalSha256({
      actionId: binding.decisionId,
      kind: actionKind,
      planVersion,
      strategyDigest,
      diagnosisEvidenceRefs: evidenceRefs,
      checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    });
  return {
    currentTaskId: state.taskId,
    currentWorkspaceId: state.workspaceId,
    currentRepositoryRevisionDigest: state.repositoryRevisionDigest,
    currentPolicyId: task.configId,
    currentPolicyVersion: task.configVersion,
    currentNormalizedActionDigest: normalizedActionDigest,
    currentPlanVersion: planVersion,
    currentStrategyDigest: strategyDigest,
    currentBaselineRef: baselineRef,
    currentEvidenceRefs: evidenceRefs,
    currentCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    currentCheckSetDigest: computeCheckSetDigest(task.requiredChecks),
  };
}

function createCoderProposalForFetch(parsedBody: unknown, sessionsByTaskId: ReadonlyMap<string, TaskSession>): Readonly<{ providerRequestId: string; model: string; proposal: unknown }> {
  const body = (typeof parsedBody === 'object' && parsedBody !== null ? parsedBody : {}) as Readonly<Record<string, unknown>>;
  const model = typeof body['model'] === 'string' ? body['model'] : CONTROLLED_CONSOLE_MODEL;
  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  const first = messages[0] as Readonly<Record<string, unknown>> | undefined;
  const promptText = typeof first?.['content'] === 'string' ? first['content'] : '{}';
  const prompt = JSON.parse(promptText) as Readonly<{
    task?: { readonly taskId?: string; readonly evidenceRefs?: readonly string[]; readonly plan?: { readonly decisionRef?: string; readonly strategy?: string } };
    request?: { readonly providerRequestId?: string; readonly role?: string; readonly purpose?: string };
    untrustedEvidence?: readonly unknown[];
  }>;
  const providerRequestId = prompt.request?.providerRequestId ?? 'controlled-req-1';
  const purpose = prompt.request?.purpose ?? 'propose-plan';
  const role = prompt.request?.role ?? 'coder';
  const taskId = prompt.task?.taskId ?? '';
  const session = sessionsByTaskId.get(taskId);

  if (role === 'reviewer' || purpose === 'final-review') {
    return {
      providerRequestId,
      model,
      proposal: { status: 'accepted', findings: [] },
    };
  }

  const evidenceCount = Array.isArray(prompt.untrustedEvidence) ? prompt.untrustedEvidence.length : 0;
  if ((purpose === 'propose-plan' || purpose === 'propose-patch' || purpose === 'propose-repair' || purpose === 'propose-replan') && evidenceCount === 0) {
    return {
      providerRequestId,
      model,
      proposal: {
        kind: 'inspect',
        proposalId: `controlled-inspect-${providerRequestId}`,
        operation: 'read_file',
        args: { path: 'src/calculator.py' },
      },
    };
  }

  if (purpose === 'propose-plan') {
    if (session?.caseKind === 'C02' && !session.clarificationAsked) {
      session.clarificationAsked = true;
      return {
        providerRequestId,
        model,
        proposal: {
          kind: 'request-info',
          proposalId: `controlled-clarify-${providerRequestId}`,
          questions: [{ questionId: 'q-denominator', text: 'What should divide(a, 0) raise when the denominator is zero?' }],
          evidenceRefs: ['src/calculator.py'],
        },
      };
    }
    const planLabel = session?.caseKind === 'C02' ? 'Raise CalculationError for clarified zero denominator behavior.' : 'Reject a zero denominator before division.';
    return {
      providerRequestId,
      model,
      proposal: {
        kind: 'propose-plan',
        proposalId: `controlled-plan-${providerRequestId}`,
        diagnosis: 'The divide implementation lacks a zero denominator guard.',
        strategy: planLabel,
        suspectedLocations: ['src/calculator.py'],
        scopedPaths: ['src/calculator.py'],
        evidenceRefs: ['src/calculator.py'],
      },
    };
  }

  if (purpose === 'propose-replan') {
    const seq = (session?.replanSequence ?? 0) + 1;
    if (session) session.replanSequence = seq;
    const baselineRef = session?.storedBaseline?.acknowledgement.evidenceId ?? prompt.task?.evidenceRefs?.find(ref => ref.startsWith('uc04://baseline/'));
    return {
      providerRequestId,
      model,
      proposal: {
        kind: 'propose-plan',
        proposalId: `controlled-replan-${providerRequestId}`,
        diagnosis: `Revised diagnosis #${seq}: guard zero denominator explicitly before float division.`,
        strategy: `Check zero first (revision #${seq}), then raise CalculationError with the explicit message.`,
        suspectedLocations: ['src/calculator.py'],
        scopedPaths: ['src/calculator.py'],
        evidenceRefs: baselineRef ? [baselineRef, 'src/calculator.py'] : ['src/calculator.py'],
      },
    };
  }

  const decisionRef = prompt.task?.plan?.decisionRef ?? '';
  const repair = purpose === 'propose-repair';
  return {
    providerRequestId,
    model,
    proposal: {
      kind: 'propose-patch',
      proposalId: `controlled-${repair ? 'repair' : 'patch'}-${providerRequestId}`,
      diff: repair ? REPAIR_DIFF : PATCH_DIFF,
      targetPaths: ['src/calculator.py'],
      approvedPlanRef: decisionRef,
    },
  };
}

function resolveOperatorToken(): { readonly token: string; readonly source: string } {
  const envToken = process.env[CONTROLLED_CONSOLE_TOKEN_ENV];
  if (envToken !== undefined && envToken.length > 0) {
    if (!TOKEN_PATTERN.test(envToken)) {
      throw new Error(`${CONTROLLED_CONSOLE_TOKEN_ENV} must be 16..512 printable ASCII characters`);
    }
    return { token: envToken, source: `${CONTROLLED_CONSOLE_TOKEN_ENV} env` };
  }
  return { token: randomBytes(24).toString('hex'), source: 'generated per-process' };
}

function resolveSessionContext<T>(map: ReadonlyMap<string, T>, key: string | undefined, fallback: T | undefined): T {
  if (key !== undefined) {
    const found = map.get(key);
    if (found !== undefined) return found;
  }
  if (fallback !== undefined) return fallback;
  throw new Error('No active controlled console task session');
}

export interface ControlledHostAssemblyExport {
  readonly host: HostAssembly;
  readonly console: EvaluationConsoleFactory;
}

/**
 * CLI `--host` assembly export for runnable controlled operator sessions.
 * Satisfies `prepareUC03Host` (`ready`) using an in-process DeepSeek fetch stub, isolated per-experiment
 * owner state/repository sessions, and both C01 (approval pause) and C02 (clarification pause) routes
 * plus an ungraded custom `bug` route.
 */
export function createHostAssembly(): ControlledHostAssemblyExport {
  const { catalog, profile } = defaultProfileBundle();
  const baseCheckRepro = createFixtureCheckDefinition({
    checkId: 'check-pytest-reproduction',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py', '-k', 'test_divide_zero'],
    purpose: 'reproduction',
  });
  const baseCheckRegression = createFixtureCheckDefinition({
    checkId: 'check-pytest-regression',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py'],
    purpose: 'regression',
  });
  const baseTask = createFixtureBugTask({ requiredChecks: [baseCheckRepro, baseCheckRegression] });

  const { token, source: tokenSource } = resolveOperatorToken();
  let printedToken = false;

  const sessionsByTaskId = new Map<string, TaskSession>();
  const sessionsByExperimentId = new Map<string, TaskSession>();
  const sessionsByClaimId = new Map<string, TaskSession>();
  const sessionsByAttemptId = new Map<string, TaskSession>();
  const sessionsByDecisionId = new Map<string, TaskSession>();
  const sessionsByBaselineId = new Map<string, TaskSession>();
  let activeSession: TaskSession | undefined;
  let taskSequence = 0;
  let admissionSequence = 0;

  const getActiveSession = (): TaskSession => {
    if (!activeSession) throw new Error('No active controlled console task session');
    return activeSession;
  };

  const createSession = async (experimentId: string, caseKind: 'C01' | 'C02' | 'custom', overrides: Partial<BugTask> = {}): Promise<TaskSession> => {
    const seq = ++taskSequence;
    const prefix = caseKind === 'custom' ? 'bug' : caseKind.toLowerCase();
    // Avoid `sk-`-shaped substrings inside ids echoed by mock repository files.
    const taskId = `eval-${prefix}-${seq}`;
    const runId = `run-${prefix}-${seq}`;
    const workspaceId = `ws-${prefix}-${seq}`;
    const task: BugTask = createFixtureBugTask({
      ...baseTask,
      ...overrides,
      taskId,
      requiredChecks: [baseCheckRepro, baseCheckRegression],
    });
    const transitionContexts = new Map<number, NonNullable<StateTransitionOptions['trusted']>>();
    const decided = new Map<string, 'approved' | 'rejected'>();
    const authorityRef = createFixturePolicyAuthorityRefV02({
      policyId: task.configId,
      policyVersion: task.configVersion,
      configId: task.configId,
      configVersion: task.configVersion,
      decisionAuthorityGeneration: 3,
    });

    const rawApprovalPort = new ScriptedApprovalPort({
      decisions: [],
      v02AuthorityRef: authorityRef,
    });

    const sessionBox: { current?: TaskSession } = {};
    const currentSession = (): TaskSession => {
      if (!sessionBox.current) throw new Error('Controlled console task session not initialized');
      return sessionBox.current;
    };

    const wrappedApprovalPort: ApprovalPort & ContextualApprovalVerifierV02 = {
      provenance: 'real' as const,
      classify: action => rawApprovalPort.classify(action),
      requestDecision: async binding => {
        const current = currentSession();
        if (!current.knownDecisionIds.has(binding.decisionId)) {
          rawApprovalPort.scriptDecision({ ...binding, status: 'pending' });
          current.knownDecisionIds.add(binding.decisionId);
        }
        const resolved = await rawApprovalPort.requestDecision(binding);
        sessionsByDecisionId.set(binding.decisionId, current);
        if (resolved.status === 'pending' && current.currentPresentation?.binding.decisionId !== binding.decisionId) {
          current.presentationVersion += 1;
          current.currentPresentation = {
            binding: structuredClone(binding),
            version: current.presentationVersion,
            digest: computeCanonicalSha256(binding),
          };
          decided.delete(binding.decisionId);
        }
        return resolved;
      },
      validateBinding: async (binding: ApprovalBinding): Promise<boolean> => {
        const current = currentSession();
        const ownerState = await current.statePort.loadTask(binding.taskId);
        const dynamicContext = ownerState ? buildDynamicApprovalContext(current.task, ownerState, binding) : undefined;
        return rawApprovalPort.validateBinding(binding, dynamicContext);
      },
      resolve: decisionId => rawApprovalPort.resolve(decisionId),
      resolvePlanDecisionInContext: (decisionId, context) => rawApprovalPort.resolvePlanDecisionInContext(decisionId, context),
    };

    const statePort = new MemoryStatePortV02({
      transitionContextFor: next => transitionContexts.get(next.stateVersion),
      initialAuthorityRef: authorityRef,
      verificationApprovalVerifier: wrappedApprovalPort,
    });
    const seedState = createGraphTaskState(task, { taskId, runId, workspaceId });
    await seedGraphTaskState(statePort, seedState);

    const repositoryPort = new FakeRepositoryPort({
      initialRevision: task.initialRevisionDigest,
      initialFiles: { 'tests/test_calculator.py': PROTECTED_TEST_TEXT, 'src/calculator.py': INITIAL_SOURCE_TEXT },
      commandResults: {
        [REPRO_COMMAND]: { exitCode: 1, stdout: 'FAILED tests/test_calculator.py::test_divide_zero - ZeroDivisionError', stderr: '' },
        [REGRESSION_COMMAND]: { exitCode: 0, stdout: '1 passed', stderr: '' },
        default: { exitCode: 0, stdout: '1 passed', stderr: '' },
      },
    });
    repositoryPort.setStatePort(statePort);
    repositoryPort.setTestResult('check-pytest-reproduction', { checkId: 'check-pytest-reproduction', outcome: 'pass', outputExcerpt: '1 passed', durationMs: 100 });
    repositoryPort.setTestResult('check-pytest-regression', { checkId: 'check-pytest-regression', outcome: 'pass', outputExcerpt: '1 passed', durationMs: 100 });
    const ownerSettledRepositoryPort = createGraphRepositoryPort(repositoryPort, statePort);

    const readPolicyDigest = `sha256:${'d'.repeat(64)}`;
    const readObservationFor = async (): Promise<GuardedReadControlObservation> => {
      const current = currentSession();
      const ownerState = await statePort.loadTask(task.taskId);
      const revisionDigest = ownerState?.repositoryRevisionDigest ?? task.initialRevisionDigest;
      return {
        taskId: task.taskId,
        workspaceId,
        repositoryId: task.repositoryId,
        revisionDigest,
        controlVersion: current.controlVersion + 1,
        mode: 'runnable',
        holdRef: null,
        fencingGeneration: 1,
        policyDigest: readPolicyDigest,
        readAllowed: true,
      };
    };
    const guardedRead = createGuardedReadCapability({
      capabilityId: `controlled-read-${seq}`,
      taskId: task.taskId,
      workspaceId,
      repositoryId: task.repositoryId,
      expectedRevisionDigest: task.initialRevisionDigest,
      pinRevision: false,
      policyDigest: readPolicyDigest,
      bounds: { maxPathLength: 512, maxQueryLength: 256 },
      provenance: 'real',
      owner: {
        observeReadControl: readObservationFor,
        fenceReadControl: async observation => {
          const current = await readObservationFor();
          if (
            observation.taskId !== current.taskId ||
            observation.workspaceId !== current.workspaceId ||
            observation.repositoryId !== current.repositoryId ||
            observation.revisionDigest !== current.revisionDigest ||
            observation.controlVersion !== current.controlVersion ||
            observation.mode !== current.mode ||
            observation.holdRef !== current.holdRef ||
            observation.fencingGeneration !== current.fencingGeneration ||
            observation.policyDigest !== current.policyDigest ||
            observation.readAllowed !== current.readAllowed
          ) {
            return null;
          }
          return {
            receiptId: `controlled-read-fence-${seq}`,
            taskId: current.taskId,
            workspaceId: current.workspaceId,
            repositoryId: current.repositoryId,
            revisionDigest: current.revisionDigest,
            controlVersion: current.controlVersion,
            fencingGeneration: current.fencingGeneration,
            policyDigest: current.policyDigest,
          };
        },
      },
    });

    const hostAuthority: TrustedHostPort = {
      async loadSnapshot(request): Promise<TrustedHostSnapshot> {
        return {
          taskId: request.taskId,
          workspaceId: request.workspaceId,
          repositoryId: request.repositoryId,
          currentRevision: request.expectedRevisionDigest,
          checkSetDigest: request.expectedCheckSetDigest,
          testFiles: [{ path: 'tests/test_calculator.py', content: PROTECTED_TEST_TEXT }],
          expectedTestFiles: request.expectedTestFiles,
        };
      },
    };

    const session: TaskSession = {
      experimentId,
      caseKind,
      task,
      workspaceId,
      runId,
      statePort,
      approvalPort: rawApprovalPort,
      wrappedApprovalPort,
      repositoryPort,
      ownerSettledRepositoryPort,
      guardedRead,
      hostAuthority,
      transitionContexts,
      decided,
      knownDecisionIds: new Set(),
      decisionReplays: new Map(),
      directionsByRef: new Map(),
      presentationVersion: 0,
      controlVersion: 0,
      replanSequence: 0,
      clarificationAsked: false,
    };
    sessionBox.current = session;

    sessionsByTaskId.set(taskId, session);
    sessionsByExperimentId.set(experimentId, session);
    activeSession = session;
    return session;
  };

  // --- Shared routing ports satisfying checkProductionPortsV02 & isAdmittedForProduction ---

  const stateForClaim = (claimId: string): TaskSession => resolveSessionContext(sessionsByClaimId, claimId, activeSession);
  const stateForTask = (taskId: string): TaskSession => resolveSessionContext(sessionsByTaskId, taskId, activeSession);

  const routingStatePort: StatePortV02 & { readonly executionGuardApiVersion: '0.2.0' } = {
    provenance: 'real' as const,
    executionGuardApiVersion: '0.2.0' as const,
    loadTask: async taskId => {
      const target = sessionsByTaskId.get(taskId);
      return target ? target.statePort.loadTask(taskId) : null;
    },
    transition: async (state, expectedVersion) => stateForTask(state.taskId).statePort.transition(state, expectedVersion),
    claim: async context => {
      const target = stateForTask(context.taskId);
      const receipt = await target.statePort.claim(context);
      sessionsByClaimId.set(receipt.claimId, target);
      return receipt;
    },
    beginAttempt: async (claimId, executor) => {
      const target = stateForClaim(claimId);
      const receipt = await target.statePort.beginAttempt(claimId, executor);
      sessionsByAttemptId.set(receipt.attemptId, target);
      return receipt;
    },
    recordOutcome: async receipt => {
      const target = sessionsByAttemptId.get(receipt.attemptId) ?? stateForClaim(receipt.claimId);
      return target.statePort.recordOutcome(receipt);
    },
    reconcileObservedOutcome: async receipt => {
      const target = sessionsByAttemptId.get(receipt.attemptId) ?? stateForClaim(receipt.claimId);
      return target.statePort.reconcileObservedOutcome(receipt);
    },
    reconcileUncertain: async (receipt, includePatchRevision) => {
      const target = sessionsByAttemptId.get(receipt.attemptId) ?? stateForClaim(receipt.claimId);
      return target.statePort.reconcileUncertain(receipt, includePatchRevision);
    },
    closeUnattemptedClaim: async receipt => stateForTask(receipt.taskId).statePort.closeUnattemptedClaim(receipt),
    checkpoint: async state => stateForTask(state.taskId).statePort.checkpoint(state),
    recover: async taskId => stateForTask(taskId).statePort.recover(taskId),
    readVerificationAuthoritySnapshot: async taskId => {
      const target = sessionsByTaskId.get(taskId);
      return target ? target.statePort.readVerificationAuthoritySnapshot(taskId) : null;
    },
    recordVerificationApproval: async request => stateForTask(request.taskId).statePort.recordVerificationApproval(request),
    resolvePlanDecisionInContext: async (decisionId, context) => stateForTask(context.approvalContext.currentTaskId).statePort.resolvePlanDecisionInContext(decisionId, context),
    readSettledPatchAncestry: async request => {
      const target = sessionsByTaskId.get(request.taskId);
      return target ? target.statePort.readSettledPatchAncestry(request) : null;
    },
  };

  const routingApprovalPort: ApprovalPort & ContextualApprovalVerifierV02 = {
    provenance: 'real' as const,
    classify: async action => getActiveSession().wrappedApprovalPort.classify(action),
    requestDecision: async binding => resolveSessionContext(sessionsByTaskId, binding.taskId, activeSession).wrappedApprovalPort.requestDecision(binding),
    validateBinding: async binding => resolveSessionContext(sessionsByTaskId, binding.taskId, activeSession).wrappedApprovalPort.validateBinding(binding),
    resolve: async decisionId => resolveSessionContext(sessionsByDecisionId, decisionId, activeSession).wrappedApprovalPort.resolve(decisionId),
    resolvePlanDecisionInContext: async (decisionId, context) =>
      resolveSessionContext(sessionsByTaskId, context.approvalContext.currentTaskId, sessionsByDecisionId.get(decisionId) ?? activeSession).wrappedApprovalPort.resolvePlanDecisionInContext(
        decisionId,
        context,
      ),
  };

  const routingRepositoryPort: RepositoryPortV02 & { readonly executionGuardApiVersion: '0.2.0' } = {
    provenance: 'real' as const,
    executionGuardApiVersion: '0.2.0' as const,
    listDir: path => getActiveSession().ownerSettledRepositoryPort.listDir(path),
    readFile: path => getActiveSession().ownerSettledRepositoryPort.readFile(path),
    searchCode: query => getActiveSession().ownerSettledRepositoryPort.searchCode(query),
    inspectDiff: revision => getActiveSession().ownerSettledRepositoryPort.inspectDiff(revision),
    applyPatch: (patch, context) => resolveSessionContext(sessionsByTaskId, context.taskId, activeSession).ownerSettledRepositoryPort.applyPatch(patch, context),
    runCommand: (action, context) => resolveSessionContext(sessionsByTaskId, context.taskId, activeSession).ownerSettledRepositoryPort.runCommand(action, context),
    runTests: (check, context) => resolveSessionContext(sessionsByTaskId, context.taskId, activeSession).ownerSettledRepositoryPort.runTests(check, context),
  };

  const inProcessFetch: typeof globalThis.fetch = async (_input, init) => {
    const rawBody = typeof init?.body === 'string' ? init.body : '{}';
    const parsed = JSON.parse(rawBody) as unknown;
    const reply = createCoderProposalForFetch(parsed, sessionsByTaskId);
    const body = JSON.stringify({
      id: reply.providerRequestId,
      type: 'message',
      model: reply.model,
      content: [{ type: 'text', text: JSON.stringify(reply.proposal) }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const transportConfig = {
    endpoint: CONTROLLED_CONSOLE_ENDPOINT,
    // In-process placeholder satisfying transport shape; zero external credential or network IO.
    apiKey: ['controlled', 'inprocess', 'placeholder'].join('-'),
    pricing: { inputRate: 1, outputRate: 1, cacheRate: 0, overheadRate: 0, denominator: 1 },
    reviewPrompt: { ...DEEPSEEK_REVIEW_PROMPT, maxOutputBytes: 16_384, maxResponseBytes: 131_072 },
    fetch: inProcessFetch,
  };
  const coderActor = createFixtureExecutorIdentityV02({ processIncarnation: 'controlled-console-coder' });
  const reviewerActor = createFixtureExecutorIdentityV02({ processIncarnation: 'controlled-console-reviewer' });

  const modelPort = new HostModelPortV02({
    transport: createDeepSeekTransport(transportConfig),
    statePort: routingStatePort,
    executorIdentity: coderActor,
    currentExecutorIdentity: () => coderActor,
  });

  const reviewerModelPort: UC03ReviewerModelPortV02 = Object.assign(
    new HostModelPortV02({
      transport: createDeepSeekTransport(transportConfig),
      statePort: routingStatePort,
      executorIdentity: reviewerActor,
      currentExecutorIdentity: () => reviewerActor,
    }),
    { providerRole: 'reviewer' as const },
  );

  const executionGuard = createExecutionGuardV02({
    ports: {
      statePort: routingStatePort,
      repositoryPort: routingRepositoryPort,
      approvalPort: routingApprovalPort,
    },
    config: { provenance: 'real' },
  });

  const guardedRead: ExecutionGuardReadCapability = {
    provenance: 'real',
    get capabilityId(): string {
      return activeSession?.guardedRead.capabilityId ?? 'controlled-read';
    },
    get workspaceId(): string {
      return activeSession?.guardedRead.workspaceId ?? 'ws-test';
    },
    get taskId(): string {
      return activeSession?.guardedRead.taskId ?? baseTask.taskId;
    },
    mediateRead: operation => getActiveSession().guardedRead.mediateRead(operation),
  };

  const baselineEvidence = createBaselineEvidenceAdapter({
    provenance: 'real',
    async persist(request) {
      const target = stateForTask(request.content.taskId);
      const acknowledgement: BaselineEvidenceAcknowledgement = {
        evidenceId: `uc04://baseline/${request.content.taskId}/1`,
        taskId: request.content.taskId,
        workspaceId: request.content.workspaceId,
        repositoryId: request.content.repositoryId,
        contentDigest: request.contentDigest,
        repositorySnapshotDigest: request.content.repositorySnapshotDigest,
        criteriaDigest: request.content.criteriaDigest,
        checkSetDigest: request.content.checkSetDigest,
        testProtectionDigest: request.content.testProtectionDigest,
        reproductionCheckId: request.content.reproductionCheckId,
        expectedPassingCheckIds: request.content.expectedPassingCheckIds,
        expectedTestFiles: request.content.expectedTestFiles,
        requiredCheckIds: request.content.requiredChecks.map(check => check.checkId),
      };
      target.storedBaseline = { content: structuredClone(request.content), acknowledgement: structuredClone(acknowledgement) };
      sessionsByBaselineId.set(acknowledgement.evidenceId, target);
      return { outcome: 'durable', acknowledgement };
    },
    load(request) {
      const target = sessionsByBaselineId.get(request.evidenceId) ?? sessionsByTaskId.get(request.taskId);
      const stored = target?.storedBaseline;
      if (!stored || stored.acknowledgement.evidenceId !== request.evidenceId) return { outcome: 'missing' };
      return { outcome: 'found', content: stored.content, acknowledgement: stored.acknowledgement };
    },
  });

  const hostAuthority: TrustedHostPort = {
    loadSnapshot: request => resolveSessionContext(sessionsByTaskId, request.taskId, activeSession).hostAuthority.loadSnapshot(request),
  };

  const replanPort: MaterialReplanPortV02 = {
    provenance: 'real' as const,
    async accept(request: MaterialReplanRequestV02) {
      const target = stateForTask(request.taskId);
      const current = await target.statePort.loadTask(request.taskId);
      if (
        !current ||
        current.node !== 'AwaitFeedback' ||
        current.stateVersion !== request.priorStateVersion ||
        current.runId !== request.runId ||
        current.planVersion !== request.priorPlanVersion ||
        current.replanCount !== request.priorReplanCount ||
        computeCanonicalSha256(request.candidatePlan) !== request.candidatePlanDigest
      ) {
        return { outcome: 'denied' as const, reason: 'Owner replan preconditions were not satisfied' };
      }
      const reservationId = await target.statePort.getUnderlying().reserve('task', 'replan', 1, request.proposalId);
      const renewedDecisionId = `renewed-${sha256Text(request.proposalId).slice(0, 24)}`;
      const planWithoutDecision = {
        ...request.candidatePlan,
        planVersion: request.priorPlanVersion + 1,
        decisionRef: undefined,
      };
      const trustedReplan = {
        replanReservation: {
          proposalId: request.proposalId,
          taskId: current.taskId,
          configurationId: target.task.configId,
          priorCount: request.priorReplanCount,
          nextCount: request.expectedNextReplanCount,
          reservationId,
        },
      };
      const investigate: TaskState = {
        ...current,
        stateVersion: current.stateVersion + 1,
        node: 'Investigate',
        nextAction: 'propose-fix-plan',
        planVersion: planWithoutDecision.planVersion,
        plan: planWithoutDecision,
        activeDecisionId: undefined,
        latestReviewRef: undefined,
        reviewRefs: [],
        replanCount: request.expectedNextReplanCount,
        budgetLedgers: target.statePort.getLedgers(),
      };
      target.transitionContexts.set(investigate.stateVersion, trustedReplan);
      const investigated = await target.statePort.transition(investigate, current.stateVersion);

      const renewedPlan = { ...planWithoutDecision, decisionRef: renewedDecisionId };
      const pendingBinding: ApprovalBinding = {
        decisionId: renewedDecisionId,
        actionKind: 'fix_plan',
        normalizedActionDigest: computeCanonicalSha256({
          actionId: renewedDecisionId,
          kind: 'approve_fix_plan',
          planVersion: renewedPlan.planVersion,
          strategyDigest: renewedPlan.strategyDigest,
          diagnosisEvidenceRefs: renewedPlan.evidenceRefs,
          checkSetDigest: renewedPlan.checkSetDigest,
        }),
        taskId: current.taskId,
        workspaceId: current.workspaceId,
        repositoryRevisionDigest: current.repositoryRevisionDigest,
        policyId: target.task.configId,
        policyVersion: target.task.configVersion,
        planVersion: renewedPlan.planVersion,
        strategyDigest: renewedPlan.strategyDigest,
        baselineRef: renewedPlan.baselineRef,
        evidenceRefs: renewedPlan.evidenceRefs,
        criteriaDigest: computeCanonicalSha256(target.task.acceptanceCriteria),
        checkSetDigest: renewedPlan.checkSetDigest,
        status: 'pending' as const,
      };
      target.approvalPort.scriptDecision(pendingBinding);
      target.knownDecisionIds.add(renewedDecisionId);
      sessionsByDecisionId.set(renewedDecisionId, target);
      target.presentationVersion += 1;
      target.currentPresentation = {
        binding: structuredClone(pendingBinding),
        version: target.presentationVersion,
        digest: computeCanonicalSha256(pendingBinding),
      };
      target.decided.delete(renewedDecisionId);

      const next: TaskState = {
        ...investigated,
        stateVersion: investigated.stateVersion + 1,
        node: 'AwaitPlan',
        nextAction: 'approve-fix-plan',
        planVersion: renewedPlan.planVersion,
        plan: renewedPlan,
        activeDecisionId: renewedDecisionId,
        latestReviewRef: undefined,
        reviewRefs: [],
        replanCount: request.expectedNextReplanCount,
        budgetLedgers: target.statePort.getLedgers(),
      };
      target.transitionContexts.set(next.stateVersion, trustedReplan);
      const saved = await target.statePort.transition(next, investigated.stateVersion);
      return {
        outcome: 'accepted' as const,
        state: saved,
        reservationReceipt: reservationId,
        transitionReceipt: `transition-${request.proposalId}`,
      };
    },
  };

  const trustedExpectedContext: TrustedHostExpectedContext = {
    get taskId(): string {
      return getActiveSession().task.taskId;
    },
    get workspaceId(): string {
      return getActiveSession().workspaceId;
    },
    get repositoryId(): string {
      return getActiveSession().task.repositoryId;
    },
    get revisionDigest(): string {
      return getActiveSession().task.initialRevisionDigest;
    },
    get criteriaDigest(): string {
      return computeCanonicalSha256(getActiveSession().task.acceptanceCriteria);
    },
    get checkSetDigest(): string {
      return computeCheckSetDigest(getActiveSession().task.requiredChecks);
    },
    expectedTestFiles: ['tests/test_calculator.py'],
    executionGuard,
    statePort: routingStatePort,
    admissionContextForCheck: async ({ check, action, currentState }) => {
      const target = stateForTask(currentState.taskId);
      const ownerAuthority = await target.statePort.readVerificationAuthoritySnapshot(currentState.taskId);
      if (!ownerAuthority) return undefined;
      const isVerify = currentState.node === 'Verify';
      const journal = target.statePort.getJournalSnapshot();
      const planBindingDigest = isVerify ? currentPlanBindingDigest(target.task, currentState) : undefined;
      const context = createTestRepositoryCommandAdmissionContextV02({
        taskId: currentState.taskId,
        runId: currentState.runId,
        workspaceId: currentState.workspaceId,
        repositoryId: currentState.repositoryId,
        canonicalRevision: currentState.repositoryRevisionDigest,
        expectedTaskStateVersion: currentState.stateVersion,
        expectedControlVersion: journal.controlVersion,
        expectedEpoch: journal.epoch,
        policyAuthorityRef: { ...ownerAuthority.policyIdentity, decisionAuthorityGeneration: ownerAuthority.decisionAuthorityGeneration },
        action,
        reservationRefs: [
          `task-timeoutMs:${action.actionId}`,
          `task-maxOutputBytes:${action.actionId}`,
          `task-maxCpuSeconds:${action.actionId}`,
          `task-maxMemoryBytes:${action.actionId}`,
          `task-maxProcessCount:${action.actionId}`,
          `run-timeoutMs:${action.actionId}`,
          `run-maxOutputBytes:${action.actionId}`,
          `run-maxCpuSeconds:${action.actionId}`,
          `run-maxMemoryBytes:${action.actionId}`,
          `run-maxProcessCount:${action.actionId}`,
        ],
        runnableNode: isVerify ? 'Verify' : 'Investigate',
        planApplicability: isVerify ? 'approved-plan' : 'pre-plan-diagnostic',
        taskCriteriaDigest: computeCanonicalSha256(target.task.acceptanceCriteria),
        checkSetDigest: computeCheckSetDigest(target.task.requiredChecks),
        checkId: check.checkId,
        testPath: 'tests/test_calculator.py',
        ...(isVerify ? { planBindingDigest, planDecisionRef: currentState.plan?.decisionRef } : { planBindingDigest: undefined, planDecisionRef: undefined, diagnosticPurpose: check.purpose }),
      });
      target.repositoryPort.setExecutorIdentity(createFixtureExecutorIdentityV02({ payloadDigest: computeCanonicalSha256(action) }));
      return context;
    },
  };

  const config: UC03GraphConfigV02 = {
    trustedExpectedContext,
    coderAdmission: async ({ task: currentTask, state, purpose, evidence }) => {
      const target = stateForTask(state.taskId);
      const owner = await target.statePort.readVerificationAuthoritySnapshot(state.taskId);
      if (!owner) return undefined;
      const identity: ProviderPricingIdentityV02 = {
        providerId: 'provider-test',
        modelId: CONTROLLED_CONSOLE_MODEL,
        configId: owner.policyIdentity.configId,
        configVersion: owner.policyIdentity.configVersion,
        pricingPolicyId: owner.policyIdentity.policyId,
        pricingPolicyVersion: owner.policyIdentity.policyVersion,
        issuerKeyRef: owner.policyIdentity.issuerKeyRef,
        decisionAuthorityGeneration: owner.decisionAuthorityGeneration,
      };
      const reqId = `controlled-${purpose}-${++admissionSequence}`;
      const request: ProviderRequest = createTestProviderRequest({
        providerRequestId: reqId,
        taskId: state.taskId,
        runId: state.runId,
        modelId: CONTROLLED_CONSOLE_MODEL,
        role: 'coder',
        purpose,
        configId: identity.configId,
        pricingPolicyId: identity.pricingPolicyId,
        contextDigest: computeContextDigest(state, evidence),
        reservationRef: `coder-allowance-${admissionSequence}`,
      });
      const receipt = createFixtureProviderAdmissionReceiptV02({
        providerRequestId: request.providerRequestId,
        role: 'coder',
        requestContentDigest: computeRequestContentDigest(request),
        providerId: identity.providerId,
        modelId: identity.modelId,
        configId: identity.configId,
        configVersion: identity.configVersion,
        decisionAuthorityGeneration: identity.decisionAuthorityGeneration,
      });
      const journal = target.statePort.getJournalSnapshot();
      const approvedPlanCall = purpose === 'propose-patch' || purpose === 'propose-repair' || (purpose === 'propose-replan' && state.node === 'AwaitFeedback');
      const context = createTestProviderAdmissionContextV02({
        providerRequest: request,
        providerIdentity: identity,
        providerAdmissionReceipt: receipt,
        taskId: state.taskId,
        runId: state.runId,
        runnableNode: state.node,
        role: 'coder',
        expectedTaskStateVersion: state.stateVersion,
        expectedControlVersion: journal.controlVersion,
        expectedEpoch: journal.epoch,
        planApplicability: approvedPlanCall ? 'approved-plan' : 'pre-plan-diagnostic',
        ...(approvedPlanCall ? {} : { diagnosticPurpose: 'diagnose-zero-denominator', taskCriteriaDigest: computeCanonicalSha256(currentTask.acceptanceCriteria) }),
        planDecisionRef: state.plan?.decisionRef,
        planBindingDigest: currentPlanBindingDigest(currentTask, state),
        budgetRefs: [`task-tokens:${reqId}`, `task-cost:${reqId}`, `run-tokens:${reqId}`, `run-cost:${reqId}`],
      });
      if (!approvedPlanCall) {
        const mutable = context as unknown as Record<string, unknown>;
        delete mutable['planDecisionRef'];
        delete mutable['planBindingDigest'];
      }
      return { request, context, trustedContext: createTestProviderAdmissionTrustedContextV02(context) };
    },
    reviewerAdmission: async ({ task: currentTask, state, diff }) => {
      const target = stateForTask(state.taskId);
      const owner = await target.statePort.readVerificationAuthoritySnapshot(state.taskId);
      if (!owner) return undefined;
      const contextDigest = reviewerContextDigest(currentTask, diff.diff, [], state.repositoryRevisionDigest, {
        runId: state.runId,
        expectedTaskStateVersion: state.stateVersion,
      });
      if (contextDigest === null) return undefined;
      const request = createTestProviderRequest({
        providerRequestId: `provider-${state.taskId}-${state.stateVersion}`,
        taskId: state.taskId,
        runId: state.runId,
        modelId: CONTROLLED_CONSOLE_MODEL,
        role: 'reviewer',
        purpose: 'final-review',
        configId: owner.policyIdentity.configId,
        pricingPolicyId: owner.policyIdentity.policyId,
        contextDigest,
        reservationRef: `review-allowance:${state.taskId}:${state.stateVersion}`,
      });
      const identity: ProviderPricingIdentityV02 = {
        providerId: request.providerId,
        modelId: request.modelId,
        configId: request.configId,
        configVersion: owner.policyIdentity.configVersion,
        pricingPolicyId: owner.policyIdentity.policyId,
        pricingPolicyVersion: owner.policyIdentity.policyVersion,
        issuerKeyRef: owner.policyIdentity.issuerKeyRef,
        decisionAuthorityGeneration: owner.decisionAuthorityGeneration,
      };
      const receipt = createFixtureProviderAdmissionReceiptV02({
        providerRequestId: request.providerRequestId,
        role: 'reviewer',
        requestContentDigest: computeRequestContentDigest(request),
        providerId: identity.providerId,
        modelId: identity.modelId,
        configId: identity.configId,
        configVersion: identity.configVersion,
        decisionAuthorityGeneration: identity.decisionAuthorityGeneration,
      });
      const journal = target.statePort.getJournalSnapshot();
      const context = createTestProviderAdmissionContextV02({
        providerRequest: request,
        providerIdentity: identity,
        providerAdmissionReceipt: receipt,
        taskId: state.taskId,
        runId: state.runId,
        runnableNode: 'Review',
        role: 'reviewer',
        expectedTaskStateVersion: state.stateVersion,
        expectedControlVersion: journal.controlVersion,
        expectedEpoch: journal.epoch,
        planApplicability: 'approved-plan',
        planDecisionRef: state.plan?.decisionRef,
        planBindingDigest: currentPlanBindingDigest(currentTask, state),
        budgetRefs: [
          `task-tokens:${request.providerRequestId}`,
          `task-cost:${request.providerRequestId}`,
          `run-tokens:${request.providerRequestId}`,
          `run-cost:${request.providerRequestId}`,
          `task-iteration:${request.providerRequestId}`,
        ],
      });
      return { request, context, trustedContext: createTestProviderAdmissionTrustedContextV02(context) };
    },
    admissionContext: async ({ task: currentTask, state, patchContent, targetPaths, actionId }) => {
      const target = stateForTask(state.taskId);
      const owner = await target.statePort.readVerificationAuthoritySnapshot(state.taskId);
      if (!owner || !state.plan?.decisionRef) return undefined;
      const action: NormalizedAction = {
        actionId: actionId ?? `controlled-patch-${state.stateVersion}`,
        kind: 'apply_patch',
        patchContent,
        targetPaths,
        baseRevisionDigest: state.repositoryRevisionDigest,
      };
      const journal = target.statePort.getJournalSnapshot();
      const context = createTestRepositoryAdmissionContextV02({
        taskId: state.taskId,
        runId: state.runId,
        workspaceId: state.workspaceId,
        repositoryId: state.repositoryId,
        canonicalRevision: state.repositoryRevisionDigest,
        expectedTaskStateVersion: state.stateVersion,
        expectedControlVersion: journal.controlVersion,
        expectedEpoch: journal.epoch,
        runnableNode: state.node === 'Repair' ? 'Repair' : 'Patch',
        planDecisionRef: state.plan.decisionRef,
        planBindingDigest: currentPlanBindingDigest(currentTask, state),
        policyAuthorityRef: { ...owner.policyIdentity, decisionAuthorityGeneration: owner.decisionAuthorityGeneration },
        action,
        baseRevision: state.repositoryRevisionDigest,
        targetPaths,
        patchDigest: computeCanonicalSha256(patchContent),
        reservationRefs: [`repair-slot:${state.taskId}:${state.stateVersion}`],
      });
      return { context, trustedContext: createTestRepositoryAdmissionTrustedContextV02(context) };
    },
    completionContextFor: async (input: UC03CompletionContextRequest): Promise<UC03TrustedCompletion | undefined> => {
      const target = stateForTask(input.state.taskId);
      return createControlledCompletionContextFor(target.transitionContexts)(input);
    },
  };

  const deliveryMeta = <K extends UC03ProductionComponentV02>(component: K) => ({
    component,
    id: `controlled-${component}`,
    contractVersion: CONTROLLED_CONSOLE_CONTRACT_VERSION,
    revision: CONTROLLED_CONSOLE_PIN_REVISIONS[component],
    provenance: 'real' as const,
  });

  const host: HostAssembly = {
    owner: [
      { ...deliveryMeta('statePort'), adapter: routingStatePort },
      { ...deliveryMeta('approvalPort'), adapter: routingApprovalPort },
      { ...deliveryMeta('repositoryPort'), adapter: routingRepositoryPort },
      { ...deliveryMeta('modelPort'), adapter: modelPort },
      { ...deliveryMeta('reviewerModelPort'), adapter: reviewerModelPort },
      { ...deliveryMeta('executionGuard'), adapter: executionGuard },
      {
        ...deliveryMeta('configPort'),
        adapter: {
          loadConfig: async taskId => {
            const target = sessionsByTaskId.get(taskId);
            return target ? { configId: target.task.configId, configVersion: target.task.configVersion } : null;
          },
        },
      },
      { ...deliveryMeta('replanPort'), adapter: replanPort },
    ],
    producers: {
      guardedRead,
      baselineEvidence,
      hostAuthority,
      contextSource: { provenance: 'real' as const, observe: () => null },
    },
    config,
  };

  const consoleFactory: EvaluationConsoleFactory = ({ readiness }) => {
    const routeConfig: Omit<UC03EvaluationGraphRoute, 'entry' | 'expectedWait' | 'resolveTask'> = {
      readiness,
      coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
      resolveDirection: ({ currentState, direction }) => {
        if (!direction || currentState.node !== 'AwaitFeedback' || !currentState.plan?.decisionRef) return undefined;
        const directive = direction.kind === 'revise' ? 'revise' : direction.kind === 'end' ? 'terminate' : 'resume';
        return {
          directive,
          taskId: currentState.taskId,
          workspaceId: currentState.workspaceId,
          repositoryRevisionDigest: currentState.repositoryRevisionDigest,
          stateVersion: currentState.stateVersion,
          planVersion: currentState.planVersion,
          rejectedDecisionId: currentState.plan.decisionRef,
          strategyDigest: currentState.plan.strategyDigest,
        } satisfies TrustedReplanDirection;
      },
      resolveClarificationResume: ({ experimentId, currentState, direction, answer, expectedAnswerDigest }) => {
        if (!direction) return undefined;
        const target = sessionsByExperimentId.get(experimentId) ?? sessionsByTaskId.get(currentState.taskId);
        const recorded = target?.directionsByRef.get(direction.receiptRef);
        if (!target || !recorded || recorded.receipt.kind !== 'resume' || recorded.taskVersion !== currentState.stateVersion) return undefined;
        return {
          receiptRef: direction.receiptRef,
          controlVersion: direction.controlVersion,
          taskId: currentState.taskId,
          runId: currentState.runId,
          workspaceId: currentState.workspaceId,
          stateVersion: currentState.stateVersion,
          questionId: answer.questionId,
          questionDigest: answer.questionDigest,
          answerDigest: expectedAnswerDigest,
        };
      },
    };

    const routeForCase = (entry: CatalogEntry, caseKind: 'C01' | 'C02'): UC03EvaluationGraphRoute => ({
      ...routeConfig,
      entry,
      expectedWait: caseKind === 'C01' ? 'waiting-approval' : 'waiting-info',
      resolveTask: async ({ experimentId, priorState }) => {
        if (priorState !== null) {
          const existing = stateForTask(priorState.taskId);
          activeSession = existing;
          return existing.task;
        }
        const existingForExperiment = sessionsByExperimentId.get(experimentId);
        if (existingForExperiment) {
          activeSession = existingForExperiment;
          return existingForExperiment.task;
        }
        const session = await createSession(experimentId, caseKind);
        return session.task;
      },
    });

    const assembly: EvaluationConsoleAssembly = {
      profile,
      catalog,
      repositoryIds: [CONTROLLED_CONSOLE_REPOSITORY_ID],
      checkSetIds: [CONTROLLED_CONSOLE_CHECK_SET],
      control: {
        async issue(input) {
          const target = sessionsByExperimentId.get(input.experimentId);
          if (!target) throw new Error('UNKNOWN_EXPERIMENT');
          const ownerState = await target.statePort.loadTask(target.task.taskId);
          if (!ownerState) throw new Error('UNKNOWN_TASK');
          if (input.expectedControlVersion !== target.controlVersion) {
            throw new Error('STALE_CONTROL_VERSION');
          }
          // NeedsInfo allows expectedTaskVersion === 0 because ExperimentView does not expose task.stateVersion before an approval pause.
          const matchesVersion = input.expectedTaskVersion === ownerState.stateVersion || (ownerState.node === 'NeedsInfo' && input.expectedTaskVersion === 0);
          if (!matchesVersion) {
            throw new Error('STALE_TASK_VERSION');
          }
          const receiptRef = `controlled-direction-${target.task.taskId}-${target.controlVersion + 1}`;
          target.controlVersion += 1;
          const receipt: ServiceControlReceipt = {
            receiptRef,
            kind: input.kind,
            taskId: target.task.taskId,
            controlVersion: target.controlVersion,
          };
          target.directionsByRef.set(receiptRef, { receipt, taskVersion: ownerState.stateVersion, feedback: input.feedback });
          return receipt;
        },
      },
      approval: {
        async presentation(experimentId) {
          const target = sessionsByExperimentId.get(experimentId);
          const presentation = target?.currentPresentation;
          if (!target || !presentation) return { ok: false, status: 'not-found', reasonCode: 'NO_PRESENTATION' };
          const ownerState = await target.statePort.loadTask(target.task.taskId);
          if (!ownerState) return { ok: false, status: 'not-found', reasonCode: 'NO_PRESENTATION' };
          const decidedStatus = target.decided.get(presentation.binding.decisionId);
          return {
            ok: true,
            value: {
              experimentId,
              taskId: presentation.binding.taskId,
              decisionId: presentation.binding.decisionId,
              actionKind: presentation.binding.actionKind,
              status: decidedStatus ?? presentation.binding.status,
              presentationVersion: presentation.version,
              requestVersion: presentation.version,
              presentationDigest: presentation.digest,
              taskStateVersion: ownerState.stateVersion,
              controlVersion: target.controlVersion,
              node: ownerState.node,
            },
          };
        },
        async decide(input) {
          const body = (typeof input === 'object' && input !== null ? input : {}) as Readonly<Record<string, unknown>>;
          const experimentId = typeof body['experimentId'] === 'string' ? body['experimentId'] : '';
          const target = sessionsByExperimentId.get(experimentId);
          const presentation = target?.currentPresentation;
          if (!target || !presentation) return { ok: false, status: 'not-found', reasonCode: 'NO_PRESENTATION' };

          const decision = body['decision'] ?? body['choice'];
          const idempotencyKey = typeof body['idempotencyKey'] === 'string' && body['idempotencyKey'].trim() !== '' ? body['idempotencyKey'] : undefined;
          const expectedVersion = typeof body['expectedVersion'] === 'number' ? body['expectedVersion'] : presentation.version;
          const presentationDigest = typeof body['presentationDigest'] === 'string' ? body['presentationDigest'] : undefined;
          const decisionIdBody = typeof body['decisionId'] === 'string' ? body['decisionId'] : undefined;

          if (decision !== 'approve' && decision !== 'reject') {
            return { ok: false, status: 'invalid-input', reasonCode: 'UNSUPPORTED_CHOICE' };
          }
          const fingerprint = sha256Text(JSON.stringify([experimentId, decision, expectedVersion, presentationDigest ?? null, decisionIdBody ?? null, presentation.binding.decisionId]));
          if (idempotencyKey !== undefined) {
            const replayed = target.decisionReplays.get(idempotencyKey);
            if (replayed) {
              if (replayed.fingerprint !== fingerprint) return { ok: false, status: 'conflict', reasonCode: 'CONFLICTING_REPLAY' };
              return { ok: true, value: replayed.result };
            }
          }
          if (decisionIdBody !== undefined && decisionIdBody !== presentation.binding.decisionId) {
            return { ok: false, status: 'conflict', reasonCode: 'STALE_DECISION' };
          }
          if (presentationDigest !== undefined && presentationDigest !== presentation.digest) {
            return { ok: false, status: 'conflict', reasonCode: 'STALE_DECISION' };
          }
          if (expectedVersion !== presentation.version) {
            return { ok: false, status: 'conflict', reasonCode: 'STALE_VERSION' };
          }
          if (target.decided.has(presentation.binding.decisionId)) {
            return { ok: false, status: 'conflict', reasonCode: 'DECISION_ALREADY_RECORDED' };
          }

          const snapshot = await target.statePort.readVerificationAuthoritySnapshot(target.task.taskId);
          if (!snapshot) return { ok: false, status: 'conflict', reasonCode: 'AUTHORITY_UNAVAILABLE' };
          const nextAuthority = { ...snapshot.policyIdentity, decisionAuthorityGeneration: snapshot.decisionAuthorityGeneration + 1 };
          if ((await target.statePort.publishAuthority({ authorityRef: nextAuthority })).status !== 'published') {
            return { ok: false, status: 'conflict', reasonCode: 'AUTHORITY_PUBLISH_FAILED' };
          }
          const nextStatus = decision === 'approve' ? ('approved' as const) : ('rejected' as const);
          const ownerState = await target.statePort.loadTask(target.task.taskId);
          const approvedBinding: ApprovalBinding = { ...presentation.binding, status: nextStatus };
          target.approvalPort.setV02AuthorityRef(nextAuthority);
          target.approvalPort.scriptDecision(approvedBinding);
          target.decided.set(presentation.binding.decisionId, nextStatus);
          if (nextStatus === 'approved' && presentation.binding.actionKind === 'fix_plan' && ownerState) {
            target.transitionContexts.set(ownerState.stateVersion + 1, {
              approval: {
                binding: approvedBinding,
                freshness: buildDynamicApprovalContext(target.task, ownerState, approvedBinding),
              },
            });
          }
          if (nextStatus === 'approved' && presentation.binding.decisionId.startsWith('dec-verify-')) {
            target.repositoryPort.setCommandResult(REPRO_COMMAND, { exitCode: 0, stdout: '1 passed', stderr: '' });
          }
          const result = {
            outcome: 'ok',
            decision,
            status: nextStatus,
            safeReasonCode: nextStatus === 'approved' ? 'APPROVED' : 'REJECTED',
            decisionId: presentation.binding.decisionId,
            experimentId,
            taskId: target.task.taskId,
            version: ownerState?.stateVersion ?? 0,
            controlVersion: target.controlVersion,
            safeNextAction: nextStatus === 'approved' ? 'issue-resume-direction-and-continue' : 'issue-resume-then-revise-or-end',
          } as const;
          if (idempotencyKey !== undefined) {
            target.decisionReplays.set(idempotencyKey, { fingerprint, result });
          }
          return { ok: true, value: result };
        },
      },
      routesFor(_ready, catalog) {
        const map = new Map<string, UC03EvaluationGraphRoute>();
        for (const entry of catalog) {
          map.set(entry.caseId, routeForCase(entry, entry.caseId === 'C02' ? 'C02' : 'C01'));
        }
        return map;
      },
      customRoute: {
        ...routeConfig,
        expectedWait: 'waiting-approval',
        resolveTask: async ({ experimentId, source, priorState }) => {
          if (priorState !== null) {
            const existing = stateForTask(priorState.taskId);
            activeSession = existing;
            return existing.task;
          }
          const existingForExperiment = sessionsByExperimentId.get(experimentId);
          if (existingForExperiment) {
            activeSession = existingForExperiment;
            return existingForExperiment.task;
          }
          if (source.kind !== 'bug') throw new Error('Custom route requires a bug source');
          const session = await createSession(experimentId, 'custom', {
            repositoryId: source.repositoryId,
            goal: source.bugInput.goal,
            observedBehavior: source.bugInput.observedBehavior,
            expectedBehavior: source.bugInput.expectedBehavior,
            reproduction: source.bugInput.reproduction,
            acceptanceCriteria: [...source.bugInput.acceptanceCriteria],
            constraints: [...(source.bugInput.constraints ?? [])],
          });
          return session.task;
        },
      },
      operatorToken: () => {
        if (!printedToken) {
          printedToken = true;
          process.stderr.write(`UC-03 controlled console operator token (${tokenSource}): ${token}\n`);
        }
        return token;
      },
    };
    return assembly;
  };

  return { host, console: consoleFactory };
}

export { CONTRACT_VERSION };
