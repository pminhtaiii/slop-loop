/**
 * Completion receipts for the PR workflow: the two-axis review record and the app's PR-link
 * record. Both are local workflow accounting rather than signed credentials, and both are
 * validated here so `complete` can require them without the caller supplying a claim.
 */
import { isAbsolute, resolve } from 'node:path';
import { readJson } from './agent-store.mjs';
import { statIfPresent } from './agent-context-resume.mjs';
import { commitId } from './publication-policy.mjs';
import { verifySubmission } from './submission-pr.mjs';

/** A distinct, non-empty axis name; the two names are what the review had to cover separately. */
function validAxes(axes) {
  return (
    Array.isArray(axes) &&
    axes.length === 2 &&
    axes.every(axis => typeof axis?.name === 'string' && axis.name.trim() !== '' && Array.isArray(axis.findings) && axis.findings.every(finding => typeof finding === 'string'))
  );
}

/**
 * Validates the review receipt, then stores it on the record. Returns the updated record.
 * The receipt names the axis report files; each must exist and hold text, so a receipt cannot
 * assert that a review ran without leaving the reports it summarises.
 */
export async function recordReviewReceipt({ receiptPath, record, git, root }) {
  const receipt = await readJson(receiptPath);
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) throw new Error('The review receipt must be a JSON object.');
  if (!commitId.test(receipt.base ?? '') || !commitId.test(receipt.head ?? '')) throw new Error('The review receipt must name base and head as full commit SHAs.');
  if (!validAxes(receipt.axes)) throw new Error('The review receipt must name exactly two axes, each with a non-empty name and its findings as an array of strings.');
  if (new Set(receipt.axes.map(axis => axis.name)).size !== receipt.axes.length) throw new Error('The review receipt must name each axis exactly once.');
  const head = git('rev-parse', 'HEAD');
  if (receipt.head !== head) throw new Error('The review receipt head must match the current checkout HEAD.');
  // A review of the head against itself observed no change; the diff must be the reviewed artifact.
  if (receipt.base === head) throw new Error('The review receipt base and head must differ; a review of the empty diff observed nothing.');
  // The base must be a real ancestor, not an arbitrary hex string: a review names the range it read.
  // Existence and ancestry are separate checks because `merge-base` also fails on unrelated
  // histories, which is a different error from a base that names nothing.
  try {
    git('rev-parse', '--verify', '--quiet', `${receipt.base}^{commit}`);
  } catch {
    throw new Error('The review receipt base must name a commit in this repository.');
  }
  let mergeBase;
  try {
    mergeBase = git('merge-base', receipt.base, head);
  } catch {
    throw new Error('The review receipt base must share history with the reviewed head.');
  }
  if (mergeBase !== receipt.base) throw new Error('The review receipt base must be an ancestor of the reviewed head.');
  if (!Array.isArray(receipt.reports) || receipt.reports.length !== 2 || receipt.reports.some(report => typeof report !== 'string' || report.trim() === ''))
    throw new Error('The review receipt must name the two axis report files.');
  if (new Set(receipt.reports).size !== receipt.reports.length) throw new Error('The review receipt must name a different report for each axis.');
  const reports = [];
  for (const report of receipt.reports) {
    const path = isAbsolute(report) ? report : resolve(root, report);
    // statIfPresent rather than existsSync: a review report is expected to be a regular file, and
    // a directory named like one must not satisfy the receipt.
    const stat = await statIfPresent(path);
    if (!stat?.isFile() || stat.size === 0) throw new Error(`The review receipt names a report file that is missing or empty: ${report}`);
    reports.push(report);
  }
  record.codeReview = { base: receipt.base, head: receipt.head, axes: receipt.axes, reports, recordedAt: new Date().toISOString() };
  return record;
}

/** Validates the app link receipt against the live PRs, then stores it on the record. */
export async function recordAppStateReceipt({ receiptPath, record, remote, targets, repo, branch, git, execute }) {
  const receipt = await readJson(receiptPath);
  const pullRequests = (receipt.structuredContent ?? receipt).pullRequests;
  const linked = pullRequests?.find(pr => pr.url === record.url && pr.repository === remote && pr.number === record.pr);
  if (!linked) throw new Error('The app receipt must include this linked PR.');
  if (targets) {
    const submission = await verifySubmission({ repo, targets, branch, sourceHead: git('rev-parse', 'HEAD'), execute });
    const pairedLink = pullRequests?.find(pr => pr.url === submission.url && pr.repository === submission.repository && pr.number === submission.number);
    if (!pairedLink) throw new Error('The app receipt must include both linked PRs, including submission.');
    record.submission = submission;
    record.submissionAppLink = { url: pairedLink.url, repository: pairedLink.repository, number: pairedLink.number, recordedAt: new Date().toISOString() };
  }
  record.appLink = { url: linked.url, repository: remote, number: linked.number, recordedAt: new Date().toISOString() };
  return record;
}
