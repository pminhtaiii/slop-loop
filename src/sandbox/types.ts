export type SandboxStatus = "READY" | "BLOCKED" | "FAILED";
export type Freshness = "CURRENT" | "STALE" | "UNCONFIRMED";

export interface SandboxLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxFileBytes: number;
  readonly maxOutputBytes: number;
  readonly timeoutSeconds: number;
  readonly maxPids: number;
  readonly cpus: number;
  readonly memoryBytes: number;
}

export interface SnapshotEntry {
  readonly path: string;
  readonly bytes: number;
  readonly mode: number;
  readonly hash: string;
  readonly content: Buffer;
}

export interface VerificationSnapshot {
  readonly formatVersion: 1;
  readonly workspaceId: string;
  readonly exclusionPolicyId: string;
  readonly entries: readonly SnapshotEntry[];
  readonly totalBytes: number;
  readonly snapshotId: string;
}

export interface PreparedImageRecord {
  readonly imageId: string;
  readonly fingerprint: string;
  readonly architecture: string;
  readonly status: "READY" | "STALE" | "MISSING" | "UNHEALTHY";
}

export interface VerificationEvidence {
  readonly check: string;
  readonly snapshotId: string;
  readonly imageId: string;
  readonly status: "PASS" | "FAIL";
  readonly cleanup: "CONFIRMED" | "UNCERTAIN";
}

export interface VerificationVerdict {
  readonly status: "PASS" | "FAIL" | "INCOMPLETE";
  readonly freshness: Freshness;
  readonly evidence: readonly VerificationEvidence[];
}

export interface SandboxBackend {
  readiness(image: PreparedImageRecord, limits: SandboxLimits): Promise<SandboxStatus>;
  executeCheck(input: {
    readonly snapshot: VerificationSnapshot;
    readonly image: PreparedImageRecord;
    readonly argv: readonly string[];
    readonly limits: SandboxLimits;
  }): Promise<VerificationEvidence>;
}
