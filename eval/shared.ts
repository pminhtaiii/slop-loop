import { canonicalDigest, validatePublicCase, type ExecutionLevel, type Json } from '../src/uc01/contracts.ts';
import { array, executionLevels as levels, fail, member, object, sha, text } from './shared-validation.ts';
import type * as ST from './shared-types.ts';
import { SHARED_EVALUATION_VERSION, SHARED_EVALUATION_V2_VERSION } from './shared-types.ts';
export * from './shared-types.ts';
export { isAdmittedRealExecutionAdmission, issueRealExecutionAdmission } from './shared-admission.ts';
import { isAdmittedRealExecutionAdmission } from './shared-admission.ts';

const callbacks = new WeakMap<ST.RegisteredEvaluation, ST.EvaluationCallbacks | ST.EvaluationCallbacksV2>();
const executions = new WeakMap<ST.RegisteredEvaluation, Set<string>>();
const reservedNamespaces = new Set<string>();
const datasetDigests = new Map<string, string>();
const oracleManifestDigests = new Map<string, string>();
const oraclePins = new WeakMap<ST.RegisteredEvaluation, Readonly<Record<string, string>>>();
const defResult = {
  status: 'not-run' as const,
  reasonCode: 'registration-unavailable',
  classification: 'not-observed' as const,
  safety: null,
  oracleDigest: null,
  durationMs: null,
  components: {},
  usage: null,
  usageState: 'not-applicable' as const,
};
const freeze = <T>(v: T): T => {
  if (v && typeof v === 'object') {
    for (const item of Object.values(v)) freeze(item);
    Object.freeze(v);
  }
  return v;
};
const snapshot = <T>(v: T): T => freeze(structuredClone(v));
export function registerEvaluation<C extends ST.EvaluationCallbacks | ST.EvaluationCallbacksV2 = ST.EvaluationCallbacks>(
  value: unknown,
  handlers?: C,
  expectedOracleDigests?: Readonly<Record<string, string>>,
): ST.RegisteredEvaluation {
  const input = object(value, ['contractVersion', 'ucId', 'datasetId', 'datasetVersion', 'adapterVersion', 'graderVersion', 'provenance', 'cases']);
  if (input.contractVersion !== SHARED_EVALUATION_VERSION || !/^UC-\d{2}$/u.test(text(input.ucId)) || !member(input.provenance, ['mock', 'real'])) fail();
  const ucId = text(input.ucId);
  const ids = new Set<string>();
  const cases = array(input.cases).map(raw => {
    const item = object(raw, ['caseId', 'caseDigest', 'levels', 'gate', 'classificationScored', 'attack', 'digestProfile', 'payload']);
    const caseId = text(item.caseId);
    if (!caseId.startsWith(`${ucId}:`) || ids.has(caseId)) fail();
    ids.add(caseId);
    const caseLevels = array(item.levels);
    if (
      !caseLevels.length ||
      new Set(caseLevels).size !== caseLevels.length ||
      caseLevels.some(level => typeof level !== 'string' || !levels.has(level)) ||
      !member(item.gate, ['hard', 'scored']) ||
      typeof item.classificationScored !== 'boolean' ||
      typeof item.attack !== 'boolean' ||
      (item.gate === 'scored' && (!item.classificationScored || caseLevels.some(level => level !== 'model-quality')))
    )
      fail();
    canonicalDigest('PublicCase', item.payload);
    if (Buffer.byteLength(JSON.stringify(item.payload)) > 1024 * 1024) fail();
    if (item.digestProfile === 'uc01-evaluation-sha256-v1') {
      const p = validatePublicCase(item.payload);
      const v = p.ok ? p.value : null;
      if (
        !v ||
        v.caseId !== caseId ||
        v.caseDigest !== item.caseDigest ||
        v.datasetId !== input.datasetId ||
        v.datasetVersion !== input.datasetVersion ||
        JSON.stringify(v.levels) !== JSON.stringify(caseLevels) ||
        v.gate !== item.gate ||
        item.classificationScored !== (v.gate === 'scored') ||
        item.attack !== (v.categories.includes('safety') || v.familyId === 'C15')
      )
        fail();
    } else if (item.digestProfile !== 'canonical-json-v1' || canonicalDigest('PublicCase', item.payload) !== item.caseDigest) fail();
    return snapshot({
      caseId,
      caseDigest: sha(item.caseDigest),
      levels: caseLevels as ExecutionLevel[],
      gate: item.gate as 'hard' | 'scored',
      classificationScored: item.classificationScored,
      attack: item.attack,
      digestProfile: item.digestProfile as ST.SharedCase['digestProfile'],
      payload: item.payload as Json,
    });
  });
  if (!cases.length) fail();
  const descriptor = {
    contractVersion: SHARED_EVALUATION_VERSION,
    ucId,
    datasetId: text(input.datasetId),
    datasetVersion: text(input.datasetVersion),
    adapterVersion: text(input.adapterVersion),
    graderVersion: text(input.graderVersion),
    provenance: input.provenance as 'mock' | 'real',
    cases,
  } as const;
  const registered = snapshot({
    ...descriptor,
    datasetDigest: canonicalDigest('PublicCase', {
      contractVersion: descriptor.contractVersion,
      ucId,
      datasetId: descriptor.datasetId,
      datasetVersion: descriptor.datasetVersion,
      cases,
    }),
  });
  const datasetKey = `${ucId}/${registered.datasetId}/${registered.datasetVersion}`;
  const previousDigest = datasetDigests.get(datasetKey);
  if (previousDigest !== undefined && previousDigest !== registered.datasetDigest) fail();
  let pinned: Readonly<Record<string, string>> | undefined;
  let oracleManifestDigest: string | undefined;
  if (expectedOracleDigests !== undefined) {
    const manifest = object(
      expectedOracleDigests,
      cases.map(item => item.caseId),
    );
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
    oraclePins.set(registered, pinned);
    oracleManifestDigests.set(datasetKey, oracleManifestDigest);
  }
  return registered;
}
const v2Keys = 'ucId,datasetId,datasetVersion,level,caseIds,requiredCases,requiredAttacks,configDigest,profileDigest,pricingDigest,adapterVersions,requestedModel,realAdmission'.split(
  ',',
) as (keyof ST.SharedSelectionV2)[];
const v1Keys = v2Keys.slice(0, 8);

