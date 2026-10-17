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

test('validateArtifacts: flags missing required files as P0 errors', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-wf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await validateArtifacts({ featureDir: directory });
  assert.equal(result.valid, false);
  const p0Codes = result.p0.map(issue => issue.code);
  assert.ok(p0Codes.includes('MISSING_PLAN'), 'Should detect missing plan.md');
  assert.ok(p0Codes.includes('MISSING_TASKS'), 'Should detect missing tasks.md');
});

test('validateArtifacts: flags unresolved NEEDS CLARIFICATION markers as P1 errors', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-wf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(join(directory, 'plan.md'), '# Plan\nTechnical Context: NEEDS CLARIFICATION regarding database choice\n', 'utf8');
  await writeFile(join(directory, 'tasks.md'), '# Tasks\n- [ ] T001 Setup in file.ts\n', 'utf8');
  await writeFile(join(directory, 'research.md'), '# Research\n- NEEDS CLARIFICATION on cache\n', 'utf8');

  const result = await validateArtifacts({ featureDir: directory });
  assert.equal(result.valid, false);
  assert.equal(result.p0.length, 0);
  const p1Codes = result.p1.map(issue => issue.code);
  assert.ok(p1Codes.includes('UNRESOLVED_CLARIFICATION'), 'Should flag NEEDS CLARIFICATION in plan.md and research.md');
});

test('validateArtifacts: passes when core planning artifacts are clean and present', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-wf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(join(directory, 'plan.md'), '# Plan\nAll decisions confirmed.\n', 'utf8');
  await writeFile(join(directory, 'tasks.md'), '# Tasks\n- [ ] T001 Setup in src/index.ts\n', 'utf8');
  await writeFile(join(directory, 'research.md'), '# Research\nDecision: Postgres chosen.\n', 'utf8');
  await writeFile(join(directory, 'data-model.md'), '# Data Model\nEntities defined.\n', 'utf8');
  await mkdir(join(directory, 'contracts'), { recursive: true });
  await writeFile(join(directory, 'contracts', 'api.md'), '# API Contract\n', 'utf8');

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
No blocking issues found.

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

test('runPlanningWorkflow: coordinates validate action and aggregates artifact and task issues', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-wf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(join(directory, 'plan.md'), '# Plan\nAll confirmed.\n', 'utf8');
  await writeFile(join(directory, 'tasks.md'), '# Tasks\n## Phase 1: Setup\n- [ ] T001 Setup in file.ts\n', 'utf8');

  const result = await runPlanningWorkflow({ action: 'validate', featureDir: directory });
  assert.equal(result.status, 'passed');
  assert.equal(result.p0.length, 0);
  assert.equal(result.p1.length, 0);
  assert.equal(result.tasks.length, 1);
});

test('runPlanningWorkflow: status reports readyForImplementation: false when blockers exist', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-wf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(join(directory, 'plan.md'), '# Plan\nNEEDS CLARIFICATION\n', 'utf8');

  const result = await runPlanningWorkflow({ action: 'status', featureDir: directory });
  assert.equal(result.status, 'needs-revision');
  assert.equal(result.readyForImplementation, false);
  assert.ok(result.issues.length > 0);
});



