import type { QuestionModelResponseV1, QuestionUsageUnknownReasonV1 } from '../../../../src/contracts/questions/contracts.ts';

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
