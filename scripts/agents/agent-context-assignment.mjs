import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { checkout, fail, headings, isInside, markdownLines, normalizedRepoPath, parseTasks, readOptionalText, repoFile } from './agent-context-common.mjs';

export async function assignment(root, uc) {
  const sourcePath = 'docs/use-case-delegation.md';
  const source = markdownLines(await readFile(await repoFile(root, sourcePath, 'delegation map'), 'utf8'));
  const sections = headings(source.lines, source.visible);
  const rows = source.lines.filter((line, index) => source.visible[index] && /^\|\s*UC-\d{2}\s*\|/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  const seen = new Set();
  for (const row of rows) {
    if (row.length !== 5 || seen.has(row[0])) fail('Delegation assignments require five columns and unique UC IDs.');
    seen.add(row[0]);
  }
  const row = rows.find((entry) => entry[0] === uc);
  if (!row) fail(`${uc} is not assigned in the selected batch; inspect ${sourcePath}.`);
  const section = (matches) => {
    const found = sections.filter(matches);
    if (found.length !== 1) fail('Delegation map requires a unique UC brief and shared-work section.');
    const start = found[0];
    const end = sections.find((heading) => heading.index > start.index && heading.level <= start.level)?.index ?? source.lines.length;
    return source.lines.slice(start.index, end).join('\n').trim();
  };
  const brief = section((heading) => heading.level === 2 && heading.title.startsWith(`${uc}:`));
  const sharedFoundation = section((heading) => heading.level === 2 && heading.title === 'Delivery order and shared work');
  const missing = [];
  const pointers = async (text, artifacts = false) => {
    const result = [];
    const prose = markdownLines(text);
    for (const line of prose.lines.filter((_, index) => prose.visible[index])) {
      for (const match of line.matchAll(/\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))\)/g)) {
        const target = (match[1] ?? match[2]).split('#')[0];
        if (!target) continue;
        if (/^[a-z][a-z\d+.-]*:/i.test(target)) {
          if (artifacts) fail('Feature artifacts must be local checkout paths.');
          continue;
        }
        const input = normalizedRepoPath(root, resolve(root, 'docs', decodeURIComponent(target)));
        try {
          const path = await repoFile(root, input, 'assignment link');
          if (!(await stat(path)).isFile()) fail(`Assignment link is not a file: ${input}`);
          result.push(normalizedRepoPath(root, path));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          missing.push(`Missing linked file: ${input}`);
        }
      }
    }
    return [...new Set(result)];
  };
  const artifacts = await pointers(row[4], true);
  for (const name of ['spec.md', 'plan.md', 'tasks.md']) {
    if (!artifacts.some((path) => basename(path) === name)) missing.push(`Link the approved ${name} in the Feature artifacts cell.`);
  }
  if (!row[2] || /pending|unassigned/i.test(row[2])) missing.push('Assign a colleague owner.');
  const context = await pointers(brief + '\n' + sharedFoundation);
  process.stdout.write(JSON.stringify({ ...(await checkout(root)), uc, owner: row[2], delivery: row[1], prerequisites: row[3],
    status: missing.length ? 'NEEDS_PLANNING' : 'REVIEW_REQUIRED', missing, artifacts, context, brief, sharedFoundation,
    source: sourcePath, note: 'Confirm artifact approval and dependency evidence before implementation; this report never updates task status.' }, null, 2) + '\n');
}

export function workflowEvidencePointers(root, activeText) {
  if (!activeText) return [];
  const source = markdownLines(activeText);
  const sectionHeadings = headings(source.lines, source.visible);
  const first = sectionHeadings.find((heading) => heading.level === 2);
  if (!first) return [];
  const end =
    sectionHeadings.find((heading) => heading.level <= first.level && heading.index > first.index)
      ?.index ?? source.lines.length;
  const result = [];
  for (let index = first.index + 1; index < end; index += 1) {
    if (!source.visible[index]) continue;
    for (const match of source.lines[index].matchAll(
      /\[([^\]]*(?:evidence|verification|record)[^\]]*)\]\(([^)]+)\)/gi,
    )) {
      const target = match[2].split('#')[0];
      if (!target || /^[a-z]+:/i.test(target) || isAbsolute(target)) continue;
      const resolved = resolve(root, 'context', target);
      if (isInside(root, resolved)) result.push(normalizedRepoPath(root, resolved));
      if (result.length === 3) return result;
    }
  }
  return result;
}

export async function handoff(root, tasksInput) {
  const tasksFile = await repoFile(root, tasksInput, '--tasks');
  const tasksText = (await readFile(tasksFile, 'utf8')).replace(/^\uFEFF/, '');
  const parsed = parseTasks(tasksText, tasksInput);
  const current = await checkout(root);
  const checked = parsed.tasks.filter((task) => task.checked).length;
  const open = parsed.tasks.length - checked;
  const candidate = parsed.tasks.find((task) => !task.checked);
  const activeText = await readOptionalText(root, 'context/active-feature.md');
  const workflowText = await readOptionalText(root, 'context/workflow.md');
  const workflowSource = workflowText ? markdownLines(workflowText) : null;
  const gates = workflowSource
    ? headings(workflowSource.lines, workflowSource.visible).filter((heading) =>
        /^Step [234]:/.test(heading.title),
      )
    : [];
  const evidence = workflowEvidencePointers(root, activeText);

  process.stdout.write(
    `Checkout: ${current.root}\nBranch: ${current.branch ?? '(detached)'}\nHEAD: ${current.head}\n`,
  );
  process.stdout.write(
    `Tasks: ${normalizedRepoPath(root, tasksFile)}\nCanonical tasks: ${checked} checked; ${open} open; ${parsed.tasks.length} total\n`,
  );
  process.stdout.write(
    candidate
      ? `First unchecked candidate (not authorization): ${candidate.line}\n`
      : 'First unchecked candidate: none\n',
  );
  process.stdout.write(
    'Workflow pointers: context/active-feature.md (checkpoint), context/workflow.md (sequence), context/testing.md (verification gates)\n',
  );
  if (evidence.length > 0)
    process.stdout.write(`Evidence pointers from active-feature.md: ${evidence.join(', ')}\n`);
  if (gates.length > 0) {
    process.stdout.write(
      `Next workflow stages (reference only): ${gates.map((heading) => heading.title).join(' -> ')}\n`,
    );
  } else {
    process.stdout.write(
      'Next workflow stages: consult context/workflow.md; no stage status is inferred.\n',
    );
  }
}
