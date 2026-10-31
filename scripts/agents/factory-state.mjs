import { parseArgs } from 'node:util';
import { capture, check } from './factory-state-checks.mjs';

try {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('capture --root <checkout> | check --root <checkout> --mode dispatch|handoff --manifest <file> --manifest-sha256 <hash> [--evidence <file> --evidence-sha256 <hash>]');
    process.exit(0);
  }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { root: { type: 'string' }, mode: { type: 'string' }, manifest: { type: 'string' }, 'manifest-sha256': { type: 'string' }, evidence: { type: 'string' }, 'evidence-sha256': { type: 'string' } } });
  if (positionals.length !== 1 || !values.root) throw new Error('Provide capture or check and --root.');
  let result;
  if (positionals[0] === 'capture') {
    if (Object.keys(values).some((key) => key !== 'root')) throw new Error('Capture accepts only --root.');
    result = await capture(values.root);
  }
  else if (positionals[0] === 'check') result = await check({ root: values.root, mode: values.mode, manifestPath: values.manifest, manifestSha256: values['manifest-sha256'], evidencePath: values.evidence, evidenceSha256: values['evidence-sha256'] });
  else throw new Error('Unknown command.');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'blocked', reasons: [error.message], provenance: 'No authorization, acceptance, or execution is established.' }));
  process.exitCode = 1;
}
