import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function fileExists(path) {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

export async function validateArtifacts({ featureDir, root = process.cwd() }) {
  const dir = resolve(root, featureDir);
  const p0 = [];
  const p1 = [];
  const p2 = [];

  const planPath = join(dir, 'plan.md');
  const tasksPath = join(dir, 'tasks.md');

  const hasPlan = await fileExists(planPath);
  const hasTasks = await fileExists(tasksPath);

  if (!hasPlan) {
    p0.push({ code: 'MISSING_PLAN', message: 'plan.md is missing from feature directory', file: 'plan.md' });
  }
  if (!hasTasks) {
    p0.push({ code: 'MISSING_TASKS', message: 'tasks.md is missing from feature directory', file: 'tasks.md' });
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

  await checkClarifications('plan.md');
  await checkClarifications('research.md');
  await checkClarifications('spec.md');

  const valid = p0.length === 0 && p1.length === 0;
  return { valid, p0, p1, p2 };
}

export function validateTaskLedger(tasksContent) {
  const p0 = [];
  const p1 = [];
  const tasks = [];
  const lines = tasksContent.split('\n');

  let currentPhase = '';
  let isStoryPhase = false;
  let isDependenciesSection = false;

  // Track parallel tasks per phase for collision detection
  const parallelTasksByPhase = new Map();

  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx];
    const line = rawLine.trim();
    const lineNum = idx + 1;

    if (line.startsWith('#')) {
      currentPhase = line;
      isStoryPhase = /User Story/i.test(line) || (/Phase\s+[3-9]/i.test(line) && !/Cross-Cutting|Polish|Integration|correction/i.test(line));
      isDependenciesSection = /Dependencies/i.test(line);
      continue;
    }

    if (isDependenciesSection) {
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

      // Extract file and directory paths: paths with extension or directory paths (ending with /)
      const filePathMatches = remainder.match(/[a-zA-Z0-9_\-./\\]+(?:\.[a-zA-Z0-9_-]+|\/)/g) || [];
      const filePaths = filePathMatches.filter(path => !path.startsWith('e.g.') && !path.startsWith('i.e.') && path !== './' && path !== '../');

      if (filePaths.length === 0) {
        p0.push({
          code: 'MISSING_FILE_PATH',
          message: `Task ${id} is missing an explicit file path: "${line}"`,
          line: lineNum,
        });
      }

      const task = { id, isParallel, story, description: remainder.trim(), filePaths, phase: currentPhase, line: lineNum };
      tasks.push(task);

      if (isParallel) {
        if (!parallelTasksByPhase.has(currentPhase)) {
          parallelTasksByPhase.set(currentPhase, []);
        }
        const phaseList = parallelTasksByPhase.get(currentPhase);
        for (const existing of phaseList) {
          const commonFiles = filePaths.filter(f => existing.filePaths.includes(f));
          if (commonFiles.length > 0) {
            p0.push({
              code: 'PARALLEL_FILE_COLLISION',
              message: `Parallel task ${id} collides with ${existing.id} on shared file(s): ${commonFiles.join(', ')}`,
              line: lineNum,
            });
          }
        }
        phaseList.push(task);
      }
    }
  }

  const valid = p0.length === 0 && p1.length === 0;
  return { valid, tasks, p0, p1 };
}

export async function generateReviewBrief({ featureDir, role = 'standards', root = process.cwd() }) {
  const dir = resolve(root, featureDir);
  const entries = await readdir(dir).catch(() => []);
  const targetFiles = entries.filter(f => f.endsWith('.md'));

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

  const lines = markdownContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').map(c => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
    if (cells.length < 5) continue;
    const [sev, code, title, description, recommendation] = cells;
    if (sev === 'Severity' || /^-+$/.test(sev)) continue;

    const upperSev = sev.toUpperCase();
    const item = { severity: upperSev, code, title, description, recommendation };
    if (upperSev === 'P0') p0.push(item);
    else if (upperSev === 'P1') p1.push(item);
    else if (upperSev === 'P2') p2.push(item);
  }

  const passed = p0.length === 0 && p1.length === 0;
  return { passed, p0, p1, p2 };
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
    const readyForImplementation = validateRes.status === 'passed';
    const issues = [...validateRes.p0, ...validateRes.p1];
    return {
      action: 'status',
      status: readyForImplementation ? 'passed' : 'needs-revision',
      readyForImplementation,
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



