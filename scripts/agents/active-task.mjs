import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from './pr-workflow.mjs';
import { isDeepStrictEqual } from 'node:util';
import { atomicWrite, dataDirectory, readJson, repository, samePath, withLock } from './agent-store.mjs';
import { captureOwnedHandoff, validateOwnedPaths, validateSessionRef, verifyOwnedHandoff } from './owned-handoff.mjs';
import { reassign, retireReassigned } from './active-task-reassignment.mjs';

const usage = `Usage:
  node scripts/agents/active-task.mjs start --owner <id> --task <id> --session <date/id> --summary <text> --next <text> [--role coordinator|worker] [--owned-path <path>...]
  node scripts/agents/active-task.mjs update --owner <id> --task <id> [--next <text>] [--verification <text>] [--status active|blocked]
  node scripts/agents/active-task.mjs handoff --owner <id> --task <id> --result <text>
  node scripts/agents/active-task.mjs finish --owner <id> --task <id> --result <text>
  node scripts/agents/active-task.mjs reassign --owner <old-id> --task <id> --new-owner <id> --session <date/id> --reason <text> [--role coordinator|worker] [--owned-path <path>...]
  node scripts/agents/active-task.mjs retire-reassigned --owner <id> --task <id> --reason <text>
  node scripts/agents/active-task.mjs verify-handoff --owner <id> --task <id>
  node scripts/agents/active-task.mjs clear --owner <id> --task <id>
  node scripts/agents/active-task.mjs archive --owner <id> --task <id> --output docs/verification/<name>.json [--apply]
  node scripts/agents/active-task.mjs list
  node scripts/agents/active-task.mjs list --compact [--owner <id>] [--task <id>] [--status <status>]
  node scripts/agents/active-task.mjs render

All commands accept --root <checkout>. Use a unique owner per session/worker.
finish requires a clean published linked PR and passing current-head CI; pending CI stays active.
handoff returns registered worker results without completing contributor work.
clear removes only completed, handed-off, or reassigned entries.
retire-reassigned explicitly migrates a blocked legacy entry with a recorded reassignment; it does not complete the source task.
archive previews by default; --apply preserves and verifies a terminal entry before clearing it.
All worktrees share the primary checkout's .agent-work/state/active-tasks.json.
Only render refreshes the selected checkout's Markdown view; other mutations update local shared state only.
A busy lock is not automatically reclaimed. The permanent template is preserved.`;

function parseArguments(args) {
  const [command, ...options] = args;
  const fields = {
    start: ['summary', 'next', 'role', 'session', 'owned-path'], update: ['next', 'verification', 'status'],
    finish: ['result'], handoff: ['result'], clear: [], archive: ['output'], list: ['owner', 'task', 'status'], render: [],
    reassign: ['new-owner', 'session', 'reason', 'role', 'owned-path'], 'retire-reassigned': ['reason'], 'verify-handoff': [],
  };
  if (!Object.hasOwn(fields, command)) throw new Error(usage);
  const values = {};
  for (let index = 0; index < options.length; index++) {
    if (options[index] === '--compact' && command === 'list' && !values.compact) { values.compact = true; continue; }
    if (options[index] === '--apply' && command === 'archive' && !values.apply) { values.apply = true; continue; }
    const name = options[index].slice(2);
    const value = options[index + 1];
    const repeatable = name === 'owned-path' && ['start', 'reassign'].includes(command);
    if (!options[index].startsWith('--') || !['root', 'owner', 'task', ...fields[command]].includes(name) || Object.hasOwn(values, name) && !repeatable || !value?.trim() || value.startsWith('--')) {
      throw new Error(`Invalid or duplicate option: ${options[index]}\n${usage}`);
    }
    if (repeatable) (values[name] ??= []).push(value);
    else values[name] = value;
    index++;
  }
  for (const name of ['list', 'render'].includes(command) ? [] : ['owner', 'task']) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(values[name] ?? '')) throw new Error(`A valid --${name} ID is required.`);
  }
  for (const name of command === 'start' ? ['summary', 'next'] : ['finish', 'handoff'].includes(command) ? ['result'] : []) {
    if (!values[name]) throw new Error(`--${name} is required.`);
  }
  if (['start', 'reassign'].includes(command)) validateSessionRef(values.session);
  if (command === 'reassign' && (!values['new-owner'] || !values.reason)) throw new Error('reassign requires --new-owner and --reason.');
  if (command === 'retire-reassigned' && !values.reason) throw new Error('retire-reassigned requires --reason.');
  if (values['new-owner'] && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(values['new-owner'])) throw new Error('A valid --new-owner ID is required.');
  if (command === 'update' && !fields.update.some((name) => values[name])) throw new Error('update requires progress, verification, or status.');
  if (values.role && !['coordinator', 'worker'].includes(values.role)) throw new Error('Role must be coordinator or worker.');
  if (command === 'update' && values.status && !['active', 'blocked'].includes(values.status)) throw new Error('Status must be active or blocked.');
  if (command === 'list' && values.status && !['active', 'blocked', 'handed-off', 'completed', 'reassigned'].includes(values.status)) {
    throw new Error('List status must be active, blocked, handed-off, completed, or reassigned.');
  }
  if (command === 'archive' && !values.output) throw new Error('archive requires --output docs/verification/<name>.json.');
  return { command, values };
}

