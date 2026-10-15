import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = `Usage:
  node scripts/ci/active-task.mjs start --owner <id> --task <id> --summary <text> --next <text>
  node scripts/ci/active-task.mjs update --owner <id> --task <id> [--next <text>] [--verification <text>] [--status active|blocked]
  node scripts/ci/active-task.mjs finish --owner <id> --task <id> --result <text>
  node scripts/ci/active-task.mjs clear --owner <id> --task <id>

All commands accept --root <checkout>. Use a unique owner per session/worker.
finish retains the result for review; clear removes only that completed entry.
A busy lock is not automatically reclaimed. The permanent template is preserved.`;

function parseArguments(args) {
  const [command, ...options] = args;
  const fields = {
    start: ['summary', 'next'], update: ['next', 'verification', 'status'],
    finish: ['result'], clear: [],
  };
  if (!Object.hasOwn(fields, command)) throw new Error(usage);
  const values = {};
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index].slice(2);
    const value = options[index + 1];
    if (!options[index].startsWith('--') || !['root', 'owner', 'task', ...fields[command]].includes(name) || Object.hasOwn(values, name) || !value?.trim() || value.startsWith('--')) {
      throw new Error(`Invalid or duplicate option: ${options[index]}\n${usage}`);
    }
    values[name] = value;
  }
  for (const name of ['owner', 'task']) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(values[name] ?? '')) throw new Error(`A valid --${name} ID is required.`);
  }
  for (const name of command === 'start' ? ['summary', 'next'] : command === 'finish' ? ['result'] : []) {
    if (!values[name]) throw new Error(`--${name} is required.`);
  }
  if (command === 'update' && !fields.update.some((name) => values[name])) throw new Error('update requires progress, verification, or status.');
  if (values.status && !['active', 'blocked'].includes(values.status)) throw new Error('Status must be active or blocked.');
  return { command, values };
}

function managedEntries(source) {
  const starts = source.split('<!-- active-task:start -->').length - 1;
  const ends = source.split('<!-- active-task:end -->').length - 1;
  const block = source.match(/(<!-- active-task:start -->\r?\n```json\r?\n)([\s\S]*?)(\r?\n```\r?\n<!-- active-task:end -->)/);
  if (starts !== 1 || ends !== 1 || !block) throw new Error('Active-task markers are damaged; file left unchanged.');
  const entries = JSON.parse(block[2]);
  const keys = new Set();
  if (!Array.isArray(entries)) throw new Error('Active-task data must be an array.');
  for (const entry of entries) {
    if (!entry || typeof entry.owner !== 'string' || typeof entry.task !== 'string' || typeof entry.summary !== 'string' || typeof entry.next !== 'string' || !['active', 'blocked', 'completed'].includes(entry.status)) {
      throw new Error('Invalid active-task entry; file left unchanged.');
    }
    const key = JSON.stringify([entry.owner, entry.task]);
    if (keys.has(key)) throw new Error('Duplicate active-task ownership; file left unchanged.');
    keys.add(key);
  }
  return { block, entries };
}

async function run(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return console.log(usage);
  const { command, values } = parseArguments(args);
  const root = await realpath(resolve(values.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..')));
  const directory = resolve(root, 'context');
  if (!(await lstat(directory)).isDirectory()) throw new Error('context must be a regular directory, not a link.');
  const path = resolve(directory, 'active_task.md');
  const lockPath = resolve(directory, '.active-task.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Active-task file is busy; retry after the other writer finishes. Do not reclaim the lock automatically.');
    throw error;
  }
  const lockIdentity = await lock.stat();
  let temporary;
  try {
    const original = await lstat(path);
    if (!original.isFile() || original.isSymbolicLink()) throw new Error('active_task.md must be a regular file, not a link.');
    const source = await readFile(path, 'utf8');
    const { block, entries } = managedEntries(source);
    const index = entries.findIndex((entry) => entry.owner === values.owner && entry.task === values.task);
    if (command === 'start') {
      if (index !== -1) throw new Error('Entry already exists; use update or finish instead of overwriting it.');
      entries.push({ owner: values.owner, task: values.task, summary: values.summary, next: values.next, status: 'active', verification: '', updatedAt: new Date().toISOString() });
    } else {
      if (index === -1) throw new Error('No entry matches that owner and task.');
      const entry = entries[index];
      if (command === 'clear') {
        if (entry.status !== 'completed') throw new Error('Only completed entries can be cleared; retain active or blocked work.');
        entries.splice(index, 1);
      } else {
        if (entry.status === 'completed') throw new Error('Completed entries are retained for review; clear before starting again.');
        for (const field of ['next', 'verification', 'status']) if (values[field]) entry[field] = values[field];
        if (command === 'finish') Object.assign(entry, { status: 'completed', result: values.result, next: 'Coordinator review and evidence recording' });
        entry.updatedAt = new Date().toISOString();
      }
    }
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const content = source.slice(0, block.index) + block[1] + JSON.stringify(entries, null, 2).replace(/\n/g, newline) + block[3] + source.slice(block.index + block[0].length);
    const tempPath = resolve(directory, `.active-task-${randomUUID()}.tmp`);
    const output = await open(tempPath, 'wx', original.mode & 0o777);
    temporary = tempPath;
    try {
      await output.writeFile(content, 'utf8');
      await output.sync();
    } finally {
      await output.close();
    }
    await rename(tempPath, path);
    temporary = undefined;
    console.log(`${command}: ${values.owner}/${values.task}; ${entries.length} assignment(s) retained.`);
  } finally {
    if (temporary) await unlink(temporary);
    await lock.close();
    const current = await lstat(lockPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    if (current?.ino === lockIdentity.ino && current?.dev === lockIdentity.dev) await unlink(lockPath);
  }
}

run(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
