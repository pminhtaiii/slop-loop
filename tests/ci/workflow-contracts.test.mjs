import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

const WORKFLOWS = [
  workflow('.github/workflows/contributor-checks.yml'),
  workflow('.github/workflows/runtime-checks.yml'),
  workflow('.github/workflows/pr-metadata.yml'),
];
const all = (predicate) => WORKFLOWS.flatMap((file) => [...file.jobs.values()].filter(predicate));

test('every workflow keeps its triggers, finite limits, read-only permissions and pinned actions', () => {
  for (const file of WORKFLOWS) {
    assert.match(file.header, /^on:$/m, file.path);
    // The metadata workflow observes pull-request edits only; the code lanes also run on promoted
    // branches and manual dispatch. Neither may lose its own required trigger.
    if (file.path.endsWith('pr-metadata.yml')) {
      assert.match(file.header, /^ {2}pull_request:\n {4}types: \[opened, reopened, synchronize, edited, ready_for_review, converted_to_draft\]$/m, `${file.path} observes the metadata-relevant events`);
      assert.doesNotMatch(file.header, /^ {2}(?:push|workflow_dispatch):$/m, `${file.path} runs no code lane`);
    } else {
      assert.match(file.header, /^ {2}push:$/m, `${file.path} keeps push`);
      assert.match(file.header, /^ {4}branches: \[main, development\]$/m, `${file.path} keeps both promoted branches`);
      assert.match(file.header, /^ {2}pull_request:$/m, `${file.path} keeps pull_request`);
      assert.match(file.header, /^ {2}workflow_dispatch:$/m, `${file.path} keeps manual dispatch`);
    }
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
      // A secret *expression* is the privileged read; the substring alone also matches a script
      // filename such as `scan-secrets.mjs`.
      assert.doesNotMatch(block, /\$\{\{\s*secrets\.|write-all|contents: write/, `${file.path}:${job.id} has no privileged access`);
    }

  }
});

test('obsolete contributor and runtime matrix jobs are absent', () => {
  for (const file of WORKFLOWS) {
    assert.equal(file.jobs.has('contributor-checks'), false);
    assert.equal(file.jobs.has('runtime-checks'), false);
    assert.doesNotMatch(file.text, /windows-latest|matrix\.os|strategy:/);
  }
});

// A required check that a job does not actually perform is a green light over nothing. `run.length > 0`
// is satisfied by `echo`, so each gate names the exact command that must be present.
// Splitting on the shell separators and requiring a segment to *start* with the command rejects
// `echo node scripts/...` while still finding a validator after `&&`, in a `run: |` body, or inline.
// Comment lines are dropped: a commented-out command is documentation, not a gate.
function runsCommand(lines, command) {
  return lines
    .filter((line) => !/^\s*#/.test(line))
    .flatMap((line) => line.split(/\s*(?:&&|\|\||;|\|)\s*/))
    .map((segment) => segment.trim().replace(/^(?:- )?run: /, ''))
    .some((segment) => segment.startsWith(command));
}
const REQUIRED_COMMANDS = {
  'static-lint': ['pnpm run lint'],
  'static-types': ['pnpm run typecheck'],
  'repository-policy': ['node scripts/ci/check-context.mjs', 'node scripts/ci/check-tracked-files.mjs', 'node scripts/ci/check-env-examples.mjs', 'node scripts/ci/scan-secrets.mjs'],
  'pr-metadata': ['node scripts/ci/check-pr-metadata.mjs'],
  'build': ['node scripts/ci/check-runtime.mjs --clean-build-only'],
  'runtime-tests': ['node scripts/ci/artifact-identity.mjs verify', 'pnpm run test:runtime'],
  'contributor-tooling-tests': ['pnpm run test:contributors'],
};

test('every active policy name has a runnable counterpart in its declared workflow job', () => {
  const active = POLICIES[ACTIVE_POLICY_ID].required;
  // Ubuntu-only activation: all seven counterparts must be executable, including the separate metadata
  // workflow. A missing one is a required check that could never report.
  assert.equal(ACTIVE_POLICY_ID, 'ci-v4');
  assert.equal(active.length, 7);
  for (const name of active) {
    const { workflow: path, job } = CHECK_JOBS[name];
    const file = WORKFLOWS.find((candidate) => candidate.path === path);
    assert.ok(file, `${name} names an existing workflow ${path}`);
    const declared = file.job(job);
    assert.ok(declared, `${name} is produced by ${path}:${job}`);
    assert.ok(declared.run.length > 0, `${path}:${job} runs at least one command`);
    // The gate must actually run its validator, not merely some command. Both inline `run:` and
    // `run: |` bodies count, so the whole job is searched with comment lines removed — a commented-out
    // command is documentation, not a gate. The scan-secrets invocation is a block body, which is why
    // `declared.run` alone cannot see it.
    const commands = REQUIRED_COMMANDS[job];
    assert.ok(commands, `${job} declares the commands it must run`);
    for (const command of commands) {
      assert.ok(runsCommand(declared.block, command), `${path}:${job} must run ${command}`);
    }
  }
  assert.deepEqual(Object.keys(REQUIRED_COMMANDS).sort(), [...new Set(active.map((name) => CHECK_JOBS[name].job))].sort(), 'every required job has a documented command set');
});

test('the command matcher refuses a mention and accepts a command position', () => {
  assert.equal(runsCommand(['        run: echo node scripts/ci/check-context.mjs'], 'node scripts/ci/check-context.mjs'), false, 'echoing a command does not run it');
  assert.equal(runsCommand(['        # run: node scripts/ci/check-context.mjs'], 'node scripts/ci/check-context.mjs'), false, 'a commented command is documentation');
  // The real metadata invocation puts the validator after `&&`, mid-line.
  const compound = ['        run: root=base; [ -f base/scripts/ci/check-pr-metadata.mjs ] || root=candidate; cd "$root" && node scripts/ci/check-pr-metadata.mjs "$EVENT_PATH"'];
  assert.equal(runsCommand(compound, 'node scripts/ci/check-pr-metadata.mjs'), true);
  // A `run: |` body line at arbitrary indent counts.
  assert.equal(runsCommand(['          node scripts/ci/scan-secrets.mjs --exemptions x.json'], 'node scripts/ci/scan-secrets.mjs'), true);
});

test('the seven bare required names match all emitted jobs and the protection mirror', () => {
  const expected = ['static-lint', 'static-types', 'repository-policy', 'pr-metadata', 'build', 'contributor-tooling-tests', 'runtime-tests'];
  assert.deepEqual([...POLICIES[ACTIVE_POLICY_ID].required], expected);
  assert.deepEqual(WORKFLOWS.flatMap((file) => [...file.jobs.keys()]).sort(), [...expected].sort());
  const mirror = JSON.parse(readFileSync(new URL('../../.github/branch-protection.json', import.meta.url), 'utf8'));
  assert.equal(mirror.required_status_checks.strict, true);
  assert.equal(mirror.enforce_admins, true);
  assert.deepEqual(mirror.required_status_checks.checks, expected.map((context) => ({ context, app_id: 15368 })));
  for (const file of WORKFLOWS) for (const job of file.jobs.values()) {
    assert.match(job.block.join('\n'), /^ {4}runs-on: ubuntu-latest$/m, job.id);
    assert.doesNotMatch(job.block.join('\n'), /^ {4}name:/m, 'job IDs are the exact bare check names');
  }
  assert.equal(Object.values(POLICIES).some((policy) => policy.required.includes(MUTATION_CHECK_NAME)), false);
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
  // Deriving this from tsconfig rather than a fixed list is what catches a new source root; it also
  // works in lanes that never build.
  const tsconfig = JSON.parse(readFileSync(new URL('../../tsconfig.json', import.meta.url), 'utf8'));
  const compiled = [...new Set(tsconfig.include.map((entry) => entry.split('/')[0]))]
    .filter((name) => name !== 'tests')
    .map((name) => `dist/${name}`);
  assert.ok(compiled.length, 'tsconfig declares at least one compiled source root');
  for (const path of compiled) {
    assert.match(build.block.join('\n'), new RegExp(`^ {12}${path}$`, 'm'), `artifact carries ${path} that emitted tests import`);
    assert.ok(ARTIFACT_PATHS.includes(path), `the manifest covers ${path}`);
  }

  const runtime = WORKFLOWS.find((file) => file.job('runtime-tests')).job('runtime-tests');
  assert.match(runtime.block.join('\n'), /^ {4}needs: build$/m, 'runtime tests depend on the build lane');
  assert.match(runtime.block.join('\n'), /name: runtime-build-ubuntu-latest/, 'only the matching OS artifact is downloaded');
  assert.ok(runtime.run.includes('node scripts/ci/artifact-identity.mjs verify'), 'identity is verified before the lane runs');
  assert.ok(runtime.run.includes('pnpm run test:runtime'), 'the complete emitted inventory runs');
  assert.equal(runtime.run.some((command) => command.includes('validate:runtime')), false, 'no clean rebuild replaces the verified artifact');
});

test('staged candidate lanes check out and verify H while recording distinct B and M', () => {
  // The metadata lane consumes its event payload instead of a working tree, so it is not a
  // candidate-code lane; every other job must bind and verify H.
  const staged = all((job) => job.id !== 'pr-metadata');
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
  // The metadata lane must read the payload as data and must never execute candidate code. It does
  // check out the head tree now, but only as the bootstrap fallback for the PR that introduces the
  // validator; the base copy is preferred whenever it exists, so an editing PR cannot certify itself.
  const metadata = WORKFLOWS.find((file) => file.job('pr-metadata')).job('pr-metadata');
  const metadataBlock = metadata.block.join('\n');
  assert.match(metadataBlock, /^ {10}ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}$/m, 'the metadata lane checks out the base revision');
  assert.doesNotMatch(metadataBlock, /ref: \$\{\{ env\.HEAD_SHA \}\}/, 'the metadata lane never checks out the candidate head through the shared env binding');
  assert.doesNotMatch(metadataBlock, /pnpm install|pnpm run|node --test/, 'metadata runs no candidate code');
  assert.match(metadataBlock, /EVENT_PATH: \$\{\{ github\.event_path \}\}/, 'the event payload arrives as a path, never as shell text');
  for (const file of WORKFLOWS.filter((candidate) => !candidate.path.endsWith('pr-metadata.yml'))) {
    assert.match(file.header, /^ {2}HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/m, `${file.path} binds H to the PR head`);
    assert.match(file.header, /^ {2}BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}$/m, `${file.path} binds B separately`);
    assert.match(file.header, /^ {2}MERGE_SHA: \$\{\{ github\.sha \}\}$/m, `${file.path} binds M separately`);
  }
});

