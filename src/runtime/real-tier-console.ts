/** Real-tier console factory behind `evaluate serve --host <host.json>` (Feature 007 T017, #267). */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateBugTask, type BugTask, type TaskNode } from '../contracts/foundation/uc03.ts';
import { observeDockerReadiness } from '../foundation/docker-readiness.ts';
import { structuredSpawn } from '../foundation/docker-spawn.ts';
import { sha256Text } from '../uc01/contracts.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../uc03/graph-types-v02.ts';
import { MAX_TASK_REPLANS } from '../uc03/replan-accounting.ts';
import type { ConsoleApprovalPort } from './console-server.ts';
import type { EvaluationConsoleAssembly, EvaluationConsoleFactory } from './evaluation-console-host.ts';
import { createRealTierReportEvidenceHost } from './evaluation-graph-report.ts';
import type { EvaluationCaseBinding, UC03EvaluationGraphRoute } from './evaluation-graph.ts';
import type { CatalogEntry } from './evaluation-profile.ts';
import type { ServiceControl, ServiceControlReceipt } from './evaluation-service-types.ts';
import type { RealTierAssembly, RealTierDependencies, RealTierResolution } from './real-tier-assembly.ts';
import { PINS, resolvePinnedGrader, type GraderCapability } from './real-tier-case-grade.ts';
import { admitRealTierConsole } from './real-tier-console-admission.ts';
import {
  hasPendingEndDirection,
  INVALID_RECEIPT,
  resolveRealConsoleClarificationEnd,
  resolveRealConsoleClarificationResume,
  resolveRealConsoleDirection,
  validRealConsoleDirection,
  type RecordedDirection,
} from './real-tier-console-direction.ts';
import { createRealTierGraderCapability } from './real-tier-grader.ts';
import { REAL_TIER_DELIVERY_CONTRACT } from './real-tier-owners.ts';
import { expectedBindingsOf, matchesDigests } from './real-tier-production-lifecycle.ts';
import type { RealTierEnvironment } from './real-tier-profile.ts';
import { bindRealTierTask } from './real-tier-task-binding.ts';
import type { UC03HostInputs } from './uc03-host-bootstrap.ts';

export const REAL_CONSOLE_TOKEN_ENV = 'UC03_REAL_CONSOLE_TOKEN';

const TOKEN_PATTERN = /^[\x21-\x7e]{16,512}$/u;
const IDENTIFIER = /^[A-Za-z0-9._:/@-]{1,256}$/u;
const TERMINAL_NODES: ReadonlySet<TaskNode> = new Set(['Deliver', 'Incomplete']);

interface BoundSession {
  readonly task: BugTask;
  readonly statePort: RealTierAssembly['components']['statePort'];
  readonly approvalService: ReturnType<RealTierAssembly['owners']['taskOwners']>['approvalService'];
  readonly approvalConsole: ConsoleApprovalPort;
  readonly directionsByRef: Map<string, RecordedDirection>;
  directionsIssued: number;
  lastControlVersion: number;
  terminal: boolean;
  cleanupCopy: () => void;
}

function resolveOperatorToken(env: RealTierEnvironment): Readonly<{ token: string; fromEnv: boolean }> {
  const supplied = Object.hasOwn(env, REAL_CONSOLE_TOKEN_ENV) ? env[REAL_CONSOLE_TOKEN_ENV] : undefined;
  if (supplied !== undefined) {
    if (typeof supplied !== 'string' || !TOKEN_PATTERN.test(supplied)) throw new Error('INVALID_OPERATOR_TOKEN');
    return { token: supplied, fromEnv: true };
  }
  return { token: randomBytes(24).toString('hex'), fromEnv: false };
}

function readFixtureTask(entry: CatalogEntry): BugTask {
  const stat = statSync(entry.fixturePath, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) throw new Error('MISSING_FIXTURE');
  const raw = readFileSync(entry.fixturePath, 'utf8');
  if (sha256Text(raw) !== entry.fixtureDigest) throw new Error('FIXTURE_DIGEST_MISMATCH');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('INVALID_FIXTURE');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('INVALID_FIXTURE');
  const validated = validateBugTask((parsed as Readonly<Record<string, unknown>>)['task']);
  if (!validated.ok) throw new Error('INVALID_FIXTURE_TASK');
  const task = validated.value;
  if (task.initialRevisionDigest.replace(/^sha256:/u, '') !== entry.initialRepositoryDigest) throw new Error('FIXTURE_REVISION_MISMATCH');
  if (task.budgetLimits.maxReplanCount !== MAX_TASK_REPLANS) throw new Error('UNSUPPORTED_REPLAN_BUDGET');
  if (!IDENTIFIER.test(task.repositoryId)) throw new Error('INVALID_REPOSITORY_ID');
  return Object.freeze(task);
}

