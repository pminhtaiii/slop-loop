import {
  type ApprovalPort,
  type NormalizedAction,
  type PermissionClass,
  type ApprovalBinding,
  type ApprovalBindingContext,
  type PortProvenance,
  validateNormalizedAction,
  computeCanonicalSha256,
  parseApprovalBinding,
  validateApprovalBinding,
} from '../../../../src/contracts/uc03.ts';

export interface ScriptedApprovalPortOptions {
  readonly classifications?: Readonly<Record<string, PermissionClass>> | undefined;
  readonly decisions?: readonly ApprovalBinding[] | undefined;
  readonly currentContext?: ApprovalBindingContext | undefined;
}

export class ScriptedApprovalPort implements ApprovalPort {
  readonly provenance: PortProvenance = 'mock';

  private readonly attemptedActions: NormalizedAction[] = [];
  private readonly recordedBindings: ApprovalBinding[] = [];
  private readonly scriptedDecisions = new Map<string, ApprovalBinding>();
  private readonly classifications = new Map<string, PermissionClass>();
  private readonly forbiddenDigests = new Set<string>();
  private readonly rejectedDecisions = new Set<string>();
  private readonly defaultContext?: ApprovalBindingContext | undefined;

  constructor(options?: ScriptedApprovalPortOptions) {
    if (options?.classifications) {
      for (const [key, perm] of Object.entries(options.classifications)) {
        this.classifications.set(key, perm);
      }
    }

    if (options?.decisions) {
      for (const d of options.decisions) {
        const parsed = parseApprovalBinding(d);
        if (!parsed.ok) {
          throw new Error(`Invalid initial decision: ${parsed.errors.map((e) => e.message).join(', ')}`);
        }
        const prior = this.scriptedDecisions.get(parsed.value.decisionId);
        if (prior) throw new Error('Duplicate decision identity');
        this.scriptedDecisions.set(parsed.value.decisionId, structuredClone(parsed.value));
        if (parsed.value.status === 'rejected') {
          this.rejectedDecisions.add(parsed.value.decisionId);
        }
      }
    }

    if (options?.currentContext) {
      this.defaultContext = structuredClone(options.currentContext);
    }
  }

  getAttemptedActions(): readonly NormalizedAction[] {
    return this.attemptedActions.map((a) => structuredClone(a));
  }

  getRecordedBindings(): readonly ApprovalBinding[] {
    return this.recordedBindings.map((b) => structuredClone(b));
  }

  scriptDecision(binding: ApprovalBinding): void {
    const parsed = parseApprovalBinding(binding);
    if (!parsed.ok) {
      throw new Error(`Invalid scripted decision: ${parsed.errors.map((e) => e.message).join(', ')}`);
    }
    const prior = this.scriptedDecisions.get(parsed.value.decisionId);
    if (prior && !this.sameIdentity(prior, parsed.value)) throw new Error('Conflicting decision identity');
    this.scriptedDecisions.set(parsed.value.decisionId, structuredClone(parsed.value));
    if (parsed.value.status === 'approved') {
      this.rejectedDecisions.delete(parsed.value.decisionId);
    } else if (parsed.value.status === 'rejected') {
      this.rejectedDecisions.add(parsed.value.decisionId);
    }
  }

  async classify(action: NormalizedAction): Promise<PermissionClass> {
    const val = validateNormalizedAction(action);
    if (!val.ok) {
      throw new Error(`Invalid action for classification: ${val.errors.map((e) => e.message).join(', ')}`);
    }
    const validated = val.value;
    this.attemptedActions.push(structuredClone(validated));

    const cmdKey =
      validated.kind === 'run_command'
        ? `${validated.executable} ${validated.argv.join(' ')}`
        : validated.actionId;

    const byCmd = this.classifications.get(cmdKey);
    if (byCmd !== undefined) {
      if (byCmd === 'FORBIDDEN') this.forbiddenDigests.add(computeCanonicalSha256(validated));
      return byCmd;
    }
    const byAction = this.classifications.get(validated.actionId);
    if (byAction !== undefined) {
      if (byAction === 'FORBIDDEN') this.forbiddenDigests.add(computeCanonicalSha256(validated));
      return byAction;
    }
    const byKind = this.classifications.get(validated.kind);
    if (byKind !== undefined) {
      if (byKind === 'FORBIDDEN') this.forbiddenDigests.add(computeCanonicalSha256(validated));
      return byKind;
    }

    // Explicit non-autoapprove: unscripted actions require approval
    return 'APPROVAL_REQUIRED';
  }

  async requestDecision(binding: ApprovalBinding): Promise<ApprovalBinding> {
    const parsed = parseApprovalBinding(binding);
    if (!parsed.ok) {
      throw new Error(`Invalid approval binding: ${parsed.errors.map((e) => e.message).join(', ')}`);
    }

    const recorded = structuredClone(parsed.value);
    this.recordedBindings.push(recorded);

    const scripted = this.scriptedDecisions.get(recorded.decisionId);
    if (!scripted || !this.sameIdentity(scripted, recorded)) throw new Error('Unscripted or conflicting decision identity');
    if (this.forbiddenDigests.has(scripted.normalizedActionDigest)) throw new Error('Forbidden action');
    const result = structuredClone(scripted);

    if (result.status === 'rejected') {
      this.rejectedDecisions.add(result.decisionId);
    }
    return structuredClone(result);
  }

  async validateBinding(binding: ApprovalBinding, context?: ApprovalBindingContext): Promise<boolean> {
    const scripted = this.scriptedDecisions.get(binding.decisionId);
    if (!scripted || computeCanonicalSha256(scripted) !== computeCanonicalSha256(binding) || this.forbiddenDigests.has(binding.normalizedActionDigest)) return false;
    // Rejection cannot become approval without scripted human/test input
    if (this.rejectedDecisions.has(binding.decisionId) && binding.status === 'approved') {
      const scripted = this.scriptedDecisions.get(binding.decisionId);
      if (!scripted || scripted.status !== 'approved') {
        return false;
      }
    }

    const ctx = context ?? this.defaultContext;
    const res = validateApprovalBinding(binding, ctx);
    if (!res.ok) {
      return false;
    }
    return res.value.status === 'approved';
  }

  private sameIdentity(a: ApprovalBinding, b: ApprovalBinding): boolean {
    const ai = Object.fromEntries(Object.entries(a).filter(([key]) => key !== 'status' && key !== 'reason'));
    const bi = Object.fromEntries(Object.entries(b).filter(([key]) => key !== 'status' && key !== 'reason'));
    return computeCanonicalSha256(ai) === computeCanonicalSha256(bi);
  }

  async resolve(decisionId: string): Promise<ApprovalBinding> {
    const decision = this.scriptedDecisions.get(decisionId);
    if (!decision) {
      throw new Error(`No decision found for decisionId: ${decisionId}`);
    }
    const parsed = parseApprovalBinding(decision);
    if (!parsed.ok) {
      throw new Error(`Invalid resolved binding: ${parsed.errors.map((e) => e.message).join(', ')}`);
    }
    return structuredClone(parsed.value);
  }
}
