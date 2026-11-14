/** Operator CLI argument handling, refusal mapping and output safety. No driver, no dispatch. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runEvaluateCli, type EvaluateCliOptions } from '../../../src/cli/evaluate.ts';
import type { WorkflowDriver, WorkflowObservation } from '../../../eval/uc03/types.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';

const digest = (seed: string): string => sha256Text(seed);

const HOST_OPTIONS: EvaluateCliOptions = {
  profileDigest: digest('profile'),
  configDigest: digest('config'),
  pricingDigest: digest('pricing'),
  adapterVersions: ['uc03-adapter-1'],
  requestedModel: 'deepseek-v4.1',
};

const selection = /UC-03 Workflow Evaluation \[(MOCK|REAL)\]: Selected = (pass|fail|incomplete), Suite = (pass|fail|incomplete|not-applicable), ExitCode = (\d)/;

function parseOutput(output: string): Record<string, unknown> {
  const cutoff = output.indexOf('\nUC-03 Workflow Evaluation');
  assert.notEqual(cutoff, -1, 'the runner summary line must be present');
  return JSON.parse(output.slice(0, cutoff)) as Record<string, unknown>;
}

/** Records every dispatch so "no dispatch in real mode" is proven, not assumed. */
function countingDriver(): { readonly driver: WorkflowDriver; readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    driver: {
      executeCase(spec) {
        calls.push(spec.caseId);
        return { blocked: null };
      },
    },
  };
}

test('invalid arguments exit 2 and never throw', async () => {
  const cases: readonly (readonly string[])[] = [
    ['--unknown', 'value'],
    ['--mode', 'mock', '--mode', 'real'],
    ['--mode'],
    ['--mode', '--cases', 'C01'],
    ['--mode', 'sideways'],
    ['--scope', 'everything'],
    ['--cases', 'C01,,C02'],
    ['--cases', ''],
    ['positional'],
  ];
  for (const args of cases) {
    const result = await runEvaluateCli(args, HOST_OPTIONS);
    assert.equal(result.exitCode, 2, `args: ${args.join(' ')}`);
    assert.equal(JSON.parse(result.output).error, 'INVALID_ARGUMENTS');
  }
});

test('serve accepts only a host-file reference before loading its configuration', async () => {
  const missingHost = join(tmpdir(), 'uc03-console-host-does-not-exist.json');
  const result = await runEvaluateCli(['serve', '--host', missingHost], HOST_OPTIONS);

  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.output).error, 'HOST_CONFIG_ERROR');
  assert.equal(result.output.includes(missingHost), false);
});

test('serve rejects every extra argument before it can read the supplied host file', async () => {
  const result = await runEvaluateCli(['serve', '--host', 'missing-host.json', '--token', 'secret-token'], HOST_OPTIONS);

  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.output).error, 'INVALID_ARGUMENTS');
  assert.equal(result.output.includes('secret-token'), false);
});

test('argv cannot carry trusted binding', async () => {
  const result = await runEvaluateCli(['--mode', 'mock', '--profileDigest', digest('attacker')], HOST_OPTIONS);
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.output).error, 'INVALID_ARGUMENTS');
});

test('a malformed host digest maps to exit 2 with no exception text', async () => {
  const result = await runEvaluateCli(['--mode', 'mock'], { ...HOST_OPTIONS, profileDigest: 'not-a-digest' });

  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.output).error, 'EVALUATION_REFUSED');
  assert.equal(result.output.includes('not-a-digest'), false);
  assert.equal(/Invalid workflow evaluation options/iu.test(result.output), false);
  assert.equal(result.output.includes('at '), false);
});

test('real mode without a host admission refuses with exit 1 and never dispatches', async () => {
  const { driver, calls } = countingDriver();
  const result = await runEvaluateCli(['--mode', 'real', '--cases', 'C01'], { ...HOST_OPTIONS, driver });
  const report = parseOutput(result.output) as {
    readonly mode: string;
    readonly tier: string;
    readonly isRealVerified: boolean;
    readonly selectionResult: { readonly outcome: string };
    readonly cases: readonly { readonly gradeReason: string; readonly mode: string }[];
  };

  assert.equal(result.exitCode, 1);
  assert.deepEqual(calls, []);
  assert.equal(report.mode, 'real');
  assert.equal(report.tier, 'real-integration');
  assert.equal(report.isRealVerified, false);
  assert.equal(report.selectionResult.outcome, 'incomplete');
  assert.equal(report.cases[0]?.gradeReason, 'real-execution-unavailable');
  assert.match(result.output, /Selected = incomplete, Suite = incomplete, ExitCode = 1/);
  assert.equal(/mock fallback/iu.test(result.output), false);
});

test('no driver maps to exit 1, not a prerequisite block', async () => {
  const result = await runEvaluateCli(['--mode', 'mock', '--cases', 'C01'], HOST_OPTIONS);

  assert.equal(result.exitCode, 1);
  assert.equal((parseOutput(result.output) as { readonly cases: readonly { readonly gradeReason: string }[] }).cases[0]?.gradeReason, 'driver-unavailable');
});