function removeCopyDir(root: string): void {
  if (statSync(root, { throwIfNoEntry: false }) === undefined) return;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

function checkGraderReady(assembly: RealTierAssembly, caseId: string, cap: GraderCapability, customCap: boolean): string | undefined {
  if (PINS[caseId] === undefined) return 'UNPINNED_CASE';
  const grader = resolvePinnedGrader(assembly, caseId, cap);
  if (grader.status !== 'ready') return grader.reasonCode;
  if (!grader.hasCriterion || (!customCap && PINS[caseId] === 'repair-success' && !grader.hasValidPayload)) return 'GRADER_UNAVAILABLE';
  return undefined;
}

function freshMatchesInitial(fresh: RealTierAssembly, initial: RealTierAssembly, expected: ReturnType<typeof expectedBindingsOf>, pins: UC03HostInputs['pins']): boolean {
  const bindings = expectedBindingsOf(fresh);
  if (!matchesDigests(bindings, expected) || bindings.model !== expected.model) return false;
  if (fresh.revision !== initial.revision || UC03_PRODUCTION_COMPONENTS_V02.some(c => pins.revisions[c] !== fresh.revision)) return false;
  return fresh.metadata.imageId === initial.metadata.imageId && fresh.metadata.endpointDigest === initial.metadata.endpointDigest && fresh.profile.catalog.path === initial.profile.catalog.path;
}

/** Builds the `EvaluationConsoleFactory` attached to `createHostAssembly()` (`real-tier-assembly.ts`). */
export function createRealTierConsoleFactory(
  initialAssembly: RealTierAssembly,
  dependencies: RealTierDependencies,
  resolveAssembly: (deps: RealTierDependencies) => RealTierResolution,
): EvaluationConsoleFactory {
  const spawn = dependencies.spawn ?? structuredSpawn;
  const baseStateRoot = dependencies.stateRoot ?? initialAssembly.profile.stateRoot;
  const expected = expectedBindingsOf(initialAssembly);
  const capOpt = dependencies.graderCapability === undefined ? {} : { graderCapability: dependencies.graderCapability };
  const customCap = dependencies.graderCapability !== undefined;
  const allowRevise = dependencies.verifyDirection !== undefined;
  const pins: UC03HostInputs['pins'] = {
    contractVersion: REAL_TIER_DELIVERY_CONTRACT,
    revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(c => [c, initialAssembly.revision])),
  };

  return ({ readiness, configuration }): EvaluationConsoleAssembly => {
    if (readiness.status !== 'ready') throw new Error('REAL_CONSOLE_READINESS_REQUIRED');
    const { token, fromEnv } = resolveOperatorToken(dependencies.env ?? process.env);
    const admitted = admitRealTierConsole({ profile: initialAssembly.profile, configuration });
    if (!admitted.ok) throw new Error(admitted.reasonCode);

    const startupCap = dependencies.graderCapability ?? createRealTierGraderCapability({ spawn });
    const tasksByCaseId = new Map<string, BugTask>();
    const repositoryIds: string[] = [];
    for (const entry of admitted.value.catalog) {
      const task = readFixtureTask(entry);
      tasksByCaseId.set(entry.caseId, task);
      if (!repositoryIds.includes(task.repositoryId)) repositoryIds.push(task.repositoryId);
      if (PINS[entry.caseId] !== undefined) {
        const err = checkGraderReady(initialAssembly, entry.caseId, startupCap, customCap);
        if (err !== undefined) throw new Error(err);
      }
    }

    const { profile, catalog } = admitted.value;
    const sessions = new Map<string, BoundSession>();
    const runNonce = randomUUID().slice(0, 12);
    let caseSeq = 0;
    let directionSeq = 0;
    let printedToken = false;

    const control: ServiceControl = {
      async issue(input) {
        if (input.kind === 'revise' && !allowRevise) return INVALID_RECEIPT;
        const session = sessions.get(input.experimentId);
        if (!session || session.terminal) return INVALID_RECEIPT;
        const [ownerState, listed] = await Promise.all([session.statePort.loadTask(session.task.taskId), session.approvalService.list(session.task.taskId)]);
        if (!ownerState) return INVALID_RECEIPT;
        if (input.kind === 'end' && hasPendingEndDirection(session, ownerState.stateVersion)) return INVALID_RECEIPT;

        const expectedCtrl = Math.max(listed.control.version, session.lastControlVersion);
        if (
          !validRealConsoleDirection(
            input.kind,
            ownerState.node,
            listed.control.mode,
            expectedCtrl,
            input.expectedControlVersion,
            input.expectedTaskVersion,
            ownerState.stateVersion,
            session.directionsIssued,
            ownerState.plan?.decisionRef,
            input.decisionRef,
          )
        ) {
          return INVALID_RECEIPT;
        }

        const nextVer = expectedCtrl + 1;
        const receipt: ServiceControlReceipt = Object.freeze({
          receiptRef: `real-dir-${session.task.taskId}-${++directionSeq}`,
          kind: input.kind,
          taskId: session.task.taskId,
          controlVersion: nextVer,
        });
        session.directionsIssued += 1;
        session.lastControlVersion = nextVer;
        session.directionsByRef.set(receipt.receiptRef, { receipt, taskVersion: ownerState.stateVersion });
        return receipt;
      },
    };

    const approval: ConsoleApprovalPort = {
      presentation(experimentId) {
        const session = sessions.get(experimentId);
        return session ? session.approvalConsole.presentation(experimentId) : { ok: false, status: 'not-found', reasonCode: 'UNKNOWN_EXPERIMENT' };
      },
      decide(input) {
        const expId = typeof input === 'object' && input !== null ? (input as Readonly<Record<string, unknown>>)['experimentId'] : undefined;
        if (typeof expId !== 'string') return { ok: false, status: 'invalid-input', reasonCode: 'INVALID_DECISION_REQUEST' };
        const session = sessions.get(expId);
        return session ? session.approvalConsole.decide(input) : { ok: false, status: 'not-found', reasonCode: 'UNKNOWN_EXPERIMENT' };
      },
    };

    const routeForEntry = (entry: CatalogEntry): UC03EvaluationGraphRoute => {
      const fixtureTask = tasksByCaseId.get(entry.caseId);
      if (!fixtureTask) throw new Error('MISSING_FIXTURE_TASK');
      return {
        entry,
        readiness,
        coderBudget: { maxModelCalls: profile.limits.totalModelCalls, maxActiveMs: profile.limits.activeExecutionMs, maxRepairs: profile.limits.repairs, maxReplans: profile.limits.materialReplans },
        expectedWait: entry.caseId === 'C02' ? 'waiting-info' : entry.caseId === 'C01' ? 'waiting-approval' : null,
        workflowReport: {
          profileDigest: profile.profileDigest,
          configDigest: profile.configDigest,
          pricingDigest: profile.pricingDigest,
          adapterVersions: profile.adapterVersions,
          requestedModel: profile.model,
          workflowEvidence: createRealTierReportEvidenceHost({ assembly: initialAssembly, caseId: entry.caseId, spawn, ...capOpt }),
        },
        resolveTask: () => fixtureTask,
        bindCase: async ({ experimentId }): Promise<EvaluationCaseBinding> => {
          for (const [expId, prior] of sessions) if (expId !== experimentId && prior.terminal) prior.cleanupCopy();
          if (PINS[entry.caseId] === undefined) return { ok: false, reasonCode: 'UNPINNED_CASE' };

          const docker = await observeDockerReadiness(spawn, initialAssembly.metadata.imageId);
          if (!docker.ok) return { ok: false, reasonCode: docker.reasonCode };

          const fresh = resolveAssembly({ ...dependencies, stateRoot: join(baseStateRoot, `console-${runNonce}-${++caseSeq}-${entry.caseId}`) });
          if (fresh.status !== 'assembly-ready') return { ok: false, reasonCode: fresh.reasonCode };
          if (!freshMatchesInitial(fresh, initialAssembly, expected, pins)) return { ok: false, reasonCode: 'HOST_BINDING_DRIFT' };
          const freshAdmitted = admitRealTierConsole({ profile: fresh.profile, configuration });
          if (!freshAdmitted.ok) return { ok: false, reasonCode: freshAdmitted.reasonCode };
          const freshEntry = freshAdmitted.value.catalog.find(c => c.caseId === entry.caseId);
          if (!freshEntry || freshEntry.caseDigest !== entry.caseDigest || freshEntry.fixtureDigest !== entry.fixtureDigest || freshEntry.grader.digest !== entry.grader.digest) {
            return { ok: false, reasonCode: 'HOST_BINDING_DRIFT' };
          }

          const cap = dependencies.graderCapability ?? createRealTierGraderCapability({ spawn });
          const graderErr = checkGraderReady(fresh, entry.caseId, cap, customCap);
          if (graderErr !== undefined) return { ok: false, reasonCode: graderErr };

          const workingCopyRoot = mkdtempSync(join(tmpdir(), 'uc03-real-console-copy-'));
          let keepCopy = false;
          try {
            const bound = await bindRealTierTask(fresh, { caseId: entry.caseId, pins, identity: configuration.identity, workingCopyRoot, retainedRoot: fresh.profile.artifacts.retainRoot });
            if (bound.status !== 'task-bound') return { ok: false, reasonCode: bound.reasonCode };

            const owners = fresh.owners.taskOwners({ taskId: bound.ids.taskId, workspaceId: bound.ids.workspaceId, repositoryId: bound.task.repositoryId });
            const session: BoundSession = {
              task: bound.task,
              statePort: bound.ports.statePort,
              approvalService: owners.approvalService,
              approvalConsole: owners.console,
              directionsByRef: new Map(),
              directionsIssued: 0,
              lastControlVersion: 0,
              terminal: false,
              cleanupCopy: () => removeCopyDir(workingCopyRoot),
            };
            sessions.set(experimentId, session);
            keepCopy = true;

            const baseEv = createRealTierReportEvidenceHost({ assembly: fresh, caseId: entry.caseId, task: bound.task, repositoryRoot: bound.repositoryRoot, spawn, ...capOpt });
            const finishIfTerminal = async () => {
              const st = await session.statePort.loadTask(session.task.taskId);
              if (session.terminal || (st && TERMINAL_NODES.has(st.node))) {
                session.terminal = true;
                session.cleanupCopy();
              }
            };
            const grade: typeof baseEv.grader.grade = async (caseId, gradeInput) => {
              const noSnap = typeof gradeInput !== 'object' || gradeInput === null || !('snapshot' in gradeInput) || gradeInput.snapshot === undefined;
              let outcome: Awaited<ReturnType<typeof baseEv.grader.grade>> | undefined;
              try {
                outcome = await baseEv.grader.grade(caseId, gradeInput);
                return outcome;
              } finally {
                if (noSnap || outcome === undefined || outcome.grade === 'not-run' || outcome.snapshot === null) await finishIfTerminal();
              }
            };
            const recheck: typeof baseEv.finalTree.recheckCurrentFinalTree = async (binding, snap) => {
              try {
                return await baseEv.finalTree.recheckCurrentFinalTree(binding, snap);
              } finally {
                await finishIfTerminal();
              }
            };
            const workflowEvidence = Object.freeze({
              grader: Object.freeze({ grade }),
              finalTree: Object.freeze({ freezeFinalTree: baseEv.finalTree.freezeFinalTree, recheckCurrentFinalTree: recheck }),
            });

            return { ok: true, task: bound.task, ports: bound.ports, config: bound.config, workflowEvidence };
          } finally {
            if (!keepCopy) removeCopyDir(workingCopyRoot);
          }
        },
        resolveDirection: input => resolveRealConsoleDirection(sessions, allowRevise, input),
        resolveClarificationResume: input => resolveRealConsoleClarificationResume(sessions, input),
        resolveClarificationEnd: input => resolveRealConsoleClarificationEnd(sessions, input),
      };
    };

    return {
      profile,
      catalog,
      repositoryIds: Object.freeze(repositoryIds),
      checkSetIds: Object.freeze(['checks-configured']),
      control,
      approval,
      routesFor: () => new Map(catalog.map(entry => [entry.caseId, routeForEntry(entry)])),
      operatorToken: () => {
        if (!printedToken) {
          printedToken = true;
          process.stderr.write(fromEnv ? `UC-03 real console operator token: using ${REAL_CONSOLE_TOKEN_ENV} from environment\n` : `UC-03 real console operator token (generated): ${token}\n`);
        }
        return token;
      },
    };
  };
}
