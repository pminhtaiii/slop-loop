import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPrMetadata, historicalBinding } from '../agents/pr-conventions.mjs';
import { parseHistoricalBindings } from './required-checks.mjs';

const configPath = fileURLToPath(new URL('../../config/legacy-ci-heads.json', import.meta.url));

// Event text is data: fields are read out of a parsed object and validated, never interpolated into a
// command and never echoed back. Draft state is a separate human-readiness question, not a skip.
export function eventMetadata(payload) {
  const pr = payload?.pull_request;
  return {
    metadata: { branch: pr?.head?.ref, base: pr?.base?.ref, title: pr?.title, body: pr?.body },
    identity: { repositoryId: payload?.repository?.id, number: pr?.number, head: pr?.head?.sha, headRepositoryId: pr?.head?.repo?.id },
  };
}

// No historical binding means the current convention applies; a PR can never name its own version.
export function checkPrMetadata(payload, { bindings = [] } = {}) {
  const { metadata, identity } = eventMetadata(payload);
  const binding = historicalBinding(identity, bindings);
  // A binding that names no convention gets the current one, never the lenient "no convention" path:
  // an incomplete audited entry must not become a validation bypass.
  assertPrMetadata(metadata, { convention: binding?.convention ?? 2 });
  return { status: 'PASSED' };
}

function readEvent(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('The event file is not readable JSON.'); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw new Error('Usage: node scripts/ci/check-pr-metadata.mjs <event.json>');
    const bindings = parseHistoricalBindings(readFileSync(configPath, 'utf8'));
    console.log(JSON.stringify(checkPrMetadata(readEvent(args[0]), { bindings })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
