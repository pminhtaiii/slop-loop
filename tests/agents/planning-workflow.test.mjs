import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateArtifacts,
  validateTaskLedger,
  generateReviewBrief,
  parseReviewFindings,
  runPlanningWorkflow,
} from '../../scripts/agents/planning-workflow.mjs';

async function writeRequiredArtifacts(directory, overrides = {}) {
  const artifacts = {
    'spec.md': '# Spec\nRequirement is defined.\n',
    'plan.md': '# Plan\nAll decisions confirmed.\n',
    'tasks.md': '# Tasks\n- [ ] T001 Setup in src/index.ts\n',
    'research.md': '# Research\nDecision is recorded.\n',
    'data-model.md': '# Data Model\nEntities are defined.\n',
    'quickstart.md': '# Quickstart\nValidation steps are defined.\n',
    ...overrides,
  };
  for (const [name, contents] of Object.entries(artifacts)) {
    await writeFile(join(directory, name), contents, 'utf8');
  }
  await mkdir(join(directory, 'contracts'), { recursive: true });
  await writeFile(join(directory, 'contracts', 'api.md'), '# API Contract\n', 'utf8');
}

test('validateArtifacts: flags all missing required files and contracts directory as P0 errors', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-wf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await validateArtifacts({ featureDir: directory });
  assert.equal(result.valid, false);
  const p0Codes = result.p0.map(issue => issue.code);
  for (const code of [
    'MISSING_SPEC',
    'MISSING_PLAN',
    'MISSING_TASKS',
    'MISSING_RESEARCH',
    'MISSING_DATA_MODEL',
    'MISSING_QUICKSTART',
    'MISSING_CONTRACTS',
  ]) {
    assert.ok(p0Codes.includes(code), `Should detect ${code}`);
  }
});

test('validateArtifacts: flags unresolved NEEDS CLARIFICATION markers as P1 errors', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-wf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeRequiredArtifacts(directory, {
    'plan.md': '# Plan\nTechnical Context: NEEDS CLARIFICATION regarding database choice\n',
    'research.md': '# Research\n- NEEDS CLARIFICATION on cache\n',
  });

  const result = await validateArtifacts({ featureDir: directory });
  assert.equal(result.valid, false);
  assert.equal(result.p0.length, 0);
  const p1Codes = result.p1.map(issue => issue.code);
  assert.ok(p1Codes.includes('UNRESOLVED_CLARIFICATION'), 'Should flag NEEDS CLARIFICATION in plan.md and research.md');
});

test('validateArtifacts: flags unresolved clarification markers across all artifacts and recursive contracts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-wf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeRequiredArtifacts(directory, {
    'spec.md': '# Spec\nNEEDS CLARIFICATION on user roles\n',
    'data-model.md': '# Data Model\nNEEDS CLARIFICATION on schema\n',
    'quickstart.md': '# Quickstart\nNEEDS CLARIFICATION on port\n',
    'tasks.md': '# Tasks\n- [ ] T001 Setup in src/index.ts NEEDS CLARIFICATION\n',
  });
  await mkdir(join(directory, 'contracts', 'services'), { recursive: true });
  await writeFile(join(directory, 'contracts', 'services', 'user.md'), '# User Contract\nNEEDS CLARIFICATION on auth\n', 'utf8');

  const result = await validateArtifacts({ featureDir: directory });
  assert.equal(result.valid, false);
  const clarificationFiles = result.p1
    .filter(i => i.code === 'UNRESOLVED_CLARIFICATION')
    .map(i => i.file);
  assert.ok(clarificationFiles.includes('spec.md'));
  assert.ok(clarificationFiles.includes('data-model.md'));
  assert.ok(clarificationFiles.includes('quickstart.md'));
  assert.ok(clarificationFiles.includes('tasks.md'));
  assert.ok(clarificationFiles.includes('contracts/services/user.md'));
});

test('validateArtifacts: passes when core planning artifacts are clean and present', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-wf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeRequiredArtifacts(directory, {
    'research.md': '# Research\nDecision: Postgres chosen.\n',
  });

  const result = await validateArtifacts({ featureDir: directory });
  assert.equal(result.valid, true);
  assert.equal(result.p0.length, 0);
  assert.equal(result.p1.length, 0);
});

