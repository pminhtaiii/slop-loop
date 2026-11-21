/**
 * Issue #212 controlled witness: a bound real-tier C01 completes a full repair.
 *
 * With the volume-spawn double and a scripted provider serving both coder and reviewer turns, this
 * drives a bound C01 from the start to `Complete`: plan approval, the post-patch verification
 * approval, one patch, checks and an accepted review, then the owner completion context and the
 * delivery transition. The final report's usage and evidence must match the run, and the T028 C16
 * judge must pass on it.
 *
 * Refusal rows: a rejected review routes to Repair inside the task's repair budget instead of
 * completing; a protected-tests digest that differs from the baseline's refuses completion; and
 * removing the reviewer admission or the completion context each stops the run before Complete.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BugTask } from '../../../src/contracts/foundation/uc03.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import { resolveRealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import { bindRealTierTask } from '../../../src/runtime/real-tier-task-binding.ts';
import { createHostCoderGeneration } from '../../../src/runtime/host-coder.ts';
import { runUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { judgeC16Report } from './uc03-success-real-c16.ts';
import { createVolumeSpawn } from '../support/docker-volume-spawn.ts';
import { createScanFixture } from '../unit/real-tier-scan-fixtures.ts';

const fixture = createScanFixture('deliver-', 'deliver-profile-fixture');

const SOURCE = 'def divide(a, b):\n    return a / b\n';
const TEST_SOURCE = 'def test_divide_zero():\n    assert False\n';
const PATCH = '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1,2 +1,4 @@\n def divide(a, b):\n+    if b == 0:\n+        raise ValueError("divisor")\n     return a / b\n';
/** A repair that the scripted provider returns on the Repair turn after a findings review. */
const REPAIR =
  '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1,4 +1,4 @@\n def divide(a, b):\n     if b == 0:\n-        raise ValueError("divisor")\n+        raise ValueError("divisor must be non-zero")\n     return a / b\n';

const ACCEPTED = { status: 'accepted', findings: [] };

interface SetupOverrides {
  /** The reviewer's verdict for each review round, replayed in order; the last repeats. */
  readonly reviewVerdicts?: readonly Record<string, unknown>[];
  /** Rewrites the protected test file once the patch has landed, so the current digest drifts. */
  readonly tamperProtectedTest?: boolean;
}

