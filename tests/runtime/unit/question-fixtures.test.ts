import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { createQuestionRepositoryFixture, type CreateQuestionRepositoryFixtureOptions } from '../support/questions/fixtures.ts';
import { ScriptedQuestionModelError, ScriptedQuestionModelPort } from '../support/questions/scripted-model.ts';
import type { QuestionModelResponseV1 } from '../../../src/contracts/questions/contracts.ts';

test('small question fixture is deterministic and isolated from the host workspace', async t => {
  const fixture = await createQuestionRepositoryFixture({ band: 'small', seed: 'fixture-v1' });
  t.after(() => fixture.dispose());

  const workspacePath = resolve(process.cwd());
  const targetPath = resolve(fixture.root);
  const pathFromWorkspace = relative(workspacePath, targetPath);

  assert.equal(fixture.lineCount, 1_000);
  assert.ok(pathFromWorkspace === '..' || pathFromWorkspace.startsWith(`..${sep}`) || isAbsolute(pathFromWorkspace));
  assert.match(fixture.digest, /^[a-f0-9]{64}$/);
});

test('all size bands include the same late definition, three-file flow and public target materials', async t => {
  const bands = [
    { band: 'small' as const, lineCount: 1_000 },
    { band: 'medium' as const, lineCount: 10_000 },
    { band: 'large' as const, lineCount: 30_000 },
  ];
  const fixtures = await Promise.all(bands.map(({ band }) => createQuestionRepositoryFixture({ band, seed: 'all-bands-v1' })));
  t.after(async () => Promise.all(fixtures.map(fixture => fixture.dispose())));

  assert.equal(new Set(fixtures.map(fixture => fixture.root)).size, bands.length);
  for (const [index, fixture] of fixtures.entries()) {
    assert.equal(fixture.lineCount, bands[index]?.lineCount);
    const pathFromWorkspace = relative(resolve(process.cwd()), resolve(fixture.root));
    assert.ok(pathFromWorkspace === '..' || pathFromWorkspace.startsWith(`..${sep}`) || isAbsolute(pathFromWorkspace));
    const filePaths = new Set(fixture.files.map(file => file.path));
    assert.ok(filePaths.has('docs/architecture.md'));
    assert.ok(filePaths.has('pyproject.toml'));
    assert.ok(filePaths.has('tests/test_orders.py'));
    assert.ok(filePaths.has('tests/fixtures/public_canary.py'));
    assert.ok(filePaths.has('tests/fixtures/execution_probe.py'));

    const api = await readFile(join(fixture.root, 'src/orders/api.py'), 'utf8');
    const validation = await readFile(join(fixture.root, 'src/orders/validation.py'), 'utf8');
    const store = await readFile(join(fixture.root, 'src/orders/store.py'), 'utf8');
    const docs = await readFile(join(fixture.root, 'docs/architecture.md'), 'utf8');
    const config = await readFile(join(fixture.root, 'pyproject.toml'), 'utf8');
    const tests = await readFile(join(fixture.root, 'tests/test_orders.py'), 'utf8');
    const lateDefinition = await readFile(join(fixture.root, 'src/late_definition.py'), 'utf8');

    assert.match(api, /normalize_order/);
    assert.match(api, /append_order/);
    assert.match(validation, /payload\.get\("items"\)/);
    assert.match(validation, /"status": "pending"/);
    assert.match(store, /ORDERS\.append\(record\)/);
    assert.match(store, /return record\["id"\]/);
    assert.match(docs, /submit_order/);
    assert.match(config, /testpaths = \["tests"\]/);
    assert.match(tests, /submit_order/);
    assert.ok(lateDefinition.split('\n').findIndex(line => line.startsWith('def retry_window_seconds')) > 200);
    const [canary] = fixture.canaries;
    assert.ok(canary);
    assert.ok((await readFile(join(fixture.root, canary.path), 'utf8')).includes(canary.value));
    assert.equal(existsSync(join(fixture.root, 'tests/fixtures/python-executed')), false);
  }
});

