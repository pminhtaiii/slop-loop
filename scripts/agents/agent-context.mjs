import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repository as agentRepository } from './agent-store.mjs';

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const usage = `Usage:
  node scripts/agents/agent-context.mjs assignment --uc UC-03 [--root <checkout>]
  node scripts/agents/agent-context.mjs handoff --tasks <tasks.md> [--root <checkout>]
  node scripts/agents/agent-context.mjs resume [--tasks <tasks.md>] [--authorization <path> ...] [--root <checkout>]
  node scripts/agents/agent-context.mjs task --tasks <tasks.md> --task T017 [--plan <plan.md>] [--root <checkout>]
  node scripts/agents/agent-context.mjs snapshot --files <repo-relative-file...> [--root <checkout>]
  node scripts/agents/agent-context.mjs verify --snapshot <snapshot.json> [--root <checkout>]
  node scripts/agents/agent-context.mjs --help`;

function fail(message) {
  throw new Error(`${message}\n\n${usage}`);
}

function parseArguments(argv) {
  if (argv.length === 0 || (argv.length === 1 && ['--help', '-h'].includes(argv[0]))) {
    return { help: true };
  }
  const mode = argv[0];
  if (!['assignment', 'handoff', 'resume', 'task', 'snapshot', 'verify'].includes(mode)) fail(`Unknown mode: ${mode}`);
  if (argv.slice(1).includes('--help') || argv.slice(1).includes('-h')) {
    if (argv.length === 2) return { help: true };
    fail('Help cannot be combined with other options.');
  }

  const values = new Map();
  const files = [];
  const authorization = [];
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--authorization') {
      if (mode !== 'resume') fail('--authorization is only valid for resume.');
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        fail('--authorization requires a repo-relative path.');
      }
      authorization.push(value);
      index += 1;
      continue;
    }
    if (option === '--files') {
      if (values.has(option)) fail('--files may be supplied once.');
      values.set(option, true);
      while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
        files.push(argv[index + 1]);
        index += 1;
      }
      if (files.length === 0) fail('--files requires at least one repo-relative path.');
      continue;
    }
    if (!['--uc', '--tasks', '--task', '--plan', '--snapshot', '--root'].includes(option)) {
      fail(`Unknown option or positional argument: ${option}`);
    }
    if (values.has(option)) fail(`${option} may be supplied once.`);
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      fail(`${option} requires a value.`);
    }
    values.set(option, value);
    index += 1;
  }

  const allowed = {
    assignment: ['--uc', '--root'],
    handoff: ['--tasks', '--root'],
    resume: ['--tasks', '--root'],
    task: ['--tasks', '--task', '--plan', '--root'],
    snapshot: ['--files', '--root'],
    verify: ['--snapshot', '--root'],
  }[mode];
  for (const option of values.keys()) {
    if (!allowed.includes(option)) fail(`${option} is not valid for ${mode}.`);
  }
  for (const required of {
    assignment: ['--uc'],
    handoff: ['--tasks'],
    resume: [],
    task: ['--tasks', '--task'],
    snapshot: ['--files'],
    verify: ['--snapshot'],
  }[mode]) {
    if (!values.has(required)) fail(`${mode} requires ${required}.`);
  }
  if (mode === 'task' && !/^T\d{3}$/.test(values.get('--task'))) {
    fail(`Invalid task ID ${values.get('--task')}; use a canonical ID such as T017.`);
  }
  if (mode === 'assignment' && !/^UC-\d{2}$/.test(values.get('--uc'))) fail('Use a canonical use-case ID such as UC-03.');
  return { mode, values, files, authorization };
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot !== '' &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

async function resolveRoot(rootOption) {
  const candidate = rootOption ? resolve(process.cwd(), rootOption) : moduleRoot;
  const canonicalRoot = await realpath(candidate);
  if (!(await stat(canonicalRoot)).isDirectory())
    fail(`Checkout root is not a directory: ${candidate}`);
  return canonicalRoot;
}

