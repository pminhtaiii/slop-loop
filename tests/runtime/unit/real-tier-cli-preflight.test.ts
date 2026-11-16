/**
 * T060 CLI integration (real-tier contract §(i)). Every row goes through the actual
 * `loadHostConfiguration` → `resolveAssembly` → `prepareAssembly` → `preflight` → `readinessReport`
 * path with a written assembly module. The module grafts T050's `createHostAssembly()` metadata and
 * preflight onto a shell host that the bootstrap accepts, and its preflight runs over an injected
 * spawn double, so nothing here spawns Docker or reaches a network.
 *
 * Sentinels are RFC 5737 / `.invalid` values and a synthetic key; no real host, port or credential.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runEvaluateCli, type EvaluateCliOptions } from '../../../src/cli/evaluate.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { createScanFixture, type ScanFixture } from './real-tier-scan-fixtures.ts';

const fixture: ScanFixture = createScanFixture('t060-cli-', 't060-cli-digest-key');

const CONTRACT = 'uc03-owner-delivery/1';
const REV = 'a'.repeat(40);
const DIGEST = 'sha256:' + 'b'.repeat(64);
const IMAGE = 'sha256:' + 'c'.repeat(64);
const VERSION = '27.3.1';
/** The model the pinned profile names; the host file must echo it or the CLI refuses. */
const MODEL = fixture.MODEL;

/** The in-process spy the written module reads; a spawn or production call here is observable. */
interface Spy {
  calls: { command: string; args: string[]; options: Record<string, unknown> }[];
  production: number;
  preflight: number;
  mode: 'ok' | 'down' | 'mismatch';
  variant: 'plain' | 'full';
  metadataPatch: Record<string, unknown> | undefined;
  /** Replaces the real preflight result, so an assembly module can return an arbitrary value. */
  preflightPatch: unknown;
  env: unknown;
  stateRoot: string | undefined;
}

function hostFile(requestedModel = MODEL, assembly?: string): string {
  const directory = mkdtempSync(join(tmpdir(), 't060-host-'));
  const path = join(directory, 'host.json');
  writeFileSync(
    path,
    JSON.stringify({
      profileId: 'profile-001',
      profileDigest: DIGEST,
      configDigest: DIGEST,
      pricingDigest: DIGEST,
      requestedModel,
      adapterVersions: ['uc03-adapter-1'],
      contractVersion: CONTRACT,
      revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, REV])),
      ...(assembly === undefined ? {} : { assembly }),
    }),
    'utf8',
  );
  return path;
}

/** Authored `.ts`, compiled `.js`: the module's own extension picks the counterpart it imports. */
const SOURCE = import.meta.url.endsWith('.ts') ? '.ts' : '.js';

/**
 * The assembly module the CLI imports. `variant: 'plain'` is a pre-T060 assembly; `full` adds the
 * §(i) metadata and the real preflight, whose spawn double answers from the spy's mode.
 */
