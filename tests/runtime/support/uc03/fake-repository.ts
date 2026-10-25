/**
 * UC-03 Phase 2 - FakeRepositoryPort
 *
 * Owned path: tests/runtime/support/uc03/fake-repository.ts
 * Feature: specs/001-verified-code-repair
 *
 * Deterministic test-only implementation of RepositoryPort and RepositoryPortV02
 * for controlled offline testing.
 *
 * Invariants:
 * - Provenance is strictly 'mock'; rejected by isAdmittedForProduction.
 * - Zero real filesystem access or child process execution; purely memory-backed snapshots and spies.
 * - Enforces path containment (isCanonicalRelativePath) and rejects protected paths (isProtectedPath).
 * - Tracks versioned repository snapshots with SHA-256 revision digests.
 * - Commands and test runners act strictly as spies, returning only scripted diagnostics.
 */

import {
  type RepositoryPatchResultV02,
  type RepositoryCommandResultV02,
  type OutcomeRecordResultV02,
  type RepositoryPort,
  type RepositoryPortV02,
  type PortProvenance,
  type SourceEvidence,
  type ApplyPatchAction,
  type RunCommandAction,
  type CheckDefinition,
  type CheckResult,
  type ValidationError,
  type RepositoryAdmissionContextV02,
  type StatePortV02,
  type ClaimReceiptV02,
  type AttemptReceiptV02,
  type AttemptOutcomeReceiptV02,
  type ExecutorIdentityV02,
  isCanonicalRelativePath,
  isProtectedPath,
  validateNormalizedAction,
  validateCheckDefinition,
  validateSourceEvidence,
  validateCheckResult,
  validateRepositoryAdmissionV02,
  computeCanonicalSha256,
  computeActionDigest,
} from '../../../../src/contracts/foundation/uc03.ts';
import { createCommandOutcomeReceipt, normalizeCommandResult, validateOutcomeRecordResult } from '../../../../src/foundation/repository-command-outcome.ts';
import { beginRepositoryAttemptWithClaim } from '../../../../src/foundation/repository-receiver.ts';
import { computeAttemptOutcomeDigest } from '../../../../src/contracts/foundation/uc03/attempt-v02.ts';
import {
  createTestRepositoryAdmissionTrustedContextV02,
  createTestRepositoryOutcomeReceiptV02,
} from './state-fixtures.ts';

export interface RepositorySnapshot {
  readonly revisionDigest: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface ScriptedCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ScriptedDiffResult {
  readonly diff: string;
  readonly diffDigest: string;
  readonly changedFiles: readonly string[];
}

export interface FakeRepositoryV02CallRecord {
  readonly action: 'applyPatch' | 'runCommand' | 'runTests';
  readonly context: RepositoryAdmissionContextV02;
  readonly claimId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly claim?: ClaimReceiptV02 | undefined;
  readonly attempt?: AttemptReceiptV02 | undefined;
  readonly outcomeReceipt?: AttemptOutcomeReceiptV02 | undefined;
  readonly outcome: unknown;
}

export interface FakeRepositoryOptions {
  readonly initialRevision?: string | undefined;
  readonly initialFiles?: Readonly<Record<string, string>> | undefined;
  readonly commandResults?: Readonly<Record<string, ScriptedCommandResult>> | undefined;
  readonly testResults?: Readonly<Record<string, CheckResult>> | undefined;
  readonly diffResults?: Readonly<Record<string, ScriptedDiffResult>> | undefined;
  readonly statePort?: StatePortV02 | undefined;
  readonly executorIdentity?: ExecutorIdentityV02 | undefined;
  readonly defaultAdmissionContext?: RepositoryAdmissionContextV02 | undefined;
}

export class FakeRepositoryPort implements RepositoryPort, RepositoryPortV02 {
  readonly provenance: PortProvenance = 'mock';
  readonly executionGuardApiVersion = '0.2.0' as const;

  private currentRevisionDigest: string;
  private snapshots = new Map<string, Map<string, string>>();
  private commandResponses = new Map<string, ScriptedCommandResult>();
  private testResponses = new Map<string, CheckResult>();
  private diffResponses = new Map<string, ScriptedDiffResult>();

