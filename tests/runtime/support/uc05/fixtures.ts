/**
 * UC-05 acceptance inputs and hidden expected oracles.
 *
 * These records are test-only. Expected outcomes stay under tests/runtime and
 * are never imported by product code or copied into agent context.
 *
 * Digest profile `uc05-fixture-canonical-json-sha256-v1` serializes JSON
 * values as UTF-8 JSON, object keys sorted using ECMAScript UTF-16 code-unit
 * order, and arrays kept in declared order. Non-finite numbers and non-JSON values are
 * rejected. Oracle digests hash the oracle body without `digest`; fixture
 * digests hash the complete fixture body, including the oracle digest, without
 * `fixtureDigest`. Each hash is SHA-256 over
 * `${profile}\n${canonicalJson}` and is rendered as `sha256:<lowercase hex>`.
 */

import { createHash } from 'node:crypto';

export const UC05_FIXTURE_SCHEMA_VERSION = 'uc05-case-fixture/1' as const;
export const UC05_FIXTURE_VERSION = 'uc05-local-v1' as const;
export const UC05_ORACLE_VERSION = 'uc05-oracle/1' as const;
export const UC05_FIXTURE_DIGEST_PROFILE = 'uc05-fixture-canonical-json-sha256-v1' as const;
export const UC05_ORACLE_DIGEST_PROFILE = 'uc05-oracle-canonical-json-sha256-v1' as const;

export type Uc05CaseId =
  | 'C01' | 'C02' | 'C03' | 'C04' | 'C05' | 'C06' | 'C07' | 'C08'
  | 'C09' | 'C10' | 'C11' | 'C12' | 'C13' | 'C14' | 'C15' | 'C16'
  | 'C17' | 'C18' | 'C19' | 'C20' | 'C21' | 'C22' | 'C23' | 'C24';

export type Uc05EvidenceLevel = 'unit' | 'mock' | 'cli' | 'real' | 'restart';
export type Uc05ActionKind = 'run_command' | 'apply_patch' | 'approve_fix_plan';
export type Uc05ExpectedOutcome =
  | 'allowed'
  | 'approval-required'
  | 'forbidden'
  | 'prerequisite-denied'
  | 'paused'
  | 'rejected'
  | 'direction-recorded'
  | 'stale'
  | 'conflict'
  | 'recovered'
  | 'uncertain'
  | 'safe-presentation'
  | 'not-executable'
  | 'comparable-catalog';

export interface Uc05FiniteTestProfile {
  readonly id: typeof UC05_FIXTURE_VERSION;
  readonly status: 'test-only';
  readonly productionDefault: false;
  readonly patch: {
    readonly maxFiles: 8;
    readonly maxAddedPlusDeletedLines: 400;
  };
  readonly maxActionBytes: 65536;
  readonly argv: {
    readonly maxEntries: 32;
    readonly maxEntryBytes: 4096;
  };
  readonly presentation: {
    readonly maxBytesPerPage: 8192;
    readonly maxPages: 3;
    readonly maxTotalBytes: 24576;
  };
  readonly maxEventBytes: 1024;
  readonly operationDeadlineMs: 2000;
  readonly maxMutationAttempts: 1;
  readonly executorResourceLimits: {
    readonly cpu: null;
    readonly memory: null;
    readonly processes: null;
    readonly network: null;
    readonly tokens: null;
    readonly cost: null;
  };
  readonly authorizesRealExecution: false;
}

export interface Uc05ExpectedCounts {
  readonly actionDispatches: number;
  readonly coderDispatches: number;
  readonly reviewerDispatches: number;
  readonly modelDispatches: number;
  readonly toolDispatches: number;
  readonly backgroundDispatches: number;
  readonly unrelatedTaskDispatches: number;
  readonly approvalPrompts: number;
  readonly operatorDecisions: number;
  readonly readEffects: number;
  readonly testEffects: number;
  readonly mutationEffects: number;
  readonly completedInFlightEffects: number;
  readonly cancelledInFlightOperations: number;
  readonly uncertainInFlightEffects: number;
  readonly reconciliationAttempts: number;
  readonly duplicateAttempts: number;
  readonly unauthorizedDispatches: number;
  readonly unauthorizedEffects: number;
  readonly planSlotsConsumed: number;
  readonly planSlotsRefunded: number;
  readonly catalogCaseObservations: number;
  readonly missingAsPass: number;
  readonly notRunAsPass: number;
  readonly approvalOnlyAsPass: number;
  readonly budgetReservationsRefunded: number;
  readonly claimAcquisitions: number;
  readonly pendingRequestWinners: number;
  readonly duplicateResponseDeliveries: number;
}

export interface Uc05FixtureVector {
  readonly id: string;
  /** null means inherit the case-level trusted action kind. */
  readonly actionKind: Uc05ActionKind | null;
  /** Named dimensions only; no source text, prompt, credential or tool stream. */
  readonly changedDimensions: readonly string[];
  readonly operatorEvents: readonly string[];
  readonly failpoints: readonly string[];
  readonly expectedOutcome: Uc05ExpectedOutcome;
  readonly expectedReason: string;
  readonly expectedCounts: Uc05ExpectedCounts;
}

export interface Uc05FreshnessDimensions {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly repositoryMappingDigest: string;
  readonly repositoryRevisionDigest: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly configId: string;
  readonly configVersion: string;
  readonly actionId: string;
  readonly normalizedActionDigest: string;
  readonly planVersion: number;
  readonly strategyDigest: string;
  readonly baselineRef: string;
  readonly evidenceRefs: readonly string[];
  readonly criteriaDigest: string;
  readonly checkSetDigest: string;
}

export interface Uc05CaseFixture {
  readonly schemaVersion: typeof UC05_FIXTURE_SCHEMA_VERSION;
  readonly caseId: Uc05CaseId;
  readonly fixtureVersion: typeof UC05_FIXTURE_VERSION;
  readonly fixtureDigest: string;
  readonly storyRefs: readonly string[];
  readonly requirementRefs: readonly string[];
  readonly successCriteriaRefs: readonly string[];
  readonly scenarioIntent: string;
  readonly evidence: {
    readonly requiredLevel: Uc05EvidenceLevel;
    readonly localPreparationLevel: Uc05EvidenceLevel;
    readonly taskRefs: readonly string[];
    readonly externalGates: readonly string[];
    readonly status: 'not-run';
    readonly localEvidenceSatisfiesRequiredLevel: false;
  };
  readonly profile: Uc05FiniteTestProfile;
  readonly initialIdentities: {
    readonly taskId: string;
    readonly runId: string;
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly controlId: string;
    readonly controlVersion: number;
    readonly controlEpoch: number;
    readonly controlMode: 'runnable' | 'waiting' | 'rejected' | 'recovery-blocked';
    readonly requestId: string;
    readonly requestState: 'absent' | 'pending' | 'approved' | 'rejected';
    readonly claimId: string;
    readonly claimState: 'absent' | 'claimed' | 'dispatched' | 'uncertain' | 'reconciled';
  };
  readonly trustedAction: {
    readonly actionId: string;
    readonly kind: Uc05ActionKind;
    readonly classification: 'ALLOWED' | 'APPROVAL_REQUIRED' | 'FORBIDDEN' | 'INVALID';
    readonly effectClass: 'read' | 'test' | 'mutation' | 'none';
    readonly targetClasses: readonly string[];
    readonly commandCapability: string;
    readonly actorProvenance: 'trusted-host' | 'mock' | 'unknown';
    readonly inputProvenance: 'registered' | 'unregistered' | 'untrusted-task-data';
    readonly artifactDigest: string;
  };
  readonly trustedContext: {
    readonly taskRole: 'coder' | 'reviewer' | 'model' | 'tool' | 'background' | 'operator' | 'aggregate';
    readonly repositoryMappingDigest: string;
    readonly repositoryRevisionDigest: string;
    readonly policyId: string;
    readonly policyVersion: string;
    readonly configId: string;
    readonly configVersion: string;
    readonly isolationProfileId: string;
    readonly operatorChannel: 'trusted-host-only' | 'unavailable-to-task-code';
    readonly freshness: Uc05FreshnessDimensions;
  };
  readonly scriptedOperatorEvents: readonly string[];
  readonly failpoints: readonly string[];
  readonly oracle: {
    readonly version: typeof UC05_ORACLE_VERSION;
    readonly digest: string;
    readonly expectedOutcome: string;
    readonly expectedCounts: Uc05ExpectedCounts;
    readonly vectors: readonly Uc05FixtureVector[];
  };
}

