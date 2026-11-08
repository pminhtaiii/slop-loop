/** Host-composition §8 bound clarification record, split out of `types.ts` to keep that module bounded. */

/** The round bound, held here so the validator and the producer cannot drift apart. */
export const CLARIFICATION_ROUND_CAP = 3;

/** A bounded coder question persisted so the record can be verified from `TaskState` alone. */
export interface ClarificationQuestion {
  readonly questionId: string;
  readonly text: string;
}

/** The reporter's answers; reporter data, never approval, direction or resume authority (§8). */
export interface ClarificationAnswer {
  readonly answerDigest: string;
  readonly answeredAtStateVersion: number;
  readonly recorderRef: string;
  readonly items: readonly ClarificationQuestion[];
}

export interface ClarificationRecord {
  readonly questionId: string;
  readonly questionDigest: string;
  readonly askedAtStateVersion: number;
  readonly round: number;
  readonly questions: readonly ClarificationQuestion[];
  readonly evidenceRefs: readonly string[];
  readonly answer?: ClarificationAnswer | undefined;
}
