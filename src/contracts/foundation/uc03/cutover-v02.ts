/**
 * UC-03 v0.2.0 Atomic Admission Canonical Cutover and Versioned Selector.
 *
 * Owned path: src/contracts/foundation/uc03/cutover-v02.ts
 * Feature: specs/001-verified-code-repair
 * Amendment: contracts/atomic-admission-amendment.md
 *
 * T064: Neutral fail-closed versioned selector and canonical-cutover RED contract.
 *       Rejects missing context, v0.1 legacy context, raw old claim IDs, open claims,
 *       and missing migration checkpoints with zero effects. Positive fully migrated
 *       v0.2 mock compositions reach the neutral selector and fail behaviorally
 *       pending T065 cutover activation.
 *
 * T065 (Deferred): Explicit canonical v0.2 cutover activation and legacy rejection.
 */

import type { TaskState } from './types.ts';
import type { StatePortV02, RepositoryPortV02 } from './ports-v02.ts';
import { isPlainObject } from './validation/common.ts';

export const CANONICAL_V02_SCHEMA_VERSION = '0.2.0' as const;

export const REQUIRED_MIGRATION_CHECKPOINTS = [
  'T038',
  'T040',
  'T042',
  'T044',
  'T046',
  'T048',
  'T050',
  'T052',
  'T054',
  'T056',
  'T058',
  'T061',
  'T063',
] as const;

export type MigrationCheckpointId = (typeof REQUIRED_MIGRATION_CHECKPOINTS)[number];

export function areMigrationCheckpointsSatisfied(checkpoints?: Iterable<string>): boolean {
  if (!checkpoints) return false;
  const set = checkpoints instanceof Set ? checkpoints : new Set(checkpoints);
  return REQUIRED_MIGRATION_CHECKPOINTS.every((cp) => set.has(cp));
}

export function getMissingMigrationCheckpoints(checkpoints?: Iterable<string>): readonly MigrationCheckpointId[] {
  const set = checkpoints ? (checkpoints instanceof Set ? checkpoints : new Set(checkpoints)) : new Set<string>();
  return REQUIRED_MIGRATION_CHECKPOINTS.filter((cp) => !set.has(cp));
}

export type CutoverRejectionCode =
  | 'MISSING_ADMISSION_CONTEXT'
  | 'LEGACY_V01_CONTEXT_REJECTED'
  | 'RAW_OLD_CLAIM_ID_REJECTED'
  | 'OPEN_CLAIM_BLOCKS_ADMISSION'
  | 'MISSING_MIGRATION_CHECKPOINTS'
  | 'NEUTRAL_CUTOVER_PENDING_T065';

export interface VersionedAdmissionDecision {
  readonly admitted: boolean;
  readonly selectedVersion?: '0.2.0' | undefined;
  readonly reason: string;
  readonly code: CutoverRejectionCode;
  readonly missingCheckpoints?: readonly MigrationCheckpointId[] | undefined;
  readonly zeroEffects: true;
  readonly neutral?: boolean | undefined;
}

export interface VersionedAdmissionSelectionOptions {
  readonly context?: unknown;
  readonly taskState?: TaskState | unknown;
  readonly checkpoints?: Iterable<string> | undefined;
  readonly rawClaimId?: string | undefined;
  readonly statePort?: StatePortV02 | unknown;
  readonly repositoryPort?: RepositoryPortV02 | unknown;
}

function hasOpenClaim(options: VersionedAdmissionSelectionOptions): boolean {
  if (options.taskState && typeof options.taskState === 'object') {
    const s = options.taskState as Record<string, unknown>;
    if (s.activeClaim || s.activeClaimId) return true;
    if (Array.isArray(s.outstandingClaimRefs) && s.outstandingClaimRefs.length > 0) return true;
    if (Array.isArray(s.openClaims) && s.openClaims.length > 0) return true;
    const status = s.status;
    if (
      status === 'claimed' ||
      status === 'attempting' ||
      status === 'uncertain' ||
      status === 'observed-unsettled'
    ) {
      return true;
    }
  }
  if (options.statePort && typeof options.statePort === 'object') {
    const sp = options.statePort as { getJournalSnapshot?: () => { activeClaimId?: string | null } };
    if (typeof sp.getJournalSnapshot === 'function') {
      const snap = sp.getJournalSnapshot();
      if (snap && snap.activeClaimId != null) return true;
    }
  }
  return false;
}