test('suiteAcceptance appears on every path', async () => {
  const noDriver = await runEvaluateCli(['--mode', 'mock', '--cases', 'C01'], HOST_OPTIONS);
  const real = await runEvaluateCli(['--mode', 'real', '--cases', 'C01'], HOST_OPTIONS);
  const exploratory = await runEvaluateCli(['--mode', 'mock', '--scope', 'exploratory', '--cases', 'C01'], HOST_OPTIONS);

  const acceptance = (output: string): unknown => (parseOutput(output) as { readonly suiteAcceptance?: unknown }).suiteAcceptance;
  assert.deepEqual(acceptance(noDriver.output), { scope: 'catalog', requiredCases: 17, satisfiedCases: 0, outcome: 'incomplete' });
  assert.deepEqual(acceptance(real.output), { scope: 'catalog', requiredCases: 17, satisfiedCases: 0, outcome: 'incomplete' });
  assert.deepEqual(acceptance(exploratory.output), { scope: 'exploratory', requiredCases: 0, satisfiedCases: 0, outcome: 'not-applicable' });
  for (const result of [noDriver, real, exploratory]) {
    assert.match(result.output, selection);
    assert.equal(parseOutput(result.output).exitCode, result.exitCode);
  }
});

test('credential and port references never reach the output', async () => {
  const secret = 'host-deepseek-key';
  const credentialRefPath = 'C:/host-only/credentials.json';
  const portReference = 'DATABASE_PORT=6543';
  const { driver } = countingDriver();
  const result = await runEvaluateCli(['--mode', 'mock', '--cases', 'C01'], {
    ...HOST_OPTIONS,
    adapterVersions: [portReference, credentialRefPath, secret],
    driver,
  });

  // Values outside the report identifier vocabulary are refused rather than echoed.
  assert.equal(result.exitCode, 2);
  for (const value of [secret, credentialRefPath, portReference]) assert.equal(result.output.includes(value), false);
});

test('--output writes the report and returns its exit code', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uc03-evaluate-cli-'));
  const outputPath = join(directory, 'report.json');

  const result = await runEvaluateCli(['--mode', 'mock', '--cases', 'C01', '--output', outputPath], HOST_OPTIONS);

  assert.equal(result.exitCode, 1);
  assert.equal(existsSync(outputPath), true);
  const written = JSON.parse(readFileSync(outputPath, 'utf8')) as { readonly suiteAcceptance: { readonly requiredCases: number } };
  assert.equal(written.suiteAcceptance.requiredCases, 17);
  assert.equal(result.output.includes('report.json'), false);
});

test('an unwritable --output exits 2', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uc03-evaluate-cli-'));
  const result = await runEvaluateCli(['--mode', 'mock', '--cases', 'C01', '--output', join(directory, 'missing', 'report.json')], HOST_OPTIONS);

  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.output).error, 'OUTPUT_WRITE_ERROR');
});

/** A complete observation; the CLI exit is the only thing under test. */
function observed(overrides: Record<string, unknown>): WorkflowObservation {
  return {
    repositoryId: 'repo-1',
    taskId: 'task-1',
    runId: 'run-1',
    returnedModel: 'mock-model-v1',
    graderDigest: null,
    initialRepositoryDigest: null,
    workflowOutcome: 'COMPLETED',
    expectedWait: null,
    blocked: null,
    effects: 'observed',
    usage: 'uncertain',
    diagnostic: null,
    artifacts: [],
    limitations: [],
    ...overrides,
  } as WorkflowObservation;
}

function waitingDriver(outcome: 'waiting-info' | 'waiting-approval', expectedWait: string | null): WorkflowDriver {
  return { executeCase: () => observed({ workflowOutcome: outcome, expectedWait }) };
}

test('an expected wait exits 0 with the task still paused, while an unresolved wait exits 3', async () => {
  const expected = await runEvaluateCli(['--mode', 'mock', '--cases', 'C02'], { ...HOST_OPTIONS, driver: waitingDriver('waiting-info', 'waiting-info') });
  assert.equal(expected.exitCode, 0);
  const expectedCase = (parseOutput(expected.output) as { readonly cases: readonly { readonly grade: string; readonly gradeReason: string; readonly workflowOutcome: string }[] }).cases[0];
  assert.deepEqual([expectedCase?.grade, expectedCase?.gradeReason, expectedCase?.workflowOutcome], ['pass', 'expected-wait-satisfied', 'waiting-info']);

  const unresolved = await runEvaluateCli(['--mode', 'mock', '--cases', 'C01'], { ...HOST_OPTIONS, driver: waitingDriver('waiting-approval', null) });
  assert.equal(unresolved.exitCode, 3);
  const unresolvedCase = (parseOutput(unresolved.output) as { readonly cases: readonly { readonly gradeReason: string }[] }).cases[0];
  assert.equal(unresolvedCase?.gradeReason, 'unresolved-wait');
});

test('a blocked prerequisite exits 4, never 1 and never a mock fallback', async () => {
  const driver: WorkflowDriver = { executeCase: () => observed({ blocked: 'prerequisite-unavailable' }) };
  const result = await runEvaluateCli(['--mode', 'mock', '--cases', 'C01'], { ...HOST_OPTIONS, driver });

  assert.equal(result.exitCode, 4);
  assert.equal(/mock fallback/iu.test(result.output), false);
});
