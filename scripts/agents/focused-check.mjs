import { createHash } from 'node:crypto';
import { mkdir, lstat, open, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, git, repository } from './agent-store.mjs';
import { capture } from './factory-state-checks.mjs';
import { runGate } from './workflow-gate.mjs';

const usage = 'Usage: focused-check.mjs <run|verify> --root <checkout> --receipt <.agent-work/session/check.json> --input <path>... -- <command> [args...]';
const hashPattern = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');

function parse(args) {
  const [mode, ...rest] = args;
  const separator = rest.indexOf('--');
  if (!['run', 'verify'].includes(mode) || separator < 0) throw new Error(usage);
  const options = rest.slice(0, separator),
    command = rest.slice(separator + 1);
  const values = { inputs: [] };
  for (let index = 0; index < options.length;) {
    const name = options[index].startsWith('--') ? options[index].slice(2) : '';
    const value = options[index + 1];
    if (!['root', 'receipt', 'input'].includes(name) || !value || value.startsWith('--')) throw new Error(usage);
    if (name === 'input') values.inputs.push(value);
    else if (values[name]) throw new Error(usage);
    else values[name] = value;
    index += 2;
  }
  if (!values.inputs.length || !values.receipt || !command.length || !command[0]) throw new Error(usage);
  return { mode, root: resolve(values.root ?? process.cwd()), receipt: values.receipt, inputs: values.inputs, command };
}

function relativePath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.trim() !== path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes(':') ||
    path.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()))
  )
    throw new Error(`Unsafe repository path: ${path}`);
  return path;
}

async function fileBytes(root, path) {
  relativePath(path);
  let current = root;
  const parts = path.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error(`Not a regular file: ${path}`);
  }
  return readFile(current);
}

