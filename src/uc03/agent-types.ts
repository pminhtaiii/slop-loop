import type {
  BugTask,
  CheckResult,
  ModelPort,
  PortProvenance,
  ProviderAdmissionContextV02,
  ProviderAdmissionTrustedContextV02,
  ProviderRequest,
  RepositoryPort,
  SourceEvidence,
  TaskState,
} from '../contracts/foundation/uc03.ts';

/** Owner-issued coder admission for exactly one turn. Owned here; `graph-types.ts` re-exports it. */
export interface UC03CoderAdmission {
  readonly request: ProviderRequest;
  readonly context: ProviderAdmissionContextV02;
  readonly trustedContext: ProviderAdmissionTrustedContextV02;
}

export type CoderKind = 'inspect' | 'propose-plan' | 'propose-patch' | 'request-info' | 'stop';

export interface CoderQuestion {
  readonly questionId: string;
  readonly text: string;
}

export type InspectRequest =
  | { readonly operation: 'list_dir'; readonly args: { readonly path: string } }
  | { readonly operation: 'read_file'; readonly args: { readonly path: string } }
  | { readonly operation: 'search_code'; readonly args: { readonly query: string } }
  | { readonly operation: 'run_check'; readonly args: { readonly checkId: string } };

export type CoderProposal =
  | ({ readonly kind: 'inspect'; readonly proposalId: string } & InspectRequest)
  | {
      readonly kind: 'propose-plan';
      readonly proposalId: string;
      readonly diagnosis: string;
      readonly strategy: string;
      readonly suspectedLocations: readonly string[];
      readonly scopedPaths: readonly string[];
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly kind: 'propose-patch';
      readonly proposalId: string;
      readonly diff: string;
      readonly targetPaths: readonly string[];
      readonly approvedPlanRef: string;
    }
  | { readonly kind: 'request-info'; readonly proposalId: string; readonly questions: readonly CoderQuestion[]; readonly evidenceRefs: readonly string[] }
  | { readonly kind: 'stop'; readonly proposalId: string; readonly reasonCode: string; readonly summary: string; readonly evidenceRefs: readonly string[] };

export type CoderToolResult =
  | { readonly kind: 'list-dir'; readonly path: string; readonly entries: readonly string[] }
  | { readonly kind: 'read-file'; readonly evidence: SourceEvidence }
  | { readonly kind: 'search-code'; readonly evidence: readonly SourceEvidence[] }
  | { readonly kind: 'run-check'; readonly checkId: string; readonly result: CheckResult };

export interface CoderCounters {
  readonly modelCalls: number;
  readonly modelOutputFailures: number;
  readonly repairs: number;
  readonly replans: number;
  readonly activeMs: number;
}

export interface CoderBudget {
  readonly maxModelCalls: number;
  readonly maxActiveMs: number;
  readonly maxRepairs: number;
  readonly maxReplans: number;
}

export interface CoderAgentOptions {
  /** v0.1 ModelPort.propose seam; T008 supplies provider admission. */
  readonly propose: ModelPort['propose'];
  readonly repository: RepositoryPort;
  readonly budget: CoderBudget;
  readonly now?: (() => number) | undefined;
}

export type CoderTurnResult =
  | { readonly outcome: 'proposal'; readonly proposal: CoderProposal; readonly tool?: CoderToolResult | undefined; readonly counters: CoderCounters }
  | { readonly outcome: 'waiting'; readonly reason: string; readonly counters: CoderCounters }
  | { readonly outcome: 'invalid'; readonly reason: string; readonly counters: CoderCounters };

export interface CoderAgent {
  readonly counters: CoderCounters;
  turn(task: BugTask, state: TaskState, evidence: readonly SourceEvidence[], request: ProviderRequest): Promise<CoderTurnResult>;
}

/**
 * Production coder turn — T020.
 *
 * Differences from `CoderAgent` above are the whole point of the version bump: the caller passes the
 * exact owner-issued admission for this task/run/state/purpose/evidence, so the agent never claims
 * and the graph cannot preclaim. `ModelPortV02.propose` receives that admission's `request` and
 * `context`; the model boundary alone reserves, begins the attempt and records the outcome.
 * A stale or substituted admission refuses with zero network calls.
 */
export interface CoderAgentV02 {
  readonly counters: CoderCounters;
  readonly provenance: PortProvenance;
  turn(input: CoderTurnInputV02): Promise<CoderTurnResultV02>;
}

export interface CoderTurnInputV02 {
  readonly task: BugTask;
  readonly state: TaskState;
  readonly purpose: 'propose-plan' | 'propose-patch' | 'propose-repair' | 'propose-replan';
  /** Observations accumulated so far this generation loop; each turn re-admits against these. */
  readonly evidence: readonly SourceEvidence[];
  readonly admission: UC03CoderAdmission;
}

export type CoderTurnResultV02 =
  | { readonly outcome: 'proposal'; readonly proposal: CoderProposal; readonly tool?: CoderToolResult | undefined; readonly counters: CoderCounters }
  | { readonly outcome: 'waiting'; readonly reason: string; readonly counters: CoderCounters }
  | { readonly outcome: 'invalid'; readonly reason: string; readonly counters: CoderCounters }
  | { readonly outcome: 'unavailable'; readonly reason: string; readonly counters: CoderCounters };
