import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_NODE_TRANSITIONS,
  computeCanonicalSha256,
  computeClarificationAnswerDigest,
  computeClarificationQuestionDigest,
  computeClarificationQuestionId,
  computeRequestContentDigest,
  validateStateTransition,
  validateTaskState,
  type BudgetLimits,
  type BugTask,
  type CheckDefinition,
  type ClarificationAnswer,
  type ClarificationQuestion,
  type ClarificationRecord,
  type ExecutionLimits,
  type ProviderPricingIdentityV02,
  type TaskNode,
  type TaskState,
} from '../../../src/contracts/foundation/uc03.ts';
import { createCoderAgent } from '../../../src/uc03/agent.ts';
import { CLARIFICATION_ROUND_CAP, askClarification, recordClarificationAnswer, type ClarificationPort } from '../../../src/uc03/clarification.ts';
import type { CoderProposal } from '../../../src/uc03/agent-types.ts';
import { coderContextDigest, createInvestigateNode } from '../../../src/uc03/graph-nodes.ts';
import type { UC03CoderAdmission, UC03CoderAdmissionResolver, UC03GraphConfig } from '../../../src/uc03/graph-types.ts';
import type { UC03GraphState } from '../../../src/uc03/graph-state.ts';
import { createFixtureProviderAdmissionReceiptV02 } from '../support/uc03/port-fixtures.ts';
import { createPendingApprovalRoute } from '../support/uc03/controlled-route.ts';
import { createGraphTaskState, seedGraphTaskState } from '../support/uc03/graph-fixtures.ts';
import type { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import { createTestProviderAdmissionContextV02, createTestProviderAdmissionTrustedContextV02, createTestProviderRequest } from '../support/uc03/state-fixtures.ts';

const TASK_ID = 'task-uc03-clarify-001';
const RUN_ID = 'run-clarify-001';
const BASELINE_REF = 'evidence-baseline-001';

function createValidCheck(): CheckDefinition {
  return {
    checkId: 'check-pytest-focused',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py'],
    purpose: 'focused',
    workingDirectory: '/workspace/repo',
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
  };
}

function createValidLimits(): ExecutionLimits {
  return { timeoutMs: 60000, maxOutputBytes: 2097152, maxCpuCores: 2, maxMemoryBytes: 2147483648, maxPids: 64 };
}

function createValidBudgetLimits(): BudgetLimits {
  return { maxReplanCount: 3, maxTokens: 100000, maxCostUsd: 5.0, maxRepairAttempts: 2, maxReviewIterations: 2 };
}

function createValidBugTask(): BugTask {
  return {
    taskId: TASK_ID,
    repositoryId: 'repo-python-calc',
    initialRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    goal: 'Fix ZeroDivisionError when dividing by zero in Calculator.divide',
    observedBehavior: 'Calling Calculator.divide(10, 0) raises unhandled ZeroDivisionError',
    expectedBehavior: 'Calling Calculator.divide(10, 0) raises custom CalculationError with clear message',
    reproduction: 'python -m pytest tests/test_calculator.py -k test_divide_zero',
    acceptanceCriteria: ['Calculator.divide(x, 0) raises CalculationError', 'Existing arithmetic operations remain unchanged'],
    constraints: ['Do not modify external public API signatures', 'No third-party math dependencies'],
    requiredChecks: [createValidCheck()],
    limits: createValidLimits(),
    budgetLimits: createValidBudgetLimits(),
    configId: 'config-uc03-v1',
    configVersion: '1.0.0',
  };
}

function createValidTaskState(node: TaskNode = 'Validate', stateVersion = 1): TaskState {
  const taskContext = createValidBugTask();
  return {
    schemaVersion: '0.1.0',
    stateVersion,
    taskId: TASK_ID,
    runId: RUN_ID,
    workspaceId: 'ws-001',
    repositoryId: taskContext.repositoryId,
    repositoryRevisionDigest: taskContext.initialRevisionDigest,
    goal: taskContext.goal,
    observedBehavior: taskContext.observedBehavior,
    expectedBehavior: taskContext.expectedBehavior,
    reproduction: taskContext.reproduction,
    acceptanceCriteria: taskContext.acceptanceCriteria,
    constraints: taskContext.constraints,
    requiredCheckIds: taskContext.requiredChecks.map(check => check.checkId),
    taskContext,
    node,
    planVersion: 1,
    replanCount: 0,
    changedPaths: [],
    evidenceRefs: [BASELINE_REF],
    risks: ['Regression in floating-point division'],
    nextAction: 'Validate bug intake',
    ...(node === 'Deliver' ? { outcome: 'COMPLETED' as const } : node === 'Incomplete' ? { outcome: 'FAILED' as const } : {}),
  };
}

function createQuestion(text = 'What output did you observe?'): ClarificationQuestion {
  return { questionId: 'q-1', text };
}

function createPlan() {
  return {
    planVersion: 1,
    diagnosis: 'ZeroDivisionError unhandled in divide method',
    suspectedCauseLocations: ['src/calculator.py:42'],
    evidenceRefs: [BASELINE_REF],
    strategy: 'Check denominator and raise CalculationError if zero',
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    baselineRef: BASELINE_REF,
    strategyDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  };
}

function createRecord(state: TaskState, round = 1, questions: readonly ClarificationQuestion[] = [createQuestion()], evidenceRefs: readonly string[] = [BASELINE_REF]): ClarificationRecord {
  const questionId = computeClarificationQuestionId({ taskId: state.taskId, runId: state.runId, round, questions, evidenceRefs });
  const questionDigest = computeClarificationQuestionDigest({
    taskId: state.taskId,
    runId: state.runId,
    askedAtStateVersion: state.stateVersion,
    round,
    questionId,
    questions,
    evidenceRefs,
  });
  return { questionId, questionDigest, askedAtStateVersion: state.stateVersion, round, questions, evidenceRefs };
}

function createAnswer(record: ClarificationRecord, answeredAtStateVersion: number, recorderRef = 'reporter-001', items: readonly ClarificationQuestion[] = record.questions): ClarificationAnswer {
  const answerDigest = computeClarificationAnswerDigest({ questionDigest: record.questionDigest, recorderRef, items });
  return { answerDigest, answeredAtStateVersion, recorderRef, items };
}

test('Clarification record validation: a well-formed unanswered record survives the validateTaskState round trip', (): void => {
  const state = createValidTaskState('Investigate', 2);
  const record = createRecord(state);
  const res = validateTaskState({ ...state, clarification: record });
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.value.clarification, record);
});