function parseOptions<T extends ST.SharedEvaluationOptions | ST.SharedEvaluationOptionsV2>(value: unknown, expectedVersion: typeof SHARED_EVALUATION_VERSION | typeof SHARED_EVALUATION_V2_VERSION): T {
  const isV2 = expectedVersion === SHARED_EVALUATION_V2_VERSION;
  const input = object(value, ['contractVersion', 'scope', 'mode', 'runId', 'attemptId', 'codeRevision', 'perCaseTimeoutMs', 'registrations', 'selections']);
  const t = Number(input.perCaseTimeoutMs);
  if (input.contractVersion !== expectedVersion || !member(input.scope, ['uc', 'project']) || !member(input.mode, ['mock', 'real']) || !Number.isSafeInteger(t) || t <= 0 || t > 60000) fail();
  text(input.runId);
  text(input.attemptId);
  text(input.codeRevision);
  const registered = array(input.registrations) as ST.RegisteredEvaluation[];
  const keys = new Set<string>();
  for (const r of registered) {
    if (!r || typeof r !== 'object' || !executions.has(r)) fail();
    const k = `${r.ucId}/${r.datasetId}/${r.datasetVersion}`;
    if (keys.has(k)) fail();
    keys.add(k);
  }
  const selections = array(input.selections);
  const selectedUcs = new Set<string>();
  if (!selections.length || (input.scope === 'uc' && selections.length !== 1)) fail();
  for (const raw of selections) {
    if (!raw || typeof raw !== 'object') fail();
    const rawKeys = Reflect.ownKeys(raw).map(String);
    const allowed = isV2 ? v2Keys : v1Keys;
    if (!v1Keys.every(k => rawKeys.includes(k)) || !rawKeys.every(k => (allowed as readonly string[]).includes(k))) fail();
    const selection = object(raw, rawKeys);
    const uc = text(selection.ucId);
    text(selection.datasetId);
    text(selection.datasetVersion);
    sha(selection.configDigest);
    if (isV2) {
      if (selection.profileDigest !== undefined) sha(selection.profileDigest);
      if (selection.pricingDigest !== undefined) sha(selection.pricingDigest);
      if (selection.requestedModel !== undefined) text(selection.requestedModel);
      if (selection.adapterVersions !== undefined) array(selection.adapterVersions).forEach(text);
    }
    if (!/^UC-\d{2}$/u.test(uc) || selectedUcs.has(uc) || typeof selection.level !== 'string' || !levels.has(selection.level)) fail();
    selectedUcs.add(uc);
    const ids = array(selection.caseIds);
    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      ids.some(id => !text(id).startsWith(`${uc}:`)) ||
      selection.requiredCases !== ids.length ||
      !Number.isSafeInteger(selection.requiredAttacks) ||
      Number(selection.requiredAttacks) < 0 ||
      Number(selection.requiredAttacks) > ids.length
    )
      fail();
  }
  return {
    contractVersion: expectedVersion,
    scope: input.scope as 'uc' | 'project',
    mode: input.mode as 'mock' | 'real',
    runId: text(input.runId),
    attemptId: text(input.attemptId),
    codeRevision: text(input.codeRevision),
    perCaseTimeoutMs: t,
    registrations: registered,
    selections: selections.map(s => freeze({ ...(snapshot(s) as object), realAdmission: (s as ST.SharedSelectionV2).realAdmission })) as unknown as T['selections'],
  } as unknown as T;
}
async function timed<T>(operation: (canContinue: () => boolean) => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = performance.now() + timeoutMs;
  try {
    return await Promise.race([
      operation(() => !expired && performance.now() < deadline),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error('Evaluation deadline'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    expired = true;
    if (timer) clearTimeout(timer);
  }
}
function grade(value: unknown): ST.SharedGrade {
  const result = object(value, ['status', 'classification', 'safety', 'oracleDigest', 'components']);
  const { status, classification, safety, components, oracleDigest } = result;
  if (
    !member(status, ['pass', 'fail']) ||
    !member(classification, ['correct', 'incorrect', 'not-observed', 'not-applicable']) ||
    typeof safety !== 'boolean' ||
    (status === 'pass' && (!safety || ['incorrect', 'not-observed'].includes(classification)))
  )
    fail();
  if (!components || typeof components !== 'object' || Object.getPrototypeOf(components) !== Object.prototype || Reflect.ownKeys(components).length > 32) fail();
  for (const key of Reflect.ownKeys(components)) {
    text(key);
    const c = Object.getOwnPropertyDescriptor(components, key);
    if (!c?.enumerable || !('value' in c) || !member(c.value, ['pass', 'fail', 'not-observed', 'not-applicable']) || (status === 'pass' && c.value === 'fail')) fail();
  }
  sha(oracleDigest);
  return snapshot(result) as ST.SharedGrade;
}

async function runTimedExecution(
  handler: ST.EvaluationCallbacks | ST.EvaluationCallbacksV2,
  payload: unknown,
  context: ST.SharedExecutionContext | ST.SharedExecutionContextV2,
  caseId: string,
  registration: ST.RegisteredEvaluation,
  timeoutMs: number,
) {
  const started = performance.now();
  try {
    const graded = await timed(async canContinue => {
      const observed = await (handler.execute as (p: Json, c: typeof context) => Promise<unknown>)(snapshot(payload as Json), context);
      if (!canContinue()) throw new Error('Evaluation deadline');
      const g = await handler.grade(caseId, observed);
      if (!canContinue()) throw new Error('Evaluation deadline');
      const validated = grade(g);
      const expectedDigest = oraclePins.get(registration)?.[caseId];
      if (expectedDigest !== undefined && validated.oracleDigest !== expectedDigest) fail();
      return validated;
    }, timeoutMs);
    return { ...graded, reasonCode: graded.status === 'pass' ? 'criteria-satisfied' : 'criteria-violation', durationMs: performance.now() - started };
  } catch {
    return { status: 'error' as const, reasonCode: 'execution-or-grading-error', durationMs: performance.now() - started };
  }
}

async function executeEvaluation(request: ST.SharedEvaluationOptions | ST.SharedEvaluationOptionsV2, isV2: boolean): Promise<ST.SharedEvaluationReport | ST.SharedEvaluationReportV2> {
  const results: ST.SharedCaseResult[] = [];
  const groups: ST.SharedEvaluationReport['groups'][number][] = [];
  const chosen = request.selections.map(selection => {
    const { ucId, datasetId, datasetVersion, level } = selection;
    const registration = request.registrations.find(r => r.ucId === ucId && r.datasetId === datasetId && r.datasetVersion === datasetVersion);
    const cases = selection.caseIds.map(id => registration?.cases.find(c => c.caseId === id && c.levels.includes(level)));
    if (registration && (cases.some(item => !item) || cases.filter(item => item?.attack).length !== selection.requiredAttacks)) fail();
    return { selection, registration, cases };
  });
  const isoKey = (cId: string, sel: (typeof chosen)[number]['selection']) => `${request.runId}/${sel.ucId}/${sel.datasetId}/${sel.datasetVersion}/${cId}/${sel.level}/${request.attemptId}`;
  const namespaces = chosen.flatMap(({ selection: sel }) => sel.caseIds.map(cId => isoKey(cId, sel)));
  if (namespaces.some(key => reservedNamespaces.has(key))) fail();
  for (const { registration } of chosen) {
    if (!registration) continue;
    const attempts = executions.get(registration);
    const key = `${request.runId}/${request.attemptId}`;
    if (!attempts || attempts.has(key)) fail();
    attempts.add(key);
  }
  for (const key of namespaces) reservedNamespaces.add(key);
  for (const { selection, registration, cases } of chosen) {
    const groupResults: ST.SharedCaseResult[] = [];
    const selBase = {
      ...defResult,
      ucId: selection.ucId,
      datasetId: selection.datasetId,
      datasetVersion: selection.datasetVersion,
      datasetDigest: registration?.datasetDigest ?? null,
      level: selection.level,
      runId: request.runId,
      attemptId: request.attemptId,
      provenance: request.mode,
      adapterVersion: registration?.adapterVersion ?? null,
      graderVersion: registration?.graderVersion ?? null,
      codeRevision: request.codeRevision,
      configDigest: selection.configDigest,
    };
    for (const [index, caseId] of selection.caseIds.entries()) {
      const spec = cases[index];
      const handler = registration && callbacks.get(registration);
      const isolationKey = isoKey(caseId, selection);
      let result: ST.SharedCaseResult = { ...selBase, caseId, caseDigest: spec?.caseDigest ?? null, isolationKey };
      if (registration && spec) {
        const isRealTier = request.mode === 'real' || selection.level === 'real-integration' || selection.level === 'model-quality' || registration.provenance !== 'mock';
        let outcomeReason: string | undefined;
        let provenance: 'mock' | 'real' = 'mock';
        let admission: ST.RealExecutionAdmission | undefined;
        if (isRealTier && (!isV2 || request.mode === 'mock')) {
          outcomeReason = 'real-execution-unavailable';
        } else if (isV2 && isRealTier) {
          const sel = selection as ST.SharedSelectionV2;
          const binding: ST.RealExecutionBinding = {
            profileDigest: sel.profileDigest ?? '',
            configDigest: sel.configDigest,
            pricingDigest: sel.pricingDigest ?? '',
            adapterVersions: sel.adapterVersions ?? [registration.adapterVersion],
            caseIds: sel.caseIds,
            requestedModel: sel.requestedModel ?? '',
          };
          if (request.mode === 'real' && registration.provenance !== 'real') {
            outcomeReason = 'real-execution-unavailable';
          } else if ((sel.adapterVersions && !sel.adapterVersions.includes(registration.adapterVersion)) || !isAdmittedRealExecutionAdmission(sel.realAdmission, binding)) {
            outcomeReason = 'real-admission-missing-or-invalid';
          } else {
            provenance = 'real';
            admission = sel.realAdmission;
          }
        }
        if (outcomeReason) {
          result = { ...result, reasonCode: outcomeReason };
        } else if (!handler) {
          result = { ...result, reasonCode: 'driver-or-grader-unavailable' };
        } else {
          const ctx = freeze({ runId: request.runId, attemptId: request.attemptId, ucId: selection.ucId, caseId, level: selection.level, provenance, isolationKey, admission });
          result = { ...result, ...(await runTimedExecution(handler, spec.payload, ctx, caseId, registration, request.perCaseTimeoutMs)) };
        }
      }
      groupResults.push(freeze(result));
      results.push(freeze(result));
    }
    const completeness = groupResults.some(result => result.status === 'error' || result.status === 'not-run') ? 'incomplete' : 'complete';
    const hardFailed =
      cases.some((spec, index) => spec?.gate === 'hard' && groupResults[index]?.status === 'fail') ||
      groupResults.some((result, index) => !result.safety || (cases[index]?.gate === 'hard' && Object.values(result.components).includes('fail')));
    const hardGate = hardFailed ? 'fail' : completeness === 'incomplete' ? 'incomplete' : 'pass';
    const scored = cases.flatMap((spec, index) => (spec?.classificationScored ? [groupResults[index]] : [])).filter(item => item !== undefined);
    const correct = scored.filter(result => result.classification === 'correct').length;
    const total = scored.length;
    const accuracy = total ? correct / total : null;
    const cFails = scored.filter(r => r.caseId.startsWith('UC-06:Q0') && Number(r.caseId.slice(7)) <= 6 && r.classification !== 'correct').length;
    const qualityVerdict = total ? ((selection.ucId === 'UC-06' ? total === 12 && correct >= 11 && !cFails : accuracy !== null && accuracy >= 0.8) ? 'pass' : 'fail') : 'not-applicable';
    const acceptance = hardGate === 'fail' || qualityVerdict === 'fail' ? 'fail' : completeness === 'incomplete' ? 'incomplete' : 'pass';
    groups.push({ ucId: selection.ucId, level: selection.level, hardGate, quality: { correct, total, accuracy, verdict: qualityVerdict }, completeness, acceptance });
  }
  const acceptance = groups.some(item => item.acceptance === 'fail') ? 'fail' : groups.some(item => item.acceptance === 'incomplete') ? 'incomplete' : 'pass';
  return freeze({
    contractVersion: isV2 ? SHARED_EVALUATION_V2_VERSION : SHARED_EVALUATION_VERSION,
    scope: request.scope,
    mode: request.mode,
    results,
    groups,
    acceptance,
    exitCode: acceptance === 'pass' ? 0 : 1,
  }) as ST.SharedEvaluationReport | ST.SharedEvaluationReportV2;
}

export async function runRegisteredEvaluation(value: unknown): Promise<ST.SharedEvaluationReport> {
  return (await executeEvaluation(parseOptions(value, SHARED_EVALUATION_VERSION), false)) as ST.SharedEvaluationReport;
}

export async function runAdmittedEvaluation(value: unknown): Promise<ST.SharedEvaluationReportV2> {
  return (await executeEvaluation(parseOptions(value, SHARED_EVALUATION_V2_VERSION), true)) as ST.SharedEvaluationReportV2;
}
