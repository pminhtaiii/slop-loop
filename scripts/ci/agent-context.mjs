import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const usage = `Usage:
  node scripts/ci/agent-context.mjs handoff --tasks <tasks.md> [--root <checkout>]
  node scripts/ci/agent-context.mjs task --tasks <tasks.md> --task T017 [--plan <plan.md>] [--root <checkout>]
  node scripts/ci/agent-context.mjs snapshot --files <repo-relative-file...> [--root <checkout>]
  node scripts/ci/agent-context.mjs verify --snapshot <snapshot.json> [--root <checkout>]
  node scripts/ci/agent-context.mjs --help`;

function fail(message) {
  throw new Error(`${message}\n\n${usage}`);
}

function parseArguments(argv) {
  if (argv.length === 0 || (argv.length === 1 && ['--help', '-h'].includes(argv[0]))) {
    return { help: true };
  }
  const mode = argv[0];
  if (!['handoff', 'task', 'snapshot', 'verify'].includes(mode)) fail(`Unknown mode: ${mode}`);
  if (argv.slice(1).includes('--help') || argv.slice(1).includes('-h')) {
    if (argv.length === 2) return { help: true };
    fail('Help cannot be combined with other options.');
  }

  const values = new Map();
  const files = [];
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
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
    if (!['--tasks', '--task', '--plan', '--snapshot', '--root'].includes(option)) {
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
    handoff: ['--tasks', '--root'],
    task: ['--tasks', '--task', '--plan', '--root'],
    snapshot: ['--files', '--root'],
    verify: ['--snapshot', '--root'],
  }[mode];
  for (const option of values.keys()) {
    if (!allowed.includes(option)) fail(`${option} is not valid for ${mode}.`);
  }
  for (const required of {
    handoff: ['--tasks'],
    task: ['--tasks', '--task'],
    snapshot: ['--files'],
    verify: ['--snapshot'],
  }[mode]) {
    if (!values.has(required)) fail(`${mode} requires ${required}.`);
  }
  if (mode === 'task' && !/^T\d{3}$/.test(values.get('--task'))) {
    fail(`Invalid task ID ${values.get('--task')}; use a canonical ID such as T017.`);
  }
  return { mode, values, files };
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
  if (args.mode === 'handoff') return handoff(root, values.get('--tasks'));
  if (args.mode === 'task')
    return taskContext(root, values.get('--tasks'), values.get('--task'), values.get('--plan'));
  if (args.mode === 'snapshot') return snapshot(root, args.files);
  return verify(root, values.get('--snapshot'));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
