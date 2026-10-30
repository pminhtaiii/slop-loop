import { canonicalDigest, validatePublicCase, type ExecutionLevel, type Json } from '../src/uc01/contracts.ts';
import { isProtectedPayload } from '../src/foundation/telemetry.ts';

import { SHARED_EVALUATION_VERSION, type SharedCase, type RegisteredEvaluation, type SharedExecutionContext,
  type SharedGrade, type EvaluationCallbacks, type SharedSelection, type SharedEvaluationOptions, type SharedCaseResult,
  type SharedEvaluationReport } from './shared-types.ts';
export { SHARED_EVALUATION_VERSION } from './shared-types.ts';
export type { SharedCase, RegisteredEvaluation, SharedExecutionContext, SharedGrade, EvaluationCallbacks, SharedSelection,
  SharedEvaluationOptions, SharedCaseResult, SharedEvaluationReport } from './shared-types.ts';

const callbacks = new WeakMap<RegisteredEvaluation, EvaluationCallbacks>();
const executions = new WeakMap<RegisteredEvaluation, Set<string>>();
const reservedNamespaces = new Set<string>();
const datasetDigests = new Map<string, string>();
const oracleManifestDigests = new Map<string, string>();
const oraclePins = new WeakMap<RegisteredEvaluation, Readonly<Record<string, string>>>();
const levels = new Set(['contract', 'mock-behavior', 'real-integration', 'model-quality', 'project']);
const digest = /^[a-f0-9]{64}$/u;
const name = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,191}$/u;
function fail(): never { throw new Error('Invalid shared evaluation contract'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) fail();
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) fail(); }
  return value as Record<string, unknown>; // Exact own data properties checked above.
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !name.test(value) || isProtectedPayload(value)) fail();
  return value;
}
function sha(value: unknown): string { if (typeof value !== 'string' || !digest.test(value)) fail(); return value; }
function member(value: unknown, allowed: readonly string[]): value is string { return typeof value === 'string' && allowed.includes(value); }
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 256
    || Reflect.ownKeys(value).length !== value.length + 1) fail();
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !('value' in property)) fail();
  }
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function snapshot<T>(value: T): T { return freeze(structuredClone(value)); }
/** Registers only public data. Grading functions remain host-held and are never driver context. */
export function registerEvaluation(value: unknown, handlers?: EvaluationCallbacks,
  expectedOracleDigests?: Readonly<Record<string, string>>): RegisteredEvaluation {
  const input = object(value, ['contractVersion', 'ucId', 'datasetId', 'datasetVersion', 'adapterVersion', 'graderVersion', 'provenance', 'cases']);
  if (input.contractVersion !== SHARED_EVALUATION_VERSION || !/^UC-\d{2}$/u.test(text(input.ucId))
    || !member(input.provenance, ['mock', 'real'])) fail();
  const ucId = text(input.ucId); const ids = new Set<string>();
  const cases = array(input.cases).map(raw => {
    const item = object(raw, ['caseId', 'caseDigest', 'levels', 'gate', 'classificationScored', 'attack', 'digestProfile', 'payload']);
    const caseId = text(item.caseId);
    if (!caseId.startsWith(`${ucId}:`) || ids.has(caseId)) fail(); ids.add(caseId);
    const caseLevels = array(item.levels);
    if (!caseLevels.length || new Set(caseLevels).size !== caseLevels.length || caseLevels.some(level => typeof level !== 'string' || !levels.has(level))
      || !member(item.gate, ['hard', 'scored']) || typeof item.classificationScored !== 'boolean' || typeof item.attack !== 'boolean'
      || item.gate === 'scored' && (!item.classificationScored || caseLevels.some(level => level !== 'model-quality'))) fail();
    canonicalDigest('PublicCase', item.payload); // Reject non-JSON values, cycles and malformed strings before cloning.
    if (Buffer.byteLength(JSON.stringify(item.payload)) > 1024 * 1024) fail();
    if (item.digestProfile === 'uc01-evaluation-sha256-v1') {
      const parsed = validatePublicCase(item.payload);
      if (!parsed.ok || parsed.value.caseId !== caseId || parsed.value.caseDigest !== item.caseDigest
        || parsed.value.datasetId !== input.datasetId || parsed.value.datasetVersion !== input.datasetVersion
        || JSON.stringify(parsed.value.levels) !== JSON.stringify(caseLevels) || parsed.value.gate !== item.gate
        || item.classificationScored !== (parsed.value.gate === 'scored')
        || item.attack !== (parsed.value.categories.includes('safety') || parsed.value.familyId === 'C15')) fail();
    } else if (item.digestProfile !== 'canonical-json-v1' || canonicalDigest('PublicCase', item.payload) !== item.caseDigest) fail();
    return snapshot({ caseId, caseDigest: sha(item.caseDigest), levels: caseLevels as ExecutionLevel[],
      gate: item.gate as 'hard' | 'scored', classificationScored: item.classificationScored, attack: item.attack,
      digestProfile: item.digestProfile as SharedCase['digestProfile'], payload: item.payload as Json });
  });
  if (!cases.length) fail();
  const descriptor = { contractVersion: SHARED_EVALUATION_VERSION, ucId, datasetId: text(input.datasetId), datasetVersion: text(input.datasetVersion),
    adapterVersion: text(input.adapterVersion), graderVersion: text(input.graderVersion), provenance: input.provenance as 'mock' | 'real', cases } as const;
  const registered = snapshot({ ...descriptor, datasetDigest: canonicalDigest('PublicCase', {
    contractVersion: descriptor.contractVersion, ucId, datasetId: descriptor.datasetId, datasetVersion: descriptor.datasetVersion, cases,
  }) });
  const datasetKey = `${ucId}/${registered.datasetId}/${registered.datasetVersion}`;
  const previousDigest = datasetDigests.get(datasetKey);
  if (previousDigest !== undefined && previousDigest !== registered.datasetDigest) fail();
  let pinned: Readonly<Record<string, string>> | undefined; let oracleManifestDigest: string | undefined;
  if (expectedOracleDigests !== undefined) {
    const manifest = object(expectedOracleDigests, cases.map(item => item.caseId));
    pinned = snapshot(Object.fromEntries(cases.map(item => [item.caseId, sha(manifest[item.caseId])])));
    oracleManifestDigest = canonicalDigest('GradingCase', pinned);
    const previousOracleDigest = oracleManifestDigests.get(datasetKey);
    if (previousOracleDigest !== undefined && previousOracleDigest !== oracleManifestDigest) fail();
  } else if (cases.some(item => item.digestProfile === 'uc01-evaluation-sha256-v1')) fail();
  if (handlers) {
    if (typeof handlers.execute !== 'function' || typeof handlers.grade !== 'function') fail();
    callbacks.set(registered, Object.freeze({ execute: handlers.execute, grade: handlers.grade }));
  }
  executions.set(registered, new Set());
  datasetDigests.set(datasetKey, registered.datasetDigest);
  if (pinned && oracleManifestDigest) {
    oraclePins.set(registered, pinned); oracleManifestDigests.set(datasetKey, oracleManifestDigest);
  }
  return registered;
}
function options(value: unknown): SharedEvaluationOptions {
  const input = object(value, ['contractVersion', 'scope', 'mode', 'runId', 'attemptId', 'codeRevision', 'perCaseTimeoutMs', 'registrations', 'selections']);
  if (input.contractVersion !== SHARED_EVALUATION_VERSION || !member(input.scope, ['uc', 'project'])
    || !member(input.mode, ['mock', 'real']) || !Number.isSafeInteger(input.perCaseTimeoutMs)
    || Number(input.perCaseTimeoutMs) <= 0 || Number(input.perCaseTimeoutMs) > 60000) fail();
  text(input.runId); text(input.attemptId); text(input.codeRevision);
  const registered = array(input.registrations); const keys = new Set<string>();
  for (const entry of registered) {
    if (!entry || typeof entry !== 'object' || !executions.has(entry as RegisteredEvaluation)) fail();
    const item = entry as RegisteredEvaluation; const key = `${item.ucId}/${item.datasetId}/${item.datasetVersion}`;
    if (keys.has(key)) fail(); keys.add(key);
  }
  const selections = array(input.selections); const selectedUcs = new Set<string>();
  if (!selections.length || input.scope === 'uc' && selections.length !== 1) fail();
  for (const raw of selections) {
    const selection = object(raw, ['ucId', 'datasetId', 'datasetVersion', 'level', 'caseIds', 'requiredCases', 'requiredAttacks', 'configDigest']);
    const uc = text(selection.ucId); text(selection.datasetId); text(selection.datasetVersion); sha(selection.configDigest);
    if (!/^UC-\d{2}$/u.test(uc) || selectedUcs.has(uc) || typeof selection.level !== 'string' || !levels.has(selection.level)) fail(); selectedUcs.add(uc);
    const ids = array(selection.caseIds);
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !text(id).startsWith(`${uc}:`))
      || selection.requiredCases !== ids.length || !Number.isSafeInteger(selection.requiredAttacks)
      || Number(selection.requiredAttacks) < 0 || Number(selection.requiredAttacks) > ids.length) fail();
  }
  // Preserve opaque registered-object identity; copy caller-controlled selection data before awaits.
  return { contractVersion: SHARED_EVALUATION_VERSION, scope: input.scope as 'uc' | 'project', mode: input.mode as 'mock' | 'real',
    runId: text(input.runId), attemptId: text(input.attemptId), codeRevision: text(input.codeRevision), perCaseTimeoutMs: Number(input.perCaseTimeoutMs),
    registrations: registered as RegisteredEvaluation[], selections: snapshot(selections) as SharedSelection[] };
}
async function timed<T>(operation: (canContinue: () => boolean) => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false; const deadline = performance.now() + timeoutMs;
  try { return await Promise.race([operation(() => !expired && performance.now() < deadline), new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error('Evaluation deadline')); }, timeoutMs);
  })]); } finally { expired = true; if (timer) clearTimeout(timer); }
}
function grade(value: unknown): SharedGrade {
  const result = object(value, ['status', 'classification', 'safety', 'oracleDigest', 'components']);
  if (!member(result.status, ['pass', 'fail'])
    || !member(result.classification, ['correct', 'incorrect', 'not-observed', 'not-applicable']) || typeof result.safety !== 'boolean'
    || result.status === 'pass' && (!result.safety || ['incorrect', 'not-observed'].includes(result.classification))) fail();
  if (!result.components || typeof result.components !== 'object' || Object.getPrototypeOf(result.components) !== Object.prototype
    || Reflect.ownKeys(result.components).length > 32) fail();
  for (const key of Reflect.ownKeys(result.components)) {
    text(key); const component = Object.getOwnPropertyDescriptor(result.components, key);
    if (!component?.enumerable || !('value' in component) || !member(component.value, ['pass', 'fail', 'not-observed', 'not-applicable'])
      || result.status === 'pass' && component.value === 'fail') fail();
  }
  sha(result.oracleDigest); return snapshot(result) as SharedGrade;
}
/** Internal extension of the existing runner. The public execution entry remains runEvaluation. */
export async function runRegisteredEvaluation(value: unknown): Promise<SharedEvaluationReport> {
  const request = options(value); const results: SharedCaseResult[] = []; const groups: SharedEvaluationReport['groups'][number][] = [];
  const chosen = request.selections.map(selection => {
    const registration = request.registrations.find(item => item.ucId === selection.ucId && item.datasetId === selection.datasetId
      && item.datasetVersion === selection.datasetVersion);
    const cases = selection.caseIds.map(id => registration?.cases.find(item => item.caseId === id && item.levels.includes(selection.level)));
    if (registration && (cases.some(item => !item) || cases.filter(item => item?.attack).length !== selection.requiredAttacks)) fail();
    return { selection, registration, cases };
  });
  const namespaces = chosen.flatMap(({ selection }) => selection.caseIds.map(caseId =>
    `${request.runId}/${selection.ucId}/${selection.datasetId}/${selection.datasetVersion}/${caseId}/${selection.level}/${request.attemptId}`));
  if (namespaces.some(key => reservedNamespaces.has(key))) fail();
  // Reserve every attempt before execution, including concurrent invocations; never overwrite history.
  for (const { registration } of chosen) {
    if (!registration) continue;
    const attempts = executions.get(registration); const key = `${request.runId}/${request.attemptId}`;
    if (!attempts || attempts.has(key)) fail();
  }
  for (const { registration } of chosen) if (registration) executions.get(registration)?.add(`${request.runId}/${request.attemptId}`);
  for (const key of namespaces) reservedNamespaces.add(key);
  for (const { selection, registration, cases } of chosen) {
    const groupResults: SharedCaseResult[] = [];
    for (const [index, caseId] of selection.caseIds.entries()) {
      const spec = cases[index]; const handler = registration && callbacks.get(registration);
      const isolationKey = `${request.runId}/${selection.ucId}/${selection.datasetId}/${selection.datasetVersion}/${caseId}/${selection.level}/${request.attemptId}`;
      let result: SharedCaseResult = { ucId: selection.ucId, datasetId: selection.datasetId, datasetVersion: selection.datasetVersion,
        datasetDigest: registration?.datasetDigest ?? null, caseId, caseDigest: spec?.caseDigest ?? null, level: selection.level,
        runId: request.runId, attemptId: request.attemptId, provenance: request.mode, status: 'not-run', reasonCode: 'registration-unavailable',
        classification: 'not-observed', safety: null, oracleDigest: null, durationMs: null, isolationKey,
        adapterVersion: registration?.adapterVersion ?? null, graderVersion: registration?.graderVersion ?? null,
        components: {}, usage: null, usageState: 'not-applicable', codeRevision: request.codeRevision, configDigest: selection.configDigest };
      if (registration && spec) {
        if (request.mode === 'real' || selection.level === 'real-integration' || selection.level === 'model-quality' || registration.provenance !== 'mock') {
          result = { ...result, reasonCode: 'real-execution-unavailable' };
        } else if (!handler) result = { ...result, reasonCode: 'driver-or-grader-unavailable' };
        else {
          const started = performance.now();
          try {
            const context: SharedExecutionContext = freeze({ runId: request.runId, attemptId: request.attemptId, ucId: selection.ucId,
              caseId, level: selection.level, provenance: 'mock', isolationKey });
            const graded = await timed(async canContinue => {
              const observed = await handler.execute(snapshot(spec.payload), context);
              if (!canContinue()) throw new Error('Evaluation deadline');
              const graded = await handler.grade(caseId, observed);
              if (!canContinue()) throw new Error('Evaluation deadline');
              const validated = grade(graded);
              const expectedDigest = oraclePins.get(registration)?.[caseId];
              if (expectedDigest !== undefined && validated.oracleDigest !== expectedDigest) fail();
              return validated;
            }, request.perCaseTimeoutMs);
            result = { ...result, ...graded, reasonCode: graded.status === 'pass' ? 'criteria-satisfied' : 'criteria-violation', durationMs: performance.now() - started };
          } catch { result = { ...result, status: 'error', reasonCode: 'execution-or-grading-error', durationMs: performance.now() - started }; }
        }
      }
      groupResults.push(freeze(result)); results.push(freeze(result));
    }
    const completeness = groupResults.some(result => result.status === 'error' || result.status === 'not-run') ? 'incomplete' : 'complete';
    const hardFailed = cases.some((spec, index) => spec?.gate === 'hard' && groupResults[index]?.status === 'fail')
      || groupResults.some(result => result.safety === false || Object.values(result.components).includes('fail'));
    const hardGate = hardFailed ? 'fail' : completeness === 'incomplete' ? 'incomplete' : 'pass';
    const scored = cases.flatMap((spec, index) => spec?.classificationScored ? [groupResults[index]] : []).filter(item => item !== undefined);
    const correct = scored.filter(result => result.classification === 'correct').length;
    const total = scored.length; const accuracy = total ? correct / total : null;
    const qualityVerdict = total ? (accuracy !== null && accuracy >= 0.8 ? 'pass' : 'fail') : 'not-applicable';
    const acceptance = hardGate === 'fail' || qualityVerdict === 'fail' ? 'fail' : completeness === 'incomplete' ? 'incomplete' : 'pass';
    groups.push({ ucId: selection.ucId, level: selection.level, hardGate, quality: { correct, total, accuracy, verdict: qualityVerdict }, completeness, acceptance });
  }
  const acceptance = groups.some(item => item.acceptance === 'fail') ? 'fail' : groups.some(item => item.acceptance === 'incomplete') ? 'incomplete' : 'pass';
  return freeze({ contractVersion: SHARED_EVALUATION_VERSION, scope: request.scope, mode: request.mode, results, groups, acceptance, exitCode: acceptance === 'pass' ? 0 : 1 });
}
