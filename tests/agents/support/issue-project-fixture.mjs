import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const projectConfig = { schemaVersion: 1, owner: 'team', number: 33, id: 'PVT_example', side: 'submission', statusField: 'Status', doneStatus: 'Done' };

export async function projectFixture(root, fallback = () => { throw new Error('Unexpected command'); }) {
  await writeFile(join(root, 'issue-project.json'), JSON.stringify(projectConfig));
  const state = { items: new Map(), writes: [], assignments: new Map(), projectId: projectConfig.id, doneId: 'done', failEdit: false, loseAdd: false, loseEdit: false, incomplete: false };
  const execute = (binary, args, cwd, timeout) => {
    if (binary !== 'gh') return fallback(binary, args, cwd, timeout);
    if (args[0] === 'project' && args[1] === 'view') return JSON.stringify({ id: state.projectId, owner: { login: 'team' }, number: 33, closed: false });
    if (args[0] === 'project' && args[1] === 'field-list') return JSON.stringify({ totalCount: 1, fields: [{ id: 'field', name: 'Status', type: 'ProjectV2SingleSelectField', options: [{ id: state.doneId, name: 'Done' }] }] });
    if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ login: 'driver', type: 'User' });
    if (args[0] === 'api' && args[1] === 'graphql') {
      const owner = args.find(arg => arg.startsWith('owner=')).slice(6);
      const name = args.find(arg => arg.startsWith('name=')).slice(5);
      const number = args.find(arg => arg.startsWith('number=')).slice(7);
      const url = `https://github.com/${owner}/${name}/issues/${number}`;
      const item = state.items.get(url);
      return JSON.stringify([{ data: { repository: { issue: { url, projectItems: { nodes: item ? [item] : [], pageInfo: { hasNextPage: state.incomplete, endCursor: null } } } } } }]);
    }
    if (args[0] === 'project' && args[1] === 'item-add') {
      const url = args[args.indexOf('--url') + 1];
      const item = state.items.get(url) ?? { id: 'item-' + state.items.size, project: { id: projectConfig.id }, fieldValueByName: { optionId: 'progress' } };
      state.items.set(url, item);
      state.writes.push('add');
      if (state.loseAdd) { state.loseAdd = false; throw new Error('lost add response'); }
      return JSON.stringify({ id: item.id });
    }
    if (args[0] === 'project' && args[1] === 'item-edit') {
      if (state.failEdit) throw new Error('project edit failed');
      const id = args[args.indexOf('--id') + 1];
      const item = [...state.items.values()].find(item => item.id === id);
      assert.ok(item);
      item.fieldValueByName.optionId = state.doneId;
      state.writes.push('done');
      if (state.loseEdit) { state.loseEdit = false; throw new Error('lost edit response'); }
      return '';
    }
    if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--add-assignee')) {
      state.assignments.set(args[args.indexOf('--repo') + 1], args[args.indexOf('--add-assignee') + 1]);
      return '';
    }
    if (args[0] === 'issue' && args[1] === 'view' && args.at(-1) === 'assignees') {
      const login = state.assignments.get(args[args.indexOf('--repo') + 1]);
      return JSON.stringify({ assignees: login ? [{ login }] : [] });
    }
    return fallback(binary, args, cwd, timeout);
  };
  return { ...state, state, execute };
}