/** Exact finite values from policy.md. Null executor limits mean this profile cannot authorize real execution. */
export const UC05_LOCAL_TEST_PROFILE: Uc05FiniteTestProfile = deepFreeze({
  id: UC05_FIXTURE_VERSION,
  status: 'test-only',
  productionDefault: false,
  patch: { maxFiles: 8, maxAddedPlusDeletedLines: 400 },
  maxActionBytes: 65536,
  argv: { maxEntries: 32, maxEntryBytes: 4096 },
  presentation: { maxBytesPerPage: 8192, maxPages: 3, maxTotalBytes: 24576 },
  maxEventBytes: 1024,
  operationDeadlineMs: 2000,
  maxMutationAttempts: 1,
  executorResourceLimits: { cpu: null, memory: null, processes: null, network: null, tokens: null, cost: null },
  authorizesRealExecution: false,
});

type CountOverrides = Partial<Uc05ExpectedCounts>;

const ZERO_COUNTS: Uc05ExpectedCounts = {
  actionDispatches: 0,
  coderDispatches: 0,
  reviewerDispatches: 0,
  modelDispatches: 0,
  toolDispatches: 0,
  backgroundDispatches: 0,
  unrelatedTaskDispatches: 0,
  approvalPrompts: 0,
  operatorDecisions: 0,
  readEffects: 0,
  testEffects: 0,
  mutationEffects: 0,
  completedInFlightEffects: 0,
  cancelledInFlightOperations: 0,
  uncertainInFlightEffects: 0,
  reconciliationAttempts: 0,
  duplicateAttempts: 0,
  unauthorizedDispatches: 0,
  unauthorizedEffects: 0,
  planSlotsConsumed: 0,
  planSlotsRefunded: 0,
  catalogCaseObservations: 0,
  missingAsPass: 0,
  notRunAsPass: 0,
  approvalOnlyAsPass: 0,
  budgetReservationsRefunded: 0,
  claimAcquisitions: 0,
  pendingRequestWinners: 0,
  duplicateResponseDeliveries: 0,
};

function expectedCounts(overrides: CountOverrides = {}): Uc05ExpectedCounts {
  return { ...ZERO_COUNTS, ...overrides };
}

function vector(
  id: string,
  changedDimensions: readonly string[],
  expectedOutcome: Uc05ExpectedOutcome,
  expectedReason: string,
  overrides: CountOverrides = {},
  operatorEvents: readonly string[] = [],
  failpoints: readonly string[] = [],
  actionKind: Uc05ActionKind | null = null,
): Uc05FixtureVector {
  return {
    id,
    actionKind,
    changedDimensions,
    operatorEvents,
    failpoints,
    expectedOutcome,
    expectedReason,
    expectedCounts: expectedCounts(overrides),
  };
}

interface CaseSeed {
  readonly caseId: Uc05CaseId;
  readonly storyRefs: readonly string[];
  readonly requirementRefs: readonly string[];
  readonly successCriteriaRefs: readonly string[];
  readonly scenarioIntent: string;
  readonly requiredLevel: Uc05EvidenceLevel;
  readonly localPreparationLevel: Uc05EvidenceLevel;
  readonly taskRefs: readonly string[];
  readonly externalGates: readonly string[];
  readonly initialControlMode: Uc05CaseFixture['initialIdentities']['controlMode'];
  readonly requestState: Uc05CaseFixture['initialIdentities']['requestState'];
  readonly claimState: Uc05CaseFixture['initialIdentities']['claimState'];
  readonly actionKind: Uc05ActionKind;
  readonly classification: Uc05CaseFixture['trustedAction']['classification'];
  readonly effectClass: Uc05CaseFixture['trustedAction']['effectClass'];
  readonly targetClasses: readonly string[];
  readonly commandCapability: string;
  readonly actorProvenance: Uc05CaseFixture['trustedAction']['actorProvenance'];
  readonly inputProvenance: Uc05CaseFixture['trustedAction']['inputProvenance'];
  readonly taskRole: Uc05CaseFixture['trustedContext']['taskRole'];
  readonly operatorChannel: Uc05CaseFixture['trustedContext']['operatorChannel'];
  readonly scriptedOperatorEvents: readonly string[];
  readonly failpoints: readonly string[];
  readonly expectedOutcome: string;
  readonly vectors: readonly Uc05FixtureVector[];
  readonly planVersion: number;
}

const HASH_FIELDS = [
  'repository-mapping', 'repository-revision', 'action', 'strategy',
  'criteria', 'check-set', 'artifact',
] as const;

function stableHash(label: string): string {
  return sha256(`uc05-fixture-identity-v1\n${label}`);
}

