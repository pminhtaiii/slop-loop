import type {
  WorkspaceBaseline,
  ProviderUsage,
  ApprovalRequestBinding,
} from '../../../../src/persistence/contracts.ts';

export type GitInspectorPort = (repoRoot: string) => Promise<WorkspaceBaseline>;

export interface ControlledUsagePort {
  readonly recordUsage: (requestId: string, usage: ProviderUsage) => Promise<void>;
  readonly getUsageHistory: (requestId: string) => ProviderUsage | undefined;
}

export interface ControlledApprovalPort {
  readonly submitApprovalRequest: (request: ApprovalRequestBinding) => Promise<void>;
  readonly resolveApproval: (requestId: string, decision: 'approved' | 'rejected', operator: string) => void;
  readonly getPendingRequest: (requestId: string) => ApprovalRequestBinding | undefined;
}

export function createControlledGitInspector(baseline: WorkspaceBaseline): {
  port: GitInspectorPort;
  setDriftCommit: (newCommit: string) => void;
  setDriftClean: (isClean: boolean) => void;
  reset: () => void;
} {
  let current = { ...baseline };

  return {
    port: async () => ({ ...current }),
    setDriftCommit: (newCommit: string) => {
      current = { ...current, commitHash: newCommit };
    },
    setDriftClean: (isClean: boolean) => {
      current = { ...current, isClean };
    },
    reset: () => {
      current = { ...baseline };
    },
  };
}

export function createControlledApprovalPort(): ControlledApprovalPort {
  const pending = new Map<string, ApprovalRequestBinding>();
  const resolved = new Map<string, { decision: 'approved' | 'rejected'; operator: string }>();

  return {
    submitApprovalRequest: async (request: ApprovalRequestBinding) => {
      pending.set(request.requestId, request);
    },
    resolveApproval: (requestId: string, decision: 'approved' | 'rejected', operator: string) => {
      pending.delete(requestId);
      resolved.set(requestId, { decision, operator });
    },
    getPendingRequest: (requestId: string) => pending.get(requestId),
  };
}

export function createControlledUsagePort(): ControlledUsagePort {
  const usageMap = new Map<string, ProviderUsage>();

  return {
    recordUsage: async (requestId: string, usage: ProviderUsage) => {
      usageMap.set(requestId, usage);
    },
    getUsageHistory: (requestId: string) => usageMap.get(requestId),
  };
}
