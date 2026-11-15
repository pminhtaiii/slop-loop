/**
 * T043 — authority publication and recovery admission for the durable UC-04 journal
 * (real-tier contract §(b)5).
 *
 * `publishAuthority` appends one publication record and advances the persisted control head to the
 * new `activeAuthorityRef`, so the T040 read fence sees a policy change as a new policy digest. The
 * receipt is the exact shape UC-05 validates (`control-v02.ts:18-25`). `loadAdmission` is a read-only
 * lookup over the persisted claim records for the one admission bound to a decision; nothing is
 * reconstructed from memory, and an ambiguous or absent decision is `null`.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { authorityRefV02, plainRecordV02, validatePublicationV02 } from '../../approvals/control-v02.ts';
import type { AuthorityPublicationReceiptV02 } from '../../approvals/control-v02.ts';
import { computeCanonicalSha256, validateAdmissionV02 } from '../../contracts/foundation/uc03.ts';
import type { AdmissionContextV02, AdmissionTrustedContextV02, PolicyAuthorityRefV02 } from '../../contracts/foundation/uc03.ts';
import { isSafeStorageId } from '../store.ts';
import type { StatePortStore } from './state-port-v02-storage.ts';
import { CorruptRecordError } from './state-port-v02-storage.ts';
import type { ControlRecordV02, StoredClaimV02 } from './state-port-v02-types.ts';

const PUBLICATIONS_FILE = 'authority-publications.json';
const SHA = /^sha256:[0-9a-f]{64}$/u;

/** A persisted publication: the receipt UC-05 validated, plus the `effectiveAt` its digest covers. */
interface StoredPublicationV02 {
  readonly publicationId: string;
  readonly publicationDigest: string;
  readonly authorityRef: PolicyAuthorityRefV02;
  readonly generation: number;
  readonly effectiveAt?: string | undefined;
}

export interface AuthorityOperationOptions {
  readonly store: StatePortStore;
  /** The task this port is bound to; an unbound port publishes and admits nothing. */
  readonly taskId: string | undefined;
  /** The port's seed for a task with no persisted control head yet. */
  readonly initialControl: ControlRecordV02;
}

/** The admission record UC-05 recovery revalidates, or `null` for an absent or ambiguous one. */
export interface StoredAdmissionV02 {
  readonly context: AdmissionContextV02;
  readonly trustedContext: AdmissionTrustedContextV02;
}

interface PublishInput {
  readonly authorityRef: PolicyAuthorityRefV02;
  readonly effectiveAt?: string | undefined;
}

function publicationIdOf(ref: PolicyAuthorityRefV02): string {
  return `pub-${ref.policyId}-${ref.decisionAuthorityGeneration}`;
}

/** UC-05 proof of a non-published outcome: the same identity, digested without `effectiveAt`. */
function refusal(ref: PolicyAuthorityRefV02, status: 'stale' | 'conflict'): AuthorityPublicationReceiptV02 {
  const publicationId = publicationIdOf(ref);
  return {
    schemaVersion: 'uc05-approval/0.2-draft',
    publicationId,
    publicationDigest: computeCanonicalSha256({ publicationId, authorityRef: ref }),
    authorityRef: ref,
    generation: ref.decisionAuthorityGeneration,
    status,
  };
}

function readInput(input: unknown): PublishInput | null {
  const fields = plainRecordV02(input, ['authorityRef', 'effectiveAt']);
  if (!fields) return null;
  const authorityRef = authorityRefV02(fields['authorityRef']);
  const effectiveAt = fields['effectiveAt'];
  if (!authorityRef || (effectiveAt !== undefined && (typeof effectiveAt !== 'string' || effectiveAt.length > 128))) return null;
  return { authorityRef, ...(effectiveAt !== undefined ? { effectiveAt } : {}) };
}

/** A present publications file is authoritative: a bad shape fails closed rather than widening authority. */
function parsePublications(value: unknown): StoredPublicationV02[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const rows = (value as Record<string, unknown>)['publications'];
  if ((value as Record<string, unknown>)['schemaVersion'] !== 1 || !Array.isArray(rows)) return null;
  const parsed: StoredPublicationV02[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return null;
    const { publicationId, publicationDigest, authorityRef, generation, effectiveAt } = row as Record<string, unknown>;
    const ref = authorityRefV02(authorityRef);
    if (typeof publicationId !== 'string' || typeof publicationDigest !== 'string' || !SHA.test(publicationDigest)) return null;
    if (!ref || typeof generation !== 'number' || generation !== ref.decisionAuthorityGeneration) return null;
    if (effectiveAt !== undefined && typeof effectiveAt !== 'string') return null;
    parsed.push({ publicationId, publicationDigest, authorityRef: ref, generation, ...(effectiveAt !== undefined ? { effectiveAt } : {}) });
  }
  return parsed;
}

async function readPublications(store: StatePortStore, taskId: string): Promise<StoredPublicationV02[] | null> {
  const stored = await store.readJson<unknown>(store.statePath(taskId, PUBLICATIONS_FILE));
  // `readJson` already treats a present file decoding to null as corruption, so null here is absence.
  return stored === null ? [] : parsePublications(stored);
}

/**
 * Persists one authority publication. Same ref replays the stored receipt; a lower or otherwise
 * conflicting generation returns `stale`/`conflict` and writes nothing.
 */
