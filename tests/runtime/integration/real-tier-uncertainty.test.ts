/**
 * T058 — uncertain effects route to their owner and gate continuation (real-tier contract §(b)2,
 * §(h)).
 *
 * Every row builds its evidence with the production T040 journal lookup, T041 baseline store or T044
 * replan transaction over a temp store. The dispatch doubles count the transport fetch and
 * `applyPatch`, and the replan `accept` and baseline `persist` are counted at their owner boundary.
 * Each row then gates after setup and requires the same four counts plus byte-identical store
 * contents, so it proves the gate neither wrote nor replayed anything. Provider and patch `unknown`
 * are gated twice: they stay blocked.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeCanonicalSha256, computeCheckSetDigest } from '../../../src/contracts/foundation/uc03.ts';
import type { AdmissionContextV02, BudgetLedger, CheckDefinition, FixPlan, RepositoryAdmissionContextV02, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { createDurableUnattemptedClaimClosureHandoff } from '../../../src/foundation/durable-recovery-handoffs.ts';
import { BASELINE_OPERATION_PREFIX, createBaselineEvidenceStore } from '../../../src/persistence/adapters/baseline-evidence-store.ts';
import type { BaselineRecordPaths } from '../../../src/persistence/adapters/baseline-evidence-store.ts';
import { createMaterialReplanPort } from '../../../src/persistence/adapters/material-replan-port.ts';
import { actorPayloadDigest, authorityFor } from '../../../src/persistence/adapters/state-port-v02-admission.ts';
import { createJournalOperationLookup, journalOperationId, journalOperationRef } from '../../../src/persistence/adapters/state-port-v02-operation-lookup.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { atomicWrite, DurableStore } from '../../../src/persistence/store.ts';
import { createRecoveryGate } from '../../../src/runtime/real-tier-recovery.ts';
import type { RecoveryDecision, RecoveryGate } from '../../../src/runtime/real-tier-recovery.ts';
import type { MaterialReplanRequestV02 } from '../../../src/uc03/graph-types-v02.ts';
import type { BaselineEvidenceCandidate, BaselineEvidenceWriteRequest } from '../../../src/uc03/investigation-types.ts';
import type { TrustedReplanDirection } from '../../../src/uc03/repair-types.ts';
import { createFixtureBugTask, createFixtureTaskState } from '../support/uc03/port-fixtures.ts';
import {
  createTestAdmissionTaskStateV02,
  createTestExecutorIdentityV02,
  createTestProviderAdmissionContextV02,
  createTestProviderOutcomeReceiptV02,
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryCommandAdmissionContextV02,
  createTestRepositoryOutcomeReceiptV02,
} from '../support/uc03/state-fixtures.ts';

interface Counts {
  fetch: number;
  applyPatch: number;
  accept: number;
  persist: number;
}

/** The effect doubles every row counts: a dispatch that may have landed, and the two owner writes. */
interface Effects {
  readonly counts: Counts;
  readonly transport: { fetch(): Promise<void> };
  readonly repository: { applyPatch(): Promise<void> };
}

interface Row {
  readonly dir: string;
  readonly ref: string;
  /** The one owner the prefix may reach, or none for a prefix no owner claims. */
  readonly owner: 'journal' | 'baseline' | 'none';
  readonly effects: Effects;
  readonly gate: RecoveryGate;
  readonly ownerCalls: { operation: number; write: number };
}

function effects(): Effects {
  const counts: Counts = { fetch: 0, applyPatch: 0, accept: 0, persist: 0 };
  return {
    counts,
    transport: { fetch: async () => void (counts.fetch += 1) },
    repository: { applyPatch: async () => void (counts.applyPatch += 1) },
  };
}

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `t058-${label}-`));
}

