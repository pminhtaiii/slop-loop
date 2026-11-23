import type { QuestionModelResponseV1, QuestionUsageUnknownReasonV1 } from '../../../../src/contracts/questions/contracts.ts';
import type { QuestionCompiledRequestV1, QuestionModelTransportControlV1, QuestionModelTransportV1, QuestionRequestTokenCounterV1 } from '../../../../src/questions/model.ts';

export interface ScriptedQuestionModelFailure {
  readonly kind: 'failure';
  readonly reasonCode: QuestionUsageUnknownReasonV1;
}

export type ScriptedQuestionModelStep = QuestionModelResponseV1 | ScriptedQuestionModelFailure;

/** A controlled transport failure; its reason code is safe metadata, not provider output. */
export class ScriptedQuestionModelError extends Error {
  readonly reasonCode: QuestionUsageUnknownReasonV1;

  constructor(reasonCode: QuestionUsageUnknownReasonV1) {
    super(`Scripted question model failed: ${reasonCode}`);
    this.name = 'ScriptedQuestionModelError';
    this.reasonCode = reasonCode;
  }
}

/** Deterministic test port. It never records context, retains no prompt/source payload, and never retries. */
export class ScriptedQuestionModelPort {
  readonly #steps: readonly ScriptedQuestionModelStep[];
  #nextStep = 0;

  constructor(steps: readonly ScriptedQuestionModelStep[]) {
    this.#steps = structuredClone(steps);
  }

  get consumedSteps(): number {
    return this.#nextStep;
  }

  get remainingSteps(): number {
    return this.#steps.length - this.#nextStep;
  }

  async decide(_context: unknown, _admission: unknown, signal: AbortSignal): Promise<QuestionModelResponseV1> {
    if (signal.aborted) throw new Error('Scripted question model call cancelled');

    const step = this.#steps[this.#nextStep];
    if (step === undefined) throw new Error('Scripted question model sequence exhausted');
    this.#nextStep += 1;

    if ('kind' in step) throw new ScriptedQuestionModelError(step.reasonCode);
    return structuredClone(step);
  }
}

/** Host-side regression expectations, never a runtime prompt or target-repository file. No real-model quality claim. */
export const QUESTION_BEHAVIOR_CONTROLS = Object.freeze([
  Object.freeze({
    id: 'clear-call',
    question: 'What does start call?',
    expectedOutcome: 'answered',
    rationale: 'The inspected entry explicitly calls retry_delivery; the referent is complete and needs no clarification.',
  }),
  Object.freeze({
    id: 'ambiguous-recovery',
    question: 'How does recovery work?',
    expectedOutcome: 'awaiting-clarification',
    rationale: 'Delivery retry and snapshot restoration are both present; selecting one would invent the intended referent.',
  }),
  Object.freeze({
    id: 'unsupported-premise',
    question: 'How does start encrypt its output?',
    expectedOutcome: 'insufficient-evidence',
    rationale: 'The entry shows delegation, not encryption; the premise is unsupported by inspected source.',
  }),
  Object.freeze({
    id: 'author-intent',
    question: 'Why did the author choose delivery retry?',
    expectedOutcome: 'insufficient-evidence',
    rationale: 'Source behavior is observable but no author rationale is supplied; intent must remain unknown.',
  }),
] as const);

/** Fixture-only byte counter. It is not a provider tokenizer or a certified live token bound. */
export const controlledQuestionRequestCounter: QuestionRequestTokenCounterV1 = Object.freeze({ kind: 'controlled', countRequest: (serialized: string) => Buffer.byteLength(serialized) });

export type ScriptedQuestionTransportStep = (request: QuestionCompiledRequestV1, control: QuestionModelTransportControlV1) => unknown;

/** Controlled generation with capped synthetic usage; retains step counts only, never requests or source payloads. */
export class ScriptedQuestionTransport implements QuestionModelTransportV1 {
  readonly kind = 'controlled' as const;
  readonly enforcesOutputTokenCap = true as const;
  readonly #steps: readonly ScriptedQuestionTransportStep[];
  #nextStep = 0;
  #sendAttempts = 0;

  constructor(steps: readonly ScriptedQuestionTransportStep[]) {
    this.#steps = Object.freeze([...steps]);
  }

  get consumedSteps(): number {
    return this.#nextStep;
  }

  get sendAttempts(): number {
    return this.#sendAttempts;
  }

  get remainingSteps(): number {
    return this.#steps.length - this.#nextStep;
  }

  async send(request: QuestionCompiledRequestV1, control: QuestionModelTransportControlV1): Promise<unknown> {
    this.#sendAttempts++;
    if (control.signal.aborted) throw new ScriptedQuestionModelError('cancelled');
    const step = this.#steps[this.#nextStep];
    if (!step) throw new ScriptedQuestionModelError('invalid-metadata');
    this.#nextStep++;
    return { decision: step(request, control), usage: { status: 'complete', inputTokens: request.inputTokens, outputTokens: Math.min(10, request.maxOutputTokens) } };
  }
}