test('the metadata lane grades with the base copy and falls back to the head copy only when absent', () => {
  // Pinning alone deadlocks the introducing PR: its base tree has no validator, and ci-v2 requires
  // this job. Both revisions are checked out; the base copy wins whenever it exists.
  const metadata = WORKFLOWS.find((file) => file.job('pr-metadata')).job('pr-metadata');
  const block = metadata.block.join('\n');
  assert.match(block, /^ {10}ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\n {10}path: base$/m, 'the base revision is checked out as the preferred grader');
  assert.match(block, /^ {10}ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}\n {10}path: candidate$/m, 'the head revision is checked out as the bootstrap fallback');
  assert.match(block, /^ {8}run: root=base; \[ -f base\/scripts\/ci\/check-pr-metadata\.mjs \] \|\| root=candidate; cd "\$root" && node scripts\/ci\/check-pr-metadata\.mjs "\$EVENT_PATH"$/m, 'presence selects the base copy, else the head copy, then runs the literal command');
  // The fallback exists only for the introducing PR: once this change merges, the path must be present
  // or every later run has no validator at all, and the unreachable fallback branch hides that.
  assert.ok(existsSync(new URL('../../scripts/ci/check-pr-metadata.mjs', import.meta.url)), 'the working tree ships the validator the fallback runs');
});

