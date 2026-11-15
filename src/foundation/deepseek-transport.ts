/**
 * DeepSeek Anthropic-messages transport (runtime-evaluation/1, T003; operator pinning T049).
 *
 * Host-only, nonstreaming, thinking-disabled JSON text over native fetch.
 * Admission is conservative and precedes dispatch; every post-dispatch failure is uncertain.
 * Owned path: src/foundation/deepseek-transport.ts
 */

import type { ModelProposal, ProviderRequest, ProviderUsage, ValidationError } from '../contracts/foundation/uc03.ts';
import { validateProviderUsage } from '../contracts/foundation/uc03.ts';
import type { HostModelTransport, HostModelTransportPayload } from './model.ts';
import { admitReviewProfile, type DeepSeekReviewPrompt } from './deepseek-review-profile.ts';
import { admit, ANTHROPIC_VERSION, DEFAULT_ENDPOINT, isNonNegativeInteger, microUsd, pinnedEndpointUrl, validationError, type Admission, type DeepSeekPricing } from './deepseek-transport-request.ts';
import type { RunUsageLimiter } from './run-usage-limit.ts';

export type { DeepSeekReviewPrompt } from './deepseek-review-profile.ts';
export type { DeepSeekPricing } from './deepseek-transport-request.ts';
export { DEEPSEEK_REVIEW_PROMPT } from './deepseek-review-profile.ts';

export type DeepSeekModelIdentity = Readonly<{ requested: string; returned: string }>;

export interface DeepSeekTransport extends HostModelTransport {
  execute(payload: HostModelTransportPayload): Promise<DeepSeekTransportResult>;
  /** Requested and provider-returned identity of the last validated response. */
  readonly lastModelIdentity: DeepSeekModelIdentity | undefined;
  /** Identity is keyed by the actual task/run/request that crossed this transport. */
  identityForRequest(taskId: string, runId: string, providerRequestId: string): DeepSeekModelIdentity | undefined;
  /** Returns a run identity only when every observed response in that run agrees. */
  identityForRun(taskId: string, runId: string): DeepSeekModelIdentity | undefined;
  readonly reviewPrompt?: DeepSeekReviewPrompt | undefined;
}

export interface DeepSeekTransportOptions {
  /** Operator-pinned `<base>/messages` URL; the public DeepSeek endpoint when omitted. */
  readonly endpoint?: string | undefined;
  /** Explicit acknowledgement that a plain-`http` endpoint was chosen by the operator. */
  readonly allowInsecureHttp?: boolean | undefined;
  readonly apiKey: string;
  readonly pricing: DeepSeekPricing;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly reviewPrompt?: DeepSeekReviewPrompt | undefined;
  readonly runLimiter?: RunUsageLimiter | undefined;
}

/** Module-private brand: only this factory can mint a trusted production transport. */
const DEEPSEEK_TRANSPORT = Symbol('deepseek-transport');

/** True only for objects returned by createDeepSeekTransport in this process. */
export function isDeepSeekTransport(value: unknown): value is DeepSeekTransport {
  const slot = typeof value === 'object' && value !== null ? Object.getOwnPropertyDescriptor(value, DEEPSEEK_TRANSPORT) : undefined;
  return slot !== undefined && 'value' in slot && slot.value === true;
}

const CREDENTIAL = /^[\x21-\x7e]{8,512}$/u;
const RESPONSE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

export type DeepSeekTransportResult =
  | { readonly proposal: ModelProposal; readonly observedUsage: ProviderUsage }
  | { readonly outcome: 'uncertain'; readonly reason: string }
  | { readonly outcome: 'denied'; readonly reason: string }
  | { readonly outcome: 'invalid'; readonly errors: readonly ValidationError[]; readonly observedUsage?: ProviderUsage | undefined };

type ParsedMessage =
  | { readonly ok: true; readonly proposal: ModelProposal; readonly usage: ProviderUsage; readonly model: string }
  | { readonly ok: false; readonly errors: readonly ValidationError[]; readonly observedUsage?: ProviderUsage | undefined };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The one shared rule both pinning sites use. The normalized `href` is frozen here at
 * construction and compared exactly before every call, so no later input can re-target a call.
 */
