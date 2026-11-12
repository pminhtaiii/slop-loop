/** Pure UC-06 validation. Successful parsing freezes detached data; it never mints owner authority. */
import { computeCanonicalSha256 as digest, isCanonicalRelativePath, isProtectedPath, validateReviewResult, type TrustedDiffLines, type ValidationResult } from '../contracts/foundation/uc03.ts';
import { safeSnapshot, deepFreeze } from '../contracts/foundation/uc03/v02/admission/snapshot.ts';
import { containsProtectedContent } from '../foundation/model.ts';
import type * as R from '../contracts/review.ts';
import { REVIEW_SCHEMAS } from '../contracts/review.ts';
type Data = Record<string, unknown>;
type Rule = (v: unknown) => boolean;
const object = (v: unknown): v is Data => typeof v === 'object' && v !== null && !Array.isArray(v);
const bytes = (v: string) => Buffer.byteLength(v, 'utf8');
const id: Rule = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(v) && bytes(v) <= 128;
const sha: Rule = v => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/u.test(v);
const path: Rule = v => typeof v === 'string' && bytes(v) <= 512 && isCanonicalRelativePath(v) && !isProtectedPath(v);
const integer: Rule = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const positive: Rule = v => integer(v) && (v as number) > 0;
const member =
  (...vs: readonly unknown[]): Rule =>
  v =>
    vs.includes(v);
const nullable =
  (r: Rule): Rule =>
  v =>
    v === null || r(v);
const array =
  (r: Rule, max = 10000): Rule =>
  v =>
    Array.isArray(v) && v.length <= max && v.every(r);
const unique =
  (r: Rule): Rule =>
  v =>
    array(r)(v) && new Set(v as unknown[]).size === (v as unknown[]).length;
function record(fields: Record<string, Rule>, optional: readonly string[] = []): Rule {
  return v =>
    object(v) && Object.keys(v).every(k => Object.hasOwn(fields, k)) && Object.entries(fields).every(([k, r]) => (optional.includes(k) && !Object.hasOwn(v, k)) || (Object.hasOwn(v, k) && r(v[k])));
}
function schema(shape: unknown): Rule {
  if (typeof shape === 'string')
    return ({ id, sha, path, integer, positive, reviewResult: (v: unknown) => validateReviewResult(v).ok } as Record<string, Rule>)[shape] ?? schema(REVIEW_SCHEMAS[shape]);
  if (Array.isArray(shape)) {
    const [kind, ...values] = shape;
    if (kind === 'enum') return member(...values);
    if (kind === 'nullable') return nullable(schema(values[0]));
    if (kind === 'unique') return unique(schema(values[0]));
    if (kind === 'array') return array(schema(values[0]));
  }
  if (object(shape)) {
    const fields = Object.fromEntries(
      Object.entries(shape)
        .filter(([k]) => k !== '$optional')
        .map(([k, s]) => [k, schema(s)]),
    );
    return record(fields, Array.isArray(shape['$optional']) ? (shape['$optional'] as string[]) : []);
  }
  return () => false;
}
const profileRule = schema('profile'),
  bindingRule = schema('binding'),
  authorityRule = schema('authority');
