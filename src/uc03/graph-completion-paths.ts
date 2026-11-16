/**
 * T053 gap 3: completion's cumulative-diff relation over the owner-settled patch chain.
 *
 * The latest admission's targets must sit inside the cumulative diff, and every cumulative-diff
 * path must be declared by some settled Patch/Repair admission for this task and run. The chain is
 * walked back through `loadVerifiedPatchAncestry` one claim snapshot at a time, because each repair
 * round's admission binds only its own paths. `state.changedPaths` is observed inventory written by
 * Verify, never admission evidence, so it is not read here.
 */
import type { BugTask, RepositoryAdmissionContextV02, StatePortV02 } from '../contracts/foundation/uc03.ts';
import { loadVerifiedPatchAncestry, type VerifiedPatchAncestry } from './graph-patch-ancestry.ts';

function declaredTargets(context: RepositoryAdmissionContextV02): readonly string[] {
  return context.action.kind === 'apply_patch' ? context.action.targetPaths : [];
}

export async function cumulativeDiffIsAdmitted(input: {
  readonly task: BugTask;
  readonly latestTargets: readonly string[];
  readonly changedFiles: readonly string[];
  readonly ancestry: VerifiedPatchAncestry;
  readonly owner: StatePortV02;
}): Promise<boolean> {
  const diff = new Set(input.changedFiles);
  if (input.latestTargets.some(path => !diff.has(path))) return false;
  const declared = new Set(input.latestTargets);
  const visited = new Set<string>();
  // One Patch plus at most `maxRepairAttempts` repairs.
  const limit = input.task.budgetLimits.maxRepairAttempts + 1;
  let link = input.ancestry;
  for (let links = 1; links <= limit; links += 1) {
    for (const path of declaredTargets(link.admission.context)) declared.add(path);
    if (input.changedFiles.every(path => declared.has(path))) return true;
    // The initial Patch is the last link; nothing before it can declare a path.
    if (link.admission.context.canonicalRevision === input.task.initialRevisionDigest) return false;
    const revision = link.originalTaskState.repositoryRevisionDigest;
    if (visited.has(revision)) return false;
    visited.add(revision);
    const previous = await loadVerifiedPatchAncestry(input.task, link.originalTaskState, input.owner);
    if (!previous) return false;
    link = previous;
  }
  return false;
}
