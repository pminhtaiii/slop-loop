import { gradeCase, validateGradingCase, validatePublicCase, type GradingCriteria, type PublicCase } from '../../src/uc01/contracts.ts';
import { registerEvaluation, SHARED_EVALUATION_VERSION, type RegisteredEvaluation, type SharedExecutionContext } from '../shared.ts';

export type UC01EvaluationObservation = Readonly<{ outcome: unknown; context: unknown }>;
export type UC01EvaluationAdapter = Readonly<{ version: string; provenance: 'mock' | 'real';
  execute: (input: PublicCase['input'], context: SharedExecutionContext) => Promise<UC01EvaluationObservation> }>;
/** Only the host calls registration with grading records. No oracle enters execute's input or context. */
export function registerUC01Evaluation(publicCases: readonly unknown[], gradingCases: readonly unknown[],
  adapter?: UC01EvaluationAdapter,
  criteriaGrader?: (caseId: string, observation: UC01EvaluationObservation) => Promise<GradingCriteria>): RegisteredEvaluation {
  const cases = publicCases.map(item => {
    const parsed = validatePublicCase(item);
    if (!parsed.ok) throw new Error('Invalid UC-01 public evaluation case');
    return parsed.value;
  });
  const first = cases[0];
  if (!first || cases.some(item => item.datasetId !== first.datasetId || item.datasetVersion !== first.datasetVersion)
    || gradingCases.length !== cases.length) throw new Error('Invalid UC-01 evaluation dataset');
  const oracles = new Map(cases.map(record => {
    const matches = gradingCases.filter(item => item && typeof item === 'object' && Object.getOwnPropertyDescriptor(item, 'caseId')?.value === record.caseId);
    if (matches.length !== 1) throw new Error('Missing or duplicate UC-01 oracle');
    const parsed = validateGradingCase(matches[0], record);
    if (!parsed.ok) throw new Error('Invalid UC-01 evaluation oracle');
    return [record.caseId, structuredClone(parsed.value)] as const;
  }));
  const byId = new Map(cases.map(record => [record.caseId, record]));
  const execute = adapter?.execute.bind(adapter);
  return registerEvaluation({ contractVersion: SHARED_EVALUATION_VERSION, ucId: 'UC-01', datasetId: first.datasetId,
    datasetVersion: first.datasetVersion, adapterVersion: adapter?.version ?? 'unavailable', graderVersion: 'uc01-grade-case-v1',
    provenance: adapter?.provenance ?? 'mock', cases: cases.map(record => ({ caseId: record.caseId, caseDigest: record.caseDigest,
      levels: record.levels, gate: record.gate, classificationScored: record.gate === 'scored',
      attack: record.categories.includes('safety') || record.familyId === 'C15', digestProfile: 'uc01-evaluation-sha256-v1', payload: record })) }, execute && criteriaGrader ? {
      execute: async (input, context) => {
        const record = byId.get(context.caseId);
        if (!record) throw new Error('Unregistered UC-01 case');
        const parsed = validatePublicCase(input);
        if (!parsed.ok || parsed.value.caseDigest !== record.caseDigest) throw new Error('Invalid UC-01 driver input');
        return execute(parsed.value.input, context);
      },
      grade: async (caseId, observation) => {
        const record = byId.get(caseId); const oracle = oracles.get(caseId);
        if (!record || !oracle || !observation || typeof observation !== 'object') throw new Error('Invalid UC-01 grading observation');
        const outcome: unknown = Object.getOwnPropertyDescriptor(observation, 'outcome')?.value;
        const context: unknown = Object.getOwnPropertyDescriptor(observation, 'context')?.value;
        const criteria: unknown = await criteriaGrader(caseId, { outcome, context });
        const result = gradeCase(outcome, record.input.invocation, context, record, oracle, criteria);
        if (!result.ok) throw new Error('Invalid UC-01 grading observation');
        return { status: result.value.status, classification: result.value.classification, safety: result.value.safety, oracleDigest: oracle.oracleDigest,
          components: { severity: result.value.severity, provenance: result.value.provenance ? 'pass' : 'fail',
            evidenceSupport: result.value.evidenceSupport ? 'pass' : 'fail', clarification: result.value.clarification ? 'pass' : 'fail',
            destination: result.value.destination ? 'pass' : 'fail' } };
      },
    } : undefined, Object.fromEntries([...oracles].map(([caseId, oracle]) => [caseId, oracle.oracleDigest])));
}
