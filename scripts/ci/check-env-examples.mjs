import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deliberately narrow policy: an example file may document keys but must not carry a usable value.
// This is not a dotenv parser, so any construct it does not recognise is refused rather than echoed.
export const MAX_BYTES = 64 * 1024;
export const EXAMPLE_BASENAME = '.env.example';
export const PLACEHOLDER_VALUES = Object.freeze(['', 'CHANGE_ME', 'YOUR_VALUE_HERE', 'EXAMPLE_VALUE', 'https://example.invalid']);

const REGULAR_MODES = new Set(['100644', '100755']);
const ASSIGNMENT = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

const hasControl = (text) => {
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
    if (code === 0x7f) return true;
  }
  return false;
};

// Diagnostics name only the path, line and rule. Values and source text never enter the message. The
// path is candidate-controlled (a file may be named with escapes or newlines), so it is only echoed
// when it is printable; otherwise a bounded substitute keeps the message single-line and unspoofable.
const PRINTABLE_PATH = /^[\x20-\x7e]{1,1024}$/;
function fail(path, rule, line) {
  const shown = typeof path === 'string' && PRINTABLE_PATH.test(path) ? path : '<unprintable path>';
  throw new Error(`${rule} in ${shown}${line === undefined ? '' : ` line ${line}`}; example env files may only hold documented keys and approved placeholders.`);
}

function checkValue(value, path, line) {
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    const close = value.indexOf(quote, 1);
    if (close === -1) fail(path, 'unmatched-quote', line);
    if (close !== value.length - 1) fail(path, 'value', line);
    const inner = value.slice(1, -1);
    if (inner.includes('"') || inner.includes("'")) fail(path, 'expressions', line);
    if (/[$`\\]/.test(inner)) fail(path, 'expressions', line);
    if (!PLACEHOLDER_VALUES.includes(inner)) fail(path, 'value', line);
    return;
  }
  if (value.includes('"') || value.includes("'")) fail(path, 'unmatched-quote', line);
  if (/[$`\\]/.test(value)) fail(path, 'expressions', line);
  if (!PLACEHOLDER_VALUES.includes(value)) fail(path, 'value', line);
}

// Validates one admitted example blob and returns its assignment count.
export function validateEnvExample({ path, mode, bytes }) {
  if (!REGULAR_MODES.has(mode)) fail(path, 'regular-file');
  if (!(bytes instanceof Uint8Array)) fail(path, 'encoding');
  if (bytes.byteLength > MAX_BYTES) fail(path, 'size');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(path, 'encoding');
  }
  if (hasControl(text)) fail(path, 'binary');
  let assignments = 0;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = ASSIGNMENT.exec(line);
    if (!match) fail(path, 'syntax', lineNumber);
    checkValue(match[2], path, lineNumber);
    assignments += 1;
  }
  return assignments;
}

// Fails on the first invalid example, so a later value is never read past an earlier refusal.
export function checkEnvExamples({ paths, read }) {
  let assignments = 0;
  for (const path of paths) {
    const { mode, bytes } = read(path);
    assignments += validateEnvExample({ path, mode, bytes });
  }
  return { files: paths.length, assignments };
}

const USAGE = 'Usage: node scripts/ci/check-env-examples.mjs [--root <checkout>]';

export function parseEnvArgs(argv) {
  if (argv.length === 0) return { root: process.cwd() };
  if (argv.length !== 2 || argv[0] !== '--root' || !argv[1]) throw new Error(USAGE);
  return { root: argv[1] };
}

function git(root, args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, ...options });
}

// Reads candidate index blobs only; the working tree's ignored local env files are never opened.
export function gitEnvExampleReader(root) {
  const listing = git(root, ['ls-files', '-sz']);
  const entries = new Map();
  for (const record of listing.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode, oid] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (path && basename(path) === EXAMPLE_BASENAME) entries.set(path, { mode, oid });
  }
  return {
    paths: [...entries.keys()],
    read: (path) => {
      const entry = entries.get(path);
      if (!entry) throw new Error(`Example env file is no longer tracked: ${path}`);
      if (!REGULAR_MODES.has(entry.mode)) return { mode: entry.mode, bytes: Buffer.alloc(0) };
      const size = Number(git(root, ['cat-file', '-s', entry.oid]).trim());
      // An over-limit blob only needs to be *shown* as over limit; allocating its real size would let a
      // candidate force a multi-gigabyte allocation inside the policy job.
      if (size > MAX_BYTES) return { mode: entry.mode, bytes: Buffer.alloc(MAX_BYTES + 1) };
      return { mode: entry.mode, bytes: git(root, ['cat-file', 'blob', entry.oid], { encoding: 'buffer', maxBuffer: MAX_BYTES + 1 }) };
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { root } = parseEnvArgs(process.argv.slice(2));
    const reader = gitEnvExampleReader(root);
    const { files } = checkEnvExamples(reader);
    console.log(`Environment-example check passed: ${files} example file(s) hold documented keys and approved placeholders.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
