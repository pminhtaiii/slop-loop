/**
 * Read-side of the durable UC-03 v0.2 journal: one claim's durable facts, settled patch ancestry,
 * and the read-only journal snapshot the approval control validates against.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateRepositoryAdmissionV02, validateRepositoryExecutionReceiptV02 } from '../../contracts/foundation/uc03.ts';
import type {
  AttemptOutcomeReceiptV02,
  AttemptReceiptV02,
  AttemptReconciliationReceiptV02,
  ClaimClosureReceiptV02,
  ClaimReceiptV02,
  RepositoryExecutionReceiptV02,
  SettledPatchAncestryRequestV02,
  SettledPatchAncestryV02,
} from '../../contracts/foundation/uc03.ts';
import { isSafeStorageId } from '../store.ts';
import type { StatePortStore } from './state-port-v02-storage.ts';
import type { ControlRecordV02, FenceProofV02, StoredAttemptV02, StoredClaimV02 } from './state-port-v02-types.ts';
import { SHA256 } from './state-port-v02-types.ts';

export interface JournalOptions {
  readonly store: StatePortStore;
  readonly initialControl: ControlRecordV02;
}

/**
 * Durable facts of one claim, for the attempt-start recovery query. Returns null when the claim is
 * absent or belongs to another task; every field is read from the store, none is inferred.
 */
export async function readClaimState(
  store: StatePortStore,
  claimId: string,
): Promise<{
  readonly taskId: string;
  readonly claim: ClaimReceiptV02;
  readonly status: StoredClaimV02['status'];
  readonly attempt: AttemptReceiptV02 | null;
  readonly fence: FenceProofV02 | null;
  readonly closure: ClaimClosureReceiptV02 | null;
} | null> {
  if (!isSafeStorageId(claimId)) return null;
  const located = await store.findClaimTask(claimId);
  if (!located) return null;
  const { taskId, claim } = located;
  const attempt = claim.attemptId ? await store.readAttempt(taskId, claim.attemptId) : null;
  const fence = await store.readFence(taskId, claimId);
  let closure: ClaimClosureReceiptV02 | null = null;
  for (const name of await readdir(dirname(store.statePath(taskId, 'x'))).catch(() => [] as string[])) {
    if (!name.startsWith('closure-') || !name.endsWith('.json')) continue;
    const candidate = await store.readJson<ClaimClosureReceiptV02>(store.statePath(taskId, name));
    if (candidate?.claimId === claimId) closure = candidate;
  }
  return structuredClone({ taskId, claim: claim.receipt, status: claim.status, attempt: attempt?.receipt ?? null, fence, closure });
}