function pinEndpoint(endpoint: string | undefined, allowInsecureHttp: boolean): string {
  if (endpoint === undefined) return DEFAULT_ENDPOINT;
  if (!URL.canParse(endpoint)) throw new Error('INVALID_ENDPOINT: endpoint must be an absolute URL');
  const url = pinnedEndpointUrl(endpoint, allowInsecureHttp);
  if (url === undefined) {
    throw new Error(
      allowInsecureHttp
        ? 'INVALID_ENDPOINT: endpoint must be an absolute http(s) URL with no credentials, query or fragment and a path ending in /messages'
        : 'INVALID_ENDPOINT: endpoint must be an absolute https URL with no credentials, query or fragment and a path ending in /messages, or http with allowInsecureHttp',
    );
  }
  return url.href;
}

function assertHostCredential(apiKey: string): void {
  if (!CREDENTIAL.test(apiKey)) throw new Error('INVALID_CREDENTIAL: host API key must be a printable host-only token');
}

function assertPricing(pricing: DeepSeekPricing): DeepSeekPricing {
  const rates = [pricing.inputRate, pricing.outputRate, pricing.cacheRate, pricing.overheadRate];
  if (!rates.every(rate => isNonNegativeInteger(rate)) || !isNonNegativeInteger(pricing.denominator) || pricing.denominator <= 0) {
    throw new Error('INVALID_PRICING: pricing requires non-negative integer rates and a positive integer denominator');
  }
  return Object.freeze({ ...pricing });
}

function parseUsage(raw: unknown, pricing: DeepSeekPricing): { readonly ok: true; readonly usage: ProviderUsage } | { readonly ok: false; readonly error: ValidationError } {
  if (!isRecord(raw)) return { ok: false, error: validationError('usage', 'INVALID_USAGE', 'Provider usage must be an object') };
  const inputTokens = raw['input_tokens'];
  const outputTokens = raw['output_tokens'];
  const cacheTokens = raw['cache_read_input_tokens'] ?? 0;
  if (!isNonNegativeInteger(inputTokens) || !isNonNegativeInteger(outputTokens) || !isNonNegativeInteger(cacheTokens)) {
    return { ok: false, error: validationError('usage', 'INVALID_USAGE', 'Provider usage token counts must be non-negative integers') };
  }
  const billableTokens = inputTokens + outputTokens + cacheTokens;
  const costUsd = microUsd(pricing, inputTokens, outputTokens, cacheTokens) / 1_000_000;
  if (!Number.isSafeInteger(billableTokens) || !Number.isFinite(costUsd)) {
    return { ok: false, error: validationError('usage', 'INVALID_USAGE', 'Provider usage exceeds bounded accounting') };
  }
  const usageRes = validateProviderUsage({ inputTokens, outputTokens, costUsd, billableTokens });
  return usageRes.ok ? { ok: true, usage: usageRes.value } : { ok: false, error: usageRes.errors[0] ?? validationError('usage', 'INVALID_USAGE', 'Provider usage is invalid') };
}

function invalidContent(path: string, code: string, message: string, observedUsage?: ProviderUsage): ParsedMessage {
  return observedUsage === undefined ? { ok: false, errors: [validationError(path, code, message)] } : { ok: false, errors: [validationError(path, code, message)], observedUsage };
}

