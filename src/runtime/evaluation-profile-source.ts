/**
 * Containment profile admission, source intake and exposure derivation for runtime-evaluation/1.
 * Admission issues an in-process capability only; it grants no execution or provider authority.
 */
import { sha256Text, type Validation } from '../uc01/contracts.ts';
import { isAdmittedEvaluationProfile } from './evaluation-profile-admission.ts';
import { BUG_KEYS, catalogDigestOf, collect, deny, keysOf, plain, text } from './evaluation-profile-primitives.ts';
import type { BugInput, BoundSource, CaseBinding, CatalogEntry, IntakeQuestion, SourceHost } from './evaluation-profile-types.ts';

export * from './evaluation-profile-types.ts';
export { admitEvaluationProfile, isAdmittedEvaluationProfile } from './evaluation-profile-admission.ts';
export { deriveExposureCeiling } from './evaluation-profile-exposure.ts';

function textList(value: unknown, path: string, maxItems: number, maxBytes: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) deny('INVALID_LIST', path);
  return Object.freeze(value.map((item, index) => text(item, `${path}[${index}]`, maxBytes)));
}

function bugInputOf(value: unknown, path: string): BugInput {
  const record = keysOf(value, BUG_KEYS, path);
  const goal = text(record.goal, `${path}.goal`);
  const observedBehavior = text(record.observedBehavior, `${path}.observedBehavior`);
  const expectedBehavior = text(record.expectedBehavior, `${path}.expectedBehavior`);
  // Absent or blank reproduction/criteria is incomplete intake, not invalid input.
  const reproduction = record.reproduction === undefined || (typeof record.reproduction === 'string' && !record.reproduction.trim()) ? '' : text(record.reproduction, `${path}.reproduction`);
  const acceptanceCriteria = record.acceptanceCriteria === undefined ? Object.freeze([] as string[]) : textList(record.acceptanceCriteria, `${path}.acceptanceCriteria`, 16, 1024);
  const constraints = record.constraints === undefined ? undefined : textList(record.constraints, `${path}.constraints`, 16, 1024);
  const input: BugInput =
    constraints === undefined
      ? { goal, observedBehavior, expectedBehavior, reproduction, acceptanceCriteria }
      : { goal, observedBehavior, expectedBehavior, reproduction, acceptanceCriteria, constraints };
  if (Buffer.byteLength(JSON.stringify(input)) > 65536) deny('REQUEST_TOO_LARGE', path);
  return Object.freeze(input);
}

const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/gu, ' ');

function intakeQuestions(input: BugInput): readonly IntakeQuestion[] {
  const questions: IntakeQuestion[] = [];
  if (!input.reproduction) questions.push({ questionId: 'q-reproduction', text: 'Provide deterministic steps that reproduce the observed behavior.' });
  if (!input.acceptanceCriteria.length) questions.push({ questionId: 'q-acceptance-criteria', text: 'List the observable acceptance criteria for a correct repair.' });
  if (normalize(input.goal) === normalize(input.observedBehavior) && normalize(input.expectedBehavior) === normalize(input.observedBehavior)) {
    questions.push({ questionId: 'q-intent', text: 'State the intended goal or expected behavior distinct from the observed behavior.' });
  }
  return Object.freeze(questions);
}

function bindingOf(entry: CatalogEntry): CaseBinding {
  return Object.freeze({
    caseId: entry.caseId,
    version: entry.version,
    caseDigest: entry.caseDigest,
    publicTaskDigest: entry.publicTaskDigest,
    initialRepositoryDigest: entry.initialRepositoryDigest,
    catalogEntryId: entry.catalogEntryId,
    grader: Object.freeze({ version: entry.grader.version, digest: entry.grader.digest }),
  });
}

function checkSource(source: unknown, host: SourceHost): BoundSource {
  if (!isAdmittedEvaluationProfile(host.profile)) deny('NOT_ADMITTED', '$.host.profile');
  if (catalogDigestOf(host.catalog) !== host.profile.catalogDigest) deny('CATALOG_MISMATCH', '$.host.catalog');
  if (!plain(source)) deny('INVALID_SOURCE', '$.source');
  if (source.kind === 'catalog') {
    keysOf(source, ['kind', 'caseIds'], '$.source');
    const caseIds = textList(source.caseIds, '$.source.caseIds', host.catalog.length, 128);
    if (!caseIds.length) deny('INVALID_SOURCE', '$.source.caseIds');
    if (new Set(caseIds).size !== caseIds.length) deny('DUPLICATE_CASE', '$.source.caseIds');
    const bindings = caseIds.map((caseId, index) => {
      const entry = host.catalog.find(candidate => candidate.caseId === caseId);
      return entry ? bindingOf(entry) : deny('UNKNOWN_CASE', `$.source.caseIds[${index}]`);
    });
    return Object.freeze({ kind: 'catalog', status: 'bound', bindings: Object.freeze(bindings) });
  }
  if (source.kind !== 'bug') deny('INVALID_SOURCE', '$.source.kind');
  keysOf(source, ['kind', 'repositoryId', 'checkSetId', 'bugInput'], '$.source');
  const repositoryId = text(source.repositoryId, '$.source.repositoryId', 128);
  const checkSetId = text(source.checkSetId, '$.source.checkSetId', 128);
  if (!host.repositoryIds.includes(repositoryId)) deny('UNCONFIGURED_REPOSITORY', '$.source.repositoryId');
  if (!host.checkSetIds.includes(checkSetId)) deny('UNCONFIGURED_CHECK_SET', '$.source.checkSetId');
  const bugInput = bugInputOf(source.bugInput, '$.source.bugInput');
  const questions = intakeQuestions(bugInput);
  const submissionDigest = sha256Text(JSON.stringify({ repositoryId, checkSetId, bugInput, questions }));
  return Object.freeze({
    kind: 'bug',
    version: 1,
    status: questions.length ? 'needs-info' : 'complete',
    submissionId: `sub-${submissionDigest.slice(0, 32)}`,
    submissionDigest,
    repositoryId,
    checkSetId,
    bugInput,
    questions,
    taskId: null,
  });
}

/** Resolves typed source against the admitted profile and trusted host catalog/configuration. */
export function bindEvaluationSource(source: unknown, host: SourceHost): Validation<BoundSource> {
  return collect(() => checkSource(source, host));
}
