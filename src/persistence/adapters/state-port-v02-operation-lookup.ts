/**
 * T040 exact-operation lookup for the UC-04 journal (`uc04-journal:` refs only).
 *
 * An uncertain effect carries `uc04-journal:<claimId|operationId>`; continuation resolves it here
 * and nowhere else. `committed` carries the exact persisted task state and receipts, `absent`
 * covers a claim closed unattempted or a ref with no journal record, and everything else —
 * a begun attempt with no outcome, a corrupt entry, another prefix — is `unknown`. Read-only:
 * no lookup writes or re-executes anything.
 */
import { readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { computeAdmissionDigest, computeAttemptOutcomeDigest, computeReconciliationDigest } from '../../contracts/foundation/uc03.ts';
import type { AttemptOutcomeReceiptV02, AttemptReceiptV02, AttemptReconciliationReceiptV02, ClaimReceiptV02, TaskState } from '../../contracts/foundation/uc03.ts';
import { isSafeStorageId } from '../store.ts';
import type { DurableStatePortV02 } from './state-port-v02.ts';
import { StatePortStore } from './state-port-v02-storage.ts';
import type { StoredAttemptV02, StoredClaimV02 } from './state-port-v02-types.ts';

export const JOURNAL_OPERATION_PREFIX = 'uc04-journal:';

/** The record the material-replan transaction writes atomically with its task transition. */
export interface JournalOperationRecordV02 {
  readonly taskId: string;
  readonly stateVersion: number;
  readonly receipts: readonly string[];
}

export type JournalOperationCommitV02 =
  | {
      readonly kind: 'claim';
      readonly claim: ClaimReceiptV02;
      readonly attempt: AttemptReceiptV02;
      readonly outcome: AttemptOutcomeReceiptV02 | null;
      readonly reconciliation: AttemptReconciliationReceiptV02 | null;
    }
  | { readonly kind: 'operation'; readonly receipts: readonly string[] };

export type JournalOperationLookupResultV02 =
  { readonly outcome: 'committed'; readonly state: TaskState; readonly commit: JournalOperationCommitV02 } | { readonly outcome: 'absent' } | { readonly outcome: 'unknown' };

export interface JournalOperationLookupV02 {
  lookupOperation(operationRef: string): Promise<JournalOperationLookupResultV02>;
}

/** The operation reference an owner issues for one journal operation. */
export function journalOperationRef(operationId: string): string {
  return `${JOURNAL_OPERATION_PREFIX}${operationId}`;
}

/** The path the owning operation records its commit at; exported so the writer and lookup agree. */
export function journalOperationPath(state: StatePortStore, taskId: string, operationId: string): string {
  return state.statePath(taskId, `operation-${operationId}.json`);
}

const ABSENT: JournalOperationLookupResultV02 = Object.freeze({ outcome: 'absent' });
const UNKNOWN: JournalOperationLookupResultV02 = Object.freeze({ outcome: 'unknown' });

/** A persisted outcome is the commit only when it is self-consistent and bound to this claim and attempt. */
function outcomeMatchesClaim(outcome: AttemptOutcomeReceiptV02, claim: StoredClaimV02, attempt: StoredAttemptV02): boolean {
  return (
    outcome.receiptDigest === computeAttemptOutcomeDigest(outcome) &&
    outcome.claimId === claim.receipt.claimId &&
    outcome.claimDigest === claim.receipt.claimDigest &&
    outcome.attemptId === attempt.receipt.attemptId &&
    outcome.admissionDigest === computeAdmissionDigest(claim.context)
  );
}

/** A persisted reconciliation is trusted only when it settles exactly this claim's outcome. */
function reconciliationMatches(reconciliation: AttemptReconciliationReceiptV02, claim: StoredClaimV02, attempt: StoredAttemptV02, outcome: AttemptOutcomeReceiptV02): boolean {
  return (
    reconciliation.reconciliationDigest === computeReconciliationDigest(reconciliation) &&
    reconciliation.claimId === claim.receipt.claimId &&
    reconciliation.claimDigest === claim.receipt.claimDigest &&
    reconciliation.attemptId === attempt.receipt.attemptId &&
    reconciliation.predecessorReceiptId === outcome.receiptId &&
    reconciliation.predecessorReceiptDigest === outcome.receiptDigest &&
    reconciliation.admissionDigest === computeAdmissionDigest(claim.context)
  );
}

/** The reconciliation that settled this claim, if the journal holds a valid one. */
async function readReconciliation(
  state: StatePortStore,
  taskId: string,
  claim: StoredClaimV02,
  attempt: StoredAttemptV02,
  outcome: AttemptOutcomeReceiptV02,
): Promise<AttemptReconciliationReceiptV02 | null> {
  const names = await readdir(dirname(state.statePath(taskId, 'x'))).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
    throw err;
  });
  for (const name of names) {
    if (!name.startsWith('recon-') || !name.endsWith('.json')) continue;
    const receipt = await state.readJson<AttemptReconciliationReceiptV02>(state.statePath(taskId, name));
    if (receipt?.claimId !== claim.receipt.claimId) continue;
    // A present receipt for this claim that does not settle it is corruption, not an absence.
    if (!reconciliationMatches(receipt, claim, attempt, outcome)) throw new Error('Corrupted UC-03 reconciliation receipt');
    return receipt;
  }
  return null;
}

