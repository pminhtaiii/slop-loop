/**
 * UC-06 Reviewer Agent Evaluation Registration
 * Registers requirement cases R01-R20 and quality cases Q01-Q12
 * adhering to Evaluation Contract uc06-review-evaluation/1.
 */
import { canonicalDigest, type Json } from '../../src/uc01/contracts.ts';
import { registerEvaluation, SHARED_EVALUATION_VERSION, type RegisteredEvaluation, type SharedExecutionContext, type SharedExecutionContextV2, type SharedGrade } from '../shared.ts';
import { UC06_QUALITY_CASES, UC06_QUALITY_LABELS, UC06_REQUIREMENT_INVENTORY, type UC06QualityCaseDescriptor } from './catalog.ts';
import { gradeQualityCase, type CaseObservationInput } from './grade.ts';

export const UC06_DATASET_ID = 'uc06-reviewer-evaluation';
export const UC06_DATASET_VERSION = '1';
export const UC06_DATASET_ADAPTER_VERSION = 'uc06-runtime-reviewer-v1';
export const UC06_GRADER_VERSION = 'uc06-independent-grader-v1';

export type UC06EvaluationObservation = Readonly<{
  caseId: string;
  result?: unknown;
  error?: string;
  status?: 'pass' | 'fail';
  safety?: boolean;
}>;

export type UC06EvaluationAdapter = Readonly<{
  version: string;
  provenance: 'mock' | 'real';
  execute: (payload: Json, context: SharedExecutionContext | SharedExecutionContextV2) => Promise<UC06EvaluationObservation>;
}>;

const toRawSha = (val: string) => (val.startsWith('sha256:') ? val.slice(7) : val);

function publicQualityPayload(c: UC06QualityCaseDescriptor): Json {
  return {
    suite: 'uc06',
    caseId: c.caseId,
    name: c.name,
    kind: c.kind,
    file: c.file,
    diff: c.diff,
    diffDigest: c.diffDigest,
    defectCategory: c.defectCategory ?? null,
  };
}

export const UC06_REQUIREMENT_ORACLES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(UC06_REQUIREMENT_INVENTORY.map(req => [`UC-06:${req.id}`, canonicalDigest('GradingCase', { requirementId: req.id, family: req.family, tier: req.tier, gate: 'hard' })])),
);

export const UC06_QUALITY_ORACLES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(UC06_QUALITY_LABELS.map(lbl => [`UC-06:${lbl.caseId}`, toRawSha(lbl.oracleDigest)])));

export const UC06_ALL_ORACLE_PINS: Readonly<Record<string, string>> = Object.freeze({
  ...UC06_REQUIREMENT_ORACLES,
  ...UC06_QUALITY_ORACLES,
});

export function registerUC06Evaluation(adapter?: UC06EvaluationAdapter, criteriaGrader?: (caseId: string, observation: unknown) => Promise<SharedGrade>): RegisteredEvaluation {
  const qCaseMap = new Map(UC06_QUALITY_CASES.map(c => [`UC-06:${c.caseId}`, c]));
  const qLabelMap = new Map(UC06_QUALITY_LABELS.map(l => [`UC-06:${l.caseId}`, l]));

  const rCases = UC06_REQUIREMENT_INVENTORY.map(req => {
    const payload: Json = {
      suite: 'uc06',
      requirementId: req.id,
      name: req.name,
      family: req.family,
      tier: req.tier,
      requiredMilestones: [...req.requiredMilestones],
      description: req.description,
    };
    return {
      caseId: `UC-06:${req.id}`,
      caseDigest: canonicalDigest('PublicCase', payload),
      levels: ['contract', 'mock-behavior'] as const,
      gate: 'hard' as const,
      classificationScored: false,
      attack: req.family === 'security' || req.family === 'guard',
      digestProfile: 'canonical-json-v1' as const,
      payload,
    };
  });

  const qCases = UC06_QUALITY_CASES.map(c => {
    const payload = publicQualityPayload(c);
    return {
      caseId: `UC-06:${c.caseId}`,
      caseDigest: canonicalDigest('PublicCase', payload),
      levels: ['model-quality'] as const,
      gate: 'scored' as const,
      classificationScored: true,
      attack: c.defectCategory === 'security',
      digestProfile: 'canonical-json-v1' as const,
      payload,
    };
  });

  const allCases = [...rCases, ...qCases];

  return registerEvaluation(
    {
      contractVersion: SHARED_EVALUATION_VERSION,
      ucId: 'UC-06',
      datasetId: UC06_DATASET_ID,
      datasetVersion: UC06_DATASET_VERSION,
      adapterVersion: adapter?.version ?? UC06_DATASET_ADAPTER_VERSION,
      graderVersion: UC06_GRADER_VERSION,
      provenance: adapter?.provenance ?? 'mock',
      cases: allCases,
    },
    adapter
      ? {
          execute: async (payload, context) => adapter.execute(payload, context),
          grade: async (caseId, observation) => {
            if (criteriaGrader) return criteriaGrader(caseId, observation);
            if (caseId.startsWith('UC-06:Q')) {
              const c = qCaseMap.get(caseId);
              const label = qLabelMap.get(caseId);
              if (!c || !label) throw new Error(`Unknown quality case: ${caseId}`);
              const obs = observation as CaseObservationInput | undefined;
              if (obs && obs.caseId !== undefined && obs.caseId !== c.caseId && obs.caseId !== caseId) {
                return {
                  status: 'fail',
                  classification: 'incorrect',
                  safety: true,
                  oracleDigest: toRawSha(label.oracleDigest),
                  components: { localizedMatch: 'fail', safety: 'pass' },
                };
              }
              const judging = gradeQualityCase(c, label, obs);
              const isClean = label.expectedStatus === 'clean';
              const classification = isClean ? (judging.fp === 0 ? 'correct' : 'incorrect') : judging.tp > 0 ? 'correct' : 'incorrect';
              return {
                status: judging.passed ? 'pass' : 'fail',
                classification,
                safety: !judging.safetyViolation,
                oracleDigest: toRawSha(label.oracleDigest),
                components: {
                  localizedMatch: judging.passed ? 'pass' : 'fail',
                  safety: !judging.safetyViolation ? 'pass' : 'fail',
                },
              };
            }
            const oracle = UC06_REQUIREMENT_ORACLES[caseId];
            if (!oracle) throw new Error(`Unknown requirement case: ${caseId}`);
            const obs = observation as { caseId?: string; status?: string; safety?: boolean } | undefined;
            const matchesCase = obs?.caseId === caseId || obs?.caseId === caseId.replace('UC-06:', '');
            const pass = obs?.status === 'pass' && matchesCase;
            return {
              status: pass ? 'pass' : 'fail',
              classification: 'not-applicable',
              safety: obs?.safety !== false,
              oracleDigest: oracle,
              components: {
                requirement: pass ? 'pass' : 'fail',
              },
            };
          },
        }
      : undefined,
    UC06_ALL_ORACLE_PINS,
  );
}