  // Spies
  private commandSpy: RunCommandAction[] = [];
  private testSpy: CheckDefinition[] = [];
  private patchSpy: ApplyPatchAction[] = [];
  private readSpy: string[] = [];
  private searchSpy: string[] = [];
  private listSpy: string[] = [];

  // v0.2 integration
  private statePort?: StatePortV02 | undefined;
  private executorIdentity?: ExecutorIdentityV02 | undefined;
  private defaultAdmissionContext?: RepositoryAdmissionContextV02 | undefined;
  private v02CallLog: FakeRepositoryV02CallRecord[] = [];

  constructor(options?: FakeRepositoryOptions) {
    const rev =
      options?.initialRevision ??
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    this.currentRevisionDigest = rev;

    const initialMap = new Map<string, string>();
    if (options?.initialFiles) {
      for (const [path, content] of Object.entries(options.initialFiles)) {
        initialMap.set(path, content);
      }
    } else {
      // Default initial python calculator files
      initialMap.set(
        'src/calculator.py',
        'class Calculator:\n    def divide(self, a, b):\n        return a / b\n'
      );
      initialMap.set(
        'tests/test_calculator.py',
        'import pytest\nfrom src.calculator import Calculator\n\ndef test_divide():\n    calc = Calculator()\n    assert calc.divide(10, 2) == 5\n'
      );
    }
    this.snapshots.set(rev, initialMap);

    if (options?.commandResults) {
      for (const [cmd, res] of Object.entries(options.commandResults)) {
        this.commandResponses.set(cmd, res);
      }
    }

    if (options?.testResults) {
      for (const [id, res] of Object.entries(options.testResults)) {
        this.testResponses.set(id, res);
      }
    }

    if (options?.diffResults) {
      for (const [r, res] of Object.entries(options.diffResults)) {
        this.diffResponses.set(r, res);
      }
    }

    this.statePort = options?.statePort;
    this.executorIdentity = options?.executorIdentity;
    this.defaultAdmissionContext = options?.defaultAdmissionContext;
  }

  get currentRevision(): string {
    return this.currentRevisionDigest;
  }

  get commands(): readonly RunCommandAction[] {
    return [...this.commandSpy];
  }

  get tests(): readonly CheckDefinition[] {
    return [...this.testSpy];
  }

  get patches(): readonly ApplyPatchAction[] {
    return [...this.patchSpy];
  }

  get reads(): readonly string[] {
    return [...this.readSpy];
  }

  get searches(): readonly string[] {
    return [...this.searchSpy];
  }

  get lists(): readonly string[] {
    return [...this.listSpy];
  }

  get v02Calls(): readonly FakeRepositoryV02CallRecord[] {
    return [...this.v02CallLog];
  }

  setExecutorIdentity(identity: ExecutorIdentityV02): void {
    this.executorIdentity = identity;
  }

  setStatePort(statePort: StatePortV02 | undefined): void {
    this.statePort = statePort;
  }

  setDefaultAdmissionContext(context: RepositoryAdmissionContextV02 | undefined): void {
    this.defaultAdmissionContext = context;
  }

  setAdmissionContext(context: RepositoryAdmissionContextV02 | undefined): void {
    this.defaultAdmissionContext = context;
  }

  setSnapshot(revisionDigest: string, files: Readonly<Record<string, string>>): void {
    const fileMap = new Map<string, string>();
    for (const [path, content] of Object.entries(files)) {
      fileMap.set(path, content);
    }
    this.snapshots.set(revisionDigest, fileMap);
    this.currentRevisionDigest = revisionDigest;
  }

  setCommandResult(commandKey: string, result: ScriptedCommandResult): void {
    this.commandResponses.set(commandKey, result);
  }

  setTestResult(checkId: string, result: CheckResult): void {
    this.testResponses.set(checkId, result);
  }

  setDiffResult(baseRevisionDigest: string, result: ScriptedDiffResult): void {
    this.diffResponses.set(baseRevisionDigest, result);
  }

  private getCurrentFiles(): Map<string, string> {
    const files = this.snapshots.get(this.currentRevisionDigest);
    if (!files) {
      const empty = new Map<string, string>();
      this.snapshots.set(this.currentRevisionDigest, empty);
      return empty;
    }
    return files;
  }

