import { readFile } from 'node:fs/promises';
import { validateTaskLedger } from './planning-workflow.mjs';
import { readWorkerState } from './agent-context-resume.mjs';
import { samePath as canonicalSamePath } from './agent-store.mjs';
import { checkout, fail, markdownLines, normalizedRepoPath, parseTasks, repoFile } from './agent-context-common.mjs';

function expandScopes(scopes, parsed, path) {
  if (!scopes.length) fail('batch and review-ready require at least one --scope.');
  const byId = new Map(parsed.tasks.map((task) => [task.id, task]));
  const selected = new Set();
  for (const scope of scopes) {
    const match = scope.match(/^(T\d{3})(?:-(T\d{3}))?$/);
    if (!match) fail(`Invalid scope ${scope}; use a canonical task ID or range such as T057-T061.`);
    const start = Number(match[1].slice(1));
    const end = match[2] ? Number(match[2].slice(1)) : start;
    if (end < start) fail(`Invalid descending scope range ${scope}.`);
    for (let number = start; number <= end; number += 1) {
      const id = `T${String(number).padStart(3, '0')}`;
      if (!byId.has(id)) fail(`Unknown scope task ID ${id} in ${path}.`);
      selected.add(id);
    }
  }
  return selected;
}

function pathKey(path) {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsOverlap(left, right) {
  const a = pathKey(left);
  const b = pathKey(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function safeRegisteredPaths(paths) {
  if (!Array.isArray(paths)) return [];
  return [...new Set(paths.filter((path) => typeof path === 'string' && path.trim())
    .map((path) => path.replaceAll('\\', '/').replace(/^\.\//, ''))
    .filter((path) => !path.startsWith('/') && !/^[A-Za-z]:/.test(path) && !path.split('/').includes('..')))];
}

function taskSummary(task) {
  return task.line.replace(/^\s*[-*+]\s+\[[ xX]\]\s+T\d{3}\s*/, '').trim();
}

function dependencyDetails(task, byId) {
  if (!task.dependenciesDeclared) return { state: 'unspecified', dependencies: [] };
  const dependencies = task.dependencies.map((id) => {
    const entry = byId.get(id);
    return { id, state: entry ? (entry.checked ? 'checked' : 'open') : 'external-unresolved' };
  });
  return {
    state: dependencies.every((dependency) => dependency.state === 'checked') ? 'ready' : 'waiting',
    dependencies,
  };
}

async function scopedWorkers(root, closureIds, tasks, parsedPaths, session) {
  const state = await readWorkerState(root);
  const worktreePaths = state.worktrees.map((entry) => entry.worktree).filter(Boolean);
  const closurePaths = [...new Set([...closureIds].flatMap((id) => parsedPaths.get(id) ?? []))];
  const entries = [];
  for (const entry of state.entries) {
    if (entry.role !== 'worker' || !['active', 'blocked', 'handed-off'].includes(entry.status)) continue;
    if (typeof entry.checkout !== 'string' || !entry.checkout || (session && entry.session !== session)) continue;
    let inRepository = false;
    for (const worktree of worktreePaths) {
      if (await canonicalSamePath(worktree, entry.checkout)) {
        inRepository = true;
        break;
      }
    }
    if (!inRepository) continue;
    const ownedPaths = safeRegisteredPaths(entry.ownedPaths);
    const taskMatches = closureIds.has(entry.task);
    const pathsMatch = ownedPaths.some((owned) => closurePaths.some((path) => pathsOverlap(owned, path)));
    if (!taskMatches && !pathsMatch) continue;
    const task = tasks.get(entry.task);
    entries.push({
      owner: entry.owner,
      task: entry.task,
      status: entry.status,
      session: entry.session ?? null,
      summary: entry.summary,
      ownedPaths,
      checked: task?.checked ?? false,
    });
  }
  return entries;
}

export async function batchContext(root, tasksInput, scopes, authorizedIds = [], options = {}) {
  const current = await checkout(root);
  const tasksFile = await repoFile(root, tasksInput, '--tasks');
  const taskText = (await readFile(tasksFile, 'utf8')).replace(/^\uFEFF/, '');
  const parsed = parseTasks(taskText, tasksInput);
  const planningSource = markdownLines(taskText);
  const planningText = planningSource.lines.map((line, index) => planningSource.visible[index] ? line : '').join('\n');
  const planning = validateTaskLedger(planningText);
  if (planning.tasks.length !== parsed.tasks.length || parsed.tasks.some((task, index) => planning.tasks[index]?.id !== task.id)) {
    fail('Task checkbox parsing differs from the canonical planning ledger parser.');
  }
  if (planning.p0.length) {
    fail(`Task ledger has invalid canonical task or dependency data: ${planning.p0.map((issue) => issue.message).join('; ')}`);
  }

  const selectedIds = expandScopes(scopes, parsed, tasksInput);
  const byId = new Map(parsed.tasks.map((task) => [task.id, task]));
  const selectedOrder = parsed.tasks.filter((task) => selectedIds.has(task.id));
  const authorized = new Set();
  for (const id of authorizedIds) {
    if (!/^T\d{3}$/.test(id)) fail(`Invalid --authorized task ID ${id}; use a canonical ID such as T057.`);
    if (!byId.has(id)) fail(`Unknown authorized task ID ${id} in ${tasksInput}.`);
    authorized.add(id);
  }

  const closureIds = new Set();
  const visit = (id) => {
    if (closureIds.has(id)) return;
    closureIds.add(id);
    const task = byId.get(id);
    for (const dependency of task.dependencies) {
      if (dependency.startsWith('T')) visit(dependency);
    }
  };
  for (const id of selectedIds) visit(id);

  const planned = new Map((planning.tasks ?? []).map((task) => [task.id, task]));
  const pathsById = new Map(parsed.tasks.map((task) => [task.id, planned.get(task.id)?.filePaths ?? []]));
  const closureTasks = parsed.tasks.filter((task) => closureIds.has(task.id));
  const selected = selectedOrder.map((task) => ({
    id: task.id,
    checked: task.checked,
    phase: task.phase?.title ?? null,
    summary: taskSummary(task),
    dependencies: dependencyDetails(task, byId),
    paths: pathsById.get(task.id),
    authorization: task.checked ? 'not-needed-for-checked-task' : (authorized.has(task.id) ? 'provided-by-caller' : 'missing'),
  }));
  const prerequisites = closureTasks.filter((task) => !selectedIds.has(task.id)).map((task) => ({
    id: task.id,
    checked: task.checked,
  }));

  const ready = closureTasks.filter((task) => {
    if (task.checked || !task.dependenciesDeclared) return false;
    return dependencyDetails(task, byId).state === 'ready';
  });
  const conflicts = [];
  for (let left = 0; left < ready.length; left += 1) {
    for (let right = left + 1; right < ready.length; right += 1) {
      for (const leftPath of pathsById.get(ready[left].id) ?? []) {
        for (const rightPath of pathsById.get(ready[right].id) ?? []) {
          if (pathsOverlap(leftPath, rightPath)) {
            const path = leftPath.length <= rightPath.length ? leftPath : rightPath;
            if (!conflicts.some((conflict) => conflict.path === path && conflict.tasks.includes(ready[left].id) && conflict.tasks.includes(ready[right].id))) {
              conflicts.push({ path, tasks: [ready[left].id, ready[right].id], kind: 'ready-frontier-path-overlap', blocking: true });
            }
          }
        }
      }
    }
  }

  const workers = await scopedWorkers(root, closureIds, byId, pathsById, options.session);
  for (const worker of workers) {
    const workerPaths = worker.ownedPaths;
    for (const task of ready) {
      if (worker.task === task.id) continue;
      for (const taskPath of pathsById.get(task.id) ?? []) {
        const path = workerPaths.find((owned) => pathsOverlap(owned, taskPath));
        if (path) {
          const conflictPath = path.length <= taskPath.length ? path : taskPath;
          const kind = `${worker.status}-worker-path-overlap`;
          if (!conflicts.some((conflict) => conflict.path === conflictPath && conflict.kind === kind &&
            conflict.tasks.includes(task.id) && conflict.tasks.includes(worker.task))) {
            conflicts.push({
              path: conflictPath,
              tasks: [task.id, worker.task],
              worker: worker.owner,
              kind,
              blocking: true,
            });
          }
        }
      }
    }
  }

  const missingAuthorization = closureTasks.filter((task) => !task.checked && !authorized.has(task.id)).map((task) => task.id);
  const unusedAuthorization = [...authorized].filter((id) => !closureIds.has(id));
  const blockers = {
    unchecked: closureTasks.filter((task) => !task.checked).map((task) => task.id),
    dependenciesUnspecified: closureTasks.filter((task) => !task.dependenciesDeclared).map((task) => task.id),
    unresolvedExternalDependencies: closureTasks.flatMap((task) =>
      dependencyDetails(task, byId).dependencies.filter((dependency) => dependency.state === 'external-unresolved')
        .map((dependency) => ({ task: task.id, dependency: dependency.id }))),
    liveWorkers: workers.filter((worker) => ['active', 'blocked'].includes(worker.status)),
    unintegratedHandoffs: workers.filter((worker) => worker.status === 'handed-off' && !worker.checked),
    conflicts: conflicts.filter((conflict) => conflict.blocking),
  };
  const blocked = Object.values(blockers).some((items) => items.length > 0);
  const report = {
    mode: options.reviewReady ? 'review-ready' : 'batch',
    status: options.reviewReady ? (options.noReview ? 'skipped' : (blocked ? 'blocked' : 'ready')) : 'brief',
    checkout: current.root,
    branch: current.branch,
    tasksPath: normalizedRepoPath(root, tasksFile),
    session: options.session ?? null,
    selected: selected.map((task) => task.id),
    dependencyClosure: closureTasks.map((task) => task.id),
    tasks: selected,
    prerequisites,
    readyFrontier: ready.map((task) => ({
      id: task.id,
      paths: pathsById.get(task.id),
      authorization: authorized.has(task.id) ? 'provided-by-caller' : 'missing',
    })),
    conflicts,
    workers,
    missingAuthorization,
    unusedAuthorization,
    blockers,
    authorizationNote: 'Dependencies never grant authorization; only --authorized IDs are caller-provided. This report does not authorize work.',
  };
  if (options.reviewReady) {
    report.review = {
      status: options.noReview ? 'skipped' : (blocked ? 'blocked' : 'ready'),
      reviewed: false,
      acceptanceCertified: false,
      note: options.noReview
        ? 'Review was explicitly skipped; no review or acceptance is certified.'
        : 'Ready for review only; ledger checkboxes and settled matching work are logistics, not proof of acceptance.',
    };
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