function safeContent(v: unknown): boolean {
  return typeof v === 'string' ? !containsProtectedContent(v) : Array.isArray(v) ? v.every(safeContent) : object(v) ? Object.values(v).every(safeContent) : true;
}
function parse<T>(input: unknown, rule: Rule, check: (v: T) => boolean = () => true): ValidationResult<T> {
  const copy = safeSnapshot(input);
  if (!copy.ok || !safeContent(copy.value) || !rule(copy.value)) return invalid();
  // Shape rules above establish the requested plain-data record, detached from caller mutation.
  const value = copy.value as T;
  return check(value) ? { ok: true, value: deepFreeze(value) } : invalid();
}
function invalid<T>(): ValidationResult<T> {
  return { ok: false, errors: [{ path: 'review', code: 'INVALID_REVIEW', message: 'Review data does not match its contract' }] };
}
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
/** Whole-input textual modify/add/delete admission; unsupported metadata never disappears silently. */
export function validateReviewDiff(input: unknown, maxBytes: number): ValidationResult<TrustedDiffLines> {
  if (typeof input !== 'string' || !positive(maxBytes) || bytes(input) > maxBytes || containsProtectedContent(input)) return invalid();
  const lines = input.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const files: Record<string, { oldLines: number[]; newLines: number[] }> = Object.create(null) as Record<string, { oldLines: number[]; newLines: number[] }>;
  let i = 0;
  while (i < lines.length) {
    let gitPath: string | undefined;
    let fileMode: 'new' | 'deleted' | undefined;
    if (lines[i]?.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(lines[i++] ?? '');
      if (!m || m[1] !== m[2] || !path(m[1])) return invalid();
      gitPath = m[1];
    }
    if (gitPath && /^(?:new|deleted) file mode /u.test(lines[i] ?? '')) {
      const mode = /^(new|deleted) file mode 100[0-7]{3}$/u.exec(lines[i++] ?? '');
      if (!mode) return invalid();
      fileMode = mode[1] === 'new' ? 'new' : 'deleted';
      if (!lines[i]?.startsWith('index ')) return invalid();
    }
    if (lines[i]?.startsWith('index ')) {
      const index = lines[i++] ?? '';
      if (!gitPath || !(fileMode ? /^index [a-f0-9]+\.\.[a-f0-9]+$/u : /^index [a-f0-9]+\.\.[a-f0-9]+(?: 100[0-7]{3})?$/u).test(index)) return invalid();
    }
    const old = /^--- (a\/.*|\/dev\/null)$/u.exec(lines[i++] ?? ''),
      next = /^\+\+\+ (b\/.*|\/dev\/null)$/u.exec(lines[i++] ?? '');
    if (!old || !next) return invalid();
    const a = old[1] === '/dev/null' ? null : old[1]?.slice(2),
      b = next[1] === '/dev/null' ? null : next[1]?.slice(2);
    if (a === undefined || b === undefined || (a === null && b === null) || (a !== null && !path(a)) || (b !== null && !path(b)) || (a !== null && b !== null && a !== b)) return invalid();
    if ((fileMode === 'new' && (a !== null || b === null)) || (fileMode === 'deleted' && (a === null || b !== null))) return invalid();
    const file = b ?? a;
    if (!file || (gitPath !== undefined && gitPath !== file) || Object.hasOwn(files, file)) return invalid();
    const changed = { oldLines: [] as number[], newLines: [] as number[] };
    let hunks = 0,
      oldEnd = 0,
      newEnd = 0;
    while (lines[i]?.startsWith('@@ ')) {
      const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(lines[i++] ?? '');
      if (!h) return invalid();
      let on = Number(h[1]),
        nn = Number(h[3]),
        ol = Number(h[2] ?? 1),
        nl = Number(h[4] ?? 1);
      if (
        ![on, nn, ol, nl, on + ol, nn + nl].every(Number.isSafeInteger) ||
        on < oldEnd ||
        nn < newEnd ||
        (ol === 0 && nl === 0) ||
        (ol > 0 && on === 0) ||
        (nl > 0 && nn === 0) ||
        (a === null && ol !== 0) ||
        (b === null && nl !== 0)
      )
        return invalid();
      oldEnd = on + ol;
      newEnd = nn + nl;
      hunks++;
      while (ol > 0 || nl > 0) {
        const line = lines[i++];
        if (line === undefined) return invalid();
        if (line === '\\ No newline at end of file') continue;
        if (line[0] === ' ') {
          ol--;
          nl--;
          on++;
          nn++;
        } else if (line[0] === '-') {
          changed.oldLines.push(on++);
          ol--;
        } else if (line[0] === '+') {
          changed.newLines.push(nn++);
          nl--;
        } else return invalid();
        if (ol < 0 || nl < 0) return invalid();
      }
      if (lines[i] === '\\ No newline at end of file') i++;
    }
    if (!hunks || (!changed.oldLines.length && !changed.newLines.length)) return invalid();
    files[file] = changed;
  }
  return Object.keys(files).length ? { ok: true, value: deepFreeze(files) } : invalid();
}
/** Validate one model verdict against the current bound diff/evidence; semantic correctness is independently graded. */
export function validateReviewOutput(input: unknown, context: R.ReviewContextV1, diff: string): ValidationResult<R.ReviewOutputV1> {
  const c = validateReviewContext(context);
  if (!c.ok || digest(diff) !== c.value.binding.diffDigest) return invalid();
  const d = validateReviewDiff(diff, c.value.profile.maxDiffBytes);
  if (!d.ok) return invalid();
  return parse(
    input,
    record({
      status: member('accepted', 'findings'),
      findings: array(
        record({ file: path, line: positive, side: member('old', 'new'), severity: member('error', 'warning', 'info'), message: v => typeof v === 'string' && v.trim().length > 0, evidenceRef: id }),
      ),
    }),
    v => {
      if (bytes(JSON.stringify(v)) > c.value.profile.maxOutputBytes || v.findings.length > c.value.profile.maxFindings) return false;
      const actionable = v.findings.some(f => f.severity !== 'info');
      return (
        (v.status === 'findings' ? actionable : !actionable) &&
        v.findings.every(
          f =>
            bytes(f.message) <= c.value.profile.maxMessageBytes &&
            d.value[f.file]?.[f.side === 'old' ? 'oldLines' : 'newLines']?.includes(f.line) &&
            c.value.evidence.some(e => e.evidenceRef === f.evidenceRef),
        )
      );
    },
  );
}
export function validateReviewProfile(input: unknown): ValidationResult<R.ReviewProfileV1> {
  return parse(input, profileRule, v => v.maxResponseBytes >= v.maxOutputBytes && v.requiredConventionPaths.length <= v.maxEvidenceItems && v.optionalEvidenceRefs.length <= v.maxEvidenceItems);
}
export function validateReviewBinding(input: unknown): ValidationResult<R.ReviewBindingV1> {
  return parse(input, bindingRule);
}
export function validateReviewAuthority(input: unknown): ValidationResult<R.ReviewAuthorityV1> {
  return parse(input, authorityRule);
}
const contextRule = schema('context');
export function validateReviewContext(input: unknown): ValidationResult<R.ReviewContextV1> {
  return parse(input, contextRule, v => {
    const p = v.profile,
      b = v.binding;
    const { contextDigest, ...body } = v;
    if (!validateReviewProfile(p).ok || bytes(JSON.stringify(v)) > p.maxContextBytes || v.evidence.length > p.maxEvidenceItems || v.conventions.length > p.maxEvidenceItems) return false;
    if (contextDigest !== digest(body) || b.profileDigest !== digest(p) || b.verificationDigest !== digest(v.verification) || b.conventionsDigest !== digest(v.conventions)) return false;
    if (new Set(v.evidence.map(e => e.evidenceRef)).size !== v.evidence.length || new Set(v.conventions.map(e => e.path)).size !== v.conventions.length) return false;
    if (!v.verification.results.length || new Set(v.verification.results.map(e => e.checkId)).size !== v.verification.results.length) return false;
    if (v.verification.results.some(e => e.repoDigest !== b.headRevisionDigest || e.diffDigest !== b.diffDigest)) return false;
    if (v.evidence.some(e => e.revisionDigest !== b.headRevisionDigest || e.path === 'review/context.json' || e.path === 'review/diff.patch')) return false;
    return (
      p.requiredConventionPaths.every(x => v.conventions.some(e => e.path === x)) &&
      v.conventions.every(c => c.revisionDigest === b.headRevisionDigest && v.evidence.some(e => e.kind === 'convention' && equal(e, { ...c, kind: 'convention' })))
    );
  });
}
/** Compare parsed context with independently selected host facts. Parsing is never dispatch authority. */
export function validateReviewContextAdmission(input: unknown, trusted: R.ReviewContextAdmissionV1): ValidationResult<R.ReviewContextV1> {
  const r = validateReviewContext(input),
    t = safeSnapshot(trusted);
  if (!r.ok || !t.ok) return invalid();
  const host = t.value as R.ReviewContextAdmissionV1;
  if (!object(host) || !validateReviewBinding(host.binding).ok || !validateReviewAuthority(host.authority).ok || !Array.isArray(host.sourceEvidence) || !unique(id)(host.requiredCheckIds))
    return invalid();
  const c = r.value,
    p = c.profile,
    ev = host.sourceEvidence;
  if (!equal(c.binding, host.binding) || !equal(c.authority, host.authority) || digest(ev) !== c.binding.evidenceDigest || ev.length > p.maxEvidenceItems) return invalid();
  if (
    ev.some(
      e =>
        !record({ path, revisionDigest: sha, boundedExcerpt: v => typeof v === 'string', resultCount: integer, truncated: member(false) })(e) ||
        !safeContent(e) ||
        e.revisionDigest !== c.binding.headRevisionDigest,
    ) ||
    ev.reduce((n, e) => n + bytes(e.boundedExcerpt), 0) > p.maxEvidenceBytes
  )
    return invalid();
  if (
    c.evidence.some(e => !ev.some(s => s.path === e.path && s.revisionDigest === e.revisionDigest && digest(s.boundedExcerpt) === e.contentDigest)) ||
    ev.some(s => !c.evidence.some(e => e.path === s.path && e.contentDigest === digest(s.boundedExcerpt)))
  )
    return invalid();
  return host.requiredCheckIds.length > 0 && host.requiredCheckIds.every(id => c.verification.results.some(r => r.checkId === id)) ? r : invalid();
}
const observationRule = schema('observation');
export function validateReviewObservation(input: unknown): ValidationResult<R.ReviewObservationV1> {
  return parse(input, observationRule, v => {
    const r = v.result;
    if (v.accountingRefs.length > 128 || (r === null) !== (v.reviewId === null) || (r !== null && v.providerRequestId === null)) return false;
    if (v.status === 'accepted' || v.status === 'findings') {
      if (!r || r.status !== v.status || v.reasonCode !== (v.status === 'accepted' ? 'OK' : 'FINDINGS') || !v.accountingRefs.length) return false;
    } else if (v.reasonCode === 'OK' || v.reasonCode === 'FINDINGS') return false;
    if (
      (v.status === 'stale' && v.reasonCode !== 'BINDING_STALE') ||
      (v.status === 'uncertain' && !['USAGE_UNCERTAIN', 'PROVIDER_TIMEOUT', 'EVIDENCE_UNACKNOWLEDGED'].includes(v.reasonCode)) ||
      (v.status === 'blocked' && r !== null)
    )
      return false;
    if (v.status === 'invalid' && r !== null && r.status !== 'invalid') return false;
    if (v.providerRequestId !== null && v.status !== 'blocked' && !v.accountingRefs.length) return false;
    return (
      !r ||
      (r.reviewId === v.reviewId &&
        id(r.reviewId) &&
        id(r.reviewerRoleConfigId) &&
        id(r.iterationReservationRef) &&
        r.repoDigest === v.binding.headRevisionDigest &&
        r.diffDigest === v.binding.diffDigest &&
        r.checkSetDigest === v.binding.checkSetDigest &&
        r.findings.length <= 128 &&
        r.findings.every(f => id(f.evidenceRef) && positive(f.line) && bytes(f.message) <= 65536) &&
        v.accountingRefs.includes(r.iterationReservationRef))
    );
  });
}
const persistRule = schema('persist');
export function validatePersistReviewObservationRequest(input: unknown): ValidationResult<R.PersistReviewObservationRequestV1> {
  return parse(
    input,
    persistRule,
    v => validateReviewObservation(v.observation).ok && v.observationDigest === digest(v.observation) && sameAuthorityMaterial(v.observation.authority, v.expectedAuthority),
  );
}
function sameAuthorityMaterial(before: R.ReviewAuthorityV1, current: R.ReviewAuthorityV1): boolean {
  return (
    current.taskStateVersion >= before.taskStateVersion &&
    current.controlVersion >= before.controlVersion &&
    before.epoch === current.epoch &&
    before.decisionAuthorityGeneration === current.decisionAuthorityGeneration &&
    before.planDecisionRef === current.planDecisionRef &&
    before.planBindingDigest === current.planBindingDigest
  );
}
const ackRule = schema('ack');
export function validateReviewEvidenceAck(input: unknown, observation?: R.ReviewObservationV1): ValidationResult<R.ReviewEvidenceAckV1> {
  const observed = observation === undefined ? undefined : validateReviewObservation(observation);
  if (observed && !observed.ok) return invalid();
  return parse(
    input,
    ackRule,
    a =>
      !observed ||
      (observed.ok &&
        a.observationDigest === digest(observed.value) &&
        a.contextDigest === observed.value.contextDigest &&
        a.providerRequestId === observed.value.providerRequestId &&
        (['taskId', 'runId', 'repositoryId', 'workspaceId', 'headRevisionDigest', 'diffDigest'] as const).every(k => a[k] === observed.value.binding[k])),
  );
}
const loadRule = schema('load'),
  recoverRule = schema('recover');
