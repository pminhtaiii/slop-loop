import { createHash } from 'node:crypto';
import {
  type ActivityEvent,
  type PortProvenance,
  type ProviderUsage,
  type TelemetryPort,
  isProtectedPath,
  validateActivityEvent,
} from '../contracts/uc03.ts';

export interface TelemetryOptions {
  readonly provenance?: PortProvenance;
  readonly maxDiagnosticBytes?: number;
  readonly secretPatterns?: readonly (RegExp | string)[];
  readonly sink?: (event: ActivityEvent) => void | Promise<void>;
}

export interface RedactedDiagnostic {
  readonly diagnosticRef: string;
  readonly sanitizedContent: string;
  readonly byteCount: number;
  readonly truncated: boolean;
  readonly redacted: boolean;
}

const BUILTIN_SECRET_PATTERNS: readonly RegExp[] = [
  /MARKER_SECRET[A-Za-z0-9_-]*/gi,
  /marker[-_]?secret[-_]?[A-Za-z0-9_-]*/gi,
  /-----BEGIN[ A-Z0-9_-]+KEY-----[^-]+-----END[ A-Z0-9_-]+KEY-----/gs,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g,
  /sk-[A-Za-z0-9-_]{20,}/g,
  /(?:token|secret|password|api[_-]?key|access[_-]?token|auth)[\s:=]+[^\s,;"']+/gi,
];

const TRUNCATION_SUFFIX = ' ... [TRUNCATED]';
const TRUNCATION_NOTICE = '... [TRUNCATED]';

export function sanitizeText(
  text: string,
  customPatterns?: readonly (RegExp | string)[]
): string {
  if (typeof text !== 'string' || text.length === 0) {
    return text;
  }

  let sanitized = text;

  // Apply custom patterns first if provided
  if (customPatterns && customPatterns.length > 0) {
    for (const pattern of customPatterns) {
      if (typeof pattern === 'string') {
        if (pattern.length > 0) {
          sanitized = sanitized.replaceAll(pattern, '[REDACTED]');
        }
      } else if (pattern instanceof RegExp) {
        const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
        const re = new RegExp(pattern.source, flags);
        sanitized = sanitized.replace(re, () => '[REDACTED]');
      }
    }
  }

  // Apply built-in secret patterns
  for (const regex of BUILTIN_SECRET_PATTERNS) {
    const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
    const re = new RegExp(regex.source, flags);
    sanitized = sanitized.replace(re, () => '[REDACTED]');
  }

  return sanitized;
}

export function truncateUtf8ToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) {
    return '';
  }
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) {
    return text;
  }

  let cut = maxBytes;
  const initialByte = buf[cut];
  if (initialByte !== undefined && (initialByte & 0xc0) === 0x80) {
    while (cut > 0) {
      const b = buf[cut];
      if (b === undefined || (b & 0xc0) !== 0x80) {
        break;
      }
      cut--;
    }
  }

  return buf.subarray(0, cut).toString('utf8');
}

export function sanitizeDiagnostic(
  content: string,
  options?: {
    readonly maxBytes?: number;
    readonly customPatterns?: readonly (RegExp | string)[];
  }
): RedactedDiagnostic {
  if (typeof content !== 'string') {
    throw new TypeError('content must be a string');
  }

  const maxBytes = options?.maxBytes;
  if (
    maxBytes === undefined ||
    typeof maxBytes !== 'number' ||
    !Number.isFinite(maxBytes) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  ) {
    throw new Error('INVALID_DIAGNOSTIC_LIMIT: maxBytes must be a finite positive integer');
  }

  const originalSanitized = sanitizeText(content, options?.customPatterns);
  const wasRedacted = originalSanitized !== content;

  let finalContent = originalSanitized;
  let wasTruncated = false;

  let byteLen = Buffer.byteLength(finalContent, 'utf8');
  if (byteLen > maxBytes) {
    wasTruncated = true;
    const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, 'utf8');
    const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, 'utf8');

    if (maxBytes >= suffixBytes) {
      const targetPrefixBytes = maxBytes - suffixBytes;
      const prefix = truncateUtf8ToBytes(originalSanitized, targetPrefixBytes);
      finalContent = prefix.length > 0 ? prefix + TRUNCATION_SUFFIX : TRUNCATION_NOTICE;
    } else if (maxBytes >= noticeBytes) {
      finalContent = TRUNCATION_NOTICE;
    } else {
      finalContent = truncateUtf8ToBytes(TRUNCATION_NOTICE, maxBytes);
    }
    byteLen = Buffer.byteLength(finalContent, 'utf8');
  }

  const hash = createHash('sha256').update(finalContent, 'utf8').digest('hex');
  const diagnosticRef = `diag:sha256:${hash}`;

  return {
    diagnosticRef,
    sanitizedContent: finalContent,
    byteCount: byteLen,
    truncated: wasTruncated,
    redacted: wasRedacted,
  };
}