function listEntries(entries, values) {
  const current = values.compact && !values.status
    ? new Set(['active', 'blocked', 'handed-off'])
    : null;
  return entries.filter((entry) =>
    (!current || current.has(entry.status)) &&
    (!values.owner || entry.owner === values.owner) &&
    (!values.task || entry.task === values.task) &&
    (!values.status || entry.status === values.status));
}

function printCompactEntries(entries) {
  const shown = entries.slice(0, 12);
  console.log(`Assignments: ${entries.length}`);
  if (!shown.length) console.log('  none');
  for (const entry of shown) {
    const checkout = entry.checkout ? ` in ${basename(entry.checkout)}` : '';
    const next = entry.next.replace(/\s+/g, ' ').trim();
    const summary = next.length > 120 ? `${next.slice(0, 119)}…` : next;
    console.log(`- ${entry.owner}/${entry.task} [${entry.status}; ${entry.role ?? 'coordinator'}]${checkout} — ${summary}`);
  }
  if (entries.length > shown.length) console.log(`  … ${entries.length - shown.length} more; add --owner, --task, or --status to narrow the list`);
  console.log('Use list without --compact for the complete JSON assignment records.');
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
    if (!entry || typeof entry.owner !== 'string' || typeof entry.task !== 'string' || typeof entry.summary !== 'string' || typeof entry.next !== 'string' || !['active', 'blocked', 'completed', 'handed-off', 'reassigned'].includes(entry.status)) {
      throw new Error('Invalid active-task entry; file left unchanged.');
    }
    if (entry.status === 'reassigned' && (!Array.isArray(entry.reassignments) || entry.reassignments.length === 0)) throw new Error('Reassigned entries must retain their reassignment history.');
    if (entry.role !== undefined && !['coordinator', 'worker'].includes(entry.role) || entry.status === 'handed-off' && entry.role !== 'worker') throw new Error('Invalid task role or worker handoff.');
    if (entry.session !== undefined) validateSessionRef(entry.session);
    if (entry.ownedPaths !== undefined) validateOwnedPaths(entry.ownedPaths);
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
        if (!legacyStat.isFile() || legacyStat.isSymbolicLink()) throw new Error('Legacy handoff must be a regular file.', { cause: error });
        for (const legacy of managedEntries(await readFile(legacyPath, 'utf8')).entries) {
          const previous = entries.find((entry) => entry.owner === legacy.owner && entry.task === legacy.task);
          if (previous) {
            const previousData = { ...previous };
            delete previousData.checkout;
            if (JSON.stringify(previousData) !== JSON.stringify(legacy)) throw new Error('Conflicting legacy handoffs; reconcile them before migration.', { cause: error });
          } else entries.push({ ...legacy, checkout: worktree.worktree });
        }
      }
    }
    if (command === 'list') {
      const selected = listEntries(entries, values);
      if (values.compact) return printCompactEntries(selected);
      return console.log(JSON.stringify(selected, null, 2));
    }
    const index = entries.findIndex((entry) => entry.owner === values.owner && entry.task === values.task);
    if (command === 'verify-handoff') {
      if (index === -1) throw new Error('No entry matches that owner and task.');
      const entry = entries[index];
      const verification = await verifyOwnedHandoff(entry);
      console.log(JSON.stringify({ owner: entry.owner, task: entry.task, checkout: entry.checkout ?? null, ...verification }, null, 2));
      if (!verification.verified) process.exitCode = 1;
      return;
    }
    if (command === 'archive') {
      if (!/^docs\/verification\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(values.output)) throw new Error('Archive output must be a JSON file directly under docs/verification/.');
      for (const part of ['docs', 'docs/verification']) {
        const directory = resolve(repo.root, part);
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Archive directories must be regular checkout directories, not links.');
      }
      const output = resolve(repo.root, values.output);
      let archive;
      try { archive = await readJson(output); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (archive) {
        if (archive.schemaVersion !== 1 || !Array.isArray(archive.entries) || archive.entries.length !== 1) throw new Error('Archive already exists with different content; choose another output.');
        const saved = validateEntries(archive.entries)[0];
        if (saved.owner !== values.owner || saved.task !== values.task || !['completed', 'handed-off', 'reassigned'].includes(saved.status) || index !== -1 && !isDeepStrictEqual(saved, entries[index])) throw new Error('Archive already exists with different content; retain the task record.');
      }
      if (index === -1) {
        if (!archive) throw new Error('No entry matches that owner and task.');
        return console.log(JSON.stringify({ applied: Boolean(values.apply), alreadyArchived: true, output: values.output }));
      }
      const entry = entries[index];
      if (!['completed', 'handed-off', 'reassigned'].includes(entry.status)) throw new Error('Only completed, handed-off, or reassigned entries can be archived; retain active or blocked work.');
      if (!values.apply) return console.log(JSON.stringify({ applied: false, output: values.output, entry }));
      const expected = { schemaVersion: 1, entries: [entry] };
      if (!archive) {
        const handle = await open(output, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(expected, null, 2) + '\n', 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
      }
      if (!isDeepStrictEqual(await readJson(output), expected)) throw new Error('Archive verification failed; task record retained.');
      entries.splice(index, 1);
    } else if (command === 'render') {
      // The shared store is authoritative; rendering changes only this checkout.
    } else if (command === 'start') {
      if (index !== -1) throw new Error('Entry already exists; use update or finish instead of overwriting it.');
      const role = values.role ?? 'coordinator';
      const ownedPaths = validateOwnedPaths(values['owned-path'] ?? []);
      if (role === 'worker' && !ownedPaths.length) throw new Error('Worker start requires at least one --owned-path.');
      entries.push({ owner: values.owner, task: values.task, checkout: repo.root, session: values.session, role, summary: values.summary, next: values.next, status: 'active', verification: '', ...(ownedPaths.length ? { ownedPaths } : {}), updatedAt: new Date().toISOString() });
    } else if (command === 'reassign') {
      reassign(entries, index, values, repo.root);
    } else if (command === 'retire-reassigned') {
      retireReassigned(entries, index, values);
    } else {
      if (index === -1) throw new Error('No entry matches that owner and task.');
      const entry = entries[index];
      if (command === 'clear') {
        if (!['completed', 'handed-off', 'reassigned'].includes(entry.status)) throw new Error('Only completed, handed-off, or reassigned entries can be cleared; retain active or blocked work.');
        entries.splice(index, 1);
      } else {
        if (['completed', 'handed-off', 'reassigned'].includes(entry.status)) throw new Error('Terminal entries are retained for review; clear before starting again.');
        for (const field of ['next', 'verification', 'status']) if (values[field]) entry[field] = values[field];
        if (command === 'finish') {
          if (entry.role === 'worker') throw new Error('Workers return results with handoff; the coordinator completes publication.');
          if (!entry.checkout || !(await samePath(entry.checkout, repo.root))) throw new Error('Finish must run in the assignment checkout.');
          const publication = await runWorkflow(['complete', '--root', repo.root]);
          Object.assign(entry, { status: 'completed', result: values.result, publication: publication.completion, next: 'Human merge decision' });
        }
        if (command === 'handoff' && entry.role !== 'worker') throw new Error('Only registered workers may hand off; coordinators must publish and finish.');
        if (command === 'handoff') {
          if (!entry.checkout || !(await samePath(entry.checkout, repo.root))) throw new Error('Worker handoff must run in the assignment checkout.');
          const handoffEvidence = entry.ownedPaths?.length
            ? await captureOwnedHandoff(entry)
            : { schemaVersion: 1, status: 'unverified', reason: 'Legacy assignment has no declared owned paths; hashes were not inferred.' };
          Object.assign(entry, { status: 'handed-off', result: values.result, handoffEvidence, next: 'Coordinator must verify owned paths before integration and publication' });
        }
        entry.updatedAt = new Date().toISOString();
      }
    }
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const content = source.slice(0, block.index) + block[1] + JSON.stringify(entries, null, 2).replace(/\n/g, newline) + block[3] + source.slice(block.index + block[0].length);
    await atomicWrite(statePath, JSON.stringify(entries, null, 2) + '\n');
    if (command === 'render') {
      try { await atomicWrite(path, content); }
      catch (error) { throw new Error(`Shared state saved, but view refresh failed: ${error.message}`, { cause: error }); }
    }
    console.log(command === 'archive' ? JSON.stringify({ applied: true, output: values.output, retained: entries.length }) : `${command}: ${values.owner}/${values.task}; ${entries.length} assignment(s) retained.`);
  });
}

run(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
