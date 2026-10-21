import { parseArgs } from 'node:util';
import { DurableStore } from '../../../../src/persistence/store.ts';
import { StepStateMachine, reconcileAndResume } from '../../../../src/persistence/recovery.ts';
import { BudgetTracker } from '../../../../src/persistence/accounting.ts';
import { createStandardTestTask, baselineWorkspace } from './scenarios.ts';

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'store-dir': { type: 'string' },
      'task-id': { type: 'string' },
      command: { type: 'string' },
    },
  });

  const storeDir = values['store-dir'];
  const taskId = values['task-id'] ?? 'task-restart-01';
  const command = values.command;

  if (!storeDir || !command) {
    console.error('Missing required arguments --store-dir and --command');
    process.exit(1);
  }

  const store = new DurableStore(storeDir);
  const machine = new StepStateMachine();

  switch (command) {
    case 'init': {
      const task = createStandardTestTask(taskId);
      await store.saveCheckpoint(task);
      console.log(JSON.stringify({ pid: process.pid, status: 'INIT_OK', taskId }));
      break;
    }

    case 'step1': {
      const cp = await store.loadLatestCheckpoint(taskId);
      if (!cp) throw new Error('No checkpoint found');
      let state = cp.state;

      // Start step-1
      state = machine.startStep(state, 'step-1');
      // Spend 500 tokens
      const tracker = new BudgetTracker(state.budgetLedgers);
      tracker.reserve('req-step1', [{ scope: 'task', kind: 'tokens', amount: 500 }]);
      tracker.settle('req-step1', { inputTokens: 400, outputTokens: 100, costUsd: 0.01 });

      // Complete step-1
      state = machine.completeStep(
        { ...state, budgetLedgers: tracker.getLedgers() },
        'step-1',
        { changedFiles: ['src/init.ts'] }
      );
      await store.saveCheckpoint(state);

      console.log(JSON.stringify({ pid: process.pid, status: 'STEP1_OK', currentStepIndex: state.currentStepIndex }));
      break;
    }

    case 'crash-on-step2': {
      const cp = await store.loadLatestCheckpoint(taskId);
      if (!cp) throw new Error('No checkpoint found');
      let state = cp.state;

      // Start step-2
      state = machine.startStep(state, 'step-2');
      // Reserve 1000 tokens in-flight
      const tracker = new BudgetTracker(state.budgetLedgers);
      tracker.reserve('req-crash-step2', [{ scope: 'task', kind: 'tokens', amount: 1000 }]);

      state = { ...state, budgetLedgers: tracker.getLedgers() };
      await store.saveCheckpoint(state);

      console.log(JSON.stringify({ pid: process.pid, status: 'CRASHING_BEFORE_SETTLE' }));
      // Simulate sudden kill / crash
      process.exit(137);
      break;
    }

    case 'resume': {
      const resumed = await reconcileAndResume(taskId, store, {
        gitInspector: async () => ({ ...baselineWorkspace }),
        unresolvedReservationAction: 'charge_as_consumed',
      });

      // Complete step-2
      let state = machine.completeStep(resumed, 'step-2', { changedFiles: ['src/core.ts'] });
      // Start and complete step-3
      state = machine.startStep(state, 'step-3');
      state = machine.completeStep(state, 'step-3', { evidenceRefs: ['test-ok'] });
      await store.saveCheckpoint(state);

      console.log(JSON.stringify({
        pid: process.pid,
        status: 'RESUME_COMPLETED_OK',
        finalStatus: state.status,
        stepStatuses: state.plan.map((s) => ({ id: s.id, status: s.status })),
        consumedTokens: state.budgetLedgers.find((l) => l.kind === 'tokens')?.consumed,
      }));
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