function refusalCodes(state: TaskState, clarification: unknown): readonly string[] {
  const res = validateTaskState({ ...state, clarification });
  assert.equal(res.ok, false);
  return res.ok ? [] : res.errors.map(error => error.code);
}

test('Clarification record validation: each malformed variant refuses with its own code', (): void => {
  const state = createValidTaskState('Investigate', 2);
  const record = createRecord(state);

  assert.ok(refusalCodes(state, { ...record, extraField: 'x' }).includes('UNKNOWN_PROPERTY'), 'unknown key');
  assert.ok(refusalCodes(state, { ...record, questionDigest: 'sha256:' + '0'.repeat(64) }).includes('CLARIFICATION_QUESTION_DIGEST_MISMATCH'), 'bad questionDigest');
  assert.ok(refusalCodes(state, { ...record, answer: { ...createAnswer(record, 3), answerDigest: 'sha256:' + '0'.repeat(64) } }).includes('CLARIFICATION_ANSWER_DIGEST_MISMATCH'), 'bad answerDigest');

  const longText = 'x'.repeat(1025);
  const seventeenQuestions = Array.from({ length: 17 }, (_, index) => ({ questionId: `q-${index}`, text: 'why?' }));
  const sixteenQuestions = seventeenQuestions.slice(0, 16);
  const manyRefs = Array.from({ length: 17 }, (_, index) => `evidence-${index}`);

  assert.ok(refusalCodes(state, createRecord(state, 1, [{ questionId: 'q-long', text: longText }])).includes('CLARIFICATION_REF_TOO_LONG'), 'over-long text');
  assert.ok(refusalCodes(state, createRecord(state, 1, seventeenQuestions)).includes('INVALID_CLARIFICATION_ITEMS'), '>16 questions');
  assert.ok(refusalCodes(state, createRecord(state, 1, [createQuestion()], manyRefs)).includes('INVALID_CLARIFICATION_REFS'), '>16 refs');

  const sixteenRecord = createRecord(state, 1, sixteenQuestions);
  const seventeenItems = [...sixteenQuestions, { questionId: 'q-extra', text: 'never asked' }];
  assert.ok(refusalCodes(state, { ...sixteenRecord, answer: createAnswer(sixteenRecord, 3, 'reporter-001', seventeenItems) }).includes('INVALID_CLARIFICATION_ITEMS'), '>16 answer items');

  assert.ok(refusalCodes(state, { ...record, askedAtStateVersion: undefined }).includes('INVALID_POSITIVE_INTEGER'), 'missing askedAtStateVersion');
  assert.ok(refusalCodes(state, createRecord(state, 0)).includes('INVALID_POSITIVE_INTEGER'), 'round 0');
  assert.ok(refusalCodes(state, createRecord(state, 4)).includes('CLARIFICATION_ROUND_EXCEEDED'), 'round 4');
  // An empty ask would pause the task with nothing to answer; an empty answer would cover it exactly.
  assert.ok(refusalCodes(state, createRecord(state, 1, [])).includes('INVALID_CLARIFICATION_ITEMS'), 'zero questions');
  assert.ok(refusalCodes(state, { ...record, answer: { ...createAnswer(record, 3), items: [] } }).includes('INVALID_CLARIFICATION_ITEMS'), 'zero answer items');
});

test('ALLOWED_NODE_TRANSITIONS pins exactly the two clarification edges added to the canonical map', (): void => {
  assert.deepEqual(ALLOWED_NODE_TRANSITIONS, {
    Validate: ['NeedsInfo', 'Investigate'],
    NeedsInfo: ['Validate', 'Investigate'],
    Investigate: ['AwaitPlan', 'NeedsInfo'],
    AwaitPlan: ['AwaitFeedback', 'Patch'],
    AwaitFeedback: ['Investigate', 'Incomplete'],
    Patch: ['Verify', 'Repair'],
    Verify: ['Review', 'Repair'],
    Review: ['Deliver', 'Repair'],
    Repair: ['Patch', 'Investigate', 'Incomplete'],
    Deliver: [],
    Incomplete: [],
  });
});

/* ------------------------------------------------------------------
 * Transition rows
 * ------------------------------------------------------------------ */

function transitionCodes(prior: TaskState, next: unknown): readonly string[] {
  const res = validateStateTransition(prior, next as TaskState);
  assert.equal(res.ok, false);
  return res.ok ? [] : res.errors.map(error => error.code);
}

function priorWithOpenRecord(round = 1): { prior: TaskState; record: ClarificationRecord } {
  const state = createValidTaskState('NeedsInfo', 2);
  const record = createRecord(state, round);
  return { prior: { ...state, clarification: record, evidenceRefs: record.evidenceRefs }, record };
}