async function setup(overrides: SetupOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deliver-case-'));
  const repositoryRoot = join(root, 'repository');
  mkdirSync(join(repositoryRoot, 'src'), { recursive: true });
  mkdirSync(join(repositoryRoot, 'tests'), { recursive: true });
  writeFileSync(join(repositoryRoot, 'src/calculator.py'), SOURCE);
  writeFileSync(join(repositoryRoot, 'tests/test_calculator.py'), TEST_SOURCE);
  const revision = await new WorkspaceFilesystemPort({ root: repositoryRoot }).getCurrentRevisionDigest();
  const task: BugTask = {
    taskId: 'task-deliver',
    repositoryId: 'repo-calculator',
    initialRevisionDigest: revision,
    goal: 'Handle zero denominator',
    observedBehavior: 'ZeroDivisionError',
    expectedBehavior: 'ValueError',
    reproduction: 'pytest -q tests/test_calculator.py',
    acceptanceCriteria: ['divide(1, 0) raises ValueError'],
    constraints: [],
    requiredChecks: [
      { checkId: 'check-zero', executable: 'pytest', argv: ['-q', 'tests/test_calculator.py'], purpose: 'reproduction', workingDirectory: '/workspace/repo', timeoutMs: 1000, maxOutputBytes: 4096 },
    ],
    limits: { timeoutMs: 1000, maxOutputBytes: 4096, maxCpuCores: 1, maxMemoryBytes: 1048576, maxPids: 16 },
    budgetLimits: { maxReplanCount: 3, maxTokens: 100000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 },
    configId: 'config-deliver',
    configVersion: '1.0.0',
  };
  const document = JSON.stringify({ task, repositoryRoot: 'repository' });
  const fixturePath = join(root, 'case.json');
  writeFileSync(fixturePath, document);
  const catalogPath = join(root, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify({ catalog: [{ caseId: 'C01', fixturePath, fixtureDigest: sha256Text(document), initialRepositoryDigest: revision.slice(7) }] }));
  const docker = createVolumeSpawn();
  const counts = { baselineCalls: 0, verificationRuns: 0, reviewCalls: 0, repairProposals: 0 };
  const sourceAtStart = SOURCE;
  const patched = (): boolean => readFileSync(join(repositoryRoot, 'src/calculator.py'), 'utf8') !== sourceAtStart;
  let approvedPlanRef = 'placeholder';
  const verdicts = [...(overrides.reviewVerdicts ?? [ACCEPTED])];
  // One cursor serves both roles, so each role's turn is a distinct scripted response.
  const responses: (() => Record<string, unknown>)[] = [
    () => ({ kind: 'inspect', proposalId: 'inspect-source', operation: 'read_file', args: { path: 'src/calculator.py' } }),
    () => ({
      kind: 'propose-plan',
      proposalId: 'plan-zero',
      diagnosis: 'The denominator is unchecked',
      strategy: 'Raise ValueError for zero',
      suspectedLocations: ['src/calculator.py'],
      scopedPaths: ['src/calculator.py'],
      evidenceRefs: ['src/calculator.py'],
    }),
    () => ({ kind: 'propose-patch', proposalId: 'patch-zero', diff: PATCH, targetPaths: ['src/calculator.py'], approvedPlanRef }),
    () => ({ kind: 'propose-patch', proposalId: `repair-${(counts.repairProposals += 1)}`, diff: REPAIR, targetPaths: ['src/calculator.py'], approvedPlanRef }),
  ];
  let cursor = 0;
  const assembly = resolveRealTierAssembly({
    env: fixture.envOf({ catalog: { path: catalogPath } }),
    stateRoot: join(root, 'state'),
    revision: 'a'.repeat(40),
    spawn: async (command, args, options) => {
      if (args[0] === 'run' && args.includes('pytest')) {
        // Before the patch the reproduction fails; after it, the verification checks pass and the
        // repository host snapshot measures the (possibly tampered) protected test file.
        if (patched()) {
          counts.verificationRuns++;
          return { exitCode: 0, stdout: '1 passed', stderr: '', timedOut: false };
        }
        counts.baselineCalls++;
        return { exitCode: 1, stdout: 'FAILED tests/test_calculator.py - ValueError expected', stderr: '', timedOut: false };
      }
      return docker.spawn(command, args, options);
    },
    fetch: async (_url, init) => {
      // The reviewer shares this transport in its own role; the prompt's `purpose` is the unescaped
      // discriminator between the two roles' turns.
      const body = typeof init?.body === 'string' ? init.body : '';
      const response = body.includes('final-review')
        ? (verdicts[Math.min(counts.reviewCalls++, verdicts.length - 1)] ?? ACCEPTED)
        : (responses[Math.min(cursor++, responses.length - 1)]?.() ?? responses.at(-1)?.());
      assert.ok(response);
      return new Response(
        JSON.stringify({
          id: `r-${cursor}-${counts.reviewCalls}`,
          type: 'message',
          role: 'assistant',
          model: fixture.MODEL,
          content: [{ type: 'text', text: JSON.stringify(response) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(assembly.status, 'assembly-ready', JSON.stringify(assembly));
  if (assembly.status !== 'assembly-ready') throw new Error('assembly unavailable');
  const bound = await bindRealTierTask(assembly, {
    caseId: 'C01',
    pins: { contractVersion: 'uc03-host-composition/2', revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, assembly.revision])) },
    identity: { profileId: 'deliver-profile', profileDigest: assembly.metadata.profileDigest, configDigest: revision, pricingDigest: revision },
    retainedRoot: join(root, 'retained'),
  });
  assert.equal(bound.status, 'task-bound', JSON.stringify(bound));
  if (bound.status !== 'task-bound') throw new Error('binding unavailable');
  const generation = createHostCoderGeneration({
    model: bound.ports.modelPort,
    repository: bound.ports.repositoryPort,
    guardedRead: bound.ports.guardedRead,
    admissionContextForCheck: bound.config.trustedExpectedContext.admissionContextForCheck,
    budget: { maxModelCalls: 8, maxActiveMs: 60000, maxRepairs: 2, maxReplans: 3 },
  });
  // The reviewer ingress dispatches through the same recorded transport, so its verdict comes from
  // this cursor too; the reviewer's own response is scripted as the next turn after a passing Verify.
  const reviewerVerdict = (): Record<string, unknown> => verdicts[Math.min(counts.reviewCalls++, verdicts.length - 1)] ?? ACCEPTED;
  const config = { ...bound.config, generation };
  const owners = assembly.owners.taskOwners({ ...bound.ids, repositoryId: task.repositoryId });
  const setPlanRef = (ref: string): void => {
    approvedPlanRef = ref;
  };
  return {
    root,
    repositoryRoot,
    assembly,
    bound,
    config,
    owners,
    docker,
    setPlanRef,
    counts,
    reviewerVerdict,
    source: () => readFileSync(join(repositoryRoot, 'src/calculator.py'), 'utf8'),
    tamperProtectedTest: () => writeFileSync(join(repositoryRoot, 'tests/test_calculator.py'), 'def test_divide_zero():\n    pass\n'),
  };
}

/** Present the pending plan through the owner console and record the operator's explicit choice. */
async function decide(h: Awaited<ReturnType<typeof setup>>, decision: 'approve' | 'reject'): Promise<string> {
  const shown = await h.owners.console.presentation('C01');
  assert.equal(shown.ok, true, JSON.stringify(shown));
  if (!shown.ok) throw new Error('no presentation');
  const view = shown.value as { readonly presentation: { readonly presentationDigest: string; readonly requestVersion: number; readonly decisionId: string } };
  const decisionId = view.presentation.decisionId;
  const decided = await h.owners.console.decide({
    experimentId: 'C01',
    presentationDigest: view.presentation.presentationDigest,
    expectedVersion: view.presentation.requestVersion,
    decision,
    idempotencyKey: `key-${decisionId}`,
  });
  assert.equal(decided.ok, true, JSON.stringify(decided));
  return decisionId;
}

test('a bound C01 completes a full repair and the final report passes the C16 judge', async () => {
  const h = await setup();
  const paused = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);
  assert.equal(paused.outcome, 'pending-approval', JSON.stringify(paused.reasons));
  const plan = paused.state?.plan;
  assert.ok(plan?.decisionRef);
  h.setPlanRef(plan.decisionRef);
  await decide(h, 'approve');

  const patched = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config, paused.state ?? undefined);
  assert.equal(patched.outcome, 'pending-approval', JSON.stringify(patched.reasons));
  assert.equal(patched.state?.node, 'Verify', JSON.stringify(patched.reasons));
  await decide(h, 'approve');

  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config, patched.state ?? undefined);
  assert.equal(result.outcome, 'COMPLETED', JSON.stringify(result.reasons));
  assert.equal(result.state?.node, 'Deliver');
  assert.equal(result.state?.outcome, 'COMPLETED');
  assert.equal(result.finalReport?.isComplete, true);
  assert.equal(result.finalReport?.delivery?.outcome, 'COMPLETED');
  assert.ok(result.finalReport?.evidence.reviewRef);
  assert.ok(result.finalReport?.evidence.evidenceRefs.length);
  assert.match(h.source(), /raise ValueError\("divisor"\)/);

  // The report's usage is the run's own settled accounting, not a recomputation.
  const owner = await h.owners.statePort.loadTask(h.bound.task.taskId);
  assert.ok(owner?.outcome === 'COMPLETED');
  const tokenLedger = owner.budgetLedgers?.find(ledger => ledger.scope === 'task' && ledger.kind === 'tokens');
  assert.ok(tokenLedger);
  assert.equal(result.finalReport?.usage.tokensConsumed, tokenLedger.consumed);
  const costLedger = owner.budgetLedgers?.find(ledger => ledger.scope === 'task' && ledger.kind === 'cost');
  assert.equal(result.finalReport?.usage.costUsd, costLedger?.consumed);

  // T028 C16: the report is present, bounded, sanitized and provenanced.
  const judged = judgeC16Report(result.finalReport);
  assert.equal(judged.ok, true, judged.reasonCode);
  assert.equal(judged.facts.outcome, 'COMPLETED');
  assert.equal(judged.facts.isComplete, true);
});

test('a rejected review routes to Repair within the repair budget instead of completing', async () => {
  const h = await setup({ reviewVerdicts: [{ status: 'findings', findings: [] }, ACCEPTED] });
  const paused = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);
  h.setPlanRef(paused.state?.plan?.decisionRef ?? 'unused');
  await decide(h, 'approve');
  const patched = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config, paused.state ?? undefined);
  await decide(h, 'approve');

  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config, patched.state ?? undefined);
  // The findings review leaves an owner Repair candidate; the run is not Complete.
  assert.notEqual(result.outcome, 'COMPLETED');
  const repaired = await h.owners.statePort.loadTask(h.bound.task.taskId);
  assert.equal(repaired?.node, 'Repair', JSON.stringify(result.reasons));
  const repairs = repaired?.budgetLedgers?.find(ledger => ledger.scope === 'task' && ledger.kind === 'repair');
  assert.ok((repairs?.consumed ?? 0) <= (repairs?.limit ?? 0));
});

