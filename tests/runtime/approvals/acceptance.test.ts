import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listUc05CaseFixtures, UC05_CASE_IDS, UC05_LOCAL_TEST_PROFILE } from '../support/uc05/fixtures.ts';
import type { Uc05CaseId, Uc05EvidenceLevel } from '../support/uc05/fixtures.ts';

interface RunIdentity {
  readonly fixture?: string;
  readonly profile?: string;
  readonly oracle?: string;
  readonly source?: string;
  readonly evidence?: string;
}

function comparable(left: RunIdentity, right: RunIdentity): boolean {
  return (['fixture', 'profile', 'oracle', 'source', 'evidence'] as const)
    .every(key => typeof left[key] === 'string' && left[key].length > 0 && left[key] === right[key]);
}

test('two-run comparison refuses changed or missing identity instead of promoting it to pass', () => {
  const identity = { fixture: 'fixture-v1', profile: 'test-profile-v1', oracle: 'oracle-v1', source: 'source-v1', evidence: 'mock-v1' };
  assert.equal(comparable(identity, identity), true);
  for (const key of Object.keys(identity) as (keyof RunIdentity)[]) {
    assert.equal(comparable(identity, { ...identity, [key]: 'changed' }), false, key);
    assert.equal(comparable(identity, { ...identity, [key]: '' }), false, key);
    const { [key]: omitted, ...missing } = identity;
    assert.ok(omitted);
    assert.equal(comparable(identity, missing), false, key);
  }
});

/**
 * T019 reuses the existing public-consumer checks, not an oracle-driven fake SUT.
 * Each row names the local subset exercised. All fixture vectors stay registered
 * as required real/restart NOT RUN. Passing a linked local assertion does not
 * execute all vectors or establish the fixture's real dispatch/effect counters.
 * Expected oracle bodies stay in this test process and never enter child args.
 */
const witnesses: Readonly<Record<Uc05CaseId, readonly [string, ...string[]]>> = {
  C01: ['policy', 'an exact configured bounded command is allowed without a prompt', 'ordinary authentication source edits need an exact approved plan, then add no path-only prompt'],
  C02: ['policy', 'dependency, deletion, structural, configuration and configured breadth gates survive plan approval'],
  C03: ['policy', 'hard boundaries and reviewer authority cannot be overridden by a configured command', 'shell evaluation and unconfigured interpreters stay forbidden even with constrained capability assertions'],
  C04: ['contracts', 'PolicyProfile validator admits only explicit finite test bounds and rejects permissive or unknown settings'],
  C05: ['cli', 'actual subprocess records only an exact displayed response through injected host authority'],
  C06: ['control', 'actual coordinator bars every caller class on a waiting task, including alternate action identities', 'unrelated task admission remains eligible and a pause committed inside activity admission is observed'],
  C07: ['control', 'service pending fences in-flight activity and every caller; rejection requests cancellation without claiming rollback'],
  C08: ['control', 'only explicit current scoped host directions release rejection; claims and other holds remain, end retains claims', 'deadline fences late task context before direction mutation; feedback, forged authority and stale versions create no directions'],
  C09: ['service', 'explicit direction after rejection requires a fresh decision and preserves rejection across drift'],
  C10: ['control', 'actual coordinator bars every caller class on a waiting task, including alternate action identities'],
  C11: ['cli', 'control grammar rejects missing, duplicate, unknown, unsafe and injected selectors with pause retained at EOF', 'actual process interruption observes the same mock pause before submission and recorded end before lost output'],
  C12: ['service', 'racing contradictory operator responses preserve one terminal decision and duplicate delivery is harmless'],
  C13: ['service', 'actual service projects every exact plan freshness change stale and refuses the original approval', 'companion repository mapping drift is a concrete stale projection and cannot silently rebind'],
  C14: ['plan-context', 'actual human plan decision is required by the canonical Patch consumer', 'a new regression baseline and nonmaterial repository refresh require exact fresh decisions without replans'],
  C15: ['plan-context', 'three material replans retain real mock reservations and a fourth cannot be authorized by consent or a new run'],
  C16: ['plan-context', 'covered authentication edits need no path-only prompt while separate risky-action gates survive plan approval'],
  C17: ['restart-admission', 'waiting and rejected task holds survive new service and continuation instances'],
  C18: ['restart-admission', 'local reload admits a fresh approved interrupted action with a retained owner claim and complete reservation', 'lost claim response retains owner claim and reservations and forbids replay after reload or a new run'],
  C19: ['restart-admission', 'observed, uncertain and reconciled outcomes never blindly replay the interrupted decision', 'a new run with admitted owner accounting can continue while earlier task spending stays charged'],
  C20: ['control', 'failed pending/decision/direction writes and lost receipts retain closed admission without claiming noncommit'],
  C21: ['audit', 'history preserves committed request and consent separately from unknown execution after freshness drift', 'presentation refuses secret ANSI OSC bidi and over-bound complete details without writing a request'],
  C22: ['policy', 'missing, malformed, unknown or unbound trusted facts cannot authorize a command'],
  C23: ['cli', 'direct executable has no store or environment-selected test-driver composition'],
  C24: ['acceptance', 'complete local catalogs compare without converting required not-run evidence to pass'],
};

