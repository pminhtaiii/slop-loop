import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--root')) {
  console.error('Usage: node scripts/ci/check-context.mjs [--root <checkout>]');
  process.exit(1);
}

function maskCode(source) {
  let fence;
  return source.split('\n').map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = undefined;
      }
      return line.replace(/./g, ' ');
    }
    if (marker) {
      fence = marker[1];
      return line.replace(/./g, ' ');
    }
    return line;
  }).join('\n');
}

function factValue(value) {
  return value.replace(/`/g, '').trim();
}

try {
  const root = await realpath(resolve(args[1] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..')));
  const contract = JSON.parse(await readFile(resolve(root, 'context/contract.json'), 'utf8'));
  if (!Array.isArray(contract.requiredDocuments) || contract.requiredDocuments.some((file) => typeof file !== 'string') || !contract.facts || typeof contract.facts !== 'object' || Array.isArray(contract.facts)) {
    throw new Error('context/contract.json requires requiredDocuments and a facts object.');
  }
  const files = ['AGENTS.md', 'docs/progress-checker-matrices.md'];
  for (const entry of await readdir(resolve(root, 'context'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(`context/${entry.name}`);
  }
  const failures = [];
  const sources = new Map();
  const localTargets = new Map();
  for (const file of files) sources.set(file, await readFile(resolve(root, file), 'utf8'));
  for (const required of contract.requiredDocuments) {
    if (!sources.has(required)) failures.push(`required document missing: ${required}`);
  }
  for (const file of files) {
    const source = sources.get(file);
    const prose = maskCode(source).replace(/(`+).*?\1/g, (code) => ' '.repeat(code.length));
    localTargets.set(file, new Set());
    // shortcut: supports inline links used by context; add reference-link support when adopted.
    const links = /\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))\s*\)/g;
    for (const match of prose.matchAll(links)) {
      const target = match[1] ?? match[2];
      if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) continue;
      const path = target.split('#')[0];
      if (!path) continue;
      const location = `${file}:${source.slice(0, match.index).split('\n').length}`;
      try {
        const destination = await realpath(resolve(dirname(resolve(root, file)), decodeURIComponent(path)));
        const fromRoot = relative(root, destination);
        if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\')) {
          throw new Error('target is outside the checkout');
        }
        localTargets.get(file).add(fromRoot.split('\\').join('/'));
      } catch (error) {
        failures.push(`${location}: ${target} (${error.code ?? error.message})`);
      }
    }
  }

  const facts = new Map();
  for (const [id, definition] of Object.entries(contract.facts)) {
    if (!definition || typeof definition.source !== 'string' || typeof definition.tableRow !== 'string') {
      failures.push(`context/contract.json: fact ${id} requires a source and tableRow`);
      continue;
    }
    const rows = maskCode(sources.get(definition.source) ?? '').split('\n')
      .map((line) => line.split('|').map((cell) => cell.trim()))
      .filter((cells) => cells[1] === definition.tableRow);
    if (rows.length !== 1 || !rows[0][2]) {
      failures.push(`context/contract.json: fact ${id} needs one source row ${definition.tableRow} in ${definition.source}`);
    } else {
      facts.set(id, factValue(rows[0][2]));
    }
  }
  for (const [file, source] of sources) {
    const prose = maskCode(source);
    const claims = [...prose.matchAll(/<!--\s*context-fact:\s*([a-z][a-z0-9-]*)\s*-->([\s\S]*?)<!--\s*\/context-fact\s*-->/g)];
    const openings = [...prose.matchAll(/<!--\s*context-fact:/g)].length;
    const closings = [...prose.matchAll(/<!--\s*\/context-fact\s*-->/g)].length;
    if (openings !== claims.length || closings !== claims.length) failures.push(`${file}: malformed context-fact markers`);
    for (const claim of claims) {
      const location = `${file}:${source.slice(0, claim.index).split('\n').length}`;
      if (!facts.has(claim[1])) {
        failures.push(`${location}: unknown fact ${claim[1]}`);
      } else if (factValue(claim[2]) !== facts.get(claim[1])) {
        failures.push(`${location}: fact ${claim[1]} conflicts with ${contract.facts[claim[1]].source}: expected ${facts.get(claim[1])}`);
      }
    }
  }
  if (!localTargets.get('AGENTS.md')?.has('context/README.md')) {
    failures.push('AGENTS.md must route to context/README.md with a Markdown link');
  }
  for (const file of files) {
    if (file.startsWith('context/') && file !== 'context/README.md' && !localTargets.get('context/README.md')?.has(file)) {
      failures.push(`${file} is not routed from context/README.md`);
    }
  }
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Context checks passed (${files.length} Markdown files; ${facts.size} canonical facts). Prose conflicts still require review.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
