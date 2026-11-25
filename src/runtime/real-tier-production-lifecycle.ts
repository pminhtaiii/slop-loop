/**
 * Per-driver lifecycle, binding checks, and working-copy ownership for `real-tier-production.ts`
 * (Feature 007 T011, PR #261 R2 repairs).
 *
 * Enforces a per-case active guard to reject overlapping `executeCase` calls and refuse abandonment
 * while active, binds paused entries to their owning attempt token, and tracks failed removals as
 * non-resumable `cleanup-only` roots so retries succeed without replaying terminal tasks.
 */
import { rmSync } from 'node:fs';

import type { EvaluationCaseSpec, WorkflowDriver } from '../../eval/uc03/types.ts';
import type { HostProductionContext, UC03HostReady } from '../cli/evaluate-host.ts';
import { sha256Text } from '../uc01/contracts.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../uc03/graph-types-v02.ts';
import type { RealTierAssembly } from './real-tier-assembly.ts';
import type { GraderResolution } from './real-tier-case-grade.ts';
import type { AttemptIdentity } from './real-tier-case-run.ts';
import { REAL_TIER_DELIVERY_CONTRACT } from './real-tier-owners.ts';
import type { UC03HostInputs } from './uc03-host-bootstrap.ts';

export type CopyRemover = (root: string) => void;

export interface PausedCaseContext {
  readonly caseAssembly: RealTierAssembly;
  readonly stateRoot: string;
  readonly workingCopyRoot: string;
  readonly graderRes: Extract<GraderResolution, { readonly status: 'ready' }>;
  readonly graderDigest: string;
  readonly expectedOutcome: EvaluationCaseSpec['expectedOutcome'];
  readonly identity: AttemptIdentity;
  readonly repositoryRoot: string;
}

export interface ExpectedBindings {
  readonly profileDigest: string;
  readonly configDigest: string;
  readonly pricingDigest: string;
  readonly model: string;
}

export interface OwnedPausedEntry<T extends { readonly workingCopyRoot: string }> {
  readonly ownerToken: symbol;
  readonly data: T;
}

export interface AttemptHandle<T extends { readonly workingCopyRoot: string }> {
  readonly token: symbol;
  readonly paused: OwnedPausedEntry<T> | undefined;
}

export interface RealTierCaseLifecycle<T extends { readonly workingCopyRoot: string }> {
  /** Acquires the per-case active guard or returns `null` when that case is already executing. */
  beginAttempt(caseId: string): AttemptHandle<T> | null;
  /** Releases the per-case active guard when `token` matches the active attempt. */
  endAttempt(caseId: string, token: symbol): void;
  /** True when `caseId` still holds a resumable paused entry owned by `ownerToken`. */
  ownsPaused(caseId: string, ownerToken: symbol): boolean;
  /** Retains a paused entry bound to `ownerToken` for continuation or explicit abandonment. */
  retainPaused(caseId: string, ownerToken: symbol, data: T): void;
  /**
   * Cleans up a non-retained attempt copy. Removes the paused entry only if `expectedPausedOwner`
   * matches its owner token, and keeps failed removals in `cleanup-only` state for later retry.
   */
  releaseAttemptCopy(caseId: string, workingCopyRoot: string, expectedPausedOwner?: symbol): boolean;
  /** Releases an owned paused entry without creating a new copy (e.g. missing disk directory). */
  releaseOwnedPaused(caseId: string, expectedPausedOwner: symbol): boolean;
  /**
   * Abandons one case (`caseId` given) or all non-active cases (`caseId` omitted).
   * Refuses active cases, isolates partial failures across roots, and preserves failed removals as
   * `cleanup-only` for later retry.
   */
  abandon(caseId?: string): boolean;
}

function bareHex(digest: string): string {
  return digest.startsWith('sha256:') ? digest.slice(7) : digest;
}

function sameDigest(actual: string | undefined, expectedHex: string): boolean {
  return actual === expectedHex || actual === `sha256:${expectedHex}`;
}

export function expectedBindingsOf(assembly: RealTierAssembly): ExpectedBindings {
  return {
    profileDigest: bareHex(assembly.metadata.profileDigest),
    configDigest: sha256Text(JSON.stringify({ limits: assembly.profile.limits, runLimits: assembly.profile.runLimits })),
    pricingDigest: sha256Text(JSON.stringify(assembly.profile.pricing)),
    model: assembly.metadata.model,
  };
}

export function matchesDigests(source: { readonly profileDigest?: unknown; readonly configDigest?: unknown; readonly pricingDigest?: unknown }, expected: ExpectedBindings): boolean {
  return (
    typeof source.profileDigest === 'string' &&
    sameDigest(source.profileDigest, expected.profileDigest) &&
    typeof source.configDigest === 'string' &&
    sameDigest(source.configDigest, expected.configDigest) &&
    typeof source.pricingDigest === 'string' &&
    sameDigest(source.pricingDigest, expected.pricingDigest)
  );
}

export function canIssueAdmission(assembly: RealTierAssembly, ready: UC03HostReady, context: HostProductionContext | undefined, expected: ExpectedBindings): context is HostProductionContext {
  if (context === undefined || context.mode !== 'real' || context.caseIds.length === 0 || ready.status !== 'ready') return false;
  if (!matchesDigests(ready.identity, expected) || !matchesDigests(context.binding, expected) || context.binding.requestedModel !== expected.model) {
    return false;
  }
  if (context.pins.contractVersion !== REAL_TIER_DELIVERY_CONTRACT) return false;
  return UC03_PRODUCTION_COMPONENTS_V02.every(c => context.pins.revisions[c] === assembly.revision);
}