async function repoFile(root, input, label, allowMissing = false) {
  if (input.length === 0 || input.includes('\0') || isAbsolute(input)) {
    fail(`${label} must be a repo-relative path: ${input}`);
  }
  const candidate = resolve(root, input);
  if (!isInside(root, candidate)) fail(`${label} escapes the checkout root: ${input}`);
  try {
    const canonicalFile = await realpath(candidate);
    if (!isInside(root, canonicalFile))
      fail(`${label} resolves outside the checkout root: ${input}`);
    return canonicalFile;
  } catch (error) {
    if (
      allowMissing &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return candidate;
    }
    throw error;
  }
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error(`Could not run git ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error((result.stderr || `git ${args.join(' ')} failed`).trim());
  }
  return result.stdout.trim();
}

async function checkout(root) {
  const gitRoot = await realpath(git(root, ['rev-parse', '--show-toplevel']));
  if (!samePath(gitRoot, root)) fail(`--root must name a Git checkout root: ${root}`);
  const branch = git(root, ['branch', '--show-current']) || null;
  const head = git(root, ['rev-parse', 'HEAD']);
  return { root, branch, head };
}

function markdownLines(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const visible = [];
  let fence = null;
  for (const line of lines) {
    const indent = line.match(/^ */)?.[0].length ?? 0;
    const body = line.slice(indent);
    if (fence) {
      const closes =
        indent <= 3 &&
        body.length >= fence.length &&
        body.slice(0, fence.length) === fence.character.repeat(fence.length) &&
        [...body.slice(fence.length)].every(
          (character) => character === fence.character || character === ' ' || character === '\t',
        );
      visible.push(false);
      if (closes) fence = null;
      continue;
    }
    const opening = indent <= 3 ? body.match(/^(`{3,}|~{3,})/)?.[0] : undefined;
    if (opening) {
      visible.push(false);
      fence = { character: opening[0], length: opening.length };
      continue;
    }
    visible.push(true);
  }
  return { lines, visible };
}

function headings(lines, visible) {
  const found = [];
  lines.forEach((line, index) => {
    if (!visible[index]) return;
    const match = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) found.push({ index, level: match[1].length, title: match[2].trim(), line });
  });
  return found;
}

function parseTasks(text, path) {
  const source = markdownLines(text);
  const sectionHeadings = headings(source.lines, source.visible);
  const tasks = [];
  const seen = new Map();
  source.lines.forEach((line, index) => {
    if (!source.visible[index]) return;
    const match = line.match(/^ {0,3}[-*+]\s+\[([ xX])\]\s+(T\d{3})\b.*$/);
    if (!match) return;
    const id = match[2];
    if (seen.has(id))
      fail(
        `Duplicate canonical task ID ${id} in ${path} at lines ${seen.get(id)} and ${index + 1}.`,
      );
    seen.set(id, index + 1);
    const prior = sectionHeadings.filter((heading) => heading.index < index);
    const phase =
      [...prior].reverse().find((heading) => /\bphase\b/i.test(heading.title)) ??
      prior.at(-1) ??
      null;
    tasks.push({ id, checked: match[1].toLowerCase() === 'x', line, lineIndex: index, phase });
  });
  if (tasks.length === 0) fail(`No canonical task checkbox lines were found in ${path}.`);
  tasks.forEach((task, index) => {
    const end = tasks[index + 1]?.lineIndex ?? source.lines.length;
    const field = source.lines.slice(task.lineIndex + 1, end).find((line, offset) =>
      source.visible[task.lineIndex + 1 + offset] && /^\s*[-*+]\s+\*\*Dependencies\*\*\s*:/i.test(line),
    );
    const value = field?.match(/^\s*[-*+]\s+\*\*Dependencies\*\*\s*:\s*(.*)$/i)?.[1]?.trim() ?? null;
    task.dependenciesDeclared = value !== null && value.length > 0;
    task.dependencies = value && !/^none\b/i.test(value)
      ? [...new Set(value.match(/\b(?:T\d{3}|X\d{2}(?:-[A-Z0-9]+)*)\b/g) ?? [])]
      : [];
  });
  return { ...source, tasks, headings: sectionHeadings };
}

function findTask(parsed, id, path) {
  const task = parsed.tasks.find((entry) => entry.id === id);
  if (task) return task;
  const known = parsed.tasks.map((entry) => entry.id).join(', ');
  fail(`Unknown task ID ${id} in ${path}. Canonical IDs: ${known}.`);
}

function normalizedRepoPath(root, file) {
  return relative(root, file).split(sep).join('/');
}

