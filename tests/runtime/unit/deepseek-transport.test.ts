import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderRequest } from '../../../src/contracts/foundation/uc03.ts';
import { buildTransportPayload, executeTransport, type HostModelTransportPayload } from '../../../src/foundation/model.ts';
import { createDeepSeekTransport, type DeepSeekPricing } from '../../../src/foundation/deepseek-transport.ts';
import { createFixtureProviderRequest, createFixtureSourceEvidence, createFixtureTaskState } from '../support/uc03/port-fixtures.ts';

const ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages';
const KEY = 'sk-host-only-secret-0123456789';
const PRICING: DeepSeekPricing = { inputRate: 1, outputRate: 1, cacheRate: 1, overheadRate: 0, denominator: 1 };
const PROPOSAL_TEXT = '{"kind":"stop","proposalId":"p-1","reasonCode":"done","summary":"ok","evidenceRefs":[]}';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(handler: (init: RequestInit) => Response | Promise<Response>): { fetchImpl: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(init ?? {});
  };
  return { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function messageResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    id: 'msg-1',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-v4.1',
    content: [{ type: 'text', text: PROPOSAL_TEXT }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 120, output_tokens: 40 },
    ...overrides,
  });
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return createFixtureProviderRequest({ modelId: 'deepseek-flash', maxCostUsd: 0.1, ...overrides });
}

function payloadFor(overrides: Partial<ProviderRequest> = {}): HostModelTransportPayload {
  const state = createFixtureTaskState();
  return buildTransportPayload(state, [createFixtureSourceEvidence()], request(overrides));
}

function transport(fetchImpl: typeof globalThis.fetch) {
  return createDeepSeekTransport({ endpoint: ENDPOINT, apiKey: KEY, pricing: PRICING, fetch: fetchImpl });
}

function requestBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

test('refuses every endpoint but the pinned DeepSeek Anthropic messages URL', () => {
  const attempts = [
    'http://api.deepseek.com/anthropic/v1/messages',
    'https://api.deepseek.com/v1/messages',
    'https://evil.example/anthropic/v1/messages',
    'https://user:pass@api.deepseek.com/anthropic/v1/messages',
    'https://api.deepseek.com:8443/anthropic/v1/messages',
    'https://api.deepseek.com/anthropic//v1/messages',
    'https://api.deepseek.com/anthropic/v1/messages?x=1',
    'relative/path',
  ];
  for (const endpoint of attempts) {
    assert.throws(() => createDeepSeekTransport({ endpoint, apiKey: KEY, pricing: PRICING, fetch: fakeFetch(() => messageResponse()).fetchImpl }), /INVALID_ENDPOINT/, endpoint);
  }
  assert.throws(() => createDeepSeekTransport({ endpoint: ENDPOINT, apiKey: 'short', pricing: PRICING }), /INVALID_CREDENTIAL/);
  assert.throws(() => createDeepSeekTransport({ endpoint: ENDPOINT, apiKey: KEY, pricing: { ...PRICING, denominator: 0 } }), /INVALID_PRICING/);
  assert.doesNotThrow(() => createDeepSeekTransport({ endpoint: ENDPOINT, apiKey: KEY, pricing: PRICING }));
});

test('dispatches one nonstreaming, thinking-disabled JSON request with host-only credentials', async () => {
  const { fetchImpl, calls } = fakeFetch(() => messageResponse());
  const subject = transport(fetchImpl);
  const payload = payloadFor();

  const result = await subject.execute(payload);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'manual');

  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], KEY);
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['content-type'], 'application/json');

  const body = requestBody(call.init);
  assert.equal(body['model'], 'deepseek-flash');
  assert.equal(body['max_tokens'], 1000);
  assert.equal(body['stream'], false);
  assert.deepEqual(body['thinking'], { type: 'disabled' });
  assert.equal('tools' in body, false);
  assert.equal('tool_choice' in body, false);
  assert.equal('reasoning' in body, false);
  assert.equal(JSON.stringify(body).includes(KEY), false);
  assert.match(String(body['system']), /Do not expose hidden reasoning/);
  assert.doesNotMatch(String(body['system']), /think step by step|chain[- ]of[- ]thought|show your (?:work|reasoning|thinking)/i);
  const messages = body['messages'] as readonly { role: string }[];
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, 'user');
  assert.match(String((messages[0] as unknown as { content: string }).content), /"taskId":"task-calc-001"/);

  assert.deepEqual(result, {
    proposal: { proposalId: 'msg-1', content: PROPOSAL_TEXT },
    observedUsage: { inputTokens: 120, outputTokens: 40, costUsd: 0.00016, billableTokens: 160 },
  });
  assert.deepEqual(subject.lastModelIdentity, { requested: 'deepseek-flash', returned: 'deepseek-v4.1' });
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(JSON.stringify(subject.lastModelIdentity).includes(KEY), false);

  const executed = await executeTransport(subject, payload, payload.request);
  assert.equal(executed.outcome, 'observed');
});

