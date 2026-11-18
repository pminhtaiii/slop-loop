/**
 * The production snapshot grader for the T028 campaign (real-tier contract §(f) T028; UC-03 T028).
 *
 * `createSnapshotGrader` needs five host-held inputs. Three are pinned material the operator's catalog
 * already carries: the criterion set, the grading profile and the grader payload, read from the
 * entry's digest-checked `grader.path`. Two are live host capabilities no serializable pinned input
 * can supply: the isolation authority that admits a hidden check, and the executor that runs it.
 * Those arrive through `GraderCapability` from the operator entry; the gate supplies doubles.
 *
 * When a required input is absent this returns `undefined` with a bounded reason, so the case stays
 * `grader-unavailable` (not-run). It never constructs a grader over a mock isolation authority, and
 * it never returns a verdict of its own (SPEC-W5-102).
 */
import { readFileSync } from 'node:fs';

import type { EvaluationGraderExecutor, EvaluationIsolationAuthority } from '../../../eval/uc03/types.ts';
import { createSnapshotGrader, type SnapshotGradeResult } from '../../../eval/uc03/workflow-grade.ts';
import type { RealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';

/** The two live host capabilities the pinned catalog cannot carry. */
export interface GraderCapability {
  readonly isolationAuthority: EvaluationIsolationAuthority;
  readonly executor: EvaluationGraderExecutor;
}

/** What the pinned grader file must carry; the digest binds all three. */
interface PinnedGrader {
  readonly criteria: unknown;
  readonly profile: unknown;
  readonly graderPayload: unknown;
}

export type GraderResolution =
  | Readonly<{ status: 'ready'; grade: (caseId: string) => Promise<SnapshotGradeResult> }>
  | Readonly<{ status: 'unavailable'; reasonCode: string; missing: readonly string[] }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The catalog entry for one case, from the profile's own catalog path. */
function entryOf(catalogPath: string, caseId: string): Readonly<{ graderPath: string; graderDigest: string }> | undefined {
  const text = readFileSync(catalogPath, 'utf8');
  const parsed: unknown = JSON.parse(text);
  const entries = isRecord(parsed) && Array.isArray(parsed['catalog']) ? parsed['catalog'] : [];
  const entry = entries.find(candidate => isRecord(candidate) && candidate['caseId'] === caseId);
  if (!isRecord(entry) || !isRecord(entry['grader'])) return undefined;
  const grader = entry['grader'];
  return typeof grader['path'] === 'string' && typeof grader['digest'] === 'string' ? { graderPath: grader['path'], graderDigest: grader['digest'] } : undefined;
}

/** The pinned material, digest-checked. A mismatch is a stale pin, not a gradeable file. */
function pinnedOf(entry: Readonly<{ graderPath: string; graderDigest: string }>): PinnedGrader | undefined {
  const text = readFileSync(entry.graderPath, 'utf8');
  const digest = `sha256:${sha256Text(text)}`;
  if (digest !== entry.graderDigest) return undefined;
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) return undefined;
  return { criteria: parsed['criteria'], profile: parsed['profile'], graderPayload: parsed['graderPayload'] };
}

/**
 * Resolves the case's independent grader. `capability` is the operator's live isolation/executor pair;
 * absent, the two missing inputs are named exactly. A pinned file that lacks criteria or profile names
 * those. Nothing here invents a criterion, a hidden check or a verdict.
 */
export function resolvePinnedGrader(assembly: RealTierAssembly, caseId: string, capability: GraderCapability | undefined): GraderResolution {
  const entry = entryOf(assembly.profile.catalog.path, caseId);
  if (entry === undefined) return { status: 'unavailable', reasonCode: 'grader-catalog-entry-missing', missing: ['catalog.grader.path', 'catalog.grader.digest'] };
  const pinned = pinnedOf(entry);
  if (pinned === undefined) return { status: 'unavailable', reasonCode: 'grader-digest-mismatch', missing: ['catalog.grader.digest'] };
  const missing: string[] = [];
  if (!isRecord(pinned.criteria)) missing.push('grader.criteria');
  if (!isRecord(pinned.profile)) missing.push('grader.profile');
  // The two live capabilities: no serializable pinned input can carry a function.
  if (capability === undefined) missing.push('grader.isolationAuthority', 'grader.executor');
  if (missing.length > 0 || capability === undefined) return { status: 'unavailable', reasonCode: capability === undefined ? 'grader-capability-unavailable' : 'grader-material-incomplete', missing };
  const grader = createSnapshotGrader({ criteria: pinned.criteria, profile: pinned.profile, graderPayload: pinned.graderPayload, isolationAuthority: capability.isolationAuthority, executor: capability.executor });
  return { status: 'ready', grade: (id: string) => grader.grade(id, undefined) };
}