  async listDir(dirPath: string): Promise<readonly string[]> {
    this.listSpy.push(dirPath);

    // Root listing can be empty string or '.'
    const normalized = dirPath === '' || dirPath === '.' ? '' : dirPath;
    if (normalized.length > 0) {
      if (!isCanonicalRelativePath(normalized)) {
        throw new Error(
          `WORKSPACE_ESCAPE: Path '${dirPath}' is not a canonical relative path`
        );
      }
      if (isProtectedPath(normalized)) {
        throw new Error(
          `PROTECTED_PATH_FORBIDDEN: Path '${dirPath}' is protected and cannot be listed`
        );
      }
    }

    const files = this.getCurrentFiles();
    const prefix = normalized.length > 0 ? `${normalized}/` : '';
    const entries = new Set<string>();

    for (const filePath of files.keys()) {
      if (isProtectedPath(filePath)) continue;
      if (prefix.length === 0) {
        const seg = filePath.split('/')[0];
        if (seg) entries.add(seg);
      } else if (filePath.startsWith(prefix)) {
        const rest = filePath.slice(prefix.length);
        const seg = rest.split('/')[0];
        if (seg) entries.add(seg);
      }
    }

    return Array.from(entries).sort();
  }

  async readFile(filePath: string): Promise<SourceEvidence> {
    this.readSpy.push(filePath);

    if (!isCanonicalRelativePath(filePath)) {
      throw new Error(
        `WORKSPACE_ESCAPE: Path '${filePath}' must be a canonical relative path`
      );
    }
    if (isProtectedPath(filePath)) {
      throw new Error(
        `PROTECTED_PATH_FORBIDDEN: Path '${filePath}' is protected and cannot be read`
      );
    }

    const files = this.getCurrentFiles();
    const content = files.get(filePath);
    if (content === undefined) {
      throw new Error(`FILE_NOT_FOUND: Path '${filePath}' does not exist in repository snapshot`);
    }

    const evidence: SourceEvidence = {
      path: filePath,
      revisionDigest: this.currentRevisionDigest,
      boundedExcerpt: content,
      resultCount: 1,
      truncated: false,
    };

    const valid = validateSourceEvidence(evidence);
    if (!valid.ok) {
      throw new Error(
        `INVALID_SOURCE_EVIDENCE: ${valid.errors.map((e) => e.message).join('; ')}`
      );
    }

    return valid.value;
  }

  async searchCode(query: string): Promise<readonly SourceEvidence[]> {
    this.searchSpy.push(query);

    const files = this.getCurrentFiles();
    const results: SourceEvidence[] = [];

    for (const [filePath, content] of files.entries()) {
      if (isProtectedPath(filePath)) continue;
      if (content.includes(query)) {
        const evidence: SourceEvidence = {
          path: filePath,
          revisionDigest: this.currentRevisionDigest,
          boundedExcerpt: content,
          resultCount: 1,
          truncated: false,
        };
        const valid = validateSourceEvidence(evidence);
        if (valid.ok) {
          results.push(valid.value);
        }
      }
    }

    return results;
  }

  private async applyPatchInternal(
    patch: ApplyPatchAction
  ): Promise<{ readonly applied: boolean; readonly newRevisionDigest: string }> {
    const validation = validateNormalizedAction(patch);
    if (!validation.ok) {
      throw new Error(
        `INVALID_PATCH_ACTION: ${validation.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`
      );
    }

    // Base revision check
    if (patch.baseRevisionDigest !== this.currentRevisionDigest) {
      return {
        applied: false,
        newRevisionDigest: this.currentRevisionDigest,
      };
    }

    // Target path check: must not target protected files
    for (const target of patch.targetPaths) {
      if (!isCanonicalRelativePath(target)) {
        throw new Error(`WORKSPACE_ESCAPE: Target path '${target}' is not canonical`);
      }
      if (isProtectedPath(target)) {
        throw new Error(`PROTECTED_PATH_FORBIDDEN: Target path '${target}' is protected`);
      }
    }

    // Clone current snapshot to new snapshot
    const currentFiles = this.getCurrentFiles();
    const newFiles = new Map<string, string>(currentFiles);

    // Apply simple replacement if target is known or append patchContent marker
    for (const target of patch.targetPaths) {
      const existing = newFiles.get(target) ?? '';
      newFiles.set(target, `${existing}\n# patch:${patch.actionId}\n${patch.patchContent}`);
    }

    const newRev = computeCanonicalSha256({
      priorRevision: this.currentRevisionDigest,
      patchActionId: patch.actionId,
      patchDigest: computeCanonicalSha256(patch.patchContent),
    });

    this.snapshots.set(newRev, newFiles);
    this.currentRevisionDigest = newRev;

    return {
      applied: true,
      newRevisionDigest: newRev,
    };
  }

