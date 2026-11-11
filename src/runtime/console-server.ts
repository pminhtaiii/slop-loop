/**
 * Protected loopback console server for runtime-evaluation/1 (T015).
 *
 * A local operator tool over the same injected `EvaluationService` the CLI uses. It owns transport
 * policy only: loopback binding, exact Host/Origin, operator token, a 64 KiB body cap, path-segment
 * decoding before any owner call, serialised mutations and no CORS. UC-05 approval/decision and
 * comparison arrive as narrow injected ports; nothing here reimplements or reconstructs them.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sha256Text } from '../uc01/contracts.ts';
import type { CatalogEntry } from './evaluation-profile.ts';
import { renderConsolePage } from './console-page.ts';
import { DIGEST, ID, type EvaluationService, type ServiceFailure, type ServiceResult } from './evaluation-service.ts';

const LOOPBACK = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const TOKEN_HEADER = 'x-operator-token';
const PROFILE_ID = 'uc03-runtime-evaluation-v1';
const SAFE_MEDIA_TYPES = new Set(['text/plain', 'text/x-diff', 'application/json']);
const STATUS_BY_FAILURE: Readonly<Record<ServiceFailure, number>> = { 'invalid-input': 400, 'not-found': 404, conflict: 409, busy: 409, blocked: 503 };

export interface ConsoleArtifact {
  readonly text: string;
  readonly taskId: string;
  readonly digest: string;
  readonly mediaType: string;
}

/** Narrow local shape of the UC-05 approval API; `src/approvals/*` is neither imported nor reimplemented. */
export interface ConsoleApprovalPort {
  presentation(experimentId: string): ConsoleOutcome;
  decide(input: unknown): ConsoleOutcome;
}

/** The exact body the page sends, validated by the route so the port never sees raw input. */
export interface ConsoleComparisonRequest {
  readonly idempotencyKey: string;
  readonly baselineId: string;
  readonly candidateId: string;
  readonly policy: 'guarded' | 'strict';
}

/** Read-only comparison over stored attempts. */
export interface ConsoleComparisonPort {
  compare(input: ConsoleComparisonRequest): ConsoleOutcome;
}

type ConsoleOutcome = ServiceResult<unknown> | Promise<ServiceResult<unknown>>;

export interface ConsoleServerOptions {
  readonly service: EvaluationService;
  readonly catalog: readonly CatalogEntry[];
  readonly operatorToken: string;
  readonly artifacts?: ReadonlyMap<string, ConsoleArtifact> | undefined;
  readonly approval?: ConsoleApprovalPort | undefined;
  readonly comparison?: ConsoleComparisonPort | undefined;
}

export interface ConsoleAddress {
  readonly host: '127.0.0.1';
  readonly port: number;
}

export interface ConsoleServer {
  listen(port?: number): Promise<ConsoleAddress>;
  close(): Promise<void>;
  address(): ConsoleAddress | null;
}

type BodyResult = Readonly<{ value: Record<string, unknown> }> | null;

function safeId(value: string | undefined): string | undefined {
  return value !== undefined && ID.test(value) ? value : undefined;
}

const COMPARISON_KEYS: readonly string[] = ['idempotencyKey', 'baselineId', 'candidateId', 'policy'];
const COMPARISON_POLICIES: ReadonlySet<string> = new Set(['guarded', 'strict']);

/** Exact key set, bounded key and safe ids; anything else leaves the port uncalled. */
function comparisonRequest(body: Record<string, unknown>): ConsoleComparisonRequest | undefined {
  const keys = Object.keys(body);
  if (keys.length !== COMPARISON_KEYS.length || !COMPARISON_KEYS.every(key => Object.hasOwn(body, key))) return undefined;
  const { idempotencyKey, baselineId, candidateId, policy } = body;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 128) return undefined;
  const baseline = safeId(typeof baselineId === 'string' ? baselineId : undefined);
  const candidate = safeId(typeof candidateId === 'string' ? candidateId : undefined);
  if (baseline === undefined || candidate === undefined || typeof policy !== 'string' || !COMPARISON_POLICIES.has(policy)) return undefined;
  return { idempotencyKey, baselineId: baseline, candidateId: candidate, policy: policy as ConsoleComparisonRequest['policy'] };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text, 'utf8'),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

