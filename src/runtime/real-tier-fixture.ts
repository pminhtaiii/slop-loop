/**
 * Catalog entry lookup, digest-pinned fixture loading, and containment validation for real-tier task binding.
 */
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { computeCanonicalSha256, validateBugTask } from '../contracts/foundation/uc03.ts';
import type { BugTask } from '../contracts/foundation/uc03.ts';
import { MAX_TASK_REPLANS } from '../uc03/replan-accounting.ts';
import { sha256Text } from '../uc01/contracts.ts';

/** One catalog entry, as the T047 profile's catalog file already declares it. */
export interface RealTierCatalogEntry {
  readonly fixturePath: string;
  readonly fixtureDigest: string;
  readonly initialRepositoryDigest: string;
}

/** The fixture document: a pinned task plus the target repository root. */
export interface RealTierFixture {
  readonly task: BugTask;
  readonly repositoryRoot: string;
}

export type RealTierFixtureRefusal = Readonly<{ status: 'unavailable'; reasonCode: string; path: string }>;

const refused = (reasonCode: string, path = '$'): RealTierFixtureRefusal => Object.freeze({ status: 'unavailable', reasonCode, path });

/** Reads one catalog entry by `caseId`, or returns a bounded refusal. */
export function entryOf(source: string, caseId: string): RealTierCatalogEntry | RealTierFixtureRefusal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return refused('catalog-invalid', '$.catalog');
  }
  const entries = (parsed as { readonly catalog?: unknown } | null)?.catalog;
  if (!Array.isArray(entries)) return refused('catalog-invalid', '$.catalog');
  const entry = entries.find((candidate: unknown) => typeof candidate === 'object' && candidate !== null && (candidate as { caseId?: unknown }).caseId === caseId);
  if (entry === undefined) return refused('catalog-entry-missing', '$.catalog');
  const record = entry as Readonly<Record<string, unknown>>;
  if (typeof record['fixturePath'] !== 'string' || typeof record['fixtureDigest'] !== 'string') return refused('catalog-invalid', '$.catalog');
  return {
    fixturePath: record['fixturePath'],
    fixtureDigest: record['fixtureDigest'],
    initialRepositoryDigest: typeof record['initialRepositoryDigest'] === 'string' ? record['initialRepositoryDigest'] : '',
  };
}

/**
 * Loads one fixture and verifies its digest, BugTask schema, revision, check working directories,
 * and `repositoryRoot` containment under `realpath` inside the catalog directory.
 */
export function loadFixture(readText: (path: string) => string, entry: RealTierCatalogEntry, catalogPath: string): RealTierFixture | RealTierFixtureRefusal {
  if (!isAbsolute(entry.fixturePath)) return refused('fixture-path-invalid', '$.fixturePath');
  let text: string;
  try {
    text = readText(entry.fixturePath);
  } catch {
    return refused('fixture-unreadable', '$.fixturePath');
  }
  if (sha256Text(text) !== entry.fixtureDigest) return refused('fixture-digest-mismatch', '$.fixtureDigest');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refused('fixture-invalid', '$.fixture');
  }
  if (typeof parsed !== 'object' || parsed === null) return refused('fixture-invalid', '$.fixture');
  const document = parsed as Readonly<Record<string, unknown>>;
  const task = validateBugTask(document['task']);
  if (!task.ok) return refused('task-invalid', '$.task');
  // The carried prerequisite: the replan ledger is three slots, so a fixture that disagrees is refused.
  if (task.value.budgetLimits.maxReplanCount !== MAX_TASK_REPLANS) return refused('replan-count-unsupported', '$.task.budgetLimits.maxReplanCount');
  if (task.value.initialRevisionDigest.replace(/^sha256:/u, '') !== entry.initialRepositoryDigest) return refused('revision-mismatch', '$.initialRepositoryDigest');
  for (let i = 0; i < task.value.requiredChecks.length; i++) {
    const rawWd = task.value.requiredChecks[i]?.workingDirectory;
    if (typeof rawWd !== 'string') return refused('check-working-directory-invalid', `$.task.requiredChecks[${i}].workingDirectory`);
    const wd = posix.normalize(rawWd);
    if (!posix.isAbsolute(wd) || (wd !== '/workspace/repo' && !wd.startsWith('/workspace/repo/'))) {
      return refused('check-working-directory-invalid', `$.task.requiredChecks[${i}].workingDirectory`);
    }
  }

  const declared = document['repositoryRoot'];
  if (typeof declared !== 'string' || !declared.trim()) return refused('repository-root-missing', '$.repositoryRoot');
  const catalogDir = realpathSync(dirname(catalogPath));
  let resolved: string;
  try {
    resolved = realpathSync(isAbsolute(declared) ? declared : join(dirname(entry.fixturePath), declared));
  } catch {
    return refused('repository-root-unresolvable', '$.repositoryRoot');
  }
  const within = relative(catalogDir, resolved);
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) return refused('repository-root-escapes-catalog', '$.repositoryRoot');

  return { task: task.value, repositoryRoot: resolved };
}

/** Validates a custom BugTask override keeps template repository, checks, config, and limits intact with a fresh taskId. */
export function validateCustomTaskOverride(template: BugTask, candidate: BugTask): BugTask | RealTierFixtureRefusal {
  const parsed = validateBugTask(candidate);
  if (!parsed.ok) return refused('custom-task-invalid', '$.customTask');
  const custom = parsed.value;
  if (custom.taskId === template.taskId) return refused('custom-task-identity-conflict', '$.customTask.taskId');
  if (
    custom.repositoryId !== template.repositoryId ||
    custom.initialRevisionDigest !== template.initialRevisionDigest ||
    custom.configId !== template.configId ||
    custom.configVersion !== template.configVersion ||
    computeCanonicalSha256(custom.requiredChecks) !== computeCanonicalSha256(template.requiredChecks) ||
    computeCanonicalSha256(custom.limits) !== computeCanonicalSha256(template.limits) ||
    computeCanonicalSha256(custom.budgetLimits) !== computeCanonicalSha256(template.budgetLimits)
  ) {
    return refused('custom-task-template-mismatch', '$.customTask');
  }
  return Object.freeze({
    ...custom,
    acceptanceCriteria: Object.freeze([...custom.acceptanceCriteria]),
    constraints: Object.freeze([...custom.constraints]),
  });
}
