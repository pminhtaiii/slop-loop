import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTaskLedger } from './planning-task-ledger.mjs';

export { validateTaskLedger } from './planning-task-ledger.mjs';

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
    if (!(await check(join(dir, name)))) {
      p0.push({ code, message: `${name} is missing from feature directory`, file: name });
    }
  }

  // Check for unresolved clarification markers in planning docs
  const checkClarifications = async filename => {
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

  const filesToCheck = ['spec.md', 'plan.md', 'research.md', 'data-model.md', 'quickstart.md', 'tasks.md'];

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

  const roleTitle = role === 'standards' ? 'Standards & Architecture Reviewer' : 'Testability & Edge Cases Reviewer';

  const roleFocus =
    role === 'standards'
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
  const standaloneNoBlockers = tableLines.length === 0 && proseLines.length === 1 && proseLines[0] === 'No blocking issues found.';

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

export async function runPlanningWorkflow({ action, featureDir, role = 'standards', reviewContent, reviewPath, root = process.cwd() }) {
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
