/**
 * Completion of a persisted uncertain outcome whose attempt/claim writes were interrupted.
 *
 * `recordOutcome` writes the outcome file first, then the attempt, then the claim as `uncertain`. A
 * fault between those writes leaves the outcome present and the claim still `attempting`; a replay
 * then found the outcome and answered `already-recorded`, orphaning the claim's held reservations,
 * because no recovery path accepts an attempting claim with no outcome link.
 */
import type { AttemptOutcomeReceiptV02, OutcomeRecordResultV02 } from '../../contracts/foundation/uc03.ts';
import type { StatePortStore } from './state-port-v02-storage.ts';
import type { StoredAttemptV02 } from './state-port-v02-types.ts';
import { DEFAULT_CONTROL, NEUTRAL_OUTCOME_RECORD_RESULT_V02 } from './state-port-v02-types.ts';

/**
 * Completes the missing attempt/claim/control writes for a matching persisted uncertain outcome,
 * restoring the exact late-fence state `reconcileUncertain` already settles. Only missing writes run:
 * a fully written record answers `already-recorded` and is never double-bumped. A record that is not
 * this claim's, or is already settled, refuses rather than rewriting accounting.
 */
export async function completeUncertainRecord(store: StatePortStore, taskId: string, snapshot: AttemptOutcomeReceiptV02): Promise<OutcomeRecordResultV02> {
  const done: OutcomeRecordResultV02 = { outcome: 'already-recorded', receiptId: snapshot.receiptId };
  // Only a fenced/uncertain outcome uses this path; a settled record is complete by construction.
  if (snapshot.outcome !== 'uncertain') return done;
  const claim = await store.readClaim(taskId, snapshot.claimId);
  const attempt = await store.readAttempt(taskId, snapshot.attemptId);
  if (
    !claim ||
    !attempt ||
    attempt.claimId !== snapshot.claimId ||
    claim.attemptId !== attempt.receipt.attemptId ||
    (attempt.outcomeReceiptId !== undefined && attempt.outcomeReceiptId !== snapshot.receiptId) ||
    (claim.status !== 'attempting' && claim.status !== 'uncertain')
  )
    return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
  const attemptPath = store.statePath(taskId, `attempt-${attempt.receipt.attemptId}.json`);
  const nextAttempt: StoredAttemptV02 = { ...attempt, outcomeReceiptId: snapshot.receiptId, status: 'uncertain' };
  const completed: OutcomeRecordResultV02 = { outcome: 'uncertain', receiptId: snapshot.receiptId };
  if (claim.status === 'uncertain') {
    if (attempt.outcomeReceiptId === snapshot.receiptId) return done;
    await store.writeJson(attemptPath, nextAttempt);
    return completed;
  }
  const control = await store.readControl(taskId, DEFAULT_CONTROL);
  if (control.epoch !== claim.receipt.epoch) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
  await store.writeJson(attemptPath, nextAttempt);
  await store.writeClaim(taskId, { ...claim, status: 'uncertain' });
  await store.writeControl(taskId, { ...control, controlVersion: control.controlVersion + 1 });
  return completed;
}
