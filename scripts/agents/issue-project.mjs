import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { command, json } from './paired-issue-api.mjs';

export async function issueProjectDigest(root) {
  try { return createHash('sha256').update(await readFile(resolve(root, 'issue-project.json'))).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function loadIssueProject(repo, call, expectedSha256) {
  let bytes;
  try { bytes = await readFile(resolve(repo.root, 'issue-project.json')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (expectedSha256 !== undefined && expectedSha256 !== null) throw new Error('Queued project configuration changed; inspect the retained job.', { cause: error });
    return null;
  }
  if (expectedSha256 !== undefined && createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('Queued project configuration changed; inspect the retained job.');
  const config = JSON.parse(bytes.toString('utf8'));
  if (config.schemaVersion !== 1 || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(config.owner ?? '') ||
      !Number.isSafeInteger(config.number) || config.number < 1 || !/^PVT_[\w-]+$/.test(config.id ?? '') ||
      !['primary', 'submission'].includes(config.side) || !config.statusField?.trim() || !config.doneStatus?.trim()) {
    throw new Error('Invalid issue-project.json configuration.');
  }
  const project = json(call, ['project', 'view', String(config.number), '--owner', config.owner, '--format', 'json'], repo, 'issue project');
  if (project.id !== config.id || project.owner?.login?.toLowerCase() !== config.owner.toLowerCase() || project.number !== config.number || project.closed !== false) {
    throw new Error('Configured issue project identity changed or project is closed.');
  }
  const fields = json(call, ['project', 'field-list', String(config.number), '--owner', config.owner, '--limit', '100', '--format', 'json'], repo, 'project fields');
  if (!Array.isArray(fields.fields) || fields.totalCount !== fields.fields.length) throw new Error('Incomplete project field listing.');
  const matches = fields.fields.filter(field => field.name === config.statusField && field.type === 'ProjectV2SingleSelectField');
  const options = matches[0]?.options?.filter(option => option.name === config.doneStatus) ?? [];
  if (matches.length !== 1 || options.length !== 1 || !matches[0].id || !options[0].id) throw new Error('Project status field or Done option is missing or ambiguous.');
  return { ...config, fieldId: matches[0].id, doneId: options[0].id };
}

export function authenticatedAssignee(repo, call) {
  const user = json(call, ['api', 'user'], repo, 'authenticated GitHub user');
  if (user.type !== 'User' || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(user.login ?? '')) throw new Error('Ticket ownership requires an authenticated human GitHub user.');
  return user.login;
}

function issueIdentity(url) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)$/.exec(url);
  if (!match) throw new Error('Invalid project issue URL.');
  return { owner: match[1], name: match[2], number: Number(match[3]) };
}

export function projectItem(repo, call, project, issueUrl) {
  const issue = issueIdentity(issueUrl);
  const query = 'query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){issue(number:$number){url projectItems(first:100,after:$endCursor){nodes{id project{id} fieldValueByName(name:' + JSON.stringify(project.statusField) + '){... on ProjectV2ItemFieldSingleSelectValue{optionId}}} pageInfo{hasNextPage endCursor}}}}}';
  const output = json(call, ['api', 'graphql', '--paginate', '--slurp', '-f', `query=${query}`, '-f', `owner=${issue.owner}`, '-f', `name=${issue.name}`, '-F', `number=${issue.number}`], repo, 'issue project membership');
  if (!Array.isArray(output) || !output.length) throw new Error('Incomplete issue project membership.');
  const nodes = [];
  for (let index = 0; index < output.length; index++) {
    const page = output[index];
    const remote = page.data?.repository?.issue;
    const connection = remote?.projectItems;
    if (page.errors || remote?.url?.toLowerCase() !== issueUrl.toLowerCase() || !Array.isArray(connection?.nodes) ||
        connection.pageInfo?.hasNextPage !== (index < output.length - 1)) throw new Error('Incomplete or mismatched issue project membership.');
    nodes.push(...connection.nodes);
  }
  const matches = nodes.filter(item => item.project?.id === project.id);
  if (matches.length > 1 || (matches.length && !matches[0].id)) throw new Error('Ambiguous issue project membership.');
  return matches[0] ?? null;
}

export function syncProjectItem(repo, call, project, issueUrl, done = false) {
  let item = projectItem(repo, call, project, issueUrl);
  if (!item) {
    // GitHub returns the same membership when a lost add response is retried.
    const added = json(call, ['project', 'item-add', String(project.number), '--owner', project.owner, '--url', issueUrl, '--format', 'json'], repo, 'added project item');
    item = projectItem(repo, call, project, issueUrl);
    if (!item || item.id !== added.id) throw new Error('Project membership was not confirmed; retry the same ticket.');
  }
  if (done && item.fieldValueByName?.optionId !== project.doneId) {
    command(call, ['project', 'item-edit', '--id', item.id, '--project-id', project.id, '--field-id', project.fieldId, '--single-select-option-id', project.doneId], repo);
    item = projectItem(repo, call, project, issueUrl);
    if (!item || item.fieldValueByName?.optionId !== project.doneId) throw new Error('Project Done status was not confirmed; retry completion.');
  }
  return { id: item.id, done: item.fieldValueByName?.optionId === project.doneId };
}
