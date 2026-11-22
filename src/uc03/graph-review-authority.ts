/**
 * Delivery authority binding helper for UC-03 graph review.
 * Resolves the owner-sourced authority and delivery candidate binding metadata.
 */
import { computeCanonicalSha256 } from '../contracts/foundation/uc03.ts';
import type { TaskState } from '../contracts/foundation/uc03.ts';
import type { ReviewObservationV1 } from '../contracts/review.ts';

export interface ReviewDeliveryBinding {
  readonly expectedReviewHead: number;
  readonly candidateDigest: string;
  readonly controlVersion?: number | undefined;
  readonly decisionAuthorityGeneration?: number | undefined;
}

interface ControlHeadReader {
  readControlHead?(taskId: string): { readonly controlVersion?: number; readonly activeAuthorityRef?: { readonly decisionAuthorityGeneration?: number } | null } | null;
}

export function resolveReviewDeliveryBinding(
  statePort: unknown,
  taskId: string,
  observation: ReviewObservationV1 | 'fresh' | undefined,
  deliverCandidate: TaskState,
  expectedReviewHead: number,
): ReviewDeliveryBinding {
  const candidateDigest = computeCanonicalSha256(deliverCandidate);
  const reader = statePort as ControlHeadReader | undefined;
  const ownerControl = reader?.readControlHead ? reader.readControlHead(taskId) : undefined;
  const controlVersion = observation && observation !== 'fresh' ? observation.authority.controlVersion : ownerControl?.controlVersion;
  const decisionAuthorityGeneration = observation && observation !== 'fresh' ? observation.authority.decisionAuthorityGeneration : ownerControl?.activeAuthorityRef?.decisionAuthorityGeneration;

  return {
    expectedReviewHead,
    candidateDigest,
    ...(controlVersion !== undefined ? { controlVersion } : {}),
    ...(decisionAuthorityGeneration !== undefined ? { decisionAuthorityGeneration } : {}),
  };
}
