import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { ACTIVE_POLICY_ID, CHECK_JOBS, MUTATION_CHECK_NAME, POLICIES } from '../../scripts/ci/required-checks.mjs';
import { ARTIFACT_PATHS } from '../../scripts/ci/artifact-identity.mjs';

// ponytail: a line scanner for exactly these workflow documents, not a YAML parser. It reads job IDs
// at two-space indent and the `uses:`/`run:` lines inside each job. Upgrade to a real parser when a
// contract needs structure beyond that (nested maps, anchors, flow sequences).
function workflow(path) {
  // A checkout with core.autocrlf writes CRLF, so split on either ending before matching exact lines.
  const text = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => line === 'jobs:');
  assert.ok(at >= 0, `${path} declares jobs`);
  const jobs = new Map();
  let current;
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line)) break;
    const job = line.match(/^ {2}([a-z][a-z0-9-]*):$/);
    if (job) {
      current = { id: job[1], uses: [], run: [], block: [] };
      jobs.set(current.id, current);
    } else if (current) {
      current.block.push(line);
      const uses = line.match(/^\s*(?:- )?uses: (\S+)/);
      if (uses) current.uses.push(uses[1]);
      const run = line.match(/^\s*(?:- )?run: (.+)$/);
      if (run && run[1] !== '|' && run[1] !== '>') current.run.push(run[1]);
    }
  }
  const before = lines.slice(0, at).join('\n');
  return { path, text, header: before, jobs, job: (id) => jobs.get(id) };
}

const WORKFLOWS = [workflow('.github/workflows/contributor-checks.yml'), workflow('.github/workflows/runtime-checks.yml')];
const all = (predicate) => WORKFLOWS.flatMap((file) => [...file.jobs.values()].filter(predicate));

// The two matrix jobs that existed before this feature; Stage C removes them after remote read-back.
const TRANSITIONAL = [
  ['contributor-checks', '.github/workflows/contributor-checks.yml'],
  ['runtime-checks', '.github/workflows/runtime-checks.yml'],
];

