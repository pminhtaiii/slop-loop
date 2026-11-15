/**
 * T040 exact-operation lookup for the UC-04 journal (`uc04-journal:` refs only).
 *
 * An uncertain effect carries `uc04-journal:<claimId|operationId>`; continuation resolves it here
 * and nowhere else. `committed` carries the exact persisted task state and receipts and `absent`
 * covers only a claim closed unattempted; everything else — a ref with no journal record, a begun
 * attempt with no outcome, a settlement whose receipt is missing or invalid, a closed claim still
 * carrying an attempt, a corrupt entry, another prefix — is `unknown`. Every receipt is
 * re-validated with the canonical v0.2 validators before it is reported as a commit. Read-only:
 * no lookup writes or re-executes anything.
 */
import { readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { computeCanonicalSha256, validateAttemptOutcomeReceiptV02, validateAttemptReconciliationReceiptV02 } from '../../contracts/foundation/uc03.ts';
import type {
  AttemptOutcomeReceiptV02,
  AttemptOutcomeValidationContextV02,
  AttemptReceiptV02,
  AttemptReconciliationReceiptV02,
  AttemptReconciliationValidationContextV02,
  ClaimReceiptV02,
  TaskState,
} from '../../contracts/foundation/uc03.ts';
import { isSafeStorageId } from '../store.ts';
import type { DurableStatePortV02 } from './state-port-v02.ts';
import { isValidRecoveryEvidence } from './state-port-v02-reconcile.ts';
import { StatePortStore } from './state-port-v02-storage.ts';
import type { StoredAttemptV02, StoredClaimV02 } from './state-port-v02-types.ts';
import { DEFAULT_CONTROL } from './state-port-v02-types.ts';

export const JOURNAL_OPERATION_PREFIX = 'uc04-journal:';

/** The record the material-replan transaction writes atomically with its task transition. */
export interface JournalOperationRecordV02 {
  readonly taskId: string;
  /** Canonical digest of the exact state the operation's own transition produced: the commit proof. */
  readonly stateDigest?: string;
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

/**
 * A persisted outcome is the commit only when the canonical v0.2 validator accepts it against the
 * journal. The status given to the validator is the one the writer validated under: settlement
 * moved the stored claim on afterwards.
 */
function outcomeValid(outcome: AttemptOutcomeReceiptV02, claim: StoredClaimV02, attempt: StoredAttemptV02): boolean {
  const context: AttemptOutcomeValidationContextV02 = {
    trustedAdmission: claim.context,
    trustedClaim: claim.receipt,
    trustedAttempt: attempt.receipt,
    currentClaimStatus: 'attempting',
    currentTaskStateVersion: attempt.receipt.postBeginTaskStateVersion,
    currentControlVersion: attempt.receipt.postBeginControlVersion,
    currentEpoch: claim.receipt.epoch,
  };
  return validateAttemptOutcomeReceiptV02(outcome, context).ok;
}

type ReconciliationFacts = Pick<
  AttemptReconciliationValidationContextV02,
  'trustedEvidenceRefs' | 'trustedObservedEffectRef' | 'trustedAccountingEvidenceRefs' | 'trustedObservedUsage' | 'trustedFencingProof'
>;

/** The evidence and fencing facts the reconciler derived, re-read from the journal; null when they are gone or invalid. */
async function reconciliationFacts(
  state: StatePortStore,
  taskId: string,
  claim: StoredClaimV02,
  outcome: AttemptOutcomeReceiptV02,
  receipt: AttemptReconciliationReceiptV02,
): Promise<ReconciliationFacts | null> {
  if (receipt.reconciliationKind === 'observed-unsettled') return { trustedEvidenceRefs: outcome.evidenceRefs };
  const disposition = (receipt as unknown as { readonly disposition?: unknown }).disposition;
  if (disposition === 'observed-and-accounted') {
    const evidence = await state.readRecovery(taskId, outcome.receiptId);
    if (!evidence || !isValidRecoveryEvidence(evidence, claim)) return null;
    return {
      trustedEvidenceRefs: [evidence.effectEvidenceRef, ...evidence.accountingEvidenceRefs],
      trustedObservedEffectRef: evidence.effectEvidenceRef,
      trustedAccountingEvidenceRefs: evidence.accountingEvidenceRefs,
      ...(evidence.observedUsage ? { trustedObservedUsage: evidence.observedUsage } : {}),
    };
  }
  if (disposition !== 'proven-not-dispatched') return null;
  const fence = await state.readFence(taskId, claim.receipt.claimId);
  if (!fence) return null;
  return {
    trustedEvidenceRefs: fence.adapterEvidenceRefs,
    trustedFencingProof: { fencedRecipientIdentity: fence.recipientIdentity, fencingGeneration: fence.fencingGeneration, proofRef: fence.proofRef },
  };
}

/**
 * A persisted reconciliation is trusted only when the canonical v0.2 validator accepts it as settling
 * this outcome AND the durable journal shows the settlement the writer produces: the claim and attempt
 * rewritten `settled` with the claim naming this exact receipt, then the control head advanced past
 * the receipt's own reconcile-time snapshot. Without the binding a forged receipt could nominate its
 * own current head.
 */
async function reconciliationValid(
  state: StatePortStore,
  taskId: string,
  claim: StoredClaimV02,
  attempt: StoredAttemptV02,
  outcome: AttemptOutcomeReceiptV02,
  receipt: AttemptReconciliationReceiptV02,
  task: TaskState,
): Promise<boolean> {
  if (claim.status !== 'settled' || attempt.status !== 'settled') return false;
  // Only the reconciler writes this, so an absent or mismatched binding is a receipt the writer never settled with.
  if (claim.settlement?.reconciliationId !== receipt.reconciliationId || claim.settlement.receiptDigest !== receipt.reconciliationDigest) return false;
  const control = await state.readControl(taskId, DEFAULT_CONTROL);
  if (
    // The writer always advanced the head, so its equal is impossible and a future head is forged.
    receipt.expectedCurrentControlVersion >= control.controlVersion ||
    receipt.expectedCurrentTaskStateVersion > task.stateVersion ||
    receipt.expectedCurrentEpoch > control.epoch
  )
    return false;
  const facts = await reconciliationFacts(state, taskId, claim, outcome, receipt);
  if (!facts) return false;
  const status = receipt.reconciliationKind === 'uncertain-attempt' ? 'uncertain' : 'observed-unsettled';
  const context: AttemptReconciliationValidationContextV02 = {
    trustedAdmission: claim.context,
    trustedClaim: claim.receipt,
    currentClaimStatus: status,
    predecessorJournalStatus: status,
    trustedAttempt: attempt.receipt,
    trustedPredecessor: outcome,
    predecessorReceiptDigest: outcome.receiptDigest,
    // The reconcile-time head is not journaled; the receipt's own expected snapshot is its record.
    currentTaskStateVersion: receipt.expectedCurrentTaskStateVersion,
    currentControlVersion: receipt.expectedCurrentControlVersion,
    currentEpoch: receipt.expectedCurrentEpoch,
    trustedAccountingIdentityDigest: computeCanonicalSha256({ predecessorReceiptDigest: outcome.receiptDigest, reservationRefs: claim.receipt.reservationRefs }),
    ...facts,
  };
  return validateAttemptReconciliationReceiptV02(receipt, context).ok;
}

/** The reconciliation that settled this claim, if the journal holds a valid one. */
async function readReconciliation(
  state: StatePortStore,
  taskId: string,
  claim: StoredClaimV02,
  attempt: StoredAttemptV02,
  outcome: AttemptOutcomeReceiptV02,
  task: TaskState,
): Promise<AttemptReconciliationReceiptV02 | null> {
  // A settlement binding names the exact receipt the writer wrote: a copy of it under another
  // `recon-*.json` name, or a different receipt at that name, is still a partial settlement write.
  if (claim.settlement !== undefined) {
    const receipt = await state.readReconciliation(taskId, claim.settlement.reconciliationId);
    if (!receipt) throw new Error('Missing UC-03 settlement reconciliation receipt');
    if (!(await reconciliationValid(state, taskId, claim, attempt, outcome, receipt, task))) throw new Error('Corrupted UC-03 reconciliation receipt');
    return receipt;
  }
  const names = await readdir(dirname(state.statePath(taskId, 'x'))).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
    throw err;
  });
  for (const name of names) {
    if (!name.startsWith('recon-') || !name.endsWith('.json')) continue;
    const receipt = await state.readJson<AttemptReconciliationReceiptV02>(state.statePath(taskId, name));
    if (receipt?.claimId !== claim.receipt.claimId) continue;
    // A present receipt for this claim that does not settle it is corruption, not an absence.
    if (!(await reconciliationValid(state, taskId, claim, attempt, outcome, receipt, task))) throw new Error('Corrupted UC-03 reconciliation receipt');
    return receipt;
  }
  return null;
}

