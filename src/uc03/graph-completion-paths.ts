/**
 * T053 / SPEC-R3-001: the cumulative-diff binding for completion.
 *
 * The diff is taken against the task's initial revision, so a later repair that touches fewer
 * paths than everything patched so far is legitimate. Comparing the newest admission to that
 * cumulative inventory refuses such a repair. The binding stays strict in both directions:
 * every path in the cumulative diff must sit in the monotone changed-path record the task has
 * carried since the first patch (`Repair` unions declared targets, `Verify` unions the observed
 * diff, so the record is the union of this task's admitted patches), and the newest admission's
 * targets must all appear in it.
 */
export function cumulativeDiffBinding(latestAdmissionTargets: readonly string[], changedFiles: readonly string[], recordedChangedPaths: readonly string[]): boolean {
  const diff = new Set(changedFiles);
  const recorded = new Set(recordedChangedPaths);
  return changedFiles.every(path => recorded.has(path)) && latestAdmissionTargets.every(path => diff.has(path));
}
