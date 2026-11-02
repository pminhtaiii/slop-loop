export type EvaluationLimits = Readonly<{
  totalModelCalls: number;
  inputTokensPerRequest: number;
  outputTokensPerRequest: number;
  providerTimeoutMs: number;
  activeExecutionMs: number;
  repairs: number;
  reviewerIterations: number;
  materialReplans: number;
  commandTimeoutMs: number;
  outputBytes: number;
  memoryBytes: number;
  cpus: number;
  processes: number;
}>;

/** Integer numerators over a shared denominator; cache and overhead are required, never defaulted. */
export type EvaluationPricing = Readonly<{
  pricingId: string;
  inputRate: number;
  outputRate: number;
  cacheRate: number;
  overheadRate: number;
  denominator: number;
}>;

/** Host-side catalog entry. Paths stay host-only; only digests reach the profile and public bindings. */
export type CatalogEntry = Readonly<{
  catalogEntryId: string;
  caseId: string;
  version: string;
  caseDigest: string;
  publicTaskDigest: string;
  initialRepositoryDigest: string;
  fixturePath: string;
  fixtureDigest: string;
  grader: Readonly<{ version: string; digest: string; path: string }>;
}>;

export type EvaluationProfile = Readonly<{
  profileId: 'uc03-runtime-evaluation-v1';
  profileDigest: string;
  endpoint: Readonly<{ origin: string; path: string }>;
  model: string;
  mode: 'nonstreaming';
  /** Opaque host secret name, never a secret value; excluded from identity digests and serialized reports. */
  credentialRef: string;
  codeDigest: string;
  configDigest: string;
  pricing: EvaluationPricing;
  pricingDigest: string;
  imageDigest: string;
  platform: string;
  adapterVersions: readonly string[];
  catalogDigest: string;
  caseDigests: readonly string[];
  graderDigests: readonly string[];
  limits: EvaluationLimits;
  spendPolicy: 'derived-exposure';
}>;

export type ExposureDerivation = Readonly<{
  spendPolicy: 'derived-exposure';
  pricingId: string;
  calls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCacheTokens: number;
  numeratorPerCall: number;
  perCallMicroUsd: number;
  ceilingMicroUsd: number;
}>;

export type CaseBinding = Readonly<{
  caseId: string;
  version: string;
  caseDigest: string;
  publicTaskDigest: string;
  initialRepositoryDigest: string;
  catalogEntryId: string;
  grader: Readonly<{ version: string; digest: string }>;
}>;

export type BugInput = Readonly<{
  goal: string;
  observedBehavior: string;
  expectedBehavior: string;
  reproduction: string;
  acceptanceCriteria: readonly string[];
  constraints?: readonly string[];
}>;

export type IntakeQuestion = Readonly<{ questionId: string; text: string }>;

export type BoundSource =
  | Readonly<{ kind: 'catalog'; status: 'bound'; bindings: readonly CaseBinding[] }>
  | Readonly<{
      kind: 'bug';
      version: 1;
      status: 'complete' | 'needs-info';
      submissionId: string;
      submissionDigest: string;
      repositoryId: string;
      checkSetId: string;
      bugInput: BugInput;
      questions: readonly IntakeQuestion[];
      /** Intake never allocates a task, run or workspace; a needs-info submission is non-executable. */
      taskId: null;
    }>;

/** Trusted host configuration; repository and check-set ids must resolve here before any effect. */
export type SourceHost = Readonly<{
  profile: EvaluationProfile;
  catalog: readonly CatalogEntry[];
  repositoryIds: readonly string[];
  checkSetIds: readonly string[];
}>;
