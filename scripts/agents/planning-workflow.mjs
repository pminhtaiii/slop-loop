import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

async function fileExists(path) {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(path) {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function validateArtifacts({ featureDir, root = process.cwd() }) {
  const dir = resolve(root, featureDir);
  const p0 = [];
  const p1 = [];
  const p2 = [];

  const requiredArtifacts = [
    ['spec.md', 'MISSING_SPEC', fileExists],
    ['plan.md', 'MISSING_PLAN', fileExists],
    ['tasks.md', 'MISSING_TASKS', fileExists],
    ['research.md', 'MISSING_RESEARCH', fileExists],
    ['data-model.md', 'MISSING_DATA_MODEL', fileExists],
    ['quickstart.md', 'MISSING_QUICKSTART', fileExists],
    ['contracts', 'MISSING_CONTRACTS', directoryExists],
  ];
  for (const [name, code, check] of requiredArtifacts) {
    if (!await check(join(dir, name))) {
      p0.push({ code, message: `${name} is missing from feature directory`, file: name });
    }
  }

  // Check for unresolved clarification markers in planning docs
  const checkClarifications = async (filename) => {
    const filePath = join(dir, filename);
    if (await fileExists(filePath)) {
      const content = await readFile(filePath, 'utf8');
      if (content.includes('NEEDS CLARIFICATION') || content.includes('NEEDS_CLARIFICATION')) {
        p1.push({
          code: 'UNRESOLVED_CLARIFICATION',
          message: `Unresolved clarification marker found in ${filename}`,
          file: filename,
        });
      }
    }
  };

  const filesToCheck = [
    'spec.md',
    'plan.md',
    'research.md',
    'data-model.md',
    'quickstart.md',
    'tasks.md',
  ];

  const contractsDir = join(dir, 'contracts');
  if (await directoryExists(contractsDir)) {
    const scanContracts = async (currentDir, relPrefix) => {
      const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const relPath = `${relPrefix}/${entry.name}`;
        if (entry.isDirectory()) {
          await scanContracts(join(currentDir, entry.name), relPath);
        } else if (entry.isFile()) {
          filesToCheck.push(relPath);
        }
      }
    };
    await scanContracts(contractsDir, 'contracts');
  }

  for (const filename of filesToCheck) {
    await checkClarifications(filename);
  }

  const valid = p0.length === 0 && p1.length === 0;
  return { valid, p0, p1, p2 };
}

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
  const normalized = posix.normalize(candidate).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
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

export async function generateReviewBrief({ featureDir, role = 'standards', root = process.cwd() }) {
  if (!['standards', 'testability'].includes(role)) {
    throw new Error(`Unknown review role: ${role} (expected standards|testability)`);
  }
  const dir = resolve(root, featureDir);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const targetFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => entry.name);
  if (await directoryExists(join(dir, 'contracts'))) targetFiles.push('contracts/');
  const addContractFiles = async (contractDir, prefix) => {
    const children = await readdir(contractDir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      const name = `${prefix}/${child.name}`;
      if (child.isDirectory()) await addContractFiles(join(contractDir, child.name), name);
      else if (child.isFile()) targetFiles.push(name);
    }
  };
  await addContractFiles(join(dir, 'contracts'), 'contracts');
  targetFiles.sort();

  const roleTitle = role === 'standards'
    ? 'Standards & Architecture Reviewer'
    : 'Testability & Edge Cases Reviewer';

  const roleFocus = role === 'standards'
    ? `- Alignment with constitution principles (.specify/memory/constitution.md) and architecture boundaries (context/architecture.md)
- Tool access and permission boundaries (context/tools_permissions.md) and state policies (context/runtime_policy.md)
- Deep module seams and avoidance of unnecessary coupling`
    : `- Unambiguous, testable acceptance criteria for every user story
- Failure mode, timeout, unexpected input, and edge-case coverage
- Completeness of contracts in contracts/ and corresponding verification tasks in tasks.md`;

  const prompt = `# Planning Review Brief: ${roleTitle}
Feature Directory: ${featureDir}

You are acting as the **${roleTitle}**. Your mission is to audit the planning and specification artifacts in "${featureDir}" before implementation begins.

## Review Scope & Focus
${roleFocus}

Target Files to Inspect:
${targetFiles.map(f => `- ${f}`).join('\n')}

## Issue Severity Guidelines
- **P0 (Critical / Blocker)**: Defect that makes implementation impossible, inconsistent, or hazardous. Contradictory criteria, invalid syntax, policy/permission violations, broken dependencies. Blocks implementation!
- **P1 (Major)**: Gaps or ambiguities that risk incorrect implementation or test failures. Unresolved clarifications, missing edge-case criteria, orphan contracts, untestable criteria. Blocks implementation!
- **P2 (Advisory / Minor)**: Non-blocking polish, stylistic improvements, documentation enhancements.

## Output Format
Provide your findings in a structured Markdown table:

| Severity | Code | Title | Description | Recommendation |
|---|---|---|---|---|
| P0/P1/P2 | <UPPER_SNAKE_CODE> | <Short Title> | <Description of issue> | <Actionable fix> |

If no issues are found, state: "No blocking issues found."
`;

  return { role, targetFiles, prompt };
}

