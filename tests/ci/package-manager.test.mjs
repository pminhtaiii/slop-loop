import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const projectManifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const root = mkdtempSync(join(tmpdir(), 'slop-loop-package-manager-'));
const manifest = {
  name: 'slop-loop-package-manager-check',
  version: '1.0.0',
  private: true,
  packageManager: projectManifest.packageManager,
  devEngines: projectManifest.devEngines,
  scripts: { 'check:manager': 'node -e "console.log(\'manager-check-ran\')"' },
};

assert.match(projectManifest.packageManager, /^pnpm@/);
assert.equal(projectManifest.devEngines?.packageManager?.name, 'pnpm');
writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));

after(() => {
  if (dirname(resolve(root)) === resolve(tmpdir())) rmSync(root, { recursive: true, force: true });
});

function runManager(manager, action = 'run check:manager') {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'npm_config_user_agent') delete env[key];
  }

  const args = `${manager} ${action}`;
  return process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', args], { cwd: root, env, encoding: 'utf8', windowsHide: true })
    : spawnSync(manager, action.split(' '), { cwd: root, env, encoding: 'utf8' });
}

test('pnpm can run project scripts under the package manager requirement', () => {
  const result = runManager('pnpm');
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /manager-check-ran/);
});

test('npm is refused before a project script runs', () => {
  const result = runManager('npm');
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /manager-check-ran/);
});

test('pnpm can install with the package manager requirement', () => {
  const result = runManager('pnpm', 'install --dry-run --lockfile=false --ignore-scripts --offline');
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('npm install is refused even when lifecycle scripts are ignored', () => {
  const result = runManager('npm', 'install --dry-run --package-lock=false --ignore-scripts --offline');
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, result.stdout);
});