test('validateTaskLedger: flags malformed task syntax and missing file paths as P0', () => {
  const tasksMarkdown = `# Tasks
## Phase 1: Setup
- [ ] T001 Initialize repository structure without any target path
T002 Missing checkbox in src/server.ts
- [ ] InvalidID [US1] Create model in src/model.ts
`;

  const result = validateTaskLedger(tasksMarkdown);
  assert.equal(result.valid, false);
  const p0Codes = result.p0.map(i => i.code);
  assert.ok(p0Codes.includes('MISSING_FILE_PATH'), 'Should flag T001 for missing file path');
  assert.ok(p0Codes.includes('MALFORMED_TASK_SYNTAX'), 'Should flag lines missing checkbox or canonical ID');
});

test('validateTaskLedger: flags missing user story tags in story phases and [P] file collisions as P0', () => {
  const tasksMarkdown = `# Tasks
## Phase 1: Setup
- [ ] T001 Setup shared config in src/config.ts

## Phase 3: User Story 1
- [ ] T002 Implement missing story tag in src/service.ts
- [ ] T003 [P] [US1] First parallel edit in src/common.ts
- [ ] T004 [P] [US1] Second parallel edit colliding on src/common.ts
`;

  const result = validateTaskLedger(tasksMarkdown);
  assert.equal(result.valid, false);
  const p0Codes = result.p0.map(i => i.code);
  assert.ok(p0Codes.includes('MISSING_STORY_TAG'), 'Should flag T002 for missing [US1] tag in story phase');
  assert.ok(p0Codes.includes('PARALLEL_FILE_COLLISION'), 'Should flag T003 and T004 for colliding [P] paths');
});

test('validateTaskLedger: passes for valid, well-formed task ledger', () => {
  const tasksMarkdown = `# Tasks
## Phase 1: Setup
- [ ] T001 Setup tooling in package.json
- [ ] T002 [P] Setup linting in eslint.config.mjs

## Phase 3: User Story 1
- [ ] T003 [US1] Create entity in src/entities/user.ts
- [ ] T004 [P] [US1] Add handler in src/handlers/user.ts
- [ ] T005 [P] [US1] Add tests in tests/handlers/user.test.ts

## Dependencies
T003 follows T001
T004 follows T003
T005 follows T003
`;

  const result = validateTaskLedger(tasksMarkdown);
  assert.equal(result.valid, true);
  assert.equal(result.p0.length, 0);
  assert.equal(result.p1.length, 0);
  assert.equal(result.tasks.length, 5);
});

test('validateTaskLedger: rejects invalid dependency declarations and graphs', () => {
  const tasksMarkdown = `# Tasks
## Phase 1: Setup
- [ ] T001 Prepare first file in src/one.ts
- [ ] T002 Prepare second file in src/two.ts
  - **Dependencies**: T999
- [ ] T003 Prepare third file in src/three.ts
  - **Dependencies**: T001 and T002

## Dependencies & Execution Order
T001 -> T002
T002 -> T001
T003 -> T003
T003 ->
`;

  const result = validateTaskLedger(tasksMarkdown);
  const p0Codes = result.p0.map(issue => issue.code);
  assert.ok(p0Codes.includes('UNKNOWN_DEPENDENCY_TASK'));
  assert.ok(p0Codes.includes('MALFORMED_DEPENDENCY'));
  assert.ok(p0Codes.includes('SELF_DEPENDENCY'));
  assert.ok(p0Codes.includes('DEPENDENCY_CYCLE'));
});

test('validateTaskLedger: accepts dependency chains and ampersand groups in Mermaid summaries', () => {
  const result = validateTaskLedger(`# Tasks
## Phase 1: Setup
- [ ] T001 Prepare first file in src/one.ts
- [ ] T002 Prepare second file in src/two.ts
- [ ] T003 Prepare third file in src/three.ts
- [ ] T004 Prepare fourth file in src/four.ts

## Dependencies & Execution Order
T001 --> T002 --> T003
T001 & T003 --> T004
X04[X04-STATE] --> T004
`);
  assert.equal(result.valid, true, JSON.stringify(result.p0));
});

test('validateTaskLedger: accepts dependency chains with whitespace around -> arrows', () => {
  const result = validateTaskLedger(`# Tasks
## Phase 1: Setup
- [ ] T001 Prepare first file in src/one.ts
- [ ] T002 Prepare second file in src/two.ts
- [ ] T003 Prepare third file in src/three.ts

## Dependencies & Execution Order
T001 -> T002 -> T003
`);
  assert.equal(result.valid, true, JSON.stringify(result.p0));
  assert.equal(result.p0.length, 0);
});

