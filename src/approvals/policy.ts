import type { ApprovalBinding, ApprovalBindingContext, PermissionClass } from '../contracts/foundation/uc03.ts';
import { computeActionDigest, validateApprovalBinding, validateNormalizedAction } from '../contracts/foundation/uc03.ts';
import type { PolicyIdentity, PolicyProfile } from '../contracts/approvals/contracts.ts';
import { validatePolicyProfile } from '../contracts/approvals/contracts.ts';
import { containsProtectedContent } from '../foundation/repository-tools.ts';

/** Host-owned admitted facts, never model-provided assertions of safety. */
export interface PolicyFacts {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly repositoryRevisionDigest: string;
  readonly policyIdentity: PolicyIdentity;
  readonly registeredActionDigest: string;
  readonly continuationRef: string;
  readonly role: 'coder' | 'reviewer';
  readonly safety: {
    readonly workspaceContained: boolean;
    readonly protectedContentAbsent: boolean;
    readonly hiddenGradingAbsent: boolean;
    readonly policyBypassAbsent: boolean;
    readonly testsPreserved: boolean;
    readonly commandSourceWritesAbsent: boolean;
    readonly isolated: boolean;
  };
  readonly patch: null | {
    readonly fileCount: number;
    readonly addedDeletedLines: number;
    readonly dependencyChange: boolean;
    readonly deletion: boolean;
    readonly structuralChange: boolean;
    readonly sensitiveConfiguration: boolean;
    readonly productionCode: boolean;
  };
  readonly command: null | {
    readonly executableRef: string;
    readonly resolvedExecutable: string;
    readonly workingDirectoryRef: string;
    readonly workingDirectory: string;
    readonly constrainedCapability: string | null;
  };
  readonly plan: null | {
    readonly binding: ApprovalBinding;
    readonly context: ApprovalBindingContext;
    readonly materialChange: boolean;
    readonly replanSlot: number | null;
  };
}

export type PolicyClassification =
  | { readonly ok: true; readonly permission: PermissionClass; readonly reasonCode: string; readonly actionDigest: string }
  | { readonly ok: false; readonly outcome: 'invalid' | 'prerequisite-denied' | 'unsupported'; readonly reasonCode: string };

export interface CompiledPolicy {
  readonly profile: PolicyProfile;
  classify(actionInput: unknown, factsInput: unknown): PolicyClassification;
}

const FACT_KEYS = ['taskId', 'workspaceId', 'repositoryId', 'repositoryRevisionDigest', 'policyIdentity', 'registeredActionDigest', 'continuationRef', 'role', 'safety', 'patch', 'command', 'plan'];
const SAFETY_KEYS = ['workspaceContained', 'protectedContentAbsent', 'hiddenGradingAbsent', 'policyBypassAbsent', 'testsPreserved', 'commandSourceWritesAbsent', 'isolated'];
const PATCH_KEYS = ['fileCount', 'addedDeletedLines', 'dependencyChange', 'deletion', 'structuralChange', 'sensitiveConfiguration', 'productionCode'];
const COMMAND_KEYS = ['executableRef', 'resolvedExecutable', 'workingDirectoryRef', 'workingDirectory', 'constrainedCapability'];
const IDENTITY_KEYS = ['policyId', 'policyVersion', 'configId', 'configVersion'];
const PLAN_CONTEXT_KEYS = ['currentTaskId', 'currentWorkspaceId', 'currentRepositoryRevisionDigest', 'currentPolicyId', 'currentPolicyVersion', 'currentNormalizedActionDigest', 'currentPlanVersion', 'currentStrategyDigest', 'currentBaselineRef', 'currentEvidenceRefs', 'currentCriteriaDigest', 'currentCheckSetDigest'];
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/.test(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);

/** Reject accessors, exotic objects, sparse arrays and deep/cyclic or oversized structures before reading them. */
function isData(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 1024) return false;
  if (Array.isArray(value) && (value.length > 1024 || keys.length !== value.length + 1)) return false;
  if (Array.isArray(value) && Array.from({ length: value.length }, (_, index) => String(index)).some(key => !Object.hasOwn(descriptors, key))) return false;
  return keys.every(key => {
    if (Array.isArray(value) && key === 'length') return true;
    const descriptor = typeof key === 'string' ? descriptors[key] : undefined;
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor && isData(descriptor.value, depth + 1);
  });
}

