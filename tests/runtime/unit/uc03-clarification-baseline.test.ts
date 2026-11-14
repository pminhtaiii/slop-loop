import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareControlledUC03Host } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { runControlledUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import { askClarification, recordClarificationAnswer } from '../../../src/uc03/clarification.ts';
import { controlledGeneratedPlanFixture } from '../support/uc03/controlled-host-journey.ts';

test('the direct controlled resume retains its reproduced baseline so a later round pauses', async () => {
  // The scripted first response is a second, distinct ask: the resumed turn spends it after the
  // fallback reproduces the baseline, so the round-2 ask must find retained evidence.
  const fixture = await controlledGeneratedPlanFixture({
    firstResponse: {
      proposalId: 'fallback-ask-2',
      content: JSON.stringify({ kind: 'request-info', proposalId: 'fallback-ask-2', questions: [{ questionId: 'q-guard', text: 'Which error type should an unguarded denominator raise?' }], evidenceRefs: [] }),
    },
  });
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;
  const seeded = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(seeded);
  const open = await askClarification({
    statePort: fixture.statePort,
    prior: seeded,
    proposal: { kind: 'request-info', proposalId: 'fallback-ask-1', questions: [{ questionId: 'q-denominator', text: 'What should a zero denominator do?' }], evidenceRefs: [] },
  });
  assert.ok(open.state.clarification);
  const answered = await recordClarificationAnswer({
    statePort: fixture.statePort,
    prior: open.state,
    answer: { recorderRef: 'reporter-1', items: open.state.clarification.questions.map(question => ({ questionId: question.questionId, text: 'raise a guarded error' })) },
  });
  assert.equal(answered.state.node, 'Investigate');

  const resumed = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  assert.equal(resumed.outcome, 'needs-info', JSON.stringify(resumed.reasons));
  const state = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.equal(state?.node, 'NeedsInfo');
  assert.equal(state?.clarification?.round, 2);
  assert.equal(state?.clarification?.answer, undefined);
});