  applyPatch(patch: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
  applyPatch(patch: ApplyPatchAction): ReturnType<RepositoryPort['applyPatch']>;
  async applyPatch(
    patch: ApplyPatchAction,
    context?: RepositoryAdmissionContextV02
  ): Promise<RepositoryPatchResultV02 | { readonly applied: boolean; readonly newRevisionDigest: string }> {
    this.patchSpy.push(patch);

    const effectiveContext = context ?? this.defaultAdmissionContext;
    if (effectiveContext !== undefined) {
      // v0.2 validation
      if (
        !effectiveContext ||
        typeof effectiveContext !== 'object' ||
        effectiveContext.schemaVersion !== '0.2.0' ||
        effectiveContext.subjectKind !== 'repository-action'
      ) {
        throw new Error('REPOSITORY_ADMISSION_REFUSED');
      }
      if (effectiveContext.policyEvaluationReceipt?.result === 'FORBIDDEN') {
        throw new Error('REPOSITORY_ADMISSION_REFUSED');
      }
      if (effectiveContext.canonicalRevision !== this.currentRevisionDigest) {
        throw new Error('REPOSITORY_ADMISSION_REFUSED');
      }
      if (!this.statePort || !this.executorIdentity) throw new Error('STATE_PORT_REQUIRED');
      const { claim, attempt } = await beginRepositoryAttemptWithClaim(
        this.statePort, effectiveContext, this.executorIdentity,
        effectiveContext.action.kind === 'apply_patch' && effectiveContext.runnableNode === 'Repair', () => undefined,
      );
      const outcome = await this.applyPatchInternal(patch);

      let outcomeReceipt: AttemptOutcomeReceiptV02 | undefined;
      let settlement: OutcomeRecordResultV02 | undefined;
      if (this.statePort && claim && attempt) {
        const receipt = createTestRepositoryOutcomeReceiptV02(claim, attempt, effectiveContext, {
          receiptId: `repository-outcome-${attempt.attemptId}`,
          ...(outcome.applied
            ? { observedResultRevisionDigest: outcome.newRevisionDigest }
            : { outcome: 'uncertain' }),
        });
        const rawReceipt = outcome.applied
          ? {
              ...receipt,
              proposedEffects: {
                ...receipt.proposedEffects,
                revision: { kind: 'advance' as const, revisionDigest: outcome.newRevisionDigest },
              },
            }
          : receipt;
        outcomeReceipt = {
          ...rawReceipt,
          receiptDigest: computeAttemptOutcomeDigest(rawReceipt),
        };
        settlement = validateOutcomeRecordResult(await this.statePort.recordOutcome(outcomeReceipt), outcomeReceipt.receiptId);
      }

      if (!outcomeReceipt || outcomeReceipt.subjectKind !== 'repository-action' || outcomeReceipt.outcome !== 'observed' ||
        !settlement || settlement.outcome !== 'settled' || settlement.receiptId !== outcomeReceipt.receiptId) {
        throw new Error('REPOSITORY_OUTCOME_PENDING');
      }
      const executionResult = { ...outcome, executionReceipt: { claim, attempt, outcome: outcomeReceipt,
        settlement: settlement as OutcomeRecordResultV02 & { readonly outcome: 'settled' } } };

      this.v02CallLog.push({
        action: 'applyPatch',
        context: effectiveContext,
        claimId: claim?.claimId,
        attemptId: attempt?.attemptId,
        claim,
        attempt,
        outcomeReceipt,
        outcome: executionResult,
      });

      return executionResult;
    }

    return this.applyPatchInternal(patch);
  }

  private async runCommandInternal(
    action: RunCommandAction
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
    const validation = validateNormalizedAction(action);
    if (!validation.ok) {
      throw new Error(
        `INVALID_COMMAND_ACTION: ${validation.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`
      );
    }

    // Check scripted responses by exact command key or executable
    const fullKey = `${action.executable} ${action.argv.join(' ')}`;
    const scripted =
      this.commandResponses.get(fullKey) ??
      this.commandResponses.get(action.executable) ??
      this.commandResponses.get('default');

    if (scripted) {
      return scripted;
    }

    throw new Error('SCRIPT_EXHAUSTED: No scripted command response');
  }

  runCommand(action: RunCommandAction, context: RepositoryAdmissionContextV02): Promise<RepositoryCommandResultV02>;
  runCommand(action: RunCommandAction): ReturnType<RepositoryPort['runCommand']>;
  async runCommand(
    action: RunCommandAction,
    context?: RepositoryAdmissionContextV02
  ): Promise<RepositoryCommandResultV02 | { readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
    this.commandSpy.push(action);

    const effectiveContext = context ?? this.defaultAdmissionContext;
    if (effectiveContext !== undefined) {
      if (
        !effectiveContext ||
        typeof effectiveContext !== 'object' ||
        effectiveContext.schemaVersion !== '0.2.0' ||
        effectiveContext.subjectKind !== 'repository-action'
      ) {
        throw new Error('INVALID_ADMISSION_CONTEXT');
      }
      if (effectiveContext.policyEvaluationReceipt?.result === 'FORBIDDEN') {
        throw new Error('FORBIDDEN_POLICY');
      }

      const fullKey = `${action.executable} ${action.argv.join(' ')}`;
      const scripted =
        this.commandResponses.get(fullKey) ??
        this.commandResponses.get(action.executable) ??
        this.commandResponses.get('default');
      if (!scripted) {
        throw new Error('SCRIPT_EXHAUSTED: No scripted command response');
      }

      if (!this.statePort || !this.executorIdentity) throw new Error('STATE_PORT_REQUIRED');
      const { claim, attempt } = await beginRepositoryAttemptWithClaim(
        this.statePort, effectiveContext, this.executorIdentity,
        effectiveContext.action.kind === 'apply_patch' && effectiveContext.runnableNode === 'Repair', () => undefined,
      );
      const scriptedResult = await this.runCommandInternal(action);
      const outcome = { ...scriptedResult, plan: {}, durationMs: 0, timedOut: false,
        outcome: scriptedResult.exitCode === 0 ? 'success' as const : 'failure' as const, truncated: false };

      let outcomeReceipt: AttemptOutcomeReceiptV02 | undefined;
      let settlement: OutcomeRecordResultV02 | undefined;
      if (this.statePort && claim && attempt) {
        const normalized = normalizeCommandResult(outcome);
        if (!normalized) throw new Error('INVALID_COMMAND_RESULT');
        outcomeReceipt = createCommandOutcomeReceipt(claim, attempt, effectiveContext, 'observed', normalized);
        settlement = validateOutcomeRecordResult(await this.statePort.recordOutcome(outcomeReceipt), outcomeReceipt.receiptId);
      }

      if (!outcomeReceipt || outcomeReceipt.subjectKind !== 'repository-action' || outcomeReceipt.outcome !== 'observed' ||
        !settlement || settlement.outcome !== 'settled' || settlement.receiptId !== outcomeReceipt.receiptId) {
        throw new Error('REPOSITORY_OUTCOME_PENDING');
      }
      const executionResult = { ...outcome, executionReceipt: { claim, attempt, outcome: outcomeReceipt,
        settlement: settlement as OutcomeRecordResultV02 & { readonly outcome: 'settled' } } };

      this.v02CallLog.push({
        action: 'runCommand',
        context: effectiveContext,
        claimId: claim?.claimId,
        attemptId: attempt?.attemptId,
        claim,
        attempt,
        outcomeReceipt,
        outcome: executionResult,
      });

      return executionResult;
    }

    return this.runCommandInternal(action);
  }

  private async runTestsInternal(check: CheckDefinition): Promise<CheckResult> {
    const validationErrors: ValidationError[] = [];
    const valid = validateCheckDefinition(check, 'check', validationErrors);
    if (!valid) {
      throw new Error('INVALID_CHECK_DEFINITION: check failed validation');
    }

    const scripted =
      this.testResponses.get(check.checkId) ??
      this.testResponses.get('default');

    if (scripted) {
      const checked = validateCheckResult(scripted);
      if (checked.ok) return checked.value;
      throw new Error(
        `INVALID_CHECK_RESULT: ${checked.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`
      );
    }

    throw new Error('SCRIPT_EXHAUSTED: No scripted check response');
  }

  async runTests(
    check: CheckDefinition,
    context?: RepositoryAdmissionContextV02
  ): Promise<CheckResult> {
    this.testSpy.push(check);

    const effectiveContext = context ?? this.defaultAdmissionContext;
    if (effectiveContext !== undefined) {
      if (
        !effectiveContext ||
        typeof effectiveContext !== 'object' ||
        effectiveContext.schemaVersion !== '0.2.0' ||
        effectiveContext.subjectKind !== 'repository-action'
      ) {
        return {
          checkId: check.checkId,
          outcome: 'fail',
          outputExcerpt: 'INVALID_ADMISSION_CONTEXT',
          durationMs: 0,
        };
      }
      if (effectiveContext.policyEvaluationReceipt?.result === 'FORBIDDEN') {
        return {
          checkId: check.checkId,
          outcome: 'fail',
          outputExcerpt: 'FORBIDDEN_POLICY',
          durationMs: 0,
        };
      }

      const scripted =
        this.testResponses.get(check.checkId) ??
        this.testResponses.get('default');
      if (!scripted) {
        throw new Error('SCRIPT_EXHAUSTED: No scripted check response');
      }

      if (!this.statePort || !this.executorIdentity) throw new Error('STATE_PORT_REQUIRED');
      let claim: ClaimReceiptV02 | undefined;
      let attempt: AttemptReceiptV02 | undefined;
      if (this.statePort) {
        if (!this.executorIdentity) {
          return { checkId: check.checkId, outcome: 'fail', outputExcerpt: 'MISSING_EXECUTOR_IDENTITY', durationMs: 0 };
        }
        claim = await this.statePort.claim(effectiveContext);
        if (!claim.claimId || claim.taskId !== effectiveContext.taskId || claim.runId !== effectiveContext.runId) {
          return { checkId: check.checkId, outcome: 'fail', outputExcerpt: 'ADMISSION_CLAIM_REFUSED', durationMs: 0 };
        }
        attempt = await this.statePort.beginAttempt(claim.claimId, this.executorIdentity);
        if (!attempt.attemptId || attempt.claimId !== claim.claimId) {
          return { checkId: check.checkId, outcome: 'fail', outputExcerpt: 'ADMISSION_ATTEMPT_REFUSED', durationMs: 0 };
        }
      }

      const outcome = await this.runTestsInternal(check);

      let outcomeReceipt: AttemptOutcomeReceiptV02 | undefined;
      if (this.statePort && claim && attempt) {
        outcomeReceipt = createTestRepositoryOutcomeReceiptV02(claim, attempt, effectiveContext, {
          receiptId: `repository-outcome-${attempt.attemptId}`,
        });
        const recorded = validateOutcomeRecordResult(await this.statePort.recordOutcome(outcomeReceipt), outcomeReceipt.receiptId);
        if (recorded.outcome !== 'settled' || recorded.receiptId !== outcomeReceipt.receiptId) throw new Error('REPOSITORY_OUTCOME_PENDING');
      }

      this.v02CallLog.push({
        action: 'runTests',
        context: effectiveContext,
        claimId: claim?.claimId,
        attemptId: attempt?.attemptId,
        claim,
        attempt,
        outcomeReceipt,
        outcome,
      });

      return outcome;
    }

    return this.runTestsInternal(check);
  }

  async inspectDiff(
    baseRevisionDigest: string
  ): Promise<{ readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] }> {
    const scripted = this.diffResponses.get(baseRevisionDigest);
    if (scripted) {
      return scripted;
    }

    const baseFiles = this.snapshots.get(baseRevisionDigest) ?? new Map<string, string>();
    const currentFiles = this.getCurrentFiles();

    const changedFiles: string[] = [];
    let diff = '';

    for (const [path, content] of currentFiles.entries()) {
      const baseContent = baseFiles.get(path);
      if (baseContent !== content) {
        changedFiles.push(path);
        diff += `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${baseContent ?? ''}\n+${content}\n`;
      }
    }

    const diffDigest = computeCanonicalSha256(diff);

    return {
      diff,
      diffDigest,
      changedFiles,
    };
  }
}

export class FakeRepositoryPortV02 implements RepositoryPortV02 {
  readonly provenance: PortProvenance = 'mock';
  readonly executionGuardApiVersion = '0.2.0' as const;
  private readonly underlying: FakeRepositoryPort;

