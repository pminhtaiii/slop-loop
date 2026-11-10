import { changedLines, featureName } from './pr-workflow-status.mjs';

export function preflight({ git, branch }) {
  git('fetch', '--no-tags', 'origin', 'refs/heads/development:refs/remotes/origin/development');
  const head = git('rev-parse', 'HEAD'),
    base = git('rev-parse', 'origin/development');
  const [behind, ahead] = git('rev-list', '--left-right', '--count', `${base}...${head}`).split(/\s+/).map(Number);
  const dirty = git('status', '--porcelain', '--untracked-files=all');
  const branchValid = featureName.test(branch);
  const blockers = [
    !branchValid && 'Use a feat/scope-description branch.',
    behind > 0 && 'Branch is behind development; integrate its changes before editing.',
    dirty && 'Review existing dirty paths before starting another assignment.',
  ].filter(Boolean);
  const size = changedLines(git('diff', '--numstat', '--no-renames', `${base}...${head}`));
  if (git('rev-parse', 'HEAD') !== head || git('branch', '--show-current') !== branch) throw new Error('Checkout changed during preflight; rerun it.');
  return { status: blockers.length ? 'BLOCKED' : 'READY_TO_WORK', branch, branchValid, head, base, behind, ahead, dirty, size, blockers };
}