test('Investigate -> NeedsInfo accepts only a record bound to prior.stateVersion', (): void => {
  const prior = createValidTaskState('Investigate', 2);
  const record = createRecord(prior);
  const next = { ...prior, stateVersion: 3, node: 'NeedsInfo' as const, clarification: record };

  const ok = validateStateTransition(prior, next);
  assert.equal(ok.ok, true);

  assert.ok(transitionCodes(prior, { ...next, clarification: undefined }).includes('CLARIFICATION_RECORD_REQUIRED'), 'absent record');
  assert.ok(transitionCodes(prior, { ...next, clarification: { ...record, answer: createAnswer(record, 3) } }).includes('CLARIFICATION_ALREADY_ANSWERED'), 'already answered');
  const earlier = createRecord(createValidTaskState('Investigate', 1));
  assert.ok(transitionCodes(prior, { ...next, clarification: earlier }).includes('CLARIFICATION_VERSION_MISMATCH'), 'bound to a different state version');
});

test('Investigate -> NeedsInfo refuses a second question while one is open on the same Investigate state', (): void => {
  const investigate = createValidTaskState('Investigate', 2);
  const open = createRecord(investigate, 1, [createQuestion('already asked')]);
  const prior: TaskState = { ...investigate, clarification: open, evidenceRefs: open.evidenceRefs };
  const second = createRecord(prior, 2, [createQuestion('second question')]);
  const next: TaskState = { ...prior, stateVersion: 3, node: 'NeedsInfo', clarification: second, evidenceRefs: second.evidenceRefs };

  assert.ok(transitionCodes(prior, next).includes('CLARIFICATION_QUESTION_OPEN'));

  const answeredOpen: ClarificationRecord = { ...open, answer: createAnswer(open, 3) };
  const priorAnswered: TaskState = { ...prior, clarification: answeredOpen };
  assert.equal(validateStateTransition(priorAnswered, { ...priorAnswered, stateVersion: 3, node: 'NeedsInfo', clarification: second, evidenceRefs: second.evidenceRefs }).ok, true);
});

test('Investigate -> NeedsInfo refuses a record whose evidence refs are not carried into next.evidenceRefs', (): void => {
  const prior = createValidTaskState('Investigate', 2);
  const foreignRef = 'evidence-foreign-999';
  const record = createRecord(prior, 1, [createQuestion()], [foreignRef]);
  const next = { ...prior, stateVersion: 3, node: 'NeedsInfo' as const, clarification: record };

  assert.ok(transitionCodes(prior, next).includes('CLARIFICATION_EVIDENCE_NOT_CARRIED'), 'foreign evidence ref');

  const carried = { ...next, evidenceRefs: [...prior.evidenceRefs, foreignRef] };
  assert.equal(validateStateTransition(prior, carried).ok, true);
});

test('NeedsInfo -> Investigate requires the supplied answer and carries it unchanged', (): void => {
  const { prior, record } = priorWithOpenRecord();
  const answer = createAnswer(record, prior.stateVersion);
  const next = { ...prior, stateVersion: prior.stateVersion + 1, node: 'Investigate' as const, clarification: { ...record, answer } };

  const res = validateStateTransition(prior, next);
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.value.clarification?.answer, answer);

  assert.ok(transitionCodes(prior, { ...next, clarification: record }).includes('CLARIFICATION_ANSWER_MISSING'), 'missing answer');

  const otherRecord = createRecord(prior, 2, [createQuestion('a different question')]);
  const substituted = { ...otherRecord, answer: createAnswer(otherRecord, prior.stateVersion) };
  assert.ok(transitionCodes(prior, { ...next, clarification: substituted }).includes('CLARIFICATION_ANSWER_SUBSTITUTED'), 'substituted answer');

  const differentDigest = { ...answer, answerDigest: 'sha256:' + '0'.repeat(64) };
  assert.ok(transitionCodes(prior, { ...next, clarification: { ...record, answer: differentDigest } }).includes('CLARIFICATION_ANSWER_DIGEST_MISMATCH'), 'different digest');
  const wrongVersion = { ...answer, answeredAtStateVersion: prior.stateVersion + 5 };
  assert.ok(transitionCodes(prior, { ...next, clarification: { ...record, answer: wrongVersion } }).includes('CLARIFICATION_VERSION_MISMATCH'), 'wrongly versioned answer');
});

test('NeedsInfo -> Investigate refuses an answer item set that omits or adds a question', (): void => {
  const prior = createValidTaskState('NeedsInfo', 2);
  const questions: readonly ClarificationQuestion[] = [createQuestion('first'), { questionId: 'q-2', text: 'second' }];
  const record = createRecord(prior, 1, questions);
  const openPrior = { ...prior, clarification: record };
  const nextWith = (items: readonly ClarificationQuestion[]): TaskState => ({
    ...openPrior,
    stateVersion: openPrior.stateVersion + 1,
    node: 'Investigate',
    clarification: { ...record, answer: createAnswer(record, openPrior.stateVersion, 'reporter-001', items) },
  });

  assert.ok(transitionCodes(openPrior, nextWith(questions.slice(0, 1))).includes('CLARIFICATION_ANSWER_INCOMPLETE'), 'omits an asked question');
  assert.ok(transitionCodes(openPrior, nextWith([...questions, { questionId: 'q-3', text: 'never asked' }])).includes('CLARIFICATION_ANSWER_INCOMPLETE'), 'adds a never-asked question');
  assert.equal(validateStateTransition(openPrior, nextWith(questions)).ok, true);
});

test('NeedsInfo -> Investigate refuses an answer that repeats the only asked question', (): void => {
  const { prior, record } = priorWithOpenRecord();
  const only = record.questions.slice(0, 1);
  const repeated = [...only, ...only];
  const next = {
    ...prior,
    stateVersion: prior.stateVersion + 1,
    node: 'Investigate' as const,
    clarification: { ...record, answer: createAnswer(record, prior.stateVersion, 'reporter-001', repeated) },
  };

  assert.ok(transitionCodes(prior, next).includes('CLARIFICATION_ANSWER_INCOMPLETE'));
});

