/** Helpers for custom-bug template selection, task construction, validation, and route assembly in the real console. */
import type { BugTask } from '../contracts/foundation/uc03.ts';
import { sha256Text } from '../uc01/contracts.ts';
import type { EvaluationCaseBinding, UC03EvaluationGraphRoute } from './evaluation-graph.ts';
import { taskMatchesSource } from './evaluation-graph-validation.ts';
import type { BoundSource, CatalogEntry } from './evaluation-profile.ts';
import type { RealConsoleSession } from './real-tier-console-control.ts';
import { resolveRealConsoleClarificationEnd, resolveRealConsoleClarificationResume, resolveRealConsoleDirection } from './real-tier-console-direction.ts';
import { validateCustomTaskOverride } from './real-tier-fixture.ts';

export interface CustomConsoleTemplate {
  readonly entry: CatalogEntry;
  readonly task: BugTask;
}

export interface PendingCustomTask {
  readonly submissionDigest: string;
  readonly task: BugTask;
}

export interface BuildCustomConsoleTaskInput {
  readonly experimentId: string;
  readonly source: BoundSource;
  readonly template: CustomConsoleTemplate;
  readonly catalogTaskIds: ReadonlySet<string>;
  readonly nextSeq: () => number;
}

export interface CreateCustomConsoleRouteInput {
  readonly readiness: UC03EvaluationGraphRoute['readiness'];
  readonly coderBudget: UC03EvaluationGraphRoute['coderBudget'];
  readonly templatesByRepo: ReadonlyMap<string, CustomConsoleTemplate>;
  readonly catalogTaskIds: ReadonlySet<string>;
  readonly sessions: ReadonlyMap<string, RealConsoleSession>;
  readonly pendingCustomTasks: Map<string, PendingCustomTask>;
  readonly allowRevise: boolean;
  readonly bindCustomCase: (input: { readonly experimentId: string; readonly entry: CatalogEntry; readonly customTask: BugTask }) => Promise<EvaluationCaseBinding>;
  readonly retireSession: (experimentId: string) => void;
}

/** Verifies candidate keeps all non-public template fields intact and matches the bound bug input on the six public fields. */
export function isCustomTaskOnTemplate(template: BugTask, candidate: BugTask, source: BoundSource): boolean {
  if (source.kind !== 'bug' || source.status !== 'complete') return false;
  const checked = validateCustomTaskOverride(template, candidate);
  return !('status' in checked) && taskMatchesSource(checked, source);
}

/** Builds a fresh, validated BugTask from a catalog template's fixed policy/repository fields and the six public bug fields. */
export function buildCustomConsoleTask(input: BuildCustomConsoleTaskInput): BugTask {
  const { experimentId, source, template, catalogTaskIds, nextSeq } = input;
  if (source.kind !== 'bug' || source.status !== 'complete') throw new Error('INVALID_CUSTOM_SOURCE');
  const { bugInput } = source;
  let taskId = '';
  do {
    const seq = nextSeq();
    taskId = `custom-${sha256Text(`${experimentId}\0${source.submissionId}\0${seq}`).slice(0, 24)}`;
  } while (catalogTaskIds.has(taskId));

  const candidate: BugTask = {
    ...template.task,
    taskId,
    goal: bugInput.goal,
    observedBehavior: bugInput.observedBehavior,
    expectedBehavior: bugInput.expectedBehavior,
    reproduction: bugInput.reproduction,
    acceptanceCriteria: Object.freeze([...bugInput.acceptanceCriteria]),
    constraints: Object.freeze([...(bugInput.constraints ?? [])]),
  };
  const checked = validateCustomTaskOverride(template.task, candidate);
  if ('status' in checked || !taskMatchesSource(checked, source)) {
    throw new Error('INVALID_CUSTOM_TASK');
  }
  return checked;
}

/** Builds the real console's `customRoute` without a catalog `entry` or `workflowReport` so custom runs stay exploratory and ungraded. */
export function createCustomConsoleRoute(input: CreateCustomConsoleRouteInput): UC03EvaluationGraphRoute {
  const { readiness, coderBudget, templatesByRepo, catalogTaskIds, sessions, pendingCustomTasks, allowRevise, bindCustomCase, retireSession } = input;
  let customSeq = 0;

  return {
    readiness,
    coderBudget,
    expectedWait: null,
    resolveTask: ({ experimentId, source, priorState }) => {
      if (source.kind !== 'bug' || source.status !== 'complete') throw new Error('INVALID_CUSTOM_SOURCE');
      const template = templatesByRepo.get(source.repositoryId);
      if (!template) throw new Error('MISSING_CUSTOM_TEMPLATE');
      if (priorState !== null) {
        const session = sessions.get(experimentId);
        if (!session || session.task.taskId !== priorState.taskId) throw new Error('UNKNOWN_CUSTOM_SESSION');
        if (!isCustomTaskOnTemplate(template.task, session.task, source)) throw new Error('INVALID_CUSTOM_TASK');
        return session.task;
      }
      const existingSession = sessions.get(experimentId);
      if (existingSession && isCustomTaskOnTemplate(template.task, existingSession.task, source)) return existingSession.task;
      const cached = pendingCustomTasks.get(experimentId);
      if (cached && cached.submissionDigest === source.submissionDigest) return cached.task;
      const task = buildCustomConsoleTask({ experimentId, source, template, catalogTaskIds, nextSeq: () => ++customSeq });
      pendingCustomTasks.set(experimentId, { submissionDigest: source.submissionDigest, task });
      return task;
    },
    bindCase: async ({ experimentId, source, task }): Promise<EvaluationCaseBinding> => {
      pendingCustomTasks.delete(experimentId);
      if (source.kind !== 'bug' || source.status !== 'complete') return { ok: false, reasonCode: 'INVALID_CUSTOM_SOURCE' };
      const template = templatesByRepo.get(source.repositoryId);
      if (!template) return { ok: false, reasonCode: 'MISSING_CUSTOM_TEMPLATE' };
      if (!isCustomTaskOnTemplate(template.task, task, source)) return { ok: false, reasonCode: 'INVALID_CUSTOM_TASK' };
      return bindCustomCase({ experimentId, entry: template.entry, customTask: task });
    },
    resolveDirection: dirInput => resolveRealConsoleDirection(sessions, allowRevise, dirInput),
    resolveClarificationResume: resumeInput => resolveRealConsoleClarificationResume(sessions, resumeInput),
    resolveClarificationEnd: endInput => resolveRealConsoleClarificationEnd(sessions, endInput),
    onClarificationEndAccepted: retireSession,
    onTerminal: retireSession,
  };
}