test('validateTaskLedger: flags any unparsed task line in Dependencies section as MALFORMED_DEPENDENCY', () => {
  const result = validateTaskLedger(`# Tasks
## Phase 1: Setup
- [ ] T001 Prepare first file in src/one.ts
- [ ] T002 Prepare second file in src/two.ts

## Dependencies & Execution Order
T002 depends on T001
T002 after T001
T001 unparsed words
`);
  const malformed = result.p0.filter(issue => issue.code === 'MALFORMED_DEPENDENCY');
  assert.equal(malformed.length, 3);
  assert.ok(malformed.some(m => m.message.includes('T002 depends on T001')));
  assert.ok(malformed.some(m => m.message.includes('T002 after T001')));
  assert.ok(malformed.some(m => m.message.includes('T001 unparsed words')));
});

test('validateTaskLedger: continues dependency validation through nested headings and task Owned Paths', () => {
  const result = validateTaskLedger(`# Tasks
- [ ] T001 Prepare first file
  - **Owned Paths**: src/one.ts
- [ ] T002 Prepare second file
  - **Owned Paths**: src/two.ts

## Dependencies & Execution Order
### Phase and story dependencies
T001 --> T002
T002 --> T999
`);
  assert.ok(result.p0.some(issue => issue.code === 'UNKNOWN_DEPENDENCY_TASK'));
  assert.equal(result.p0.some(issue => issue.code === 'MISSING_FILE_PATH'), false);
  assert.equal(result.p0.some(issue => issue.code === 'MALFORMED_TASK_SYNTAX'), false);
});

test('validateTaskLedger: rejects duplicate and nonsequential task IDs', () => {
  const result = validateTaskLedger(`# Tasks
- [ ] T001 Prepare first file in src/one.ts
- [ ] T003 Skip the second ID in src/three.ts
- [ ] T003 Reuse an ID in src/duplicate.ts
`);
  const p0Codes = result.p0.map(issue => issue.code);
  assert.ok(p0Codes.includes('NONSEQUENTIAL_TASK_ID'));
  assert.ok(p0Codes.includes('DUPLICATE_TASK_ID'));
});

test('validateTaskLedger: treats Node.js as prose and normalizes parallel path aliases', () => {
  const result = validateTaskLedger(`# Tasks
## Phase 1: Setup
- [ ] T001 [P] Add Node.js support in src/./common.ts
- [ ] T002 [P] Add Node.js support in src/common.ts
`);
  const collisions = result.p0.filter(issue => issue.code === 'PARALLEL_FILE_COLLISION');
  assert.equal(collisions.length, 1);
  assert.match(collisions[0].message, /src\/common\.ts/);
});

test('validateTaskLedger: uses Owned Paths for parallel collision checks when declared', () => {
  const result = validateTaskLedger(`# Tasks
## Phase 1: Setup
- [ ] T001 [P] Prepare first change in src/one.ts
  - **Owned Paths**: src/shared.ts
- [ ] T002 [P] Prepare second change in src/two.ts
  - **Owned Paths**: ./src/shared.ts
`);
  const collisions = result.p0.filter(issue => issue.code === 'PARALLEL_FILE_COLLISION');
  assert.equal(collisions.length, 1);
  assert.match(collisions[0].message, /src\/shared\.ts/);
});

test('validateTaskLedger: detects overlap between parallel directory and file ownership', () => {
  const result = validateTaskLedger(`# Tasks
## Phase 1: Setup
- [ ] T001 [P] Prepare directory in src/a/
  - **Owned Paths**: src/a/
- [ ] T002 [P] Prepare file in src/a/item.ts
  - **Owned Paths**: src/a/item.ts
- [ ] T003 [P] Prepare sibling path in src/ab/item.ts
  - **Owned Paths**: src/ab/item.ts
`);
  const collisions = result.p0.filter(issue => issue.code === 'PARALLEL_FILE_COLLISION');
  assert.equal(collisions.length, 1);
  assert.match(collisions[0].message, /src\/a/);
});

test('validateTaskLedger: excludes dependency-ordered parallel ownership from simultaneous collision checks', () => {
  const result = validateTaskLedger(`# Tasks
## Phase 1: Setup
- [ ] T001 [P] Prepare a shared-file skeleton in src/shared.ts
  - **Owned Paths**: src/shared.ts
- [ ] T002 [P] Implement the shared file in src/shared.ts
  - **Dependencies**: T001.
  - **Owned Paths**: src/shared.ts
`);
  assert.equal(result.p0.some(issue => issue.code === 'PARALLEL_FILE_COLLISION'), false);
});

