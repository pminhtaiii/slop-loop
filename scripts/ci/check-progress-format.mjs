// Checks the progress ledger's Markdown contract; it does not judge evidence or authorization.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const statuses = ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'IMPLEMENTED_UNVERIFIED', 'VERIFIED'];
const sections = ['# Implementation Status', '## Status meanings', '## Repository observations'];
const headers = [
  ['Status', 'Meaning'],
  ['Area', 'Status', 'Implementation / inspected paths', 'Verification evidence', 'Inspected revision'],
];

/** Returns line-addressed structural errors without changing the supplied ledger. */
export function checkProgressFormat(source) {
  const errors = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const fail = (index, message) => errors.push(`context/progress_checker.md:${index + 1}: ${message}`);
  const headings = lines.filter(line => /^#/.test(line));
  if (JSON.stringify(headings) !== JSON.stringify(sections) || lines[0] !== sections[0]) fail(0, `Use these headings in order: ${sections.join(', ')}`);
  if (!source.endsWith('\n')) fail(lines.length - 1, 'End the file with a newline.');
  let table = -1;
  const tableCounts = [0, 0];
  const seen = [new Set(), new Set()];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/[\t\r]| +$/.test(line)) fail(index, 'Use spaces without trailing whitespace.');
    if (line === sections[1]) table = 0;
    if (line === sections[2]) table = 1;
    if (!line.trimStart().startsWith('|')) continue;
    if (table < 0) {
      fail(index, 'Tables belong under Status meanings or Repository observations.');
      continue;
    }
    // An escaped pipe is content; an unescaped pipe (even in inline code) splits a Markdown cell.
    const cells = line
      .split(/(?<!\\)(?:\\\\)*\|/)
      .slice(1, -1)
      .map(cell => cell.trim());
    const expected = headers[table];
    if (!(line.startsWith('| ') && line.endsWith(' |')) && !/^\|(?:-+\|)+$/.test(line)) fail(index, 'Use | cell | spacing and leading/trailing pipes.');
    if (cells.length !== expected.length || cells.some(cell => !cell)) {
      fail(index, `Expected ${expected.length} nonempty cells; escape content pipes as \\|.`);
      continue;
    }
    if (lines[index - 1]?.startsWith('## ') || !lines[index - 1]?.startsWith('|')) {
      tableCounts[table]++;
      if (cells.join('|') !== expected.join('|')) fail(index, `Expected table header: ${expected.join(' | ')}`);
      const separator = lines[index + 1]
        ?.split('|')
        .slice(1, -1)
        .map(cell => cell.trim());
      if (separator?.length !== expected.length || separator.some(cell => !/^:?-{3,}:?$/.test(cell))) fail(index + 1, 'Follow the header with a Markdown separator row.');
      continue;
    }
    if (cells.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    const key = cells[0].replaceAll('`', '').toLowerCase();
    if (seen[table].has(key)) fail(index, `Duplicate ${expected[0].toLowerCase()}: ${cells[0]}`);
    seen[table].add(key);
    const status = cells[table === 0 ? 0 : 1];
    if (!statuses.some(value => status === `\`${value}\``)) fail(index, `Use one backtick-wrapped status: ${statuses.join(', ')}.`);
  }
  for (const count of tableCounts) if (count !== 1) fail(0, 'Each section requires exactly one table.');
  for (const status of statuses) if (!seen[0].has(status.toLowerCase())) fail(0, `Missing status definition: ${status}`);
  if (!seen[1].size) fail(0, 'Repository observations needs at least one data row.');
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--root')) {
    console.error('Usage: node scripts/ci/check-progress-format.mjs [--root <checkout>]');
    process.exitCode = 1;
  } else {
    const root = resolve(args[1] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
    try {
      const errors = checkProgressFormat(await readFile(resolve(root, 'context/progress_checker.md'), 'utf8'));
      if (errors.length) {
        console.error(errors.join('\n'));
        process.exitCode = 1;
      } else console.log('Progress format checks passed. Evidence accuracy still requires review.');
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