/** Production owner lookups over one temp store, wrapped only to count which owner is asked. */
function row(dir: string, ref: string, owner: Row['owner'], effect: Effects): Row {
  const store = new DurableStore(dir);
  const journal = createJournalOperationLookup(new DurableStatePortV02({ store }));
  const baseline = createBaselineEvidenceStore({ store });
  const ownerCalls = { operation: 0, write: 0 };
  const gate = createRecoveryGate({
    lookupOperation: operationRef => {
      ownerCalls.operation += 1;
      return journal.lookupOperation(operationRef);
    },
    lookupWrite: operationRef => {
      ownerCalls.write += 1;
      return baseline.lookupWrite(operationRef);
    },
  });
  return { dir, ref, owner, effects: effect, gate, ownerCalls };
}

/** Every path under the store with a byte digest for each file, sorted: a total view of persisted state. */
function snapshot(dir: string): string {
  return readdirSync(dir, { recursive: true })
    .map(entry => String(entry).replaceAll('\\', '/'))
    .sort()
    .map(name => {
      const path = join(dir, name);
      return statSync(path).isFile() ? `${name}:${createHash('sha256').update(readFileSync(path)).digest('hex')}` : name;
    })
    .join('\n');
}

/** Gates `ref` and proves the decision, the held bytes and the untouched effect counts. */
async function expectRow(row: Row, expected: RecoveryDecision, repeats = 1): Promise<void> {
  const before = snapshot(row.dir);
  const countsBefore = { ...row.effects.counts };
  const ownerCalls = row.owner === 'journal' ? { operation: repeats, write: 0 } : row.owner === 'baseline' ? { operation: 0, write: repeats } : { operation: 0, write: 0 };
  try {
    for (let call = 0; call < repeats; call++) {
      assert.equal(await row.gate.decide(row.ref), expected, `gate decision for ${row.ref} on call ${call + 1}`);
      assert.equal(snapshot(row.dir), before, `${row.ref}: the gate must leave task, control, journal and baseline bytes unchanged`);
      assert.deepEqual({ ...row.effects.counts }, countsBefore, `${row.ref}: the gate must replay no fetch, applyPatch, replan accept or baseline persist`);
    }
    assert.deepEqual({ ...row.ownerCalls }, ownerCalls, `${row.ref}: the prefix must reach exactly its own owner`);
  } finally {
    rmSync(row.dir, { recursive: true, force: true });
  }
}

/** Seeds one persisted task and control head, so every row's hold assertion covers real bytes. */
async function seedTask(dir: string, ctx: AdmissionContextV02): Promise<DurableStatePortV02> {
  const store = new DurableStore(dir);
  await store.init();
  const port = new DurableStatePortV02({
    store,
    initialControl: { controlVersion: ctx.expectedControlVersion, epoch: ctx.expectedEpoch, activeAuthorityRef: authorityFor(ctx) },
  });
  await port.transition(createTestAdmissionTaskStateV02(ctx), 0);
  return port;
}

type JournalEffect = 'provider' | 'patch';
type JournalEvidence = 'committed' | 'closed-unattempted' | 'begun';

async function journalRow(effect: JournalEffect, evidence: JournalEvidence): Promise<Row> {
  const dir = tempDir(`journal-${effect}-${evidence}`);
  const dispatch = effects();
  const ctx = effect === 'provider' ? createTestProviderAdmissionContextV02() : createTestRepositoryAdmissionContextV02();
  const port = await seedTask(dir, ctx);
  const claim = await port.claim(ctx);
  assert.notEqual(claim.claimId, '', 'the fixture admission must open a claim');
  const executor = createTestExecutorIdentityV02({ payloadDigest: actorPayloadDigest(ctx) });
  const ref = journalOperationRef(claim.claimId);

  if (evidence === 'closed-unattempted') {
    // Invariant: the handoff reads only `admission.taskId`; closure itself re-checks the stored claim context.
    const closure = await createDurableUnattemptedClaimClosureHandoff(port).closeUnattemptedClaim({
      admission: ctx as RepositoryAdmissionContextV02,
      claim,
      recipientIdentity: executor,
    });
    assert.equal(closure.closed, true, 'the claim must close unattempted before its absence is asserted');
    return row(dir, ref, 'journal', dispatch);
  }

  const attempt = await port.beginAttempt(claim.claimId, executor);
  assert.notEqual(attempt.attemptId, '', 'the fixture must begin an attempt');
  // The dispatch double is the transport call / patch application that may have landed.
  if (effect === 'provider') await dispatch.transport.fetch();
  else await dispatch.repository.applyPatch();

  if (evidence === 'committed') {
    const outcome = ctx.subjectKind === 'provider-request' ? createTestProviderOutcomeReceiptV02(claim, attempt, ctx) : createTestRepositoryOutcomeReceiptV02(claim, attempt, ctx);
    assert.equal((await port.recordOutcome(outcome)).outcome, 'settled', 'the committed row needs its outcome recorded');
  }
  return row(dir, ref, 'journal', dispatch);
}

