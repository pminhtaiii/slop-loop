/** Q&A-only model composition: bounded request compilation, reservation, transport and trusted settlement. */
import { validateQuestionBudgetProfile, validateQuestionDecision, validateQuestionIdentity, validateQuestionUsage } from '../contracts/questions/validation.ts';
import type { QuestionUsageV1 } from '../contracts/questions/contracts.ts';
import { compileQuestionModelRequest } from './model-compiler.ts';
import type { CreateQuestionModelPortOptionsV1, QuestionModelConfigurationV1, QuestionModelFailureReasonV1, QuestionModelOutcomeV1, QuestionModelPortCreationV1 } from './model-types.ts';

export type {
  CreateQuestionModelPortOptionsV1,
  QuestionCompiledRequestV1,
  QuestionModelContextV1,
  QuestionModelOutcomeV1,
  QuestionModelPort,
  QuestionModelPortCreationV1,
  QuestionModelTransportControlV1,
  QuestionModelTransportV1,
  QuestionRequestTokenCounterV1,
} from './model-types.ts';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value);
}

function stopped(reasonCode: QuestionModelFailureReasonV1, usage: QuestionUsageV1 = { status: 'missing' }): QuestionModelOutcomeV1 {
  return Object.freeze({ status: 'stopped', reasonCode, usage: Object.freeze(usage) });
}

/** Creates no provider or accounting owner. Host capabilities/config are validated before any dispatch. */
export function createQuestionModelPort(options: CreateQuestionModelPortOptionsV1): QuestionModelPortCreationV1 {
  const identity = validateQuestionIdentity(options?.identity);
  const profile = validateQuestionBudgetProfile(options?.profile);
  const counter = options?.counter;
  const transport = options?.transport;
  if (
    !identity.ok ||
    !profile.ok ||
    !safeId(options?.providerId) ||
    !safeId(options?.modelId) ||
    !counter ||
    !['controlled', 'exact-provider', 'certified-upper-bound'].includes(counter.kind) ||
    typeof counter.countRequest !== 'function' ||
    !transport ||
    !['controlled', 'host'].includes(transport.kind) ||
    transport.enforcesOutputTokenCap !== true ||
    typeof transport.send !== 'function' ||
    !options.budget ||
    typeof options.budget.reserveModelCall !== 'function' ||
    typeof options.budget.snapshot !== 'function' ||
    typeof options.budget.cancel !== 'function' ||
    (counter.kind !== 'controlled' && (counter.providerId !== options.providerId || counter.modelId !== options.modelId)) ||
    (counter.kind === 'certified-upper-bound' && !safeId(counter.certificationId)) ||
    (transport.kind === 'host' && counter.kind === 'controlled')
  ) {
    return Object.freeze({ ok: false, reasonCode: 'invalid-config' });
  }
  const config: QuestionModelConfigurationV1 = Object.freeze({
    ...options,
    identity: identity.value,
    profile: profile.value,
    counter: Object.freeze({ ...counter, countRequest: counter.countRequest.bind(counter) }),
    transport: Object.freeze({ ...transport, send: transport.send.bind(transport) }),
  });

  async function decide(context: unknown, signal: AbortSignal): Promise<QuestionModelOutcomeV1> {
    if (!signal || typeof signal.addEventListener !== 'function') return stopped('invalid-context');
    if (signal.aborted) {
      config.budget.cancel();
      return stopped('cancelled');
    }
    const state = config.budget.snapshot();
    if (state.status !== 'open') {
      if (state.status === 'cancelled') return stopped('cancelled');
      if (state.status === 'blocked') return stopped('accounting-unknown');
      const denied = config.budget.reserveModelCall(0);
      return stopped(denied.ok ? 'accounting-unknown' : denied.reasonCode);
    }
    let compiled;
    try {
      compiled = compileQuestionModelRequest(context, config, signal);
    } catch {
      return stopped('owner-unavailable');
    }
    if (!compiled.ok) {
      if (compiled.reasonCode === 'cancelled') config.budget.cancel();
      return stopped(compiled.reasonCode);
    }
    if (signal.aborted) {
      config.budget.cancel();
      return stopped('cancelled');
    }
    const admission = config.budget.reserveModelCall(compiled.request.inputTokens);
    if (!admission.ok) return stopped(admission.reasonCode);
    if (admission.value.maximumBillableTokens - compiled.request.inputTokens !== compiled.request.maxOutputTokens) {
      admission.value.releaseBeforeDispatch();
      return stopped('owner-unavailable');
    }
    const cancel = () => config.budget.cancel();
    let observedUsage: QuestionUsageV1 = { status: 'missing' };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) {
        config.budget.cancel();
        return stopped('cancelled');
      }
      const execution = await admission.value.execute(
        control =>
          config.transport.send(
            compiled.request,
            Object.freeze({
              ...control,
              admission: Object.freeze({
                reservationId: admission.value.id,
                identity: config.identity,
                maximumBillableTokens: admission.value.maximumBillableTokens,
                maximumCostMicros: admission.value.maximumCostMicros,
              }),
            }),
          ),
        response => {
          const usage = validateQuestionUsage(record(response) ? response['usage'] : undefined);
          observedUsage = usage.ok ? usage.value : { status: 'unknown', reasonCode: 'invalid-metadata' };
          return { kind: 'model-usage', usage: observedUsage };
        },
      );
      if (!execution.ok)
        return stopped(
          execution.reasonCode,
          execution.reasonCode === 'accounting-unknown'
            ? observedUsage
            : {
                status: 'unknown',
                reasonCode:
                  execution.reasonCode === 'over-reservation'
                    ? 'over-reservation'
                    : execution.reasonCode === 'cancelled'
                      ? 'cancelled'
                      : execution.reasonCode === 'elapsed-deadline'
                        ? 'timeout'
                        : 'invalid-metadata',
              },
        );
      if (signal.aborted) {
        config.budget.cancel();
        return stopped('cancelled');
      }
      const response = execution.value;
      if (!record(response) || Object.keys(response).sort().join(',') !== 'decision,usage') return stopped('invalid-decision', observedUsage);
      const usage = validateQuestionUsage(response['usage']);
      // The ledger admits only complete usage, but retain validation at the public response boundary.
      if (!usage.ok || usage.value.status !== 'complete') return stopped('accounting-unknown', { status: 'unknown', reasonCode: 'invalid-metadata' });
      const decision = validateQuestionDecision(response['decision']);
      if (!decision.ok) return stopped('invalid-decision', usage.value);
      return Object.freeze({ status: 'ok', decision: decision.value, usage: usage.value, visibleEvidenceIds: compiled.request.visibleEvidenceIds });
    } catch {
      // The reservation has already held uncertain usage. Provider exception text never leaves this boundary.
      return stopped('accounting-unknown', { status: 'unknown', reasonCode: 'provider-error' });
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  return Object.freeze({ ok: true, value: Object.freeze({ decide }) });
}