test('NeedsInfo -> Investigate refuses a duplicated item over a multi-question record', (): void => {
  const prior = createValidTaskState('NeedsInfo', 2);
  const questions: readonly ClarificationQuestion[] = [createQuestion('first'), { questionId: 'q-2', text: 'second' }];
  const record = createRecord(prior, 1, questions);
  const openPrior = { ...prior, clarification: record };
  const repeated = [...questions.slice(0, 1), ...questions.slice(0, 1)];
  const next = {
    ...openPrior,
    stateVersion: openPrior.stateVersion + 1,
    node: 'Investigate' as const,
    clarification: { ...record, answer: createAnswer(record, openPrior.stateVersion, 'reporter-001', repeated) },
  };

  assert.ok(transitionCodes(openPrior, next).includes('CLARIFICATION_ANSWER_INCOMPLETE'));
});

test('NeedsInfo -> Investigate requires a bounded non-empty recorderRef and never consults an identity service', (): void => {
  const { prior, record } = priorWithOpenRecord();
  const answer = createAnswer(record, prior.stateVersion, 'reporter-001');
  const next = { ...prior, stateVersion: prior.stateVersion + 1, node: 'Investigate' as const, clarification: { ...record, answer } };

  const missing = { ...next, clarification: { ...record, answer: { ...answer, recorderRef: undefined } } };
  assert.ok(transitionCodes(prior, missing).includes('INVALID_CLARIFICATION_STRING'), 'missing recorderRef');

  const overLong = { ...next, clarification: { ...record, answer: { ...answer, recorderRef: 'r'.repeat(129) } } };
  assert.ok(transitionCodes(prior, overLong).includes('CLARIFICATION_REF_TOO_LONG'), 'over-long recorderRef');
});

test('NeedsInfo -> Validate works with no record (intake path) and refuses when a record is present (bypass)', (): void => {
  const prior = createValidTaskState('NeedsInfo', 2);
  const next = { ...prior, stateVersion: 3, node: 'Validate' as const };
  assert.equal(validateStateTransition(prior, next).ok, true);

  const { prior: openPrior, record } = priorWithOpenRecord();
  const bypass = { ...openPrior, stateVersion: openPrior.stateVersion + 1, node: 'Validate' as const, clarification: record };
  assert.ok(transitionCodes(openPrior, bypass).includes('CLARIFICATION_BYPASS_REFUSED'), 'bypass with a record present');
});

test('Investigate -> AwaitPlan still transitions with an answered record and echoes it unchanged', (): void => {
  const plan = createPlan();
  const state = createValidTaskState('Investigate', 4);
  const record = createRecord(state);
  const answered: ClarificationRecord = { ...record, answer: createAnswer(record, 5) };
  const prior: TaskState = { ...state, plan, clarification: answered };
  const next: TaskState = { ...prior, stateVersion: 5, node: 'AwaitPlan' };

  const res = validateStateTransition(prior, next);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.value.clarification, answered);
    assert.deepEqual(
      { plan: res.value.plan, planVersion: res.value.planVersion, replanCount: res.value.replanCount },
      { plan: prior.plan, planVersion: prior.planVersion, replanCount: prior.replanCount },
    );
  }

  // The only difference from the accepted pair above is the dropped record: the record lifecycle (§8)
  // refuses it, so the transition cannot shed the record on its way out of the pair.
  assert.ok(transitionCodes(prior, { ...next, clarification: undefined }).includes('CLARIFICATION_RECORD_ALTERED'), 'dropped record');
});

test('a record cannot be shed outside the pair, so a later ask cannot restart at round 1', (): void => {
  const plan = createPlan();
  const state = createValidTaskState('Investigate', 4);
  const record = createRecord(state);
  const answered: ClarificationRecord = { ...record, answer: createAnswer(record, 5) };
  const prior: TaskState = { ...state, plan, clarification: answered };

  // AwaitPlan dropping the record is the route that would otherwise let a later Investigate -> NeedsInfo
  // derive round = (undefined ?? 0) + 1 = 1 and reset the per-task cap of three.
  assert.ok(transitionCodes(prior, { ...prior, stateVersion: 5, node: 'AwaitPlan', clarification: undefined }).includes('CLARIFICATION_RECORD_ALTERED'));

  // A different but self-consistent record is refused as an alteration too, so the guard is about the
  // pair's write monopoly, not just a nil check.
  assert.ok(transitionCodes(prior, { ...prior, stateVersion: 5, node: 'AwaitPlan', clarification: createRecord(prior, 2) }).includes('CLARIFICATION_RECORD_ALTERED'), 'replaced record');

  // The consequence: an Investigate state with no record does accept a round-1 ask, so a shed record
  // really would restart the cap. Only the refusal above keeps that state unreachable.
  const bare = createValidTaskState('Investigate', 4);
  assert.equal(validateStateTransition(bare, { ...bare, stateVersion: 5, node: 'NeedsInfo', clarification: createRecord(bare) }).ok, true);
});

test('CLARIFICATION_ROUND_CAP is 3 and round 4 is refused', (): void => {
  assert.equal(CLARIFICATION_ROUND_CAP, 3);

  const prior = createValidTaskState('Investigate', 6);
  const openRecord: ClarificationRecord = { ...createRecord(prior, 2), answer: createAnswer(createRecord(prior, 2), 7) };
  const priorOpen: TaskState = { ...prior, clarification: openRecord };
  const roundThree = createRecord(prior, 3);
  const accepted = validateStateTransition(priorOpen, { ...priorOpen, stateVersion: 7, node: 'NeedsInfo', clarification: roundThree, evidenceRefs: roundThree.evidenceRefs });
  assert.equal(accepted.ok, true, 'round 3 accepts');

  // Round 4 refuses in `validateStateTransition`'s own state validation, before section 5 runs: the
  // cap is enforced at the record boundary, and section 5 only orders rounds against the open record.
  const roundFour = createRecord(prior, 4);
  assert.ok(
    transitionCodes(priorOpen, { ...priorOpen, stateVersion: 7, node: 'NeedsInfo', clarification: roundFour, evidenceRefs: roundFour.evidenceRefs }).includes('CLARIFICATION_ROUND_EXCEEDED'),
    'round 4 refuses',
  );
});

