import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function generateReviewTemplate({ noFindings = false } = {}) {
  if (noFindings) return '# Subagent Review Report\n\nNo blocking issues found.\n';

  return `# Subagent Review Report

## Findings (unfinished skeleton)

| Severity | Code | Title | Description | Recommendation |
| --- | --- | --- | --- | --- |
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/agents/planning-review-template.mjs [--no-findings]');
  } else if (args.some(arg => arg !== '--no-findings')) {
    console.error(`Unknown option: ${args.find(arg => arg !== '--no-findings')}`);
    process.exitCode = 2;
  } else {
    process.stdout.write(generateReviewTemplate({ noFindings: args.includes('--no-findings') }));
  }
}
