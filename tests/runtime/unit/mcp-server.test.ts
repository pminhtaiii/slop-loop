import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { computeCanonicalSha256 as hash } from '../../../src/contracts/foundation/uc03.ts';
import type { ReviewObservationV1 } from '../../../src/contracts/review.ts';
import { handleMcpRequest, MCP_PROTOCOL_VERSION, MCP_SERVER_INFO } from '../../../src/cli/mcp-server.ts';
import { createDurableReviewEvidenceStore } from '../../../src/persistence/adapters/review-evidence-store.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { createGraphTaskState } from '../support/uc03/graph-fixtures.ts';
import { createFixtureBugTask } from '../support/uc03/port-fixtures.ts';

const SHA = 'sha256:' + 'a'.repeat(64);
const AUTHORITY = {
  taskStateVersion: 1,
  controlVersion: 2,
  epoch: 1,
  decisionAuthorityGeneration: 1,
  planDecisionRef: 'D1',
  planBindingDigest: SHA,
};

function makeObservation(): ReviewObservationV1 {
  const diff = '--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1 @@\n-old\n+new\n';
  const diffDigest = hash(diff);
  const binding = {
    taskId: 'task-mcp-1',
    runId: 'run-mcp-1',
    repositoryId: 'repo-mcp',
    workspaceId: 'ws-mcp',
    baseRevisionDigest: SHA,
    headRevisionDigest: SHA,
    diffDigest,
    criteriaDigest: SHA,
    checkSetDigest: SHA,
    verificationDigest: SHA,
    conventionsDigest: SHA,
    evidenceDigest: SHA,
    profileDigest: SHA,
  };
  return {
    schemaVersion: 'uc06-review-observation/1',
    contextDigest: SHA,
    binding,
    authority: AUTHORITY,
    reviewId: 'rev-mcp-1',
    providerRequestId: 'prov-mcp-1',
    status: 'accepted',
    reasonCode: 'OK',
    result: {
      reviewId: 'rev-mcp-1',
      reviewerRoleConfigId: 'reviewer',
      repoDigest: SHA,
      diffDigest,
      checkSetDigest: SHA,
      status: 'accepted',
      findings: [],
      iterationReservationRef: 'res-mcp-1',
    },
    accountingRefs: ['res-mcp-1'],
    evidenceTier: 'real-integration',
  };
}

test('MCP protocol lifecycle: initialize, ping, notifications, tools/list, and resources', async () => {
  const initRes = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.ok(initRes && initRes.result);
  const initResult = initRes.result as { protocolVersion: string; serverInfo: { name: string } };
  assert.equal(initResult.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(initResult.serverInfo.name, MCP_SERVER_INFO.name);

  const notifRes = await handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notifRes, null);

  const pingRes = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(pingRes?.result, {});

  const toolsRes = await handleMcpRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const tools = (toolsRes?.result as { tools: { name: string }[] }).tools;
  assert.deepEqual(
    tools.map(t => t.name),
    ['slop_list_review_records', 'slop_recover_review', 'slop_get_task_state', 'slop_list_eval_cases'],
  );

  const listResourcesRes = await handleMcpRequest({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
  const resources = (listResourcesRes?.result as { resources: { uri: string }[] }).resources;
  assert.equal(resources[0]?.uri, 'slop://policy/safety');

  const readResourceRes = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'resources/read',
    params: { uri: 'slop://policy/safety' },
  });
  const contents = (readResourceRes?.result as { contents: { text: string }[] }).contents;
  assert.ok(contents[0]);
  const policy = JSON.parse(contents[0].text) as { mode: string; tools: { permission: string }[] };
  assert.equal(policy.mode, 'read-only');
  assert.ok(policy.tools.every(t => t.permission === 'read-only'));
});