export async function publishAuthority(options: AuthorityOperationOptions, input: unknown): Promise<AuthorityPublicationReceiptV02> {
  const { store, taskId } = options;
  const parsed = readInput(input);
  if (!parsed || !taskId || !isSafeStorageId(taskId))
    return refusal(parsed?.authorityRef ?? { policyId: '', policyVersion: '', configId: '', configVersion: '', issuerKeyRef: '', decisionAuthorityGeneration: 0 }, 'conflict');
  const { authorityRef: ref, effectiveAt } = parsed;

  return store.locked(taskId, async () => {
    if (!(await store.readTask(taskId))) return refusal(ref, 'conflict');
    const stored = await readPublications(store, taskId);
    if (stored === null) return refusal(ref, 'conflict');

    const publicationId = publicationIdOf(ref);
    const publicationDigest = computeCanonicalSha256({ publicationId, authorityRef: ref, ...(effectiveAt !== undefined ? { effectiveAt } : {}) });
    const prior = stored.find(row => row.publicationId === publicationId);
    if (prior) {
      if (prior.publicationDigest !== publicationDigest) return refusal(ref, 'conflict');
      return healControlHead(store, taskId, options.initialControl, ref, prior);
    }

    const control = await store.readControl(taskId, options.initialControl);
    const active = control.activeAuthorityRef;
    if (active && ref.decisionAuthorityGeneration <= active.decisionAuthorityGeneration) return refusal(ref, 'stale');
    // A row recorded by a failed head write still owns its generation: a different policy may not append over it.
    if (stored.some(row => row.generation >= ref.decisionAuthorityGeneration)) return refusal(ref, 'conflict');

    const entry: StoredPublicationV02 = { publicationId, publicationDigest, authorityRef: ref, generation: ref.decisionAuthorityGeneration, ...(effectiveAt !== undefined ? { effectiveAt } : {}) };
    // Record first, then the shared head: a crash between them is healed by the replay above.
    await store.writeJson(store.statePath(taskId, PUBLICATIONS_FILE), { schemaVersion: 1, publications: [...stored, entry] });
    const receipt: AuthorityPublicationReceiptV02 = {
      schemaVersion: 'uc05-approval/0.2-draft',
      publicationId,
      publicationDigest,
      authorityRef: ref,
      generation: ref.decisionAuthorityGeneration,
      status: 'published',
    };
    const validated = validatePublicationV02(receipt, ref, effectiveAt);
    if (!validated) return refusal(ref, 'conflict');
    await store.writeControl(taskId, { ...control, controlVersion: control.controlVersion + 1, activeAuthorityRef: ref });
    return validated;
  });
}

/** An idempotent replay still re-asserts the head when a previous attempt recorded but did not advance it. */
async function healControlHead(store: StatePortStore, taskId: string, seed: ControlRecordV02, ref: PolicyAuthorityRefV02, prior: StoredPublicationV02): Promise<AuthorityPublicationReceiptV02> {
  const control = await store.readControl(taskId, seed);
  const receipt: AuthorityPublicationReceiptV02 = {
    schemaVersion: 'uc05-approval/0.2-draft',
    publicationId: prior.publicationId,
    publicationDigest: prior.publicationDigest,
    authorityRef: prior.authorityRef,
    generation: prior.generation,
    status: 'published',
  };
  const validated = validatePublicationV02(receipt, ref, prior.effectiveAt);
  if (!validated) return refusal(ref, 'conflict');
  const active = control.activeAuthorityRef;
  if (!active || active.decisionAuthorityGeneration < ref.decisionAuthorityGeneration) {
    await store.writeControl(taskId, { ...control, controlVersion: control.controlVersion + 1, activeAuthorityRef: prior.authorityRef });
  }
  return validated;
}

/** The decision an admission was issued for: its plan decision, or the action decision that bound it. */
function decisionOf(context: AdmissionContextV02): readonly string[] {
  return [
    ...(context.planApplicability === 'approved-plan' ? [context.planDecisionRef] : []),
    ...(context.subjectKind === 'repository-action' && context.actionDecisionReceipt ? [context.actionDecisionReceipt.decisionId] : []),
  ];
}

/**
 * Reads the one persisted admission bound to `decisionId`. Absence, another task, more than one
 * matching claim record, or a record the canonical validator rejects are all `null`.
 */
export async function loadAdmission(options: AuthorityOperationOptions, decisionId: string): Promise<StoredAdmissionV02 | null> {
  const { store, taskId } = options;
  if (!taskId || !isSafeStorageId(taskId) || !isSafeStorageId(decisionId)) return null;
  return store.locked(taskId, async () => {
    const names = await readdir(join(store.store.claimDir, taskId)).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
      throw err;
    });
    const matches = [];
    for (const name of names.filter(entry => entry.endsWith('.json'))) {
      // A record the validators reject is the documented `null` outcome, not an outage: like an absent
      // claim it must not hide an unrelated valid admission. Only unknown failures propagate.
      const claim: StoredClaimV02 | null = await store.readClaim(taskId, name.slice(0, -'.json'.length)).catch(err => {
        if (err instanceof CorruptRecordError) return null;
        throw err;
      });
      if (claim?.context.taskId === taskId && decisionOf(claim.context).includes(decisionId)) matches.push(claim);
    }
    const match = matches.length === 1 ? matches[0] : undefined;
    if (!match) return null;
    const checked = validateAdmissionV02(match.context, match.trustedAdmissionContext);
    return checked.ok ? { context: structuredClone(checked.value), trustedContext: structuredClone(match.trustedAdmissionContext) } : null;
  });
}