test('every workflow keeps its triggers, finite limits, read-only permissions and pinned actions', () => {
  for (const file of WORKFLOWS) {
    assert.match(file.header, /^on:$/m, file.path);
    assert.match(file.header, /^ {2}push:$/m, `${file.path} keeps push`);
    assert.match(file.header, /^ {4}branches: \[main, development\]$/m, `${file.path} keeps both promoted branches`);
    assert.match(file.header, /^ {2}pull_request:$/m, `${file.path} keeps pull_request`);
    assert.match(file.header, /^ {2}workflow_dispatch:$/m, `${file.path} keeps manual dispatch`);
    assert.match(file.header, /^ {2}group: \S+-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}$/m, `${file.path} groups per PR or ref`);
    assert.match(file.header, /^ {2}cancel-in-progress: true$/m, file.path);
    assert.match(file.header, /^permissions:\n {2}contents: read$/m, `${file.path} stays read-only`);

    for (const job of file.jobs.values()) {
      assert.match(job.block.join('\n'), /^ {4}timeout-minutes: [0-9]+$/m, `${file.path}:${job.id} has a finite timeout`);
      const uses = job.block.filter((line) => /^\s*(?:- )?uses:/.test(line)).map((line) => line.match(/uses: (\S+)/)[1]);
      assert.ok(uses.length > 0, `${file.path}:${job.id} uses actions`);
      for (const action of uses) {
        if (/^actions\//.test(action)) assert.match(action, /^actions\/[a-z-]+@v[0-9]+$/, `${action} is a first-party major tag`);
        else assert.match(action, /^[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/, `${action} is pinned to a commit`);
      }
      const block = job.block.join('\n');
      assert.match(block, /persist-credentials: false/, `${file.path}:${job.id} does not persist credentials`);
      assert.doesNotMatch(block, /secrets\.|write-all|contents: write/, `${file.path}:${job.id} has no privileged access`);
    }

    for (const job of file.jobs.values()) {
      if (!job.block.some((line) => /^ {6}matrix:$/.test(line))) continue;
      assert.match(job.block.join('\n'), /fail-fast: false/, `${file.path}:${job.id} keeps both OS lanes`);
    }
  }
});

test('the four transitional old jobs are retained with their original command', () => {
  const expected = [
    ['contributor-checks', ['node scripts/ci/check-context.mjs', 'node scripts/ci/check-tracked-files.mjs', 'pnpm run lint', 'pnpm run test:contributors']],
    ['runtime-checks', ['pnpm run validate:runtime']],
  ];
  for (const [id, commands] of expected) {
    const file = WORKFLOWS.find((candidate) => candidate.job(id));
    assert.ok(file, `${id} is retained`);
    assert.match(file.job(id).block.join('\n'), /matrix:\s*\n\s*os: \[ubuntu-latest, windows-latest\]/, `${id} keeps both OS lanes`);
    for (const command of commands) assert.ok(file.job(id).run.includes(command), `${id} still runs ${command}`);
  }
  assert.deepEqual(TRANSITIONAL.map(([id]) => id), ['contributor-checks', 'runtime-checks']);
});

test('every active policy name has a runnable counterpart in its declared workflow job', () => {
  const active = POLICIES[ACTIVE_POLICY_ID].required;
  assert.equal(ACTIVE_POLICY_ID, 'ci-v1', 'Stage A2 is the only change that turns this test into a ci-v2 requirement');
  for (const name of active) {
    const { workflow: path, job } = CHECK_JOBS[name];
    const file = WORKFLOWS.find((candidate) => candidate.path === path);
    assert.ok(file, `${name} names an existing workflow ${path}`);
    const declared = file.job(job);
    assert.ok(declared, `${name} is produced by ${path}:${job}`);
    assert.ok(declared.run.length > 0, `${path}:${job} runs at least one command`);
  }
});

test('staged non-required jobs are inventoried by exact name and are not prematurely required', () => {
  const active = new Set(POLICIES[ACTIVE_POLICY_ID].required);
  const staged = [];
  for (const file of WORKFLOWS) {
    for (const id of file.jobs.keys()) {
      const names = Object.entries(CHECK_JOBS).filter(([, job]) => job.workflow === file.path && job.job === id).map(([name]) => name);
      if (!names.length) continue;
      for (const name of names) if (!active.has(name)) staged.push(name);
    }
  }
  const matrixStaged = ['build (ubuntu-latest)', 'build (windows-latest)', 'contributor-tooling-tests (ubuntu-latest)', 'contributor-tooling-tests (windows-latest)', 'runtime-tests (ubuntu-latest)', 'runtime-tests (windows-latest)'];
  assert.deepEqual([...new Set(staged)].sort(), [...matrixStaged, 'repository-policy', 'static-lint', 'static-types'].sort());
  assert.equal(staged.includes('pr-metadata'), false, 'pr-metadata is not staged by this workflow pair');
  assert.equal(Object.values(POLICIES).some((policy) => policy.required.includes(MUTATION_CHECK_NAME)), false);
  for (const id of ['static-lint', 'static-types', 'repository-policy', 'contributor-tooling-tests', 'build', 'runtime-tests']) {
    assert.ok(WORKFLOWS.some((file) => file.job(id)), `${id} is staged`);
    assert.equal(active.has(id), false, `${id} is not required while ci-v1 is current`);
  }
});

test('the build lanes reuse the clean-build-only mode and the runtime lane consumes its artifact', () => {
  const build = WORKFLOWS.find((file) => file.job('build')).job('build');
  assert.ok(build.run.includes('node scripts/ci/check-runtime.mjs --clean-build-only'), 'build uses clean-build-only');
  assert.ok(build.run.some((command) => command === 'node scripts/ci/artifact-identity.mjs write'), 'build records identity');
  assert.match(build.block.join('\n'), /^ {12}artifact-identity\.json$/m, 'identity ships with the artifact');
  assert.match(build.block.join('\n'), /^ {12}(?:tests\/runtime|dist\/tests\/runtime)$/m, 'artifact carries source and emitted tests');
  assert.match(build.block.join('\n'), /if-no-files-found: error/);

  // A lane that only received the emitted test tree cannot import the compiled code those tests
  // import, so every emitted top-level tree besides `tests` must ship and be in the verified manifest.
  // Deriving this from the build output is what catches a new emitted root, which a fixed list missed.
  const compiled = readdirSync(new URL('../../dist', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'tests')
    .map((entry) => `dist/${entry.name}`);
  for (const path of compiled) {
    assert.match(build.block.join('\n'), new RegExp(`^ {12}${path}$`, 'm'), `artifact carries ${path} that emitted tests import`);
    assert.ok(ARTIFACT_PATHS.includes(path), `the manifest covers ${path}`);
  }

  const runtime = WORKFLOWS.find((file) => file.job('runtime-tests')).job('runtime-tests');
  assert.match(runtime.block.join('\n'), /^ {4}needs: build$/m, 'runtime tests depend on the build lane');
  assert.match(runtime.block.join('\n'), /name: runtime-build-\$\{\{ matrix\.os \}\}/, 'only the matching OS artifact is downloaded');
  assert.ok(runtime.run.includes('node scripts/ci/artifact-identity.mjs verify'), 'identity is verified before the lane runs');
  assert.ok(runtime.run.includes('pnpm run test:runtime'), 'the complete emitted inventory runs');
  assert.equal(runtime.run.some((command) => command.includes('validate:runtime')), false, 'no clean rebuild replaces the verified artifact');
});

test('staged candidate lanes check out and verify H while recording distinct B and M', () => {
  const staged = all((job) => !TRANSITIONAL.some(([id]) => id === job.id));
  assert.ok(staged.length >= 6);
  for (const job of staged) {
    const block = job.block.join('\n');
    assert.match(block, /^ {10}ref: \$\{\{ env\.HEAD_SHA \}\}$/m, `${job.id} checks out H explicitly`);
    assert.match(block, /git rev-parse HEAD/, `${job.id} verifies the checkout`);
    assert.match(block, /base=\$\{BASE_SHA:-none\} merge=\$\{MERGE_SHA:-none\}/, `${job.id} records B and M as provenance`);
    // Refusal must precede side effects: identity is confirmed before dependencies are installed.
    const lines = job.block;
    const verifyAt = lines.findIndex((line) => line.includes('git rev-parse HEAD'));
    const installAt = lines.findIndex((line) => /^\s*- name: Install dependencies$/.test(line));
    if (installAt >= 0) assert.ok(verifyAt >= 0 && verifyAt < installAt, `${job.id} verifies the head before installing`);
  }
  for (const file of WORKFLOWS) {
    assert.match(file.header, /^ {2}HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/m, `${file.path} binds H to the PR head`);
    assert.match(file.header, /^ {2}BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}$/m, `${file.path} binds B separately`);
    assert.match(file.header, /^ {2}MERGE_SHA: \$\{\{ github\.sha \}\}$/m, `${file.path} binds M separately`);
  }
});

test('artifact identity inputs come from the run context, never a candidate-supplied value', () => {
  for (const id of ['build', 'runtime-tests']) {
    const job = WORKFLOWS.find((file) => file.job(id)).job(id);
    const block = job.block.join('\n');
    for (const [name, value] of [['REPOSITORY_ID', 'github.repository_id'], ['RUN_ID', 'github.run_id'], ['RUN_ATTEMPT', 'github.run_attempt']]) {
      assert.match(block, new RegExp(`^ {10}${name}: \\$\\{\\{ ${value.replace('.', '\\.')} \\}\\}$`, 'm'), `${id} binds ${name} to ${value}`);
    }
    assert.match(block, /^ {10}RUNNER_OS_LABEL: \$\{\{ matrix\.os \}\}$/m, `${id} binds the OS label`);
    assert.doesNotMatch(block, /RUNNER_OS_LABEL: \$\{\{ (?:env|inputs)\./, `${id} never takes the OS label from candidate input`);
  }
});

test('new lanes retain machine-readable results even when the lane fails', () => {
  for (const [id, results] of [['contributor-tooling-tests', 'contributor-test-results.xml'], ['runtime-tests', 'runtime-test-results.xml']]) {
    const job = WORKFLOWS.find((file) => file.job(id)).job(id);
    const block = job.block.join('\n');
    assert.match(block, /if: always\(\)/, `${id} uploads results on failure`);
    assert.match(block, new RegExp(`^ {10}path: ${results.replace('.', '\\.')}$`, 'm'), `${id} retains ${results}`);
    assert.match(block, /if-no-files-found: warn/, `${id} makes a missing results file visible instead of silent`);
    assert.match(block, /name: \S+-results-\$\{\{ matrix\.os \}\}/, `${id} separates results per OS`);
  }
});

test('no staged lane introduces a shard count or an aggregate required gate', () => {
  for (const file of WORKFLOWS) {
    assert.doesNotMatch(file.text, /shard|--shard=|[0-9]+-of-[0-9]+/i, `${file.path} stays unsharded`);
    for (const id of file.jobs.keys()) assert.doesNotMatch(id, /^(?:ci|checks|aggregate|all)$/, `${file.path} has no aggregate gate`);
  }
  assert.equal(readdirSync(new URL('../../.github/workflows', import.meta.url)).includes('pr-metadata.yml'), false, 'pr-metadata is not required to exist yet');
});
