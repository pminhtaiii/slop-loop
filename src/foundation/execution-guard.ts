/**
 * UC-03 Phase 5 - Execution Guard Foundation (T021 Skeleton / T022 SUT)
 *
 * Owned path: src/foundation/execution-guard.ts
 * Feature: specs/001-verified-code-repair
 *
 * SUT for ExecutionGuard composing:
 * - Deterministic pre-dispatch envelope, isolation, and limits validation.
 * - UC-05 approval classification and policy enforcement (no reimplementation).
 * - UC-04 atomic multi-budget reservation, CAS state transitions, and settlement.
 * - Isolated repository execution via RepositoryPort.
 *
 * T021 Status: Signature-only neutral no-dispatch skeleton.
 * Full authoritative sequence composition is completed in T022.
 */

import type {
  ExecutionGuard,
  PortProvenance,
  NormalizedAction,
  TaskState,
  EnvelopeOutcome,
  StatePort,
  ApprovalPort,
  RepositoryPort,
  TelemetryPort,
  CommandView,
} from '../contracts/foundation/uc03.ts';

export interface ExecutionGuardPorts {
  readonly statePort: StatePort;
  readonly approvalPort: ApprovalPort;
  readonly repositoryPort: RepositoryPort;
  readonly telemetryPort?: TelemetryPort | undefined;
}

export interface ExecutionGuardConfig {
  readonly provenance?: PortProvenance | undefined;
  readonly commandView?: CommandView | undefined;
  readonly defaultTimeoutMs?: number | undefined;
}

export interface ExecutionGuardOptions {
  readonly ports: ExecutionGuardPorts;
  readonly config?: ExecutionGuardConfig | undefined;
}

export interface ExecutionGuardResult {
  readonly outcome: EnvelopeOutcome;
  readonly result?: unknown;
  readonly reason?: string | undefined;
}

export class AuthoritativeExecutionGuard implements ExecutionGuard {
  readonly provenance: PortProvenance;
  readonly ports: ExecutionGuardPorts;
  readonly config?: ExecutionGuardConfig | undefined;

  constructor(options: ExecutionGuardOptions) {
    this.provenance = options.config?.provenance ?? 'mock';
    this.ports = options.ports;
    this.config = options.config;
  }

  async validateAndExecute(
    action: NormalizedAction,
    state: TaskState
  ): Promise<ExecutionGuardResult> {
    // T021: Neutral no-dispatch / incomplete skeleton.
    // Zero dispatch to repositoryPort, statePort, or approvalPort.
    // The complete interfaces.md sequence is composed in T022.
    void action;
    void state;
    return {
      outcome: 'denied',
      reason: 'SKELETON_NO_DISPATCH: T021 signature-only guard skeleton; authoritative execution checks composed in T022',
    };
  }
}

export function createExecutionGuard(
  options: ExecutionGuardOptions
): AuthoritativeExecutionGuard {
  return new AuthoritativeExecutionGuard(options);
}
