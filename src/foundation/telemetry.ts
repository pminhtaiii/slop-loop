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

const DEFAULT_MAX_DIAGNOSTIC_BYTES = 1024;

const BUILTIN_SECRET_PATTERNS: readonly RegExp[] = [
  /MARKER_SECRET[A-Za-z0-9_-]*/gi,
  /marker[-_]?secret[-_]?[A-Za-z0-9_-]*/gi,
  /-----BEGIN[ A-Z0-9_-]+KEY-----[^-]+-----END[ A-Z0-9_-]+KEY-----/gs,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g,
  /sk-[A-Za-z0-9-_]{20,}/g,
  /(?:token|secret|password|api[_-]?key|access[_-]?token|auth)[\s:=]+([^\s,;"']+)/gi,
];

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
      } else {
        sanitized = sanitized.replace(pattern, (match, captured: string | undefined) => {
          if (captured !== undefined && match.includes(captured)) {
            return match.replace(captured, '[REDACTED]');
          }
          return '[REDACTED]';
        });
      }
    }
  }

  // Apply built-in secret patterns
  for (const regex of BUILTIN_SECRET_PATTERNS) {
    // Reset state for global regexes
    const re = new RegExp(regex.source, regex.flags);
    sanitized = sanitized.replace(re, (match, captured: string | undefined) => {
      if (captured !== undefined && match.includes(captured)) {
        return match.replace(captured, '[REDACTED]');
      }
      return '[REDACTED]';
    });
  }

  return sanitized;
}

export function sanitizeDiagnostic(
  content: string,
  options?: {
    readonly maxBytes?: number;
    readonly customPatterns?: readonly (RegExp | string)[];
  }
): RedactedDiagnostic {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_DIAGNOSTIC_BYTES;
  const originalSanitized = sanitizeText(content, options?.customPatterns);
  const wasRedacted = originalSanitized !== content;

  let finalContent = originalSanitized;
  let wasTruncated = false;

  let byteLen = Buffer.byteLength(finalContent, 'utf8');
  if (byteLen > maxBytes) {
    wasTruncated = true;
    const truncationNotice = ' ... [TRUNCATED]';
    const noticeBytes = Buffer.byteLength(truncationNotice, 'utf8');
    const targetBytes = Math.max(0, maxBytes - noticeBytes);

    const buf = Buffer.from(finalContent, 'utf8');
    finalContent = buf.subarray(0, targetBytes).toString('utf8') + truncationNotice;
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

export function isProtectedPayload(val: unknown): boolean {
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (isProtectedPath(trimmed)) {
      return true;
    }
    if (
      trimmed.includes('-----BEGIN') &&
      trimmed.includes('KEY-----')
    ) {
      return true;
    }
    for (const regex of BUILTIN_SECRET_PATTERNS) {
      const re = new RegExp(regex.source, regex.flags);
      if (re.test(trimmed)) {
        return true;
      }
    }
    return false;
  }

  if (typeof val === 'object' && val !== null) {
    for (const [key, value] of Object.entries(val)) {
      if (isProtectedPayload(key) || isProtectedPayload(value)) {
        return true;
      }
    }
  }

  return false;
}

export class SanitizedTelemetry implements TelemetryPort {
  readonly provenance: PortProvenance;
  private readonly maxDiagnosticBytes: number;
  private readonly secretPatterns: readonly (RegExp | string)[];
  private readonly sink: ((event: ActivityEvent) => void | Promise<void>) | undefined;
  private readonly events: Map<string, ActivityEvent[]>;
  private readonly runUsage: Map<string, ProviderUsage>;
  private readonly diagnostics: Map<string, RedactedDiagnostic>;

  constructor(options: TelemetryOptions = {}) {
    this.provenance = options.provenance ?? 'real';
    this.maxDiagnosticBytes = options.maxDiagnosticBytes ?? DEFAULT_MAX_DIAGNOSTIC_BYTES;
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
    if (typeof runId !== 'string' || runId.trim().length === 0) {
      throw new Error('recordUsage requires a non-empty runId');
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

    const key = `${taskId}:${runId}`;
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
    _taskId: string,
    _runId: string,
    rawDiagnostic: string
  ): RedactedDiagnostic {
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
    const usage = this.runUsage.get(`${taskId}:${runId}`);
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