export function parseReviewFindings(markdownContent) {
  const p0 = [];
  const p1 = [];
  const p2 = [];
  const errors = [];
  const outsideFence = [];
  let fence;
  let fenceLength = 0;
  for (const line of String(markdownContent ?? '').split('\n')) {
    const marker = line.trim().match(/^(`{3,}|~{3,})/);
    if (marker && !fence) {
      fence = marker[1][0];
      fenceLength = marker[1].length;
    } else if (marker && marker[1][0] === fence && marker[1].length >= fenceLength) {
      fence = undefined;
    } else if (!fence) {
      outsideFence.push(line.trim());
    }
  }

  const reportLines = outsideFence.filter(Boolean);
  const tableLines = reportLines.filter(line => line.startsWith('|'));
  const proseLines = reportLines.filter(line => !line.startsWith('|') && !/^#{1,6}\s/.test(line));
  const standaloneNoBlockers = tableLines.length === 0
    && proseLines.length === 1
    && proseLines[0] === 'No blocking issues found.';

  if (!tableLines.length && !standaloneNoBlockers) {
    errors.push('Review must contain a findings table or a standalone "No blocking issues found." declaration');
  }
  if (tableLines.length && proseLines.length > 0) {
    errors.push('A findings table must not be mixed with prose or a standalone no-blocking declaration');
  }

  if (tableLines.length) {
    const splitRow = line => {
      let body = line.trim();
      if (body.startsWith('|')) body = body.slice(1);
      if (body.endsWith('|')) body = body.slice(0, -1);
      return body.split('|').map(cell => cell.trim());
    };
    const expectedHeader = ['Severity', 'Code', 'Title', 'Description', 'Recommendation'];
    let headerSeen = false;
    let separatorSeen = false;
    let rowCount = 0;
    for (const line of tableLines) {
      const cells = splitRow(line);
      if (!headerSeen) {
        if (cells.length === expectedHeader.length && cells.every((cell, index) => cell.toLowerCase() === expectedHeader[index].toLowerCase())) {
          headerSeen = true;
        } else {
          errors.push('Findings table must start with the five required column headings');
        }
        continue;
      }
      if (!separatorSeen) {
        if (cells.length === expectedHeader.length && cells.every(cell => /^:?-{3,}:?$/.test(cell))) {
          separatorSeen = true;
        } else {
          errors.push('Findings table must include a five-column separator row');
        }
        continue;
      }
      if (cells.length !== expectedHeader.length) {
        errors.push(`Malformed findings row: "${line}"`);
        continue;
      }
      const [severity, code, title, description, recommendation] = cells;
      const upperSeverity = severity.toUpperCase();
      if (!['P0', 'P1', 'P2'].includes(upperSeverity) || [code, title, description, recommendation].some(value => !value)) {
        errors.push(`Malformed finding severity or empty field: "${line}"`);
        continue;
      }
      const item = { severity: upperSeverity, code, title, description, recommendation };
      if (upperSeverity === 'P0') p0.push(item);
      else if (upperSeverity === 'P1') p1.push(item);
      else p2.push(item);
      rowCount += 1;
    }
    if (!headerSeen || !separatorSeen || rowCount === 0) errors.push('Findings table has no valid finding rows');
  }

  const valid = errors.length === 0;
  const passed = valid && p0.length === 0 && p1.length === 0;
  return { valid, passed, p0, p1, p2, errors };
}

export async function runPlanningWorkflow({
  action,
  featureDir,
  role = 'standards',
  reviewContent,
  reviewPath,
  root = process.cwd(),
}) {
  if (action === 'validate') {
    if (!featureDir) throw new Error('validate action requires --dir <featureDir>');
    const artifactRes = await validateArtifacts({ featureDir, root });
    const tasksPath = join(resolve(root, featureDir), 'tasks.md');
    let taskRes = { valid: true, tasks: [], p0: [], p1: [] };
    if (await fileExists(tasksPath)) {
      const content = await readFile(tasksPath, 'utf8');
      taskRes = validateTaskLedger(content);
    }
    const p0 = [...artifactRes.p0, ...taskRes.p0];
    const p1 = [...artifactRes.p1, ...taskRes.p1];
    const p2 = [...artifactRes.p2];
    const status = p0.length === 0 && p1.length === 0 ? 'passed' : 'failed';
    return {
      action: 'validate',
      status,
      p0,
      p1,
      p2,
      tasks: taskRes.tasks,
    };
  }

  if (action === 'review-brief') {
    if (!featureDir) throw new Error('review-brief action requires --dir <featureDir>');
    return generateReviewBrief({ featureDir, role, root });
  }

  if (action === 'evaluate-review') {
    let content = reviewContent;
    if (!content && reviewPath) {
      content = await readFile(resolve(root, reviewPath), 'utf8');
    }
    if (!content) throw new Error('evaluate-review requires --review <file> or reviewContent');
    const findings = parseReviewFindings(content);
    return {
      action: 'evaluate-review',
      status: findings.passed ? 'passed' : 'failed',
      ...findings,
    };
  }

  if (action === 'status') {
    if (!featureDir) throw new Error('status action requires --dir <featureDir>');
    const validateRes = await runPlanningWorkflow({ action: 'validate', featureDir, root });
    const automatedValidationPassed = validateRes.status === 'passed';
    const issues = [...validateRes.p0, ...validateRes.p1];
    return {
      action: 'status',
      status: automatedValidationPassed ? 'awaiting-independent-reviews' : 'needs-revision',
      automatedValidationPassed,
      readyForImplementation: false,
      automatedValidation: validateRes,
      p0: validateRes.p0,
      p1: validateRes.p1,
      issues,
    };
  }

  throw new Error(`Unknown action: ${action}`);
}

function parseCliArgs(argv) {
  const args = argv.slice(2);
  const action = args[0];
  let featureDir;
  let role = 'standards';
  let reviewPath;
  let json = false;

  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--dir') {
      featureDir = args[++i];
    } else if (args[i] === '--role') {
      role = args[++i];
    } else if (args[i] === '--review') {
      reviewPath = args[++i];
    } else if (args[i] === '--json') {
      json = true;
    }
  }

  return { action, featureDir, role, reviewPath, json };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { action, featureDir, role, reviewPath, json } = parseCliArgs(process.argv);
  if (!action || ['--help', '-h'].includes(action)) {
    console.log(`Usage:
  node scripts/agents/planning-workflow.mjs validate --dir <featureDir> [--json]
  node scripts/agents/planning-workflow.mjs review-brief --dir <featureDir> [--role standards|testability] [--json]
  node scripts/agents/planning-workflow.mjs evaluate-review --review <file> [--json]
  node scripts/agents/planning-workflow.mjs status --dir <featureDir> [--json]`);
    process.exit(0);
  }

  try {
    const result = await runPlanningWorkflow({ action, featureDir, role, reviewPath });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (action === 'review-brief') {
        console.log(result.prompt);
      } else if (action === 'validate' || action === 'status') {
        console.log(`[planning-workflow] Action: ${result.action} | Status: ${result.status}`);
        if (result.p0 && result.p0.length > 0) {
          console.log(`\nP0 Blockers (${result.p0.length}):`);
          result.p0.forEach(i => console.log(`  - [${i.code}] ${i.message} (${i.file || `line ${i.line}`})`));
        }
        if (result.p1 && result.p1.length > 0) {
          console.log(`\nP1 Issues (${result.p1.length}):`);
          result.p1.forEach(i => console.log(`  - [${i.code}] ${i.message} (${i.file || `line ${i.line}`})`));
        }
        if (action === 'status') {
          console.log(`\nReady for Implementation: ${result.readyForImplementation ? 'YES' : 'NO'}`);
        }
      } else if (action === 'evaluate-review') {
        console.log(`[planning-workflow] Review Status: ${result.status}`);
        console.log(`P0: ${result.p0.length} | P1: ${result.p1.length} | P2: ${result.p2.length}`);
      }
    }

    if (result.status === 'failed' || result.status === 'needs-revision') {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}