export function isProtectedPathRef(ref: string): boolean {
  if (typeof ref !== 'string') {
    return false;
  }
  const trimmed = ref.trim();
  if (isProtectedPath(trimmed)) {
    return true;
  }
  const stripped = trimmed.replace(/^file:\/\/\/?/i, '');
  const cleanPath = stripped.split('#')[0]?.split('?')[0] ?? stripped;
  if (isProtectedPath(cleanPath)) {
    return true;
  }
  return false;
}

export function isProtectedPayload(
  val: unknown,
  customPatternsOrSeen?: readonly (RegExp | string)[] | Set<unknown>,
  maybeSeen?: Set<unknown>
): boolean {
  let customPatterns: readonly (RegExp | string)[] | undefined;
  let seen: Set<unknown>;

  if (customPatternsOrSeen instanceof Set) {
    seen = customPatternsOrSeen;
    customPatterns = undefined;
  } else {
    customPatterns = customPatternsOrSeen;
    seen = maybeSeen ?? new Set<unknown>();
  }

  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (isProtectedPathRef(trimmed)) {
      return true;
    }
    if (
      trimmed.includes('-----BEGIN') &&
      trimmed.includes('KEY-----')
    ) {
      return true;
    }
    if (customPatterns && customPatterns.length > 0) {
      for (const pattern of customPatterns) {
        if (typeof pattern === 'string') {
          if (pattern.length > 0 && trimmed.includes(pattern)) {
            return true;
          }
        } else if (pattern instanceof RegExp) {
          const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
          const re = new RegExp(pattern.source, flags);
          if (re.test(trimmed)) {
            return true;
          }
        }
      }
    }
    for (const regex of BUILTIN_SECRET_PATTERNS) {
      const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
      const re = new RegExp(regex.source, flags);
      if (re.test(trimmed)) {
        return true;
      }
    }
    return false;
  }

  if (typeof val === 'object' && val !== null) {
    if (seen.has(val)) {
      return false;
    }
    seen.add(val);
    for (const [key, value] of Object.entries(val)) {
      if (
        isProtectedPayload(key, customPatterns, seen) ||
        isProtectedPayload(value, customPatterns, seen)
      ) {
        return true;
      }
    }
  }

  return false;
}

export class SanitizedTelemetry implements TelemetryPort {
  readonly provenance: PortProvenance;
  private readonly maxDiagnosticBytes: number | undefined;
  private readonly secretPatterns: readonly (RegExp | string)[];
  private readonly sink: ((event: ActivityEvent) => void | Promise<void>) | undefined;
  private readonly events: Map<string, ActivityEvent[]>;
  private readonly runUsage: Map<string, ProviderUsage>;
  private readonly diagnostics: Map<string, RedactedDiagnostic>;

