import type { BugTask } from '../contracts/foundation/uc03.ts';
export const RECEIVER_CONTRACT_VERSION = 'uc01-uc03-receiver-v1' as const;
export interface IntakeSource {
  readonly contractVersion: typeof RECEIVER_CONTRACT_VERSION;
  readonly assessmentId: string;
  readonly issueId: string;
  readonly reportDigest: string;
  readonly catalogId: string;
  readonly catalogVersion: string;
  readonly provenance: 'mock' | 'real';
}
export type IntakeResult =
  | Readonly<{ status: 'accepted'; task: BugTask; source?: IntakeSource }>
  | Readonly<{ status: 'needs-info'; fields: readonly string[]; questionIds: readonly string[] }>
  | Readonly<{ status: 'invalid-input' | 'conflict' | 'not-applicable'; reasonCode: string; path: string }>;