test('the round sequence is enforced: a first ask is round 1 and a replacement advances by exactly one', (): void => {
  // Both branches of the `CLARIFICATION_ROUND_SEQUENCE` guard, each witnessed by its own row. Without
  // a witness `validateClarification`'s cap of 3 alone would let a first ask open at round 2 or a
  // replacement jump 1 -> 3, shortening the task's real budget without any refusal.
  const fresh = createValidTaskState('Investigate', 2);
  const openingAtTwo = createRecord(fresh, 2);
  assert.ok(
    transitionCodes(fresh, { ...fresh, stateVersion: 3, node: 'NeedsInfo', clarification: openingAtTwo, evidenceRefs: openingAtTwo.evidenceRefs }).includes('CLARIFICATION_ROUND_SEQUENCE'),
    'a first ask must be round 1',
  );

  // A replacement ask leaves `Investigate` carrying an already-answered record.
  const investigate = createValidTaskState('Investigate', 2);
  const open = createRecord(investigate, 1);
  const prior: TaskState = { ...investigate, clarification: { ...open, answer: createAnswer(open, 3) }, evidenceRefs: open.evidenceRefs };
  const jumping = createRecord(prior, 3);
  assert.ok(
    transitionCodes(prior, { ...prior, stateVersion: 3, node: 'NeedsInfo', clarification: jumping, evidenceRefs: jumping.evidenceRefs }).includes('CLARIFICATION_ROUND_SEQUENCE'),
    'a replacement must advance the round by exactly one',
  );

  // The adjacent legal advance is the positive control: 1 -> 2 still transitions, so the two refusals
  // above are the sequence guard and not a blanket refusal of any replacement.
  const next = createRecord(prior, 2);
  assert.equal(validateStateTransition(prior, { ...prior, stateVersion: 3, node: 'NeedsInfo', clarification: next, evidenceRefs: next.evidenceRefs }).ok, true);
});

test('every other NeedsInfo/Investigate exit and every terminal-node exit stays refused', (): void => {
  const nodes: readonly TaskNode[] = ['Validate', 'NeedsInfo', 'Investigate', 'AwaitPlan', 'AwaitFeedback', 'Patch', 'Verify', 'Review', 'Repair', 'Deliver', 'Incomplete'];
  const permitted = new Set(['NeedsInfo->Validate', 'NeedsInfo->Investigate', 'Investigate->AwaitPlan', 'Investigate->NeedsInfo']);

  for (const from of ['NeedsInfo', 'Investigate'] as const) {
    const prior = createValidTaskState(from, 2);
    for (const to of nodes) {
      if (from === to || permitted.has(`${from}->${to}`)) continue;
      const next = { ...prior, stateVersion: 3, node: to, ...(to === 'Deliver' ? { outcome: 'COMPLETED' as const } : {}), ...(to === 'Incomplete' ? { outcome: 'INCOMPLETE' as const } : {}) };
      assert.ok(transitionCodes(prior, next).includes('INVALID_NODE_TRANSITION'), `${from} -> ${to} must stay refused`);
    }
  }

  for (const from of ['Deliver', 'Incomplete'] as const) {
    const prior = createValidTaskState(from, 2);
    for (const to of nodes) {
      const next = {
        ...prior,
        stateVersion: 3,
        node: to,
        outcome: to === 'Deliver' ? ('COMPLETED' as const) : to === 'Incomplete' ? ('INCOMPLETE' as const) : undefined,
      };
      assert.ok(transitionCodes(prior, next).includes('TERMINAL_NODE_CANNOT_TRANSITION'), `${from} -> ${to} must stay refused`);
    }
  }
});

/* ------------------------------------------------------------------
 * Node-level row: a `request-info` proposal pauses the Investigate node
 * ------------------------------------------------------------------ */

const AGENT_BUDGET = { maxModelCalls: 4, maxActiveMs: 60_000, maxRepairs: 1, maxReplans: 1 };
// The one ask the fixture agent proposes. A record built from it is a replay; change it here and the
// replay tests stop being replays. Tests that assert the record's content spell it out literally
// instead — comparing against this const would make that round-trip assertion tautological.
const FIXTURE_QUESTION = { questionId: 'q-1', text: 'Which exception type should divide() raise for a zero denominator?' };

