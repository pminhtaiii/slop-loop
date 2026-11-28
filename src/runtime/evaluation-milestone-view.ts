/** Bounded allowlist projection for persisted UC-03 workflow milestones at the service boundary. */

import type { MilestoneKind } from '../uc03/report.ts';
import { sanitizeText } from '../foundation/telemetry.ts';
import { isMilestoneKind, isMilestoneOutcome } from '../uc03/report/sanitize.ts';

export type MilestoneViewOutcome = 'success' | 'failure' | 'pending' | 'info';

export interface MilestoneView {
  readonly kind: MilestoneKind;
  readonly node: string;
  readonly outcome: MilestoneViewOutcome;
  readonly timestamp: string;
  readonly summary: string;
}

export const MAX_MILESTONE_VIEWS = 64;
export const MAX_MILESTONE_SUMMARY_BYTES = 512;

const MAX_NODE_BYTES = 64;
const MAX_TIMESTAMP_BYTES = 64;
const SAFE_NODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

function isControlOrBidiCode(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function hasControlOrBidiChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (isControlOrBidiCode(value.charCodeAt(i))) return true;
  }
  return false;
}

function stripControlAndBidiChars(value: string): string {
  let out = '';
  let inGap = false;
  for (let i = 0; i < value.length; i += 1) {
    if (isControlOrBidiCode(value.charCodeAt(i))) {
      if (!inGap) {
        out += ' ';
        inGap = true;
      }
    } else {
      out += value[i];
      inGap = false;
    }
  }
  return out;
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || hasControlOrBidiChar(value)) return undefined;
  return Buffer.byteLength(value, 'utf8') <= MAX_TIMESTAMP_BYTES ? value : undefined;
}

function safeNode(value: unknown): string | undefined {
  if (typeof value !== 'string' || !SAFE_NODE.test(value)) return undefined;
  return Buffer.byteLength(value, 'utf8') <= MAX_NODE_BYTES ? value : undefined;
}

function safeSummary(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (Buffer.byteLength(value, 'utf8') > MAX_MILESTONE_SUMMARY_BYTES) return undefined;
  const clean = stripControlAndBidiChars(sanitizeText(value)).trim();
  if (!clean || Buffer.byteLength(clean, 'utf8') > MAX_MILESTONE_SUMMARY_BYTES) return undefined;
  return clean;
}

function projectMilestoneEntry(entry: unknown): MilestoneView | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
  const candidate = entry as Record<string, unknown>;
  const kind = candidate['kind'];
  const outcome = candidate['outcome'];
  const node = safeNode(candidate['node']);
  const timestamp = safeTimestamp(candidate['timestamp']);
  const summary = safeSummary(candidate['summary']);
  if (typeof kind !== 'string' || !isMilestoneKind(kind) || !isMilestoneOutcome(outcome) || !node || !timestamp || !summary) {
    return undefined;
  }
  return Object.freeze({ kind, node, outcome, timestamp, summary });
}

/**
 * Projects explicit allowlisted milestone fields (`kind`, `node`, `outcome`, `timestamp`, `summary`),
 * dropping `details`, `evidenceRefs`, and any unknown, malformed, or over-long entries.
 * Preserves producer order including duplicates up to `MAX_MILESTONE_VIEWS`; returns `null` when none exist.
 */
export function projectMilestones(raw: unknown): readonly MilestoneView[] | null {
  if (!Array.isArray(raw)) return null;
  const projected: MilestoneView[] = [];
  for (const item of raw) {
    const view = projectMilestoneEntry(item);
    if (view === undefined) continue;
    projected.push(view);
    if (projected.length >= MAX_MILESTONE_VIEWS) break;
  }
  return projected.length > 0 ? Object.freeze(projected) : null;
}

/** Appends valid incoming milestones after prior ones for the same run, bounded to `MAX_MILESTONE_VIEWS`. */
export function appendMilestoneViews(existing: readonly MilestoneView[] | null, incoming: unknown): readonly MilestoneView[] | null {
  const next = projectMilestones(incoming);
  if (!next) return existing && existing.length > 0 ? existing : null;
  if (!existing || existing.length === 0) return next;
  return Object.freeze([...existing, ...next].slice(0, MAX_MILESTONE_VIEWS));
}