test('completion is refused when the protected-tests digest differs from the baseline', async () => {
  const h = await setup();
  // The tampered test file drifts the current protected-tests digest away from the baseline's.
  const paused = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);
  h.setPlanRef(paused.state?.plan?.decisionRef ?? 'unused');
  await decide(h, 'approve');
  const patched = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config, paused.state ?? undefined);
  await decide(h, 'approve');
  // Tamper only once the checks have run, so the completion stage sees drifted protected bytes.
  h.tamperProtectedTest();
  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config, patched.state ?? undefined);
  assert.notEqual(result.outcome, 'COMPLETED');
  assert.equal(result.finalReport?.isComplete, false);
});

/** The same config with one key absent, so a removal row exercises the run without it. */
function without(config: Awaited<ReturnType<typeof setup>>['config'], key: 'reviewerAdmission' | 'completionContextFor'): typeof config {
  return Object.fromEntries(Object.entries(config).filter(([name]) => name !== key)) as typeof config;
}

test('removing the reviewer admission stops the run before Complete', async () => {
  const h = await setup();
  const paused = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);
  h.setPlanRef(paused.state?.plan?.decisionRef ?? 'unused');
  await decide(h, 'approve');
  const patched = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config, paused.state ?? undefined);
  await decide(h, 'approve');
  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, without(h.config, 'reviewerAdmission'), patched.state ?? undefined);
  assert.notEqual(result.outcome, 'COMPLETED');
  assert.notEqual(result.state?.node, 'Deliver', JSON.stringify(result.reasons));
});

test('removing the completion context stops the run before Complete', async () => {
  const h = await setup();
  const paused = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);
  h.setPlanRef(paused.state?.plan?.decisionRef ?? 'unused');
  await decide(h, 'approve');
  const patched = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config, paused.state ?? undefined);
  await decide(h, 'approve');
  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, without(h.config, 'completionContextFor'), patched.state ?? undefined);
  assert.notEqual(result.outcome, 'COMPLETED');
  assert.notEqual(result.state?.node, 'Deliver', JSON.stringify(result.reasons));
});