const PROPOSAL = 'replan-prop-001';
const CHANGED_STRATEGY = 'Check divisor == 0 and raise CalculationError';
const fixtureTask = createFixtureBugTask();

/** A task paused at AwaitFeedback with an approved plan: the only state a revise direction binds. */
function replanSeed(): { state: TaskState; request: MaterialReplanRequestV02 } {
  const strategy = 'Check divisor == 0 before division';
  const plan: FixPlan = {
    planVersion: 1,
    diagnosis: 'Calculator.divide does not check the divisor',
    suspectedCauseLocations: ['src/calculator.py:3'],
    evidenceRefs: ['evi-repro-001'],
    strategy,
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: computeCheckSetDigest(fixtureTask.requiredChecks),
    baselineRef: fixtureTask.initialRevisionDigest,
    strategyDigest: computeCanonicalSha256(strategy),
    decisionRef: 'dec-plan-001',
  };
  const budget = (kind: string, limit: number, unit: 'count' | 'usd'): BudgetLedger => ({
    scope: 'task',
    kind,
    limit,
    consumed: 0,
    reservations: [],
    unit,
    configurationId: fixtureTask.configId,
    version: 1,
  });
  const state: TaskState = createFixtureTaskState({
    stateVersion: 1,
    node: 'AwaitFeedback',
    nextAction: 'await-human-direction',
    planVersion: 1,
    plan,
    activeDecisionId: plan.decisionRef,
    replanCount: 0,
    budgetLedgers: [
      budget('replan', 3, 'count'),
      budget('repair', 2, 'count'),
      budget('tokens', fixtureTask.budgetLimits.maxTokens, 'count'),
      budget('cost', fixtureTask.budgetLimits.maxCostUsd, 'usd'),
    ],
  });
  const candidate: FixPlan = { ...plan, strategy: CHANGED_STRATEGY, strategyDigest: computeCanonicalSha256(CHANGED_STRATEGY), decisionRef: undefined };
  const direction: TrustedReplanDirection = {
    directive: 'revise',
    taskId: state.taskId,
    workspaceId: state.workspaceId,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
    stateVersion: state.stateVersion,
    planVersion: state.planVersion,
    rejectedDecisionId: plan.decisionRef ?? '',
    strategyDigest: plan.strategyDigest,
  };
  return {
    state,
    request: {
      taskId: state.taskId,
      runId: state.runId,
      workspaceId: state.workspaceId,
      repositoryId: state.repositoryId,
      configurationId: state.taskContext?.configId ?? '',
      configurationVersion: state.taskContext?.configVersion ?? '',
      proposalId: PROPOSAL,
      candidatePlan: candidate,
      candidatePlanDigest: computeCanonicalSha256(candidate),
      priorPlanVersion: state.planVersion,
      priorStateVersion: state.stateVersion,
      priorReplanCount: state.replanCount,
      expectedNextReplanCount: state.replanCount + 1,
      direction,
    },
  };
}

type ReplanEvidence = 'accepted' | 'lost-write' | 'lost-ack';