export function validateLoadReviewObservationRequest(input: unknown): ValidationResult<R.LoadReviewObservationRequestV1> {
  return parse(input, loadRule);
}
export function validateRecoverReviewObservationRequest(input: unknown): ValidationResult<R.RecoverReviewObservationRequestV1> {
  return parse(input, recoverRule);
}
const refusalRule = record({ outcome: member('conflict', 'denied'), reasonCode: member('BINDING_STALE', 'AUTHORITY_UNAVAILABLE', 'MODEL_OUTPUT_INVALID') });
const uncertainRule = record({ outcome: member('uncertain'), operationRef: id }),
  missingRule = record({ outcome: member('missing') });
const foundRule = record({ outcome: member('found'), observation: v => validateReviewObservation(v).ok, ack: ackRule });
function foundMatches(v: R.ReviewEvidenceFoundV1, authority: R.ReviewAuthorityV1): boolean {
  return validateReviewEvidenceAck(v.ack, v.observation).ok && sameAuthorityMaterial(v.observation.authority, authority);
}
/** Reply correlation only: callers must obtain these replies from the accepted independent owner, not model data. */
export function validatePersistReviewObservationResult(input: unknown, request: R.PersistReviewObservationRequestV1): ValidationResult<R.PersistReviewObservationResultV1> {
  const req = validatePersistReviewObservationRequest(request);
  if (!req.ok) return invalid();
  return parse(
    input,
    v => record({ outcome: member('acknowledged'), ack: ackRule })(v) || refusalRule(v) || uncertainRule(v),
    v => v.outcome !== 'acknowledged' || validateReviewEvidenceAck(v.ack, req.value.observation).ok,
  );
}
export function validateLoadReviewObservationResult(input: unknown, request: R.LoadReviewObservationRequestV1): ValidationResult<R.LoadReviewObservationResultV1> {
  const req = validateLoadReviewObservationRequest(request);
  if (!req.ok) return invalid();
  return parse(
    input,
    v => foundRule(v) || refusalRule(v) || missingRule(v),
    v =>
      v.outcome !== 'found' ||
      (foundMatches(v, req.value.expectedAuthority) &&
        v.ack.taskId === req.value.taskId &&
        v.ack.runId === req.value.runId &&
        v.ack.providerRequestId === req.value.providerRequestId &&
        v.ack.contextDigest === req.value.contextDigest &&
        v.ack.observationDigest === req.value.observationDigest),
  );
}
export function validateRecoverReviewObservationResult(input: unknown, request: R.RecoverReviewObservationRequestV1): ValidationResult<R.RecoverReviewObservationResultV1> {
  const req = validateRecoverReviewObservationRequest(request);
  if (!req.ok) return invalid();
  return parse(
    input,
    v => foundRule(v) || refusalRule(v) || missingRule(v) || uncertainRule(v),
    v =>
      v.outcome !== 'found' ||
      (foundMatches(v, req.value.expectedAuthority) && (['taskId', 'workspaceId', 'repositoryId', 'headRevisionDigest', 'diffDigest'] as const).every(k => v.ack[k] === req.value[k])),
  );
}
