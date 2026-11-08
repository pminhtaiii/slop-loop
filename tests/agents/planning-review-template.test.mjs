import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { generateReviewTemplate } from '../../scripts/agents/planning-review-template.mjs';
import * as planningWorkflow from '../../scripts/agents/planning-workflow.mjs';
import { parseReviewFindings } from '../../scripts/agents/planning-workflow.mjs';

const workflowCli = fileURLToPath(new URL('../../scripts/agents/planning-workflow.mjs', import.meta.url));
const templateCli = fileURLToPath(new URL('../../scripts/agents/planning-review-template.mjs', import.meta.url));

test('generateReviewTemplate: default skeleton has the required table shape and cannot pass unfinished', () => {
  const template = generateReviewTemplate();

  assert.match(template, /^# Subagent Review Report\n/m);
  assert.match(template, /^## Findings \(unfinished skeleton\)$/m);
  assert.match(template, /^\| Severity \| Code \| Title \| Description \| Recommendation \|$/m);
  assert.match(template, /^\| --- \| --- \| --- \| --- \| --- \|$/m);
  assert.doesNotMatch(template, /^\| P[012] \|/m);

  const parsed = parseReviewFindings(template);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.passed, false);
  assert.ok(parsed.errors.includes('Findings table has no valid finding rows'));
});

test('generateReviewTemplate: explicit no-findings form round-trips through the existing evaluator', () => {
  const template = generateReviewTemplate({ noFindings: true });

  assert.equal(template, '# Subagent Review Report\n\nNo blocking issues found.\n');
  assert.deepEqual(parseReviewFindings(template), {
    valid: true,
    passed: true,
    p0: [],
    p1: [],
    p2: [],
    errors: [],
  });
});

test('parseReviewFindings: completed skeleton preserves P1 blocking and P2 advisory behavior', () => {
  const completed =
    `${generateReviewTemplate()}` +
    '| P1 | MISSING_BOUNDARY | Missing boundary case | The input limit is undefined | Define the limit |\n' +
    '| P2 | DOC_CLARITY | Improve wording | A sentence is hard to scan | Rewrite it |\n';
  const parsed = parseReviewFindings(completed);

  assert.equal(parsed.valid, true);
  assert.equal(parsed.passed, false);
  assert.equal(parsed.p0.length, 0);
  assert.equal(parsed.p1.length, 1);
  assert.equal(parsed.p1[0].code, 'MISSING_BOUNDARY');
  assert.equal(parsed.p2.length, 1);
  assert.equal(parsed.p2[0].code, 'DOC_CLARITY');

  const advisoryOnly = parseReviewFindings(`${generateReviewTemplate()}` + '| P2 | DOC_CLARITY | Improve wording | A sentence is hard to scan | Rewrite it |\n');
  assert.equal(advisoryOnly.valid, true);
  assert.equal(advisoryOnly.passed, true);
  assert.equal(advisoryOnly.p2.length, 1);
});

test('parseReviewFindings: fenced and malformed reports remain rejected', () => {
  const fenced = parseReviewFindings(`\`\`\`md\n${generateReviewTemplate({ noFindings: true })}\`\`\``);
  assert.equal(fenced.valid, false);
  assert.equal(fenced.passed, false);

  const malformed = parseReviewFindings(`${generateReviewTemplate()}| P1 | TOO_SHORT | Missing cells |\n`);
  assert.equal(malformed.valid, false);
  assert.equal(malformed.passed, false);
  assert.ok(malformed.errors.some(error => error.startsWith('Malformed findings row:')));
});

test('planning-review-template CLI: --no-findings emits an evaluable declaration', () => {
  const output = execFileSync(process.execPath, [templateCli, '--no-findings'], { encoding: 'utf8' });

  assert.equal(output, generateReviewTemplate({ noFindings: true }));
  assert.equal(parseReviewFindings(output).passed, true);
});

test('planning-workflow exposes review-template generation and CLI output modes', async () => {
  assert.equal(typeof planningWorkflow.generateReviewTemplate, 'function');
  assert.equal(planningWorkflow.generateReviewTemplate({ noFindings: true }), generateReviewTemplate({ noFindings: true }));

  const actionResult = await planningWorkflow.runPlanningWorkflow({ action: 'review-template', noFindings: true });
  assert.deepEqual(actionResult, {
    action: 'review-template',
    template: generateReviewTemplate({ noFindings: true }),
  });

  const textOutput = execFileSync(process.execPath, [workflowCli, 'review-template'], { encoding: 'utf8' });
  assert.equal(textOutput, generateReviewTemplate());

  const noFindingsOutput = execFileSync(process.execPath, [workflowCli, 'review-template', '--no-findings'], { encoding: 'utf8' });
  assert.equal(noFindingsOutput, generateReviewTemplate({ noFindings: true }));

  const jsonOutput = execFileSync(process.execPath, [workflowCli, 'review-template', '--no-findings', '--json'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(jsonOutput), actionResult);
});

test('evaluate-review CLI distinguishes malformed reports from valid blocking findings', async t => {
  const reviewDir = await mkdtemp(join(tmpdir(), 'planning-review-cli-'));
  t.after(() => rm(reviewDir, { recursive: true, force: true }));

  const malformedPath = join(reviewDir, 'malformed.md');
  const blockingPath = join(reviewDir, 'blocking.md');
  await writeFile(malformedPath, '```md\nNo blocking issues found.\n```\n');
  await writeFile(blockingPath, `${generateReviewTemplate()}| P1 | MISSING_BOUNDARY | Missing boundary case | The input limit is undefined | Define the limit |\n`);

  const malformed = spawnSync(process.execPath, [workflowCli, 'evaluate-review', '--review', malformedPath], { encoding: 'utf8' });
  const malformedOutput = `${malformed.stdout}${malformed.stderr}`;
  assert.equal(malformed.status, 1);
  assert.match(malformedOutput, /Review Status: failed/);
  assert.match(malformedOutput, /Report format: invalid/);
  assert.match(malformedOutput, /Review must contain a findings table or a standalone/);

  const blocking = spawnSync(process.execPath, [workflowCli, 'evaluate-review', '--review', blockingPath], { encoding: 'utf8' });
  const blockingOutput = `${blocking.stdout}${blocking.stderr}`;
  assert.equal(blocking.status, 1);
  assert.match(blockingOutput, /Review Status: failed/);
  assert.match(blockingOutput, /Report format: valid/);
  assert.match(blockingOutput, /P0: 0 \| P1: 1 \| P2: 0/);
});

test('generateReviewBrief: includes the safe unfinished table skeleton without a placeholder finding row', async t => {
  const featureDir = await mkdtemp(join(tmpdir(), 'planning-review-template-'));
  t.after(() => rm(featureDir, { recursive: true, force: true }));

  const brief = await planningWorkflow.generateReviewBrief({ featureDir });

  assert.ok(brief.prompt.includes(generateReviewTemplate()));
  assert.doesNotMatch(brief.prompt, /^\| P[012](?:\/P[012])? \|/m);
});
