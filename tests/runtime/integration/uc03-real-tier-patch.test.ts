/**
 * Issue #211 controlled witness: a bound real-tier C01 reaches a human plan pause, the operator
 * approves it through the real UC-05 approval service, and the bound task then applies exactly one
 * admitted patch, verifies it against the patched revision, and advances to Review (or the reviewer
 * dispatch point, which #212 owns). The volume is the in-memory spawn double; the provider is a
 * scripted fetch; no live Docker or endpoint is used.
 *
 * Refusal rows: a patch outside the plan scope gets zero patch effects, a stale plan decision gets
 * zero patch effects, and a rejected plan ends on its own hold with no patch attempt.
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
import { createVolumeSpawn } from '../support/docker-volume-spawn.ts';
import { createScanFixture } from '../unit/real-tier-scan-fixtures.ts';

const fixture = createScanFixture('patch-', 'patch-profile-fixture');

const SOURCE = 'def divide(a, b):\n    return a / b\n';
const TEST_SOURCE = 'def test_divide_zero():\n    assert False\n';
const PATCH = '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1,2 +1,4 @@\n def divide(a, b):\n+    if b == 0:\n+        raise ValueError("divisor")\n     return a / b\n';

interface SetupOverrides {
  /** The patch proposal the scripted provider returns on the Patch turn. */
  readonly patchProposal?: (planRef: string) => Record<string, unknown>;
  /** Overrides the plan's `scopedPaths`, to test a plan whose scope excludes the patch target. */
  readonly scopedPaths?: readonly string[];
}

async function setup(overrides: SetupOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'patch-case-'));
  const repositoryRoot = join(root, 'repository');
  mkdirSync(join(repositoryRoot, 'src'), { recursive: true });
  mkdirSync(join(repositoryRoot, 'tests'), { recursive: true });
  writeFileSync(join(repositoryRoot, 'src/calculator.py'), SOURCE);
  writeFileSync(join(repositoryRoot, 'tests/test_calculator.py'), TEST_SOURCE);
  const revision = await new WorkspaceFilesystemPort({ root: repositoryRoot }).getCurrentRevisionDigest();
  const task: BugTask = {
    taskId: 'task-patch',
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
    configId: 'config-patch',
    configVersion: '1.0.0',
  };
  const document = JSON.stringify({ task, repositoryRoot: 'repository' });
  const fixturePath = join(root, 'case.json');
  writeFileSync(fixturePath, document);
  const catalogPath = join(root, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify({ catalog: [{ caseId: 'C01', fixturePath, fixtureDigest: sha256Text(document), initialRepositoryDigest: revision.slice(7) }] }));
  const docker = createVolumeSpawn();
  let baselineCalls = 0;
  let verificationRuns = 0;
  const sourceAtStart = SOURCE;
  const patched = (): boolean => readFileSync(join(repositoryRoot, 'src/calculator.py'), 'utf8') !== sourceAtStart;
  let fetches = 0;
  // The patch proposal must name the approved plan; the plan's own decision ref is read after the pause.
  let approvedPlanRef = 'placeholder';
  const responses = [
    { kind: 'inspect', proposalId: 'inspect-source', operation: 'read_file', args: { path: 'src/calculator.py' } },
    {
      kind: 'propose-plan',
      proposalId: 'plan-zero',
      diagnosis: 'The denominator is unchecked',
      strategy: 'Raise ValueError for zero',
      suspectedLocations: ['src/calculator.py'],
      scopedPaths: [...(overrides.scopedPaths ?? ['src/calculator.py'])],
      evidenceRefs: ['src/calculator.py'],
    },
    () => overrides.patchProposal?.(approvedPlanRef) ?? { kind: 'propose-patch', proposalId: 'patch-zero', diff: PATCH, targetPaths: ['src/calculator.py'], approvedPlanRef },
  ];
  const assembly = resolveRealTierAssembly({
    env: fixture.envOf({ catalog: { path: catalogPath } }),
    stateRoot: join(root, 'state'),
    revision: 'a'.repeat(40),
    spawn: async (command, args, options) => {
      if (args[0] === 'run' && args.includes('pytest')) {
        // Before the patch the reproduction fails; after it, the verification checks pass.
        if (patched()) {
          verificationRuns++;
          return { exitCode: 0, stdout: '1 passed', stderr: '', timedOut: false };
        }
        baselineCalls++;
        return { exitCode: 1, stdout: 'FAILED tests/test_calculator.py - ValueError expected', stderr: '', timedOut: false };
      }
      return docker.spawn(command, args, options);
    },
    fetch: async () => {
      const entry = responses[Math.min(fetches++, responses.length - 1)];
      const response = typeof entry === 'function' ? entry() : entry;
      assert.ok(response);
      return new Response(
        JSON.stringify({
          id: `r-${fetches}`,
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
    identity: { profileId: 'patch-profile', profileDigest: assembly.metadata.profileDigest, configDigest: revision, pricingDigest: revision },
    retainedRoot: join(root, 'retained'),
  });
  assert.equal(bound.status, 'task-bound', JSON.stringify(bound));
  if (bound.status !== 'task-bound') throw new Error('binding unavailable');
  const generation = createHostCoderGeneration({
    model: bound.ports.modelPort,
    repository: bound.ports.repositoryPort,
    guardedRead: bound.ports.guardedRead,
    admissionContextForCheck: bound.config.trustedExpectedContext.admissionContextForCheck,
    budget: { maxModelCalls: 6, maxActiveMs: 60000, maxRepairs: 2, maxReplans: 3 },
  });
  // #211 owns the patch and Verify boundary and stops at the reviewer dispatch point: the reviewer
  // admission and the owner completion context are #212's (see `uc03-real-tier-deliver.test.ts`).
  const config = { ...bound.config, generation, reviewerAdmission: undefined };
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
    counts: () => ({ baselineCalls, fetches, verificationRuns }),
    source: () => readFileSync(join(repositoryRoot, 'src/calculator.py'), 'utf8'),
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

test('a bound C01 applies one admitted patch, verifies it and reaches Review', async () => {
  const h = await setup();
  const paused = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);
  assert.equal(paused.outcome, 'pending-approval', JSON.stringify(paused.reasons));
  const plan = paused.state?.plan;
  assert.ok(plan?.decisionRef);
  h.setPlanRef(plan.decisionRef);
  await decide(h, 'approve');
  const patched = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config, paused.state ?? undefined);
  // The patch is applied and the graph pauses on the fresh post-patch verification D1.
  assert.equal(patched.outcome, 'pending-approval', JSON.stringify(patched.reasons));
  assert.equal(patched.state?.node, 'Verify', JSON.stringify(patched.reasons));
  assert.match(h.source(), /raise ValueError\("divisor"\)/);
  await decide(h, 'approve');
  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config, patched.state ?? undefined);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED', JSON.stringify(result.reasons));
  assert.equal(result.state?.node, 'Review', JSON.stringify(result.reasons));
  assert.equal(h.assembly.workspaceManager.hasActiveWriterLease(h.bound.ids.workspaceId), false);
  assert.equal(h.counts().baselineCalls >= 1, true);
});

/** Drive a plan pause, approve it, and run the Patch turn; returns the state reached. */
async function approveAndPatch(h: Awaited<ReturnType<typeof setup>>) {
  const paused = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);
  assert.equal(paused.outcome, 'pending-approval', JSON.stringify(paused.reasons));
  const plan = paused.state?.plan;
  assert.ok(plan?.decisionRef);
  h.setPlanRef(plan.decisionRef);
  await decide(h, 'approve');
  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config, paused.state ?? undefined);
  return { paused, result };
}

