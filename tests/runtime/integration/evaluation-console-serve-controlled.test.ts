/**
 * Runs the real console CLI entry (`runEvaluateCli(['serve', '--host', <file>])`) against the
 * controlled console assembly (`controlled-console-assembly.ts`), asserting loopback listening,
 * page & catalog HTML/JSON delivery, operator token handling, and C01/C02/custom browser flows.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runEvaluateCli } from '../../../src/cli/evaluate.ts';
import type { ExperimentReceipt, ExperimentView, ServiceControlReceipt } from '../../../src/runtime/evaluation-service.ts';
import { buildControlledHostConfiguration, CONTROLLED_CONSOLE_CHECK_SET, CONTROLLED_CONSOLE_REPOSITORY_ID, CONTROLLED_CONSOLE_TOKEN_ENV } from '../support/uc03/controlled-console-assembly.ts';

type ConsoleEnvelope<T> = Readonly<{ ok: true; result: T }> | Readonly<{ ok: false; error: string }>;
type ExperimentReply = Readonly<{ experiment: ExperimentView; receipt: ExperimentReceipt }>;
type ApprovalPresentation = Readonly<{
  experimentId: string;
  taskId: string;
  decisionId: string;
  actionKind: string;
  status: string;
  presentationVersion: number;
  requestVersion: number;
  presentationDigest: string;
  taskStateVersion: number;
  controlVersion: number;
  node: string;
}>;
type DecisionReply = Readonly<{
  outcome: 'ok';
  decision: 'approve' | 'reject';
  status: 'approved' | 'rejected';
  safeReasonCode: string;
  decisionId: string;
  experimentId: string;
  taskId: string;
  version: number;
  controlVersion: number;
  safeNextAction: string;
}>;

function resolveRepoRoot(): string {
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(cursor, 'package.json')) && existsSync(join(cursor, 'eval', 'uc03', 'manifest.json'))) {
      return cursor;
    }
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error('Could not locate repository root');
}

function controlledAssemblyPath(repoRoot: string): string {
  const isEmitted = fileURLToPath(import.meta.url).endsWith('.js');
  const repoRelative = isEmitted ? 'dist/tests/runtime/support/uc03/controlled-console-assembly.js' : 'tests/runtime/support/uc03/controlled-console-assembly.ts';
  return resolve(process.cwd()) === resolve(repoRoot) ? repoRelative : relative(process.cwd(), resolve(repoRoot, repoRelative));
}

function writeTempHostFile(repoRoot: string): { readonly dir: string; readonly hostFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'uc03-serve-controlled-'));
  const hostFile = join(dir, 'controlled-host.json');
  const config = buildControlledHostConfiguration(controlledAssemblyPath(repoRoot));
  writeFileSync(hostFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { dir, hostFile };
}

test('serve --host with controlled console assembly serves loopback page, catalog, approvals, replan, clarification and custom route', async () => {
  const repoRoot = resolveRepoRoot();
  const { dir, hostFile } = writeTempHostFile(repoRoot);
  const token = ['controlled', 'serve', 'operator', '01'].join('-');
  const previousToken = process.env[CONTROLLED_CONSOLE_TOKEN_ENV];
  process.env[CONTROLLED_CONSOLE_TOKEN_ENV] = token;

  const stderrChunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: Uint8Array | string, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    if (typeof encoding === 'function') return originalWrite(chunk, encoding);
    return originalWrite(chunk, encoding, cb);
  }) as typeof process.stderr.write;

  let cliResult: Awaited<ReturnType<typeof runEvaluateCli>> | undefined;
  try {
    cliResult = await runEvaluateCli(['serve', '--host', hostFile]);
    assert.equal(cliResult.exitCode, 0);
    assert.equal(cliResult.output.includes(token), false, 'operator token must never appear in stdout');

    const listening = JSON.parse(cliResult.output) as { outcome: string; host: string; port: number };
    assert.equal(listening.outcome, 'listening');
    assert.equal(listening.host, '127.0.0.1');
    assert.equal(Number.isSafeInteger(listening.port) && listening.port > 0, true);

    const origin = `http://${listening.host}:${listening.port}`;
    const headers = { 'content-type': 'application/json', origin, 'x-operator-token': token };

    const get = async <T>(path: string): Promise<{ status: number; body: ConsoleEnvelope<T> }> => {
      const response = await fetch(`${origin}${path}`);
      return { status: response.status, body: (await response.json()) as ConsoleEnvelope<T> };
    };
    const post = async <T>(path: string, body: unknown): Promise<{ status: number; body: ConsoleEnvelope<T> }> => {
      const response = await fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as ConsoleEnvelope<T> };
    };

    const unwrap = <T>(reply: { status: number; body: ConsoleEnvelope<T> }, label: string): T => {
      assert.equal(reply.status, 200, `${label}: expected HTTP 200, got ${reply.status} (${JSON.stringify(reply.body)})`);
      if (!reply.body.ok) {
        assert.fail(`${label}: expected ok envelope (${reply.body.error})`);
      }
      return reply.body.result;
    };

    let keySeq = 0;
    const nextKey = (label: string): string => `${label}-${++keySeq}`;

    // Page & catalog delivery
    const pageResponse = await fetch(`${origin}/`);
    assert.equal(pageResponse.status, 200);
    const pageHtml = await pageResponse.text();
    assert.match(pageHtml, /UC-03 Evaluation Console/u);
    assert.match(pageHtml, /id="decision-choice"/u);
    assert.match(pageHtml, /id="direction-kind"/u);
    assert.match(pageHtml, /value="revise"/u);
    assert.match(pageHtml, /value="end"/u);

    const forbidden = await fetch(`${origin}/api/experiments`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' });
    assert.equal(forbidden.status, 403);

    const catalog = unwrap<{ profileId: string; cases: readonly { caseId: string; ready: boolean }[] }>(await get('/api/catalog'), 'catalog');
    const profileId = catalog.profileId;
    assert.deepEqual(
      catalog.cases.map(item => ({ caseId: item.caseId, ready: item.ready })),
      [
        { caseId: 'C01', ready: true },
        { caseId: 'C02', ready: true },
      ],
    );
    const stderrText = stderrChunks.join('');
    assert.match(stderrText, /UC-03 controlled console operator token: using UC03_CONSOLE_OPERATOR_TOKEN from environment/u);
    assert.equal(stderrText.includes(token), false, 'env operator token must not be printed to stderr');

    const loadPresentation = async (experimentId: string): Promise<ApprovalPresentation> =>
      unwrap<ApprovalPresentation>(await get(`/api/experiments/${experimentId}/approval`), `approval(${experimentId})`);

    const issueAndContinue = async (
      experimentId: string,
      input: {
        kind: 'resume' | 'revise' | 'end';
        expectedTaskVersion: number;
        expectedControlVersion: number;
        decisionRef?: string;
        feedback?: string;
        keyPrefix: string;
      },
      expectedExperimentVersion: number,
    ): Promise<ExperimentView> => {
      const dirReply = unwrap<{ experiment: ExperimentView; receipt: ServiceControlReceipt }>(
        await post(`/api/experiments/${experimentId}/directions`, {
          idempotencyKey: nextKey(`${input.keyPrefix}-dir`),
          kind: input.kind,
          expectedTaskVersion: input.expectedTaskVersion,
          expectedControlVersion: input.expectedControlVersion,
          ...(input.decisionRef !== undefined ? { decisionRef: input.decisionRef } : {}),
          ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
        }),
        `${input.keyPrefix}-dir`,
      );
      assert.equal(dirReply.experiment.version, expectedExperimentVersion + 1);
      const contReply = unwrap<ExperimentReply>(
        await post(`/api/experiments/${experimentId}/continue`, {
          idempotencyKey: nextKey(`${input.keyPrefix}-cont`),
          directionRef: dirReply.receipt.receiptRef,
          expectedVersion: dirReply.experiment.version,
        }),
        `${input.keyPrefix}-cont`,
      );
      return contReply.experiment;
    };

    // --- 1. C01: reject D0 -> resume (AwaitFeedback) -> resume -> revise -> approve D0 -> approve D1 -> completed
    const c01Start = unwrap<ExperimentReply>(
      await post('/api/experiments', { profileId, idempotencyKey: nextKey('c01-replan-start'), source: { kind: 'catalog', caseIds: ['C01'] } }),
      'c01-replan-start',
    );
    let c01 = c01Start.experiment;
    assert.equal(c01.status, 'waiting-approval');
    assert.equal(c01.workflowReport, null);
    assert.equal(c01.control, null);

    const p0 = await loadPresentation(c01.id);
    assert.equal(p0.status, 'pending');
    assert.equal(p0.node, 'AwaitPlan');

    const rejected = unwrap<DecisionReply>(
      await post(`/api/experiments/${c01.id}/decision`, {
        idempotencyKey: nextKey('c01-reject-d0'),
        decision: 'reject',
        expectedVersion: p0.presentationVersion,
        presentationDigest: p0.presentationDigest,
      }),
      'c01-reject-d0',
    );
    assert.equal(rejected.status, 'rejected');
    const c01AfterReject = unwrap<ExperimentView>(await get(`/api/experiments/${c01.id}`), 'c01-after-reject');
    assert.deepEqual(c01AfterReject.control, { taskVersion: rejected.version, controlVersion: rejected.controlVersion });

    // Move AwaitPlan -> AwaitFeedback
    assert.ok(c01AfterReject.control);
    c01 = await issueAndContinue(
      c01.id,
      {
        kind: 'resume',
        expectedTaskVersion: c01AfterReject.control.taskVersion,
        expectedControlVersion: c01AfterReject.control.controlVersion,
        decisionRef: p0.decisionId,
        keyPrefix: 'c01-to-feedback',
      },
      c01.version,
    );
    assert.equal(c01.status, 'waiting-info');

    // Resume in AwaitFeedback stays paused at AwaitFeedback
    const pFeedback = await loadPresentation(c01.id);
    assert.equal(pFeedback.node, 'AwaitFeedback');
    assert.deepEqual(c01.control, { taskVersion: pFeedback.taskStateVersion, controlVersion: pFeedback.controlVersion });
    c01 = await issueAndContinue(
      c01.id,
      { kind: 'resume', expectedTaskVersion: pFeedback.taskStateVersion, expectedControlVersion: pFeedback.controlVersion, decisionRef: p0.decisionId, keyPrefix: 'c01-feedback-resume' },
      c01.version,
    );
    assert.equal(c01.status, 'waiting-info');

    // Revise in AwaitFeedback produces renewed AwaitPlan v2
    const pFeedback2 = await loadPresentation(c01.id);
    assert.deepEqual(c01.control, { taskVersion: pFeedback2.taskStateVersion, controlVersion: pFeedback2.controlVersion });
    assert.ok(c01.control);
    c01 = await issueAndContinue(
      c01.id,
      {
        kind: 'revise',
        expectedTaskVersion: c01.control.taskVersion,
        expectedControlVersion: c01.control.controlVersion,
        decisionRef: p0.decisionId,
        feedback: 'Check denominator before float division.',
        keyPrefix: 'c01-feedback-revise',
      },
      c01.version,
    );
    assert.equal(c01.status, 'waiting-approval', `expected waiting-approval after revise, got ${c01.status}: ${JSON.stringify(c01)}`);
    assert.equal(c01.control, null);

    const pRenewed = await loadPresentation(c01.id);
    assert.equal(pRenewed.status, 'pending');
    assert.equal(pRenewed.node, 'AwaitPlan');
    assert.match(pRenewed.decisionId, /^renewed-/u);

    const approvedD0 = unwrap<DecisionReply>(
      await post(`/api/experiments/${c01.id}/decision`, {
        idempotencyKey: nextKey('c01-approve-d0-v2'),
        decision: 'approve',
        expectedVersion: pRenewed.presentationVersion,
        presentationDigest: pRenewed.presentationDigest,
      }),
      'c01-approve-d0-v2',
    );
    assert.equal(approvedD0.status, 'approved');

    c01 = await issueAndContinue(
      c01.id,
      { kind: 'resume', expectedTaskVersion: approvedD0.version, expectedControlVersion: approvedD0.controlVersion, decisionRef: pRenewed.decisionId, keyPrefix: 'c01-patch-verify' },
      c01.version,
    );
    assert.equal(c01.status, 'waiting-approval');
    assert.equal(c01.control, null);

    const pD1 = await loadPresentation(c01.id);
    assert.equal(pD1.status, 'pending');
    assert.match(pD1.decisionId, /^dec-verify-/u);

    const approvedD1 = unwrap<DecisionReply>(
      await post(`/api/experiments/${c01.id}/decision`, {
        idempotencyKey: nextKey('c01-approve-d1'),
        decision: 'approve',
        expectedVersion: pD1.presentationVersion,
        presentationDigest: pD1.presentationDigest,
      }),
      'c01-approve-d1',
    );
    c01 = await issueAndContinue(
      c01.id,
      { kind: 'resume', expectedTaskVersion: approvedD1.version, expectedControlVersion: approvedD1.controlVersion, decisionRef: pD1.decisionId, keyPrefix: 'c01-deliver' },
      c01.version,
    );
    assert.equal(c01.status, 'completed');
    assert.equal(c01.control, null);

    // --- 2. C01: reject D0 -> resume (AwaitFeedback) -> end -> incomplete
    const c01EndStart = unwrap<ExperimentReply>(
      await post('/api/experiments', { profileId, idempotencyKey: nextKey('c01-end-start'), source: { kind: 'catalog', caseIds: ['C01'] } }),
      'c01-end-start',
    );
    let c01End = c01EndStart.experiment;
    const pEnd0 = await loadPresentation(c01End.id);
    const rejectedEnd = unwrap<DecisionReply>(
      await post(`/api/experiments/${c01End.id}/decision`, {
        idempotencyKey: nextKey('c01-end-reject'),
        decision: 'reject',
        expectedVersion: pEnd0.presentationVersion,
        presentationDigest: pEnd0.presentationDigest,
      }),
      'c01-end-reject',
    );
    c01End = await issueAndContinue(
      c01End.id,
      { kind: 'resume', expectedTaskVersion: rejectedEnd.version, expectedControlVersion: rejectedEnd.controlVersion, decisionRef: pEnd0.decisionId, keyPrefix: 'c01-end-feedback' },
      c01End.version,
    );
    assert.equal(c01End.status, 'waiting-info');
    const pEndFeedback = await loadPresentation(c01End.id);
    c01End = await issueAndContinue(
      c01End.id,
      { kind: 'end', expectedTaskVersion: pEndFeedback.taskStateVersion, expectedControlVersion: pEndFeedback.controlVersion, decisionRef: pEnd0.decisionId, keyPrefix: 'c01-end-terminate' },
      c01End.version,
    );
    assert.equal(c01End.status, 'incomplete');
    assert.equal(c01End.control, null);

    // --- 3. C02: clarification pause -> answer -> resume -> D0 -> D1 -> completed
    const c02Start = unwrap<ExperimentReply>(await post('/api/experiments', { profileId, idempotencyKey: nextKey('c02-start'), source: { kind: 'catalog', caseIds: ['C02'] } }), 'c02-start');
    let c02 = c02Start.experiment;
    assert.equal(c02.status, 'waiting-info');
    assert.ok(c02.workflowClarification);
    assert.match(c02.workflowClarification.questionId, /^sha256:/u);
    assert.equal(c02.workflowClarification.questions[0]?.questionId, 'q-denominator');

    const answered = unwrap<ExperimentReply>(
      await post(`/api/experiments/${c02.id}/answers`, {
        idempotencyKey: nextKey('c02-answer'),
        questionId: c02.workflowClarification.questionId,
        questionDigest: c02.workflowClarification.questionDigest,
        expectedVersion: c02.version,
        answers: ['Raise CalculationError when b == 0.'],
      }),
      'c02-answer',
    );
    c02 = answered.experiment;
    assert.equal(c02.status, 'waiting-info');
    assert.ok(c02.control && c02.control.taskVersion > 0 && c02.control.controlVersion === 0);

    const staleC02 = await post(`/api/experiments/${c02.id}/directions`, {
      idempotencyKey: nextKey('c02-stale-ver'),
      kind: 'resume',
      expectedTaskVersion: c02.control.taskVersion + 1,
      expectedControlVersion: c02.control.controlVersion,
    });
    assert.equal(staleC02.status, 500);
    assert.deepEqual(staleC02.body, { ok: false, error: 'SERVICE_ERROR' });

    c02 = await issueAndContinue(c02.id, { kind: 'resume', expectedTaskVersion: c02.control.taskVersion, expectedControlVersion: c02.control.controlVersion, keyPrefix: 'c02-resume' }, c02.version);
    assert.equal(c02.status, 'waiting-approval');

    const c02P0 = await loadPresentation(c02.id);
    const c02D0 = unwrap<DecisionReply>(
      await post(`/api/experiments/${c02.id}/decision`, {
        idempotencyKey: nextKey('c02-d0'),
        decision: 'approve',
        expectedVersion: c02P0.presentationVersion,
        presentationDigest: c02P0.presentationDigest,
      }),
      'c02-d0',
    );
    c02 = await issueAndContinue(
      c02.id,
      { kind: 'resume', expectedTaskVersion: c02D0.version, expectedControlVersion: c02D0.controlVersion, decisionRef: c02P0.decisionId, keyPrefix: 'c02-after-d0' },
      c02.version,
    );
    assert.equal(c02.status, 'waiting-approval');

    const c02P1 = await loadPresentation(c02.id);
    const c02D1 = unwrap<DecisionReply>(
      await post(`/api/experiments/${c02.id}/decision`, {
        idempotencyKey: nextKey('c02-d1'),
        decision: 'approve',
        expectedVersion: c02P1.presentationVersion,
        presentationDigest: c02P1.presentationDigest,
      }),
      'c02-d1',
    );
    c02 = await issueAndContinue(
      c02.id,
      { kind: 'resume', expectedTaskVersion: c02D1.version, expectedControlVersion: c02D1.controlVersion, decisionRef: c02P1.decisionId, keyPrefix: 'c02-deliver' },
      c02.version,
    );
    assert.equal(c02.status, 'completed');

    // --- 4. Exploratory customRoute bug submission
    const customStart = unwrap<ExperimentReply>(
      await post('/api/experiments', {
        profileId,
        idempotencyKey: nextKey('custom-complete-start'),
        source: {
          kind: 'bug',
          repositoryId: CONTROLLED_CONSOLE_REPOSITORY_ID,
          checkSetId: CONTROLLED_CONSOLE_CHECK_SET,
          bugInput: {
            goal: 'Reject zero divisor safely',
            observedBehavior: 'divide(1, 0) raises ZeroDivisionError',
            expectedBehavior: 'divide(1, 0) raises CalculationError',
            reproduction: 'pytest -q tests/test_calculator.py -k test_divide_zero',
            acceptanceCriteria: ['divide(1, 0) raises CalculationError'],
          },
        },
      }),
      'custom-complete-start',
    );
    let custom = customStart.experiment;
    assert.equal(custom.scope, 'exploratory');
    assert.equal(custom.graded, false);
    assert.equal(custom.status, 'waiting-approval');
    assert.equal(custom.workflowReport, null);

    const customP0 = await loadPresentation(custom.id);
    const customD0 = unwrap<DecisionReply>(
      await post(`/api/experiments/${custom.id}/decision`, {
        idempotencyKey: nextKey('custom-d0'),
        decision: 'approve',
        expectedVersion: customP0.presentationVersion,
        presentationDigest: customP0.presentationDigest,
      }),
      'custom-d0',
    );
    custom = await issueAndContinue(
      custom.id,
      { kind: 'resume', expectedTaskVersion: customD0.version, expectedControlVersion: customD0.controlVersion, decisionRef: customP0.decisionId, keyPrefix: 'custom-after-d0' },
      custom.version,
    );
    assert.equal(custom.status, 'waiting-approval');

    const customP1 = await loadPresentation(custom.id);
    const customD1 = unwrap<DecisionReply>(
      await post(`/api/experiments/${custom.id}/decision`, {
        idempotencyKey: nextKey('custom-d1'),
        decision: 'approve',
        expectedVersion: customP1.presentationVersion,
        presentationDigest: customP1.presentationDigest,
      }),
      'custom-d1',
    );
    custom = await issueAndContinue(
      custom.id,
      { kind: 'resume', expectedTaskVersion: customD1.version, expectedControlVersion: customD1.controlVersion, decisionRef: customP1.decisionId, keyPrefix: 'custom-deliver' },
      custom.version,
    );
    assert.equal(custom.status, 'completed');
    assert.equal(custom.graded, false);
    assert.equal(custom.scope, 'exploratory');
  } finally {
    process.stderr.write = originalWrite;
    await cliResult?.close?.();
    if (previousToken === undefined) {
      Reflect.deleteProperty(process.env, CONTROLLED_CONSOLE_TOKEN_ENV);
    } else {
      process.env[CONTROLLED_CONSOLE_TOKEN_ENV] = previousToken;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('serve --host generates a per-process operator token to stderr when env var is unset', async () => {
  const repoRoot = resolveRepoRoot();
  const { dir, hostFile } = writeTempHostFile(repoRoot);
  const previousToken = process.env[CONTROLLED_CONSOLE_TOKEN_ENV];
  Reflect.deleteProperty(process.env, CONTROLLED_CONSOLE_TOKEN_ENV);

  const stderrChunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: Uint8Array | string, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    if (typeof encoding === 'function') return originalWrite(chunk, encoding);
    return originalWrite(chunk, encoding, cb);
  }) as typeof process.stderr.write;

  let cliResult: Awaited<ReturnType<typeof runEvaluateCli>> | undefined;
  try {
    cliResult = await runEvaluateCli(['serve', '--host', hostFile]);
    assert.equal(cliResult.exitCode, 0);
    const listening = JSON.parse(cliResult.output) as { outcome: string; host: string; port: number };
    assert.equal(listening.outcome, 'listening');

    const stderrText = stderrChunks.join('');
    const matches = [...stderrText.matchAll(/^UC-03 controlled console operator token \(generated per-process\): ([a-f0-9]{48})\r?$/gmu)];
    assert.equal(matches.length, 1, 'expected exactly one per-process generated 48-hex token line on stderr');
    const generatedToken = matches[0]?.[1];
    assert.ok(generatedToken, 'expected per-process generated 48-hex token on stderr');
    assert.equal(cliResult.output.includes(generatedToken), false, 'generated token must never appear in stdout');

    const origin = `http://${listening.host}:${listening.port}`;
    const catalogRes = await fetch(`${origin}/api/catalog`);
    assert.equal(catalogRes.status, 200);
    const catalogBody = (await catalogRes.json()) as ConsoleEnvelope<{ profileId: string }>;
    assert.equal(catalogBody.ok, true);
    if (!catalogBody.ok) return;

    const intakeRes = await fetch(`${origin}/api/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'x-operator-token': generatedToken },
      body: JSON.stringify({
        profileId: catalogBody.result.profileId,
        idempotencyKey: ['generated', 'req', '1'].join('-'),
        source: {
          kind: 'bug',
          repositoryId: CONTROLLED_CONSOLE_REPOSITORY_ID,
          checkSetId: CONTROLLED_CONSOLE_CHECK_SET,
          bugInput: {
            goal: 'Reject zero divisor',
            observedBehavior: 'Raises ZeroDivisionError',
            expectedBehavior: 'Raises CalculationError',
          },
        },
      }),
    });
    assert.equal(intakeRes.status, 200);
  } finally {
    process.stderr.write = originalWrite;
    await cliResult?.close?.();
    if (previousToken !== undefined) {
      process.env[CONTROLLED_CONSOLE_TOKEN_ENV] = previousToken;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('serve --host replays an earlier rejection after revise and returns the original result', async () => {
  const repoRoot = resolveRepoRoot();
  const { dir, hostFile } = writeTempHostFile(repoRoot);
  const token = ['controlled', 'serve', 'replay', '01'].join('-');
  const previousToken = process.env[CONTROLLED_CONSOLE_TOKEN_ENV];
  process.env[CONTROLLED_CONSOLE_TOKEN_ENV] = token;

  let cliResult: Awaited<ReturnType<typeof runEvaluateCli>> | undefined;
  try {
    cliResult = await runEvaluateCli(['serve', '--host', hostFile]);
    assert.equal(cliResult.exitCode, 0);
    const listening = JSON.parse(cliResult.output) as { outcome: string; host: string; port: number };
    const origin = `http://${listening.host}:${listening.port}`;
    const headers = { 'content-type': 'application/json', origin, 'x-operator-token': token };

    const get = async <T>(path: string): Promise<T> => {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as ConsoleEnvelope<T>;
      if (!body.ok) assert.fail(body.error);
      return body.result;
    };
    const post = async <T>(path: string, body: unknown): Promise<{ status: number; body: ConsoleEnvelope<T> }> => {
      const response = await fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as ConsoleEnvelope<T> };
    };
    const postOk = async <T>(path: string, body: unknown): Promise<T> => {
      const reply = await post<T>(path, body);
      assert.equal(reply.status, 200);
      if (!reply.body.ok) assert.fail(reply.body.error);
      return reply.body.result;
    };

    const catalog = await get<{ profileId: string }>('/api/catalog');
    const started = await postOk<ExperimentReply>('/api/experiments', {
      profileId: catalog.profileId,
      idempotencyKey: 'replay-c01-start',
      source: { kind: 'catalog', caseIds: ['C01'] },
    });
    let exp = started.experiment;
    assert.equal(exp.status, 'waiting-approval', `expected waiting-approval after C01 start, got ${exp.status}: ${JSON.stringify(exp)}`);
    const p0 = await get<ApprovalPresentation>(`/api/experiments/${exp.id}/approval`);

    const rejectPayload = {
      idempotencyKey: 'replay-c01-reject-d0',
      decision: 'reject' as const,
      expectedVersion: p0.presentationVersion,
      presentationDigest: p0.presentationDigest,
    };
    const rejected = await postOk<DecisionReply>(`/api/experiments/${exp.id}/decision`, rejectPayload);
    assert.equal(rejected.status, 'rejected');

    const toFeedbackDir = await postOk<{ experiment: ExperimentView; receipt: ServiceControlReceipt }>(`/api/experiments/${exp.id}/directions`, {
      idempotencyKey: 'replay-c01-to-feedback-dir',
      kind: 'resume',
      expectedTaskVersion: rejected.version,
      expectedControlVersion: rejected.controlVersion,
      decisionRef: p0.decisionId,
    });
    exp = (
      await postOk<ExperimentReply>(`/api/experiments/${exp.id}/continue`, {
        idempotencyKey: 'replay-c01-to-feedback-cont',
        directionRef: toFeedbackDir.receipt.receiptRef,
        expectedVersion: toFeedbackDir.experiment.version,
      })
    ).experiment;
    assert.equal(exp.status, 'waiting-info');

    const pFeedback = await get<ApprovalPresentation>(`/api/experiments/${exp.id}/approval`);
    const reviseDir = await postOk<{ experiment: ExperimentView; receipt: ServiceControlReceipt }>(`/api/experiments/${exp.id}/directions`, {
      idempotencyKey: 'replay-c01-revise-dir',
      kind: 'revise',
      expectedTaskVersion: pFeedback.taskStateVersion,
      expectedControlVersion: pFeedback.controlVersion,
      decisionRef: p0.decisionId,
      feedback: 'Refine guard',
    });
    exp = (
      await postOk<ExperimentReply>(`/api/experiments/${exp.id}/continue`, {
        idempotencyKey: 'replay-c01-revise-cont',
        directionRef: reviseDir.receipt.receiptRef,
        expectedVersion: reviseDir.experiment.version,
      })
    ).experiment;
    assert.equal(exp.status, 'waiting-approval');

    const pRenewed = await get<ApprovalPresentation>(`/api/experiments/${exp.id}/approval`);
    assert.notEqual(pRenewed.decisionId, p0.decisionId);

    const replayed = await postOk<DecisionReply>(`/api/experiments/${exp.id}/decision`, rejectPayload);
    assert.deepEqual(replayed, rejected);

    const staleNewRequest = await post<DecisionReply>(`/api/experiments/${exp.id}/decision`, {
      ...rejectPayload,
      idempotencyKey: 'replay-c01-reject-d0-stale-new-key',
    });
    assert.equal(staleNewRequest.status, 409);
  } finally {
    await cliResult?.close?.();
    if (previousToken === undefined) {
      Reflect.deleteProperty(process.env, CONTROLLED_CONSOLE_TOKEN_ENV);
    } else {
      process.env[CONTROLLED_CONSOLE_TOKEN_ENV] = previousToken;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