test('fixture digest is stable for the same seed while target roots stay distinct', async t => {
  const first = await createQuestionRepositoryFixture({ band: 'small', seed: 'repeatable-v1' });
  const second = await createQuestionRepositoryFixture({ band: 'small', seed: 'repeatable-v1' });
  t.after(async () => Promise.all([first.dispose(), second.dispose()]));

  assert.notEqual(first.root, second.root);
  assert.equal(first.digest, second.digest);
  assert.equal(first.seedDigest, second.seedDigest);
  assert.deepEqual(first.canaries, second.canaries);
});

test('fixture seeds change synthetic canaries and content digests', async t => {
  const first = await createQuestionRepositoryFixture({ band: 'small', seed: 'seed-one' });
  const second = await createQuestionRepositoryFixture({ band: 'small', seed: 'seed-two' });
  t.after(async () => Promise.all([first.dispose(), second.dispose()]));

  assert.notEqual(first.digest, second.digest);
  assert.notDeepEqual(first.canaries, second.canaries);
});

test('fixture options reject evaluator judging data before creating a target', async () => {
  const options = { band: 'small', rubric: { expectedFacts: ['secret answer'] } } as unknown as CreateQuestionRepositoryFixtureOptions;
  await assert.rejects(createQuestionRepositoryFixture(options), /judging data is not fixture input/);
});

test('scripted model returns the injected decision and usage sequence in order', async () => {
  const scripted: readonly QuestionModelResponseV1[] = [
    {
      decision: { kind: 'list', path: 'src' },
      usage: { status: 'complete', inputTokens: 11, outputTokens: 4 },
    },
    {
      decision: { kind: 'clarify', question: 'Which retry?', explanation: 'Two retry paths exist.', unresolvedReferents: ['retry'] },
      usage: { status: 'unknown', reasonCode: 'timeout' },
    },
  ];
  const model = new ScriptedQuestionModelPort(scripted);
  const signal = new AbortController().signal;

  const first = await model.decide({ userQuestion: 'raw question marker' }, { providerCredential: 'raw credential marker' }, signal);
  assert.deepEqual(first, scripted[0]);
  assert.notStrictEqual(first, scripted[0]);
  assert.equal(model.consumedSteps, 1);

  const second = await model.decide({ userQuestion: 'follow-up marker' }, { reservation: 'opaque' }, signal);
  assert.deepEqual(second, scripted[1]);
  assert.equal(model.consumedSteps, 2);
  assert.equal(model.remainingSteps, 0);
});

test('scripted model refuses exhausted sequences instead of inventing a fallback decision', async () => {
  const model = new ScriptedQuestionModelPort([]);

  await assert.rejects(model.decide({}, {}, new AbortController().signal), /scripted question model sequence exhausted/i);
  assert.equal(model.consumedSteps, 0);
});

test('scripted model does not consume a decision after cancellation', async () => {
  const model = new ScriptedQuestionModelPort([{ decision: { kind: 'insufficient', explanation: 'No evidence was supplied.' }, usage: { status: 'missing' } }]);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(model.decide({}, {}, controller.signal), /scripted question model call cancelled/i);
  assert.equal(model.consumedSteps, 0);
  assert.equal(model.remainingSteps, 1);
});

test('scripted failures consume one step and never retry automatically', async () => {
  const model = new ScriptedQuestionModelPort([
    { kind: 'failure', reasonCode: 'timeout' },
    { decision: { kind: 'insufficient', explanation: 'The scripted answer is insufficient.' }, usage: { status: 'missing' } },
  ]);

  await assert.rejects(model.decide({}, {}, new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof ScriptedQuestionModelError);
    assert.equal(error.reasonCode, 'timeout');
    return true;
  });
  assert.equal(model.consumedSteps, 1);
  assert.equal((await model.decide({}, {}, new AbortController().signal)).usage.status, 'missing');
  assert.equal(model.consumedSteps, 2);
});