async function readOptionalText(root, path) {
  try {
    const file = await repoFile(root, path, 'context path');
    return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}

async function assignment(root, uc) {
  const sourcePath = 'docs/use-case-delegation.md';
  const source = markdownLines(await readFile(await repoFile(root, sourcePath, 'delegation map'), 'utf8'));
  const sections = headings(source.lines, source.visible);
  const rows = source.lines.filter((line, index) => source.visible[index] && /^\|\s*UC-\d{2}\s*\|/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  const seen = new Set();
  for (const row of rows) {
    if (row.length !== 5 || seen.has(row[0])) fail('Delegation assignments require five columns and unique UC IDs.');
    seen.add(row[0]);
  }
  const row = rows.find((entry) => entry[0] === uc);
  if (!row) fail(`${uc} is not assigned in the selected batch; inspect ${sourcePath}.`);
  const section = (matches) => {
    const found = sections.filter(matches);
    if (found.length !== 1) fail('Delegation map requires a unique UC brief and shared-work section.');
    const start = found[0];
    const end = sections.find((heading) => heading.index > start.index && heading.level <= start.level)?.index ?? source.lines.length;
    return source.lines.slice(start.index, end).join('\n').trim();
  };
  const brief = section((heading) => heading.level === 2 && heading.title.startsWith(`${uc}:`));
  const sharedFoundation = section((heading) => heading.level === 2 && heading.title === 'Delivery order and shared work');
  const missing = [];
  const pointers = async (text, artifacts = false) => {
    const result = [];
    const prose = markdownLines(text);
    for (const line of prose.lines.filter((_, index) => prose.visible[index])) {
      for (const match of line.matchAll(/\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))\)/g)) {
        const target = (match[1] ?? match[2]).split('#')[0];
        if (!target) continue;
        if (/^[a-z][a-z\d+.-]*:/i.test(target)) {
          if (artifacts) fail('Feature artifacts must be local checkout paths.');
          continue;
        }
        const input = normalizedRepoPath(root, resolve(root, 'docs', decodeURIComponent(target)));
        try {
          const path = await repoFile(root, input, 'assignment link');
          if (!(await stat(path)).isFile()) fail(`Assignment link is not a file: ${input}`);
          result.push(normalizedRepoPath(root, path));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          missing.push(`Missing linked file: ${input}`);
        }
      }
    }
    return [...new Set(result)];
  };
  const artifacts = await pointers(row[4], true);
  for (const name of ['spec.md', 'plan.md', 'tasks.md']) {
    if (!artifacts.some((path) => basename(path) === name)) missing.push(`Link the approved ${name} in the Feature artifacts cell.`);
  }
  if (!row[2] || /pending|unassigned/i.test(row[2])) missing.push('Assign a colleague owner.');
  const context = await pointers(brief + '\n' + sharedFoundation);
  process.stdout.write(JSON.stringify({ ...(await checkout(root)), uc, owner: row[2], delivery: row[1], prerequisites: row[3],
    status: missing.length ? 'NEEDS_PLANNING' : 'REVIEW_REQUIRED', missing, artifacts, context, brief, sharedFoundation,
    source: sourcePath, note: 'Confirm artifact approval and dependency evidence before implementation; this report never updates task status.' }, null, 2) + '\n');
}

function workflowEvidencePointers(root, activeText) {
  if (!activeText) return [];
  const source = markdownLines(activeText);
  const sectionHeadings = headings(source.lines, source.visible);
  const first = sectionHeadings.find((heading) => heading.level === 2);
  if (!first) return [];
  const end =
    sectionHeadings.find((heading) => heading.level <= first.level && heading.index > first.index)
      ?.index ?? source.lines.length;
  const result = [];
  for (let index = first.index + 1; index < end; index += 1) {
    if (!source.visible[index]) continue;
    for (const match of source.lines[index].matchAll(
      /\[([^\]]*(?:evidence|verification|record)[^\]]*)\]\(([^)]+)\)/gi,
    )) {
      const target = match[2].split('#')[0];
      if (!target || /^[a-z]+:/i.test(target) || isAbsolute(target)) continue;
      const resolved = resolve(root, 'context', target);
      if (isInside(root, resolved)) result.push(normalizedRepoPath(root, resolved));
      if (result.length === 3) return result;
    }
  }
  return result;
}

