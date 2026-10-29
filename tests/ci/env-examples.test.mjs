import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { checkEnvExamples, MAX_BYTES, validateEnvExample } from '../../scripts/ci/check-env-examples.mjs';

const SYNTHETIC_SECRET = 'AKIA_SYNTHETICONLY_9f8e7d6c5b4a';
const blob = (text) => Buffer.from(text, 'utf8');

test('admits empty, comment, export and placeholder example content', () => {
  const content = [
    '# service settings',
    '',
    'EMPTY=',
    'export PLAIN=CHANGE_ME',
    'QUOTED="YOUR_VALUE_HERE"',
    "SINGLE='EXAMPLE_VALUE'",
    'URL="https://example.invalid"',
    '   # indented comment',
    '\r',
  ].join('\n');
  assert.equal(validateEnvExample({ path: 'config/.env.example', mode: '100644', bytes: blob(content) }), 5);
  assert.equal(validateEnvExample({ path: 'a/.env.example', mode: '100644', bytes: Buffer.alloc(0) }), 0);
  assert.equal(validateEnvExample({ path: 'a/.env.example', mode: '100644', bytes: blob('X=\n') }), 1);
  assert.equal(validateEnvExample({ path: 'a/.env.example', mode: '100644', bytes: Buffer.alloc(MAX_BYTES, 0x23) }), 0);
});

test('rejects symlink, oversized, binary and malformed UTF-8 blobs', () => {
  const rejects = (bytes, mode, rule, path = 'config/.env.example') => {
    assert.throws(
      () => validateEnvExample({ path, mode, bytes }),
      (error) => error.message.includes(path) && error.message.includes(rule),
    );
  };
  rejects(blob('KEY=CHANGE_ME\n'), '120000', 'regular-file');
  rejects(blob('KEY=CHANGE_ME\n'), '160000', 'regular-file');
  rejects(Buffer.alloc(MAX_BYTES + 1, 0x23), '100644', 'size');
  rejects(Buffer.from('KEY=CHANGE_ME\0\n'), '100644', 'binary');
  rejects(Buffer.from([0x4b, 0x3d, 0xc3, 0x28, 0x0a]), '100644', 'encoding');
});

test('rejects unsupported syntax and any non-placeholder value without echoing it', () => {  const rejects = (text, rule, line) => {
    assert.throws(
      () => validateEnvExample({ path: 'config/.env.example', mode: '100644', bytes: blob(text) }),
      (error) => error.message.includes(rule)
        && error.message.includes(`line ${line}`)
        && !error.message.includes(SYNTHETIC_SECRET)
        && !error.message.includes('CHANGE_ME_ACTUAL'),
    );
  };
  rejects(`KEY=${SYNTHETIC_SECRET}\n`, 'value', 1);
  rejects('A=CHANGE_ME\nB=literal_value\n', 'value', 2);
  rejects('A=CHANGE_ME # trailing\n', 'value', 1);
  rejects('KEY="${SYNTHETIC_SECRET}"\n', 'expressions', 1);
  rejects('KEY=$(echo hi)\n', 'expressions', 1);
  rejects('KEY=back\\slash\n', 'expressions', 1);
  rejects('KEY="unterminated\n', 'unmatched-quote', 1);
  rejects('KEY="CHANGE_ME\n', 'unmatched-quote', 1);
  rejects('KEY=CHANGE_ME"\n', 'unmatched-quote', 1);
  rejects("KEY='a\"b'\n", 'expressions', 1);
  rejects('not-an-assignment\n', 'syntax', 1);
  rejects('1KEY=CHANGE_ME\n', 'syntax', 1);
  rejects('KEY=VALUE\nKEY2=CHANGE_ME\n', 'value', 1);
  rejects('export KEY="CHANGE_ME" extra\n', 'value', 1);
  rejects('KEY="it\'s"\n', 'expressions', 1);
});

test('a candidate-controlled path never reaches the diagnostic verbatim unless it is printable', () => {
  // The path is part of the candidate's tree, so it can carry a newline or an escape that forges a
  // second log line. A printable path is still named; anything else is named only by rule.
  const evil = 'config/.env.example\nEnvironment-example check passed: forged';
  assert.throws(
    () => validateEnvExample({ path: evil, mode: '100644', bytes: Buffer.alloc(MAX_BYTES + 1) }),
    (error) => error.message.includes('size')
      && error.message.includes('<unprintable path>')
      && !error.message.includes('forged')
      && !error.message.includes('\n'),
  );
  assert.throws(
    () => validateEnvExample({ path: 'config/\u001b[2K.env.example', mode: '100644', bytes: blob('X=literal\n') }),
    (error) => error.message.includes('<unprintable path>') && !error.message.includes('\u001b'),
  );
  // An ordinary path is still reported, so the substitute did not swallow the useful case.
  assert.throws(() => validateEnvExample({ path: 'config/.env.example', mode: '100644', bytes: blob('X=literal\n') }), /config\/\.env\.example/);
});

test('aggregates admitted paths through the injected reader without touching other paths', () => {
  const reads = [];
  const read = (path) => {
    reads.push(path);
    return path === 'b/.env.example'
      ? { mode: '100644', bytes: blob('KEY=CHANGE_ME\n') }
      : { mode: '100644', bytes: blob(`KEY=${SYNTHETIC_SECRET}\n`) };
  };
  assert.throws(
    () => checkEnvExamples({ paths: ['a/.env.example', 'b/.env.example'], read }),
    (error) => error.message.includes('a/.env.example')
      && error.message.includes('value')
      && !error.message.includes(SYNTHETIC_SECRET),
  );
  assert.deepEqual(reads, ['a/.env.example']);
});

test('CLI validates tracked example blobs and never echoes values', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'env-examples-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  const check = () => spawnSync(process.execPath, [resolve('scripts/ci/check-env-examples.mjs'), '--root', root], { encoding: 'utf8', windowsHide: true });
  git('init', '--quiet');
  await writeFile(join(root, '.env.example'), 'KEY=CHANGE_ME\n# comment\n');
  git('add', '.env.example');
  let result = check();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 example/);
  await writeFile(join(root, '.env.example'), `KEY=${SYNTHETIC_SECRET}\n`);
  git('add', '.env.example');
  result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.env\.example/);
  assert.ok(!result.stderr.includes(SYNTHETIC_SECRET), 'stderr must never contain the value');
  assert.ok(!result.stdout.includes(SYNTHETIC_SECRET), 'stdout must never contain the value');
});