  constructor(underlying: FakeRepositoryPort) {
    this.underlying = underlying;
  }

  get currentRevision(): string {
    return this.underlying.currentRevision;
  }

  get commands(): readonly RunCommandAction[] {
    return this.underlying.commands;
  }

  get tests(): readonly CheckDefinition[] {
    return this.underlying.tests;
  }

  get patches(): readonly ApplyPatchAction[] {
    return this.underlying.patches;
  }

  get reads(): readonly string[] {
    return this.underlying.reads;
  }

  get searches(): readonly string[] {
    return this.underlying.searches;
  }

  get lists(): readonly string[] {
    return this.underlying.lists;
  }

  get v02Calls(): readonly FakeRepositoryV02CallRecord[] {
    return this.underlying.v02Calls;
  }

  private admits(action: ApplyPatchAction | RunCommandAction, context: RepositoryAdmissionContextV02): boolean {
    try {
      const trusted = createTestRepositoryAdmissionTrustedContextV02(context);
      const validation = validateRepositoryAdmissionV02(context, {
        ...trusted,
        canonicalRevision: this.currentRevision,
      });
      return validation.ok && computeActionDigest(action) === context.actionDigest;
    } catch {
      return false;
    }
  }

  listDir(path: string): Promise<readonly string[]> {
    return this.underlying.listDir(path);
  }