/** Owner-issued coder admission bound to the current state, as the route documents. */
function coderAdmission(statePort: MemoryStatePortV02): UC03CoderAdmissionResolver {
  return async (request): Promise<UC03CoderAdmission | undefined> => {
    const ownerAuthority = await statePort.readVerificationAuthoritySnapshot(request.task.taskId);
    if (!ownerAuthority) return undefined;
    const providerRequest = createTestProviderRequest({
      providerRequestId: `provider-coder-${request.task.taskId}-${request.state.stateVersion}`,
      taskId: request.task.taskId,
      runId: request.state.runId,
      role: 'coder',
      purpose: request.purpose,
      configId: ownerAuthority.policyIdentity.configId,
      pricingPolicyId: ownerAuthority.policyIdentity.policyId,
      contextDigest: coderContextDigest(request.task, request.state, request.purpose, request.evidence),
      reservationRef: `coder-allowance:${request.task.taskId}:${request.state.stateVersion}`,
    });
    const providerIdentity: ProviderPricingIdentityV02 = {
      providerId: providerRequest.providerId,
      modelId: providerRequest.modelId,
      configId: providerRequest.configId,
      configVersion: ownerAuthority.policyIdentity.configVersion,
      pricingPolicyId: providerRequest.pricingPolicyId,
      pricingPolicyVersion: ownerAuthority.policyIdentity.policyVersion,
      issuerKeyRef: ownerAuthority.policyIdentity.issuerKeyRef,
      decisionAuthorityGeneration: ownerAuthority.decisionAuthorityGeneration,
    };
    const providerAdmissionReceipt = createFixtureProviderAdmissionReceiptV02({
      providerRequestId: providerRequest.providerRequestId,
      role: 'coder',
      requestContentDigest: computeRequestContentDigest(providerRequest),
      providerId: providerIdentity.providerId,
      modelId: providerIdentity.modelId,
      configId: providerIdentity.configId,
      configVersion: providerIdentity.configVersion,
      decisionAuthorityGeneration: providerIdentity.decisionAuthorityGeneration,
    });
    const journal = statePort.getJournalSnapshot();
    const context = createTestProviderAdmissionContextV02({
      providerRequest,
      providerIdentity,
      providerAdmissionReceipt,
      taskId: request.task.taskId,
      runId: request.state.runId,
      runnableNode: 'Investigate',
      role: 'coder',
      expectedTaskStateVersion: request.state.stateVersion,
      expectedControlVersion: journal.controlVersion,
      expectedEpoch: journal.epoch,
      planApplicability: 'pre-plan-diagnostic',
      diagnosticPurpose: 'diagnose-zero-denominator',
      taskCriteriaDigest: computeCanonicalSha256(request.task.acceptanceCriteria),
      budgetRefs: [
        `task-tokens:${providerRequest.providerRequestId}`,
        `task-cost:${providerRequest.providerRequestId}`,
        `run-tokens:${providerRequest.providerRequestId}`,
        `run-cost:${providerRequest.providerRequestId}`,
      ],
    });
    // The shared fixture always seeds approved-plan fields; a pre-plan diagnostic forbids them.
    const prePlan = context as unknown as Record<string, unknown>;
    delete prePlan['planBindingDigest'];
    delete prePlan['planDecisionRef'];
    return { request: providerRequest, context, trustedContext: createTestProviderAdmissionTrustedContextV02(context) };
  };
}

function graphState(task: BugTask, state: TaskState): UC03GraphState {
  return {
    task,
    state,
    baseline: undefined,
    verificationResults: [],
    reviewResult: undefined,
    reviewRequest: undefined,
    patchAdmission: undefined,
    patchReceipt: undefined,
    failureEvidence: [],
    finalReport: undefined,
    reasons: [],
    terminalOutcome: undefined,
    milestones: [],
  };
}

/** A controlled route whose coder always asks for info, so the Investigate ask path is the only effect. */
async function requestInfoRoute(seedOverrides: Partial<TaskState> = {}) {
  const route = createPendingApprovalRoute('pending');
  const { task, statePort, ports } = route;
  const seeded = createGraphTaskState(task, { evidenceRefs: ['src/calculator.py'], ...seedOverrides });
  await seedGraphTaskState(statePort, seeded);

  const dispatches: string[] = [];
  const agent = createCoderAgent({
    propose: async (_state, _evidence, request) => {
      dispatches.push(request.providerRequestId);
      return {
        outcome: 'observed' as const,
        result: {
          proposal: {
            proposalId: 'prop-info-1',
            content: JSON.stringify({
              kind: 'request-info',
              proposalId: 'prop-info-1',
              questions: [FIXTURE_QUESTION],
              evidenceRefs: ['src/calculator.py'],
            }),
          },
          observedUsage: { inputTokens: 1, outputTokens: 1, costUsd: 0, billableTokens: 2 },
        },
      };
    },
    repository: route.repositoryPort,
    budget: AGENT_BUDGET,
  });

  const config: UC03GraphConfig = {
    mode: 'production',
    generation: { agent, budget: AGENT_BUDGET },
    trustedExpectedContext: route.config.trustedExpectedContext,
    coderAdmission: coderAdmission(statePort),
  };

  return { task, statePort, seeded, dispatches, agent, run: () => createInvestigateNode(ports, config)(graphState(task, seeded)) };
}

test('a request-info proposal at Investigate persists the bound record and pauses with exactly one dispatch', async () => {
  const { task, statePort, seeded, dispatches, agent, run } = await requestInfoRoute();

  const result = await run();

  assert.equal(result.terminalOutcome, 'needs-info', result.reasons?.join(' | '));
  assert.equal(result.state?.node, 'NeedsInfo');

  const record = result.state?.clarification;
  assert.ok(record, 'the bound record must be persisted');
  assert.equal(record.round, 1);
  assert.equal(record.askedAtStateVersion, seeded.stateVersion);
  assert.equal(record.questionId, computeClarificationQuestionId({ taskId: seeded.taskId, runId: seeded.runId, round: 1, questions: record.questions, evidenceRefs: record.evidenceRefs }));
  assert.equal(
    record.questionDigest,
    computeClarificationQuestionDigest({
      taskId: seeded.taskId,
      runId: seeded.runId,
      askedAtStateVersion: record.askedAtStateVersion,
      round: record.round,
      questionId: record.questionId,
      questions: record.questions,
      evidenceRefs: record.evidenceRefs,
    }),
  );
  assert.equal(record.answer, undefined, 'the question is open, not answered');
  assert.deepEqual(record.questions, [{ questionId: 'q-1', text: 'Which exception type should divide() raise for a zero denominator?' }]);

  // The persisted owner state is the same record the node returned.
  assert.deepEqual(await statePort.loadTask(task.taskId), result.state);

  assert.equal(dispatches.length, 1, 'exactly one model dispatch');
  assert.equal(agent.counters.modelCalls, 1);
});