export function selectVersionedAdmission(
  options: VersionedAdmissionSelectionOptions
): VersionedAdmissionDecision {
  // 1. Raw old claim ID check
  if (
    options.rawClaimId !== undefined ||
    (isPlainObject(options.context) &&
      'claimId' in options.context &&
      !('schemaVersion' in options.context && options.context.schemaVersion === CANONICAL_V02_SCHEMA_VERSION))
  ) {
    return {
      admitted: false,
      reason: 'Raw old claim ID without verified v0.2 admission authority cannot launch effects',
      code: 'RAW_OLD_CLAIM_ID_REJECTED',
      zeroEffects: true,
    };
  }

  // 2. Missing context check
  if (
    options.context === undefined ||
    options.context === null ||
    (isPlainObject(options.context) && Object.keys(options.context).length === 0)
  ) {
    return {
      admitted: false,
      reason: 'Admission context is missing or empty; unadmitted requests produce zero effects',
      code: 'MISSING_ADMISSION_CONTEXT',
      zeroEffects: true,
    };
  }

  // 3. Legacy v0.1 context check
  if (isPlainObject(options.context)) {
    const sv = options.context['schemaVersion'];
    if (
      sv === '0.1.0' ||
      sv === 'uc05-approval/0.1-draft' ||
      sv === '0.1' ||
      (typeof sv === 'string' && sv.startsWith('0.1'))
    ) {
      return {
        admitted: false,
        reason: 'Legacy v0.1 context rejected; v0.1 records never authorize v0.2 effects',
        code: 'LEGACY_V01_CONTEXT_REJECTED',
        zeroEffects: true,
      };
    }
  }

  // 4. Open claim check
  if (hasOpenClaim(options)) {
    return {
      admitted: false,
      reason: 'Unresolved open claim exists on task; fresh admission blocked until reconciled',
      code: 'OPEN_CLAIM_BLOCKS_ADMISSION',
      zeroEffects: true,
    };
  }

  // 5. Checkpoints check
  const missing = getMissingMigrationCheckpoints(options.checkpoints);
  if (missing.length > 0) {
    return {
      admitted: false,
      reason: `Missing required migration checkpoints: ${missing.join(', ')}`,
      code: 'MISSING_MIGRATION_CHECKPOINTS',
      missingCheckpoints: missing,
      zeroEffects: true,
    };
  }

  // 6. Positive composition reaches neutral fail-closed selector (T064 RED)
  return {
    admitted: false,
    reason: 'Neutral fail-closed versioned selector pending T065 canonical cutover activation',
    code: 'NEUTRAL_CUTOVER_PENDING_T065',
    zeroEffects: true,
    neutral: true,
  };
}

export const selectAtomicAdmissionContract = selectVersionedAdmission;

export class VersionedCutoverSelectorV02 {
  readonly apiVersion = '0.2.0' as const;
  readonly neutral = true as const;

  select(options: VersionedAdmissionSelectionOptions): VersionedAdmissionDecision {
    return selectVersionedAdmission(options);
  }

  async executeIfAdmitted<T>(
    options: VersionedAdmissionSelectionOptions,
    action: () => Promise<T>
  ): Promise<{ readonly admitted: boolean; readonly result?: T | undefined; readonly decision: VersionedAdmissionDecision }> {
    const decision = this.select(options);
    if (!decision.admitted) {
      return { admitted: false, decision };
    }
    const result = await action();
    return { admitted: true, result, decision };
  }
}

export function createNeutralCutoverSelectorV02(): VersionedCutoverSelectorV02 {
  return new VersionedCutoverSelectorV02();
}
