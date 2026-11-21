/**
 * T043 — authority publication, recovery admission and the production brand for the durable UC-04
 * journal (real-tier contract §(b)5).
 *
 * Every receipt is checked with `validatePublicationV02`, the same validator UC-05 applies, and
 * every read goes through a fresh port over the same directory so nothing that came from memory
 * instead of bytes can pass. `loadAdmission` is satisfied from the persisted claim journal alone.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { journalSnapshotV02, validatePublicationV02 } from '../../../src/approvals/control-v02.ts';
import { computeCanonicalSha256, validateAdmissionV02 } from '../../../src/contracts/foundation/uc03.ts';
import type { PolicyAuthorityRefV02, RepositoryAdmissionContextV02, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { isProductionJournal } from '../../../src/foundation/production-journal-registry.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import { DEFAULT_CONTROL } from '../../../src/persistence/adapters/state-port-v02-types.ts';
import {
  createTestAdmissionTaskStateV02,
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryAdmissionTrustedContextV02,
  createTestRepositoryCommandAdmissionContextV02,
} from '../support/uc03/state-fixtures.ts';

// The tree reads real sources, so it must find the checkout root from either `tests/` or `dist/tests/`.
const REPO_ROOT = ((): string => {
  for (let dir = dirname(fileURLToPath(import.meta.url)); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  throw new Error('repository root not found');
})();
const commandContext: RepositoryAdmissionContextV02 = createTestRepositoryCommandAdmissionContextV02();
const planContext: RepositoryAdmissionContextV02 = createTestRepositoryAdmissionContextV02();
const DECISION_ID = planContext.planApplicability === 'approved-plan' ? planContext.planDecisionRef : '';

function seedTask(context: RepositoryAdmissionContextV02): TaskState {
  return createTestAdmissionTaskStateV02(context);
}

/** A port with a bound task, which `publishAuthority`/`loadAdmission` require. */
function openPort(baseDir: string, context: RepositoryAdmissionContextV02 = commandContext, bindTask = true): DurableStatePortV02 {
  return new DurableStatePortV02({
    store: new DurableStore(baseDir),
    ...(bindTask ? { taskId: context.taskId } : {}),
    initialControl: { controlVersion: context.expectedControlVersion, epoch: context.expectedEpoch, activeAuthorityRef: context.policyAuthorityRef },
  });
}

/** The persisted control head, read the way the T040 read fence reads it. */
async function headOf(baseDir: string, taskId: string): Promise<{ activeAuthorityRef: PolicyAuthorityRefV02 | null; controlVersion: number }> {
  const control = await new StatePortStore(new DurableStore(baseDir)).readControl(taskId, DEFAULT_CONTROL);
  return { activeAuthorityRef: control.activeAuthorityRef, controlVersion: control.controlVersion };
}

function authorityAfter(ref: PolicyAuthorityRefV02, steps = 1): PolicyAuthorityRefV02 {
  return { ...ref, decisionAuthorityGeneration: ref.decisionAuthorityGeneration + steps };
}

/** The persisted publication rows, or `null` when the file is absent. */
async function publicationRows(baseDir: string, taskId: string): Promise<readonly { readonly publicationId: string; readonly generation: number }[] | null> {
  const state = new StatePortStore(new DurableStore(baseDir));
  const stored = await state.readJson<{ readonly publications: readonly { readonly publicationId: string; readonly generation: number }[] }>(state.statePath(taskId, 'authority-publications.json'));
  return stored?.publications ?? null;
}