test('artifact identity inputs come from the run context, never a candidate-supplied value', () => {
  for (const id of ['build', 'runtime-tests']) {
    const job = WORKFLOWS.find((file) => file.job(id)).job(id);
    const block = job.block.join('\n');
    for (const [name, value] of [['REPOSITORY_ID', 'github.repository_id'], ['RUN_ID', 'github.run_id'], ['RUN_ATTEMPT', 'github.run_attempt']]) {
      assert.match(block, new RegExp(`^ {10}${name}: \\$\\{\\{ ${value.replace('.', '\\.')} \\}\\}$`, 'm'), `${id} binds ${name} to ${value}`);
    }
    assert.match(block, /^ {10}RUNNER_OS_LABEL: ubuntu-latest$/m, `${id} binds the OS label`);
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
    assert.match(block, /name: \S+-results-ubuntu-latest/, `${id} separates results per OS`);
  }
});

test('no staged lane introduces a shard count or an aggregate required gate', () => {
  for (const file of WORKFLOWS) {
    assert.doesNotMatch(file.text, /shard|--shard=|[0-9]+-of-[0-9]+/i, `${file.path} stays unsharded`);
    for (const id of file.jobs.keys()) assert.doesNotMatch(id, /^(?:ci|checks|aggregate|all)$/, `${file.path} has no aggregate gate`);
  }
  // Stage A2 requires this file to exist; before activation the same assertion rejected its presence.
  assert.equal(readdirSync(new URL('../../.github/workflows', import.meta.url)).includes('pr-metadata.yml'), true, 'the metadata workflow exists once it is required');
});

// A historical job mapping must never accidentally restore a canonical Windows runner.
test('canonical build and complete test inventories run only on Ubuntu', () => {
  for (const id of ['build', 'runtime-tests', 'contributor-tooling-tests']) {
    const job = WORKFLOWS.find((file) => file.job(id)).job(id);
    assert.match(job.block.join('\n'), /^ {4}runs-on: ubuntu-latest$/m, id);
    assert.doesNotMatch(job.block.join('\n'), /windows-latest/, id);
  }
});
