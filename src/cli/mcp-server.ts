/**
 * Read-only Model Context Protocol (MCP) stdio server for slop-loop.
 *
 * Exposes inspection and recovery tools backed by existing durable adapters
 * (DurableReviewEvidenceStore, DurableStatePortV02) and public UC-06 evaluation
 * metadata without adding external dependencies or mutating runtime state.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { ReviewAuthorityV1 } from '../contracts/review.ts';
import { UC06_QUALITY_CASES } from '../../eval/uc06/catalog.ts';
import { createDurableReviewEvidenceStore } from '../persistence/adapters/review-evidence-store.ts';
import { DurableStatePortV02 } from '../persistence/adapters/state-port-v02.ts';
import { DurableStore, isSafeStorageId } from '../persistence/store.ts';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_INFO = {
  name: 'slop-loop-mcp',
  version: '0.1.0',
} as const;

export interface McpServerOptions {
  readonly storageDir?: string;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const SAFETY_RESOURCE_URI = 'slop://policy/safety';

const TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'slop_list_review_records',
    description: 'List persisted review observation digests and candidate discovery files in the durable store (read-only).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'slop_recover_review',
    description: 'Recover a persisted ReviewObservationV1 from DurableReviewEvidenceStore by candidate binding and expectedAuthority without LLM replay.',
    inputSchema: {
      type: 'object',
      required: ['taskId', 'workspaceId', 'repositoryId', 'headRevisionDigest', 'diffDigest', 'expectedAuthority'],
      properties: {
        taskId: { type: 'string' },
        workspaceId: { type: 'string' },
        repositoryId: { type: 'string' },
        headRevisionDigest: { type: 'string' },
        diffDigest: { type: 'string' },
        expectedAuthority: {
          type: 'object',
          required: ['taskStateVersion', 'controlVersion', 'epoch', 'decisionAuthorityGeneration', 'planDecisionRef', 'planBindingDigest'],
          properties: {
            taskStateVersion: { type: 'number' },
            controlVersion: { type: 'number' },
            epoch: { type: 'number' },
            decisionAuthorityGeneration: { type: 'number' },
            planDecisionRef: { type: 'string' },
            planBindingDigest: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'slop_get_task_state',
    description: 'Load persisted TaskState and VerificationAuthoritySnapshotV02 for a taskId from DurableStatePortV02 (read-only).',
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'slop_list_eval_cases',
    description: 'List public UC-06 quality evaluation rubric cases (Q01-Q12) without exposing private oracle labels.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseAuthority(value: unknown): ReviewAuthorityV1 | null {
  if (!isRecord(value)) return null;
  const taskStateVersion = readNumber(value, 'taskStateVersion');
  const controlVersion = readNumber(value, 'controlVersion');
  const epoch = readNumber(value, 'epoch');
  const decisionAuthorityGeneration = readNumber(value, 'decisionAuthorityGeneration');
  const planDecisionRef = readString(value, 'planDecisionRef');
  const planBindingDigest = readString(value, 'planBindingDigest');
  if (taskStateVersion === null || controlVersion === null || epoch === null || decisionAuthorityGeneration === null || planDecisionRef === null || planBindingDigest === null) {
    return null;
  }
  return {
    taskStateVersion,
    controlVersion,
    epoch,
    decisionAuthorityGeneration,
    planDecisionRef,
    planBindingDigest,
  };
}

function resolveStorageDir(options?: McpServerOptions): string {
  const configured = options?.storageDir ?? process.env['SLOP_LOOP_STORAGE_DIR'] ?? join(process.cwd(), '.slop-loop', 'store');
  return resolve(configured);
}

function toolResult(payload: unknown, isError = false): { content: readonly { type: 'text'; text: string }[]; isError?: boolean } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function listReviewRecords(storageDir: string): { storageDir: string; records: readonly string[]; discoveryEntries: readonly Record<string, unknown>[] } {
  const reviewRoot = join(storageDir, 'review-evidence');
  const recordsDir = join(reviewRoot, 'records');
  const discoveryDir = join(reviewRoot, 'discovery');

  const records = existsSync(recordsDir)
    ? readdirSync(recordsDir)
        .filter(f => f.endsWith('.json'))
        .sort()
    : [];

  const discoveryEntries: Record<string, unknown>[] = [];
  if (existsSync(discoveryDir)) {
    for (const file of readdirSync(discoveryDir)
      .filter(f => f.endsWith('.json'))
      .sort()) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(discoveryDir, file), 'utf8'));
        if (isRecord(parsed)) discoveryEntries.push(parsed);
      } catch {
        discoveryEntries.push({ file, error: 'INVALID_JSON' });
      }
    }
  }

  return { storageDir, records, discoveryEntries };
}

async function handleToolCall(name: string, args: Record<string, unknown>, options?: McpServerOptions) {
  if (name === 'slop_list_review_records') {
    const storageDir = resolveStorageDir(options);
    return toolResult(listReviewRecords(storageDir));
  }

  if (name === 'slop_recover_review') {
    const taskId = readString(args, 'taskId');
    const workspaceId = readString(args, 'workspaceId');
    const repositoryId = readString(args, 'repositoryId');
    const headRevisionDigest = readString(args, 'headRevisionDigest');
    const diffDigest = readString(args, 'diffDigest');
    const expectedAuthority = parseAuthority(args['expectedAuthority']);
    if (!taskId || !workspaceId || !repositoryId || !headRevisionDigest || !diffDigest || !expectedAuthority) {
      return toolResult({ error: 'INVALID_ARGUMENTS', message: 'Missing or invalid candidate binding or expectedAuthority fields.' }, true);
    }
    const storageDir = resolveStorageDir(options);
    if (!existsSync(join(storageDir, 'review-evidence'))) {
      return toolResult({ outcome: 'missing' });
    }
    const store = createDurableReviewEvidenceStore(storageDir);
    const recovered = await store.recoverObservation({
      taskId,
      workspaceId,
      repositoryId,
      headRevisionDigest,
      diffDigest,
      expectedAuthority,
    });
    return toolResult(recovered, recovered.outcome === 'denied');
  }

  if (name === 'slop_get_task_state') {
    const taskId = readString(args, 'taskId');
    if (!taskId || !isSafeStorageId(taskId)) {
      return toolResult({ error: 'INVALID_TASK_ID', message: 'A valid safe taskId is required.' }, true);
    }
    const storageDir = resolveStorageDir(options);
    const durableStore = new DurableStore(storageDir);
    const statePort = new DurableStatePortV02({ store: durableStore, taskId });
    const [taskState, authoritySnapshot] = await Promise.all([statePort.loadTask(taskId), statePort.readVerificationAuthoritySnapshot(taskId)]);
    return toolResult({ taskId, found: taskState !== null, taskState, authoritySnapshot });
  }

  if (name === 'slop_list_eval_cases') {
    const cases = UC06_QUALITY_CASES.map(c => ({
      caseId: c.caseId,
      name: c.name,
      file: c.file,
      diffDigest: c.diffDigest,
    }));
    return toolResult({ totalCases: cases.length, cases });
  }

  return toolResult({ error: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}` }, true);
}

function safetyPolicyResource(): Record<string, unknown> {
  return {
    server: MCP_SERVER_INFO.name,
    mode: 'read-only',
    lethalTrifectaMitigation: {
      privateDataAccess: 'bounded-to-configured-storage-dir',
      untrustedContentIngestion: 'none',
      externalExfiltration: 'none (zero network/write tools)',
    },
    tools: TOOLS.map(t => ({
      name: t.name,
      permission: 'read-only',
      approvalRequired: false,
    })),
  };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export async function handleMcpRequest(request: unknown, options?: McpServerOptions): Promise<JsonRpcResponse | null> {
  if (!isRecord(request) || request['jsonrpc'] !== '2.0' || typeof request['method'] !== 'string') {
    return rpcError(null, -32600, 'Invalid JSON-RPC 2.0 request.');
  }

  const hasId = 'id' in request && request['id'] !== undefined;
  const rawId = request['id'];
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
  const method = request['method'];
  const params = isRecord(request['params']) ? request['params'] : {};

  if (!hasId) {
    return null;
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: MCP_SERVER_INFO,
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const toolName = readString(params, 'name');
    if (!toolName) return rpcError(id, -32602, 'Tool name is required.');
    const args = isRecord(params['arguments']) ? params['arguments'] : {};
    const result = await handleToolCall(toolName, args, options);
    return { jsonrpc: '2.0', id, result };
  }

  if (method === 'resources/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        resources: [
          {
            uri: SAFETY_RESOURCE_URI,
            name: 'slop-loop MCP Safety & Permission Policy',
            mimeType: 'application/json',
          },
        ],
      },
    };
  }

  if (method === 'resources/read') {
    const uri = readString(params, 'uri');
    if (uri !== SAFETY_RESOURCE_URI) {
      return rpcError(id, -32602, `Unknown resource URI: ${String(uri)}`);
    }
    return {
      jsonrpc: '2.0',
      id,
      result: {
        contents: [
          {
            uri: SAFETY_RESOURCE_URI,
            mimeType: 'application/json',
            text: JSON.stringify(safetyPolicyResource(), null, 2),
          },
        ],
      },
    };
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

export function startMcpServer(options?: McpServerOptions): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      process.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`);
      return;
    }
    void handleMcpRequest(parsed, options)
      .then(response => {
        if (response !== null) {
          process.stdout.write(`${JSON.stringify(response)}\n`);
        }
      })
      .catch((error: unknown) => {
        if (isRecord(parsed) && 'id' in parsed && parsed['id'] !== undefined) {
          const rawId = parsed['id'];
          const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
          const message = error instanceof Error ? error.message : 'Internal server error';
          process.stdout.write(`${JSON.stringify(rpcError(id, -32603, message))}\n`);
        }
      });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMcpServer();
}