function assemblyModule(): string {
  const directory = mkdtempSync(join(tmpdir(), 't060-assembly-'));
  const path = join(directory, 'assembly.mjs');
  const types = pathToFileURL(fileURLToPath(new URL(`../../../src/uc03/graph-types-v02${SOURCE}`, import.meta.url))).href;
  const real = pathToFileURL(fileURLToPath(new URL(`../../../src/runtime/real-tier-assembly${SOURCE}`, import.meta.url))).href;
  writeFileSync(
    path,
    `import { REQUIRED_PORTS_V02_METHODS as METHODS, UC03_PRODUCTION_COMPONENTS_V02 as COMPONENTS, portDeclarationsV02 as DECLARATIONS } from ${JSON.stringify(types)};
import { createHostAssembly as realAssembly } from ${JSON.stringify(real)};
// In a child process the in-process spy is absent; the defaults keep the same code path observable.
const SPY = globalThis.__t060 ?? { calls: [], production: 0, preflight: 0, mode: 'ok', variant: 'full', metadataPatch: undefined, preflightPatch: undefined, env: undefined, stateRoot: undefined };
const CONTRACT = ${JSON.stringify(CONTRACT)};
const REV = ${JSON.stringify(REV)};
const DIGEST = ${JSON.stringify(DIGEST)};
const IMAGE = ${JSON.stringify(IMAGE)};
const HOST = ['guardedRead', 'baselineEvidence', 'hostAuthority', 'contextSource'];
const shell = component => ({
  component,
  id: component + '-id',
  contractVersion: CONTRACT,
  revision: REV,
  provenance: 'real',
  adapter: { provenance: 'real', ...DECLARATIONS(component), ...Object.fromEntries(METHODS[component].map(method => [method, () => undefined])) },
});
const spawn = async (command, args, options) => {
  SPY.calls.push({ command, args: [...args], options: { ...options } });
  if (command !== 'docker') return { exitCode: 1, stdout: '', stderr: '', timedOut: false };
  if (args[0] === 'version') return SPY.mode === 'down' ? { exitCode: 1, stdout: '', stderr: 'daemon down', timedOut: false } : { exitCode: 0, stdout: '${VERSION}\\n', stderr: '', timedOut: false };
  // The inspect answers with the id it was asked about: the profile's own pinned image.
  return SPY.mode === 'mismatch' ? { exitCode: 1, stdout: '', stderr: 'No such image', timedOut: false } : { exitCode: 0, stdout: args[4] + '\\n', stderr: '', timedOut: false };
};
export function createHostAssembly() {
  const host = {
    owner: COMPONENTS.filter(component => !HOST.includes(component)).map(shell),
    producers: {
      guardedRead: { provenance: 'real', mediateRead: () => undefined },
      baselineEvidence: { provenance: 'real', persistBaselineEvidence: () => undefined, loadBaselineEvidence: () => undefined },
      hostAuthority: { loadSnapshot: () => undefined },
      contextSource: { provenance: 'real', observe: () => undefined },
    },
    config: {
      trustedExpectedContext: {
        taskId: 'task-calc-001',
        workspaceId: 'workspace-001',
        repositoryId: 'repo-calc',
        revisionDigest: DIGEST,
        criteriaDigest: DIGEST,
        checkSetDigest: DIGEST,
        expectedTestFiles: ['tests/test_calculator.py'],
      },
    },
  };
  if (SPY.variant === 'plain') return { host };
  const built = realAssembly({ env: SPY.env ?? process.env, spawn, stateRoot: SPY.stateRoot, revision: REV });
  if (built.status === 'unavailable') return built;
  return {
    host,
    metadata: { ...built.metadata, ...(SPY.metadataPatch ?? {}) },
    preflight: async () => {
      SPY.preflight += 1;
      return SPY.preflightPatch === undefined ? built.preflight() : SPY.preflightPatch;
    },
    production: () => {
      SPY.production += 1;
      return { executeCase: () => ({ blocked: null }) };
    },
  };
}
`,
    'utf8',
  );
  return path;
}

const STATE_ROOT = mkdtempSync(join(tmpdir(), 't060-state-'));

/** Install the spy and the profile environment the module's real assembly reads. */
function install(patch: Partial<Spy> = {}): Spy {
  const value: Spy = {
    calls: [],
    production: 0,
    preflight: 0,
    mode: 'ok',
    variant: 'full',
    metadataPatch: undefined,
    preflightPatch: undefined,
    env: fixture.envOf(),
    stateRoot: STATE_ROOT,
    ...patch,
  };
  (globalThis as unknown as { __t060: Spy }).__t060 = value;
  return value;
}

const options = (): EvaluateCliOptions => ({ profileDigest: DIGEST, configDigest: DIGEST, pricingDigest: DIGEST, adapterVersions: ['uc03-adapter-1'], requestedModel: MODEL });

test('a metadata-bearing assembly is ready and reports only the allowlisted metadata keys', async () => {
  const state = install();
  const result = await runEvaluateCli(['preflight', '--host', hostFile(MODEL, assemblyModule())], options());
  assert.equal(result.exitCode, 0, result.output);
  const report = JSON.parse(result.output) as {
    readonly outcome: string;
    readonly assembly: string;
    readonly operational: string;
    readonly components: readonly string[];
    readonly metadata: Record<string, unknown>;
  };
  assert.equal(report.outcome, 'ready');
  assert.equal(report.assembly, 'ready');
  assert.equal(report.operational, 'ready');
  assert.deepEqual(report.components, [...UC03_PRODUCTION_COMPONENTS_V02]);
  assert.deepEqual(Object.keys(report.metadata).sort(), ['endpointDigest', 'endpointScheme', 'imageId', 'insecureHttpAcknowledged', 'model', 'profileDigest']);
  assert.equal(report.metadata.model, MODEL);
  assert.equal(report.metadata.imageId, state.calls[1]?.args[4], 'the reported id is the one the inspect was asked about');
  assert.match(String(report.metadata.imageId), /^sha256:[a-f0-9]{64}$/u);
  assert.match(String(report.metadata.profileDigest), /^sha256:[a-f0-9]{64}$/u);
  assert.match(String(report.metadata.endpointDigest), /^sha256:[a-f0-9]{64}$/u);

  // Exactly the two fixed commands, through the assembly's own preflight, with the bounded options.
  assert.equal(state.preflight, 1);
  assert.deepEqual(
    state.calls.map(call => [call.command, call.args]),
    [
      ['docker', ['version', '--format', '{{.Server.Version}}']],
      ['docker', ['image', 'inspect', '--format', '{{.Id}}', String(report.metadata.imageId)]],
    ],
  );
  for (const call of state.calls) assert.deepEqual(call.options, { timeoutMs: 10_000, maxOutputBytes: 4_096 });
  assert.equal(state.production, 0, 'preflight never allocates');
});