test('MCP tools: list/recover review, get task state, and list public eval cases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-mcp-tools-'));
  try {
    const obs = makeObservation();
    const obsDigest = hash(obs);
    const reviewStore = createDurableReviewEvidenceStore(dir);
    await reviewStore.persistObservation({
      observation: obs,
      observationDigest: obsDigest,
      expectedAuthority: AUTHORITY,
      idempotencyKey: 'mcp-idem-1',
    });

    const durableStore = new DurableStore(dir);
    const statePort = new DurableStatePortV02({ store: durableStore, taskId: 'task-mcp-1' });
    const initialState = createGraphTaskState(createFixtureBugTask({ taskId: 'task-mcp-1' }));
    await statePort.transition(initialState, 0);

    // 1. slop_list_review_records
    const listRes = await handleMcpRequest({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'slop_list_review_records', arguments: {} } }, { storageDir: dir });
    const listPayload = JSON.parse(((listRes?.result as { content: { text: string }[] }).content[0] ?? { text: '{}' }).text) as {
      records: string[];
      discoveryEntries: unknown[];
    };
    assert.equal(listPayload.records.length, 1);
    assert.equal(listPayload.discoveryEntries.length, 1);

    // 2. slop_recover_review (matching + drifted authority)
    const recoverRes = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'slop_recover_review',
          arguments: {
            taskId: obs.binding.taskId,
            workspaceId: obs.binding.workspaceId,
            repositoryId: obs.binding.repositoryId,
            headRevisionDigest: obs.binding.headRevisionDigest,
            diffDigest: obs.binding.diffDigest,
            expectedAuthority: AUTHORITY,
          },
        },
      },
      { storageDir: dir },
    );
    const recoverPayload = JSON.parse(((recoverRes?.result as { content: { text: string }[] }).content[0] ?? { text: '{}' }).text) as {
      outcome: string;
      observation: ReviewObservationV1;
    };
    assert.equal(recoverPayload.outcome, 'found');
    assert.equal(recoverPayload.observation.reviewId, 'rev-mcp-1');

    const driftedRes = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'slop_recover_review',
          arguments: {
            taskId: obs.binding.taskId,
            workspaceId: obs.binding.workspaceId,
            repositoryId: obs.binding.repositoryId,
            headRevisionDigest: obs.binding.headRevisionDigest,
            diffDigest: obs.binding.diffDigest,
            expectedAuthority: { ...AUTHORITY, decisionAuthorityGeneration: AUTHORITY.decisionAuthorityGeneration + 1 },
          },
        },
      },
      { storageDir: dir },
    );
    assert.equal((driftedRes?.result as { isError?: boolean }).isError, true);

    // 3. slop_get_task_state
    const taskRes = await handleMcpRequest({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'slop_get_task_state', arguments: { taskId: 'task-mcp-1' } } }, { storageDir: dir });
    const taskPayload = JSON.parse(((taskRes?.result as { content: { text: string }[] }).content[0] ?? { text: '{}' }).text) as {
      found: boolean;
      taskState: { taskId: string };
    };
    assert.equal(taskPayload.found, true);
    assert.equal(taskPayload.taskState.taskId, 'task-mcp-1');

    // 4. slop_list_eval_cases (public only, no private labels leaked)
    const evalRes = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'slop_list_eval_cases', arguments: {} },
    });
    const evalText = ((evalRes?.result as { content: { text: string }[] }).content[0] ?? { text: '{}' }).text;
    const evalPayload = JSON.parse(evalText) as { totalCases: number };
    assert.equal(evalPayload.totalCases, 12);
    assert.ok(!evalText.includes('expectedStatus'));
    assert.ok(!evalText.includes('requiredKeywordGroups'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP stdio subprocess: handles real stdin/stdout JSON-RPC lines', () => {
  const entry = join(process.cwd(), 'src', 'cli', 'mcp-server.ts');
  const input = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })].join('\n');

  const res = spawnSync(process.execPath, [entry], { input: `${input}\n`, encoding: 'utf8' });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const lines = res.stdout
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as { id: number; result?: unknown });
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.id, 1);
  assert.equal(lines[1]?.id, 2);
});