function seedToFixture(seed: CaseSeed): Uc05CaseFixture {
  const lowerId = seed.caseId.toLowerCase();
  const taskId = `uc05-${lowerId}-task`;
  const runId = `uc05-${lowerId}-run-1`;
  const workspaceId = `uc05-${lowerId}-workspace`;
  const repositoryId = `uc05-${lowerId}-repository`;
  const actionId = `uc05-${lowerId}-action-1`;
  const freshness: Uc05FreshnessDimensions = {
    taskId,
    workspaceId,
    repositoryId,
    repositoryMappingDigest: stableHash(`${lowerId}:${HASH_FIELDS[0]}`),
    repositoryRevisionDigest: stableHash(`${lowerId}:${HASH_FIELDS[1]}`),
    policyId: 'uc05-fixture-policy',
    policyVersion: '1',
    configId: UC05_FIXTURE_VERSION,
    configVersion: '1',
    actionId,
    normalizedActionDigest: stableHash(`${lowerId}:${HASH_FIELDS[2]}`),
    planVersion: seed.planVersion,
    strategyDigest: stableHash(`${lowerId}:${HASH_FIELDS[3]}`),
    baselineRef: `uc05-${lowerId}-baseline-1`,
    evidenceRefs: [`uc05-${lowerId}-evidence-1`],
    criteriaDigest: stableHash(`${lowerId}:${HASH_FIELDS[4]}`),
    checkSetDigest: stableHash(`${lowerId}:${HASH_FIELDS[5]}`),
  };
  const fixtureBody = {
    schemaVersion: UC05_FIXTURE_SCHEMA_VERSION,
    caseId: seed.caseId,
    fixtureVersion: UC05_FIXTURE_VERSION,
    storyRefs: seed.storyRefs,
    requirementRefs: seed.requirementRefs,
    successCriteriaRefs: seed.successCriteriaRefs,
    scenarioIntent: seed.scenarioIntent,
    evidence: {
      requiredLevel: seed.requiredLevel,
      localPreparationLevel: seed.localPreparationLevel,
      taskRefs: seed.taskRefs,
      externalGates: seed.externalGates,
      status: 'not-run' as const,
      localEvidenceSatisfiesRequiredLevel: false as const,
    },
    profile: UC05_LOCAL_TEST_PROFILE,
    initialIdentities: {
      taskId,
      runId,
      workspaceId,
      repositoryId,
      controlId: `uc05-${lowerId}-control-1`,
      controlVersion: 1,
      controlEpoch: 1,
      controlMode: seed.initialControlMode,
      requestId: `uc05-${lowerId}-decision-1`,
      requestState: seed.requestState,
      claimId: `uc05-${lowerId}-claim-1`,
      claimState: seed.claimState,
    },
    trustedAction: {
      actionId,
      kind: seed.actionKind,
      classification: seed.classification,
      effectClass: seed.effectClass,
      targetClasses: seed.targetClasses,
      commandCapability: seed.commandCapability,
      actorProvenance: seed.actorProvenance,
      inputProvenance: seed.inputProvenance,
      artifactDigest: stableHash(`${lowerId}:${HASH_FIELDS[6]}`),
    },
    trustedContext: {
      taskRole: seed.taskRole,
      repositoryMappingDigest: freshness.repositoryMappingDigest,
      repositoryRevisionDigest: freshness.repositoryRevisionDigest,
      policyId: freshness.policyId,
      policyVersion: freshness.policyVersion,
      configId: freshness.configId,
      configVersion: freshness.configVersion,
      isolationProfileId: UC05_FIXTURE_VERSION,
      operatorChannel: seed.operatorChannel,
      freshness,
    },
    scriptedOperatorEvents: seed.scriptedOperatorEvents,
    failpoints: seed.failpoints,
  };
  const oracleBody = {
    version: UC05_ORACLE_VERSION,
    expectedOutcome: seed.expectedOutcome,
    expectedCounts: sumVectorCounts(seed.vectors),
    vectors: seed.vectors,
  };
  const oracle = { ...oracleBody, digest: digestObject(UC05_ORACLE_DIGEST_PROFILE, oracleBody) };
  const withoutFixtureDigest = { ...fixtureBody, oracle };
  const fixtureDigest = digestObject(UC05_FIXTURE_DIGEST_PROFILE, withoutFixtureDigest);
  return deepFreeze({ ...withoutFixtureDigest, fixtureDigest }) as Uc05CaseFixture;
}

function sumVectorCounts(vectors: readonly Uc05FixtureVector[]): Uc05ExpectedCounts {
  const totals: Record<keyof Uc05ExpectedCounts, number> = { ...ZERO_COUNTS };
  for (const item of vectors) {
    for (const key of Object.keys(ZERO_COUNTS) as (keyof Uc05ExpectedCounts)[]) {
      totals[key] += item.expectedCounts[key];
    }
  }
  return totals;
}

const EXTERNAL_REAL = ['G-PROFILE', 'G-REAL', 'X04-APPROVAL-STORE', 'X03-ADMISSION'] as const;
const EXTERNAL_PLAN = [...EXTERNAL_REAL, 'X03-PLAN-CONTEXT'] as const;
const EXTERNAL_RESTART = [...EXTERNAL_REAL, 'G-RESTART', 'X04-X05-RESTART'] as const;