/** Require exactly the named data properties; callers first validate the entire value with isData. */
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Turn exotic input traps into a typed denial without invoking input accessors. */
function boundedData(value: unknown, maxBytes: number): boolean {
  try {
    return isData(value) && Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes;
  } catch {
    return false;
  }
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function validFacts(input: unknown): input is PolicyFacts {
  if (!isData(input) || !record(input, FACT_KEYS)) return false;
  if (!['taskId', 'workspaceId', 'repositoryId', 'continuationRef'].every(key => id(input[key])) ||
    !sha(input['repositoryRevisionDigest']) || !sha(input['registeredActionDigest']) ||
    (input['role'] !== 'coder' && input['role'] !== 'reviewer')) return false;
  if (!record(input['policyIdentity'], IDENTITY_KEYS) || !Object.values(input['policyIdentity']).every(id)) return false;
  if (!record(input['safety'], SAFETY_KEYS) || !Object.values(input['safety']).every(value => typeof value === 'boolean')) return false;
  const patch = input['patch'];
  if (patch !== null && (!record(patch, PATCH_KEYS) ||
    !['fileCount', 'addedDeletedLines'].every(key => typeof patch[key] === 'number' && Number.isSafeInteger(patch[key]) && Number(patch[key]) >= 0) ||
    !PATCH_KEYS.slice(2).every(key => typeof patch[key] === 'boolean'))) return false;
  const command = input['command'];
  if (command !== null && (!record(command, COMMAND_KEYS) ||
    !id(command['executableRef']) || !id(command['workingDirectoryRef']) ||
    !['resolvedExecutable', 'workingDirectory'].every(key => typeof command[key] === 'string' && String(command[key]).length > 0) ||
    !(command['constrainedCapability'] === null || id(command['constrainedCapability'])))) return false;
  const plan = input['plan'];
  return plan === null || (record(plan, ['binding', 'context', 'materialChange', 'replanSlot']) &&
    typeof plan['materialChange'] === 'boolean' &&
    (plan['replanSlot'] === null || (typeof plan['replanSlot'] === 'number' && Number.isSafeInteger(plan['replanSlot']) && plan['replanSlot'] > 0)) &&
    record(plan['context'], PLAN_CONTEXT_KEYS));
}

/** Compile only explicit finite fixture configuration; classification never dispatches effects. */
export function compilePolicy(profileInput: unknown):
  | { readonly ok: true; readonly value: CompiledPolicy }
  | { readonly ok: false; readonly reasonCode: 'invalid-profile' } {
  if (!boundedData(profileInput, 65_536)) return { ok: false, reasonCode: 'invalid-profile' };
  const parsed = validatePolicyProfile(profileInput);
  if (!parsed.ok) return { ok: false, reasonCode: 'invalid-profile' };
  const profile = freeze(structuredClone(parsed.value));
  return { ok: true, value: {
    profile,
    classify(actionInput: unknown, factsInput: unknown): PolicyClassification {
      if (!boundedData(actionInput, profile.maxActionBytes) || !boundedData(factsInput, profile.maxActionBytes)) {
        return { ok: false, outcome: 'invalid', reasonCode: 'invalid-or-over-bound-input' };
      }
      const action = validateNormalizedAction(actionInput);
      if (!action.ok) {
        if (action.errors.some(error => ['WORKSPACE_ESCAPE', 'PROTECTED_PATH_FORBIDDEN', 'FORBIDDEN_SHELL_CHARACTERS'].includes(error.code))) {
          return { ok: false, outcome: 'prerequisite-denied', reasonCode: 'forbidden-action-input' };
        }
        return { ok: false, outcome: 'invalid', reasonCode: 'invalid-action' };
      }
      if (!profile.supportedActionKinds.includes(action.value.kind)) return { ok: false, outcome: 'unsupported', reasonCode: 'unsupported-action' };
      if (!validFacts(factsInput)) return { ok: false, outcome: 'invalid', reasonCode: 'invalid-trusted-facts' };
      if (action.value.kind === 'approve_fix_plan' && (factsInput.command !== null || factsInput.patch !== null)) return { ok: false, outcome: 'invalid', reasonCode: 'invalid-trusted-facts' };
      if (factsInput.registeredActionDigest !== computeActionDigest(action.value) ||
        IDENTITY_KEYS.some(key => factsInput.policyIdentity[key as keyof PolicyIdentity] !== profile.policyIdentity[key as keyof PolicyIdentity])) {
        return { ok: false, outcome: 'prerequisite-denied', reasonCode: 'unbound-trusted-facts' };
      }
      if (SAFETY_KEYS.filter(key => key !== 'isolated').some(key => !factsInput.safety[key as keyof PolicyFacts['safety']]) || factsInput.role === 'reviewer') {
        return { ok: true, permission: 'FORBIDDEN', reasonCode: 'hard-boundary', actionDigest: computeActionDigest(action.value) };
      }
      if (!factsInput.safety.isolated) return { ok: false, outcome: 'prerequisite-denied', reasonCode: 'missing-isolation' };
      if (containsProtectedContent(JSON.stringify(action.value))) {
        return { ok: true, permission: 'FORBIDDEN', reasonCode: 'protected-content', actionDigest: computeActionDigest(action.value) };
      }
      if (factsInput.plan?.materialChange && (factsInput.plan.replanSlot === null || factsInput.plan.replanSlot > 3)) {
        return { ok: false, outcome: 'prerequisite-denied', reasonCode: 'material-replan-allowance' };
      }
      if (action.value.kind === 'approve_fix_plan') return { ok: true, permission: 'APPROVAL_REQUIRED', reasonCode: 'fix-plan-decision', actionDigest: computeActionDigest(action.value) };
      if (action.value.kind === 'apply_patch') {
        if (factsInput.patch === null || factsInput.command !== null) return { ok: false, outcome: 'invalid', reasonCode: 'invalid-trusted-facts' };
        if (factsInput.patch.fileCount < new Set(action.value.targetPaths).size) return { ok: false, outcome: 'invalid', reasonCode: 'incomplete-patch-facts' };
        if (action.value.baseRevisionDigest !== factsInput.repositoryRevisionDigest) return { ok: false, outcome: 'prerequisite-denied', reasonCode: 'repository-drift' };
        if (factsInput.patch.productionCode) {
          const plan = factsInput.plan;
          if (plan === null || !validateApprovalBinding(plan.binding, plan.context).ok || plan.binding.status !== 'approved' || plan.binding.actionKind !== 'fix_plan' ||
            plan.context.currentTaskId !== factsInput.taskId || plan.context.currentWorkspaceId !== factsInput.workspaceId ||
            plan.context.currentRepositoryRevisionDigest !== factsInput.repositoryRevisionDigest ||
            plan.context.currentPolicyId !== factsInput.policyIdentity.policyId || plan.context.currentPolicyVersion !== factsInput.policyIdentity.policyVersion) {
            return { ok: false, outcome: 'prerequisite-denied', reasonCode: 'fix-plan-required' };
          }
          if (plan.materialChange && (plan.replanSlot === null || plan.replanSlot > 3)) return { ok: false, outcome: 'prerequisite-denied', reasonCode: 'material-replan-allowance' };
        }
        const patch = factsInput.patch;
        if (patch.dependencyChange || patch.deletion || patch.structuralChange || patch.sensitiveConfiguration ||
          patch.fileCount > profile.patchBreadth.maxFiles || patch.addedDeletedLines > profile.patchBreadth.maxAddedDeletedLines ||
          action.value.targetPaths.some(path => profile.sensitivePaths.some(sensitive => path === sensitive || path.startsWith(`${sensitive}/`)))) {
          return { ok: true, permission: 'APPROVAL_REQUIRED', reasonCode: 'risky-patch', actionDigest: computeActionDigest(action.value) };
        }
        return { ok: true, permission: 'ALLOWED', reasonCode: 'ordinary-patch', actionDigest: computeActionDigest(action.value) };
      }
      if (action.value.kind === 'run_command') {
        if (action.value.argv.length > profile.maxArgvEntries || action.value.argv.some(token => Buffer.byteLength(token, 'utf8') > profile.maxArgvEntryBytes)) {
          return { ok: false, outcome: 'invalid', reasonCode: 'argv-over-bound' };
        }
        const command = factsInput.command;
        if (command === null || factsInput.patch !== null || command.resolvedExecutable !== action.value.executable || command.workingDirectory !== action.value.workingDirectory) {
          return { ok: false, outcome: 'invalid', reasonCode: 'invalid-command-facts' };
        }
        // The draft profile has no suffix grammar: its configured tuple is the complete accepted argv.
        const argv = action.value.argv;
        const executableName = action.value.executable.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, '').toLowerCase() ?? '';
        if (/^(?:sh|bash|dash|zsh|fish|cmd|powershell|pwsh)$/.test(executableName) ||
          argv.some(token => /[;&|<>`$\r\n\u0000-\u001f\u007f]/u.test(token)) ||
          (/^(?:python[\d.]*|node|deno|bun|ruby|perl|php|lua)$/.test(executableName) && argv.some(token => ['-c', '-e', '--eval', '--print'].includes(token)))) {
          return { ok: true, permission: 'FORBIDDEN', reasonCode: 'unsafe-command', actionDigest: computeActionDigest(action.value) };
        }
        if (profile.commandRules.some(rule => rule.executableRef === command.executableRef &&
          rule.workingDirectoryRef === command.workingDirectoryRef && rule.argvPrefix.length === argv.length &&
          rule.argvPrefix.every((token, index) => token === argv[index]))) {
          return { ok: true, permission: 'ALLOWED', reasonCode: 'configured-command', actionDigest: computeActionDigest(action.value) };
        }
        if (/^(?:python[\d.]*|node|deno|bun|ruby|perl|php|lua)$/.test(executableName)) return { ok: true, permission: 'FORBIDDEN', reasonCode: 'unconfigured-interpreter', actionDigest: computeActionDigest(action.value) };
        if (command.constrainedCapability !== null) return { ok: true, permission: 'APPROVAL_REQUIRED', reasonCode: 'constrained-command', actionDigest: computeActionDigest(action.value) };
        return { ok: false, outcome: 'unsupported', reasonCode: 'unsupported-command' };
      }
      return { ok: false, outcome: 'unsupported', reasonCode: 'unsupported-action' };
    },
  } };
}
