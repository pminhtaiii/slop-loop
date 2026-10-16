import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export function githubRepository(url) {
  const match = url.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!match) throw new Error('Publication remotes must identify GitHub repositories over HTTPS or SSH.');
  return match[1];
}

export async function publicationTargets(repo, execute) {
  let config;
  try { config = JSON.parse(await readFile(resolve(repo.root, 'publication-targets.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (config.schemaVersion !== 1 || config.submission?.remote !== 'submission' || config.submission?.base !== 'main') throw new Error('publication-targets.json requires schemaVersion 1 and submission remote submission / base main.');
  const target = (remote, base) => ({ remote, base, repository: githubRepository(execute('git', ['remote', 'get-url', remote], repo.root, 30_000)) });
  const targets = { primary: target('origin', 'development'), submission: target('submission', 'main') };
  if (targets.primary.repository.toLowerCase() === targets.submission.repository.toLowerCase()) throw new Error('Primary and submission repositories must be different.');
  return targets;
}