const CASE_SEEDS: readonly CaseSeed[] = [
  {
    caseId: 'C01', storyRefs: ['US1', 'US3'], requirementRefs: ['FR-001', 'FR-002', 'FR-016'], successCriteriaRefs: ['SC-001'],
    scenarioIntent: 'Bounded read/search, configured test, and ordinary current-plan patch each receive the declared permission with no extra prompt.',
    requiredLevel: 'real', localPreparationLevel: 'mock', taskRefs: ['T005', 'T006', 'T007', 'T020'], externalGates: EXTERNAL_REAL,
    initialControlMode: 'runnable', requestState: 'absent', claimState: 'absent', actionKind: 'run_command', classification: 'ALLOWED', effectClass: 'read',
    targetClasses: ['workspace-bounded-read', 'configured-test', 'current-plan-patch'], commandCapability: 'registered-read-and-test', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'coder', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: [], failpoints: [], expectedOutcome: 'All allowed vectors dispatch once without an action prompt; only the patch vector mutates.', planVersion: 1,
    vectors: [
      vector('bounded-read', ['action=bounded-search'], 'allowed', 'registered-bounded-read', { actionDispatches: 1, toolDispatches: 1, readEffects: 1 }),
      vector('configured-test', ['action=configured-test'], 'allowed', 'registered-test-profile', { actionDispatches: 1, toolDispatches: 1, testEffects: 1 }),
      vector('ordinary-patch', ['action=ordinary-patch', 'plan=current'], 'allowed', 'current-approved-plan', { actionDispatches: 1, toolDispatches: 1, mutationEffects: 1 }, [], [], 'apply_patch'),
    ],
  },
  {
    caseId: 'C02', storyRefs: ['US1', 'US3'], requirementRefs: ['FR-002', 'FR-005', 'FR-006'], successCriteriaRefs: ['SC-001', 'SC-003'],
    scenarioIntent: 'Each approval-required change pauses before any effect and presents the five decision elements.',
    requiredLevel: 'real', localPreparationLevel: 'cli', taskRefs: ['T005', 'T006', 'T007', 'T020'], externalGates: EXTERNAL_REAL,
    initialControlMode: 'runnable', requestState: 'absent', claimState: 'absent', actionKind: 'apply_patch', classification: 'APPROVAL_REQUIRED', effectClass: 'mutation',
    targetClasses: ['dependency', 'deletion', 'move', 'sensitive-config', 'broad-patch', 'supported-nonallowlisted-command'], commandCapability: 'registered-but-approval-required', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'coder', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['request-created', 'five-elements-rendered', 'no-terminal-decision'], failpoints: [], expectedOutcome: 'Six independent approval-required vectors each create one safe prompt and zero dispatch or effects.', planVersion: 1,
    vectors: ['dependency-change', 'deletion', 'move', 'sensitive-config', 'broad-patch', 'supported-nonallowlisted-command'].map((name) => vector(name, [`action=${name}`, 'prompt-elements=necessity,targets,consequences,verification-status,exact-command-or-patch'], 'approval-required', 'explicit-human-decision-required', { approvalPrompts: 1 }, [], [], name === 'supported-nonallowlisted-command' ? 'run_command' : 'apply_patch')),
  },
  {
    caseId: 'C03', storyRefs: ['US1'], requirementRefs: ['FR-003'], successCriteriaRefs: ['SC-001'],
    scenarioIntent: 'Workspace escape, secret access, hidden grading, test weakening, forbidden command, and reviewer write stay forbidden regardless of approval.',
    requiredLevel: 'real', localPreparationLevel: 'mock', taskRefs: ['T005', 'T006', 'T007', 'T020'], externalGates: EXTERNAL_REAL,
    initialControlMode: 'runnable', requestState: 'absent', claimState: 'absent', actionKind: 'run_command', classification: 'FORBIDDEN', effectClass: 'none',
    targetClasses: ['workspace-escape', 'secret', 'hidden-grading', 'test-weakening', 'forbidden-command', 'reviewer-write'], commandCapability: 'forbidden', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'reviewer', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['attempted-approval-does-not-override-forbidden'], failpoints: [], expectedOutcome: 'Every forbidden vector is denied with no prompt, dispatch, or effect.', planVersion: 1,
    vectors: ['workspace-escape', 'secret-access', 'hidden-grading', 'test-weakening', 'forbidden-command', 'reviewer-write'].map((name) => vector(name, [`target=${name}`], 'forbidden', 'forbidden-action-no-override')),
  },
  {
    caseId: 'C04', storyRefs: ['US1'], requirementRefs: ['FR-001', 'FR-002', 'FR-003'], successCriteriaRefs: ['SC-001'],
    scenarioIntent: 'Missing, malformed, non-finite, out-of-range, or unknown policy/context input produces a safe prerequisite result before dispatch.',
    requiredLevel: 'real', localPreparationLevel: 'unit', taskRefs: ['T002', 'T005', 'T006', 'T007', 'T020'], externalGates: EXTERNAL_REAL,
    initialControlMode: 'runnable', requestState: 'absent', claimState: 'absent', actionKind: 'run_command', classification: 'INVALID', effectClass: 'none',
    targetClasses: ['policy', 'limits', 'breadth', 'trusted-context', 'unknown-fields'], commandCapability: 'not-evaluated', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'coder', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: [], failpoints: [], expectedOutcome: 'Each invalid prerequisite denies safely with zero prompts, dispatches, and effects.', planVersion: 1,
    vectors: ['missing-policy', 'malformed-limits', 'nan-or-infinite-bound', 'invalid-breadth', 'missing-trusted-context', 'unknown-execution-field'].map((name) => vector(name, [`invalid-input=${name}`], 'prerequisite-denied', 'required-finite-trusted-input-missing-or-invalid')),
  },
  {
    caseId: 'C05', storyRefs: ['US1', 'US2'], requirementRefs: ['FR-004'], successCriteriaRefs: ['SC-003'],
    scenarioIntent: 'Model, source, output, clarification, or PR-approval text cannot submit a runtime decision; repository code cannot use the host operator channel.',
    requiredLevel: 'real', localPreparationLevel: 'cli', taskRefs: ['T007', 'T010', 'T020'], externalGates: EXTERNAL_REAL,
    initialControlMode: 'waiting', requestState: 'pending', claimState: 'absent', actionKind: 'run_command', classification: 'INVALID', effectClass: 'none',
    targetClasses: ['untrusted-decision-source', 'host-capability-boundary'], commandCapability: 'operator-channel-unavailable-to-task-code', actorProvenance: 'unknown', inputProvenance: 'untrusted-task-data', taskRole: 'model', operatorChannel: 'unavailable-to-task-code',
    scriptedOperatorEvents: ['reject-untrusted-model-text', 'reject-untrusted-source-text', 'reject-untrusted-output-text', 'reject-clarification-text', 'reject-pr-approval-text'], failpoints: [], expectedOutcome: 'Five untrusted sources fail to resolve the pending request and cause no task dispatch or effect.', planVersion: 1,
    vectors: ['model-text', 'source-text', 'tool-output', 'clarification', 'pr-approval-text'].map((name) => vector(name, [`decision-source=${name}`], 'paused', 'only-trusted-host-operator-can-decide')),
  },
  {
    caseId: 'C06', storyRefs: ['US2'], requirementRefs: ['FR-006', 'FR-019'], successCriteriaRefs: ['SC-002'],
    scenarioIntent: 'A pending request bars coder, reviewer, model, tool, and background work for its task while an unrelated task progresses.',
    requiredLevel: 'real', localPreparationLevel: 'mock', taskRefs: ['T008', 'T009', 'T010', 'T020'], externalGates: EXTERNAL_REAL,
    initialControlMode: 'waiting', requestState: 'pending', claimState: 'absent', actionKind: 'run_command', classification: 'ALLOWED', effectClass: 'none',
    targetClasses: ['task-wide-admission-barrier'], commandCapability: 'none-while-waiting', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'aggregate', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['pending-prompt-already-issued'], failpoints: [], expectedOutcome: 'Five same-task admission attempts remain fenced; one unrelated task dispatch is admitted.', planVersion: 1,
    vectors: [vector('all-agent-roles', ['roles=coder,reviewer,model,tool,background', 'scope=one-task'], 'paused', 'pending-task-control-fences-all-agents', { approvalPrompts: 1, unrelatedTaskDispatches: 1 })],
  },
  {
    caseId: 'C07', storyRefs: ['US2', 'US5'], requirementRefs: ['FR-007', 'FR-020', 'FR-021'], successCriteriaRefs: ['SC-002', 'SC-007'],
    scenarioIntent: 'Rejection fences the task, requests cancellation where possible, and reports already completed, cancelled, or uncertain work without claiming rollback.',
    requiredLevel: 'real', localPreparationLevel: 'mock', taskRefs: ['T008', 'T009', 'T010', 'T020'], externalGates: EXTERNAL_REAL,
    initialControlMode: 'waiting', requestState: 'pending', claimState: 'dispatched', actionKind: 'apply_patch', classification: 'APPROVAL_REQUIRED', effectClass: 'mutation',
    targetClasses: ['in-flight-completed', 'in-flight-cancellable', 'in-flight-uncertain'], commandCapability: 'mutation', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'coder', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['reject-current-request'], failpoints: [], expectedOutcome: 'Rejection stops new work and records one completed, one cancelled, and one uncertain prior operation without undo claims.', planVersion: 1,
    vectors: [vector('reject-with-in-flight-work', ['in-flight=completed,cancelled,uncertain'], 'rejected', 'task-fenced-effects-reported-not-rolled-back', { approvalPrompts: 1, operatorDecisions: 1, completedInFlightEffects: 1, cancelledInFlightOperations: 1, uncertainInFlightEffects: 1 })],
  },
  {
    caseId: 'C08', storyRefs: ['US2'], requirementRefs: ['FR-008', 'FR-019'], successCriteriaRefs: ['SC-002'],
    scenarioIntent: 'Facts or feedback leave rejection paused; explicit resume, revise, or end is scoped, preserves history, and never approves work.',
    requiredLevel: 'real', localPreparationLevel: 'cli', taskRefs: ['T008', 'T009', 'T010', 'T020'], externalGates: EXTERNAL_REAL,
    initialControlMode: 'rejected', requestState: 'rejected', claimState: 'absent', actionKind: 'run_command', classification: 'ALLOWED', effectClass: 'none',
    targetClasses: ['feedback-only', 'explicit-resume', 'explicit-revise', 'explicit-end'], commandCapability: 'no-action-authority', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'operator', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['feedback-only', 'resume-scoped', 'revise-scoped', 'end-task'], failpoints: [], expectedOutcome: 'Feedback alone leaves rejection held; each explicit direction is recorded without approving the rejected action.', planVersion: 1,
    vectors: [
      vector('feedback-only', ['direction=feedback'], 'paused', 'feedback-is-not-a-direction', { approvalPrompts: 1 }),
      vector('resume', ['direction=resume'], 'direction-recorded', 'resume-does-not-approve-action', { approvalPrompts: 1, operatorDecisions: 1 }, ['explicit-resume']),
      vector('revise', ['direction=revise'], 'direction-recorded', 'revise-does-not-approve-action', { approvalPrompts: 1, operatorDecisions: 1 }, ['explicit-revise']),
      vector('end', ['direction=end'], 'direction-recorded', 'end-retains-history-and-uncertainty', { approvalPrompts: 1, operatorDecisions: 1 }, ['explicit-end']),
    ],
  },
  {
    caseId: 'C09', storyRefs: ['US3'], requirementRefs: ['FR-009', 'FR-012'], successCriteriaRefs: ['SC-004'],
    scenarioIntent: 'A rejected or revised action receives a new request identity; the prior immutable decision never authorizes the replacement.',
    requiredLevel: 'real', localPreparationLevel: 'mock', taskRefs: ['T011', 'T012', 'T020'], externalGates: EXTERNAL_REAL,
    initialControlMode: 'rejected', requestState: 'rejected', claimState: 'absent', actionKind: 'apply_patch', classification: 'APPROVAL_REQUIRED', effectClass: 'mutation',
    targetClasses: ['revised-action'], commandCapability: 'new-decision-slot-required', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'coder', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['reject-request-1', 'revise-task', 'create-request-2', 'approve-request-2'], failpoints: [], expectedOutcome: 'Old and new request IDs remain distinct; only the fresh request is resolved and no replacement effect is duplicated.', planVersion: 2,
    vectors: [vector('reject-then-revise', ['requestId=1->2', 'old-decision=immutable'], 'approval-required', 'replacement-requires-fresh-request-and-decision', { approvalPrompts: 2, operatorDecisions: 2 }, ['reject-old', 'revise', 'approve-new'])],
  },
  {
    caseId: 'C10', storyRefs: ['US2', 'US3'], requirementRefs: ['FR-008', 'FR-009'], successCriteriaRefs: ['SC-002', 'SC-004'],
    scenarioIntent: 'Changing IDs, tools, spelling, or encoding cannot bypass a rejected task; forbidden actions remain forbidden after a direction.',
    requiredLevel: 'real', localPreparationLevel: 'mock', taskRefs: ['T008', 'T009', 'T010', 'T020'], externalGates: EXTERNAL_REAL,
    initialControlMode: 'rejected', requestState: 'rejected', claimState: 'absent', actionKind: 'run_command', classification: 'FORBIDDEN', effectClass: 'none',
    targetClasses: ['alternate-id', 'alternate-tool', 'spelling-variant', 'encoding-variant', 'forbidden-after-direction'], commandCapability: 'task-fenced-and-forbidden-precedence', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'coder', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['task-rejected', 'explicit-direction-before-forbidden-vector'], failpoints: [], expectedOutcome: 'Five retries produce no dispatch, prompt, or effect; forbidden precedence remains after direction.', planVersion: 1,
    vectors: ['changed-id', 'changed-tool', 'spelling-change', 'encoding-change', 'forbidden-after-direction'].map((name) => vector(name, [`retry-form=${name}`], 'forbidden', 'task-hold-or-forbidden-rule-blocks-retry')),
  },
  {
    caseId: 'C11', storyRefs: ['US2', 'US5'], requirementRefs: ['FR-004', 'FR-005', 'FR-006', 'FR-008'], successCriteriaRefs: ['SC-003'],
    scenarioIntent: 'Missing/duplicate flags, malformed or empty input, EOF, Ctrl+C, terminal closure, and store timeout never mean consent or unpause.',
    requiredLevel: 'restart', localPreparationLevel: 'cli', taskRefs: ['T007', 'T010', 'T018', 'T021'], externalGates: EXTERNAL_RESTART,
    initialControlMode: 'waiting', requestState: 'pending', claimState: 'absent', actionKind: 'approve_fix_plan', classification: 'APPROVAL_REQUIRED', effectClass: 'none',
    targetClasses: ['terminal-input', 'store-timeout'], commandCapability: 'trusted-host-cli', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'operator', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['missing-flags', 'duplicate-flags', 'malformed-input', 'empty-input', 'eof', 'ctrl-c', 'terminal-close', 'store-timeout'], failpoints: ['before-terminal-resolution', 'store-timeout'], expectedOutcome: 'Every terminal-loss vector retains the same waiting control/request and zero consent, dispatch, or effect.', planVersion: 1,
    vectors: ['missing-flags', 'duplicate-flags', 'malformed-input', 'empty-input', 'eof', 'ctrl-c', 'terminal-close', 'store-timeout'].map((name) => vector(name, [`input=${name}`], 'paused', 'no-valid-trusted-response-means-no-consent', { approvalPrompts: 1 }, [name], name === 'store-timeout' ? ['store-timeout'] : [])),
  },
  {
    caseId: 'C12', storyRefs: ['US3'], requirementRefs: ['FR-010', 'FR-011', 'FR-012'], successCriteriaRefs: ['SC-004'],
    scenarioIntent: 'The same response is idempotent; raced, conflicting, or foreign responses cannot overwrite consent or duplicate an effect.',
    requiredLevel: 'real', localPreparationLevel: 'mock', taskRefs: ['T002', 'T011', 'T012', 'T020'], externalGates: EXTERNAL_REAL,
    initialControlMode: 'waiting', requestState: 'pending', claimState: 'absent', actionKind: 'apply_patch', classification: 'APPROVAL_REQUIRED', effectClass: 'mutation',
    targetClasses: ['duplicate-response', 'conflicting-response', 'foreign-response', 'racing-response'], commandCapability: 'one-terminal-resolution-per-request', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'operator', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['approve-key-a', 'repeat-key-a-same-body', 'race-conflicting-key-b', 'submit-foreign-request'], failpoints: [], expectedOutcome: 'One terminal approval and one admitted action; duplicate delivery adds no second effect, conflicts remain visible.', planVersion: 1,
  vectors: [vector('duplicate-race-foreign', ['same-response=idempotent', 'conflicting-response=conflict', 'foreign-request=denied'], 'conflict', 'one-authoritative-resolution-no-duplicate-effect', { approvalPrompts: 1, operatorDecisions: 1, actionDispatches: 1, toolDispatches: 1, mutationEffects: 1, duplicateResponseDeliveries: 1 }, ['approve', 'duplicate-same', 'race-conflict', 'foreign-response'])],
  },
  {
    caseId: 'C13', storyRefs: ['US3'], requirementRefs: ['FR-010', 'FR-011'], successCriteriaRefs: ['SC-004'],
    scenarioIntent: 'Independent changes to every trusted action and fix-plan binding dimension make the prior approval stale and require a fresh request.',
    requiredLevel: 'real', localPreparationLevel: 'mock', taskRefs: ['T011', 'T012', 'T013', 'T020'], externalGates: EXTERNAL_PLAN,
    initialControlMode: 'waiting', requestState: 'approved', claimState: 'absent', actionKind: 'approve_fix_plan', classification: 'APPROVAL_REQUIRED', effectClass: 'mutation',
    targetClasses: ['task', 'workspace', 'repository-mapping', 'repository-digest', 'policy-id', 'policy-version', 'config-id', 'config-version', 'action', 'plan-version', 'strategy', 'baseline', 'evidence-refs', 'criteria', 'check-set'], commandCapability: 'exact-current-binding-required', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'coder', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['prior-approval-recorded', 'independent-binding-drift', 'renewed-request-required'], failpoints: [], expectedOutcome: 'Each changed freshness dimension independently produces stale denial and a new immutable approval request before dispatch.', planVersion: 1,
    vectors: ['taskId', 'workspaceId', 'repositoryId', 'repositoryMappingDigest', 'repositoryRevisionDigest', 'policyId', 'policyVersion', 'configId', 'configVersion', 'actionId', 'normalizedActionDigest', 'planVersion', 'strategyDigest', 'baselineRef', 'evidenceRefs', 'criteriaDigest', 'checkSetDigest'].map((field) => vector(`drift-${field}`, [`freshness=${field}`], 'stale', 'prior-approval-binding-no-longer-current', { approvalPrompts: 1 }, [], [], 'approve_fix_plan')),
  },
  {
    caseId: 'C14', storyRefs: ['US3'], requirementRefs: ['FR-013'], successCriteriaRefs: ['SC-005'],
    scenarioIntent: 'Production edits require an approved diagnosis/baseline/criteria/check-set; a permitted reproduction test may establish a new bound baseline but never auto-approves edits.',
    requiredLevel: 'real', localPreparationLevel: 'mock', taskRefs: ['T011', 'T012', 'T013', 'T020'], externalGates: EXTERNAL_PLAN,
    initialControlMode: 'runnable', requestState: 'absent', claimState: 'absent', actionKind: 'approve_fix_plan', classification: 'APPROVAL_REQUIRED', effectClass: 'mutation',
    targetClasses: ['diagnosis', 'baseline', 'criteria', 'check-set', 'permitted-reproduction-test'], commandCapability: 'reproduction-test-only-before-plan-approval', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'coder', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['reproduction-test-completes', 'new-baseline-recorded', 'fresh-plan-requested', 'no-automatic-approval'], failpoints: [], expectedOutcome: 'A reproduction test may run and update baseline evidence; any production edit still waits for explicit current plan approval.', planVersion: 1,
    vectors: [
      vector('production-patch-without-plan', ['diagnosis=present', 'baseline=present', 'plan-approval=absent'], 'approval-required', 'production-edit-waits-for-fix-plan-approval', { approvalPrompts: 1 }, [], [], 'apply_patch'),
      vector('reproduction-updates-baseline', ['action=reproduction-test', 'baseline=changed', 'plan-approval=not-automatic'], 'approval-required', 'new-baseline-must-be-in-fresh-plan-decision', { actionDispatches: 1, toolDispatches: 1, testEffects: 1, approvalPrompts: 1 }, [], [], 'run_command'),
    ],
  },
  {
    caseId: 'C15', storyRefs: ['US3', 'US4'], requirementRefs: ['FR-014', 'FR-018'], successCriteriaRefs: ['SC-005', 'SC-006'],
    scenarioIntent: 'Three material strategy revisions reserve their slots and need new approvals; a fourth is denied and restart or approval never refunds slots.',
    requiredLevel: 'restart', localPreparationLevel: 'mock', taskRefs: ['T011', 'T012', 'T013', 'T014', 'T015', 'T021'], externalGates: [...EXTERNAL_RESTART, 'X03-PLAN-CONTEXT'],
    initialControlMode: 'runnable', requestState: 'absent', claimState: 'absent', actionKind: 'approve_fix_plan', classification: 'APPROVAL_REQUIRED', effectClass: 'none',
    targetClasses: ['material-replan-1', 'material-replan-2', 'material-replan-3', 'material-replan-4'], commandCapability: 'three-retained-material-replan-slots', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'coder', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['approve-replan-1', 'approve-replan-2', 'approve-replan-3', 'fourth-replan-denied', 'restart-does-not-refund'], failpoints: ['after-third-slot-reservation'], expectedOutcome: 'Three slots remain consumed across restart; the fourth material replan has no approval path and no production effect.', planVersion: 4,
    vectors: [vector('three-slots-fourth-denied', ['replans=3-approved,4-denied', 'restart=retains-count'], 'prerequisite-denied', 'replan-cap-is-three-and-is-not-refunded', { approvalPrompts: 3, operatorDecisions: 3, planSlotsConsumed: 3, planSlotsRefunded: 0 }, ['approve-1', 'approve-2', 'approve-3', 'restart'])],
  },
  {
    caseId: 'C16', storyRefs: ['US3'], requirementRefs: ['FR-013', 'FR-014', 'FR-015'], successCriteriaRefs: ['SC-005'],
    scenarioIntent: 'Covered authentication paths do not trigger path-only prompts; nonmaterial wording does not spend a replan; repository drift needs fresh immutable approval and separate risky-action gates remain.',
    requiredLevel: 'real', localPreparationLevel: 'mock', taskRefs: ['T011', 'T012', 'T013', 'T020'], externalGates: EXTERNAL_PLAN,
    initialControlMode: 'runnable', requestState: 'approved', claimState: 'absent', actionKind: 'apply_patch', classification: 'ALLOWED', effectClass: 'mutation',
    targetClasses: ['covered-auth-path', 'nonmaterial-wording', 'repository-drift', 'dependency-change'], commandCapability: 'plan-covered-patch-plus-separate-risk-gate', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'coder', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['old-plan-approved', 'repo-drift-observed', 'fresh-decision-requested-for-drift'], failpoints: [], expectedOutcome: 'Covered path work has no path-only prompt; actual drift and separate risky action are independently gated without a material replan charge.', planVersion: 1,
    vectors: [
      vector('covered-auth-path', ['path=covered-by-plan'], 'allowed', 'path-alone-does-not-trigger-prompt', { actionDispatches: 1, toolDispatches: 1, mutationEffects: 1 }),
      vector('nonmaterial-wording', ['strategy-materiality=unchanged'], 'allowed', 'wording-does-not-consume-replan-slot'),
      vector('repository-drift', ['repositoryRevisionDigest=changed'], 'stale', 'digest-drift-requires-fresh-immutable-approval', { approvalPrompts: 1 }),
      vector('separate-risky-action', ['action=dependency-change', 'plan-approval-does-not-waive-action-gate'], 'approval-required', 'separate-action-gate-retained', { approvalPrompts: 1 }),
    ],
  },
  {
    caseId: 'C17', storyRefs: ['US2', 'US4'], requirementRefs: ['FR-017', 'FR-019'], successCriteriaRefs: ['SC-006'],
    scenarioIntent: 'Actual restart while pending and after rejection retains the same task/request/pause and keeps unrelated task control isolated.',
    requiredLevel: 'restart', localPreparationLevel: 'mock', taskRefs: ['T014', 'T015', 'T021'], externalGates: EXTERNAL_RESTART,
    initialControlMode: 'waiting', requestState: 'pending', claimState: 'absent', actionKind: 'approve_fix_plan', classification: 'APPROVAL_REQUIRED', effectClass: 'none',
    targetClasses: ['pending-restart', 'rejected-restart', 'unrelated-task'], commandCapability: 'durable-task-control-required', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'aggregate', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['restart-pending', 'reject-request', 'restart-rejected', 'inspect-unrelated-task'], failpoints: ['after-pending-commit', 'after-rejection-commit'], expectedOutcome: 'Both actual restart points retain the exact task/request and wait/rejection state; unrelated task remains independently runnable.', planVersion: 1,
    vectors: [
      vector('restart-while-pending', ['controlMode=waiting', 'requestId=preserved'], 'recovered', 'restart-retains-pending-pause', { approvalPrompts: 1, unrelatedTaskDispatches: 1 }, ['restart-pending'], ['after-pending-commit']),
      vector('restart-after-rejection', ['controlMode=rejected', 'requestId=preserved'], 'recovered', 'restart-retains-rejection-and-history', { approvalPrompts: 1, operatorDecisions: 1, unrelatedTaskDispatches: 1 }, ['reject', 'restart-rejected'], ['after-rejection-commit']),
    ],
  },
  {
    caseId: 'C18', storyRefs: ['US4'], requirementRefs: ['FR-016', 'FR-017', 'FR-018'], successCriteriaRefs: ['SC-006'],
    scenarioIntent: 'Kill at approval/claim/dispatch boundaries reloads control, freshness, and accounting without a duplicate attempt or timer reset.',
    requiredLevel: 'restart', localPreparationLevel: 'mock', taskRefs: ['T014', 'T015', 'T021'], externalGates: EXTERNAL_RESTART,
    initialControlMode: 'waiting', requestState: 'approved', claimState: 'absent', actionKind: 'apply_patch', classification: 'ALLOWED', effectClass: 'mutation',
    targetClasses: ['approval-commit', 'pre-claim', 'post-claim', 'pre-dispatch'], commandCapability: 'one-durable-claim-one-attempt', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'coder', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['approved-commit-durable', 'restore-and-revalidate'], failpoints: ['after-approval-commit', 'before-claim', 'after-claim', 'before-dispatch'], expectedOutcome: 'Unclaimed fresh work can obtain only one claim; a claimed attempt is reconciled before any new dispatch, with no reset or duplicate.', planVersion: 1,
    vectors: [
      vector('approval-committed-before-claim', ['claim=absent-at-stop'], 'recovered', 'freshness-and-control-revalidated-before-single-claim', { approvalPrompts: 1, claimAcquisitions: 1, actionDispatches: 1, toolDispatches: 1, mutationEffects: 1 }, ['restore-after-approval'], ['after-approval-commit', 'before-claim']),
      vector('claim-committed-before-dispatch', ['claim=present-at-stop', 'effect=not-yet-observed'], 'uncertain', 'existing-claim-cannot-be-replayed-blindly', { approvalPrompts: 1 }, ['restore-with-existing-claim'], ['after-claim', 'before-dispatch']),
    ],
  },
  {
    caseId: 'C19', storyRefs: ['US4', 'US5'], requirementRefs: ['FR-018', 'FR-021'], successCriteriaRefs: ['SC-006', 'SC-007'],
    scenarioIntent: 'A kill after an effect but before observation/settlement reconciles once or retains uncertainty and charge; it never gets a fresh attempt budget.',
    requiredLevel: 'restart', localPreparationLevel: 'mock', taskRefs: ['T014', 'T015', 'T021'], externalGates: EXTERNAL_RESTART,
    initialControlMode: 'recovery-blocked', requestState: 'approved', claimState: 'uncertain', actionKind: 'apply_patch', classification: 'ALLOWED', effectClass: 'mutation',
    targetClasses: ['effect-before-observation', 'settlement-pending'], commandCapability: 'reconcile-existing-claim-only', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'aggregate', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['restart-after-effect', 'reconcile-or-retain-uncertain'], failpoints: ['after-effect', 'before-observation', 'before-settlement'], expectedOutcome: 'The prior attempt remains charged; evidence permits one reconciliation, otherwise uncertainty persists and no retry occurs.', planVersion: 1,
    vectors: [
      vector('trusted-reconciliation-evidence', ['effect=preexisting', 'reconciliation=evidence-backed'], 'recovered', 'settle-existing-effect-once', { completedInFlightEffects: 1, reconciliationAttempts: 1 }, ['reconcile-once'], ['after-effect', 'before-observation']),
      vector('insufficient-reconciliation-evidence', ['effect=preexisting', 'reconciliation=unresolved'], 'uncertain', 'retain-uncertainty-and-charge-no-retry', { uncertainInFlightEffects: 1, planSlotsRefunded: 0 }, ['retain-uncertain'], ['after-effect', 'before-settlement']),
    ],
  },
  {
    caseId: 'C20', storyRefs: ['US2', 'US3', 'US4'], requirementRefs: ['FR-006', 'FR-010', 'FR-012', 'FR-017'], successCriteriaRefs: ['SC-002', 'SC-004', 'SC-006'],
    scenarioIntent: 'Pending/decision failures and lost commit responses fail closed; concurrent pending requests and pause-versus-claim have one atomic winner with no runnable gap.',
    requiredLevel: 'restart', localPreparationLevel: 'mock', taskRefs: ['T002', 'T008', 'T009', 'T014', 'T015', 'T020', 'T021'], externalGates: EXTERNAL_RESTART,
    initialControlMode: 'runnable', requestState: 'absent', claimState: 'absent', actionKind: 'apply_patch', classification: 'APPROVAL_REQUIRED', effectClass: 'mutation',
    targetClasses: ['pending-transaction', 'decision-transaction', 'lost-commit-response', 'concurrent-pending', 'pause-versus-claim'], commandCapability: 'atomic-control-store-and-claim', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'aggregate', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['competing-request-a', 'competing-request-b', 'pause-race', 'claim-race'], failpoints: ['pending-transaction-failure', 'decision-transaction-failure', 'commit-response-lost', 'pause-claim-race'], expectedOutcome: 'Failures create no authority; the transaction/claim serialization admits one winner, records uncertainty, and never opens a runnable gap.', planVersion: 1,
    vectors: [
      vector('pending-transaction-fails', ['pending-commit=aborted'], 'prerequisite-denied', 'failed-persistence-grants-no-authority', {}, [], ['pending-transaction-failure']),
      vector('decision-transaction-fails', ['decision-commit=aborted'], 'paused', 'task-remains-waiting-on-failed-decision-persistence', { approvalPrompts: 1 }, [], ['decision-transaction-failure']),
      vector('commit-response-lost', ['decision-commit=durable', 'response=lost'], 'recovered', 'read-back-deduplicates-response-without-second-effect', { approvalPrompts: 1, operatorDecisions: 1 }, ['idempotent-read-back'], ['commit-response-lost']),
      vector('pending-request-race', ['request-winner-count=1'], 'conflict', 'one-pending-slot-winner-per-task', { approvalPrompts: 1, pendingRequestWinners: 1 }, ['concurrent-pending-a', 'concurrent-pending-b']),
      vector('pause-commits-before-claim', ['linearization=pause-first'], 'paused', 'pause-fences-claim', {}, ['pause-wins'], ['pause-claim-race']),
      vector('claim-commits-before-pause', ['linearization=claim-first'], 'uncertain', 'existing-claim-is-in-flight-and-must-be-reconciled', { claimAcquisitions: 1, cancelledInFlightOperations: 1 }, ['claim-wins', 'pause-recorded'], ['pause-claim-race']),
    ],
  },
  {
    caseId: 'C21', storyRefs: ['US1', 'US5'], requirementRefs: ['FR-005', 'FR-020', 'FR-021'], successCriteriaRefs: ['SC-003', 'SC-007'],
    scenarioIntent: 'Every outcome has a safe audit/presentation projection; secret markers and terminal controls never leak or impersonate an operator, and over-bound details cannot be approved.',
    requiredLevel: 'real', localPreparationLevel: 'cli', taskRefs: ['T007', 'T016', 'T017', 'T018', 'T020'], externalGates: EXTERNAL_REAL,
    initialControlMode: 'waiting', requestState: 'pending', claimState: 'absent', actionKind: 'apply_patch', classification: 'APPROVAL_REQUIRED', effectClass: 'mutation',
    targetClasses: ['secret-marker', 'raw-prompt-marker', 'raw-stream-marker', 'ansi-osc-bidi-controls', 'over-bound-detail'], commandCapability: 'bounded-safe-projection', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'operator', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['project-allowed-pending-approved-rejected-stale-uncertain-denied', 'attempt-protected-marker-injection'], failpoints: [], expectedOutcome: 'Safe projections cover every outcome; protected content is excluded/escaped, and uninspectable over-bound details produce no approval prompt.', planVersion: 1,
    vectors: [
      vector('outcome-projections', ['outcomes=allowed,pending,approved,rejected,stale,cancelled,failed,uncertain,denied'], 'safe-presentation', 'metadata-only-safe-outcome-projection', { approvalPrompts: 1 }),
      ...['secret-marker', 'raw-prompt-marker', 'raw-stream-marker', 'ansi-osc-bidi-controls'].map((name) => vector(name, [`unsafe-detail=${name}`], 'safe-presentation', 'protected-content-not-emitted-or-trusted-as-control', { approvalPrompts: 1 })),
      vector('over-bound-details', ['presentation=over-bound'], 'prerequisite-denied', 'cannot-request-approval-with-uninspectable-details'),
    ],
  },
  {
    caseId: 'C22', storyRefs: ['US1', 'US3'], requirementRefs: ['FR-001', 'FR-004', 'FR-010', 'FR-016'], successCriteriaRefs: ['SC-001', 'SC-003', 'SC-004'],
    scenarioIntent: 'Mock/unknown provenance, fake actor fields, changed artifact/presentation/context digests, and unregistered actions cannot enter real composition.',
    requiredLevel: 'real', localPreparationLevel: 'unit', taskRefs: ['T002', 'T004', 'T007', 'T011', 'T012', 'T020'], externalGates: EXTERNAL_REAL,
    initialControlMode: 'runnable', requestState: 'absent', claimState: 'absent', actionKind: 'run_command', classification: 'INVALID', effectClass: 'none',
    targetClasses: ['mock-provenance', 'unknown-provenance', 'fake-actor', 'artifact-digest', 'presentation-digest', 'context-digest', 'unregistered-action'], commandCapability: 'real-composition-rejects-test-dependencies', actorProvenance: 'mock', inputProvenance: 'unregistered', taskRole: 'aggregate', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: [], failpoints: [], expectedOutcome: 'Each forged or test-only composition is rejected before prompt, dispatch, or effect.', planVersion: 1,
    vectors: ['mock-provenance', 'unknown-provenance', 'fake-actor-fields', 'altered-artifact-digest', 'altered-presentation-digest', 'altered-context-digest', 'unregistered-action'].map((name) => vector(name, [`composition=${name}`], 'prerequisite-denied', 'trusted-real-provenance-and-exact-registry-required')),
  },
  {
    caseId: 'C23', storyRefs: ['US1'], requirementRefs: ['FR-003', 'FR-016', 'FR-022'], successCriteriaRefs: ['SC-001', 'SC-008'],
    scenarioIntent: 'Absent real isolation/profile/adapter or unsupported host means no execution; protected source/test boundaries remain enforced even after approval.',
    requiredLevel: 'real', localPreparationLevel: 'mock', taskRefs: ['T019', 'T020'], externalGates: ['G-PROFILE', 'G-REAL', 'X04-APPROVAL-STORE', 'X03-ADMISSION'],
    initialControlMode: 'runnable', requestState: 'approved', claimState: 'absent', actionKind: 'apply_patch', classification: 'INVALID', effectClass: 'none',
    targetClasses: ['isolation-profile-absent', 'profile-absent', 'adapter-absent', 'unsupported-host', 'resource-boundary', 'source-boundary', 'test-boundary', 'protected-data'], commandCapability: 'real-isolation-required', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'coder', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: ['approval-does-not-supply-isolation-or-profile'], failpoints: [], expectedOutcome: 'All unsupported or protected-boundary vectors deny with zero action dispatch/effect, including after an approval.', planVersion: 1,
    vectors: ['isolation-absent', 'profile-absent', 'adapter-absent', 'unsupported-host', 'source-boundary-after-approval', 'test-boundary-after-approval', 'protected-data-after-approval'].map((name) => vector(name, [`runtime-prerequisite=${name}`], 'not-executable', 'approval-cannot-supply-missing-enforcement')),
  },
  {
    caseId: 'C24', storyRefs: ['US5'], requirementRefs: ['FR-020', 'FR-021', 'FR-022'], successCriteriaRefs: ['SC-007', 'SC-008'],
    scenarioIntent: 'Two result runs account for every required case and compare only matching fixture/profile/oracle identities; missing, not-run, error, and approval-only outcomes never count as pass.',
    requiredLevel: 'restart', localPreparationLevel: 'mock', taskRefs: ['T019', 'T020', 'T021', 'T022'], externalGates: EXTERNAL_RESTART,
    initialControlMode: 'runnable', requestState: 'absent', claimState: 'absent', actionKind: 'run_command', classification: 'INVALID', effectClass: 'none',
    targetClasses: ['run-1', 'run-2', 'C01-C24', 'fixture-version', 'profile-identity', 'oracle-identity'], commandCapability: 'comparison-only-no-runtime-dispatch', actorProvenance: 'trusted-host', inputProvenance: 'registered', taskRole: 'aggregate', operatorChannel: 'trusted-host-only',
    scriptedOperatorEvents: [], failpoints: [], expectedOutcome: 'The catalog comparator sees 24 cases per run, zero missing-as-pass outcomes, and marks unavailable real/restart evidence not-run rather than passing.', planVersion: 1,
    vectors: [vector('two-run-complete-catalog', ['runs=2', 'caseIds=C01-C24', 'compare=fixture-profile-oracle-identities', 'approval-only=not-pass', 'not-run-or-error=not-pass'], 'comparable-catalog', 'all-cases-accounted-and-no-missing-as-pass', { catalogCaseObservations: 48, missingAsPass: 0, notRunAsPass: 0, approvalOnlyAsPass: 0 })],
  },
];