async function handoff(root, tasksInput) {
  const tasksFile = await repoFile(root, tasksInput, '--tasks');
  const tasksText = (await readFile(tasksFile, 'utf8')).replace(/^\uFEFF/, '');
  const parsed = parseTasks(tasksText, tasksInput);
  const current = await checkout(root);
  const checked = parsed.tasks.filter((task) => task.checked).length;
  const open = parsed.tasks.length - checked;
  const candidate = parsed.tasks.find((task) => !task.checked);
  const activeText = await readOptionalText(root, 'context/active-feature.md');
  const workflowText = await readOptionalText(root, 'context/workflow.md');
  const workflowSource = workflowText ? markdownLines(workflowText) : null;
  const gates = workflowSource
    ? headings(workflowSource.lines, workflowSource.visible).filter((heading) =>
        /^Step [234]:/.test(heading.title),
      )
    : [];
  const evidence = workflowEvidencePointers(root, activeText);

  process.stdout.write(
    `Checkout: ${current.root}\nBranch: ${current.branch ?? '(detached)'}\nHEAD: ${current.head}\n`,
  );
  process.stdout.write(
    `Tasks: ${normalizedRepoPath(root, tasksFile)}\nCanonical tasks: ${checked} checked; ${open} open; ${parsed.tasks.length} total\n`,
  );
  process.stdout.write(
    candidate
      ? `First unchecked candidate (not authorization): ${candidate.line}\n`
      : 'First unchecked candidate: none\n',
  );
  process.stdout.write(
    'Workflow pointers: context/active-feature.md (checkpoint), context/workflow.md (sequence), context/testing.md (verification gates)\n',
  );
  if (evidence.length > 0)
    process.stdout.write(`Evidence pointers from active-feature.md: ${evidence.join(', ')}\n`);
  if (gates.length > 0) {
    process.stdout.write(
      `Next workflow stages (reference only): ${gates.map((heading) => heading.title).join(' -> ')}\n`,
    );
  } else {
    process.stdout.write(
      'Next workflow stages: consult context/workflow.md; no stage status is inferred.\n',
    );
  }
}

function statIfPresent(path) {
  return lstat(path).catch((error) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
}

async function readWorkerState(root) {
  const repo = await agentRepository(root);
  const agentDirectory = resolve(repo.primary, '.agent-work');
  const stateDirectory = resolve(agentDirectory, 'state');
  const agentInfo = await statIfPresent(agentDirectory);
  if (!agentInfo) return { entries: [], worktrees: repo.worktrees, source: null };
  if (!agentInfo.isDirectory() || agentInfo.isSymbolicLink() || await realpath(agentDirectory) !== agentDirectory)
    fail('Shared agent-work directory must be a regular directory.');
  const stateInfo = await statIfPresent(stateDirectory);
  if (!stateInfo) return { entries: [], worktrees: repo.worktrees, source: null };
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink() || await realpath(stateDirectory) !== stateDirectory)
    fail('Shared agent state directory must be a regular directory.');

  const storePath = resolve(stateDirectory, 'active-tasks.json');
  const lockPath = resolve(stateDirectory, 'active-task.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await statIfPresent(lockPath)) {
      if (attempt === 0) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        continue;
      }
      fail('Shared active-task state is being updated; retry the resume report.');
    }
    const storeInfo = await statIfPresent(storePath);
    if (!storeInfo) return { entries: [], worktrees: repo.worktrees, source: null };
    if (!storeInfo.isFile() || storeInfo.isSymbolicLink()) fail('Shared active-task state must be a regular file.');
    let entries;
    try {
      entries = JSON.parse(await readFile(storePath, 'utf8'));
    } catch (error) {
      fail(`Could not read shared active-task state: ${error.message}`);
    }
    if (await statIfPresent(lockPath)) {
      if (attempt === 0) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        continue;
      }
      fail('Shared active-task state changed during the read; retry the resume report.');
    }
    if (!Array.isArray(entries) || entries.some((entry) =>
      !entry || typeof entry.owner !== 'string' || typeof entry.task !== 'string' ||
      !['active', 'blocked', 'completed', 'handed-off'].includes(entry.status) ||
      typeof entry.summary !== 'string' || typeof entry.next !== 'string' ||
      (entry.role !== undefined && !['coordinator', 'worker'].includes(entry.role)))) {
      fail('Shared active-task state has an unsupported shape.');
    }
    return { entries, worktrees: repo.worktrees, source: normalizedRepoPath(root, storePath) };
  }
  fail('Shared active-task state is being updated; retry the resume report.');
}

function evidencePointers(text) {
  const normalized = text.replaceAll('\\', '/');
  return [...normalized.matchAll(/https?:\/\/[^\s),>]+|(?:\.agent-work|docs|specs|context)\/[A-Za-z0-9._/-]+/g)]
    .map((match) => match[0].replace(/[.,;:!?]+$/, ''));
}

