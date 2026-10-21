import {
  UC04_SCHEMA_VERSION,
  type TaskState,
  type WorkspaceBaseline,
  type BudgetLedger,
  type PlanStep,
} from '../../../../src/persistence/contracts.ts';

export interface RecoveryScenario {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly evidenceLevel: 'foundation-test' | 'mock-test';
  readonly createTask: () => TaskState;
}

export const baselineWorkspace: WorkspaceBaseline = {
  commitHash: '0123456789abcdef0123456789abcdef01234567',
  branch: 'feat/uc04-test',
  isClean: true,
  trackedFilesHash: 'sha256-baseline-tracked-files-hash',
};

export const defaultLedgers: BudgetLedger[] = [
  {
    scope: 'task',
    kind: 'tokens',
    limit: 50000,
    consumed: 0,
    reservations: [],
    configurationId: 'cfg-default',
    version: 1,
  },
  {
    scope: 'task',
    kind: 'cost',
    limit: 10.0,
    consumed: 0,
    reservations: [],
    configurationId: 'cfg-default',
    version: 1,
  },
  {
    scope: 'run',
    kind: 'repair',
    limit: 3,
    consumed: 0,
    reservations: [],
    configurationId: 'cfg-default',
    version: 1,
  },
];

export const samplePlan: PlanStep[] = [
  {
    id: 'step-1',
    title: 'Initialize Module',
    description: 'Set up types and configuration',
    status: 'todo',
    predecessorIds: [],
  },
  {
    id: 'step-2',
    title: 'Implement Core',
    description: 'Core logic implementation',
    status: 'todo',
    predecessorIds: ['step-1'],
  },
  {
    id: 'step-3',
    title: 'Verification',
    description: 'Run integration test suite',
    status: 'todo',
    predecessorIds: ['step-2'],
  },
];

export function createStandardTestTask(taskId = 'task-scen-01'): TaskState {
  return {
    schemaVersion: UC04_SCHEMA_VERSION,
    taskId,
    runId: 'run-01',
    repositoryId: 'repo-mock-01',
    workspaceId: 'ws-mock-01',
    taskType: 'feature',
    goal: 'Demonstrate durable execution and restart recovery',
    acceptanceCriteria: ['All 3 steps complete', 'Zero duplicate dispatch', 'Cumulative budget preserved'],
    constraints: ['Strict Node 24 ESM', 'Safe file isolation'],
    plan: samplePlan.map((s) => ({ ...s })),
    currentStepIndex: 0,
    changedFiles: [],
    openRisks: [],
    nextAction: 'Start step-1',
    status: 'pending',
    stateVersion: 1,
    budgetLedgers: defaultLedgers.map((l) => ({ ...l })),
    workspaceBaseline: { ...baselineWorkspace },
  };
}

export const RECOVERY_SCENARIOS: readonly RecoveryScenario[] = [
  {
    id: 'R01',
    code: 'R01',
    title: 'Acyclic Step Registration & Predecessor Validation',
    evidenceLevel: 'foundation-test',
    createTask: () => createStandardTestTask('task-r01'),
  },
  {
    id: 'R02',
    code: 'R02',
    title: 'Atomic Checkpoint & SHA-256 Integrity Verification',
    evidenceLevel: 'foundation-test',
    createTask: () => createStandardTestTask('task-r02'),
  },
  {
    id: 'R03',
    code: 'R03',
    title: 'Coherent Progress Restore & Zero Completed Step Replay',
    evidenceLevel: 'foundation-test',
    createTask: (): TaskState => {
      const task = createStandardTestTask('task-r03');
      return {
        ...task,
        currentStepIndex: 1,
        plan: task.plan.map((s, idx) =>
          idx === 0
            ? { ...s, status: 'done' as const, completedAt: '2026-10-21T12:00:00.000Z', changedFiles: ['src/init.ts'] }
            : { ...s, status: 'todo' as const }
        ),
        changedFiles: ['src/init.ts'],
        stateVersion: 2,
      };
    },
  },
  {
    id: 'R04',
    code: 'R04',
    title: 'Atomic Multi-Budget Reservation (Tokens & Cost)',
    evidenceLevel: 'foundation-test',
    createTask: () => createStandardTestTask('task-r04'),
  },
  {
    id: 'R05',
    code: 'R05',
    title: 'Provider Usage Settlement & Conservative Uncertain Retention',
    evidenceLevel: 'foundation-test',
    createTask: () => createStandardTestTask('task-r05'),
  },
  {
    id: 'R06',
    code: 'R06',
    title: 'Deliberate Human Pause via Sidecar Record',
    evidenceLevel: 'foundation-test',
    createTask: () => createStandardTestTask('task-r06'),
  },
  {
    id: 'R07',
    code: 'R07',
    title: 'Declined Early Resume when In-Flight Work Outstanding',
    evidenceLevel: 'foundation-test',
    createTask: () => createStandardTestTask('task-r07'),
  },
  {
    id: 'R08',
    code: 'R08',
    title: 'Shared Epoch Fence between Deliberate Pause & Dispatch Claim',
    evidenceLevel: 'foundation-test',
    createTask: () => createStandardTestTask('task-r08'),
  },
  {
    id: 'R09',
    code: 'R09',
    title: 'Workspace Drift Detection (Commit Mismatch & Dirty Tree)',
    evidenceLevel: 'foundation-test',
    createTask: () => createStandardTestTask('task-r09'),
  },
  {
    id: 'R10',
    code: 'R10',
    title: 'Task-Scoped vs Run-Scoped Budget Persistence across New Run',
    evidenceLevel: 'foundation-test',
    createTask: () => createStandardTestTask('task-r10'),
  },
  {
    id: 'R11',
    code: 'R11',
    title: 'Reconcile Uncertain Reservation after Interrupted Execution',
    evidenceLevel: 'foundation-test',
    createTask: () => createStandardTestTask('task-r11'),
  },
  {
    id: 'R12',
    code: 'R12',
    title: 'Safe 6-Field Compact Context Compaction for LLM Reasoning',
    evidenceLevel: 'foundation-test',
    createTask: () => createStandardTestTask('task-r12'),
  },
  {
    id: 'R13',
    code: 'R13',
    title: 'Process Crash Simulation & Multi-Process Concurrency Lock',
    evidenceLevel: 'foundation-test',
    createTask: () => createStandardTestTask('task-r13'),
  },
  {
    id: 'R14',
    code: 'R14',
    title: 'Bounded Status & Task History Inspection without State Mutation',
    evidenceLevel: 'foundation-test',
    createTask: () => createStandardTestTask('task-r14'),
  },
  {
    id: 'R15',
    code: 'R15',
    title: 'Approval Hold Preservation & Cryptographic Binding Validation',
    evidenceLevel: 'foundation-test',
    createTask: () => createStandardTestTask('task-r15'),
  },
  {
    id: 'R16',
    code: 'R16',
    title: 'End-to-End Multi-Step Feature Execution with Crash Recovery',
    evidenceLevel: 'foundation-test',
    createTask: () => createStandardTestTask('task-r16'),
  },
];
