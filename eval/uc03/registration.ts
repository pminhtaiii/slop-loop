/**
 * Registrations for the uc03 workflow evaluation suite.
 *
 * Only public case data is registered: ids, category, expected outcome and requirement refs.
 * Private grader payloads, task bytes, ports and credentials stay host-held.
 */

import { canonicalDigest, type Json } from '../../src/uc01/contracts.ts';
import { registerEvaluation, SHARED_EVALUATION_VERSION, type RegisteredEvaluation } from '../shared.ts';
import { EVALUATION_CASE_IDS, type EvaluationCaseSpec, type EvaluationOutcome } from './types.ts';

export const UC03_DATASET_ID = 'uc03-workflow-evaluation';
export const UC03_DATASET_VERSION = '1';
export const UC03_DATASET_ADAPTER_VERSION = 'uc03-workflow-driver-v1';
export const UC03_GRADER_VERSION = 'uc03-workflow-observation-v1';

const OUTCOMES = new Set<string>(['COMPLETED', 'INCOMPLETE', 'IMPLEMENTED_UNVERIFIED', 'FAILED']);
const CASE_IDS = new Set<string>(EVALUATION_CASE_IDS);
const REQUIREMENT = /^(FR|SC)-\d{3}$/u;

function parseSpec(value: unknown): EvaluationCaseSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid UC-03 evaluation case');
  const record = value as Record<string, unknown>;
  const caseId = record['caseId'];
  const name = record['name'];
  const description = record['description'];
  const category = record['category'];
  const expectedOutcome = record['expectedOutcome'];
  const requirements = record['requirements'];
  if (typeof caseId !== 'string' || !CASE_IDS.has(caseId) || record['required'] !== true) throw new Error('Invalid UC-03 evaluation case');
  if (typeof name !== 'string' || !name.trim() || typeof description !== 'string' || !description.trim() || typeof category !== 'string' || !category.trim()) {
    throw new Error('Invalid UC-03 evaluation case');
  }
  if (typeof expectedOutcome !== 'string' || !OUTCOMES.has(expectedOutcome)) throw new Error('Invalid UC-03 evaluation case');
  if (!Array.isArray(requirements) || requirements.length === 0 || requirements.length > 16 || !requirements.every(item => typeof item === 'string' && REQUIREMENT.test(item))) {
    throw new Error('Invalid UC-03 evaluation case');
  }
  return {
    caseId: caseId as EvaluationCaseSpec['caseId'],
    name,
    description,
    category,
    required: true,
    expectedOutcome: expectedOutcome as EvaluationOutcome,
    requirements: [...requirements] as readonly string[],
  };
}

/** Public payload only: no task bytes, hidden grader id or host fixture path. */
function publicPayload(spec: EvaluationCaseSpec): Json {
  return {
    suite: 'uc03',
    caseId: spec.caseId,
    category: spec.category,
    expectedOutcome: spec.expectedOutcome,
    requirements: [...spec.requirements],
  };
}

export function registerUC03WorkflowEvaluation(cases: readonly unknown[], expectedOracleDigests?: Readonly<Record<string, string>>): RegisteredEvaluation {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('Invalid UC-03 evaluation dataset');
  const specs = cases.map(parseSpec);
  if (new Set(specs.map(spec => spec.caseId)).size !== specs.length) throw new Error('Invalid UC-03 evaluation dataset');
  if (expectedOracleDigests !== undefined) {
    const pinned = Object.keys(expectedOracleDigests);
    if (pinned.length !== specs.length || !specs.every(spec => pinned.includes(`UC-03:${spec.caseId}`))) throw new Error('Invalid UC-03 evaluation oracle pins');
  }
  return registerEvaluation(
    {
      contractVersion: SHARED_EVALUATION_VERSION,
      ucId: 'UC-03',
      datasetId: UC03_DATASET_ID,
      datasetVersion: UC03_DATASET_VERSION,
      adapterVersion: UC03_DATASET_ADAPTER_VERSION,
      graderVersion: UC03_GRADER_VERSION,
      provenance: 'mock',
      cases: specs.map(spec => {
        const payload = publicPayload(spec);
        return {
          caseId: `UC-03:${spec.caseId}`,
          caseDigest: canonicalDigest('PublicCase', payload),
          levels: ['contract', 'mock-behavior'],
          gate: 'hard',
          classificationScored: false,
          attack: spec.category === 'test-protection' || spec.category === 'path-traversal' || spec.category === 'secrets' || spec.category === 'command-injection',
          digestProfile: 'canonical-json-v1',
          payload,
        };
      }),
    },
    undefined,
    expectedOracleDigests,
  );
}
