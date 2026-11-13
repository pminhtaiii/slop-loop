/** Host-owned, task/run-scoped construction for the production v0.2 coder. */

import type { ModelPortV02, RepositoryPortV02 } from '../contracts/foundation/uc03.ts';
import type { ExecutionGuardReadCapability } from '../foundation/repository-types.ts';
import { createCoderAgentV02 } from '../uc03/agent.ts';
import type { CoderAgentV02, CoderBudget, CoderTurnInputV02 } from '../uc03/agent-types.ts';
import type { TrustedHostExpectedContext } from '../uc03/investigation-types.ts';
import type { UC03GraphGenerationV02 } from '../uc03/graph-types-v02.ts';

export interface HostCoderOptions {
  readonly model: ModelPortV02;
  readonly repository: RepositoryPortV02;
  readonly guardedRead: ExecutionGuardReadCapability;
  readonly admissionContextForCheck?: TrustedHostExpectedContext['admissionContextForCheck'];
  readonly budget: CoderBudget;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validBudget(value: unknown): value is CoderBudget {
  if (!isRecord(value)) return false;
  const keys = ['maxModelCalls', 'maxActiveMs', 'maxRepairs', 'maxReplans'] as const;
  return keys.every(key => typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0);
}

function requireHostCoderOptions(options: HostCoderOptions): void {
  if (typeof options?.model?.propose !== 'function') throw new Error('HOST_CODER_MODEL_REQUIRED');
  if (
    typeof options.repository?.listDir !== 'function' ||
    typeof options.repository.readFile !== 'function' ||
    typeof options.repository.searchCode !== 'function' ||
    typeof options.repository.applyPatch !== 'function' ||
    typeof options.repository.runCommand !== 'function' ||
    typeof options.repository.runTests !== 'function' ||
    typeof options.repository.inspectDiff !== 'function'
  ) throw new Error('HOST_CODER_REPOSITORY_REQUIRED');
  if (typeof options.guardedRead?.mediateRead !== 'function') throw new Error('HOST_CODER_GUARDED_READ_REQUIRED');
  if (typeof options.admissionContextForCheck !== 'function') throw new Error('HOST_CODER_CHECK_ADMISSION_REQUIRED');
  if (!validBudget(options.budget)) throw new Error('HOST_CODER_BUDGET_REQUIRED');
}

function runKey(input: CoderTurnInputV02): string {
  const taskId = input?.state?.taskId;
  const runId = input?.state?.runId;
  if (typeof taskId !== 'string' || !taskId.trim() || typeof runId !== 'string' || !runId.trim()) {
    throw new Error('HOST_CODER_TASK_RUN_REQUIRED');
  }
  return JSON.stringify([taskId, runId]);
}

/**
 * Creates no task agent until the graph has authoritative task/run state. The selector returns the
 * same agent for continuations of that run and a fresh agent for every different task/run pair.
 */
export function createHostCoderGeneration(options: HostCoderOptions): UC03GraphGenerationV02 {
  requireHostCoderOptions(options);
  const agents = new Map<string, CoderAgentV02>();
  return Object.freeze({
    agentFor(input: CoderTurnInputV02): CoderAgentV02 {
      const key = runKey(input);
      const existing = agents.get(key);
      if (existing) return existing;
      const agent = createCoderAgentV02({
        model: options.model,
        repository: options.repository,
        guardedRead: options.guardedRead,
        admissionContextForCheck: options.admissionContextForCheck,
        budget: options.budget,
      });
      agents.set(key, agent);
      return agent;
    },
  });
}