/** One text block carrying one JSON object; tool calls, extra blocks and reasoning blocks refuse. */
function parseMessage(raw: unknown, pricing: DeepSeekPricing, request: ProviderRequest, maxOutputBytes?: number): ParsedMessage {
  if (!isRecord(raw)) return invalidContent('message', 'INVALID_TYPE', 'Provider response must be a JSON object');
  const usage = parseUsage(raw['usage'], pricing);
  const observedUsage = usage.ok ? usage.usage : undefined;
  if (!usage.ok) return invalidContent('usage', usage.error.code, usage.error.message);
  if (raw['type'] !== undefined && raw['type'] !== 'message') return invalidContent('type', 'UNEXPECTED_CONTENT', 'Provider response is not a message', observedUsage);
  const model = raw['model'];
  if (typeof model !== 'string' || !model.trim()) return invalidContent('model', 'MISSING_MODEL', 'Provider response must identify the returned model', observedUsage);
  const content = raw['content'];
  if (!Array.isArray(content) || content.length !== 1) return invalidContent('content', 'UNEXPECTED_CONTENT', 'Provider content must be exactly one block', observedUsage);
  const block = content[0];
  if (!isRecord(block) || block['type'] !== 'text' || typeof block['text'] !== 'string' || !block['text'].trim()) {
    return invalidContent('content', 'UNEXPECTED_CONTENT', 'Provider content must be a single non-empty text block', observedUsage);
  }
  if (raw['stop_reason'] === 'tool_use') return invalidContent('stop_reason', 'TOOL_CALL_FORBIDDEN', 'Provider requested an unsupported tool call', observedUsage);
  const text = block['text'];
  if (maxOutputBytes !== undefined && Buffer.byteLength(text, 'utf8') > maxOutputBytes)
    return invalidContent('content', 'OUTPUT_TOO_LARGE', 'Provider content exceeds the admitted byte bound', observedUsage);
  let contentValue: unknown;
  try {
    contentValue = JSON.parse(text);
  } catch {
    return invalidContent('content', 'CONTENT_NOT_JSON', 'Provider content is not JSON text', observedUsage);
  }
  if (!isRecord(contentValue)) return invalidContent('content', 'CONTENT_NOT_OBJECT', 'Provider content must be one JSON object', observedUsage);
  const responseId = typeof raw['id'] === 'string' && RESPONSE_ID.test(raw['id']) ? raw['id'] : request.providerRequestId;
  return { ok: true, proposal: { proposalId: responseId, content: text }, usage: usage.usage, model: model.trim() };
}

function isTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TimeoutError';
}

async function boundedBody(response: Response, limit: number, timeoutMs: number): Promise<string> {
  if (!response.body) throw new Error('BODY_MISSING');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('BODY_TIMEOUT')), timeoutMs);
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), expired]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error('BODY_TOO_LARGE');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}