async function artifactPath(root, path, { create = false } = {}) {
  relativePath(path);
  if (!path.startsWith('.agent-work/')) throw new Error('Receipts and logs must stay under ignored .agent-work/.');
  if (git(root, ['check-ignore', '--quiet', '--', path], true).status !== 0) throw new Error(`Output must be Git-ignored: ${path}`);
  const parts = path.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (create)
      await mkdir(current).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe artifact directory: ${current}`);
  }
  return join(current, parts.at(-1));
}

async function fingerprints(root, paths) {
  const unique = new Set();
  const result = [];
  for (const path of paths) {
    relativePath(path);
    if (unique.has(path)) throw new Error(`Duplicate input path: ${path}`);
    unique.add(path);
    result.push({ path, sha256: digest(await fileBytes(root, path)) });
  }
  return result;
}

function environment(root, inputs) {
  return { root, nodeVersion: process.version, platform: process.platform, arch: process.arch, declaredInputsSha256: digest(JSON.stringify(inputs)) };
}

function fingerprintReceipt(payload) {
  return { ...payload, digest: digest(JSON.stringify(payload)) };
}

function validateReceiptDigest(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || !hashPattern.test(receipt.digest ?? '')) throw new Error('Malformed focused-check receipt.');
  const { digest: checksum, ...payload } = receipt;
  if (digest(JSON.stringify(payload)) !== checksum) throw new Error('Receipt digest mismatch.');
  return payload;
}

async function fileDigest(path) {
  const handle = await open(path, 'r');
  const hash = createHash('sha256'),
    buffer = Buffer.alloc(64 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function executeRun(state, repo, inputHashes, outputPath, logPath) {
  const before = await capture(repo.root);
  const inputsBeforeRun = await fingerprints(repo.root, state.inputs);
  if (JSON.stringify(inputsBeforeRun) !== JSON.stringify(inputHashes)) throw new Error('Declared inputs changed before command execution.');
  const startedAt = new Date().toISOString();
  const base = {
    schemaVersion: 1,
    status: 'running',
    root: repo.root,
    command: state.command,
    candidateSha256: before.candidateSha256,
    inputs: inputHashes,
    environment: environment(repo.root, inputHashes),
    startedAt,
    output: { log: relative(repo.root, logPath).replaceAll('\\', '/'), capture: 'combined stdout/stderr', streams: ['stdout', 'stderr'], sha256: null },
  };
  await atomicWrite(outputPath, `${JSON.stringify(fingerprintReceipt(base), null, 2)}\n`, { exclusive: true });
  let gate, failure;
  try {
    gate = await runGate({ name: 'focused-check', command: state.command[0], args: state.command.slice(1), cwd: repo.root, logPath });
  } catch (error) {
    gate = error.gate ?? { status: 'failed', exitCode: null, signal: null, log: logPath, summary: error.message.slice(0, 1000) };
    failure = error.message;
  }
  let after;
  try {
    after = await capture(repo.root);
  } catch (error) {
    failure ??= `Could not verify the candidate after execution: ${error.message}`;
  }
  try {
    if (JSON.stringify(await fingerprints(repo.root, state.inputs)) !== JSON.stringify(inputHashes)) failure ??= 'Declared inputs changed during command execution.';
  } catch (error) {
    failure ??= `Could not verify declared inputs after execution: ${error.message}`;
  }
  if (after && after.candidateSha256 !== before.candidateSha256) failure ??= 'Candidate changed during command execution.';
  const outputHash = await fileDigest(logPath).catch(error => {
    failure ??= `Captured output is unavailable: ${error.message}`;
    return null;
  });
  const outcome = gate.status === 'passed' && !failure && outputHash ? 'passed' : 'failed';
  const payload = {
    ...base,
    status: outcome,
    finishedAt: new Date().toISOString(),
    gate,
    candidateAfterSha256: after?.candidateSha256 ?? null,
    output: { ...base.output, sha256: outputHash },
    scope: 'Binding observation for the candidate, declared inputs, command, allowlisted runtime identity, and captured output. Undeclared external state is outside this claim.',
    ...(failure ? { failure: failure.slice(0, 1000) } : {}),
  };
  await atomicWrite(outputPath, `${JSON.stringify(fingerprintReceipt(payload), null, 2)}\n`);
  return {
    status: 'CAPTURED',
    outcome,
    receipt: relative(repo.root, outputPath).replaceAll('\\', '/'),
    log: payload.output.log,
    candidateSha256: payload.candidateSha256,
    gate: { status: gate.status, exitCode: gate.exitCode },
  };
}

async function verifyReceipt(state, repo, inputHashes, outputPath) {
  let raw;
  try {
    const stat = await lstat(outputPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Receipt must be a regular file.');
    raw = await readFile(outputPath, 'utf8');
  } catch (error) {
    throw new Error(`Receipt is unavailable: ${error.message}`, { cause: error });
  }
  const payload = validateReceiptDigest(JSON.parse(raw));
  if (payload.schemaVersion !== 1 || payload.root !== repo.root || !Array.isArray(payload.command) || !Array.isArray(payload.inputs)) throw new Error('Malformed focused-check receipt.');
  if (JSON.stringify(payload.command) !== JSON.stringify(state.command)) throw new Error('Command changed since the focused check.');
  if (JSON.stringify(payload.inputs) !== JSON.stringify(inputHashes)) throw new Error('Declared input fingerprints changed.');
  if (JSON.stringify(payload.environment) !== JSON.stringify(environment(repo.root, inputHashes))) throw new Error('Allowlisted runtime identity changed.');
  const current = await capture(repo.root);
  if (payload.candidateSha256 !== current.candidateSha256 || payload.candidateAfterSha256 !== current.candidateSha256) throw new Error('Candidate changed since the focused check.');
  if (payload.status !== 'passed' || payload.gate?.status !== 'passed' || payload.gate?.exitCode !== 0) throw new Error('Only a passed focused check can be reused.');
  const expectedLog = relative(repo.root, `${outputPath}.log`).replaceAll('\\', '/');
  if (payload.output?.log !== expectedLog || !hashPattern.test(payload.output.sha256 ?? '')) throw new Error('Malformed output artifact binding.');
  const logPath = await artifactPath(repo.root, expectedLog);
  const logStat = await lstat(logPath);
  if (!logStat.isFile() || logStat.isSymbolicLink()) throw new Error('Captured output must be a regular file.');
  if ((await fileDigest(logPath)) !== payload.output.sha256) throw new Error('Captured output log changed since the focused check.');
  return { status: 'REUSED', outcome: 'passed', receipt: relative(repo.root, outputPath).replaceAll('\\', '/'), log: expectedLog, candidateSha256: payload.candidateSha256, command: payload.command };
}

export async function focusedCheck(args) {
  const state = parse(args);
  const repo = await repository(state.root);
  const receiptPath = relativePath(state.receipt);
  const outputPath = await artifactPath(repo.root, receiptPath, { create: state.mode === 'run' });
  const logRelative = `${receiptPath}.log`;
  const logPath = await artifactPath(repo.root, logRelative, { create: state.mode === 'run' });
  if (state.inputs.includes(receiptPath) || state.inputs.includes(logRelative)) throw new Error('Receipt and output log cannot be declared inputs.');
  const inputHashes = await fingerprints(repo.root, state.inputs);
  if (state.mode === 'verify') return verifyReceipt(state, repo, inputHashes, outputPath);
  for (const path of [outputPath, logPath]) {
    try {
      await lstat(path);
      throw new Error(`Retained output already exists: ${relative(repo.root, path)}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return executeRun(state, repo, inputHashes, outputPath, logPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  focusedCheck(process.argv.slice(2))
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      if (result.outcome === 'failed') process.exitCode = 1;
    })
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
