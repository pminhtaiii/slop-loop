/**
 * UC-03 v0.2.0 Atomic Admission Canonical Cutover and Versioned Selector.
 *
 * Owned path: src/contracts/foundation/uc03/v02/cutover.ts
 * Feature: specs/001-verified-code-repair
 * Amendment: contracts/atomic-admission-amendment.md
 *
 * T064: Neutral fail-closed versioned selector and canonical-cutover RED contract.
 *       Rejects missing context, v0.1 legacy context, raw old claim IDs, open claims,
 *       and missing migration checkpoints with zero effects.
 *
 * T065: Explicit canonical v0.2 cutover activation and legacy rejection.
 *       Canonical mock composition admits explicit v0.2 records only.
 *       Retains separately versioned test-only neutral selector fail-closed.
 */

import type { TaskState } from '../v01/types.ts';
import type { StatePortV02, RepositoryPortV02 } from './ports.ts';
import { isPlainObject } from '../v01/validation/common.ts';
import { validateRepositoryAdmissionV02 } from './admission/repository.ts';

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
  | 'INVALID_ADMISSION_CONTEXT'
  | 'V02_COMPOSITION_REQUIRED'
  | 'RAW_OLD_CLAIM_ID_REJECTED'
  | 'OPEN_CLAIM_BLOCKS_ADMISSION'
  | 'MISSING_MIGRATION_CHECKPOINTS'
  | 'NEUTRAL_CUTOVER_PENDING_T065'
  | 'CANONICAL_V02_ADMITTED';

export interface VersionedAdmissionDecision {
  readonly admitted: boolean;
  readonly selectedVersion?: '0.2.0' | undefined;
  readonly reason: string;
  readonly code: CutoverRejectionCode;
  readonly missingCheckpoints?: readonly MigrationCheckpointId[] | undefined;
  readonly zeroEffects: boolean;
  readonly neutral?: boolean | undefined;
}

export interface VersionedAdmissionSelectionOptions {
  readonly context?: unknown;
  readonly taskState?: TaskState | unknown;
  readonly checkpoints?: Iterable<string> | undefined;
  readonly rawClaimId?: string | undefined;
  readonly statePort?: StatePortV02 | unknown;
  readonly repositoryPort?: RepositoryPortV02 | unknown;
  readonly neutral?: boolean | undefined;
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
    const sp = options.statePort as {
      getJournalSnapshot?: () => {
        activeClaimId?: string | null;
        holdRef?: string | null;
        mode?: string;
        claims?: readonly { status: string }[];
      };
    };
    if (typeof sp.getJournalSnapshot === 'function') {
      const snap = sp.getJournalSnapshot();
      if (snap) {
        if (snap.activeClaimId != null) return true;
        if (snap.holdRef != null) return true;
        if (snap.mode && snap.mode !== 'runnable') return true;
        if (
          Array.isArray(snap.claims) &&
          snap.claims.some(
            (c) =>
              c.status === 'claimed' ||
              c.status === 'attempting' ||
              c.status === 'uncertain' ||
              c.status === 'observed-unsettled'
          )
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function hasVersionedPort(value: unknown, methods: readonly string[]): boolean {
  if (!isPlainObject(value)) return false;
  try {
    const marker = Object.getOwnPropertyDescriptor(value, 'executionGuardApiVersion');
    if (marker === undefined || !('value' in marker) || marker.value !== '0.2.0') return false;
    return methods.every((method) => {
      let current: object | null = value;
      while (current) {
        const descriptor = Object.getOwnPropertyDescriptor(current, method);
        if (descriptor !== undefined) return 'value' in descriptor && typeof descriptor.value === 'function';
        current = Object.getPrototypeOf(current);
      }
      return false;
    });
  } catch {
    return false;
  }
}

export function selectVersionedAdmission(
  options: VersionedAdmissionSelectionOptions
): VersionedAdmissionDecision {
  // 1. Raw old claim ID check
  if (
    options.rawClaimId !== undefined ||
    (isPlainObject(options.context) && 'claimId' in options.context)
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
      (typeof sv === 'string' && sv.startsWith('0.1')) ||
      sv !== CANONICAL_V02_SCHEMA_VERSION
    ) {
      return {
        admitted: false,
        reason: 'Legacy v0.1 context rejected; v0.1 records never authorize v0.2 effects',
        code: 'LEGACY_V01_CONTEXT_REJECTED',
        zeroEffects: true,
      };
    }
  } else {
    return {
      admitted: false,
      reason: 'Admission context must be an object; unadmitted requests produce zero effects',
      code: 'MISSING_ADMISSION_CONTEXT',
      zeroEffects: true,
    };
  }

  const contextValidation = validateRepositoryAdmissionV02(options.context);
  if (!contextValidation.ok) {
    return {
      admitted: false,
      reason: 'Admission context is not a complete, valid v0.2 repository record',
      code: 'INVALID_ADMISSION_CONTEXT',
      zeroEffects: true,
    };
  }

  if (
    !hasVersionedPort(options.statePort, ['loadTask', 'claim', 'beginAttempt', 'recordOutcome']) ||
    !hasVersionedPort(options.repositoryPort, ['applyPatch', 'runCommand', 'runTests'])
  ) {
    return {
      admitted: false,
      reason: 'Canonical selection requires explicit v0.2 state and repository ports; effects still require ExecutionGuardV02',
      code: 'V02_COMPOSITION_REQUIRED',
      zeroEffects: true,
    };
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

  // 6. Neutral selector check (retained for test compatibility)
  if (options.neutral === true) {
    return {
      admitted: false,
      reason: 'Neutral fail-closed versioned selector pending T065 canonical cutover activation',
      code: 'NEUTRAL_CUTOVER_PENDING_T065',
      zeroEffects: true,
      neutral: true,
    };
  }

  // 7. Canonical v0.2 atomic admission cutover admitted
  return {
    admitted: true,
    selectedVersion: '0.2.0',
    reason: 'Canonical v0.2 contract selected; effects still require ExecutionGuardV02 with validated context and ports',
    code: 'CANONICAL_V02_ADMITTED',
    zeroEffects: true,
  };
}

export const selectAtomicAdmissionContract = selectVersionedAdmission;

export class VersionedCutoverSelectorV02 {
  readonly apiVersion = '0.2.0' as const;
  readonly provenance = 'mock' as const;
  readonly neutral: boolean;

  constructor(options?: { readonly neutral?: boolean }) {
    this.neutral = options?.neutral ?? false;
  }

  select(options: VersionedAdmissionSelectionOptions): VersionedAdmissionDecision {
    return selectVersionedAdmission({
      ...options,
      neutral: this.neutral,
    });
  }
}

export function createNeutralCutoverSelectorV02(): VersionedCutoverSelectorV02 {
  return new VersionedCutoverSelectorV02({ neutral: true });
}

export function createCanonicalCutoverSelectorV02(): VersionedCutoverSelectorV02 {
  return new VersionedCutoverSelectorV02({ neutral: false });
}