test('a patch outside the approved plan scope is refused with zero patch effects', async () => {
  // The plan scopes a different file; the proposed patch writes src/calculator.py, outside that scope.
  const h = await setup({ scopedPaths: ['src/other.py'] });
  const { result } = await approveAndPatch(h);
  assert.equal(result.state?.node, 'Patch', JSON.stringify(result.reasons));
  assert.equal(h.source(), SOURCE, 'the host tree is untouched');
  assert.equal(h.counts().verificationRuns, 0);
});

test('a stale plan decision is refused with zero patch effects', async () => {
  const h = await setup();
  const paused = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);
  assert.equal(paused.outcome, 'pending-approval', JSON.stringify(paused.reasons));
  const plan = paused.state?.plan;
  assert.ok(plan?.decisionRef);
  h.setPlanRef(plan.decisionRef);
  await decide(h, 'approve');
  // Publish a changed policy identity at a new generation: the recorded approval named the old
  // policy, so it no longer matches the current head and the plan decision is stale.
  const owner = h.owners.statePort;
  const snapshot = await owner.readVerificationAuthoritySnapshot(h.bound.ids.taskId);
  assert.ok(snapshot);
  const changed = { ...snapshot.policyIdentity, policyId: 'policy-rotated', decisionAuthorityGeneration: snapshot.decisionAuthorityGeneration + 1 };
  assert.equal((await owner.publishAuthority({ authorityRef: changed })).status, 'published');
  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config, paused.state ?? undefined);
  assert.notEqual(result.state?.node, 'Verify', JSON.stringify(result.reasons));
  assert.equal(h.source(), SOURCE, 'the host tree is untouched');
});

test('a rejected plan ends on its hold with no patch attempt', async () => {
  const h = await setup();
  const paused = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);
  assert.equal(paused.outcome, 'pending-approval', JSON.stringify(paused.reasons));
  h.setPlanRef(paused.state?.plan?.decisionRef ?? 'unused-rejected');
  await decide(h, 'reject');
  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config, paused.state ?? undefined);
  // A rejected plan parks on AwaitFeedback and applies no patch; the owner records the rejection.
  assert.equal(result.state?.node, 'AwaitFeedback', JSON.stringify(result.reasons));
  assert.equal(h.source(), SOURCE, 'a rejected plan applies no patch');
  assert.equal(h.counts().verificationRuns, 0);
});

test('removing the patch admission stops the run before Verify', async () => {
  const h = await setup();
  const paused = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);
  assert.equal(paused.outcome, 'pending-approval', JSON.stringify(paused.reasons));
  h.setPlanRef(paused.state?.plan?.decisionRef ?? 'unused-removal');
  await decide(h, 'approve');
  const config = { ...h.config, admissionContext: undefined };
  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, config, paused.state ?? undefined);
  assert.notEqual(result.state?.node, 'Verify', JSON.stringify(result.reasons));
  assert.equal(h.source(), SOURCE, 'no patch is applied without an admission resolver');
});

test('removing the Verify check admission stops the run before Review', async () => {
  const h = await setup();
  const paused = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);
  assert.equal(paused.outcome, 'pending-approval', JSON.stringify(paused.reasons));
  h.setPlanRef(paused.state?.plan?.decisionRef ?? 'unused-removal');
  await decide(h, 'approve');
  const patched = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config, paused.state ?? undefined);
  assert.equal(patched.outcome, 'pending-approval', JSON.stringify(patched.reasons));
  await decide(h, 'approve');
  const withoutCheck = { ...h.config.trustedExpectedContext };
  delete (withoutCheck as { admissionContextForCheck?: unknown }).admissionContextForCheck;
  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, { ...h.config, trustedExpectedContext: withoutCheck }, patched.state ?? undefined);
  assert.notEqual(result.state?.node, 'Review', JSON.stringify(result.reasons));
});