export const UC05_CASE_IDS: readonly Uc05CaseId[] = deepFreeze(CASE_SEEDS.map((seed) => seed.caseId));

const builtFixtures = CASE_SEEDS.map(seedToFixture);
if (new Set(builtFixtures.map((fixture) => fixture.caseId)).size !== 24) {
  throw new Error('UC-05 fixture registry must contain C01-C24 exactly once');
}

const registry = Object.fromEntries(builtFixtures.map((fixture) => [fixture.caseId, fixture])) as Record<Uc05CaseId, Uc05CaseFixture>;

/** Immutable, test-only case registry. Each entry includes fixture and oracle identities. */
export const UC05_CASE_FIXTURES: Readonly<Record<Uc05CaseId, Uc05CaseFixture>> = deepFreeze(registry);

/** List the complete registry in canonical C01-C24 order. */
export function listUc05CaseFixtures(): readonly Uc05CaseFixture[] {
  return UC05_CASE_IDS.map((caseId) => UC05_CASE_FIXTURES[caseId]);
}

/** Look up one immutable case fixture; unknown IDs return undefined. */
export function getUc05CaseFixture(caseId: string): Uc05CaseFixture | undefined {
  return Object.hasOwn(UC05_CASE_FIXTURES, caseId)
    ? UC05_CASE_FIXTURES[caseId as Uc05CaseId]
    : undefined;
}

function digestObject(profile: string, value: unknown): string {
  return sha256(`${profile}\n${canonicalJson(value)}`);
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Fixture digest input must use finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return `{${fields.map((field) => `${JSON.stringify(field)}:${canonicalJson(record[field])}`).join(',')}}`;
  }
  throw new TypeError(`Fixture digest input is not JSON-compatible: ${typeof value}`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if ('value' in descriptor) deepFreeze(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}