test('denies admission before any fetch when bounds are unsupported or the request is malformed', async () => {
  const cases: readonly { payload: HostModelTransportPayload; reason: RegExp }[] = [
    { payload: payloadFor({ maxInputTokens: 50 }), reason: /^INPUT_TOKENS_UNBOUNDED/ },
    { payload: payloadFor({ maxCostUsd: 0 }), reason: /^UNSUPPORTED_COST_BOUND/ },
    { payload: payloadFor({ maxCostUsd: 0.000001 }), reason: /^COST_BOUND_UNSUPPORTED/ },
    { payload: { ...payloadFor(), caps: { ...payloadFor().caps, maxBillableTokens: 100 } }, reason: /^BILLABLE_BOUND_UNSUPPORTED/ },
    { payload: payloadFor({ role: 'admin' as ProviderRequest['role'] }), reason: /^INVALID_REQUEST/ },
  ];
  for (const { payload, reason } of cases) {
    const { fetchImpl, calls } = fakeFetch(() => messageResponse());
    const result = await transport(fetchImpl).execute(payload);
    assert.equal(calls.length, 0);
    assert.equal((result as { outcome?: string }).outcome, 'denied');
    assert.match((result as { reason: string }).reason, reason);
    assert.equal('proposal' in result, false);
    assert.equal(JSON.stringify(result).includes(KEY), false);
  }
});

test('refuses redirects without following or re-sending them', async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 307, headers: { location: 'https://evil.example/collect' } }));
  const result = await transport(fetchImpl).execute(payloadFor());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init.redirect, 'manual');
  assert.deepEqual(result, { outcome: 'uncertain', reason: 'PROVIDER_REDIRECT_REFUSED: redirects are never followed after dispatch' });
});

test('charges timeouts and connection failures after dispatch as uncertain without retry', async () => {
  const failures: readonly { thrown: unknown; reason: RegExp }[] = [
    { thrown: new DOMException('The operation was aborted due to timeout', 'TimeoutError'), reason: /^PROVIDER_TIMEOUT/ },
    { thrown: new TypeError('fetch failed'), reason: /^PROVIDER_CONNECTION_FAILED/ },
  ];
  for (const { thrown, reason } of failures) {
    const { fetchImpl, calls } = fakeFetch(() => Promise.reject(thrown));
    const payload = payloadFor({ timeoutMs: 5 });
    const result = await transport(fetchImpl).execute(payload);
    assert.equal(calls.length, 1);
    assert.equal((result as { outcome?: string }).outcome, 'uncertain');
    assert.match((result as { reason: string }).reason, reason);
    assert.equal(JSON.stringify(result).includes(KEY), false);
  }
});

test('treats HTTP errors as uncertain and never retries them', async () => {
  for (const status of [400, 429, 500, 503]) {
    const { fetchImpl, calls } = fakeFetch(() => new Response('{"error":"boom"}', { status }));
    const result = await transport(fetchImpl).execute(payloadFor());
    assert.equal(calls.length, 1);
    assert.deepEqual(result, { outcome: 'uncertain', reason: `PROVIDER_HTTP_ERROR: status ${status} after dispatch` });
  }
});

test('refuses malformed or unexpected content as typed invalid output', async () => {
  const cases: readonly { response: Response; code: string }[] = [
    { response: messageResponse({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'run', input: {} }] }), code: 'UNEXPECTED_CONTENT' },
    { response: messageResponse({ content: [{ type: 'thinking', thinking: 'raw reasoning' }] }), code: 'UNEXPECTED_CONTENT' },
    {
      response: messageResponse({
        content: [
          { type: 'text', text: PROPOSAL_TEXT },
          { type: 'text', text: PROPOSAL_TEXT },
        ],
      }),
      code: 'UNEXPECTED_CONTENT',
    },
    { response: messageResponse({ content: [{ type: 'text', text: 'not json' }] }), code: 'CONTENT_NOT_JSON' },
    { response: messageResponse({ content: [{ type: 'text', text: '[1,2]' }] }), code: 'CONTENT_NOT_OBJECT' },
    { response: messageResponse({ stop_reason: 'tool_use' }), code: 'TOOL_CALL_FORBIDDEN' },
    { response: messageResponse({ model: undefined }), code: 'MISSING_MODEL' },
    { response: messageResponse({ usage: undefined }), code: 'INVALID_USAGE' },
    { response: messageResponse({ usage: { input_tokens: 'many', output_tokens: 40 } }), code: 'INVALID_USAGE' },
    { response: messageResponse({ type: 'error' }), code: 'UNEXPECTED_CONTENT' },
    { response: new Response('not json', { status: 200 }), code: 'MALFORMED_JSON' },
  ];
  for (const { response, code } of cases) {
    const { fetchImpl, calls } = fakeFetch(() => response);
    const result = await transport(fetchImpl).execute(payloadFor());
    assert.equal(calls.length, 1);
    assert.equal((result as { outcome?: string }).outcome, 'invalid');
    const errors = (result as { errors: readonly { code: string }[] }).errors;
    assert.equal(errors[0]?.code, code);
    assert.equal('proposal' in result, false);
    assert.equal(JSON.stringify(result).includes(KEY), false);
  }
});

test('keeps validated usage on a refused content response', async () => {
  const { fetchImpl } = fakeFetch(() => messageResponse({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'run', input: {} }] }));
  const result = (await transport(fetchImpl).execute(payloadFor())) as { observedUsage?: { inputTokens: number; outputTokens: number } };
  assert.equal(result.observedUsage?.inputTokens, 120);
  assert.equal(result.observedUsage?.outputTokens, 40);
});