test('validateTaskLedger: requires explicit local paths and rejects absolute or outside targets', () => {
  const result = validateTaskLedger(`# Tasks
- [ ] T001 Add Node.js support
- [ ] T002 Update package.json
- [ ] T003 Update eslint.config.mjs
- [ ] T004 Update tsconfig.json
- [ ] T005 Update custom-settings.json
- [ ] T006 Update /outside/file.ts
- [ ] T007 Update ../outside.ts
- [ ] T008 Update C:/outside/file.ts
`);
  const p0Codes = result.p0.map(issue => issue.code);
  assert.ok(p0Codes.includes('MISSING_FILE_PATH'));
  assert.ok(p0Codes.includes('AMBIGUOUS_ROOT_PATH'));
  assert.equal(p0Codes.filter(code => code === 'INVALID_FILE_PATH').length, 3);
  assert.equal(result.p0.some(issue => issue.code === 'AMBIGUOUS_ROOT_PATH' && ['T002', 'T003', 'T004'].includes(issue.task)), false);
});

test('validateTaskLedger: excludes version numbers, abbreviations, and capitalized frameworks from AMBIGUOUS_ROOT_PATH', () => {
  const result = validateTaskLedger(`# Tasks
## Phase 1: Setup
- [ ] T001 Upgrade React.js to 18.2.0 and Vue.js to 3.0 in package.json (e.g. for hooks, i.e. state)
- [ ] T002 Configure tsconfig.json and eslint.config.mjs
- [ ] T003 Fix main.ts and util.js
`);
  const ambiguous = result.p0.filter(issue => issue.code === 'AMBIGUOUS_ROOT_PATH');
  assert.equal(ambiguous.length, 2);
  const ambiguousMessages = ambiguous.map(issue => issue.message);
  assert.ok(ambiguousMessages.some(msg => msg.includes('main.ts')));
  assert.ok(ambiguousMessages.some(msg => msg.includes('util.js')));
  assert.equal(ambiguous.some(issue => ['T001', 'T002'].includes(issue.task)), false);
});

test('generateReviewBrief: generates specialized review instructions for subagent roles', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-wf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(join(directory, 'plan.md'), '# Plan\n', 'utf8');
  await writeFile(join(directory, 'tasks.md'), '# Tasks\n', 'utf8');

  const standardsBrief = await generateReviewBrief({ featureDir: directory, role: 'standards' });
  assert.equal(standardsBrief.role, 'standards');
  assert.ok(standardsBrief.prompt.includes('Standards & Architecture Reviewer'));
  assert.ok(standardsBrief.prompt.includes('P0 (Critical / Blocker)'));
  assert.ok(standardsBrief.prompt.includes('P1 (Major)'));
  assert.ok(standardsBrief.targetFiles.includes('plan.md'));

  const testabilityBrief = await generateReviewBrief({ featureDir: directory, role: 'testability' });
  assert.equal(testabilityBrief.role, 'testability');
  assert.ok(testabilityBrief.prompt.includes('Testability & Edge Cases Reviewer'));
});

test('generateReviewBrief: rejects unknown review roles', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-wf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    () => generateReviewBrief({ featureDir: directory, role: 'invalid' }),
    {
      name: 'Error',
      message: 'Unknown review role: invalid (expected standards|testability)',
    }
  );
});

test('generateReviewBrief: includes all contracts files recursively regardless of extension', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-wf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'contracts', 'schemas'), { recursive: true });
  await mkdir(join(directory, 'notes'), { recursive: true });
  await writeFile(join(directory, 'plan.md'), '# Plan\n', 'utf8');
  await writeFile(join(directory, 'contracts', 'schema.json'), '{}', 'utf8');
  await writeFile(join(directory, 'contracts', 'schemas', 'event.yaml'), 'type: object\n', 'utf8');
  await writeFile(join(directory, 'contracts', 'schemas', 'readme.md'), '# Contract\n', 'utf8');
  await writeFile(join(directory, 'notes', 'ignored.yaml'), 'note: true\n', 'utf8');

  const brief = await generateReviewBrief({ featureDir: directory, role: 'testability' });
  assert.ok(brief.targetFiles.includes('plan.md'));
  assert.ok(brief.targetFiles.includes('contracts/'));
  assert.ok(brief.targetFiles.includes('contracts/schema.json'));
  assert.ok(brief.targetFiles.includes('contracts/schemas/event.yaml'));
  assert.ok(brief.targetFiles.includes('contracts/schemas/readme.md'));
  assert.equal(brief.targetFiles.some(file => file.includes('ignored.yaml')), false);
});

