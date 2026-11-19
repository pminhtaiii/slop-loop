/**
 * T051 support — the parts of the real containment probe that need no Docker, so a controlled test can
 * run exactly what the probe runs (`uc03-real-containment-evidence.test.ts`).
 *
 * - the hostile `run_command` admission, built through the production view builder lift
 *   (`admissionCommandView`) and the production receipt digest, never hand-made digests;
 * - the guard's refusal text for each negative row, as the guard actually returns it;
 * - the resource-kill predicates, including the memory witness bound to the container that ran.
 *
 * Not a `*.test.ts` file: it only holds helpers, and the probe imports it.
 */
import { computePolicyEvaluationReceiptDigest } from '../../../src/contracts/approvals/contracts.ts';
import { computeActionDigest, computeCanonicalSha256, computeCheckSetDigest } from '../../../src/contracts/foundation/uc03.ts';
import type { CheckDefinition, RepositoryAdmissionContextV02, RunCommandAction, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import type { CommandViewV02 } from '../../../src/contracts/foundation/uc03/v02/ports.ts';
import type { StructuredSpawn } from '../../../src/foundation/docker-controller.ts';
import type { CommandViewOwnerBindingParams, IssuedCommandView } from '../../../src/foundation/docker-view-builder.ts';
import { admissionCommandView } from '../../../src/foundation/repository-admission.ts';
import type { ExecutionProfileV02 } from '../../../src/persistence/adapters/state-port-v02-admission.ts';

/** The one test file the hostile command targets; the diagnostic admission names it as its test path. */
const HOSTILE_TEST_PATH = 'tests/test_malicious.py';

/** The one check the hostile admission binds to; a missing check is a fixture error, not a refusal. */
export function firstCheck(checks: readonly CheckDefinition[]): CheckDefinition {
  const check = checks[0];
  if (check === undefined) throw new Error('the hostile admission needs a bound check');
  return check;
}

/**
 * The hostile action is the bound check's own command, so the receiver's check binding
 * (`bindCheckToAdmission`: executable, argv, working directory) admits it. The check is the one source.
 */
export function hostileCommand(actionId: string, check: CheckDefinition): RunCommandAction {
  const { workingDirectory } = check;
  if (!check.argv.includes(HOSTILE_TEST_PATH) || workingDirectory === undefined) throw new Error(`the bound check must run ${HOSTILE_TEST_PATH} in a named working directory`);
  return { actionId, kind: 'run_command', executable: check.executable, argv: [...check.argv], workingDirectory, purpose: 'investigate' };
}

/** Any owner-bound view build: the workspace manager's in the probe, the production builder over a double in the test. */
export type AdmitView = (params: CommandViewOwnerBindingParams) => Promise<IssuedCommandView>;

/**
 * The v0.2 view the production path hands the guard: measure once, then re-issue under the owner's
 * trusted isolation profile and lift the issued view with its host-measured record.
 */
export async function measuredAdmissionView(admit: AdmitView, workspaceId: string, requiredFiles: readonly string[], isolationProfileRef: string): Promise<CommandViewV02> {
  const { view } = await admit({ workspaceId, requiredFiles });
  const issued = await admit({
    workspaceId,
    requiredFiles,
    trustedIsolationProfileRef: isolationProfileRef,
    ownerView: {
      canonicalRevision: view.canonicalRevisionDigest,
      exclusionsPolicyVersion: view.exclusionsPolicyVersion,
      scratchIdentity: view.scratchIdentity,
      admittedFiles: view.admittedFiles,
      mountedReadOnly: true,
      isolationProfileRef,
    },
  });
  if (issued.measured === undefined) throw new Error('the owner-bound view build issued no isolation record');
  return admissionCommandView(issued.view, issued.measured);
}

export interface HostileAdmissionInput {
  readonly state: Pick<TaskState, 'taskId' | 'runId' | 'workspaceId' | 'repositoryId' | 'stateVersion' | 'repositoryRevisionDigest' | 'acceptanceCriteria'>;
  readonly view: CommandViewV02;
  /** The owner profile the bound port admits against: it names the bounds, so they are never retyped here. */
  readonly profile: ExecutionProfileV02;
  /** The authority the control head publishes. */
  readonly authority: RepositoryAdmissionContextV02['policyAuthorityRef'];
  readonly checks: readonly CheckDefinition[];
  readonly action: RunCommandAction;
}

/** A pre-plan diagnostic `run_command` admission at the `Investigate` node, with full-body receipt digests. */
export function hostileAdmission(input: HostileAdmissionInput): RepositoryAdmissionContextV02 {
  const { state, view, profile, authority, checks, action } = input;
  const actionDigest = computeActionDigest(action);
  // The admission recomputes this digest over the whole receipt body without its digest key.
  const evaluation = {
    receiptId: `pe-${action.actionId}`,
    actionDigest,
    freshnessContextDigest: computeCanonicalSha256({ freshness: action.actionId }),
    policyId: authority.policyId,
    policyVersion: authority.policyVersion,
    configId: authority.configId,
    configVersion: authority.configVersion,
    decisionAuthorityGeneration: authority.decisionAuthorityGeneration,
    result: 'ALLOWED' as const,
  };
  const context: RepositoryAdmissionContextV02 = {
    schemaVersion: '0.2.0',
    subjectKind: 'repository-action',
    planApplicability: 'pre-plan-diagnostic',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: state.stateVersion,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 1,
    expectedEpoch: 1,
    taskId: state.taskId,
    runId: state.runId,
    workspaceId: state.workspaceId,
    repositoryId: state.repositoryId,
    runnableNode: 'Investigate',
    canonicalRevision: state.repositoryRevisionDigest,
    executionProfileId: profile.isolationProfileRef,
    action,
    actionDigest,
    policyAuthorityRef: authority,
    policyEvaluationReceipt: { ...evaluation, receiptDigest: computePolicyEvaluationReceiptDigest(evaluation) },
    commandView: view,
    finiteBounds: { ...profile.commandBounds, isolationProfileRef: profile.isolationProfileRef },
    reservationRefs: (['task', 'run'] as const).flatMap(scope =>
      ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'].map(kind => `${scope}-${kind}-${action.actionId}`),
    ),
    diagnosticPurpose: 'investigate',
    taskCriteriaDigest: computeCanonicalSha256(state.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(checks),
    checkId: checks[0]?.checkId,
    testPath: HOSTILE_TEST_PATH,
  };
  return context;
}

/**
 * What the production guard returns for each refusal. The guard reports a validator error by its message,
 * not its code, so these are the messages; `STATE_CONTEXT_MISMATCH` is the guard's own prefix.
 */
export const REFUSAL_REASONS = {
  stale: 'STATE_CONTEXT_MISMATCH',
  forbidden: 'FORBIDDEN result never admits',
  noView: 'commandView required',
  noBounds: 'finiteBounds required',
} as const;

export type RefusalName = keyof typeof REFUSAL_REASONS | 'foreignIsolation';

const STALE_REVISION = `sha256:${'0'.repeat(64)}`;

/** One context per negative row, each differing from the admitted one in exactly the field it names. */
export function refusalContexts(input: Omit<HostileAdmissionInput, 'action'>): Record<RefusalName, RepositoryAdmissionContextV02> {
  const make = (name: RefusalName, change: (base: Record<string, unknown>) => void): RepositoryAdmissionContextV02 => {
    const base = structuredClone(hostileAdmission({ ...input, action: hostileCommand(`act-guarded-${name}`, firstCheck(input.checks)) })) as unknown as Record<string, unknown>;
    change(base);
    return base as unknown as RepositoryAdmissionContextV02;
  };
  const view = (base: Record<string, unknown>): Record<string, unknown> => base['commandView'] as Record<string, unknown>;
  return {
    stale: make('stale', base => {
      base['canonicalRevision'] = STALE_REVISION;
      view(base)['canonicalRevision'] = STALE_REVISION;
    }),
    forbidden: make('forbidden', base => {
      (base['policyEvaluationReceipt'] as Record<string, unknown>)['result'] = 'FORBIDDEN';
    }),
    noView: make('noView', base => {
      delete base['commandView'];
    }),
    noBounds: make('noBounds', base => {
      delete base['finiteBounds'];
    }),
    foreignIsolation: make('foreignIsolation', base => {
      view(base)['isolationProfileRef'] = 'another-isolation-profile';
    }),
  };
}

export interface CommandOutcome {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outcome: string;
  readonly durationMs?: number;
}

/**
 * Whether an execution was ended by the admitted timeout rather than by an unrelated command failure:
 * an observed timeout verdict, settled within the admitted deadline plus the spawner's own SIGKILL grace.
 * A launch error (125), an ordinary failure (1), a generic `error` outcome or a null exit never count.
 */
export function timeoutKilled(result: CommandOutcome, admittedTimeoutMs?: number): boolean {
  if (!result.timedOut || result.outcome !== 'timeout') return false;
  if (admittedTimeoutMs === undefined) return true;
  // A supplied deadline needs measured evidence that the kill settled within it plus the grace.
  const duration = result.durationMs;
  return duration !== undefined && Number.isFinite(duration) && duration >= 0 && duration <= admittedTimeoutMs + 15_000;
}

/** A non-timeout SIGKILL exit (137 = 128+9), the one kill signal the controller surfaces. Not yet proof of OOM. */
export function sigkilled(result: CommandOutcome): boolean {
  return !result.timedOut && result.outcome === 'failure' && result.exitCode === 137;
}

export interface InspectedContainer {
  readonly name: string;
  readonly oomKilled: boolean;
  readonly exitCode: number;
}

/** Parses `docker inspect --format '{{.State.OOMKilled}} {{.State.ExitCode}}'`; anything else is no evidence. */
export function parseInspected(name: string, stdout: string): InspectedContainer | undefined {
  const [flag, code] = stdout.trim().split(/\s+/u);
  if ((flag !== 'true' && flag !== 'false') || code === undefined || !/^\d+$/u.test(code)) return undefined;
  return { name, oomKilled: flag === 'true', exitCode: Number.parseInt(code, 10) };
}

/**
 * The memory witness: the executor was SIGKILLed promptly, and Docker reports that this very container
 * (the one the executor started, by name) was OOM-killed with the same exit code. A SIGKILL without OOM,
 * or an OOM in some other container, is not memory enforcement of this run.
 */
export function memoryKillWitnessed(executed: CommandOutcome, ranName: string | undefined, container: InspectedContainer | undefined, admittedTimeoutMs: number): boolean {
  return (
    ranName !== undefined &&
    container !== undefined &&
    container.name === ranName &&
    container.oomKilled &&
    container.exitCode === executed.exitCode &&
    sigkilled(executed) &&
    executed.durationMs !== undefined &&
    executed.durationMs <= admittedTimeoutMs
  );
}

export interface ContainerTrap {
  /** The spawn the assembly runs Docker through. */
  readonly spawn: StructuredSpawn;
  /** Watch for the one `docker run` carrying this exact argument (the script under test). */
  arm(marker: string): void;
  /** Stop watching and return the name of the container that run started. */
  disarm(): string | undefined;
}

/**
 * Records the name of the one container started for an armed command and keeps it after exit, so
 * `docker inspect` can report its own kill reason: `--rm` is the only argument dropped, and only for
 * that run. Every resource, isolation and mount argument reaches Docker unchanged.
 */
export function createContainerTrap(base: StructuredSpawn): ContainerTrap {
  let marker: string | undefined;
  let name: string | undefined;
  return {
    spawn: (command, args, options) => {
      if (marker === undefined || name !== undefined || command !== 'docker' || args[0] !== 'run' || !args.includes(marker)) return base(command, args, options);
      name = args.find(argument => argument.startsWith('--name='))?.slice('--name='.length);
      return base(
        command,
        args.filter(argument => argument !== '--rm'),
        options,
      );
    },
    arm: next => {
      marker = next;
      name = undefined;
    },
    disarm: () => {
      const ran = name;
      marker = undefined;
      name = undefined;
      return ran;
    },
  };
}

export interface DiagnosticRunResult {
  readonly outcome: CommandOutcome;
  readonly ranName: string | undefined;
  readonly inspected: InspectedContainer | undefined;
  readonly removed: boolean;
}

/**
 * Runs one armed diagnostic execution with guaranteed container cleanup (STD-W5-301):
 * owns the diagnostic container in a local try/finally, disarming the trap and force-removing
 * the captured container name on every return and failure path (including execution rejection,
 * indeterminate exit or inspection failure), and checking and reporting removal failure.
 */
export async function runDiagnosticWithCleanup(options: {
  readonly trap: ContainerTrap;
  readonly marker: string;
  readonly execute: () => Promise<CommandOutcome>;
  readonly inspect: (name: string) => Promise<InspectedContainer | undefined>;
  readonly remove: (name: string) => Promise<{ exitCode: number | null }>;
}): Promise<DiagnosticRunResult> {
  const { trap, marker, execute, inspect, remove } = options;
  let ranName: string | undefined;
  let inspected: InspectedContainer | undefined;
  let outcome: CommandOutcome | undefined;
  let runFailure: { readonly error: unknown } | undefined;
  let removalError: Error | undefined;

  trap.arm(marker);
  try {
    outcome = await execute();
    ranName = trap.disarm();
    if (ranName !== undefined) {
      inspected = await inspect(ranName);
    }
  } catch (error) {
    // Held, not swallowed: cleanup runs first, then this failure is rethrown with any removal failure.
    runFailure = { error };
  }
  const target = ranName ?? trap.disarm();
  if (target !== undefined) {
    try {
      const rm = await remove(target);
      if (rm.exitCode !== 0) removalError = new Error(`DIAGNOSTIC_CONTAINER_REMOVAL_FAILED: docker rm -f ${target} exited with ${rm.exitCode}`);
    } catch (error) {
      removalError = new Error(`DIAGNOSTIC_CONTAINER_REMOVAL_FAILED: docker rm -f ${target} threw`, { cause: error });
    }
  }
  if (runFailure !== undefined) {
    // A retained container must not hide behind the run's own failure, so both are reported together.
    if (removalError !== undefined) throw new AggregateError([runFailure.error, removalError], `DIAGNOSTIC_RUN_FAILED_AND_CONTAINER_RETAINED: ${target}`);
    throw runFailure.error;
  }
  if (removalError !== undefined) throw removalError;

  if (outcome === undefined) throw new Error('DIAGNOSTIC_EXECUTION_MISSING');
  return { outcome, ranName, inspected, removed: removalError === undefined && ranName !== undefined };
}