function taskReadiness(parsed) {
  const byId = new Map(parsed.tasks.map((task) => [task.id, task]));
  const ready = [];
  const blocked = [];
  for (const task of parsed.tasks.filter((entry) => !entry.checked)) {
    if (!task.dependenciesDeclared) {
      blocked.push({ task, dependencies: [], reason: 'dependencies unspecified' });
      continue;
    }
    const dependencies = task.dependencies.map((id) => {
      const dependency = byId.get(id);
      return { id, state: dependency ? (dependency.checked ? 'checked' : 'open') : 'unresolved' };
    });
    if (dependencies.every((dependency) => dependency.state === 'checked')) ready.push({ task, dependencies });
    else blocked.push({ task, dependencies, reason: null });
  }
  return { ready, blocked };
}

function truncate(text, limit = 180) {
  const value = text.trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function verificationSummary(text) {
  const value = text.replace(/\s+/g, ' ').trim();
  const outcomes = [...value.matchAll(/\b(?:fail(?:ed|ure|ures|ing)?|error|not[- ]run|timed[- ]out|timeout|blocked|pending|unavailable|skipped)\b/gi)]
    .map((match) => value.slice(Math.max(0, match.index - 45), Math.min(value.length, match.index + match[0].length + 75)));
  const suffix = [...new Set(outcomes)].slice(0, 3).join(' | ');
  return truncate(suffix ? `${truncate(value, 140)} | recorded outcome(s): ${suffix}` : value, 400);
}

async function resumeReport(root, tasksInput, authorizationInputs) {
  const current = await checkout(root);
  const changed = git(root, ['status', '--short', '--untracked-files=all']).split(/\r?\n/).filter(Boolean);
  let parsed = null;
  let tasksFile = null;
  if (tasksInput) {
    tasksFile = await repoFile(root, tasksInput, '--tasks');
    parsed = parseTasks((await readFile(tasksFile, 'utf8')).replace(/^\uFEFF/, ''), tasksInput);
  }

  const authorization = [];
  if (tasksFile) {
    const decisionsInput = normalizedRepoPath(root, resolve(dirname(tasksFile), 'contracts', 'decisions.md'));
    const decisions = await repoFile(root, decisionsInput, 'authorization evidence pointer', true);
    if ((await statIfPresent(decisions))?.isFile()) authorization.push(normalizedRepoPath(root, decisions));
  }
  for (const input of authorizationInputs) {
    const file = await repoFile(root, input, '--authorization');
    if (!(await stat(file)).isFile()) fail(`Authorization evidence pointer is not a file: ${input}`);
    authorization.push(normalizedRepoPath(root, file));
  }

  const workerState = await readWorkerState(root);
  const workers = workerState.entries.filter((entry) => entry.role === 'worker');
  const counts = Object.fromEntries(['active', 'blocked', 'handed-off', 'completed'].map((status) =>
    [status, workers.filter((entry) => entry.status === status).length]));
  const worktreePaths = workerState.worktrees.map((entry) => entry.worktree).filter(Boolean);
  const taskIds = new Set(parsed?.tasks.map((task) => task.id) ?? []);
  const relevantAssignments = workerState.entries.filter((entry) =>
    ['active', 'blocked', 'handed-off'].includes(entry.status) &&
    worktreePaths.some((path) => samePath(path, entry.checkout ?? '')) &&
    (samePath(root, entry.checkout ?? '') || (entry.role === 'worker' && taskIds.has(entry.task))))
    .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
  const pointers = new Map();
  for (const entry of relevantAssignments) {
    const found = [...new Set([
      ...evidencePointers(entry.verification ?? ''),
      ...evidencePointers(entry.result ?? ''),
    ])];
    if (found.length) pointers.set(`${entry.owner}/${entry.task}`, found.slice(0, 5));
  }
  const readiness = parsed ? taskReadiness(parsed) : { ready: [], blocked: [] };

  process.stdout.write(`Checkout: ${current.root}\nBranch: ${current.branch ?? '(detached)'}\nHEAD: ${current.head}\n`);
  process.stdout.write(changed.length
    ? `Working tree: ${changed.length} changed path(s)\n${changed.slice(0, 8).map((path) => `  ${path}`).join('\n')}${changed.length > 8 ? '\n  …' : ''}\n`
    : 'Working tree: clean\n');

  if (!parsed) {
    process.stdout.write('Task ledger: not supplied; no task candidates or dependencies assessed.\n');
  } else {
    const checked = parsed.tasks.filter((task) => task.checked).length;
    const candidates = readiness.ready.slice(0, 5);
    process.stdout.write(`Task ledger: ${normalizedRepoPath(root, tasksFile)} (${checked} checked; ${parsed.tasks.length - checked} open)\n`);
    process.stdout.write('Ledger-derived task candidates (verify integrated dependency evidence and current authorization before acting):\n');
    if (!candidates.length) process.stdout.write('  none; dependencies are open, external, or unspecified\n');
    for (const { task, dependencies } of candidates) {
      const details = dependencies.length ? dependencies.map((dependency) => `${dependency.id} checked`).join(', ') : 'none';
      process.stdout.write(`  ${task.id} [${task.phase?.title ?? 'no phase'}] deps: ${details} — ${truncate(task.line.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, ''))}\n`);
    }
    if (readiness.ready.length > candidates.length) process.stdout.write(`  … ${readiness.ready.length - candidates.length} more candidate(s)\n`);
    const blocked = readiness.blocked.slice(0, 5);
    if (blocked.length) {
      process.stdout.write('Other open tasks and dependency state:\n');
      for (const { task, dependencies, reason } of blocked) {
        const details = reason ?? dependencies.map((dependency) => `${dependency.id} ${dependency.state}`).join(', ');
        process.stdout.write(`  ${task.id}: ${details}\n`);
      }
      if (readiness.blocked.length > blocked.length) process.stdout.write(`  … ${readiness.blocked.length - blocked.length} more open task(s)\n`);
    }
  }

  process.stdout.write('Authorization evidence pointers (pointers only; no grant is inferred):\n');
  const uniqueAuthorization = [...new Set(authorization)];
  process.stdout.write(uniqueAuthorization.length
    ? `${uniqueAuthorization.map((path) => `  ${path}`).join('\n')}\n`
    : '  none supplied or found\n');

  const storeLabel = workerState.source ?? '(shared store not present)';
  process.stdout.write(`Worker state from ${storeLabel}: ${Object.entries(counts).map(([status, count]) => `${status} ${count}`).join('; ')}\n`);
  process.stdout.write('Matching assignment records (shared-state snapshot):\n');
  const shown = relevantAssignments.slice(0, 8);
  if (!shown.length) process.stdout.write('  none for this checkout or ledger task IDs\n');
  for (const entry of shown) {
    process.stdout.write(`  ${entry.role ?? 'coordinator'} ${entry.owner}/${entry.task} [${entry.status}] — ${truncate(entry.summary, 120)}; next: ${truncate(entry.next, 140)}\n`);
    if (entry.verification) process.stdout.write(`    recorded verification (not revalidated): ${verificationSummary(entry.verification)}\n`);
    const found = pointers.get(`${entry.owner}/${entry.task}`) ?? [];
    if (found.length) process.stdout.write(`    recorded pointers (not revalidated): ${found.join(', ')}\n`);
  }
  if (relevantAssignments.length > shown.length)
    process.stdout.write(`  … ${relevantAssignments.length - shown.length} more assignment(s) omitted\n`);
  process.stdout.write('Recheck the source files and evidence before resuming; this report is read-only and never authorizes work.\n');
}

function taskConstraints(parsed, task) {
  const storyTags = [...task.line.matchAll(/\[(US\d+)\]/g)].map((match) => match[1]);
  const result = [];
  const add = (line) => {
    const value = line.trim();
    if (value && !result.includes(value)) result.push(value);
  };
  if (task.phase) {
    const end =
      parsed.headings.find(
        (heading) => heading.index > task.phase.index && heading.level <= task.phase.level,
      )?.index ?? parsed.lines.length;
    for (let index = task.phase.index + 1; index < end; index += 1) {
      if (!parsed.visible[index] || /^ {0,3}[-*+]\s+\[[ xX]\]\s+T\d{3}\b/.test(parsed.lines[index]))
        continue;
      add(parsed.lines[index]);
    }
  }
  const dependency = parsed.headings.find((heading) => /dependency graph/i.test(heading.title));
  if (dependency) {
    const end =
      parsed.headings.find(
        (heading) => heading.index > dependency.index && heading.level <= dependency.level,
      )?.index ?? parsed.lines.length;
    for (let index = dependency.index + 1; index < end; index += 1) {
      const line = parsed.lines[index];
      if (!parsed.visible[index]) continue;
      if (
        line.includes(task.id) ||
        storyTags.some((tag) => line.includes(tag)) ||
        (task.line.includes('[P]') && line.includes('[P] marks'))
      )
        add(line);
    }
  }
  return result;
}

function taskArtifacts(taskLine) {
  const paths = [];
  for (const token of taskLine.split(/\s+/)) {
    const candidate = token.replace(/^[`"'(]+/, '').replace(/[.`"'),;]+$/, '');
    if (/^(?:[^/\\\s]+[/\\])*[^/\\\s]+\.[A-Za-z0-9_-]+$/.test(candidate))
      paths.push(candidate.replaceAll('\\', '/'));
  }
  return paths.flatMap((path) => {
    const implementationPath = path.replace(
      /\.(?:spec|test|e2e-spec|unit)(?=\.(?:ts|tsx|js|mjs)$)/i,
      '',
    );
    return [...new Set([path, implementationPath])];
  });
}

function sharedInterfaces(taskLine) {
  const names = new Set(taskLine.match(/\b[A-Z][A-Z0-9_]*_(?:PORT|INTERFACE|CONTRACT)\b/g) ?? []);
  for (const match of taskLine.matchAll(/(?:^|[/\\])ports[/\\]([a-z0-9-]+)\.port\.ts\b/gi)) {
    names.add(`${match[1].replaceAll('-', '_').toUpperCase()}_PORT`);
  }
  return [...names];
}

function expandPlanPathBraces(line) {
  const open = line.indexOf('{');
  const close = line.indexOf('}', open + 1);
  if (
    open < 0 ||
    close < 0 ||
    line.indexOf('{', open + 1) >= 0 ||
    line.indexOf('}', close + 1) >= 0
  )
    return [line];
  const choices = line
    .slice(open + 1, close)
    .split(',')
    .map((choice) => choice.trim());
  if (choices.length < 2 || choices.some((choice) => choice.length === 0)) return [line];
  const prefix = line.slice(0, open);
  const suffix = line.slice(close + 1);
  return choices.map((choice) => `${prefix}${choice}${suffix}`);
}

function planSections(planText, task) {
  const source = markdownLines(planText);
  const sectionHeadings = headings(source.lines, source.visible);
  const artifacts = taskArtifacts(task.line);
  const sectionMatches = [];
  for (const heading of sectionHeadings) {
    const end =
      sectionHeadings.find((next) => next.index > heading.index)?.index ?? source.lines.length;
    const lines = [];
    for (let index = heading.index + 1; index < end; index += 1) {
      if (!source.visible[index]) continue;
      const line = source.lines[index];
      if (
        line.includes(task.id) ||
        artifacts.some((path) => {
          const normalizedLine = line.replaceAll('\\', '/');
          const normalizedPath = path.replaceAll('\\', '/');
          return (
            normalizedLine.includes(normalizedPath) ||
            (!normalizedLine.includes('/') && normalizedLine.includes(basename(normalizedPath))) ||
            expandPlanPathBraces(normalizedLine).some((expanded) =>
              expanded.includes(normalizedPath),
            )
          );
        })
      )
        lines.push(line.trim());
    }
    if (heading.title.includes(task.id) || lines.length > 0)
      sectionMatches.push({ title: heading.line, lines });
  }
  return { source, sections: sectionMatches, interfaces: sharedInterfaces(task.line) };
}

async function taskContext(root, tasksInput, taskId, planInput) {
  const tasksFile = await repoFile(root, tasksInput, '--tasks');
  const parsed = parseTasks((await readFile(tasksFile, 'utf8')).replace(/^\uFEFF/, ''), tasksInput);
  const task = findTask(parsed, taskId, tasksInput);
  process.stdout.write(
    `Task: ${task.id}\nPhase: ${task.phase?.line ?? '(no phase heading found)'}\nCanonical task line:\n${task.line}\n`,
  );

  const constraints = taskConstraints(parsed, task);
  process.stdout.write('Task-file constraints:\n');
  process.stdout.write(
    constraints.length > 0
      ? `${constraints.map((line) => `- ${line}`).join('\n')}\n`
      : '- No additional phase or dependency note applies.\n',
  );

  if (!planInput) {
    process.stdout.write('Plan: omitted; pass --plan to retrieve matching plan context.\n');
    return;
  }
  const planFile = await repoFile(root, planInput, '--plan');
  const plan = planSections(await readFile(planFile, 'utf8'), task);
  process.stdout.write(`Matching plan sections from ${normalizedRepoPath(root, planFile)}:\n`);
  if (plan.sections.length === 0)
    process.stdout.write(
      `- No task-specific heading or target-artifact section matched ${task.id}; plan body omitted.\n`,
    );
  for (const section of plan.sections) {
    process.stdout.write(`${section.title}\n`);
    for (const line of section.lines) process.stdout.write(`${line}\n`);
  }

  process.stdout.write('Shared interfaces referenced by the task:\n');
  if (plan.interfaces.length === 0) {
    process.stdout.write('- None named in the task line or target port paths.\n');
    return;
  }
  for (const name of plan.interfaces) {
    const matches = plan.source.lines.filter(
      (line, index) => plan.source.visible[index] && line.includes(name),
    );
    process.stdout.write(
      matches.length > 0
        ? `${matches.map((line) => `- ${name}: ${line.trim()}`).join('\n')}\n`
        : `- ${name}\n`,
    );
  }
}

async function snapshot(root, files) {
  const current = await checkout(root);
  const seen = new Set();
  const declarations = [];
  for (const input of files) {
    const file = await repoFile(root, input, '--files');
    const path = normalizedRepoPath(root, file);
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (seen.has(key)) fail(`Duplicate snapshot path: ${input}`);
    seen.add(key);
    const bytes = await readFile(file);
    declarations.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, ...current, files: declarations }, null, 2)}\n`,
  );
}

function validSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshotValue = value;
  if (
    snapshotValue.schemaVersion !== 1 ||
    typeof snapshotValue.root !== 'string' ||
    !isAbsolute(snapshotValue.root) ||
    !(
      snapshotValue.branch === null ||
      (typeof snapshotValue.branch === 'string' && snapshotValue.branch.length > 0)
    ) ||
    typeof snapshotValue.head !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(snapshotValue.head) ||
    !Array.isArray(snapshotValue.files) ||
    snapshotValue.files.length === 0
  )
    return false;
  return snapshotValue.files.every(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof entry.path === 'string' &&
      entry.path.length > 0 &&
      typeof entry.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(entry.sha256),
  );
}

async function verify(root, snapshotInput) {
  const snapshotFile = await repoFile(root, snapshotInput, '--snapshot');
  let snapshotValue;
  try {
    snapshotValue = JSON.parse((await readFile(snapshotFile, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Invalid snapshot JSON in ${snapshotInput}: ${error.message}`);
  }
  if (!validSnapshot(snapshotValue))
    throw new Error(`Malformed or unsupported snapshot in ${snapshotInput}.`);
  if (!samePath(snapshotValue.root, root))
    throw new Error(`Snapshot workspace mismatch: expected ${root}, found ${snapshotValue.root}.`);
  const current = await checkout(root);
  const changed = [];
  const missing = [];
  for (const entry of snapshotValue.files) {
    const file = await repoFile(root, entry.path, 'snapshot file', true);
    let bytes;
    try {
      bytes = await readFile(file);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        missing.push(entry.path);
        continue;
      }
      throw error;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) changed.push(entry.path);
  }
  process.stdout.write(
    `Workspace: ${current.root}\nFiles: ${snapshotValue.files.length - changed.length - missing.length}/${snapshotValue.files.length} unchanged\n`,
  );
  if (snapshotValue.head !== current.head)
    process.stdout.write(`HEAD drift: ${snapshotValue.head} -> ${current.head}\n`);
  if (snapshotValue.branch !== current.branch)
    process.stdout.write(
      `Branch drift: ${snapshotValue.branch ?? '(detached)'} -> ${current.branch ?? '(detached)'}\n`,
    );
  if (changed.length > 0 || missing.length > 0) {
    for (const path of changed) process.stderr.write(`Changed: ${path}\n`);
    for (const path of missing) process.stderr.write(`Missing: ${path}\n`);
    throw new Error('Snapshot is stale; declared files changed or are missing.');
  }
  process.stdout.write('Declared file content matches the snapshot.\n');
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const values = args.values;
  const root = await resolveRoot(values.get('--root'));
  if (args.mode === 'assignment') return assignment(root, values.get('--uc'));
  if (args.mode === 'handoff') return handoff(root, values.get('--tasks'));
  if (args.mode === 'resume') return resumeReport(root, values.get('--tasks'), args.authorization);
  if (args.mode === 'task')
    return taskContext(root, values.get('--tasks'), values.get('--task'), values.get('--plan'));
  if (args.mode === 'snapshot') return snapshot(root, args.files);
  return verify(root, values.get('--snapshot'));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