const scopes: Readonly<Record<Uc05CaseId, string>> = {
  C01: 'configured command and approved-plan source classification; no real read/tool/effect dispatch',
  C02: 'configured risky patch classification; five-element prompt covered by service regression separately',
  C03: 'trusted facts and deterministic forbidden precedence; no real containment',
  C04: 'companion profile validation; no production profile selected',
  C05: 'actual CLI host-capability refusal; no repository-container isolation proof',
  C06: 'representative mock caller classes and unrelated task; no real scheduler/provider',
  C07: 'mock in-flight fence/cancellation observations; no rollback or real effects',
  C08: 'actual service scoped directions, holds, feedback and stale versions',
  C09: 'immutable rejection and fresh request through actual service',
  C10: 'task-wide alternate identity hold; no command semantic-equivalence claim',
  C11: 'actual CLI grammar/EOF and supported process signals with retained parent mock state',
  C12: 'actual service racing responses and immutable duplicate delivery',
  C13: 'actual service canonical freshness and companion mapping changes',
  C14: 'actual service decision consumed by canonical Patch; mock context/baseline',
  C15: 'canonical retained in-memory three-slot allowance; no real restart',
  C16: 'canonical plan consumer with separate deterministic action gates',
  C17: 'new consumer instances over retained in-memory state; no runtime kill/restore',
  C18: 'mock owner claim/reservations and lost receipt across instances; no runtime kill/restore',
  C19: 'mock observed/uncertain/reconciled claims and cumulative reservations; no real effects',
  C20: 'mock failed/lost pending decision direction writes; no durable atomicity',
  C21: 'actual safe-history/presentation consumers with mock authoritative metadata',
  C22: 'exact registered trusted facts; no production composition attestation',
  C23: 'unconfigured actual executable refuses without store; no real enforcement after approval',
  C24: 'local catalog accounting and comparable runs; required real/restart cases still not-run',
};

type CheckStatus = 'pass' | 'fail' | 'not-run';
interface Check {
  readonly file: string;
  readonly name: string;
  readonly status: CheckStatus;
}
interface CaseResult {
  readonly caseId: Uc05CaseId;
  readonly identity: RunIdentity;
  readonly requiredLevel: Uc05EvidenceLevel;
  readonly requiredStatus: 'not-run' | 'pass';
  readonly requiredVectors: readonly { readonly id: string; readonly status: 'not-run' }[];
  readonly externalGates: readonly string[];
  readonly localLevel: Uc05EvidenceLevel;
  readonly localScope: string;
  readonly localStatus: 'partial' | 'error' | 'approval-only';
  readonly checks: readonly Check[];
  readonly expectedCountRef: string;
  readonly observedFixtureEffectCounts: null;
  readonly executionOutcome: 'not-observed';
}
interface LocalRun {
  readonly runId: string;
  readonly identity: RunIdentity;
  readonly platform: string;
  readonly toolchain: string;
  readonly adapter: 'existing-test-only-mock-ports';
  readonly command: readonly string[];
  readonly exitStatus: number | null;
  readonly signal: string | null;
  readonly elapsedMs: number;
  readonly outputDigest: string;
  readonly checks: readonly Check[];
  readonly cases: readonly CaseResult[];
}

const sourceRoot = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../../' : '../../../../', import.meta.url));
const suiteNames = ['contracts', 'mock-ports', 'policy', 'service', 'control', 'plan-binding', 'plan-context', 'restart-admission', 'audit', 'cli'];
const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const suitePaths = suiteNames.map(name => fileURLToPath(new URL(`${name}.test.${extension}`, import.meta.url)));