export async function readSettledPatchAncestry(store: StatePortStore, request: SettledPatchAncestryRequestV02): Promise<SettledPatchAncestryV02 | null> {
  let query: SettledPatchAncestryRequestV02;
  try {
    query = structuredClone(request);
  } catch {
    return null;
  }
  if (!query.taskId || !query.runId || !SHA256.test(query.resultingRepositoryRevisionDigest) || !isSafeStorageId(query.taskId)) return null;
  const taskId = query.taskId;
  return store.locked(taskId, async () => {
    let files: string[];
    try {
      files = await readdir(store.taskDir(taskId));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const matches: SettledPatchAncestryV02[] = [];
    for (const file of files.filter(item => item.endsWith('.json')).sort()) {
      const claimId = file.slice(0, -'.json'.length);
      const claim = await store.readClaim(taskId, claimId);
      if (
        !claim ||
        claim.status !== 'settled' ||
        !claim.attemptId ||
        claim.receipt.taskId !== query.taskId ||
        claim.receipt.runId !== query.runId ||
        claim.context.subjectKind !== 'repository-action' ||
        claim.context.runnableNode !== 'Patch' ||
        claim.context.planApplicability !== 'approved-plan' ||
        claim.context.action.kind !== 'apply_patch' ||
        claim.trustedAdmissionContext.subjectKind !== 'repository-action' ||
        !claim.settlementResult
      )
        continue;
      const attempt = await store.readAttempt(taskId, claim.attemptId);
      const outcome = attempt?.outcomeReceiptId ? await store.readOutcome(taskId, attempt.outcomeReceiptId) : null;
      if (
        !attempt ||
        attempt.status !== 'settled' ||
        !outcome ||
        outcome.subjectKind !== 'repository-action' ||
        outcome.outcome !== 'observed' ||
        outcome.observedResultRevisionDigest !== query.resultingRepositoryRevisionDigest ||
        outcome.claimId !== claim.receipt.claimId ||
        outcome.attemptId !== attempt.receipt.attemptId ||
        claim.settlementResult.receiptId !== outcome.receiptId
      )
        continue;
      const admission = validateRepositoryAdmissionV02(claim.context, claim.trustedAdmissionContext);
      const execution: RepositoryExecutionReceiptV02 = { claim: claim.receipt, attempt: attempt.receipt, outcome, settlement: claim.settlementResult };
      if (!admission.ok || !validateRepositoryExecutionReceiptV02(execution, claim.context).ok) continue;
      matches.push({
        admissionContext: structuredClone(claim.context),
        trustedAdmissionContext: structuredClone(claim.trustedAdmissionContext),
        claim: structuredClone(claim.receipt),
        attempt: structuredClone(attempt.receipt),
        outcome: structuredClone(outcome),
        settlement: structuredClone(claim.settlementResult),
        originalTaskState: structuredClone(claim.taskSnapshot),
        originalAuthorityRef: structuredClone(claim.authorityRef),
      });
    }
    return matches.length === 1 ? structuredClone(matches[0] ?? null) : null;
  });
}

/**
 * Read-only 17-key JournalSnapshotV02 over the durable task, the shape
 * ControlledRepositoryReader and createApprovalControlV02 validate.
 *
 * Synchronous on purpose: RepositoryTaskControlReadPortV02 is called between filesystem
 * reads as the read hold, so a cached copy would let a mid-read pause go unseen.
 *
 * shortcut: no publication or control-event log is persisted, so authorityPublications is
 * empty and controlEventRefs holds only the current holdRef. Add both when a real closure
 * path needs them.
 */
export function getJournalSnapshot(options: JournalOptions, taskId: string): unknown {
  const { store } = options;
  if (!isSafeStorageId(taskId)) return null;
  const read = <T>(path: string): T | null => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };
  const listDir = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  };
  const names = listDir(store.taskDir(taskId));
  const ids = (prefix: string): string[] =>
    names.filter(name => name.startsWith(prefix) && name.endsWith('.json') && isSafeStorageId(name.slice(prefix.length, -'.json'.length))).map(name => name.slice(prefix.length, -'.json'.length));
  const all = <T>(prefix: string): T[] =>
    ids(prefix)
      .map(id => read<T>(store.statePath(taskId, `${prefix}${id}.json`)))
      .filter((value): value is T => value !== null);

  const control = read<ControlRecordV02>(store.statePath(taskId, 'control.json')) ?? options.initialControl;
  const claims = names
    .filter(name => name.endsWith('.json'))
    .map(name => read<StoredClaimV02>(join(store.taskDir(taskId), name)))
    .filter((claim): claim is StoredClaimV02 => claim !== null);
  const fences = all<FenceProofV02>('fence-');

  return {
    controlVersion: control.controlVersion,
    epoch: control.epoch,
    mode: control.mode,
    holdRef: control.holdRef,
    holdEventDigest: control.holdRef ? control.holdEventDigest : null,
    activeClaimId: control.activeClaimId,
    activeAuthorityRef: control.activeAuthorityRef,
    claims: claims.map(claim => ({ claimId: claim.receipt.claimId, status: claim.status, attemptId: claim.attemptId ?? null })),
    attempts: all<StoredAttemptV02>('attempt-').map(attempt => ({
      attemptId: attempt.receipt.attemptId,
      claimId: attempt.claimId,
      status: attempt.status,
      outcomeReceiptId: attempt.outcomeReceiptId ?? null,
    })),
    outcomes: all<AttemptOutcomeReceiptV02>('outcome-').map(receipt => ({
      receiptId: receipt.receiptId,
      claimId: receipt.claimId,
      attemptId: receipt.attemptId,
      outcome: receipt.outcome,
      receiptDigest: receipt.receiptDigest,
    })),
    reconciliations: all<AttemptReconciliationReceiptV02>('recon-').map(receipt => ({
      reconciliationId: receipt.reconciliationId,
      claimId: receipt.claimId,
      attemptId: receipt.attemptId,
      predecessorReceiptId: receipt.predecessorReceiptId,
      receiptDigest: receipt.reconciliationDigest,
    })),
    closures: all<ClaimClosureReceiptV02>('closure-').map(receipt => ({ receiptId: receipt.receiptId, claimId: receipt.claimId, receiptDigest: receipt.receiptDigest })),
    authorityPublications: [],
    controlEventRefs: control.holdRef ? [control.holdRef] : [],
    fenceProofs: fences.map(proof => ({
      claimId: proof.claimId,
      proofRef: proof.proofRef,
      fencingGeneration: proof.fencingGeneration,
      holdRef: proof.holdRef,
      controlVersion: proof.controlVersion,
      epoch: proof.epoch,
    })),
    recoveryEvidencePredecessorReceiptIds: ids('recovery-'),
    fencedIncarnations: fences
      .map(proof => `${proof.recipientIdentity.adapterIdentity}\u0000${proof.recipientIdentity.processIncarnation}`)
      .filter((key, index, all) => all.indexOf(key) === index)
      .sort(),
  };
}
