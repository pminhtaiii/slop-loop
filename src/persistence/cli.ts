import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DurableStore } from './store.ts';
import { reconcileAndResume, WorkspaceDriftError } from './recovery.ts';
import { pauseTask, resumeTask } from './task-control.ts';
import { compactContext, formatCompactSummaryMarkdown } from './inspection.ts';
import type { WorkspaceBaseline } from './contracts.ts';

export interface CliResult {
  readonly exitCode: number;
  readonly output: string;
}

export interface CliOptions {
  readonly repoRoot?: string;
  readonly gitInspector?: (repoRoot: string) => Promise<WorkspaceBaseline>;
}

export async function runCli(args: string[], storeInstance?: DurableStore, options?: CliOptions): Promise<CliResult> {
  const store = storeInstance ?? new DurableStore();
  await store.init();
  const command = args[0]?.toLowerCase();

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return {
      exitCode: 0,
      output: [
        'UC-04 Durable Task Control CLI',
        'Usage:',
        '  task status <taskId>         Display task state, steps, and progress',
        '  task pause <taskId> [reason] Initiate deliberate pause on a runnable task',
        '  task resume <taskId>         Reconcile drift and resume a paused task',
        '  task compact <taskId>        Output 6-field compact summary for context token saving',
      ].join('\n'),
    };
  }

  try {
    switch (command) {
      case 'status': {
        const taskId = args[1];
        if (!taskId) {
          return { exitCode: 1, output: 'Error: Missing <taskId> parameter for status command.' };
        }
        const state = await store.loadTaskState(taskId);
        if (!state) {
          return { exitCode: 1, output: `Error: Task '${taskId}' not found in storage.` };
        }
        const lines: string[] = [`Task: ${state.taskId} [Run: ${state.runId}]`, `Status: ${state.status}`, `State Version: ${state.stateVersion}`, 'Steps:'];
        for (const step of state.plan) {
          const stepObj = step as unknown as Record<string, unknown>;
          const stepId = typeof stepObj['id'] === 'string' ? stepObj['id'] : typeof stepObj['stepId'] === 'string' ? stepObj['stepId'] : 'step';
          const rawDeps = stepObj['predecessorIds'] ?? stepObj['dependencies'];
          const depsArr = Array.isArray(rawDeps) ? (rawDeps as string[]) : [];
          const deps = depsArr.length > 0 ? ` (deps: ${depsArr.join(', ')})` : '';
          lines.push(`  [${step.status.toUpperCase()}] ${stepId}: ${step.title}${deps}`);
        }
        return { exitCode: 0, output: lines.join('\n') };
      }

      case 'pause': {
        const taskId = args[1];
        const reason = args.slice(2).join(' ') || 'Operator deliberate pause';
        if (!taskId) {
          return { exitCode: 1, output: 'Error: Missing <taskId> parameter for pause command.' };
        }
        const state = await store.loadTaskState(taskId);
        if (!state) {
          return { exitCode: 1, output: `Error: Task '${taskId}' not found in storage.` };
        }
        if (state.status === 'paused' || state.status === 'completed' || state.status === 'failed') {
          return { exitCode: 1, output: `Task '${taskId}' is currently ${state.status}; cannot pause.` };
        }

        const existingPause = await store.loadPauseRecord(taskId);
        const pauseRec = await pauseTask(store, {
          taskId,
          expectedRevision: existingPause?.revision ?? 1,
          pauseKey: `pause-${randomUUID()}`,
          operatorRef: 'operator-cli',
        });

        // Update task state status to paused
        await store.saveTaskState({
          ...state,
          status: 'paused',
          stateVersion: state.stateVersion + 1,
        });

        return {
          exitCode: 0,
          output: `Task '${taskId}' successfully paused. Key: ${pauseRec.pauseKey} (Reason: ${reason})`,
        };
      }

      case 'resume': {
        const taskId = args[1];
        if (!taskId) {
          return { exitCode: 1, output: 'Error: Missing <taskId> parameter for resume command.' };
        }
        try {
          const pauseRecord = await store.loadPauseRecord(taskId);
          if (pauseRecord?.active) {
            await resumeTask(store, {
              taskId,
              expectedRevision: pauseRecord.revision,
              resumeKey: `resume-${randomUUID()}`,
              operatorRef: 'operator-cli',
            });
          }
          const resumed = await reconcileAndResume(taskId, store, {
            repoRoot: options?.repoRoot ?? '.',
            ...(options?.gitInspector ? { gitInspector: options.gitInspector } : {}),
          });
          return {
            exitCode: 0,
            output: `Task '${taskId}' successfully resumed to state '${resumed.status}'. Steps: ${resumed.plan.length}`,
          };
        } catch (err: unknown) {
          if (err instanceof WorkspaceDriftError) {
            return {
              exitCode: 1,
              output: `Drift detected for task '${taskId}': ${err.message}`,
            };
          }
          return {
            exitCode: 1,
            output: `Failed to resume task '${taskId}': ${(err as Error).message}`,
          };
        }
      }

      case 'compact': {
        const taskId = args[1];
        if (!taskId) {
          return { exitCode: 1, output: 'Error: Missing <taskId> parameter for compact command.' };
        }
        const state = await store.loadTaskState(taskId);
        if (!state) {
          return { exitCode: 1, output: `Error: Task '${taskId}' not found in storage.` };
        }
        const summary = compactContext(state);
        const md = formatCompactSummaryMarkdown(summary);
        return { exitCode: 0, output: md };
      }

      default:
        return {
          exitCode: 1,
          output: `Unknown command: '${command}'. Run 'task help' for usage instructions.`,
        };
    }
  } catch (err: unknown) {
    return {
      exitCode: 1,
      output: `CLI Error: ${(err as Error).message}`,
    };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  runCli(process.argv.slice(2)).then(res => {
    if (res.output) {
      if (res.exitCode === 0) {
        console.log(res.output);
      } else {
        console.error(res.output);
      }
    }
    process.exit(res.exitCode);
  });
}
