/**
 * Completion receipts for the PR workflow: the two-axis review record and the app's PR-link
 * record. Both are local workflow accounting rather than signed credentials, and both are
 * validated here so `complete` can require them without the caller supplying a claim.
 */
import { readJson } from './agent-store.mjs';
import { verifySubmission } from './submission-pr.mjs';

const commitId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Validates the review receipt, then stores it on the record. Returns the updated record. */
export async function recordReviewReceipt({ receiptPath, record, git }) {
  const receipt = await readJson(receiptPath);
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) throw new Error('The review receipt must be a JSON object.');
  if (!commitId.test(receipt.base ?? '') || !commitId.test(receipt.head ?? '')) throw new Error('The review receipt must name base and head as full commit SHAs.');
  if (!Array.isArray(receipt.axes) || receipt.axes.length !== 2) throw new Error('The review receipt must name exactly two review axes.');
  if (!receipt.axes.every(axis => axis?.name && (Array.isArray(axis.findings) || (Number.isInteger(axis.findings) && axis.findings >= 0))))
    throw new Error('Each review axis must have a name and a findings array or count.');
  if (new Set(receipt.axes.map(axis => axis.name)).size !== receipt.axes.length) throw new Error('The review receipt must name each axis exactly once.');
  if (receipt.head !== git('rev-parse', 'HEAD')) throw new Error('The review receipt head must match the current checkout HEAD.');
  record.codeReview = { base: receipt.base, head: receipt.head, axes: receipt.axes, recordedAt: new Date().toISOString() };
  return record;
}

/** Validates the app link receipt against the live PRs, then stores it on the record. */
export async function recordAppStateReceipt({ receiptPath, record, remote, targets, repo, branch, git, execute }) {
  const receipt = await readJson(receiptPath);
  const linked = (receipt.structuredContent ?? receipt).pullRequests?.find(pr => pr.url === record.url && pr.repository === remote && pr.number === record.pr);
  if (!linked) throw new Error('The app receipt must include this linked PR.');
  if (targets) {
    const submission = await verifySubmission({ repo, targets, branch, sourceHead: git('rev-parse', 'HEAD'), execute });
    const pairedLink = (receipt.structuredContent ?? receipt).pullRequests?.find(pr => pr.url === submission.url && pr.repository === submission.repository && pr.number === submission.number);
    if (!pairedLink) throw new Error('The app receipt must include both linked PRs, including submission.');
    record.submission = submission;
    record.submissionAppLink = { url: pairedLink.url, repository: pairedLink.repository, number: pairedLink.number, recordedAt: new Date().toISOString() };
  }
  record.appLink = { url: linked.url, repository: remote, number: linked.number, recordedAt: new Date().toISOString() };
  return record;
}