test('an exhausted round budget stops the Investigate node as a typed refusal, not an escaping throw', async () => {
  // Round 3 is already answered, so the coder's ask would be round 4. The node must refuse *before*
  // the write: without that pre-check the producer's throw escapes the node and the graph runner
  // reports an unconfirmed owner transition instead of this reason.
  const probe = createGraphTaskState(createPendingApprovalRoute('pending').task);
  const usedRecord = createRecord(probe, CLARIFICATION_ROUND_CAP);
  const { dispatches, run } = await requestInfoRoute({ clarification: { ...usedRecord, answer: createAnswer(usedRecord, 7) } });

  const result = await run();

  assert.equal(result.terminalOutcome, 'INCOMPLETE');
  assert.match(result.reasons?.join(' | ') ?? '', /CLARIFICATION_ROUND_EXCEEDED/u);
  assert.equal(result.state?.clarification?.round, CLARIFICATION_ROUND_CAP, 'the used record is preserved, not rewritten');
  assert.equal(dispatches.length, 1, 'the model was still consulted once before the refusal');
});

test('a replayed ask on an already-answered record is refused and issues no state transition', async () => {
  // The record answers the coder's exact ask, which is what makes this a replay. This is an unreachable
  // state by construction — §8 writes the answer through NeedsInfo -> Investigate, so a real answered
  // record sits above version 1 with `answeredAtStateVersion` one past its ask. The replay check keys on
  // the ask's identity fields, so the branch under test is reached correctly; but do not read this
  // fixture as how an answered record comes to exist.
  // Node-level only: `run` invokes the node directly, so this proves the refusal, the unchanged record
  // and the single dispatch — never the graph edge. No task currently owns that graph-level witness.
  // The one dispatch already claimed the coder reservation before the refusal; the node itself writes
  // no record and no transition.
  const probe = createGraphTaskState(createPendingApprovalRoute('pending').task);
  const record = createRecord(probe, 1, [FIXTURE_QUESTION], ['src/calculator.py']);
  const { task, statePort, seeded, dispatches, run } = await requestInfoRoute({ clarification: { ...record, answer: createAnswer(record, probe.stateVersion) } });

  const result = await run();

  assert.equal(result.terminalOutcome, 'INCOMPLETE', 'an answered replay is a refusal, not a pause');
  assert.match(result.reasons?.join(' | ') ?? '', /no question is open to pause on/u);
  assert.equal(result.state?.node, 'Investigate');
  assert.deepEqual(result.state?.clarification, seeded.clarification, 'the answered record is carried unchanged');
  assert.equal(result.state?.stateVersion, seeded.stateVersion, 'the replay issues no owner write');
  assert.deepEqual(await statePort.loadTask(task.taskId), result.state);
  assert.equal(dispatches.length, 1, 'the model was still consulted once');
});

/* ------------------------------------------------------------------
 * Producer rows: `src/uc03/clarification.ts` is the only writer of the
 * record, so its own arithmetic is exercised here rather than assumed.
 * ------------------------------------------------------------------ */

/** The producer's port surface only; `transitionState` reloads through `loadTask`. */
function producerPort(initial: TaskState, seen?: TaskState[]): ClarificationPort & { current(): TaskState } {
  let stored: TaskState = initial;
  return {
    current: (): TaskState => stored,
    loadTask: async (): Promise<TaskState> => structuredClone(stored),
    transition: async (state: TaskState, expectedVersion: number): Promise<TaskState> => {
      assert.equal(stored.stateVersion, expectedVersion, 'the producer must name the version it read');
      stored = structuredClone(state);
      seen?.push(stored);
      return structuredClone(stored);
    },
  };
}

function requestInfoProposal(
  questions: readonly { readonly questionId: string; readonly text: string }[],
  evidenceRefs: readonly string[] = [BASELINE_REF],
): Extract<CoderProposal, { kind: 'request-info' }> {
  return { kind: 'request-info', proposalId: 'proposal-clarify-1', questions, evidenceRefs };
}

/** The record's questions, non-empty by contract, so every row indexes without a `!`. */
function askedQuestions(state: TaskState): readonly [ClarificationQuestion, ...ClarificationQuestion[]] {
  assert.ok(state.clarification, 'the write under test must persist a record');
  const [first, ...rest] = state.clarification.questions;
  assert.ok(first, 'a record asks at least one question');
  return [first, ...rest];
}

test('askClarification persists a round-1 record, bumps the version by one and carries its refs into evidenceRefs', async (): Promise<void> => {
  const prior = createValidTaskState('Investigate', 2);
  const writes: TaskState[] = [];
  const port = producerPort(prior, writes);
  const write = await askClarification({ statePort: port, prior, proposal: requestInfoProposal([createQuestion()]) });

  assert.equal(write.replayed, false);
  assert.equal(write.state.stateVersion, prior.stateVersion + 1, 'exactly one version step');
  assert.equal(write.state.node, 'NeedsInfo');
  assert.equal(write.state.clarification?.round, 1);
  assert.equal(write.state.clarification?.askedAtStateVersion, prior.stateVersion);
  assert.deepEqual(write.state.clarification?.evidenceRefs, [BASELINE_REF]);
  assert.ok(write.state.evidenceRefs.includes(BASELINE_REF), 'the ask write carries its own refs');
  assert.equal(writes.length, 1, 'one owner write, no double-write');
});

test('askClarification replay returns the prior state unchanged and issues no owner write', async (): Promise<void> => {
  const prior = createValidTaskState('Investigate', 2);
  const writes: TaskState[] = [];
  const port = producerPort(prior, writes);
  const first = await askClarification({ statePort: port, prior, proposal: requestInfoProposal([createQuestion()]) });

  const replay = await askClarification({ statePort: port, prior: first.state, proposal: requestInfoProposal([createQuestion()]) });
  assert.equal(replay.replayed, true);
  assert.equal(replay.state, first.state, 'a replay returns the very same reference, not a rewrite');
  assert.equal(writes.length, 1, 'a replay issues no second write');
});

