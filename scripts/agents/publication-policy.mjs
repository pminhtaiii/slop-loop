const safeDirectories = ['docs/', 'context/', '.agents/skills/', '.githooks/', 'scripts/agents/', 'tests/agents/', 'tests/ci/'];
const safeCiHelpers = new Set(['scripts/ci/check-context.mjs', 'scripts/ci/check-staged-file-size.mjs', 'scripts/ci/check-env-examples.mjs', 'scripts/ci/check-tracked-files.mjs']);
const fullGateFiles = new Set([
  '.npmrc',
  '.pnpmfile.cjs',
  'pnpmfile.cjs',
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'turbo.json',
  'nx.json',
  'project.json',
  'makefile',
  'cmakelists.txt',
]);
const buildConfigPrefixes = [
  'eslint.config.',
  'prettier.config.',
  'vite.config.',
  'vitest.config.',
  'webpack.config.',
  'rollup.config.',
  'babel.config.',
  'jest.config.',
  'playwright.config.',
  'next.config.',
  'nuxt.config.',
  'astro.config.',
  'svelte.config.',
  'postcss.config.',
  'tailwind.config.',
];

function parseChangedPaths(raw) {
  if (typeof raw !== 'string' || !raw) throw new Error('The exact base-to-candidate Git diff is empty or unreadable.');
  if (!raw.endsWith('\0')) throw new Error('The exact base-to-candidate Git diff is malformed.');
  const fields = raw.split('\0');
  fields.pop();
  const paths = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const pathCount = /^[RC]\d{1,3}$/.test(status) ? 2 : ['A', 'D', 'M', 'T'].includes(status) ? 1 : 0;
    if (!pathCount || fields.length - index < pathCount) throw new Error('The exact base-to-candidate Git diff contains an invalid name-status record.');
    const changed = fields.slice(index, index + pathCount);
    if (changed.some(path => !path)) throw new Error('The exact base-to-candidate Git diff contains an empty path.');
    paths.push(...changed);
    index += pathCount;
  }
  if (!paths.length) throw new Error('The exact base-to-candidate Git diff contains no changed paths.');
  return paths;
}

function isDocumentationOrHelperPath(path) {
  const normalized = path.toLowerCase();
  const basename = normalized.split('/').at(-1);
  if (
    fullGateFiles.has(basename) ||
    /^(?:tsconfig|jsconfig)(?:\.[^/]*)?\.json$/.test(basename) ||
    /^\.(?:eslintrc|prettierrc)(?:\..+)?$/.test(basename) ||
    buildConfigPrefixes.some(prefix => basename.startsWith(prefix))
  )
    return false;
  return normalized === 'agents.md' || /^readme(?:\.[^/]*)?$/.test(normalized) || safeCiHelpers.has(path) || safeDirectories.some(directory => normalized.startsWith(directory));
}

function policy({ requestedMode, mode, provenance, reason, classification, base, head, paths }) {
  return { requestedMode, mode, provenance, reason, classification, base, head, paths };
}

/** The commit-id shape every policy, receipt and binding predicate accepts. */
export const commitId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export async function selectPublicationPolicy({ requestedMode = 'auto', reason, base, head, git }) {
  if (!['auto', 'full', 'push-only'].includes(requestedMode)) throw new Error('Publication policy mode must be auto, full, or push-only.');
  if (!commitId.test(base ?? '') || !commitId.test(head ?? '')) {
    throw new Error('Publication policy requires exact base and candidate commit IDs.');
  }
  if (requestedMode === 'full') {
    if (reason !== undefined) throw new Error('--reason is only valid with --mode push-only.');
    return policy({ requestedMode, mode: 'full', provenance: 'explicit-v1', reason: 'Explicit --mode full selected.', classification: 'explicit', base, head, paths: [] });
  }
  if (requestedMode === 'push-only') {
    if (!reason?.trim() || reason.length > 2000) throw new Error('Push-only publication requires a non-empty --reason of at most 2000 characters.');
    return policy({ requestedMode, mode: 'push-only', provenance: 'explicit-v1', reason: reason.trim(), classification: 'explicit', base, head, paths: [] });
  }
  if (reason !== undefined) throw new Error('--reason is only valid with --mode push-only.');
  if (!git) throw new Error('Automatic publication policy requires a Git command.');

  let raw;
  try {
    raw = await git('diff', '--name-status', '-z', '--find-renames', base, head);
  } catch (error) {
    throw new Error(`Could not read the exact base-to-candidate Git diff: ${error.message}`, { cause: error });
  }
  const paths = parseChangedPaths(raw);
  const outOfScope = paths.find(path => !isDocumentationOrHelperPath(path));
  return policy({
    requestedMode,
    mode: outOfScope ? 'full' : 'push-only',
    provenance: 'automatic-v1',
    reason: outOfScope
      ? `Full local gates selected because ${JSON.stringify(outOfScope)} is outside the documentation and contributor-helper policy.`
      : 'All changed paths are documentation and contributor helper paths.',
    classification: outOfScope ? 'full-required' : 'docs-helper-only',
    base,
    head,
    paths,
  });
}

export function matchesAutomaticPushOnlyPolicy(record, head, policy) {
  return (
    record.publicationMode === 'push-only' &&
    record.publicationProvenance === 'automatic-v1' &&
    record.publicationPolicy?.provenance === 'automatic-v1' &&
    record.publicationPolicy.requestedMode === 'auto' &&
    record.publicationPolicy.mode === 'push-only' &&
    record.publicationPolicy.head === head &&
    record.publicationPolicy.base === policy.base &&
    record.publicationPolicy.reason === policy.reason &&
    record.publicationReason === policy.reason &&
    record.publicationPolicy.classification === policy.classification &&
    JSON.stringify(record.publicationPolicy.paths) === JSON.stringify(policy.paths) &&
    policy.mode === 'push-only' &&
    policy.provenance === 'automatic-v1'
  );
}

export async function validatePushOnlyCompletion(record, head, git) {
  const policy = record.publicationPolicy;
  if (!policy && !record.publicationProvenance) return; // Legacy explicit push-only records retain their existing behavior.
  if (record.publicationProvenance === 'automatic-v1' || policy?.provenance === 'automatic-v1') {
    let current;
    try {
      current = await selectPublicationPolicy({ base: policy?.base, head, git });
    } catch (error) {
      throw new Error(`Automatic publication policy could not be revalidated; completion requires local gates. ${error.message}`, { cause: error });
    }
    if (!matchesAutomaticPushOnlyPolicy(record, head, current)) {
      throw new Error('Automatic publication policy is stale or inconsistent; completion requires local gates.');
    }
    return;
  }
  if (
    record.publicationProvenance === 'explicit-v1' &&
    policy?.provenance === 'explicit-v1' &&
    policy.requestedMode === 'push-only' &&
    policy.mode === 'push-only' &&
    policy.head === head &&
    policy.reason === record.publicationReason
  )
    return;
  throw new Error('Push-only publication provenance is missing or inconsistent; completion requires local gates.');
}