/** @param port the actual bound port; the token is the only credential and never enters a URL. */
export function createConsoleServer(options: ConsoleServerOptions): ConsoleServer {
  const { service, catalog, operatorToken, artifacts, approval, comparison } = options;
  if (typeof operatorToken !== 'string' || operatorToken.length < 16 || operatorToken.length > 512) throw new Error('Invalid operator token');
  // shortcut: no TLS, the socket is loopback-only and never bound to a routable interface; upgrade if serving off-host.
  const tokenDigest = createHash('sha256').update(operatorToken, 'utf8').digest();
  const page = renderConsolePage();
  const catalogView = Object.freeze({
    profileId: PROFILE_ID,
    cases: Object.freeze(
      catalog.map(entry =>
        Object.freeze({
          caseId: entry.caseId,
          catalogEntryId: entry.catalogEntryId,
          version: entry.version,
          caseDigest: entry.caseDigest,
          publicTaskDigest: entry.publicTaskDigest,
          initialRepositoryDigest: entry.initialRepositoryDigest,
          graderVersion: entry.grader.version,
          graderDigest: entry.grader.digest,
          ready: [entry.caseDigest, entry.publicTaskDigest, entry.initialRepositoryDigest, entry.grader.digest].every(value => DIGEST.test(value)),
        }),
      ),
    ),
  });

  let port = 0;
  let tail: Promise<void> = Promise.resolve();

  /** One in-process chain: mutations never interleave, and a rejected mutation leaves the chain usable. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const started = tail.then(task, task);
    tail = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  };

  const hostOk = (host: string): boolean => host === `${LOOPBACK}:${port}` || host === `localhost:${port}`;
  const originOk = (origin: string | undefined): boolean => origin === `http://${LOOPBACK}:${port}` || origin === `http://localhost:${port}`;
  const tokenOk = (value: string | string[] | undefined): boolean => typeof value === 'string' && timingSafeEqual(createHash('sha256').update(value, 'utf8').digest(), tokenDigest);

  const sendPage = (res: ServerResponse): void => {
    if (res.writableEnded) return;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(page, 'utf8'),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(page);
  };

  const respond = async (res: ServerResponse, run: () => ConsoleOutcome): Promise<void> => {
    let result: ServiceResult<unknown>;
    try {
      result = await run();
    } catch {
      send(res, 500, { ok: false, error: 'SERVICE_ERROR' });
      return;
    }
    if (!result.ok) {
      send(res, STATUS_BY_FAILURE[result.status], { ok: false, error: result.reasonCode });
      return;
    }
    send(res, 200, { ok: true, result: result.value });
  };

  /** Denies a non-mutation, a missing/incorrect token, a cross/missing origin or a non-JSON body before any owner call. */
  const mutationAllowed = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== 'POST') {
      send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
      return false;
    }
    if (!tokenOk(req.headers[TOKEN_HEADER])) {
      send(res, 403, { ok: false, error: 'FORBIDDEN_TOKEN' });
      return false;
    }
    if (!originOk(req.headers.origin)) {
      send(res, 403, { ok: false, error: 'FORBIDDEN_ORIGIN' });
      return false;
    }
    const contentType = req.headers['content-type'];
    if (typeof contentType !== 'string' || (contentType.split(';')[0] ?? '').trim().toLowerCase() !== 'application/json') {
      send(res, 415, { ok: false, error: 'UNSUPPORTED_MEDIA_TYPE' });
      return false;
    }
    return true;
  };

  const readBody = (req: IncomingMessage, res: ServerResponse): Promise<BodyResult> =>
    new Promise(resolve => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (result: BodyResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      req.on('data', (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          send(res, 413, { ok: false, error: 'REQUEST_TOO_LARGE' });
          finish(null);
          // Drain the remainder without buffering: the operator is local, the socket is disposable.
          req.resume();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (settled) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          send(res, 400, { ok: false, error: 'INVALID_JSON' });
          finish(null);
          return;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          send(res, 400, { ok: false, error: 'INVALID_REQUEST' });
          finish(null);
          return;
        }
        finish({ value: parsed as Record<string, unknown> });
      });
      req.on('error', () => finish(null));
    });

  const serveArtifact = (res: ServerResponse, raw: string | undefined): void => {
    const id = safeId(raw);
    if (!id) {
      send(res, 400, { ok: false, error: 'INVALID_ID' });
      return;
    }
    const artifact = artifacts?.get(id);
    if (!artifact) {
      send(res, 404, { ok: false, error: 'UNKNOWN_ARTIFACT' });
      return;
    }
    if (
      !SAFE_MEDIA_TYPES.has(artifact.mediaType) ||
      !DIGEST.test(artifact.digest) ||
      !ID.test(artifact.taskId) ||
      Buffer.byteLength(artifact.text, 'utf8') > MAX_ARTIFACT_BYTES ||
      sha256Text(artifact.text) !== artifact.digest
    ) {
      send(res, 409, { ok: false, error: 'ARTIFACT_REFUSED' });
      return;
    }
    send(res, 200, { ok: true, result: { id, taskId: artifact.taskId, digest: artifact.digest, mediaType: artifact.mediaType, text: artifact.text } });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = req.headers.host;
    // Exact Host defeats DNS rebinding: a name resolving to loopback still arrives with its own Host.
    if (typeof host !== 'string' || !hostOk(host)) {
      send(res, 403, { ok: false, error: 'FORBIDDEN_HOST' });
      return;
    }
    const [pathname = '/'] = (req.url ?? '/').split('?');
    const segments: string[] = [];
    for (const part of pathname.split('/')) {
      if (part === '') continue;
      try {
        segments.push(decodeURIComponent(part));
      } catch {
        send(res, 400, { ok: false, error: 'INVALID_PATH' });
        return;
      }
    }

    if (segments[0] !== 'api') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
        return;
      }
      sendPage(res);
      return;
    }

    const resource = segments[1];
    if (resource === 'catalog' && segments.length === 2) {
      if (req.method !== 'GET') {
        send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
        return;
      }
      send(res, 200, { ok: true, result: catalogView });
      return;
    }

    if (resource === 'experiments' && segments.length === 2) {
      if (!mutationAllowed(req, res)) return;
      const body = await readBody(req, res);
      if (body === null) return;
      await respond(res, () => serial(() => service.startExperiment(body.value)));
      return;
    }

    if (resource === 'experiments' && segments.length === 3) {
      if (req.method !== 'GET') {
        send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
        return;
      }
      const id = safeId(segments[2]);
      if (!id) {
        send(res, 400, { ok: false, error: 'INVALID_ID' });
        return;
      }
      await respond(res, () => service.getExperiment(id));
      return;
    }

    if (resource === 'experiments' && segments.length === 4) {
      const id = safeId(segments[2]);
      if (!id) {
        send(res, 400, { ok: false, error: 'INVALID_ID' });
        return;
      }
      const action = segments[3];
      if (action === 'approval') {
        if (req.method !== 'GET') {
          send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
          return;
        }
        if (!approval) {
          send(res, 503, { ok: false, error: 'APPROVAL_UNAVAILABLE' });
          return;
        }
        await respond(res, () => approval.presentation(id));
        return;
      }
      if (action !== 'decision' && action !== 'answers' && action !== 'directions' && action !== 'continue') {
        send(res, 404, { ok: false, error: 'UNKNOWN_OPERATION' });
        return;
      }
      if (!mutationAllowed(req, res)) return;
      const body = await readBody(req, res);
      if (body === null) return;
      if (action === 'decision') {
        if (!approval) {
          send(res, 503, { ok: false, error: 'APPROVAL_UNAVAILABLE' });
          return;
        }
        await respond(res, () => serial(async () => approval.decide({ ...body.value, experimentId: id })));
        return;
      }
      if (action === 'answers') {
        await respond(res, () => serial(() => service.answerClarification({ ...body.value, id })));
        return;
      }
      if (action === 'directions') {
        await respond(res, () => serial(() => service.issueDirection({ ...body.value, id })));
        return;
      }
      await respond(res, () => serial(() => service.continueExperiment({ ...body.value, id })));
      return;
    }

    if (resource === 'artifacts' && segments.length === 3) {
      if (req.method !== 'GET') {
        send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
        return;
      }
      serveArtifact(res, segments[2]);
      return;
    }

    if (resource === 'comparisons' && segments.length === 2) {
      if (!mutationAllowed(req, res)) return;
      if (!comparison) {
        send(res, 503, { ok: false, error: 'COMPARISON_UNAVAILABLE' });
        return;
      }
      const body = await readBody(req, res);
      if (body === null) return;
      const request = comparisonRequest(body.value);
      if (request === undefined) {
        send(res, 400, { ok: false, error: 'INVALID_REQUEST' });
        return;
      }
      await respond(res, () => serial(async () => comparison.compare(request)));
      return;
    }

    send(res, 404, { ok: false, error: 'UNKNOWN_OPERATION' });
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => send(res, 500, { ok: false, error: 'INTERNAL_ERROR' }));
  });

  const listen = (requestedPort = 0): Promise<ConsoleAddress> =>
    new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        const info = server.address();
        if (typeof info !== 'object' || info === null) {
          reject(new Error('Invalid listen address'));
          return;
        }
        port = info.port;
        resolve({ host: LOOPBACK, port });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(requestedPort, LOOPBACK);
    });

  return {
    listen,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    address: () => (port === 0 ? null : { host: LOOPBACK, port }),
  };
}
