import { posix } from 'node:path';

function collectPathReferences(text) {
  const paths = [];
  const ambiguousRoots = [];
  const codePaths = [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]);
  const plainText = text.replace(/`[^`]*`/g, ' ').replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
  const pathPattern = /(?:[A-Za-z]:\/|\.{1,2}\/|\/{1,2}|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?|[A-Za-z0-9_.-]+\//g;
  const addSlashPaths = (source, explicit = false) => {
    const normalizedSeparators = source.replaceAll('\\', '/');
    for (const match of normalizedSeparators.matchAll(pathPattern)) {
      const candidate = match[0].replace(/[.,;:!?)\]}]+$/, '');
      if (explicit || candidate.includes('.') || candidate.endsWith('/') || /^\.{1,2}\//.test(candidate) || /^[A-Za-z]:\//.test(candidate) || candidate.startsWith('/')) {
        paths.push(candidate);
      }
    }
  };
  addSlashPaths(plainText);
  for (const codePath of codePaths) {
    addSlashPaths(codePath, true);
    if (!codePath.includes('/') && !codePath.includes('\\') && codePath.trim()) paths.push(codePath.trim());
  }

  for (const match of plainText.matchAll(/\b[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+\b/g)) {
    const candidate = match[0];
    const before = plainText[match.index - 1];
    if (before === '/' || before === '\\') continue;
    if (!/\.[a-z][a-z0-9]*$/i.test(candidate)) continue;
    if (/^\d+(?:\.\d+)+$/.test(candidate)) continue;
    if (/^(?:e\.g|i\.e)\.?$/i.test(candidate)) continue;
    if (['node.js', 'vue.js', 'react.js'].includes(candidate.toLowerCase()) || /^[A-Z][A-Za-z0-9_-]*\.js$/.test(candidate)) continue;
    if (['package.json', 'tsconfig.json'].includes(candidate.toLowerCase()) || /^eslint\.config\.[A-Za-z0-9_-]+$/i.test(candidate)) {
      paths.push(candidate);
    } else {
      ambiguousRoots.push(candidate);
    }
  }

  return { paths: [...new Set(paths)], ambiguousRoots: [...new Set(ambiguousRoots)] };
}

function normalizeRepoPath(value) {
  const candidate = value.replaceAll('\\', '/').trim();
  if (!candidate || candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate)) return undefined;
  const normalized = posix
    .normalize(candidate)
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

export function validateTaskLedger(tasksContent) {
  const p0 = [];
  const p1 = [];
  const tasks = [];
  const seenTaskIds = new Set();
  const dependencyEdges = [];
  const lines = tasksContent.split('\n');

  let currentPhase = '';
  let isStoryPhase = false;
  let isDependenciesSection = false;
  let dependencySectionLevel = 0;
  let currentTask;

  // Track parallel tasks per phase for collision detection
  const parallelTasksByPhase = new Map();

  const readPaths = (text, task, lineNum, { allowBareRoots = false } = {}) => {
    const refs = collectPathReferences(text);
    for (const filePath of refs.paths) {
      const normalized = normalizeRepoPath(filePath);
      if (!normalized) {
        p0.push({ code: 'INVALID_FILE_PATH', message: `Task ${task.id} has an absolute or outside path: "${filePath}"`, line: lineNum, task: task.id });
      } else {
        task.filePaths.push(normalized);
      }
    }
    for (const filePath of refs.ambiguousRoots) {
      if (allowBareRoots) {
        const normalized = normalizeRepoPath(filePath);
        if (normalized) task.filePaths.push(normalized);
      } else {
        task.ambiguousRootPaths.push({ filePath, line: lineNum });
      }
    }
    return refs.paths.length > 0 || refs.ambiguousRoots.length > 0;
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx];
    const line = rawLine.trim();
    const lineNum = idx + 1;

    if (line.startsWith('#')) {
      const heading = line.match(/^(#+)\s*(.*)$/);
      const level = heading?.[1].length ?? 0;
      const title = heading?.[2] ?? '';
      if (/^Dependencies\b/i.test(title)) {
        isDependenciesSection = true;
        dependencySectionLevel = level;
      } else if (isDependenciesSection && level <= dependencySectionLevel) {
        isDependenciesSection = false;
      }
      currentPhase = line;
      isStoryPhase = /User Story/i.test(line) || (/Phase\s+[3-9]/i.test(line) && !/Cross-Cutting|Polish|Integration|correction/i.test(line));
      currentTask = undefined;
      continue;
    }

    if (isDependenciesSection) {
      const declaration = line.replace(/^[-*]\s+/, '');
      const arrow = declaration.match(/^((?:T\d{3}(?:\s*,\s*T\d{3})*))\s*->\s*((?:T\d{3}(?:\s*,\s*T\d{3})*))[.]?$/);
      const follows = declaration.match(/^((?:T\d{3}(?:\s*,\s*T\d{3})*))\s+follows\s+((?:T\d{3}(?:\s*,\s*T\d{3})*))[.]?$/i);
      const chain = declaration.match(/^(T\d{3}(?:\s*(?:-->|->|→)\s*T\d{3})+)/);
      const addEdges = (prerequisites, dependents) => {
        for (const prerequisite of prerequisites.split(/\s*,\s*/).filter(Boolean)) {
          for (const dependent of dependents.split(/\s*,\s*/).filter(Boolean)) {
            dependencyEdges.push({ prerequisite, dependent, line: lineNum });
          }
        }
      };

      if (declaration.includes('-->')) {
        const parseGroup = group => {
          const nodes = group.split(/\s*&\s*/).map(node => node.trim());
          if (!nodes.length || nodes.some(node => !/^(?:T\d{3}|X[A-Za-z0-9_-]+(?:\[[^\]]+\])?)$/.test(node))) return undefined;
          return nodes.filter(node => /^T\d{3}$/.test(node));
        };
        const groups = declaration.split(/\s*-->\s*/).map(parseGroup);
        if (groups.length < 2 || groups.some(group => group === undefined)) {
          p0.push({ code: 'MALFORMED_DEPENDENCY', message: `Malformed dependency declaration: "${line}"`, line: lineNum });
        } else {
          for (let index = 0; index < groups.length - 1; index += 1) {
            addEdges(groups[index].join(', '), groups[index + 1].join(', '));
          }
        }
      } else if (arrow) {
        addEdges(arrow[1], arrow[2]);
      } else if (follows) {
        addEdges(follows[2], follows[1]);
      } else if (chain && !/^(?:-->|->|→)/.test(declaration.slice(chain[0].length).trim())) {
        const ids = chain[0].match(/T\d{3}/g);
        for (let index = 0; index < ids.length - 1; index += 1) addEdges(ids[index], ids[index + 1]);
      } else if (/^T\d+\b/.test(declaration)) {
        p0.push({ code: 'MALFORMED_DEPENDENCY', message: `Malformed dependency declaration: "${line}"`, line: lineNum });
      }
      continue;
    }

    const dependencyMetadata = line.match(/^\s*-\s+\*\*Dependencies\*\*:\s*(.*)$/i);
    if (dependencyMetadata) {
      const value = dependencyMetadata[1].trim();
      const internal = value.split(';', 1)[0].trim().replace(/[.]$/, '');
      if (!currentTask || !internal) {
        p0.push({ code: 'MALFORMED_DEPENDENCY', message: `Malformed dependency declaration: "${line}"`, line: lineNum });
      } else if (!/^None(?:\s+internally)?$/i.test(internal)) {
        if (!/^(?:T\d{3})(?:\s*,\s*T\d{3})*$/.test(internal)) {
          p0.push({ code: 'MALFORMED_DEPENDENCY', message: `Malformed dependency declaration for ${currentTask.id}: "${line}"`, line: lineNum, task: currentTask.id });
        } else {
          for (const prerequisite of internal.split(/\s*,\s*/)) {
            dependencyEdges.push({ prerequisite, dependent: currentTask.id, line: lineNum });
          }
        }
      }
      continue;
    }

    const ownedPathsMetadata = line.match(/^\s*-\s+\*\*Owned Paths\*\*:\s*(.*)$/i);
    if (ownedPathsMetadata && currentTask) {
      const ownedTask = { ...currentTask, filePaths: [], ambiguousRootPaths: [] };
      const hasOwnedPathReference = readPaths(ownedPathsMetadata[1], ownedTask, lineNum, { allowBareRoots: true });
      currentTask.hasPathReference = currentTask.hasPathReference || hasOwnedPathReference;
      currentTask.ownedPathsDeclared = true;
      currentTask.ambiguousRootPaths = [];
      if (ownedTask.filePaths.length > 0) currentTask.filePaths = [...new Set(ownedTask.filePaths)];
      continue;
    }

    // Check for malformed lines like "T002 Missing checkbox..."
    if (/^T\d{3}\b/.test(line)) {
      p0.push({
        code: 'MALFORMED_TASK_SYNTAX',
        message: `Task line missing checkbox: "${line}"`,
        line: lineNum,
      });
      continue;
    }

    if (line.startsWith('- [ ]') || line.startsWith('- [x]') || line.startsWith('- [X]')) {
      const taskMatch = line.match(/^- \[[ xX]\]\s+(T\d{3})\b(.*)$/);
      if (!taskMatch) {
        p0.push({
          code: 'MALFORMED_TASK_SYNTAX',
          message: `Task line missing canonical T### task ID: "${line}"`,
          line: lineNum,
        });
        continue;
      }

      const id = taskMatch[1];
      const remainder = taskMatch[2];

      const expectedId = `T${String(tasks.length + 1).padStart(3, '0')}`;
      if (seenTaskIds.has(id)) {
        p0.push({ code: 'DUPLICATE_TASK_ID', message: `Task ID ${id} is declared more than once`, line: lineNum, task: id });
      }
      seenTaskIds.add(id);
      if (id !== expectedId) {
        p0.push({ code: 'NONSEQUENTIAL_TASK_ID', message: `Expected ${expectedId} but found ${id}`, line: lineNum, task: id });
      }

      const isParallel = /\[P\]/.test(remainder);
      const storyMatch = remainder.match(/\[(US\d+)\]/i);
      const story = storyMatch ? storyMatch[1].toUpperCase() : undefined;

      if (isStoryPhase && !story) {
        p0.push({
          code: 'MISSING_STORY_TAG',
          message: `Task ${id} in user story phase missing [US#] tag: "${line}"`,
          line: lineNum,
        });
      }

      const task = { id, isParallel, story, description: remainder.trim(), filePaths: [], ambiguousRootPaths: [], hasPathReference: false, phase: currentPhase, line: lineNum };
      task.hasPathReference = readPaths(remainder, task, lineNum);
      if (isParallel) {
        if (!parallelTasksByPhase.has(currentPhase)) parallelTasksByPhase.set(currentPhase, []);
        parallelTasksByPhase.get(currentPhase).push(task);
      }
      tasks.push(task);
      currentTask = task;
    }
  }

  for (const task of tasks) {
    if (task.filePaths.length === 0 && !task.hasPathReference) {
      p0.push({ code: 'MISSING_FILE_PATH', message: `Task ${task.id} is missing an explicit file path: "${lines[task.line - 1].trim()}"`, line: task.line, task: task.id });
    }
    if (!task.ownedPathsDeclared) {
      for (const { filePath, line } of task.ambiguousRootPaths) {
        p0.push({ code: 'AMBIGUOUS_ROOT_PATH', message: `Root file ${filePath} must be written in backticks or with a ./ prefix`, line, task: task.id });
      }
    }
  }

  const dependencyGraph = new Map(tasks.map(task => [task.id, []]));
  for (const edge of dependencyEdges) {
    if (dependencyGraph.has(edge.prerequisite) && dependencyGraph.has(edge.dependent)) {
      dependencyGraph.get(edge.prerequisite).push(edge.dependent);
    }
  }
  const dependencyPrecedes = (prerequisite, dependent) => {
    const visited = new Set();
    const pending = [...(dependencyGraph.get(prerequisite) ?? [])];
    while (pending.length) {
      const next = pending.pop();
      if (next === dependent) return true;
      if (!visited.has(next)) {
        visited.add(next);
        pending.push(...(dependencyGraph.get(next) ?? []));
      }
    }
    return false;
  };

  for (const phaseTasks of parallelTasksByPhase.values()) {
    for (let i = 0; i < phaseTasks.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        if (dependencyPrecedes(phaseTasks[i].id, phaseTasks[j].id) || dependencyPrecedes(phaseTasks[j].id, phaseTasks[i].id)) continue;
        const commonFiles = [];
        for (const left of phaseTasks[i].filePaths) {
          for (const right of phaseTasks[j].filePaths) {
            if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
              commonFiles.push(left.length <= right.length ? left : right);
            }
          }
        }
        if (commonFiles.length > 0) {
          const sharedPaths = [...new Set(commonFiles)];
          p0.push({
            code: 'PARALLEL_FILE_COLLISION',
            message: `Parallel task ${phaseTasks[i].id} collides with ${phaseTasks[j].id} on shared path(s): ${sharedPaths.join(', ')}`,
            line: phaseTasks[i].line,
            task: phaseTasks[i].id,
          });
        }
      }
    }
  }

  const taskIds = new Set(tasks.map(task => task.id));
  const graph = new Map([...taskIds].map(id => [id, []]));
  const cycleEdges = [];
  for (const edge of dependencyEdges) {
    if (!taskIds.has(edge.prerequisite) || !taskIds.has(edge.dependent)) {
      p0.push({
        code: 'UNKNOWN_DEPENDENCY_TASK',
        message: `${edge.dependent} references unknown task ${!taskIds.has(edge.prerequisite) ? edge.prerequisite : edge.dependent}`,
        line: edge.line,
        task: edge.dependent,
      });
      continue;
    }
    if (edge.prerequisite === edge.dependent) {
      p0.push({ code: 'SELF_DEPENDENCY', message: `${edge.dependent} cannot depend on itself`, line: edge.line, task: edge.dependent });
      continue;
    }
    graph.get(edge.prerequisite).push(edge.dependent);
    cycleEdges.push(edge);
  }

  const state = new Map();
  const stack = [];
  const reportedCycles = new Set();
  const visit = id => {
    state.set(id, 1);
    stack.push(id);
    for (const dependent of graph.get(id) ?? []) {
      if (state.get(dependent) === 1) {
        const cycle = stack.slice(stack.indexOf(dependent));
        const key = [...cycle].sort().join(',');
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          const edge = cycleEdges.find(item => item.prerequisite === id && item.dependent === dependent);
          p0.push({ code: 'DEPENDENCY_CYCLE', message: `Dependency cycle includes ${[...cycle, dependent].join(' -> ')}`, line: edge?.line });
        }
      } else if (!state.has(dependent)) {
        visit(dependent);
      }
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of graph.keys()) {
    if (!state.has(id)) visit(id);
  }

  const valid = p0.length === 0 && p1.length === 0;
  return { valid, tasks, p0, p1 };
}