test('askClarification refuses a fourth round before the port, and still replays the third', async (): Promise<void> => {
  const base = createValidTaskState('Investigate', 6);
  const third = createRecord(base, CLARIFICATION_ROUND_CAP);
  const prior: TaskState = { ...base, clarification: { ...third, answer: createAnswer(third, 7) } };
  const writes: TaskState[] = [];
  const port = producerPort(prior, writes);

  // A new ask is a fourth round. It must refuse here: if the cap only lived in the validator, the throw
  // would escape `createInvestigateNode` and be reported as an unconfirmed owner transition instead.
  await assert.rejects(askClarification({ statePort: port, prior, proposal: requestInfoProposal([createQuestion('a different ask')]) }), /CLARIFICATION_ROUND_EXCEEDED/u);
  assert.equal(writes.length, 0, 'a refused round issues no owner write');

  // At the cap but not a new round: the same ask replayed writes nothing and is not refused.
  const replay = await askClarification({ statePort: port, prior, proposal: requestInfoProposal([createQuestion()]) });
  assert.equal(replay.replayed, true);
  assert.equal(replay.state, prior);
  assert.equal(writes.length, 0);
});

test('recordClarificationAnswer: a partial answer is refused by the producer, not merely by the validator', async (): Promise<void> => {
  const prior = createValidTaskState('Investigate', 2);
  const port = producerPort(prior);
  const asked = await askClarification({
    statePort: port,
    prior,
    proposal: requestInfoProposal([createQuestion(), { questionId: 'sha256:' + 'e'.repeat(32), text: 'second question' }]),
  });

  // Mutation guard: the producer's own cover check must fire. If this is deleted, the partial answer
  // reaches `transitionState` and the failure surfaces as a validator error instead of this message.
  await assert.rejects(
    recordClarificationAnswer({ statePort: port, prior: asked.state, answer: { recorderRef: 'reporter-001', items: [askedQuestions(asked.state)[0]] } }),
    /CLARIFICATION_ANSWER_INCOMPLETE/u,
    'one item cannot answer two asked questions',
  );
  assert.deepEqual(port.current(), asked.state, 'a refused answer mutates nothing');
});

test('recordClarificationAnswer: a duplicated item is refused even for a single-question record', async (): Promise<void> => {
  const prior = createValidTaskState('Investigate', 2);
  const port = producerPort(prior);
  const asked = await askClarification({ statePort: port, prior, proposal: requestInfoProposal([createQuestion()]) });
  const [item] = askedQuestions(asked.state);

  await assert.rejects(
    recordClarificationAnswer({ statePort: port, prior: asked.state, answer: { recorderRef: 'reporter-001', items: [item, item] } }),
    /CLARIFICATION_ANSWER_INCOMPLETE/u,
    'the same question answered twice must not pass a one-question record',
  );
});

test('recordClarificationAnswer: a duplicate standing in for a missing question is refused (right length, wrong set)', async (): Promise<void> => {
  const prior = createValidTaskState('Investigate', 2);
  const port = producerPort(prior);
  const asked = await askClarification({
    statePort: port,
    prior,
    proposal: requestInfoProposal([createQuestion(), { questionId: 'sha256:' + 'e'.repeat(32), text: 'second question' }]),
  });
  const [first] = askedQuestions(asked.state);

  // This is the case a length-only check misses: two items for two questions, so `items.length` and
  // the asked-set size both agree, and only the distinct-id count exposes the missing question.
  await assert.rejects(
    recordClarificationAnswer({ statePort: port, prior: asked.state, answer: { recorderRef: 'reporter-001', items: [first, first] } }),
    /CLARIFICATION_ANSWER_INCOMPLETE/u,
    'a repeated item must not satisfy a two-question record by length alone',
  );
  assert.deepEqual(port.current(), asked.state, 'a refused answer mutates nothing');
});

test('recordClarificationAnswer persists the answer at Investigate and a replay is idempotent', async (): Promise<void> => {
  const prior = createValidTaskState('Investigate', 2);
  const writes: TaskState[] = [];
  const port = producerPort(prior, writes);
  const asked = await askClarification({ statePort: port, prior, proposal: requestInfoProposal([createQuestion()]) });

  const answer = { recorderRef: 'reporter-001', items: askedQuestions(asked.state) };
  const written = await recordClarificationAnswer({ statePort: port, prior: asked.state, answer });
  assert.equal(written.replayed, false);
  assert.equal(written.state.node, 'Investigate', 'the answer write is also the move back to Investigate');
  assert.equal(written.state.stateVersion, asked.state.stateVersion + 1);
  assert.equal(written.state.clarification?.answer?.answeredAtStateVersion, asked.state.stateVersion);

  const replay = await recordClarificationAnswer({ statePort: port, prior: written.state, answer });
  assert.equal(replay.replayed, true);
  assert.equal(replay.state, written.state, 'an identical answer returns the same reference');
  assert.equal(writes.length, 2, 'two real writes across ask + answer, none from the replay');
});

test('recordClarificationAnswer refuses a substituted answer on an already-answered record', async (): Promise<void> => {
  const prior = createValidTaskState('Investigate', 2);
  const port = producerPort(prior);
  const asked = await askClarification({ statePort: port, prior, proposal: requestInfoProposal([createQuestion()]) });
  const answered = await recordClarificationAnswer({
    statePort: port,
    prior: asked.state,
    answer: { recorderRef: 'reporter-001', items: askedQuestions(asked.state) },
  });

  await assert.rejects(
    recordClarificationAnswer({
      statePort: port,
      prior: answered.state,
      answer: { recorderRef: 'reporter-001', items: [{ questionId: askedQuestions(asked.state)[0].questionId, text: 'a different answer' }] },
    }),
    /CLARIFICATION_ANSWER_SUBSTITUTED/u,
    'changing the reporter text must not overwrite the stored answer',
  );
});
