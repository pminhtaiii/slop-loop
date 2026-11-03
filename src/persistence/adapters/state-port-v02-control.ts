/**
 * Adapter-specific journal control for the durable UC-03 v0.2 state port.
 *
 * shortcut: StatePortV02 has no control/fence surface, but closeUnattemptedClaim and
 * reconcileUncertain are unreachable without one. These mirror MemoryStatePortV02's non-contract
 * setTaskControl/fenceClaimRecipient; fold them into the contract when it grows them.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { computeCanonicalSha256 } from '../../contracts/foundation/uc03.ts';
import type { ExecutorIdentityV02 } from '../../contracts/foundation/uc03.ts';
import { isSafeStorageId } from '../store.ts';
import { isValidRecoveryEvidence } from './state-port-v02-reconcile.ts';
import type { StatePortStore } from './state-port-v02-storage.ts';
import type { ControlRecordV02, FenceProofV02, RecoveryEvidenceV02, TaskControlModeV02 } from './state-port-v02-types.ts';
import { CONTROL_MODES, DEFAULT_CONTROL } from './state-port-v02-types.ts';
import { actorPayloadDigest, equal, validExecutorIdentity } from './state-port-v02-admission.ts';

export async function setTaskControl(store: StatePortStore, taskId: string, mode: TaskControlModeV02, eventRef: string): Promise<boolean> {
  if (!CONTROL_MODES.includes(mode) || !eventRef.trim()) return false;
  if (!isSafeStorageId(taskId)) return false;
  return store.locked(taskId, async () => {
    const control = await store.readControl(taskId, DEFAULT_CONTROL);
    const task = await store.readTask(taskId);
    if (!task) return false;
    if (control.mode === mode && control.holdRef === (mode === 'runnable' ? null : eventRef)) return true;
    const next: ControlRecordV02 = {
      ...control,
      mode,
      holdRef: mode === 'runnable' ? null : eventRef,
      holdEventDigest:
        mode === 'runnable'
          ? null
          : computeCanonicalSha256({
              schemaVersion: 'uc04-control-event/0.2-draft',
              taskId,
              runId: task.runId,
              taskStateVersion: task.stateVersion,
              eventKind: mode === 'rejected' ? 'denial' : 'pause',
              mode,
              eventRef,
              controlVersion: control.controlVersion + 1,
              epoch: control.epoch,
            }),
      controlVersion: control.controlVersion + 1,
    };
    await store.writeControl(taskId, next);
    return true;
  });
}

export async function fenceClaimRecipient(store: StatePortStore, claimId: string, recipient: ExecutorIdentityV02): Promise<FenceProofV02 | null> {
  if (!validExecutorIdentity(recipient)) return null;
  const located = await store.findClaimTask(claimId);
  if (!located) return null;
  const taskId = located.taskId;
  return store.locked(taskId, async () => {
    const control = await store.readControl(taskId, DEFAULT_CONTROL);
    const claim = await store.readClaim(taskId, claimId);
    if (!claim) return null;
    const prior = await store.readFence(taskId, claimId);
    if (prior) return equal(prior.recipientIdentity, recipient) ? structuredClone(prior) : null;
    if (!control.holdRef || control.mode === 'runnable') return null;
    if (claim.status !== 'claimed' || claim.attemptId !== undefined) return null;
    if (recipient.payloadDigest !== actorPayloadDigest(claim.context)) return null;
    let priorGeneration = 0;
    for (const file of (await readdir(store.taskDir(taskId)).catch(() => [] as string[])).filter(name => name.startsWith('fence-') && name.endsWith('.json'))) {
      const existing = await store.readJson<FenceProofV02>(join(store.taskDir(taskId), file));
      if (!existing || existing.fencedExecutorIdentity.adapterIdentity !== recipient.adapterIdentity) continue;
      if (existing.fencedExecutorIdentity.processIncarnation === recipient.processIncarnation) return null;
      priorGeneration = Math.max(priorGeneration, existing.fencingGeneration);
    }
    const generation = Math.max(recipient.fencingGeneration + 1, priorGeneration + 1);
    const proof: FenceProofV02 = {
      claimId,
      claimDigest: claim.receipt.claimDigest,
      taskId: claim.receipt.taskId,
      recipientIdentity: structuredClone(recipient),
      fencedExecutorIdentity: { ...structuredClone(recipient), fencingGeneration: generation },
      fencingGeneration: generation,
      proofRef: { reference: `fence-${claimId}`, digest: computeCanonicalSha256({ claimId, recipient, holdRef: control.holdRef }) },
      adapterEvidenceRefs: [{ reference: `adapter-fence-${claimId}`, digest: computeCanonicalSha256({ recipient, holdRef: control.holdRef }) }],
      holdRef: control.holdRef,
      controlVersion: control.controlVersion + 1,
      epoch: control.epoch,
    };
    await store.writeJson(store.statePath(taskId, `fence-${claimId}.json`), proof);
    await store.writeControl(taskId, { ...control, controlVersion: control.controlVersion + 1 });
    return structuredClone(proof);
  });
}

/** Publishes the durable recovery evidence reconcileUncertain reads for `observed-and-accounted`. */
export async function publishRecoveryEvidence(store: StatePortStore, taskId: string, evidence: RecoveryEvidenceV02): Promise<boolean> {
  if (!isSafeStorageId(taskId) || !isSafeStorageId(evidence.predecessorReceiptId)) return false;
  return store.locked(taskId, async () => {
    const predecessor = await store.readOutcome(taskId, evidence.predecessorReceiptId);
    const claim = predecessor ? await store.readClaim(taskId, predecessor.claimId) : null;
    if (!predecessor || predecessor.outcome !== 'uncertain' || !claim || claim.status !== 'uncertain') return false;
    if (!isValidRecoveryEvidence(evidence, claim)) return false;
    const prior = await store.readRecovery(taskId, evidence.predecessorReceiptId);
    if (prior) return equal(prior, evidence);
    await store.writeJson(store.statePath(taskId, `recovery-${evidence.predecessorReceiptId}.json`), evidence);
    return true;
  });
}
