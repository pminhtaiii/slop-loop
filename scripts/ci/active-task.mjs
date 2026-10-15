import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, dataDirectory, readJson, repository, withLock } from './agent-store.mjs';

const usage = `Usage:
  node scripts/ci/active-task.mjs start --owner <id> --task <id> --summary <text> --next <text>
  node scripts/ci/active-task.mjs update --owner <id> --task <id> [--next <text>] [--verification <text>] [--status active|blocked]
  node scripts/ci/active-task.mjs finish --owner <id> --task <id> --result <text>
  node scripts/ci/active-task.mjs clear --owner <id> --task <id>
  node scripts/ci/active-task.mjs list
  node scripts/ci/active-task.mjs render

All commands accept --root <checkout>. Use a unique owner per session/worker.
finish retains the result for review; clear removes only that completed entry.
All worktrees share the primary checkout's .agent-work/state/active-tasks.json.
Primary mutations refresh Markdown; worker mutations leave tracked views unchanged.
render explicitly refreshes the selected checkout's view.
A busy lock is not automatically reclaimed. The permanent template is preserved.`;

function parseArguments(args) {
  const [command, ...options] = args;
  const fields = {
    start: ['summary', 'next'], update: ['next', 'verification', 'status'],
    finish: ['result'], clear: [], list: [], render: [],
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
  for (const name of ['list', 'render'].includes(command) ? [] : ['owner', 'task']) {
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
  const entries = validateEntries(JSON.parse(block[2]));
  return { block, entries };
}

function validateEntries(entries) {
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
  return entries;
}

async function run(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return console.log(usage);
  const { command, values } = parseArguments(args);
  const repo = await repository(values.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
  const directory = resolve(repo.root, 'context');
  if (!(await lstat(directory)).isDirectory()) throw new Error('context must be a regular directory, not a link.');
  const path = resolve(directory, 'active_task.md');
  const store = await dataDirectory(repo, 'state');
  const statePath = resolve(store, 'active-tasks.json');
  await withLock(resolve(store, 'active-task.lock'), async () => {
    const original = await lstat(path);
    if (!original.isFile() || original.isSymbolicLink()) throw new Error('active_task.md must be a regular file, not a link.');
    const source = await readFile(path, 'utf8');
    const { block } = managedEntries(source);
    let entries;
    try { entries = validateEntries(await readJson(statePath)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      entries = [];
      for (const worktree of repo.worktrees) {
        const legacyPath = resolve(worktree.worktree, 'context/active_task.md');
        const legacyStat = await lstat(legacyPath).catch((missing) => { if (missing.code !== 'ENOENT') throw missing; });
        if (!legacyStat) continue;
        if (!legacyStat.isFile() || legacyStat.isSymbolicLink()) throw new Error('Legacy handoff must be a regular file.');
        for (const legacy of managedEntries(await readFile(legacyPath, 'utf8')).entries) {
          const previous = entries.find((entry) => entry.owner === legacy.owner && entry.task === legacy.task);
          if (previous) {
            const { checkout, ...previousData } = previous;
            if (JSON.stringify(previousData) !== JSON.stringify(legacy)) throw new Error('Conflicting legacy handoffs; reconcile them before migration.');
          } else entries.push({ ...legacy, checkout: worktree.worktree });
        }
      }
    }
    if (command === 'list') return console.log(JSON.stringify(entries, null, 2));
    const index = entries.findIndex((entry) => entry.owner === values.owner && entry.task === values.task);
    if (command === 'render') {
      // The shared store is authoritative; rendering changes only this checkout.
    } else if (command === 'start') {
      if (index !== -1) throw new Error('Entry already exists; use update or finish instead of overwriting it.');
      entries.push({ owner: values.owner, task: values.task, checkout: repo.root, summary: values.summary, next: values.next, status: 'active', verification: '', updatedAt: new Date().toISOString() });
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
    await atomicWrite(statePath, JSON.stringify(entries, null, 2) + '\n');
    if (repo.root === repo.primary || command === 'render') {
      try { await atomicWrite(path, content); }
      catch (error) { throw new Error(`Shared state saved, but view refresh failed: ${error.message}`); }
    }
    console.log(`${command}: ${values.owner}/${values.task}; ${entries.length} assignment(s) retained.`);
  });
}

run(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
