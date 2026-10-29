// Single pure definition of the directly required CI check names. Workflow-contract tests, PR
// readiness, paired-issue state and paired eligibility all read this module, so a required name
// cannot drift between a workflow and its consumers. Nothing here reads the environment or PR
// input to choose a policy.

export const MUTATION_CHECK_NAME = 'mutation-report';
export const GITHUB_ACTIONS_APP_ID = 15368;

const immutable = (id, required) => Object.freeze({ id, required: Object.freeze(required) });

export const POLICIES = Object.freeze({
  'ci-v1': immutable('ci-v1', [
    'contributor-checks (ubuntu-latest)',
    'contributor-checks (windows-latest)',
    'runtime-checks (ubuntu-latest)',
    'runtime-checks (windows-latest)',
  ]),
  'ci-v2': immutable('ci-v2', [
    'static-lint',
    'static-types',
    'repository-policy',
    'pr-metadata',
    'build (ubuntu-latest)',
    'build (windows-latest)',
    'contributor-tooling-tests (ubuntu-latest)',
    'contributor-tooling-tests (windows-latest)',
    'runtime-tests (ubuntu-latest)',
    'runtime-tests (windows-latest)',
  ]),
});

// Stage A2: every ci-v2 counterpart is now executable, so this is the single reviewed source switch
// that makes it the current policy. `ci-v1` is historical-only from here and is selectable solely
// through an exact audited binding in `config/legacy-ci-heads.json`.
export const ACTIVE_POLICY_ID = 'ci-v2';

const POLICY_ORDER = Object.freeze(Object.keys(POLICIES));
// Only a policy that has already been required can be bound to an immutable merged head, so the
// newest policy is never bindable.
const BINDABLE_POLICIES = Object.freeze(POLICY_ORDER.slice(0, -1));

const WORKFLOWS = {
  contributor: '.github/workflows/contributor-checks.yml',
  runtime: '.github/workflows/runtime-checks.yml',
  prMetadata: '.github/workflows/pr-metadata.yml',
};

// Where each required name comes from, so a contract test can prove a runnable counterpart exists.
export const CHECK_JOBS = Object.freeze(Object.fromEntries([
  [POLICIES['ci-v1'].required[0], { workflow: WORKFLOWS.contributor, job: 'contributor-checks' }],
  [POLICIES['ci-v1'].required[1], { workflow: WORKFLOWS.contributor, job: 'contributor-checks' }],
  [POLICIES['ci-v1'].required[2], { workflow: WORKFLOWS.runtime, job: 'runtime-checks' }],
  [POLICIES['ci-v1'].required[3], { workflow: WORKFLOWS.runtime, job: 'runtime-checks' }],
  ['static-lint', { workflow: WORKFLOWS.contributor, job: 'static-lint' }],
  ['static-types', { workflow: WORKFLOWS.contributor, job: 'static-types' }],
  ['repository-policy', { workflow: WORKFLOWS.contributor, job: 'repository-policy' }],
  ['pr-metadata', { workflow: WORKFLOWS.prMetadata, job: 'pr-metadata' }],
  ['build (ubuntu-latest)', { workflow: WORKFLOWS.runtime, job: 'build' }],
  ['build (windows-latest)', { workflow: WORKFLOWS.runtime, job: 'build' }],
  ['contributor-tooling-tests (ubuntu-latest)', { workflow: WORKFLOWS.contributor, job: 'contributor-tooling-tests' }],
  ['contributor-tooling-tests (windows-latest)', { workflow: WORKFLOWS.contributor, job: 'contributor-tooling-tests' }],
  ['runtime-tests (ubuntu-latest)', { workflow: WORKFLOWS.runtime, job: 'runtime-tests' }],
  ['runtime-tests (windows-latest)', { workflow: WORKFLOWS.runtime, job: 'runtime-tests' }],
].map(([name, job]) => [name, Object.freeze(job)])));

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const WILDCARD = /[*?]/;
const IDENTITY_FIELDS = ['repositoryId', 'number', 'head', 'headRepositoryId', 'tree'];
const BINDING_KEYS = [...IDENTITY_FIELDS, 'policy', 'convention'];

function policyFor(policyId) {
  const policy = typeof policyId === 'string' && Object.hasOwn(POLICIES, policyId) ? POLICIES[policyId] : undefined;
  if (!policy) throw new Error(`Unknown check policy: ${String(policyId)}`);
  return policy;
}

// The active policy plus every older policy that a merged head may still be assessed under.
export function createPolicyState(policyId, bindings = []) {
  const policy = policyFor(policyId);
  const historical = POLICY_ORDER.slice(0, POLICY_ORDER.indexOf(policy.id));
  return { policy, historical: Object.freeze(historical), bindings: Object.freeze([...bindings]) };
}

// Git object ids are case-insensitive hex; comparing case-sensitively would make an upper-case
// binding unmatchable against the lower-case ids GitHub API responses normally carry.
const folded = (value) => typeof value === 'string' ? value.toLowerCase() : value;
// Every identity field must be present on both sides and agree: a field missing from both is not a
// match, it is an identity that was never audited.
const sameIdentity = (entry, pr) => IDENTITY_FIELDS.every((field) => entry[field] !== undefined && entry[field] !== null && pr[field] !== undefined && pr[field] !== null && folded(entry[field]) === folded(pr[field]));