test('unknown metadata keys and pattern violations give HOST_METADATA_INVALID before any preflight', async () => {
  const patches: readonly Record<string, unknown>[] = [
    { extra: 'value' },
    { profileDigest: 'sha256:' + 'A'.repeat(64) },
    { profileDigest: 'not-a-digest' },
    { endpointDigest: 'http://192.0.2.10:54321/v1/messages' },
    { endpointScheme: 'ftp' },
    { insecureHttpAcknowledged: 'yes' },
    { model: '' },
    { model: 'bad model with spaces' },
    { imageId: 'sha256:short' },
  ];
  for (const metadataPatch of patches) {
    const state = install({ metadataPatch });
    const result = await runEvaluateCli(['preflight', '--host', hostFile(MODEL, assemblyModule())], options());
    assert.equal(result.exitCode, 4, JSON.stringify(metadataPatch));
    assert.equal(JSON.parse(result.output).error, 'HOST_METADATA_INVALID', JSON.stringify(metadataPatch));
    assert.deepEqual(state.calls, [], 'invalid metadata is refused before the operational probe');
    assert.equal(state.preflight, 0);
    assert.equal(result.output.includes('192.0.2.10'), false);
    assert.equal(result.output.includes('54321'), false);
  }
});

test('a host-file requestedModel that differs from the pinned metadata model gives HOST_MODEL_MISMATCH', async () => {
  const state = install();
  const result = await runEvaluateCli(['preflight', '--host', hostFile('some-other-model', assemblyModule())], options());
  assert.equal(result.exitCode, 4, result.output);
  assert.equal(JSON.parse(result.output).error, 'HOST_MODEL_MISMATCH');
  // The model check is before the probe, so a dead daemon never masks a binding mismatch.
  assert.deepEqual(state.calls, []);
});

test('a preflight failure gives exit 4 with its reason, no allocation and no task effect', async () => {
  for (const [mode, reasonCode] of [
    ['down', 'docker-unavailable'],
    ['mismatch', 'image-mismatch'],
  ] as const) {
    for (const command of ['preflight', 'run'] as const) {
      // `run` is the row that proves the refusal precedes allocation: the production binding never runs.
      const state = install({ mode });
      const result = await runEvaluateCli([command, '--host', hostFile(MODEL, assemblyModule()), ...(command === 'run' ? ['--cases', 'C01'] : [])], options());
      assert.equal(result.exitCode, 4, `${command}: ${result.output}`);
      const report = JSON.parse(result.output) as { readonly assembly: string; readonly operational: string; readonly metadata: Record<string, unknown> };
      assert.equal(report.assembly, 'ready', 'the static stage passed; only the operational stage refused');
      assert.equal(report.operational, reasonCode);
      assert.equal(report.metadata.model, MODEL);
      assert.equal(state.production, 0, 'no route was bound, so nothing could be allocated');
      // The first command failed, so no inspect ran for a dead daemon.
      assert.equal(state.calls.length, mode === 'down' ? 1 : 2);
    }
  }
});

