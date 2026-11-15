/**
 * T058 — routes an uncertain effect to its owner and gates continuation (real-tier contract §(b)2,
 * §(h)).
 *
 * `createRecoveryGate({ lookupOperation, lookupWrite })` resolves one `operationRef` by its owner
 * prefix only: `uc04-journal:` goes to the T040 journal lookup, `uc04-baseline:` to the T041
 * evidence-store lookup, and any other prefix is `blocked` without reaching either owner. The owner
 * answer maps one way — `committed` resumes from the owner record, `absent` (a claim closed
 * unattempted, or a baseline write that left no file) permits a fresh attempt under new authority,
 * and `unknown` blocks. Provider and patch `unknown` stay blocked: nothing queries the provider and
 * no repository reconciliation exists, so a fresh task is the only way forward. The gate is
 * read-only: it never writes, replays a fetch/patch/replan/persist, or re-executes an effect.
 */
import { BASELINE_OPERATION_PREFIX } from '../persistence/adapters/baseline-evidence-store.ts';
import { JOURNAL_OPERATION_PREFIX } from '../persistence/adapters/state-port-v02-operation-lookup.ts';

export type RecoveryDecision = 'resume' | 'fresh-attempt' | 'blocked';

/** What an owner lookup can answer about one operation; both production lookups return this shape. */
export interface OwnerLookupOutcome {
  readonly outcome: 'committed' | 'absent' | 'unknown';
}

export interface RecoveryGateOptions {
  readonly lookupOperation: (operationRef: string) => Promise<OwnerLookupOutcome>;
  readonly lookupWrite: (operationRef: string) => Promise<OwnerLookupOutcome>;
}

export interface RecoveryGate {
  /** The continuation decision for one uncertain effect's operation ref. Read-only. */
  decide(operationRef: string): Promise<RecoveryDecision>;
}

export function createRecoveryGate(options: RecoveryGateOptions): RecoveryGate {
  return {
    async decide(operationRef: string): Promise<RecoveryDecision> {
      const lookup = operationRef.startsWith(JOURNAL_OPERATION_PREFIX) ? options.lookupOperation : operationRef.startsWith(BASELINE_OPERATION_PREFIX) ? options.lookupWrite : undefined;
      if (!lookup) return 'blocked';
      const { outcome } = await lookup(operationRef);
      return outcome === 'committed' ? 'resume' : outcome === 'absent' ? 'fresh-attempt' : 'blocked';
    },
  };
}
