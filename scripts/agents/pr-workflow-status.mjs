import { assertPrMetadata, featureBranch as featureName, validSummary } from './pr-conventions.mjs';
import { localGateStatus, localVerifiedHead } from './pr-workflow-push-only.mjs';
import { ACTIVE_POLICY_ID, createPolicyState, selectLatest } from '../ci/required-checks.mjs';
export { featureName, validSummary };

export function assess({ head, pr, checks, convention }) {
  const result = { status: 'WAITING_CI', failedChecks: [], unresolved: [] };
  if (!pr || typeof pr !== 'object' || Array.isArray(pr) || pr.state !== 'OPEN' || pr.headRefOid !== head) return { ...result, status: 'BLOCKED', reason: 'PR identity, title, base, state, or current HEAD does not match.' };
  // Live metadata is revalidated on every observation, so a body-only edit cannot ride an older
  // passing same-head check. The retained convention decides the rules; unversioned records stay readable.
  try { assertPrMetadata({ branch: pr.headRefName, base: pr.baseRefName, title: pr.title, body: pr.body }, { convention }); }
  catch (error) { return { ...result, status: 'BLOCKED', reason: `Live PR metadata is invalid: ${error.message}` }; }
  if (pr.reviews.pageInfo.hasPreviousPage || pr.reviewThreads.pageInfo.hasNextPage) return { ...result, status: 'BLOCKED', reason: 'Review data exceeds the bounded page; inspect manually.' };
  result.unresolved = pr.reviewThreads.nodes.filter((thread) => !thread.isResolved);
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'BEHIND') return { ...result, status: 'BLOCKED', reason: 'Update the feature branch against development and rerun verification.' };
  const latest = selectLatest({ policy: createPolicyState(ACTIVE_POLICY_ID).policy, head, checks }).map(({ check }) => check);
  result.failedChecks = latest.filter((check) => check?.status === 'completed' && check.conclusion !== 'success').map((check) => ({ name: check.name, conclusion: check.conclusion, url: check.details_url }));
  if (result.failedChecks.length) result.status = 'NEEDS_FIX';
  else if (pr.mergeable === 'UNKNOWN' || latest.some((check) => !check || check.status !== 'completed')) result.status = 'WAITING_CI';
  else if (pr.mergeStateStatus === 'BLOCKED' && pr.isDraft === false) return { ...result, status: 'BLOCKED', reason: 'GitHub reports an unmet merge requirement.' };
  else result.status = pr.isDraft === false ? 'AWAITING_HUMAN_MERGE' : 'READY_FOR_HUMAN';
  return result;
}

export function changedLines(numstat) {
  let reviewable = 0, generated = 0, binaries = 0;
  for (const line of numstat.trim().split('\n').filter(Boolean)) {
    const [added, removed, ...path] = line.split('\t');
    if (added === '-' || removed === '-') { binaries++; continue; }
    const size = Number(added) + Number(removed);
    if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path.join('\t'))) generated += size;
    else reviewable += size;
  }
  return { reviewable, generated, binaries, overTarget: reviewable + generated > 1000 };
}

export function workflowSummary(record) {
  if (record.usage || !record.schemaVersion) return record;
  const unresolved = (record.observation?.unresolved ?? []).map(thread => ({ id: thread.id, isOutdated: thread.isOutdated, urls: thread.comments?.nodes.map(comment => comment.url) ?? [] }));
  const logs = Object.fromEntries(Object.entries(record.gateLogs ?? {}).map(([name, gate]) => [name, { status: gate.status, exitCode: gate.exitCode, log: gate.log, durationMs: gate.durationMs }]));
  const head = record.head ?? record.publishedHead;
  return { status: record.status, branch: record.branch, head, publishedHead: record.publishedHead, pr: record.pr, url: record.url, submission: record.submission, size: record.size, reason: record.reason ?? record.observation?.reason, publicationMode: record.publicationMode ?? 'full', publicationReason: record.publicationReason, checkPolicy: record.checkPolicy ?? null, repairRounds: record.repairRounds.length, failedChecks: record.observation?.failedChecks ?? [], unresolved, logs, localVerifiedHead: localVerifiedHead(record), localGateStatus: localGateStatus(record, head) };
}
