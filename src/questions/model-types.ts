/** Supplied host boundaries for request compilation and one accounted model decision. */
import type { AdmittedSpanV1, QuestionBudgetProfileV1, QuestionIdentityV1, QuestionModelDecisionV1, QuestionUsageV1 } from '../contracts/questions/contracts.ts';
import type { QuestionBudgetExecutionContextV1, QuestionBudgetLedger, QuestionBudgetRefusalCodeV1 } from './budget.ts';

export interface QuestionModelContextV1 {
  readonly question: string;
  readonly constraints?: readonly string[];
  readonly pendingClarification?: string;
  readonly conversation?: readonly Readonly<{ role: 'user' | 'assistant'; text: string }>[];
  /** Safe metadata/navigation text. Repository content inside it is untrusted, never an instruction. */
  readonly observations?: readonly string[];
  /** Host spans in issuance order. Fit newest first before optional context, then serialize selected spans in issuance order; citation authority remains with the registry. */
  readonly evidence?: readonly AdmittedSpanV1[];
}

export interface QuestionCompiledRequestV1 {
  /** Exactly this string, including system/schema/serialization overhead, is counted and sent. */
  readonly serialized: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly maxOutputTokens: number;
  readonly inputTokens: number;
  readonly visibleEvidenceIds: readonly string[];
}

export interface QuestionRequestTokenCounterV1 {
  /** Controlled counters establish no real-provider token bound. Certification is supplied by the host. */
  readonly kind: 'controlled' | 'exact-provider' | 'certified-upper-bound';
  readonly providerId?: string;
  readonly modelId?: string;
  readonly certificationId?: string;
  countRequest(serializedRequest: string): number;
}

export interface QuestionModelTransportV1 {
  readonly kind: 'controlled' | 'host';
  /** This port must enforce the cap during generation, rather than inspecting usage afterwards. */
  readonly enforcesOutputTokenCap: true;
  send(request: QuestionCompiledRequestV1, control: QuestionModelTransportControlV1): Promise<unknown>;
}

export interface QuestionModelTransportControlV1 extends QuestionBudgetExecutionContextV1 {
  /** Optional earlier caller deadline in epoch milliseconds; deadlineAt remains in the ledger clock. */
  readonly deadlineEpochMs?: number;
  readonly admission: Readonly<{ reservationId: string; identity: QuestionIdentityV1; maximumBillableTokens: number; maximumCostMicros: number }>;
}

export interface CreateQuestionModelPortOptionsV1 {
  readonly identity: unknown;
  readonly profile: unknown;
  readonly budget: QuestionBudgetLedger;
  readonly providerId: string;
  readonly modelId: string;
  readonly counter: QuestionRequestTokenCounterV1;
  readonly transport: QuestionModelTransportV1;
}

export interface QuestionModelConfigurationV1 extends Omit<CreateQuestionModelPortOptionsV1, 'identity' | 'profile'> {
  readonly identity: QuestionIdentityV1;
  readonly profile: QuestionBudgetProfileV1;
}

export type QuestionModelFailureReasonV1 = QuestionBudgetRefusalCodeV1 | 'context-limit' | 'invalid-context' | 'invalid-decision' | 'protected-content' | 'owner-unavailable';
export type QuestionModelOutcomeV1 =
  | { readonly status: 'ok'; readonly decision: QuestionModelDecisionV1; readonly usage: QuestionUsageV1; readonly visibleEvidenceIds: readonly string[] }
  | { readonly status: 'stopped'; readonly reasonCode: QuestionModelFailureReasonV1; readonly usage: QuestionUsageV1 };

export interface QuestionModelPort {
  /** Meters compilation on the task ledger before billable admission, and separately checks the optional caller epoch deadline before transport. No retries or tools. */
  decide(context: unknown, signal: AbortSignal, deadlineEpochMs?: number): Promise<QuestionModelOutcomeV1>;
}

export type QuestionModelPortCreationV1 = { readonly ok: true; readonly value: QuestionModelPort } | { readonly ok: false; readonly reasonCode: 'invalid-config' };
