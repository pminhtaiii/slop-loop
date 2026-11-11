/** Admission-context records, split out of `types.ts` to keep that module bounded. */

import type { VerificationPhase } from './types.ts';

export interface SourceEvidenceLimits {
  readonly maxExcerptBytes?: number | undefined;
  readonly maxResultCount?: number | undefined;
  readonly allowedPaths?: readonly string[] | undefined;
}

export interface BaselineAdmissionContext {
  readonly expectedEvidenceId?: string | undefined;
  readonly expectedRepositorySnapshotDigest: string;
  readonly expectedCheckSetDigest: string;
  readonly expectedTestProtectionDigest: string;
  readonly expectedReproductionCheckId: string;
  readonly expectedPassingCheckIds: readonly string[];
}

export interface VerificationAdmissionContext {
  readonly expectedTaskId: string;
  readonly expectedRunId: string;
  readonly expectedRepoDigest: string;
  readonly expectedDiffDigest?: string | undefined;
  readonly expectedCheckId?: string | undefined;
  readonly requiredPhase?: VerificationPhase | undefined;
}

export type TrustedDiffLines = Readonly<
  Record<
    string,
    {
      readonly oldLines?: readonly number[] | undefined;
      readonly newLines?: readonly number[] | undefined;
    }
  >
>;

export interface ReviewAdmissionContext {
  readonly expectedReviewId?: string | undefined;
  readonly expectedTaskId?: string | undefined;
  readonly expectedRepoDigest: string;
  readonly expectedDiffDigest: string;
  readonly expectedCheckSetDigest: string;
  readonly expectedRoleConfigId: string;
  readonly expectedIterationReservationRef?: string | undefined;
  readonly trustedDiffLines?: TrustedDiffLines | undefined;
}

export interface TaskWorkspaceValidationContext {
  readonly expectedTaskId?: string | undefined;
  readonly expectedWorkspaceId?: string | undefined;
}

export interface DeliveryValidationContext {
  readonly expectedTaskId?: string | undefined;
  readonly expectedRunId?: string | undefined;
  readonly expectedDiffDigest?: string | undefined;
  readonly expectedBaselineRef?: string | undefined;
  readonly expectedReviewRef?: string | undefined;
}
