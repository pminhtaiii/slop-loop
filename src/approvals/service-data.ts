import type { ApprovalBinding, ApprovalBindingContext, ApprovalPort, NormalizedAction } from '../contracts/foundation/uc03.ts';
import type { ApprovalRequestRecord, ApprovalTaskControl, BindingAssessment, DecisionEvent, DeveloperDirection, DispatchClaim, HumanResolution, PolicyProfile, SafeResult, TrustedOperatorIdentity } from '../contracts/approvals/contracts.ts';
import type { PolicyFacts, CompiledPolicy } from './policy.ts';
import type { PresentationBundle, PresentationInput } from './presentation.ts';
import type { ApprovalActivity, ApprovalControl } from './control.ts';
import type { ApprovalHistoryPage } from './history.ts';

export interface ApprovalContext {
  readonly action: NormalizedAction;
  readonly facts: PolicyFacts;
  readonly freshness: ApprovalBindingContext;
  readonly runId: string;
  readonly elements: PresentationInput['elements'];
}
export interface StoreResponse<T> { readonly safe: SafeResult; readonly value: T | null }
export interface ApprovalStore {
  readonly provenance: 'mock';
  loadTaskControl(taskId: string): StoreResponse<ApprovalTaskControl>;
  readRequest(decisionId: string): StoreResponse<ApprovalRequestRecord>;
  readHistory(taskId: string): StoreResponse<{ readonly resolutions: readonly HumanResolution[]; readonly directions?: readonly DeveloperDirection[]; readonly assessments?: readonly BindingAssessment[]; readonly claims?: readonly DispatchClaim[] }>;
  readEvents?(taskId: string): StoreResponse<readonly DecisionEvent[]>;
  recordDirection?(input: unknown): StoreResponse<DeveloperDirection>;
  createPendingAndPause(input: unknown): StoreResponse<ApprovalRequestRecord>;
  replaceStalePending?(input: unknown): StoreResponse<ApprovalRequestRecord>;
  resolvePending(input: unknown): StoreResponse<HumanResolution>;
}
export interface ApprovalServiceOptions {
  readonly observations?: { readonly provenance: 'mock'; read(taskId: string): Promise<unknown> };
  readonly activity?: ApprovalActivity;
  readonly taskId: string;
  readonly profile: unknown;
  readonly store?: ApprovalStore;
  readonly context: {
    loadForAction(taskId: string, actionId: string): Promise<unknown>;
    loadForDecision(decisionId: string): Promise<unknown>;
    loadForTask?(taskId: string): Promise<unknown>;
  };
  readonly operator?: { readonly identity: TrustedOperatorIdentity };
  readonly now?: () => string;
}
export interface ApprovalView {
  readonly control: ApprovalTaskControl;
  readonly binding: ApprovalBinding;
  readonly presentation: PresentationBundle['summary'];
}
export interface ApprovalService extends ApprovalPort {
  history(taskId: string, page: number): Promise<ApprovalHistoryPage>;
  admitAttempt(attemptId: string, claim: unknown): boolean;
  control(input: unknown): Promise<SafeResult>;
  list(taskId: string): Promise<{ readonly control: ApprovalTaskControl; readonly decisionId: string | null }>;
  show(taskId: string, decisionId: string): Promise<ApprovalView>;
  inspect(taskId: string, decisionId: string, page: number): Promise<{ readonly presentationDigest: string; readonly page: number; readonly pageCount: number; readonly content: string }>;
  decide(input: unknown): Promise<SafeResult>;
}
export class ApprovalServiceError extends Error {
  readonly outcome: SafeResult['outcome'];
  readonly reasonCode: string;
  constructor(outcome: SafeResult['outcome'], reasonCode = 'approval-operation-denied') { super('approval-operation-denied'); this.outcome = outcome; this.reasonCode = reasonCode; }
}

/** Shared host-owned capabilities; helpers cannot independently reopen admission. */
export interface ServiceRuntime {
  readonly options: ApprovalServiceOptions;
  readonly profile: PolicyProfile;
  readonly policy: CompiledPolicy;
  readonly admission: { closed: boolean };
  readonly coordinator: ApprovalControl;
  readonly staleContextDigests: WeakMap<ApprovalServiceError, string>;
  readonly now: () => string;
  store(): ApprovalStore;
  control(): ApprovalTaskControl;
  task(taskId: string): void;
  trusted(decisionId: string, binding: ApprovalBinding): Promise<ApprovalContext>;
  checkedView(decisionId: string): Promise<{ record: ApprovalRequestRecord; context: ApprovalContext; bundle: PresentationBundle }>;
  presentation(binding: ApprovalBinding, context: ApprovalContext, requestVersion?: number): PresentationBundle;
  request(decisionId: string): ApprovalRequestRecord;
  resolution(record: ApprovalRequestRecord): HumanResolution | undefined;
  projection(record: ApprovalRequestRecord): ApprovalBinding;
  callPort<T>(operation: () => T): T;
  loadPort<T>(operation: () => Promise<T>): Promise<T>;
  bounded<T>(operation: (assertActive: () => void) => Promise<T> | T): Promise<T>;
}