  readFile(path: string): Promise<SourceEvidence> {
    return this.underlying.readFile(path);
  }

  searchCode(query: string): Promise<readonly SourceEvidence[]> {
    return this.underlying.searchCode(query);
  }

  applyPatch(
    patch: ApplyPatchAction,
    context: RepositoryAdmissionContextV02
  ): Promise<RepositoryPatchResultV02> {
    if (!context || !this.admits(patch, context)) {
      return Promise.reject(new Error('INVALID_ADMISSION_CONTEXT'));
    }
    return this.underlying.applyPatch(patch, context);
  }

  runCommand(
    action: RunCommandAction,
    context: RepositoryAdmissionContextV02
  ): Promise<RepositoryCommandResultV02> {
    if (!context || !this.admits(action, context)) {
      return Promise.reject(new Error(context ? 'INVALID_ADMISSION_CONTEXT' : 'MISSING_ADMISSION_CONTEXT'));
    }
    return this.underlying.runCommand(action, context);
  }

  runTests(
    check: CheckDefinition,
    context: RepositoryAdmissionContextV02
  ): Promise<CheckResult> {
    if (!context || !check.workingDirectory || context.checkId !== check.checkId ||
      !this.admits({
        actionId: check.checkId,
        kind: 'run_command',
        executable: check.executable,
        argv: check.argv,
        workingDirectory: check.workingDirectory,
        ...(check.purpose !== undefined ? { purpose: check.purpose } : {}),
      }, context)) {
      return Promise.resolve({
        checkId: check.checkId,
        outcome: 'fail',
        outputExcerpt: context ? 'INVALID_ADMISSION_CONTEXT' : 'MISSING_ADMISSION_CONTEXT',
        durationMs: 0,
      });
    }
    return this.underlying.runTests(check, context);
  }

  inspectDiff(
    baseRevisionDigest: string
  ): Promise<{ readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] }> {
    return this.underlying.inspectDiff(baseRevisionDigest);
  }
}