async function replanRow(evidence: ReplanEvidence): Promise<Row> {
  const dir = tempDir(`replan-${evidence}`);
  const dispatch = effects();
  const store = new DurableStore(dir);
  await store.init();
  const port = new DurableStatePortV02({ store });
  const { state, request } = replanSeed();
  await port.transition(state, 0);
  // The default control seed never writes a head; pause and resume so this row holds real control bytes.
  assert.equal(await port.setTaskControl(state.taskId, 'paused', 'pause-t058-seed'), true);
  assert.equal(await port.setTaskControl(state.taskId, 'runnable', 'resume-t058-seed'), true);

  const commitTransaction =
    evidence === 'lost-write'
      ? async (): Promise<void> => {
          throw new Error('write abandoned before any record');
        }
      : evidence === 'lost-ack'
        ? async (write: () => Promise<void>): Promise<void> => {
            await write();
            throw new Error('lost acknowledgement after the commit');
          }
        : undefined;
  const replan = createMaterialReplanPort({ state: port, verifyDirection: () => true, ...(commitTransaction ? { commitTransaction } : {}) });
  const accept = async (input: MaterialReplanRequestV02) => {
    dispatch.counts.accept += 1;
    return replan.accept(input);
  };
  const result = await accept(request);
  if (result.outcome !== 'accepted' && result.outcome !== 'uncertain') throw new Error(`unexpected replan outcome ${result.outcome}: ${result.outcome === 'denied' ? result.reason : ''}`);
  if (evidence === 'accepted') assert.equal(result.outcome, 'accepted', 'the committed row needs its replan accepted');
  const ref = result.outcome === 'uncertain' ? result.operationRef : journalOperationRef(journalOperationId(request.taskId, PROPOSAL));
  return row(dir, ref, 'journal', dispatch);
}

const requiredChecks: readonly CheckDefinition[] = Object.freeze([
  Object.freeze({ checkId: 'check-repro', executable: 'python', argv: Object.freeze(['-m', 'pytest', 'tests/test_bug.py']), purpose: 'reproduction' as const }),
  Object.freeze({ checkId: 'check-regression', executable: 'python', argv: Object.freeze(['-m', 'pytest', 'tests/test_ok.py']), purpose: 'regression' as const }),
]);

function baselineCandidate(): BaselineEvidenceCandidate {
  return {
    taskId: 'task-baseline-001',
    workspaceId: 'workspace-1',
    repositoryId: 'repo-1',
    acceptanceCriteria: ['the reported defect no longer reproduces'],
    criteriaDigest: computeCanonicalSha256(['the reported defect no longer reproduces']),
    requiredChecks,
    expectedPassingCheckIds: ['check-regression'],
    reproductionCheckId: 'check-repro',
    expectedTestFiles: ['tests/test_bug.py', 'tests/test_ok.py'],
    repositorySnapshotDigest: `sha256:${'1'.repeat(64)}`,
    checkSetDigest: computeCheckSetDigest(requiredChecks),
    reproductionFailureSignature: 'AssertionError: expected 1 got 2',
    checkResults: [
      { checkId: 'check-repro', outcome: 'fail' as const },
      { checkId: 'check-regression', outcome: 'pass' as const },
    ],
    testProtectionDigest: `sha256:${'2'.repeat(64)}`,
  };
}

function storedOperationRef(dir: string): string {
  const [entry] = readdirSync(join(dir, 'baseline-evidence'));
  assert.ok(entry, 'expected exactly one stored baseline record');
  const record = JSON.parse(readFileSync(join(dir, 'baseline-evidence', entry, 'record.json'), 'utf8')) as { operationRef: string };
  return record.operationRef;
}

type BaselineEvidence = 'committed' | 'absent' | 'unknown' | 'lost-ack';