  constructor(options: TelemetryOptions = {}) {
    this.provenance = options.provenance ?? 'real';
    if (options.maxDiagnosticBytes !== undefined) {
      if (
        typeof options.maxDiagnosticBytes !== 'number' ||
        !Number.isFinite(options.maxDiagnosticBytes) ||
        !Number.isSafeInteger(options.maxDiagnosticBytes) ||
        options.maxDiagnosticBytes <= 0
      ) {
        throw new Error('INVALID_DIAGNOSTIC_LIMIT: maxDiagnosticBytes must be a finite positive integer');
      }
      this.maxDiagnosticBytes = options.maxDiagnosticBytes;
    } else {
      this.maxDiagnosticBytes = undefined;
    }
    this.secretPatterns = options.secretPatterns ?? [];
    this.sink = options.sink;
    this.events = new Map();
    this.runUsage = new Map();
    this.diagnostics = new Map();
  }

  async emitActivity(event: ActivityEvent): Promise<void> {
    const validation = validateActivityEvent(event);
    if (!validation.ok) {
      const msg = validation.errors
        .map((err) => `${err.path}: ${err.message} (${err.code})`)
        .join('; ');
      throw new Error(`Invalid ActivityEvent: ${msg}`);
    }

    const valid = validation.value;

    // Reject protected stable identities fail-closed rather than rewriting to preserve linkage
    if (isProtectedPayload(valid.eventId, this.secretPatterns)) {
      throw new Error(`Protected identifier rejected: eventId contains protected data or secret`);
    }
    if (isProtectedPayload(valid.taskId, this.secretPatterns)) {
      throw new Error(`Protected identifier rejected: taskId contains protected data or secret`);
    }
    if (isProtectedPayload(valid.runId, this.secretPatterns)) {
      throw new Error(`Protected identifier rejected: runId contains protected data or secret`);
    }
    if (isProtectedPayload(valid.node, this.secretPatterns)) {
      throw new Error(`Protected identifier rejected: node contains protected data or secret`);
    }
    if (isProtectedPayload(valid.actionType, this.secretPatterns)) {
      throw new Error(`Protected identifier rejected: actionType contains protected data or secret`);
    }
    if (isProtectedPayload(valid.timestamp, this.secretPatterns)) {
      throw new Error(`Protected metadata rejected: timestamp contains protected data or secret`);
    }

    // Reject protected path refs fail-closed
    for (const ref of valid.evidenceRefs) {
      if (typeof ref !== 'string' || ref.trim().length === 0 || isProtectedPathRef(ref)) {
        throw new Error(`Protected path reference rejected: evidenceRefs contains protected path "${ref}"`);
      }
    }

    // Redact permitted bounded diagnostic/outcome fields according to contract
    const sanitizedOutcome = sanitizeText(valid.outcome, this.secretPatterns);
    const sanitizedEvidenceRefs = valid.evidenceRefs.map((ref) =>
      sanitizeText(ref, this.secretPatterns)
    );

    const sanitizedEvent: ActivityEvent = {
      ...valid,
      outcome: sanitizedOutcome,
      evidenceRefs: sanitizedEvidenceRefs,
    };

    let taskEvents = this.events.get(sanitizedEvent.taskId);
    if (!taskEvents) {
      taskEvents = [];
      this.events.set(sanitizedEvent.taskId, taskEvents);
    }
    taskEvents.push(sanitizedEvent);

    if (this.sink) {
      await this.sink(sanitizedEvent);
    }
  }