function hash(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** Hash tracked source AND working bytes, including dirty changes, never source bodies. */
function sourceIdentity(): string {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' });
  const tracked = spawnSync('git', ['ls-files', '-z', '--', 'src', 'tests/runtime', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json'], { cwd: sourceRoot, encoding: 'utf8' });
  assert.equal(revision.status, 0);
  assert.equal(tracked.status, 0);
  const files = [...new Set([...tracked.stdout.split('\0').filter(Boolean), 'tests/runtime/approvals/acceptance.test.ts'])].sort();
  return `${revision.stdout.trim()}:${hash(JSON.stringify(files.map(file => [file, hash(readFileSync(join(sourceRoot, file)))])))}`;
}

function observe(runId: string): LocalRun {
  const before = sourceIdentity();
  const command = ['--test', '--test-reporter=tap', '--test-concurrency=1', ...suitePaths];
  const started = performance.now();
  // A new test coordinator must not inherit the parent's binary worker protocol.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, command, { cwd: sourceRoot, env, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const elapsedMs = performance.now() - started;
  assert.equal(sourceIdentity(), before, 'source changed while observing a local run');
  const checks: Check[] = [];
  // Names are closed contributor-visible test metadata. Never forward child diagnostics.
  for (const line of child.stdout.split(/\r?\n/u)) {
    const match = /^(ok|not ok) \d+ - (.+?)(?: # (SKIP|TODO).*)?$/u.exec(line);
    if (match === null) continue;
    const [, result, name, skipped] = match;
    if (name === undefined) continue;
    const file = suiteNames.find(suite => readFileSync(new URL(`${suite}.test.${extension}`, import.meta.url), 'utf8').includes(`test('${name}'`));
    // Template-generated inherited checks retain a digest identity; arbitrary
    // child strings never enter this metadata report or become named witnesses.
    checks.push({ file: file ?? 'dynamic-inherited', name: file === undefined ? hash(name) : name,
      status: skipped === undefined ? result === 'ok' ? 'pass' : 'fail' : 'not-run' });
  }
  const identity = {
    fixture: hash(JSON.stringify(listUc05CaseFixtures().map(fixture => [fixture.caseId, fixture.fixtureVersion, fixture.fixtureDigest]))),
    profile: hash(JSON.stringify(UC05_LOCAL_TEST_PROFILE)),
    oracle: hash(JSON.stringify(listUc05CaseFixtures().map(fixture => [fixture.caseId, fixture.oracle.version, fixture.oracle.digest]))),
    source: before,
    evidence: hash(JSON.stringify({ adapter: 'existing-test-only-mock-ports', platform: process.platform, arch: process.arch, node: process.version, mode: extension, suites: suiteNames,
      suiteDigests: suitePaths.map(path => hash(readFileSync(path))) })),
  } satisfies RunIdentity;
  return { runId, identity, platform: `${process.platform}/${process.arch}`, toolchain: process.version, adapter: 'existing-test-only-mock-ports', command,
    exitStatus: child.status, signal: child.signal, elapsedMs, outputDigest: hash(child.stdout + child.stderr), checks,
    cases: listUc05CaseFixtures().map(fixture => {
      const [file, ...names] = witnesses[fixture.caseId];
      const observed = file === 'acceptance' ? [] : names.map(name => checks.find(check => check.file === file && check.name === name) ?? { file, name, status: 'not-run' as const });
      return {
        caseId: fixture.caseId,
        identity: { fixture: `${fixture.fixtureVersion}:${fixture.fixtureDigest}`, profile: identity.profile,
          oracle: `${fixture.oracle.version}:${fixture.oracle.digest}`, source: before, evidence: hash(JSON.stringify({ file, names, scope: scopes[fixture.caseId], parent: identity.evidence })) },
        requiredLevel: fixture.evidence.requiredLevel, requiredStatus: 'not-run',
        requiredVectors: fixture.oracle.vectors.map(vector => ({ id: vector.id, status: 'not-run' })),
        externalGates: fixture.evidence.externalGates, localLevel: fixture.evidence.localPreparationLevel,
        localScope: scopes[fixture.caseId], localStatus: child.status === 0 && observed.every(check => check.status === 'pass') ? 'partial' : 'error',
        checks: observed, expectedCountRef: fixture.oracle.digest, observedFixtureEffectCounts: null, executionOutcome: 'not-observed',
      };
    }),
  };
}

function compareCatalogs(left: LocalRun, right: LocalRun): { readonly comparable: boolean; readonly fullAcceptance: false; readonly requiredNotRun: number } {
  const complete = (run: LocalRun): boolean => run.exitStatus === 0 && run.signal === null && run.cases.length === 24
    && comparable(run.identity, run.identity)
    && new Set(run.cases.map(row => row.caseId)).size === 24
    && UC05_CASE_IDS.every(id => {
      const row = run.cases.find(candidate => candidate.caseId === id);
      const fixture = listUc05CaseFixtures().find(candidate => candidate.caseId === id);
      if (row === undefined || fixture === undefined) return false;
      const [file, ...names] = witnesses[id];
      const expectedNames = file === 'acceptance' ? [] : names;
      return row.localStatus === 'partial' && row.requiredStatus === 'not-run' && comparable(row.identity, row.identity)
        && row.identity.fixture === `${fixture.fixtureVersion}:${fixture.fixtureDigest}`
        && row.identity.oracle === `${fixture.oracle.version}:${fixture.oracle.digest}`
        && row.identity.profile === run.identity.profile && row.identity.source === run.identity.source
        && row.requiredLevel === fixture.evidence.requiredLevel && row.localLevel === fixture.evidence.localPreparationLevel
        && row.localScope === scopes[id]
        && JSON.stringify(row.requiredVectors) === JSON.stringify(fixture.oracle.vectors.map(vector => ({ id: vector.id, status: 'not-run' })))
        && row.checks.length === expectedNames.length && expectedNames.every(name => row.checks.some(check => check.file === file && check.name === name && check.status === 'pass'));
    })
    && run.checks.length === 192 && new Set(run.checks.map(check => `${check.file}:${check.name}`)).size === 192
    && run.checks.every(check => check.status === 'pass');
  const same = complete(left) && complete(right) && comparable(left.identity, right.identity)
    && left.platform === right.platform && left.toolchain === right.toolchain && left.adapter === right.adapter
    && JSON.stringify(left.command) === JSON.stringify(right.command)
    && JSON.stringify(left.checks) === JSON.stringify(right.checks)
    && left.cases.every(row => {
      const other = right.cases.find(candidate => candidate.caseId === row.caseId);
      return other !== undefined && comparable(row.identity, other.identity)
        && JSON.stringify({ ...row, identity: null }) === JSON.stringify({ ...other, identity: null });
    });
  return { comparable: same, fullAcceptance: false, requiredNotRun: left.cases.filter(row => row.requiredStatus === 'not-run').length };
}

test('complete local catalogs compare without converting required not-run evidence to pass', { timeout: 190000 }, t => {
  const left = observe('local-run-1');
  const right = observe('local-run-2');
  const comparison = compareCatalogs(left, right);
  // Metadata only: no child stdout/stderr, source bodies or expected oracle bodies.
  t.diagnostic(JSON.stringify({ schemaVersion: 'uc05-local-acceptance/1', runs: [left, right], comparison }));
  assert.deepEqual(comparison, { comparable: true, fullAcceptance: false, requiredNotRun: 24 });
  assert.equal(left.checks.length, 192, 'inherited check inventory changed; review the case mappings');
  assert.equal(left.cases.reduce((sum, row) => sum + row.requiredVectors.length, 0), 104);
  assert.equal(left.cases.every(row => row.observedFixtureEffectCounts === null && row.executionOutcome === 'not-observed'), true);

  for (const key of ['fixture', 'profile', 'oracle', 'source', 'evidence'] as const) {
    assert.equal(compareCatalogs(left, { ...right, identity: { ...right.identity, [key]: '' } }).comparable, false, key);
    assert.equal(compareCatalogs(left, { ...right, cases: right.cases.map(row => row.caseId === 'C13' ? { ...row, identity: { ...row.identity, [key]: 'changed' } } : row) }).comparable, false, key);
  }
  assert.equal(compareCatalogs(left, { ...right, cases: right.cases.slice(1) }).comparable, false);
  const duplicate = right.cases.find(row => row.caseId === 'C02');
  assert.ok(duplicate);
  assert.equal(compareCatalogs(left, { ...right, cases: [...right.cases.slice(1), duplicate] }).comparable, false);
  assert.equal(compareCatalogs(left, { ...right, checks: right.checks.slice(1) }).comparable, false);
  assert.equal(compareCatalogs(left, { ...right, exitStatus: 1 }).comparable, false);
  assert.equal(compareCatalogs(left, { ...right, cases: right.cases.map(row => row.caseId === 'C19' ? { ...row, localStatus: 'error' } : row) }).comparable, false);
  for (const status of ['not-run', 'fail'] as const) {
    const failed = { ...right, checks: right.checks.map((check, index) => index === 0 ? { ...check, status } : check) };
    assert.equal(compareCatalogs(failed, failed).comparable, false, 'matching failed/missing evidence is not a valid local result');
  }
  const approvalOnly = { ...right, cases: right.cases.map(row => row.caseId === 'C18' ? { ...row, localStatus: 'approval-only' as const } : row) };
  assert.equal(compareCatalogs(approvalOnly, approvalOnly).comparable, false);
  const mockAsReal = { ...right, cases: right.cases.map(row => ({ ...row, requiredStatus: 'pass' as const })) };
  assert.deepEqual(compareCatalogs(mockAsReal, mockAsReal), { comparable: false, fullAcceptance: false, requiredNotRun: 0 });
  const missingWitness = { ...right, cases: right.cases.map(row => row.caseId === 'C13' ? { ...row, checks: [] } : row) };
  assert.equal(compareCatalogs(missingWitness, missingWitness).comparable, false);
  const removedVector = { ...right, cases: right.cases.map(row => row.caseId === 'C17' ? { ...row, requiredVectors: [] } : row) };
  assert.equal(compareCatalogs(removedVector, removedVector).comparable, false);
});
