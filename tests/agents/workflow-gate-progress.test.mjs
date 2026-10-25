import assert from 'node:assert/strict';
import test from 'node:test';
import { createGateProgressParser, gateTestProgressLine, MAX_TEST_LABEL_LENGTH, PROGRESS_PREFIX } from '../../scripts/agents/workflow-gate-progress.mjs';

test('progress parser handles split UTF-8 chunks and bounded safe labels', () => {
  const line = gateTestProgressLine('test:start', `safe\nname \u001b[31mred\u001b[0m\0 ${'😀'.repeat(120)}`, 'C:\\outside\\fixture.test.mjs', 'C:\\repo');
  assert.ok(line.startsWith(PROGRESS_PREFIX));
  const bytes = Buffer.from(line);
  const parser = createGateProgressParser();
  const events = [
    ...parser.write(bytes.subarray(0, 19)),
    ...parser.write(bytes.subarray(19, 47)),
    ...parser.write(bytes.subarray(47)),
    ...parser.end(),
  ];
  assert.equal(events.length, 1);
  assert.equal(events[0].testEvent, 'test:start');
  assert.ok(events[0].currentTest.length <= MAX_TEST_LABEL_LENGTH);
  // This control-character range is the behavior safeLabel promises to remove.
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(events[0].currentTest, /[\r\n\x00-\x1f\x7f]/);
  assert.equal(events[0].currentFile, 'fixture.test.mjs');
  if (process.platform === 'win32') {
    const crossDrive = createGateProgressParser();
    const crossDriveLine = gateTestProgressLine('test:start', 'cross drive', 'D:\\private\\fixture.test.mjs', 'C:\\repo');
    assert.equal(crossDrive.write(Buffer.from(crossDriveLine))[0].currentFile, 'fixture.test.mjs');
  }
});

test('malformed, oversized, unrelated, and unsupported progress lines are ignored', () => {
  const parser = createGateProgressParser();
  const input = [
    'ordinary stderr\n',
    `${PROGRESS_PREFIX}{broken json}\n`,
    `${PROGRESS_PREFIX}${JSON.stringify({ type: 'test:stdout', test: 'not a test result', file: 'x' })}\n`,
    `${PROGRESS_PREFIX}${'x'.repeat(5000)}\n`,
    gateTestProgressLine('test:fail', 'failure name', 'tests/fail.test.mjs'),
  ].join('');
  const events = [...parser.write(Buffer.from(input)), ...parser.end()];
  assert.deepEqual(events, [{ testEvent: 'test:fail', currentTest: 'failure name', currentFile: 'tests/fail.test.mjs' }]);
});