  async recordUsage(
    taskId: string,
    runId: string,
    usage: ProviderUsage
  ): Promise<void> {
    if (typeof taskId !== 'string' || taskId.trim().length === 0) {
      throw new Error('recordUsage requires a non-empty taskId');
    }
    if (isProtectedPayload(taskId, this.secretPatterns)) {
      throw new Error('Protected identifier rejected: recordUsage taskId contains protected data or secret');
    }
    if (typeof runId !== 'string' || runId.trim().length === 0) {
      throw new Error('recordUsage requires a non-empty runId');
    }
    if (isProtectedPayload(runId, this.secretPatterns)) {
      throw new Error('Protected identifier rejected: recordUsage runId contains protected data or secret');
    }
    if (
      typeof usage !== 'object' ||
      usage === null ||
      typeof usage.inputTokens !== 'number' ||
      !Number.isSafeInteger(usage.inputTokens) ||
      usage.inputTokens < 0
    ) {
      throw new Error('INVALID_NON_NEGATIVE_INTEGER: inputTokens must be a non-negative integer');
    }
    if (
      typeof usage.outputTokens !== 'number' ||
      !Number.isSafeInteger(usage.outputTokens) ||
      usage.outputTokens < 0
    ) {
      throw new Error('INVALID_NON_NEGATIVE_INTEGER: outputTokens must be a non-negative integer');
    }
    if (
      typeof usage.costUsd !== 'number' ||
      !Number.isFinite(usage.costUsd) ||
      usage.costUsd < 0
    ) {
      throw new Error('INVALID_NON_NEGATIVE_NUMBER: costUsd must be a non-negative number');
    }
    if (
      usage.billableTokens !== undefined &&
      (typeof usage.billableTokens !== 'number' ||
        !Number.isSafeInteger(usage.billableTokens) ||
        usage.billableTokens < 0)
    ) {
      throw new Error('INVALID_NON_NEGATIVE_INTEGER: billableTokens must be a non-negative integer');
    }

    const key = JSON.stringify([taskId, runId]);
    const existing = this.runUsage.get(key);

    if (!existing) {
      this.runUsage.set(key, { ...usage });
    } else {
      const inputTokens = existing.inputTokens + usage.inputTokens;
      const outputTokens = existing.outputTokens + usage.outputTokens;
      const costUsd = Number((existing.costUsd + usage.costUsd).toFixed(6));
      const billableTokens =
        existing.billableTokens !== undefined || usage.billableTokens !== undefined
          ? (existing.billableTokens ?? 0) + (usage.billableTokens ?? 0)
          : undefined;

      this.runUsage.set(key, {
        inputTokens,
        outputTokens,
        costUsd,
        ...(billableTokens !== undefined ? { billableTokens } : {}),
      });
    }
  }

  recordDiagnostic(
    taskId: string,
    runId: string,
    rawDiagnostic: string
  ): RedactedDiagnostic {
    if (typeof taskId !== 'string' || taskId.trim().length === 0) {
      throw new Error('recordDiagnostic requires a non-empty taskId');
    }
    if (isProtectedPayload(taskId, this.secretPatterns)) {
      throw new Error('Protected identifier rejected: recordDiagnostic taskId contains protected data or secret');
    }
    if (typeof runId !== 'string' || runId.trim().length === 0) {
      throw new Error('recordDiagnostic requires a non-empty runId');
    }
    if (isProtectedPayload(runId, this.secretPatterns)) {
      throw new Error('Protected identifier rejected: recordDiagnostic runId contains protected data or secret');
    }
    if (this.maxDiagnosticBytes === undefined) {
      throw new Error(
        'INVALID_DIAGNOSTIC_LIMIT: maxDiagnosticBytes must be configured with a finite positive integer to record diagnostics'
      );
    }
    const redacted = sanitizeDiagnostic(rawDiagnostic, {
      maxBytes: this.maxDiagnosticBytes,
      customPatterns: this.secretPatterns,
    });
    this.diagnostics.set(redacted.diagnosticRef, redacted);
    return redacted;
  }

  getEvents(taskId?: string): readonly ActivityEvent[] {
    if (taskId) {
      return [...(this.events.get(taskId) ?? [])];
    }
    const all: ActivityEvent[] = [];
    for (const list of this.events.values()) {
      all.push(...list);
    }
    return all;
  }

  getRunUsage(taskId: string, runId: string): ProviderUsage | undefined {
    const usage = this.runUsage.get(JSON.stringify([taskId, runId]));
    return usage ? { ...usage } : undefined;
  }

  getDiagnostic(ref: string): RedactedDiagnostic | undefined {
    const diag = this.diagnostics.get(ref);
    return diag ? { ...diag } : undefined;
  }

  clear(): void {
    this.events.clear();
    this.runUsage.clear();
    this.diagnostics.clear();
  }
}
