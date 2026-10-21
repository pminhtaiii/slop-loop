import assert from 'node:assert/strict';
import test from 'node:test';
import { ESLint } from 'eslint';

test('repository lint config covers tooling and CI tests without applying TypeScript rules to JavaScript', async () => {
  const eslint = new ESLint();

  for (const file of [
    'scripts/agents/active-task.mjs',
    'scripts/ci/check-context.mjs',
    'tests/agents/active-task.test.mjs',
    'tests/ci/check-context.test.mjs',
  ]) {
    const config = await eslint.calculateConfigForFile(file);

    assert.ok(config, `${file} should be included in the lint config`);
    assert.equal(config.rules['no-unused-vars'][0], 2, `${file} should check unused variables`);
    assert.equal(config.rules['no-undef'][0], 2, `${file} should check unresolved names`);
    assert.equal(config.rules['@typescript-eslint/no-explicit-any'], undefined, `${file} should not receive TypeScript-only rules`);
  }
});
