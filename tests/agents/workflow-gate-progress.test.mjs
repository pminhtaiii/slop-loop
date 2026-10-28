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
});

test('outside absolute file paths from POSIX, Windows drives, and UNC roots emit only the basename', () => {
  const files = [
    '/outside/fixture.test.mjs',
    'C:\\outside\\fixture.test.mjs',
    '\\\\server\\share\\outside\\fixture.test.mjs',
  ];

  for (const file of files) {
    const parser = createGateProgressParser();
    const line = gateTestProgressLine('test:start', 'path test', file, process.cwd());
    const events = [...parser.write(Buffer.from(line)), ...parser.end()];
    assert.equal(events.length, 1);
    assert.equal(events[0].currentFile, 'fixture.test.mjs');
  }

  const relativeLine = gateTestProgressLine('test:start', 'nested relative path', 'tests/agents/nested/fixture.test.mjs', process.cwd());
  const relativeParser = createGateProgressParser();
  const relativeEvents = [...relativeParser.write(Buffer.from(relativeLine)), ...relativeParser.end()];
  assert.equal(relativeEvents[0].currentFile, 'tests/agents/nested/fixture.test.mjs');
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