// The binding is always looked up in the audited list; a caller cannot supply one. Accepting a binding
// argument would let a caller pass identity copied from the pull request it is trying to satisfy.
export function resolvePolicy(state, { policyId, pr } = {}) {
  const policy = policyFor(policyId);
  if (policy.id === state.policy.id) return { historical: false, policy };
  if (!state.historical.includes(policy.id)) throw new Error(`Check policy ${policy.id} is not active.`);
  if (pr?.state !== 'MERGED') throw new Error('A historical check policy requires a merged pull request.');
  const candidate = state.bindings.find((entry) => entry.policy === policy.id && sameIdentity(entry, pr));
  if (!candidate) throw new Error('No audited binding supplies the historical binding identity for this pull request.');
  return { historical: true, policy, binding: candidate };
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Historical binding identity has an invalid ${field}.`);
  return value;
}

export function parseHistoricalBindings(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Historical check bindings are not valid JSON: ${error.message}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Historical check bindings must be a JSON object.');
  }
  for (const key of Object.keys(parsed)) {
    if (key !== 'schemaVersion' && key !== 'entries') throw new Error(`Historical check bindings have an unknown top-level key: ${key}`);
  }
  if (parsed.schemaVersion !== 1) throw new Error(`Unsupported historical binding schema: ${String(parsed.schemaVersion)}`);
  if (!Array.isArray(parsed.entries)) throw new Error('Historical check bindings require an entries array.');

  const entries = [];
  const byNumber = new Set();
  const byHead = new Set();
  for (const raw of parsed.entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each historical binding must be an object.');
    for (const key of Object.keys(raw)) {
      if (!BINDING_KEYS.includes(key)) throw new Error(`Historical binding has an unknown key: ${key}`);
    }
    for (const key of BINDING_KEYS) {
      if (typeof raw[key] === 'string' && WILDCARD.test(raw[key])) {
        throw new Error(`Historical binding ${key} must not contain a wildcard.`);
      }
    }
    if (!BINDABLE_POLICIES.includes(raw.policy)) {
      throw new Error(`Each historical binding must name a bindable policy: ${BINDABLE_POLICIES.join(', ')}.`);
    }
    if (raw.convention !== undefined && ![1, 2].includes(raw.convention)) {
      throw new Error(`Unsupported historical convention: ${String(raw.convention)}.`);
    }
    const repositoryId = positiveInteger(raw.repositoryId, 'repositoryId');
    const number = positiveInteger(raw.number, 'number');
    const headRepositoryId = positiveInteger(raw.headRepositoryId, 'headRepositoryId');
    if (typeof raw.head !== 'string' || !SHA.test(raw.head)) throw new Error('Historical binding identity has an invalid head.');
    if (typeof raw.tree !== 'string' || !SHA.test(raw.tree)) throw new Error('Historical binding identity has an invalid tree.');
    const numberKey = `${repositoryId}/${number}`;
    const headKey = `${repositoryId}/${folded(raw.head)}`;
    if (byNumber.has(numberKey) || byHead.has(headKey)) {
      throw new Error(`Historical binding ${numberKey} duplicates another entry.`);
    }
    byNumber.add(numberKey);
    byHead.add(headKey);
    entries.push({
      repositoryId,
      number,
      head: raw.head,
      headRepositoryId,
      tree: raw.tree,
      policy: raw.policy,
      ...(raw.convention === undefined ? {} : { convention: raw.convention }),
    });
  }
  return entries;
}

const isGithubActions = (check) => check?.app?.slug === 'github-actions';

// Latest exact-head GitHub Actions run for each required name, in policy order. This is the shared
// selection every consumer translates into its own vocabulary; without it each consumer re-implements
// the filter-and-latest walk and can drift. Hex case is folded because a git object id has one case.
export function selectLatest({ policy, head, checks, appId } = {}) {
  if (!policy || !Array.isArray(policy.required)) throw new Error('A check policy with a required list is needed.');
  if (typeof head !== 'string' || !SHA.test(head)) throw new Error('A canonical 40- or 64-character head SHA is needed.');
  if (!Array.isArray(checks)) throw new Error('Check runs must be supplied as an array.');

  const observed = checks.filter((check) => {
    if (!check || typeof check.name !== 'string') throw new Error('Each check run needs a name and numeric id.');
    return folded(check.head_sha) === folded(head)
      && isGithubActions(check)
      && (appId === undefined || check.app?.id === appId);
  });

  return policy.required.map((name) => ({
    name,
    check: observed.filter((check) => check.name === name).sort((a, b) => Number(b.id) - Number(a.id))[0],
  }));
}

// Pure assessment over already-fetched check runs. Statuses are the shared minimum a consumer may
// translate into its own vocabulary; nothing here falls back to another policy or to a stale head.
export function evaluateRequired({ policy, head, checks, appId } = {}) {
  const latest = selectLatest({ policy, head, checks, appId });
  const missing = latest.filter(({ check }) => !check).map(({ name }) => name);
  const failed = latest.filter(({ check }) => check?.status === 'completed' && check.conclusion !== 'success').map(({ name }) => name);
  const pending = latest.some(({ check }) => check && check.status !== 'completed');
  const status = failed.length ? 'FAILED' : missing.length || pending ? 'WAITING' : 'READY';
  return { status, missing, failed };
}