export function matchesAdmittedAssembly(candidate: RealTierAssembly, initialRevision: string, expected: ExpectedBindings, pins: UC03HostInputs['pins'], paused?: PausedCaseContext): boolean {
  const b = expectedBindingsOf(candidate);
  if (!matchesDigests(b, expected) || b.model !== expected.model || candidate.revision !== initialRevision || UC03_PRODUCTION_COMPONENTS_V02.some(c => pins.revisions[c] !== candidate.revision)) {
    return false;
  }
  if (paused === undefined) return true;
  const p = paused.caseAssembly;
  return candidate.metadata.imageId === p.metadata.imageId && candidate.metadata.endpointDigest === p.metadata.endpointDigest && candidate.profile.catalog.path === p.profile.catalog.path;
}

const defaultRemoveCopy: CopyRemover = (root: string): void => {
  rmSync(root, { recursive: true, force: true });
};

const driverDisposers = new WeakMap<WorkflowDriver, (caseId?: string) => boolean>();

/** Registers the disposal handler scoped to one production `WorkflowDriver`. */
export function registerDriverDisposer(driver: WorkflowDriver, disposer: (caseId?: string) => boolean): void {
  driverDisposers.set(driver, disposer);
}

/** Releases retained paused or failed-cleanup working copies scoped to a production workflow driver. */
export function abandonDriverCases(driver: WorkflowDriver, caseId?: string): boolean {
  return driverDisposers.get(driver)?.(caseId) ?? false;
}

/** Creates a per-driver lifecycle coordinator for paused and `cleanup-only` working copies. */
export function createRealTierCaseLifecycle<T extends { readonly workingCopyRoot: string }>(removeCopy: CopyRemover = defaultRemoveCopy): RealTierCaseLifecycle<T> {
  const activeCases = new Map<string, symbol>();
  const pausedCases = new Map<string, OwnedPausedEntry<T>>();
  const cleanupOnlyRoots = new Map<string, Set<string>>();

  const addCleanupRoot = (caseId: string, root: string): void => {
    let roots = cleanupOnlyRoots.get(caseId);
    if (roots === undefined) {
      roots = new Set<string>();
      cleanupOnlyRoots.set(caseId, roots);
    }
    roots.add(root);
  };

  const deleteCleanupRoot = (caseId: string, root: string): void => {
    const roots = cleanupOnlyRoots.get(caseId);
    if (roots === undefined) return;
    roots.delete(root);
    if (roots.size === 0) cleanupOnlyRoots.delete(caseId);
  };

  const tryRemoveTrackedRoot = (caseId: string, root: string): boolean => {
    addCleanupRoot(caseId, root);
    try {
      removeCopy(root);
      deleteCleanupRoot(caseId, root);
      return true;
    } catch {
      return false;
    }
  };

  const movePausedToCleanup = (caseId: string, expectedOwner?: symbol): string | undefined => {
    const entry = pausedCases.get(caseId);
    if (entry === undefined) return undefined;
    if (expectedOwner !== undefined && entry.ownerToken !== expectedOwner) return undefined;
    pausedCases.delete(caseId);
    addCleanupRoot(caseId, entry.data.workingCopyRoot);
    return entry.data.workingCopyRoot;
  };

  const disposeNonActiveCase = (caseId: string): { readonly attempted: number; readonly removed: number; readonly failed: number } => {
    movePausedToCleanup(caseId);
    const pending = [...(cleanupOnlyRoots.get(caseId) ?? [])];
    let removed = 0;
    let failed = 0;
    for (const root of pending) {
      if (tryRemoveTrackedRoot(caseId, root)) removed += 1;
      else failed += 1;
    }
    return { attempted: pending.length, removed, failed };
  };

  return {
    beginAttempt(caseId: string): AttemptHandle<T> | null {
      if (activeCases.has(caseId)) return null;
      const token = Symbol(caseId);
      activeCases.set(caseId, token);
      return { token, paused: pausedCases.get(caseId) };
    },

    endAttempt(caseId: string, token: symbol): void {
      if (activeCases.get(caseId) === token) activeCases.delete(caseId);
    },

    ownsPaused(caseId: string, ownerToken: symbol): boolean {
      return pausedCases.get(caseId)?.ownerToken === ownerToken;
    },

    retainPaused(caseId: string, ownerToken: symbol, data: T): void {
      pausedCases.set(caseId, { ownerToken, data });
    },

    releaseAttemptCopy(caseId: string, workingCopyRoot: string, expectedPausedOwner?: symbol): boolean {
      if (expectedPausedOwner !== undefined) movePausedToCleanup(caseId, expectedPausedOwner);
      return tryRemoveTrackedRoot(caseId, workingCopyRoot);
    },

    releaseOwnedPaused(caseId: string, expectedPausedOwner: symbol): boolean {
      const root = movePausedToCleanup(caseId, expectedPausedOwner);
      if (root === undefined) return false;
      return tryRemoveTrackedRoot(caseId, root);
    },

    abandon(targetCaseId?: string): boolean {
      if (targetCaseId !== undefined) {
        if (activeCases.has(targetCaseId)) return false;
        const result = disposeNonActiveCase(targetCaseId);
        return result.attempted > 0 && result.failed === 0;
      }

      const candidateCaseIds = new Set<string>();
      for (const id of pausedCases.keys()) {
        if (!activeCases.has(id)) candidateCaseIds.add(id);
      }
      for (const id of cleanupOnlyRoots.keys()) {
        if (!activeCases.has(id)) candidateCaseIds.add(id);
      }
      if (candidateCaseIds.size === 0) return false;

      let totalRemoved = 0;
      let totalFailed = 0;
      for (const id of candidateCaseIds) {
        const result = disposeNonActiveCase(id);
        totalRemoved += result.removed;
        totalFailed += result.failed;
      }
      return totalRemoved > 0 && totalFailed === 0;
    },
  };
}
