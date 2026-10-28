import assert from 'node:assert/strict';
import test from 'node:test';
import { receiveBugTask } from '../../../src/uc03/input.ts';
import { createFixtureBugTask } from '../support/uc03/port-fixtures.ts';
test('C01 direct intake accepts a complete explicit bug task without execution', () => {
  const task = createFixtureBugTask();
  const before = structuredClone(task);
  const result = receiveBugTask({ task });
  assert.equal(result.status, 'accepted');
  if (result.status === 'accepted') assert.deepEqual(result.task, before);
  assert.deepEqual(task, before);
});
test('C02 missing reproduction and criteria request information without manufacturing a task', () => {
  const task = { ...createFixtureBugTask(), reproduction: '', acceptanceCriteria: [] };
  const before = structuredClone(task);
  const result = receiveBugTask({ task });
  assert.deepEqual(result, { status: 'needs-info', fields: ['reproduction', 'acceptanceCriteria'], questionIds: [] });
  assert.equal('task' in result, false);
  assert.deepEqual(task, before);
});
test('C02 material ambiguity requires later confirmation without reflecting question text', () => {
  const result = receiveBugTask({ task: createFixtureBugTask(), materialAmbiguities: ['Confirm intended behavior'] });
  assert.deepEqual(result, { status: 'needs-info', fields: ['materialAmbiguities'], questionIds: [] });
  assert.equal('task' in result, false);
});

for (const field of ['repositoryId', 'expectedBehavior', 'goal', 'limits', 'budgetLimits', 'requiredChecks', 'constraints', 'configId', 'configVersion']) {
  test('C02 missing ' + field + ' requests explicit caller information', () => {
    const task = Object.fromEntries(Object.entries(createFixtureBugTask()).filter(([key]) => key !== field));
    const result = receiveBugTask({ task });
    assert.equal(result.status, 'needs-info');
    if (result.status === 'needs-info') assert.ok(result.fields.includes(field));
    assert.equal('task' in result, false);
  });
}

test('C01 accepted task is detached from later caller mutation at every nested boundary', () => {
  const task = structuredClone(createFixtureBugTask());
  const result = receiveBugTask({ task });
  assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted') assert.fail('Complete task must be accepted');
  const before = structuredClone(result.task);
  Object.assign(task.limits, { timeoutMs: 1 });
  Object.assign(task.budgetLimits, { maxTokens: 0 });
  Object.assign(task.acceptanceCriteria, { 0: 'Different criteria' });
  Object.assign(task.constraints, { 0: 'Different constraints' });
  Object.assign(task.requiredChecks[0]?.argv ?? [], { 0: 'different-argument' });
  assert.deepEqual(result.task, before);
});

test('C02 malformed supplied values outrank missing fields and never become a task', () => {
  const task = { ...createFixtureBugTask(), reproduction: '', expectedBehavior: 42 };
  const result = receiveBugTask({ task });
  assert.deepEqual(result, { status: 'invalid-input', reasonCode: 'invalid-task', path: 'expectedBehavior' });
  assert.equal('task' in result, false);
});

test('C16 unrecognized caller keys cannot leak protected data through diagnostics', () => {
  const task = { ...createFixtureBugTask(), 'PRIVATE-SECRET-MARKER': 'sensitive caller value' };
  const result = receiveBugTask({ task });
  assert.deepEqual(result, { status: 'invalid-input', reasonCode: 'invalid-task', path: 'task' });
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('C16 accessor input is refused without invoking its getter', () => {
  let effects = 0;
  const task = Object.defineProperty({}, 'reproduction', { enumerable: true, get() { effects++; return 'secret'; } });
  assert.equal(receiveBugTask({ task }).status, 'invalid-input');
  assert.equal(effects, 0);
});

for (const [name, task] of [
  ['prototype', Object.create({ reproduction: 'inherited' }) as unknown],
  ['cycle', (() => { const value: Record<string, unknown> = {}; value['self'] = value; return value; })()],
  ['sparse', { ...createFixtureBugTask(), acceptanceCriteria: new Array(2) }],
  ['deep', (() => { let value: unknown = 'leaf'; for (let i = 0; i < 34; i++) value = { nested: value }; return value; })()],
  ['oversized', { ...createFixtureBugTask(), observedBehavior: 'x'.repeat(1048577) }],
  ['too-many-values', { ...createFixtureBugTask(), constraints: Array.from({ length: 20001 }, () => 'constraint') }],
] as const) {
  test('C16 ' + name + ' input is refused with bounded data-only diagnostics', () => {
    assert.deepEqual(receiveBugTask({ task }), { status: 'invalid-input', reasonCode: 'invalid-envelope', path: 'input' });
  });
}

test('C02 invalid finite limits are refused instead of receiving execution defaults', () => {
  const task = createFixtureBugTask();
  assert.equal(receiveBugTask({ task: { ...task, limits: { ...task.limits, timeoutMs: 0 } } }).status, 'invalid-input');
});

test('C02 malformed ambiguity and unknown envelope fields are refused', () => {
  const task = createFixtureBugTask();
  assert.equal(receiveBugTask({ task, materialAmbiguities: [''] }).status, 'invalid-input');
  assert.equal(receiveBugTask({ task, approve: true }).status, 'invalid-input');
});

test('C16 nested Proxy is refused before any introspection trap runs', () => {
  let effects = 0;
  const task = createFixtureBugTask();
  const constraints = new Proxy([...task.constraints], {
    getPrototypeOf(target) { effects++; return Reflect.getPrototypeOf(target); },
    ownKeys(target) { effects++; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { effects++; return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  const result = receiveBugTask({ task: { ...task, constraints } });
  assert.deepEqual({ status: result.status, effects }, { status: 'invalid-input', effects: 0 });
  assert.equal('task' in result, false);
});