/** Classifies a claim ref: a recorded outcome (settled, uncertain or observed-unsettled) is the commit. */
async function lookupClaim(state: StatePortStore, claimId: string): Promise<JournalOperationLookupResultV02 | null> {
  const located = await state.findClaimTask(claimId);
  if (!located) return null;
  const { taskId, claim } = located;
  // A claim closed before dispatch released its reservations, so nothing was committed.
  if (claim.status === 'closed') return ABSENT;
  if (claim.attemptId === undefined) return UNKNOWN;
  const attempt = await state.readAttempt(taskId, claim.attemptId);
  if (!attempt || attempt.outcomeReceiptId === undefined) return UNKNOWN;
  const outcome = await state.readOutcome(taskId, attempt.outcomeReceiptId);
  const task = await state.readTask(taskId);
  if (!outcome || !task || !outcomeMatchesClaim(outcome, claim, attempt)) return UNKNOWN;
  return {
    outcome: 'committed',
    state: structuredClone(task),
    commit: {
      kind: 'claim',
      claim: structuredClone(claim.receipt),
      attempt: structuredClone(attempt.receipt),
      outcome: structuredClone(outcome),
      reconciliation: await readReconciliation(state, taskId, claim, attempt, outcome),
    },
  };
}

/** Resolves a committed operation record; a record whose task or version drifted is not a commit. */
async function lookupRecord(state: StatePortStore, operationId: string): Promise<JournalOperationLookupResultV02 | null> {
  const taskIds = await readdir(state.store.claimDir).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
    throw err;
  });
  for (const taskId of taskIds) {
    if (!isSafeStorageId(taskId)) continue;
    const record = await state.readJson<JournalOperationRecordV02>(journalOperationPath(state, taskId, operationId));
    if (!record) continue;
    if (record.taskId !== taskId || !Array.isArray(record.receipts) || !record.receipts.every(item => typeof item === 'string')) return UNKNOWN;
    const task = await state.readTask(taskId);
    if (!task || task.stateVersion !== record.stateVersion) return UNKNOWN;
    return { outcome: 'committed', state: structuredClone(task), commit: { kind: 'operation', receipts: [...record.receipts] } };
  }
  return null;
}

/**
 * Builds the read-only `uc04-journal:` lookup over one durable state port. Corruption or an
 * unreadable entry fails closed as `unknown` rather than guessing a commit or an absence.
 */
export function createJournalOperationLookup(port: DurableStatePortV02): JournalOperationLookupV02 {
  const state = new StatePortStore(port.store);
  return {
    async lookupOperation(operationRef: string): Promise<JournalOperationLookupResultV02> {
      if (typeof operationRef !== 'string' || !operationRef.startsWith(JOURNAL_OPERATION_PREFIX)) return UNKNOWN;
      const operationId = operationRef.slice(JOURNAL_OPERATION_PREFIX.length);
      if (!isSafeStorageId(operationId)) return UNKNOWN;
      try {
        return (await lookupClaim(state, operationId)) ?? (await lookupRecord(state, operationId)) ?? ABSENT;
      } catch {
        // Translation only: a corrupt or unreadable journal entry is an unknown outcome, never a write.
        return UNKNOWN;
      }
    },
  };
}