/** Classifies a claim ref: a recorded outcome (settled, uncertain or observed-unsettled) is the commit. */
async function lookupClaim(state: StatePortStore, claimId: string): Promise<JournalOperationLookupResultV02 | null> {
  const located = await state.findClaimTask(claimId);
  if (!located) return null;
  const { taskId, claim } = located;
  // Valid closure refuses an attempted claim, so a closed claim carrying one is corrupt.
  if (claim.status === 'closed') return claim.attemptId === undefined ? ABSENT : UNKNOWN;
  if (claim.attemptId === undefined) return UNKNOWN;
  const attempt = await state.readAttempt(taskId, claim.attemptId);
  if (!attempt || attempt.outcomeReceiptId === undefined) return UNKNOWN;
  const outcome = await state.readOutcome(taskId, attempt.outcomeReceiptId);
  const task = await state.readTask(taskId);
  if (!outcome || !task || !outcomeValid(outcome, claim, attempt)) return UNKNOWN;
  return {
    outcome: 'committed',
    state: structuredClone(task),
    commit: {
      kind: 'claim',
      claim: structuredClone(claim.receipt),
      attempt: structuredClone(attempt.receipt),
      outcome: structuredClone(outcome),
      reconciliation: await readReconciliation(state, taskId, claim, attempt, outcome, task),
    },
  };
}

/** Resolves a committed operation record; a record whose exact state is not persisted is not a commit. */
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
    // The written task and the record are separate files, so the version alone cannot prove whose
    // transition landed: only the exact resulting state is this operation's commit.
    if (!task || task.stateVersion !== record.stateVersion || typeof record.stateDigest !== 'string' || computeCanonicalSha256(task) !== record.stateDigest) return UNKNOWN;
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
        return (await lookupClaim(state, operationId)) ?? (await lookupRecord(state, operationId)) ?? UNKNOWN;
      } catch {
        // Translation only: a corrupt or unreadable journal entry is an unknown outcome, never a write.
        return UNKNOWN;
      }
    },
  };
}
