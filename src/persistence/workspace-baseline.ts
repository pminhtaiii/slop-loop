import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceBaseline } from './contracts.ts';

export async function captureWorkspaceBaseline(repoRoot: string): Promise<WorkspaceBaseline> {
  const revParse = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  if (revParse.status !== 0) {
    throw new Error(`Failed to get git commit: ${revParse.stderr}`);
  }
  const commitHash = revParse.stdout.trim();

  const branchRes = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const branch = branchRes.status === 0 ? branchRes.stdout.trim() : 'HEAD';

  const statusRes = spawnSync('git', ['status', '--porcelain=v1', '-z', '-uall'], { cwd: repoRoot, encoding: 'utf8' });
  if (statusRes.status !== 0) {
    throw new Error(`Failed to get git status: ${statusRes.stderr || 'non-zero exit code'}`);
  }
  const records = statusRes.stdout.split('\0');
  if (records.at(-1) === '') records.pop();
  const isClean = records.length === 0;

  const contentHash = createHash('sha256');
  if (isClean) {
    contentHash.update(commitHash);
  } else {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] ?? '';
      const code = record.slice(0, 2);
      const filePath = record.slice(3);
      if (code[0] === 'R' || code[0] === 'C') index += 1;
      contentHash.update(code).update('\0').update(filePath).update('\0');
      try {
        contentHash.update(await readFile(join(repoRoot, filePath)));
      } catch {
        contentHash.update('<unreadable>');
      }
      contentHash.update('\0');
    }
  }

  return {
    commitHash,
    branch,
    isClean,
    trackedFilesHash: contentHash.digest('hex'),
  };
}