test('a thrown preflight is the same docker-unavailable refusal', async () => {
  const state = install();
  const directory = mkdtempSync(join(tmpdir(), 't060-throwing-'));
  const path = join(directory, 'assembly.mjs');
  const module = assemblyModule();
  // Wrap the module: the spy stays the same, only the preflight throws.
  writeFileSync(
    path,
    `import { createHostAssembly as base } from ${JSON.stringify(pathToFileURL(module).href)};\nexport function createHostAssembly() { const value = base(); return { ...value, preflight: async () => { throw new Error('probe-detail-9f2'); } }; }\n`,
    'utf8',
  );
  const result = await runEvaluateCli(['preflight', '--host', hostFile(MODEL, path)], options());
  assert.equal(result.exitCode, 4);
  assert.equal((JSON.parse(result.output) as { readonly operational?: unknown }).operational, 'docker-unavailable');
  assert.equal(result.output.includes('probe-detail-9f2'), false);
  assert.equal(state.production, 0);
});

test('a preflight reasonCode outside the fixed set is refused, never projected', async () => {
  // A preflight is imported host code: its result is unknown, so only the allowlisted variants project.
  const hostile = {
    ok: false,
    reasonCode: `https://sentinel.invalid/private?api_key=${fixture.KEY}`,
    sentinel: fixture.DIGEST_KEY,
  };
  const state = install({ preflightPatch: hostile });
  const result = await runEvaluateCli(['preflight', '--host', hostFile(MODEL, assemblyModule())], options());
  assert.equal(result.exitCode, 4, result.output);
  const report = JSON.parse(result.output) as { readonly assembly?: string; readonly operational?: string; readonly metadata?: unknown };
  assert.equal(report.assembly, 'ready', 'the static stage passed; only the operational stage refused');
  assert.equal(report.operational, 'docker-unavailable', 'an unrecognized result maps to the fixed code');
  for (const needle of [fixture.KEY, 'sentinel.invalid', 'api_key']) {
    assert.equal(result.output.includes(needle), false, `${needle} must not reach the output`);
  }
  assert.equal(state.production, 0);
});

test('a preflight ok:true with an unexpected version or image does not project it', async () => {
  for (const patch of [
    { ok: true, dockerServerVersion: `https://sentinel.invalid/${fixture.KEY}`, imageId: `sha256:${'c'.repeat(64)}` },
    { ok: true, dockerServerVersion: '27.3.1', imageId: `https://sentinel.invalid/${fixture.KEY}` },
    { ok: true },
    { ok: 'yes', reasonCode: 'docker-unavailable' },
    'sentinel',
  ]) {
    install({ preflightPatch: patch });
    const result = await runEvaluateCli(['preflight', '--host', hostFile(MODEL, assemblyModule())], options());
    const report = JSON.parse(result.output) as { readonly operational?: string };
    assert.equal(report.operational, 'docker-unavailable', JSON.stringify(patch));
    assert.equal(result.output.includes('sentinel.invalid'), false, JSON.stringify(patch));
    assert.equal(result.output.includes(fixture.KEY), false, JSON.stringify(patch));
  }
});

test('an assembly without metadata or preflight keeps the pre-T060 output exactly', async () => {
  const state = install({ variant: 'plain' });
  const result = await runEvaluateCli(['preflight', '--host', hostFile(MODEL, assemblyModule())], options());
  assert.equal(result.exitCode, 0, result.output);
  const report = JSON.parse(result.output) as Record<string, unknown>;
  assert.deepEqual(Object.keys(report).sort(), ['components', 'identity', 'outcome']);
  assert.equal(report.outcome, 'ready');
  assert.equal('metadata' in report, false);
  assert.equal('operational' in report, false);
  assert.equal('assembly' in report, false);
  assert.deepEqual(state.calls, [], 'an assembly with no preflight runs no command');
});

test('the sentinel credential and endpoint never appear in stdout or stderr', () => {
  install();
  const assembly = assemblyModule();
  // A child process: the profile environment is the only channel, and the module's own defaults apply.
  const result: SpawnSyncReturns<string> = spawnSync(
    process.execPath,
    [fileURLToPath(new URL(`../../../src/cli/evaluate${SOURCE}`, import.meta.url)), 'preflight', '--host', hostFile(MODEL, assembly)],
    {
      encoding: 'utf8',
      windowsHide: true,
      // Only the fixture's own values: an inherited provider variable would make the endpoint ambiguous.
      env: fixture.envOf() as unknown as NodeJS.ProcessEnv,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const needle of [fixture.KEY, fixture.HREF, '192.0.2.10', '54321', '/v1/messages', fixture.DIGEST_KEY, assembly]) {
    assert.equal(result.stdout.includes(needle), false, 'stdout must not carry a sentinel or the module path');
    assert.equal(result.stderr.includes(needle), false, 'stderr must not carry a sentinel or the module path');
  }
  assert.equal(result.stderr, '');
});