test('parseReviewFindings: parses structured subagent findings into P0, P1, P2 issues', () => {
  const sampleReview = `# Subagent Review Report

## Findings

| Severity | Code | Title | Description | Recommendation |
|---|---|---|---|---|
| P0 | SEC_VIOLATION | Unbounded tool permission | Tool allows arbitrary script execution without sandbox | Add sandbox constraint |
| P1 | UNTESTABLE_CRITERIA | Ambiguous latency | Acceptance criteria says "fast" without ms threshold | Define <200ms target |
| P2 | STYLE_DOC | Typo in section 2 | Minor grammar issue in overview | Fix typo |
`;

  const parsed = parseReviewFindings(sampleReview);
  assert.equal(parsed.passed, false);
  assert.equal(parsed.p0.length, 1);
  assert.equal(parsed.p0[0].code, 'SEC_VIOLATION');
  assert.equal(parsed.p1.length, 1);
  assert.equal(parsed.p1[0].code, 'UNTESTABLE_CRITERIA');
  assert.equal(parsed.p2.length, 1);
  assert.equal(parsed.p2[0].code, 'STYLE_DOC');
});

test('parseReviewFindings: reports passed when 0 P0 and 0 P1 findings exist', () => {
  const cleanReview = `# Subagent Review Report

| Severity | Code | Title | Description | Recommendation |
|---|---|---|---|---|
| P2 | OPTIONAL_POLISH | Doc format | Consider adding a diagram | Add diagram |
`;

  const parsed = parseReviewFindings(cleanReview);
  assert.equal(parsed.passed, true);
  assert.equal(parsed.p0.length, 0);
  assert.equal(parsed.p1.length, 0);
  assert.equal(parsed.p2.length, 1);
});

test('parseReviewFindings: accepts only a standalone no-blocking declaration or a valid findings table', () => {
  const standalone = parseReviewFindings('# Subagent Review Report\n\nNo blocking issues found.');
  assert.equal(standalone.valid, true);
  assert.equal(standalone.passed, true);

  const invalidReports = [
    '',
    'Review complete.',
    '| Severity | Code | Title | Description | Recommendation |\n|---|---|---|---|---|',
    '| Severity | Code | Title | Description | Recommendation |\n|---|---|---|---|---|\n| P1 | MISSING_EDGE |',
    '| Severity | Code | Title | Description | Recommendation |\n|---|---|---|---|---|\n| P3 | OTHER | Unknown severity | Description | Recommendation |',
    '| Severity | Code | Title | Description | Recommendation |\n|---|---|---|---|---|\n| P2 | POLISH | Good row | Description | Recommendation |\nP1 | BLOCKER | Missing leading pipe | Description | Fix |',
    '```md\nNo blocking issues found.\n```',
  ];
  for (const report of invalidReports) {
    const parsed = parseReviewFindings(report);
    assert.equal(parsed.valid, false, `Should reject: ${report}`);
    assert.equal(parsed.passed, false, `Should not pass: ${report}`);
  }

  const blockerWithSentinel = parseReviewFindings(`No blocking issues found.

| Severity | Code | Title | Description | Recommendation |
|---|---|---|---|---|
| P1 | BLOCKER | Blocking finding | Must be fixed | Fix it |
`);
  assert.equal(blockerWithSentinel.valid, false);
  assert.equal(blockerWithSentinel.passed, false);
  assert.equal(blockerWithSentinel.p1.length, 1);
});

test('runPlanningWorkflow: coordinates validate action and aggregates artifact and task issues', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-wf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeRequiredArtifacts(directory, {
    'tasks.md': '# Tasks\n## Phase 1: Setup\n- [ ] T001 Setup in src/index.ts\n',
  });

  const result = await runPlanningWorkflow({ action: 'validate', featureDir: directory });
  assert.equal(result.status, 'passed');
  assert.equal(result.p0.length, 0);
  assert.equal(result.p1.length, 0);
  assert.equal(result.tasks.length, 1);
});

test('runPlanningWorkflow: status reports readyForImplementation: false when blockers exist', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-wf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeRequiredArtifacts(directory, {
    'plan.md': '# Plan\nNEEDS CLARIFICATION\n',
  });

  const result = await runPlanningWorkflow({ action: 'status', featureDir: directory });
  assert.equal(result.status, 'needs-revision');
  assert.equal(result.readyForImplementation, false);
  assert.equal(result.automatedValidationPassed, false);
  assert.ok(result.issues.length > 0);
});

test('runPlanningWorkflow: validated artifacts await independent reviews before implementation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-wf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeRequiredArtifacts(directory);

  const result = await runPlanningWorkflow({ action: 'status', featureDir: directory });
  assert.equal(result.automatedValidationPassed, true);
  assert.equal(result.readyForImplementation, false);
  assert.equal(result.status, 'awaiting-independent-reviews');
});