async function withDir(body: (baseDir: string) => Promise<void>): Promise<void> {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-authority-'));
  try {
    await body(baseDir);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

test('publishAuthority returns the UC-05-validated receipt and advances the persisted control head', () =>
  withDir(async baseDir => {
    const port = openPort(baseDir);
    await port.transition(seedTask(commandContext), 0);
    const next = authorityAfter(commandContext.policyAuthorityRef);

    const receipt = await port.publishAuthority({ authorityRef: next });
    assert.equal(receipt.status, 'published');
    assert.equal(receipt.generation, next.decisionAuthorityGeneration);
    assert.deepEqual(validatePublicationV02(receipt, next, undefined), receipt, 'UC-05 must accept the exact receipt');

    assert.deepEqual(await headOf(baseDir, commandContext.taskId), { activeAuthorityRef: next, controlVersion: commandContext.expectedControlVersion + 1 });

    // A fresh port over the same directory sees the published head, and the snapshot still validates.
    const restarted = openPort(baseDir);
    assert.deepEqual(journalSnapshotV02(restarted.getJournalSnapshot(commandContext.taskId))?.activeAuthorityRef, next);

    const timedRef = authorityAfter(commandContext.policyAuthorityRef, 2);
    const effectiveAt = '2026-11-15T00:00:00.000Z';
    const timed = await restarted.publishAuthority({ authorityRef: timedRef, effectiveAt });
    assert.equal(timed.status, 'published');
    assert.deepEqual(validatePublicationV02(timed, timedRef, effectiveAt), timed);
    assert.notEqual(timed.publicationDigest, receipt.publicationDigest, 'effectiveAt is part of a published digest');
  }));

test('a repeat is idempotent, and a lower or conflicting generation is stale or conflict without an effect', () =>
  withDir(async baseDir => {
    const port = openPort(baseDir);
    await port.transition(seedTask(commandContext), 0);
    const next = authorityAfter(commandContext.policyAuthorityRef);
    const published = await port.publishAuthority({ authorityRef: next });
    const head = await headOf(baseDir, commandContext.taskId);

    assert.deepEqual(await port.publishAuthority({ authorityRef: next }), published, 'the same ref replays the same publication');
    assert.deepEqual(await headOf(baseDir, commandContext.taskId), head, 'a replay writes nothing');

    const lower = authorityAfter(commandContext.policyAuthorityRef, -1);
    const stale = await port.publishAuthority({ authorityRef: lower });
    assert.equal(stale.status, 'stale');
    assert.deepEqual(validatePublicationV02(stale, lower, undefined), stale);
    assert.deepEqual(await headOf(baseDir, commandContext.taskId), head, 'a stale publication writes nothing');

    const conflicting = { ...next, configVersion: '9.9.9' };
    const conflict = await port.publishAuthority({ authorityRef: conflicting });
    assert.equal(conflict.status, 'conflict');
    assert.deepEqual(validatePublicationV02(conflict, conflicting, undefined), conflict);
    assert.deepEqual(await headOf(baseDir, commandContext.taskId), head, 'a conflicting publication writes nothing');

    const reTimed = await port.publishAuthority({ authorityRef: next, effectiveAt: '2026-11-15T00:00:00.000Z' });
    assert.equal(reTimed.status, 'conflict', 'the same identity with a different effectiveAt is different content');
    assert.deepEqual(await headOf(baseDir, commandContext.taskId), head);
  }));

test('publishAuthority fails closed on an unbound port, a missing task and malformed options', () =>
  withDir(async baseDir => {
    const next = authorityAfter(commandContext.policyAuthorityRef);
    const unbound = await openPort(baseDir, commandContext, false).publishAuthority({ authorityRef: next });
    assert.equal(unbound.status, 'conflict');

    const port = openPort(baseDir);
    assert.equal((await port.publishAuthority({ authorityRef: next })).status, 'conflict', 'no persisted task admits no publication');

    await port.transition(seedTask(commandContext), 0);
    const head = await headOf(baseDir, commandContext.taskId);
    const malformed = [null, {}, { authorityRef: { ...next, policyId: '' } }, { authorityRef: next, extra: true }, { authorityRef: next, effectiveAt: 7 }];
    for (const input of malformed) assert.equal((await port.publishAuthority(input as never)).status, 'conflict');
    assert.deepEqual(await headOf(baseDir, commandContext.taskId), head, 'a malformed publication writes nothing');
  }));

test('loadAdmission returns the admission a persisted claim recorded, and a typed absence otherwise', () =>
  withDir(async baseDir => {
    const port = openPort(baseDir, planContext);
    await port.transition(seedTask(planContext), 0);
    const claim = await port.claim(planContext);
    assert.notEqual(claim.claimId, '', 'the fixture admission must open a claim');

    const restarted = openPort(baseDir, planContext);
    const loaded = await restarted.loadAdmission(DECISION_ID);
    assert.ok(loaded, 'the admission must come back from the persisted claim journal');
    const canonical = validateAdmissionV02(planContext, createTestRepositoryAdmissionTrustedContextV02(planContext));
    assert.ok(canonical.ok);
    // `validateAdmissionV02` returns null-prototype records, so compare the canonical digest.
    assert.equal(computeCanonicalSha256(loaded.context), computeCanonicalSha256(canonical.value), 'the record is the canonical admission, not a projection of it');
    assert.equal(loaded.trustedContext.subjectKind, 'repository-action');

    assert.equal(await restarted.loadAdmission('dec-unknown-001'), null, 'an unknown decision is absent');
    assert.equal(await restarted.loadAdmission(''), null);
    assert.equal(await openPort(baseDir, planContext, false).loadAdmission(DECISION_ID), null, 'an unbound port admits nothing');

    // Two persisted admissions for one decision are ambiguous, so the lookup refuses rather than pick.
    const state = new StatePortStore(new DurableStore(baseDir));
    const first = await state.readClaim(planContext.taskId, claim.claimId);
    assert.ok(first);
    const secondId = 'claim-second-admission-001';
    const unsigned = { ...first.receipt, claimId: secondId, claimDigest: '' };
    await state.writeClaim(planContext.taskId, { ...first, receipt: { ...unsigned, claimDigest: computeCanonicalSha256({ ...unsigned, claimDigest: undefined }) } });
    assert.equal(await openPort(baseDir, planContext).loadAdmission(DECISION_ID), null);
  }));

test('a recorded publication whose head write failed refuses a different policy at the same generation', () =>
  withDir(async baseDir => {
    const port = openPort(baseDir);
    await port.transition(seedTask(commandContext), 0);
    const next = authorityAfter(commandContext.policyAuthorityRef);
    const head = await headOf(baseDir, commandContext.taskId);

    const original = StatePortStore.prototype.writeControl;
    try {
      StatePortStore.prototype.writeControl = async () => {
        throw new Error('synthetic head write failure');
      };
      await assert.rejects(port.publishAuthority({ authorityRef: next }));
    } finally {
      StatePortStore.prototype.writeControl = original;
    }
    const rows = await publicationRows(baseDir, commandContext.taskId);
    assert.deepEqual(
      rows?.map(row => row.generation),
      [next.decisionAuthorityGeneration],
      'the row is recorded before the head write',
    );
    assert.deepEqual(await headOf(baseDir, commandContext.taskId), head, 'the failed head write left the head behind');

    const other = { ...next, policyId: 'policy-other' };
    const refused = await port.publishAuthority({ authorityRef: other });
    assert.equal(refused.status, 'conflict', 'the recorded generation is taken even though the head never advanced');
    assert.deepEqual(await publicationRows(baseDir, commandContext.taskId), rows, 'no second publication at a recorded generation');
    assert.deepEqual(await headOf(baseDir, commandContext.taskId), head, 'the refusal writes nothing');

    const healed = await port.publishAuthority({ authorityRef: next });
    assert.equal(healed.status, 'published', 'an exact replay still heals the head');
    assert.deepEqual((await headOf(baseDir, commandContext.taskId)).activeAuthorityRef, next);
  }));

test('loadAdmission ignores a rejected claim record instead of failing the whole lookup', () =>
  withDir(async baseDir => {
    const port = openPort(baseDir, planContext);
    await port.transition(seedTask(planContext), 0);
    const claim = await port.claim(planContext);
    assert.notEqual(claim.claimId, '', 'the fixture admission must open a claim');

    const state = new StatePortStore(new DurableStore(baseDir));
    // A record the claim validators reject: the documented outcome is absence, not a failed lookup.
    await state.writeJson(state.store.getClaimPath(planContext.taskId, 'claim-malformed-001'), { receipt: {}, context: {}, taskSnapshot: {}, status: 'claimed' });
    const loaded = await openPort(baseDir, planContext).loadAdmission(DECISION_ID);
    assert.ok(loaded, 'one malformed unrelated claim cannot hide a valid admission');

    // An unreadable file is an outage, not a rejected record, and must stay distinct.
    writeFileSync(state.store.getClaimPath(planContext.taskId, 'claim-unreadable-001'), '{not json');
    await assert.rejects(openPort(baseDir, planContext).loadAdmission(DECISION_ID), SyntaxError);
  }));

test('isProductionJournal brands only a real-provenance DurableStatePortV02 instance', () =>
  withDir(async baseDir => {
    const real = new DurableStatePortV02({ store: new DurableStore(baseDir) });
    assert.equal(real.provenance, 'real');
    assert.equal(isProductionJournal(real), true);
    assert.equal(isProductionJournal(new DurableStatePortV02({ store: new DurableStore(baseDir), provenance: 'mock' })), false);
    const forged = Object.assign(Object.create(DurableStatePortV02.prototype) as object, { provenance: 'real' });
    for (const value of [{ provenance: 'real' }, forged, null, 42, 'real']) assert.equal(isProductionJournal(value), false, 'only the constructor mints the brand');
  }));

test('the production journal registry imports nothing and the port constructor is its only call site', () => {
  const registry = 'src/foundation/production-journal-registry.ts';
  const registrySource = readFileSync(join(REPO_ROOT, registry), 'utf8');
  assert.equal(/^\s*import\b/mu.test(registrySource), false, 'the registry must stay dependency-neutral');

  const callSites: string[] = [];
  for (const file of sourceFiles(join(REPO_ROOT, 'src'))) {
    const path = relative(REPO_ROOT, file).replaceAll('\\', '/');
    if (path === registry) continue;
    for (const found of readFileSync(file, 'utf8').match(/\bregisterProductionJournal\s*\([^)]*\)/gu) ?? []) callSites.push(`${path}:${found}`);
  }
  assert.deepEqual(callSites, ['src/persistence/adapters/state-port-v02.ts:registerProductionJournal(this)'], 'the DurableStatePortV02 constructor is the only call site in src');
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
    .map(entry => join(entry.parentPath, entry.name));
}

test('verification snapshot reads the published durable authority and follows generation changes', () =>
  withDir(async baseDir => {
    const port = openPort(baseDir);
    const task = seedTask(commandContext);
    assert.equal(await port.readVerificationAuthoritySnapshot(task.taskId), null);
    await port.transition(task, 0);
    // The seed is the head claims admit against, so the snapshot reads it before anything is persisted.
    assert.equal((await port.readVerificationAuthoritySnapshot(task.taskId))?.controlVersion, ((await port.getJournalSnapshot(task.taskId)) as { controlVersion: number }).controlVersion);
    const authority = authorityAfter(commandContext.policyAuthorityRef);
    assert.equal((await port.publishAuthority({ authorityRef: authority })).status, 'published');
    const { decisionAuthorityGeneration, ...policyIdentity } = authority;
    const snapshot = await openPort(baseDir).readVerificationAuthoritySnapshot(task.taskId);
    assert.deepEqual(snapshot, {
      taskId: task.taskId,
      runId: task.runId,
      stateVersion: task.stateVersion,
      repositoryRevisionDigest: task.repositoryRevisionDigest,
      controlVersion: commandContext.expectedControlVersion + 1,
      epoch: commandContext.expectedEpoch,
      decisionAuthorityGeneration,
      policyIdentity,
      controlMode: 'runnable',
      holdRef: null,
      activeClaimId: null,
    });
    assert.equal(await port.readVerificationAuthoritySnapshot('foreign-task'), null);
    const next = authorityAfter(authority);
    assert.equal((await port.publishAuthority({ authorityRef: next })).status, 'published');
    assert.equal((await port.readVerificationAuthoritySnapshot(task.taskId))?.decisionAuthorityGeneration, next.decisionAuthorityGeneration);
  }));

test('verification snapshot refuses a persisted head without authority', () =>
  withDir(async baseDir => {
    const port = openPort(baseDir);
    await port.transition(seedTask(commandContext), 0);
    const storage = new StatePortStore(new DurableStore(baseDir));
    await storage.writeControl(commandContext.taskId, DEFAULT_CONTROL);
    assert.equal(await port.readVerificationAuthoritySnapshot(commandContext.taskId), null);
  }));
