import { sha256Text, validateIntake, type Evidence, type Intake, type Validation } from './contracts.ts';
import { isProtectedPayload } from '../foundation/telemetry.ts';

export type BoundIntake = Intake;
export type ModelEvidence = Readonly<{ evidence: Evidence; boundedExcerpt: string }>;
export interface ExcerptAdmission {
  /** Trusted reference resolver; admission is separate from model or caller authority. */
  resolveExcerpt(evidence: Evidence): unknown;
}
export class IntakeBinder {
  private readonly admission: ExcerptAdmission | undefined;
  constructor(admission?: ExcerptAdmission) { this.admission = admission; }
  bind(invocation: unknown, context: unknown): Validation<BoundIntake> {
    const result = validateIntake(invocation, context);
    if (!result.ok) return result;
    if (isProtectedPayload(result.value)) return { ok: false, status: 'invalid-input', reasonCode: 'protected-content', path: '$' };
    return result;
  }

  admit(evidence: Evidence, inputBytes: number): Validation<ModelEvidence> {
    const excerpt: unknown = this.admission?.resolveExcerpt(evidence);
    if (typeof excerpt !== 'string' || Buffer.byteLength(excerpt) > inputBytes || sha256Text(excerpt) !== evidence.contentDigest
      || isProtectedPayload(excerpt)) return { ok: false, status: 'invalid-input', reasonCode: 'evidence-not-admitted', path: '$.evidence' };
    return { ok: true, value: { evidence, boundedExcerpt: excerpt } };
  }
}
