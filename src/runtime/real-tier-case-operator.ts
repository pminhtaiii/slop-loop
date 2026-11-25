/**
 * The real T046 operator decision source for the T028 campaign (real-tier contract §(f) T028;
 * quickstart §5).
 *
 * The runner presents the owner's pending approval through the bound task's own console port
 * (`src/runtime/console-approval-port.ts`) and reads one explicit choice from the operator's stdin.
 * Nothing approves automatically: EOF, a blank line, an unrecognised word or a service refusal all
 * return `undefined`, which the case stage records as a failed `approval-required` row.
 *
 * The forwarded body carries the exact presentation digest and version the owner showed, so the
 * UC-05 service's own stale/binding refusals apply unchanged. No argv, env or model value can supply
 * a decision.
 */
import { createInterface } from 'node:readline';

import type { SafePresentation } from '../contracts/approvals/contracts.ts';
import type { ConsoleApprovalPort } from './console-server.ts';

/** The prompt/decision seam, so the gate can drive this without a terminal. */
export interface OperatorIo {
  /** Writes one operator-facing line; never a credential, endpoint or report payload. */
  readonly write: (line: string) => void;
  /** Reads one line; `undefined` at end of input. */
  readonly read: () => Promise<string | undefined>;
}

/** The bound task a decision belongs to, plus its own console port. */
export interface DecisionTarget {
  readonly taskId: string;
  readonly console: ConsoleApprovalPort;
}

/** The default operator IO over stdin/stdout: one question, one line, nothing echo-suppressed. */
export function stdioOperator(): OperatorIo {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const lines: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let closed = false;
  rl.on('line', line => {
    const resolve = waiting.shift();
    if (resolve) resolve(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const resolve of waiting.splice(0)) resolve(undefined);
  });
  return {
    write: line => process.stdout.write(`${line}\n`),
    read: async () => {
      const ready = lines.shift();
      if (ready !== undefined) return ready;
      if (closed) return undefined;
      return new Promise(resolve => waiting.push(resolve));
    },
  };
}

/** The response key a decision body needs; derived from the decision id, so a retry replays it. */
function idempotencyKey(decisionId: string): string {
  return `uc03-t054-${decisionId}`.slice(0, 128);
}

/** The presentation the console port returns: the owner's safe view with a digest and version. */
function isPresentation(value: unknown): value is Readonly<{ taskId: string; presentation: SafePresentation }> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const presentation = record['presentation'];
  if (typeof record['taskId'] !== 'string' || typeof presentation !== 'object' || presentation === null) return false;
  const view = presentation as Record<string, unknown>;
  if (
    typeof view['presentationDigest'] !== 'string' ||
    typeof view['requestVersion'] !== 'number' ||
    typeof view['decisionId'] !== 'string' ||
    typeof view['elements'] !== 'object' ||
    view['elements'] === null
  ) {
    return false;
  }
  const elements = view['elements'] as Record<string, unknown>;
  return (
    typeof elements['action'] === 'string' &&
    typeof elements['necessity'] === 'string' &&
    Array.isArray(elements['targets']) &&
    elements['targets'].every((target: unknown) => typeof target === 'string') &&
    typeof elements['consequences'] === 'string' &&
    typeof elements['verificationStatus'] === 'string'
  );
}

/**
 * Builds the decision source the runner hands to the case stage. It presents through the task's own
 * console port and forwards exactly the shown digest and version; only `approve`/`reject` are accepted.
 */
export function createOperatorDecisionSource(io: OperatorIo): (caseId: string, target: DecisionTarget) => Promise<'approve' | 'reject' | undefined> {
  return async (caseId, target) => {
    const experimentId = caseId;
    const shown = await target.console.presentation(experimentId);
    if (!shown.ok || !isPresentation(shown.value)) {
      io.write(`CASE ${caseId}: no pending approval is available (${shown.ok ? 'unexpected-shape' : shown.reasonCode}). Nothing was approved.`);
      return undefined;
    }
    const view = shown.value;
    io.write(`CASE ${caseId}: approval required for task ${view.taskId}.`);
    io.write(`  action: ${view.presentation.elements.action}`);
    io.write(`  necessity: ${view.presentation.elements.necessity}`);
    io.write(`  targets: ${view.presentation.elements.targets.join(', ') || 'none'}`);
    io.write(`  consequences: ${view.presentation.elements.consequences}`);
    io.write(`  verification: ${view.presentation.elements.verificationStatus}`);
    io.write(`  decision: ${view.presentation.decisionId} v${view.presentation.requestVersion} ${view.presentation.presentationDigest}`);
    for (;;) {
      io.write('Type "approve" or "reject" (anything else aborts with no decision):');
      const answer = (await io.read())?.trim().toLowerCase();
      if (answer !== 'approve' && answer !== 'reject') {
        io.write('No explicit decision was entered; the task stays paused.');
        return undefined;
      }
      const decided = await target.console.decide({
        experimentId,
        presentationDigest: view.presentation.presentationDigest,
        expectedVersion: view.presentation.requestVersion,
        decision: answer,
        idempotencyKey: idempotencyKey(view.presentation.decisionId),
      });
      if (decided.ok) {
        io.write(`Decision recorded: ${answer}.`);
        return answer;
      }
      // A refusal is the owner's own: report it and let the operator try again or abort.
      io.write(`The owner refused the decision: ${decided.reasonCode}.`);
      if (decided.reasonCode !== 'conflict') return undefined;
    }
  };
}
