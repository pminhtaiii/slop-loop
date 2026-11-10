import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkProgressFormat } from '../../scripts/ci/check-progress-format.mjs';

const ledger = `# Implementation Status

Observed evidence only.

## Status meanings

| Status | Meaning |
|---|---|
| \`NOT_STARTED\` | Not begun |
| \`IN_PROGRESS\` | Active |
| \`BLOCKED\` | Blocked |
| \`IMPLEMENTED_UNVERIFIED\` | Checks pending |
| \`VERIFIED\` | Checks passed |

## Repository observations

Inspected on 2026-11-09.

| Area | Status | Implementation / inspected paths | Verification evidence | Inspected revision |
|---|---|---|---|---|
| Helpers | \`IMPLEMENTED_UNVERIFIED\` | scripts/agents/ | Old evidence | abc1234 |
`;

test('accepts the documented format with LF, CRLF, and escaped content pipes', () => {
  for (const source of [ledger, ledger.replaceAll('\n', '\r\n'), ledger.replace('Old evidence', 'a \\| b')]) assert.deepEqual(checkProgressFormat(source), []);
});

test('rejects structural drift with line-addressed diagnostics', () => {
  for (const [source, message] of [
    [ledger.replace('## Status meanings', '## Status'), /headings/],
    [ledger.replace('| Old evidence |', '| evidence | extra |'), /5 nonempty cells/],
    [ledger.replace('`IMPLEMENTED_UNVERIFIED` | scripts', 'VERIFIED | scripts'), /backtick-wrapped status/],
    [ledger.replace('`IMPLEMENTED_UNVERIFIED` | scripts', '`DONE` | scripts'), /backtick-wrapped status/],
    [ledger.replace('| Old evidence |', '|  |'), /nonempty/],
    [ledger.replace('Inspected revision', 'Revision'), /table header/],
    [ledger.replace('|---|---|---|---|---|', '|--|---|---|---|---|'), /separator/],
    [ledger + ledger.split('\n').at(-2) + '\n', /Duplicate area/],
    [ledger.replace('| `BLOCKED` | Blocked |\n', ''), /Missing status definition/],
    [ledger.replace('Observed evidence only.', 'Observed evidence only.  '), /trailing whitespace/],
    [ledger.trimEnd(), /newline/],
    [ledger + '\n| Area | Status | Implementation / inspected paths | Verification evidence | Inspected revision |\n|---|---|---|---|---|\n', /exactly one table/],
  ]) {
    const errors = checkProgressFormat(source);
    assert.ok(
      errors.some(error => message.test(error)),
      errors.join('\n'),
    );
    assert.ok(errors.every(error => /^context\/progress_checker.md:\d+: /.test(error)));
  }
});

test('CLI is read-only and fails on malformed ledger or invalid arguments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'progress-format-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'context'));
  const path = join(root, 'context/progress_checker.md');
  const cli = fileURLToPath(new URL('../../scripts/ci/check-progress-format.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true });
  await writeFile(path, ledger);
  assert.equal(run(['--root', root]).status, 0);
  const broken = ledger.replace('| Old evidence |', '| |');
  await writeFile(path, broken);
  const result = run(['--root', root]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nonempty/);
  assert.equal(await readFile(path, 'utf8'), broken);
  assert.equal(run(['--write']).status, 1);
});