async function baselineRow(evidence: BaselineEvidence): Promise<Row> {
  const dir = tempDir(`baseline-${evidence}`);
  const dispatch = effects();
  // The same store also holds a task and control head, so this row proves those bytes hold too.
  await seedTask(dir, createTestRepositoryCommandAdmissionContextV02());
  const durable = new DurableStore(dir);
  const commitRecord =
    evidence === 'absent'
      ? async (): Promise<void> => {
          throw new Error('write abandoned before any bytes landed');
        }
      : evidence === 'unknown'
        ? async ({ pendingPath }: BaselineRecordPaths, text: string): Promise<void> => {
            await atomicWrite(pendingPath, text);
            throw new Error('write abandoned before the rename');
          }
        : evidence === 'lost-ack'
          ? async ({ recordPath }: BaselineRecordPaths, text: string): Promise<void> => {
              await atomicWrite(recordPath, text);
              throw new Error('acknowledgement lost after the rename committed');
            }
          : undefined;
  const store = createBaselineEvidenceStore({ store: durable, ...(commitRecord ? { commitRecord } : {}) });
  const persist = async (request: BaselineEvidenceWriteRequest) => {
    dispatch.counts.persist += 1;
    return store.persist(request);
  };
  const content = baselineCandidate();
  const outcome = await persist({ content, contentDigest: computeCanonicalSha256(content) });

  if (outcome.outcome === 'durable') {
    assert.equal(evidence, 'committed', 'only the committed row may write durably');
    const ref = storedOperationRef(dir);
    assert.ok(ref.startsWith(BASELINE_OPERATION_PREFIX), 'the stored ref carries its owner prefix');
    return row(dir, ref, 'baseline', dispatch);
  }
  assert.notEqual(evidence, 'committed', 'the committed row must write durably');
  assert.equal(outcome.outcome, 'uncertain', `expected an uncertain write, got ${outcome.outcome}`);
  if (outcome.outcome !== 'uncertain') throw new Error('unreachable');
  return row(dir, outcome.operationRef, 'baseline', dispatch);
}

async function emptyRow(kind: 'journal-no-record' | 'unknown-prefix'): Promise<Row> {
  const dir = tempDir(kind);
  await seedTask(dir, createTestRepositoryCommandAdmissionContextV02());
  const ref = kind === 'journal-no-record' ? journalOperationRef('claim-never-issued') : 'uc99-elsewhere:claim-never-issued';
  return row(dir, ref, kind === 'journal-no-record' ? 'journal' : 'none', effects());
}

/** Every matrix row: the title, the setup that produces the ref, and the decision it must gate to. */
const ROWS: readonly (readonly [string, () => Promise<Row>, RecoveryDecision])[] = [
  ['a committed provider attempt resumes from the journal', () => journalRow('provider', 'committed'), 'resume'],
  ['a provider claim closed unattempted permits a fresh attempt', () => journalRow('provider', 'closed-unattempted'), 'fresh-attempt'],
  // Gated twice: an attempted provider call with no record stays blocked permanently (§(h)).
  ['a provider attempt with no recorded outcome stays blocked', () => journalRow('provider', 'begun'), 'blocked'],
  ['a committed patch attempt resumes from the journal', () => journalRow('patch', 'committed'), 'resume'],
  ['a patch claim closed unattempted permits a fresh attempt', () => journalRow('patch', 'closed-unattempted'), 'fresh-attempt'],
  ['a patch attempt with no recorded outcome stays blocked', () => journalRow('patch', 'begun'), 'blocked'],
  ['a committed material replan resumes', () => replanRow('accepted'), 'resume'],
  ['a lost replan write with no record stays blocked, never absent', () => replanRow('lost-write'), 'blocked'],
  ['a replan whose acknowledgement was lost resumes from its recorded commit', () => replanRow('lost-ack'), 'resume'],
  ['a committed baseline write resumes from the owner record', () => baselineRow('committed'), 'resume'],
  ['a baseline write with neither file present permits a fresh attempt', () => baselineRow('absent'), 'fresh-attempt'],
  ['a baseline write with unsettled debris stays blocked', () => baselineRow('unknown'), 'blocked'],
  ['a baseline write whose acknowledgement was lost resumes from the stored record', () => baselineRow('lost-ack'), 'resume'],
  ['a journal ref with no record is blocked, never a fresh attempt', () => emptyRow('journal-no-record'), 'blocked'],
  ['an unknown prefix is blocked and reaches no owner', () => emptyRow('unknown-prefix'), 'blocked'],
];

for (const [title, build, expected] of ROWS) test(`recovery gate: ${title}`, async () => expectRow(await build(), expected, expected === 'blocked' ? 2 : 1));
