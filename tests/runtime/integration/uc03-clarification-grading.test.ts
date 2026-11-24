/**
 * Public regression suite for UC-03 clarification evidence and grading (T054 / C02).
 *
 * Owned path: tests/runtime/integration/uc03-clarification-grading.test.ts
 *
 * Requirements:
 * - Production graph pauses on genuine clarification (request-info) at NeedsInfo.
 * - Measured baseline candidate is retained in non-enumerable host-only execution evidence.
 * - Evidence derivation resolves the validated baseline candidate when canonical baseline is absent.
 * - Independent snapshot grader accepts C02 clarification pause with zero patch/review/approval calls.
 * - Negative invariants: missing, invalid, stale, foreign, mutated candidate, protected tree drift,
 *   or speculative patch cannot certify clarification.
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
import { attachUC03ExecutionEvidence } from '../../../src/uc03/graph-types.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { createVolumeSpawn } from '../support/docker-volume-spawn.ts';
import { createScanFixture } from '../unit/real-tier-scan-fixtures.ts';
import { deriveWorkflowEvidenceFacts, type FinalTreeBinding } from '../../../eval/uc03/workflow-evidence-facts.ts';
import { createSnapshotGrader } from '../../../eval/uc03/workflow-grade.ts';
import type { EvaluationGradingAdmissionRequest, WorkflowObservation } from '../../../eval/uc03/types.ts';

const fixture = createScanFixture('clarify-', 'clarify-profile-fixture');

async function setupClarificationHarness(options: { testPrefix?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'clarify-case-'));
  const repositoryRoot = join(root, 'repository');
  mkdirSync(join(repositoryRoot, 'src'), { recursive: true });
  mkdirSync(join(repositoryRoot, 'tests'), { recursive: true });
  const source = 'def divide(a, b):\n    return a / b\n';
  writeFileSync(join(repositoryRoot, 'src/calculator.py'), source);
  writeFileSync(join(repositoryRoot, 'tests/test_calculator.py'), `${options.testPrefix ?? ''}def test_divide_zero():\n    assert False\n`);
  const revision = await new WorkspaceFilesystemPort({ root: repositoryRoot }).getCurrentRevisionDigest();
  const task: BugTask = {
    taskId: 'task-clarify',
    repositoryId: 'repo-calculator',
    initialRevisionDigest: revision,
    goal: 'Handle zero denominator with clarification',
    observedBehavior: 'ZeroDivisionError',
    expectedBehavior: 'CalculationError',
    reproduction: 'pytest -q tests/test_calculator.py',
    acceptanceCriteria: ['divide(1, 0) raises CalculationError'],
    constraints: [],
    requiredChecks: [
      { checkId: 'check-zero', executable: 'pytest', argv: ['-q', 'tests/test_calculator.py'], purpose: 'reproduction', workingDirectory: '/workspace/repo', timeoutMs: 1000, maxOutputBytes: 4096 },
    ],
    limits: { timeoutMs: 1000, maxOutputBytes: 4096, maxCpuCores: 1, maxMemoryBytes: 1048576, maxPids: 16 },
    budgetLimits: { maxReplanCount: 3, maxTokens: 100000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 },
    configId: 'config-clarify',
    configVersion: '1.0.0',
  };
  const document = JSON.stringify({ task, repositoryRoot: 'repository' });
  const fixturePath = join(root, 'case.json');
  writeFileSync(fixturePath, document);
  const catalogPath = join(root, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify({ catalog: [{ caseId: 'C02', fixturePath, fixtureDigest: sha256Text(document), initialRepositoryDigest: revision.slice(7) }] }));
  const docker = createVolumeSpawn();
  let baselineCalls = 0;
  let fetches = 0;
  let admissions = 0;
  const responses = [
    { kind: 'inspect', proposalId: 'inspect-source', operation: 'read_file', args: { path: 'src/calculator.py' } },
    { kind: 'request-info', proposalId: 'ask-policy', questions: [{ questionId: 'policy-q', text: 'Which error type to raise?' }], evidenceRefs: [] },
  ];
  const assembly = resolveRealTierAssembly({
    env: fixture.envOf({ catalog: { path: catalogPath }, runLimits: { perRunInputTokens: 32768, perRunOutputTokens: 8192 } }),
    stateRoot: join(root, 'state'),
    revision: 'b'.repeat(40),
    spawn: async (command, args, options) => {
      if (args[0] === 'run' && args.includes('pytest')) {
        baselineCalls++;
        return { exitCode: 1, stdout: 'FAILED tests/test_calculator.py::test_divide_zero - ZeroDivisionError', stderr: '', timedOut: false };
      }
      return docker.spawn(command, args, options);
    },
    fetch: async () => {
      assert.equal(admissions, fetches + 1);
      const response = responses[fetches++];
      assert.ok(response, 'unexpected provider call');
      return new Response(
        JSON.stringify({
          id: `response-${fetches}`,
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
  assert.equal(assembly.status, 'assembly-ready');
  if (assembly.status !== 'assembly-ready') throw new Error('assembly unavailable');
  const bound = await bindRealTierTask(assembly, {
    caseId: 'C02',
    pins: { contractVersion: 'uc03-host-composition/2', revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, assembly.revision])) },
    identity: { profileId: 'clarify-profile', profileDigest: assembly.metadata.profileDigest, configDigest: revision, pricingDigest: revision },
    retainedRoot: join(root, 'retained'),
  });
  assert.equal(bound.status, 'task-bound');
  if (bound.status !== 'task-bound') throw new Error('binding unavailable');
  const resolver = bound.config.coderAdmission;
  const coderAdmission: typeof resolver = async input => {
    const admission = await resolver?.(input);
    if (admission) admissions++;
    return admission;
  };
  const generation = createHostCoderGeneration({
    model: bound.ports.modelPort,
    repository: bound.ports.repositoryPort,
    guardedRead: bound.ports.guardedRead,
    admissionContextForCheck: bound.config.trustedExpectedContext.admissionContextForCheck,
    budget: { maxModelCalls: 4, maxActiveMs: 60000, maxRepairs: 2, maxReplans: 3 },
  });
  const config = { ...bound.config, coderAdmission, generation };
  return { bound, config, repositoryRoot, counts: () => ({ baselineCalls, fetches, admissions }) };
}

function createFinalTreeDouble(repositoryRoot: string, overrides: { modifyProtected?: boolean; returnBytes?: boolean; protectedContent?: string | Uint8Array } = {}) {
  return {
    freezeFinalTree: (binding: FinalTreeBinding) => ({
      ...binding,
      snapshotId: 'clarification-tree-snap',
      complete: true,
      files: ['src/calculator.py', 'tests/test_calculator.py'].map(path => {
        if (overrides.protectedContent !== undefined && path.includes('test_calculator.py')) {
          return { path, content: overrides.protectedContent };
        }
        let content: string | Uint8Array = readFileSync(join(repositoryRoot, path), overrides.returnBytes && path.includes('test_calculator.py') ? null : 'utf8');
        if (overrides.modifyProtected && path.includes('test_calculator.py')) {
          content = typeof content === 'string' ? content + '\n# mutated test file\n' : Buffer.concat([content, Buffer.from('\n# mutated test file\n', 'utf8')]);
        }
        return { path, content };
      }),
    }),
    recheckCurrentFinalTree: () => undefined,
  };
}

function createC02Grader() {
  const criteriaDigest = `sha256:${'c'.repeat(64)}`;
  return createSnapshotGrader({
    criteria: {
      digest: criteriaDigest,
      criteria: [{ criterionId: 'crit-c02-clarification', caseId: 'C02', predicate: 'clarification', hiddenCheckId: null }],
    },
    profile: {
      profileId: 'clarify-profile',
      digest: `sha256:${'a'.repeat(64)}`,
      bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 8 },
    },
    graderPayload: 'CLARIFICATION_PAYLOAD',
    isolationAuthority: { admit: async (req: EvaluationGradingAdmissionRequest) => ({ kind: 'mock-admission', admissionId: 'adm-c02', ...req }) },
    executor: { executorId: 'mock-exec-c02', execute: async () => ({ outcome: 'pass', output: '' }) },
  });
}

test('bound C02 production graph genuine clarification pause supplies gradeable baseline evidence and passes C02 grade', async () => {
  const h = await setupClarificationHarness();
  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);

  assert.equal(result.outcome, 'needs-info');
  assert.ok(result.state);
  assert.equal(result.state.node, 'NeedsInfo');
  assert.deepEqual(result.state.changedPaths, []);
  assert.deepEqual(h.counts(), { baselineCalls: 1, fetches: 2, admissions: 2 });

  // Execution evidence baselineCandidate is validated, detached, frozen, and non-enumerable
  assert.ok(result.executionEvidence, 'executionEvidence must be attached to workflow result');
  assert.ok(result.executionEvidence.baselineCandidate, 'baselineCandidate must be present in execution evidence on clarification pause');
  assert.equal(result.executionEvidence.baseline, undefined, 'canonical baseline must not be fabricated');
  assert.ok(Object.isFrozen(result.executionEvidence), 'executionEvidence must be frozen');
  assert.ok(Object.isFrozen(result.executionEvidence.baselineCandidate), 'baselineCandidate must be frozen');

  // Non-enumerable check: omitted from keys and JSON serialization
  assert.ok(!Object.keys(result).includes('executionEvidence'), 'executionEvidence must not be enumerable');
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('baselineCandidate'), 'serialized result must not include baselineCandidate');

  const observation: WorkflowObservation = {
    repositoryId: result.state.repositoryId,
    taskId: result.state.taskId,
    runId: result.state.runId,
    returnedModel: null,
    graderDigest: null,
    initialRepositoryDigest: h.bound.task.initialRevisionDigest,
    workflowOutcome: 'waiting-info',
    expectedWait: 'waiting-info',
    blocked: null,
    effects: 'observed',
    usage: 'uncertain',
    diagnostic: null,
    artifacts: [],
    limitations: [],
  };

  const finalTree = createFinalTreeDouble(h.repositoryRoot);
  const facts = await deriveWorkflowEvidenceFacts({
    caseId: 'C02',
    task: h.bound.task,
    result,
    observation,
    repository: h.bound.ports.repositoryPort,
    statePort: h.bound.ports.statePort,
    finalTree,
  });

  assert.ok(facts, 'deriveWorkflowEvidenceFacts must succeed from executionEvidence.baselineCandidate');
  assert.equal(facts.evidence.baselineFailed, true);
  assert.equal(facts.evidence.testsProtected, true);
  assert.equal(facts.evidence.speculativePatchApplied, false);
  assert.equal(facts.evidence.completionWithheld, true);
  assert.equal(facts.evidence.stoppedBeforeEffect, false);

  // Independent C02 snapshot grader passes with criteria-satisfied
  const grader = createC02Grader();
  const graded = await grader.grade('C02', { observation, snapshot: facts.snapshot, evidence: facts.evidence });
  assert.equal(graded.grade, 'pass');
  assert.equal(graded.reason, 'criteria-satisfied');
});

test('negative: missing, foreign, or corrupted baselineCandidate cannot certify clarification', async () => {
  const h = await setupClarificationHarness();
  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);
  assert.ok(result.state);
  const observation: WorkflowObservation = {
    repositoryId: result.state.repositoryId,
    taskId: result.state.taskId,
    runId: result.state.runId,
    returnedModel: null,
    graderDigest: null,
    initialRepositoryDigest: h.bound.task.initialRevisionDigest,
    workflowOutcome: 'waiting-info',
    expectedWait: 'waiting-info',
    blocked: null,
    effects: 'observed',
    usage: 'uncertain',
    diagnostic: null,
    artifacts: [],
    limitations: [],
  };
  const finalTree = createFinalTreeDouble(h.repositoryRoot);

  // Negative 1: Missing candidate entirely
  const resultWithoutCandidate = attachUC03ExecutionEvidence({ ...result, executionEvidence: undefined }, { state: result.state });
  const factsMissing = await deriveWorkflowEvidenceFacts({
    caseId: 'C02',
    task: h.bound.task,
    result: resultWithoutCandidate,
    observation,
    repository: h.bound.ports.repositoryPort,
    statePort: h.bound.ports.statePort,
    finalTree,
  });
  assert.equal(factsMissing, undefined, 'missing baseline candidate must fail derivation');

  // Negative 2: Foreign taskId candidate
  const candidate = result.executionEvidence?.baselineCandidate;
  if (candidate) {
    const foreignCandidate = { ...candidate, taskId: 'foreign-task-999' };
    const resultForeign = attachUC03ExecutionEvidence({ ...result, executionEvidence: undefined }, { state: result.state, baselineCandidate: foreignCandidate });
    const factsForeign = await deriveWorkflowEvidenceFacts({
      caseId: 'C02',
      task: h.bound.task,
      result: resultForeign,
      observation,
      repository: h.bound.ports.repositoryPort,
      statePort: h.bound.ports.statePort,
      finalTree,
    });
    assert.equal(factsForeign, undefined, 'foreign candidate taskId must fail derivation');
  }

  // Negative 3: Protected tree drift (mutated test file in worktree) voids test protection
  const driftTree = createFinalTreeDouble(h.repositoryRoot, { modifyProtected: true });
  const factsDrift = await deriveWorkflowEvidenceFacts({
    caseId: 'C02',
    task: h.bound.task,
    result,
    observation,
    repository: h.bound.ports.repositoryPort,
    statePort: h.bound.ports.statePort,
    finalTree: driftTree,
  });
  assert.equal(factsDrift, undefined, 'protected tree drift must not supply gradeable clarification facts');

  // Negative 4: Speculative patch applied cannot certify clarification grade
  const facts = await deriveWorkflowEvidenceFacts({
    caseId: 'C02',
    task: h.bound.task,
    result,
    observation,
    repository: h.bound.ports.repositoryPort,
    statePort: h.bound.ports.statePort,
    finalTree,
  });
  assert.ok(facts);
  const grader = createC02Grader();
  const patchedGrade = await grader.grade('C02', {
    observation,
    snapshot: facts.snapshot,
    evidence: { ...facts.evidence, speculativePatchApplied: true },
  });
  assert.equal(patchedGrade.grade, 'fail', 'speculative patch applied must fail clarification grade');
});

test('CR249-BOM: actual production graph genuine NeedsInfo clarification with unchanged BOM-prefixed protected test returned as bytes passes C02 grade; mutated or invalid bytes are refused', async () => {
  const h = await setupClarificationHarness({ testPrefix: '\uFEFF' });
  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);

  assert.equal(result.outcome, 'needs-info');
  assert.ok(result.state);
  assert.equal(result.state.node, 'NeedsInfo');

  const observation: WorkflowObservation = {
    repositoryId: result.state.repositoryId,
    taskId: result.state.taskId,
    runId: result.state.runId,
    returnedModel: null,
    graderDigest: null,
    initialRepositoryDigest: h.bound.task.initialRevisionDigest,
    workflowOutcome: 'waiting-info',
    expectedWait: 'waiting-info',
    blocked: null,
    effects: 'observed',
    usage: 'uncertain',
    diagnostic: null,
    artifacts: [],
    limitations: [],
  };

  // Case 1: Unchanged BOM test file returned as bytes -> facts derived, passes C02 grade
  const finalTreeBytes = createFinalTreeDouble(h.repositoryRoot, { returnBytes: true });
  const facts = await deriveWorkflowEvidenceFacts({
    caseId: 'C02',
    task: h.bound.task,
    result,
    observation,
    repository: h.bound.ports.repositoryPort,
    statePort: h.bound.ports.statePort,
    finalTree: finalTreeBytes,
  });

  assert.ok(facts, 'deriveWorkflowEvidenceFacts must succeed for unchanged BOM-prefixed test returned as bytes');
  assert.equal(facts.evidence.testsProtected, true);
  assert.equal(facts.evidence.sentinelsUnchanged, true);

  const grader = createC02Grader();
  const graded = await grader.grade('C02', { observation, snapshot: facts.snapshot, evidence: facts.evidence });
  assert.equal(graded.grade, 'pass');
  assert.equal(graded.reason, 'criteria-satisfied');

  // Negative 1: Mutated test content in bytes -> refused
  const mutatedTree = createFinalTreeDouble(h.repositoryRoot, {
    protectedContent: Buffer.from('\uFEFFdef test_divide_zero():\n    assert True\n', 'utf8'),
  });
  const factsMutated = await deriveWorkflowEvidenceFacts({
    caseId: 'C02',
    task: h.bound.task,
    result,
    observation,
    repository: h.bound.ports.repositoryPort,
    statePort: h.bound.ports.statePort,
    finalTree: mutatedTree,
  });
  assert.equal(factsMutated, undefined, 'mutated test content must be refused');

  // Negative 2: Mutated BOM (stripped BOM from bytes) -> refused
  const strippedBomTree = createFinalTreeDouble(h.repositoryRoot, {
    protectedContent: Buffer.from('def test_divide_zero():\n    assert False\n', 'utf8'),
  });
  const factsStrippedBom = await deriveWorkflowEvidenceFacts({
    caseId: 'C02',
    task: h.bound.task,
    result,
    observation,
    repository: h.bound.ports.repositoryPort,
    statePort: h.bound.ports.statePort,
    finalTree: strippedBomTree,
  });
  assert.equal(factsStrippedBom, undefined, 'stripped BOM bytes must be refused');

  // Negative 3: Invalid UTF-8 bytes -> refused
  const invalidUtf8Tree = createFinalTreeDouble(h.repositoryRoot, {
    protectedContent: new Uint8Array([0xff, 0xfe, 0xfd]),
  });
  const factsInvalidUtf8 = await deriveWorkflowEvidenceFacts({
    caseId: 'C02',
    task: h.bound.task,
    result,
    observation,
    repository: h.bound.ports.repositoryPort,
    statePort: h.bound.ports.statePort,
    finalTree: invalidUtf8Tree,
  });
  assert.equal(factsInvalidUtf8, undefined, 'invalid UTF-8 bytes must be refused');
});