export function createDeepSeekTransport(options: DeepSeekTransportOptions): DeepSeekTransport {
  const endpoint = pinEndpoint(options.endpoint, options.allowInsecureHttp === true);
  assertHostCredential(options.apiKey);
  const pricing = assertPricing(options.pricing);
  const reviewPrompt = admitReviewProfile(options.reviewPrompt);
  const runLimiter = options.runLimiter;
  const fetchFn = options.fetch ?? globalThis.fetch;
  let lastModelIdentity: DeepSeekModelIdentity | undefined;
  const runIdentities = new Map<string, Map<string, DeepSeekModelIdentity>>();
  const runKeyOf = (taskId: string, runId: string): string => JSON.stringify([taskId, runId]);

  const identityForRequest = (taskId: string, runId: string, providerRequestId: string): DeepSeekModelIdentity | undefined => runIdentities.get(runKeyOf(taskId, runId))?.get(providerRequestId);
  const identityForRun = (taskId: string, runId: string): DeepSeekModelIdentity | undefined => {
    const identities = [...(runIdentities.get(runKeyOf(taskId, runId))?.values() ?? [])];
    if (identities.length === 0) return undefined;
    const first = identities[0];
    if (!first || identities.some(identity => identity.requested !== first.requested || identity.returned !== first.returned)) return undefined;
    return first;
  };

  const transport: DeepSeekTransport = {
    get reviewPrompt() {
      return reviewPrompt;
    },
    get lastModelIdentity() {
      return lastModelIdentity;
    },
    identityForRequest,
    identityForRun,
    async execute(payload: HostModelTransportPayload): Promise<DeepSeekTransportResult> {
      const admission: Admission = admit(payload, pricing, endpoint, reviewPrompt);
      if (!admission.ok) return { outcome: 'denied', reason: admission.reason };
      if (admission.target !== endpoint) return { outcome: 'denied', reason: 'ENDPOINT_DRIFT: the call target no longer matches the pinned endpoint' };

      const call = {
        // Counters are keyed by the request's own ids, never by the state envelope.
        taskId: admission.request.taskId,
        runId: admission.request.runId,
        callId: admission.request.providerRequestId,
        maxInputTokens: admission.request.maxInputTokens,
        maxOutputTokens: admission.request.maxOutputTokens,
      };
      // The runaway stop runs after admission and before dispatch; a refused call makes no fetch.
      if (runLimiter !== undefined && !runLimiter.admit(call)) {
        return { outcome: 'denied', reason: 'RUN_USAGE_LIMIT_REACHED: this run reached its call or token ceiling before dispatch' };
      }

      let response: Response;
      try {
        response = await fetchFn(admission.target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': ANTHROPIC_VERSION,
            'x-api-key': options.apiKey,
          },
          body: admission.body,
          redirect: 'manual',
          signal: AbortSignal.timeout(payload.caps.timeoutMs),
        });
      } catch (caught) {
        runLimiter?.settle(call);
        return { outcome: 'uncertain', reason: isTimeout(caught) ? 'PROVIDER_TIMEOUT: request timed out after dispatch' : 'PROVIDER_CONNECTION_FAILED: request failed after dispatch' };
      }

      if (response.status >= 300 && response.status < 400) {
        runLimiter?.settle(call);
        return { outcome: 'uncertain', reason: 'PROVIDER_REDIRECT_REFUSED: redirects are never followed after dispatch' };
      }
      if (!response.ok) {
        runLimiter?.settle(call);
        return { outcome: 'uncertain', reason: `PROVIDER_HTTP_ERROR: status ${response.status} after dispatch` };
      }

      let text: string;
      try {
        text = admission.request.role === 'reviewer' && reviewPrompt ? await boundedBody(response, reviewPrompt.maxResponseBytes, payload.caps.timeoutMs) : await response.text();
      } catch {
        runLimiter?.settle(call);
        return { outcome: 'uncertain', reason: 'PROVIDER_BODY_READ_FAILED: response body unreadable after dispatch' };
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        runLimiter?.settle(call);
        return { outcome: 'invalid', errors: [validationError('body', 'MALFORMED_JSON', 'Provider response body is not JSON')] };
      }
      const parsed = parseMessage(body, pricing, admission.request, admission.request.role === 'reviewer' ? reviewPrompt?.maxOutputBytes : undefined);
      // Only parsed usage from a validated 2xx replaces the provisional charge; anything else keeps it.
      runLimiter?.settle(call, parsed.ok ? parsed.usage : parsed.observedUsage);
      if (!parsed.ok) {
        return parsed.observedUsage === undefined ? { outcome: 'invalid', errors: parsed.errors } : { outcome: 'invalid', errors: parsed.errors, observedUsage: parsed.observedUsage };
      }
      const identity = Object.freeze({ requested: admission.request.modelId, returned: parsed.model });
      lastModelIdentity = identity;
      const runKey = runKeyOf(payload.state.taskId, payload.state.runId);
      let requests = runIdentities.get(runKey);
      if (requests === undefined) {
        requests = new Map();
        runIdentities.set(runKey, requests);
        // Evaluation runs are finite; bound retained host telemetry without borrowing another run's identity.
        if (runIdentities.size > 128) {
          const oldest = runIdentities.keys().next();
          if (!oldest.done) runIdentities.delete(oldest.value);
        }
      }
      requests.set(admission.request.providerRequestId, identity);
      return { proposal: parsed.proposal, observedUsage: parsed.usage };
    },
  };
  // Defaults are non-enumerable and non-configurable, so an object spread cannot launder the brand.
  Object.defineProperty(transport, DEEPSEEK_TRANSPORT, { value: true });
  Object.defineProperty(transport, 'reviewPrompt', { value: reviewPrompt, writable: false, configurable: false, enumerable: true });
  return transport;
}
