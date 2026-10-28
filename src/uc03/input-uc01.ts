import { validateIntake, validateOutcome, type TrustedContext } from '../uc01/contracts.ts';
import { hasInputKeys, isInputRecord, snapshotInputData, validateTaskData } from './input-data.ts';
import { RECEIVER_CONTRACT_VERSION, type IntakeResult } from './input-types.ts';

function configuredReceiver(value: unknown, context: TrustedContext): Readonly<{ destinationId: string; defectClassificationIds: readonly string[] }> | undefined {
  if (!isInputRecord(value) || !hasInputKeys(value, ['destinationId', 'defectClassificationIds'])) return undefined;
  const destinationId = value['destinationId'];
  const ids = value['defectClassificationIds'];
  if (typeof destinationId !== 'string' || !destinationId.trim() || !Array.isArray(ids) || !ids.length
    || ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) return undefined;
  const destination = context.catalog.destinations.find(entry => entry.id === destinationId);
  const classificationIds: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !context.catalog.classifications.some(entry => entry.id === id && entry.impairmentAssessment)
      || !destination?.acceptsClassificationIds.includes(id)) return undefined;
    classificationIds.push(id);
  }
  return { destinationId, defectClassificationIds: classificationIds };
}

export function receiveUc01Assessment(input: unknown): IntakeResult {
  const snapshot = snapshotInputData(input);
  const keys = ['contractVersion', 'outcome', 'invocation', 'context', 'suppliedBugTask', 'receiverConfig'];
  const value = snapshot.ok ? snapshot.value : undefined;
  if (!isInputRecord(value) || !hasInputKeys(value, keys) || keys.some(key => !Object.hasOwn(value, key))) {
    return { status: 'invalid-input', reasonCode: 'invalid-envelope', path: 'input' };
  }
  if (value['contractVersion'] !== RECEIVER_CONTRACT_VERSION) {
    return { status: 'invalid-input', reasonCode: 'unsupported-contract-version', path: 'contractVersion' };
  }
  const intake = validateIntake(value['invocation'], value['context']);
  if (!intake.ok) return { status: intake.status === 'conflict' ? 'conflict' : 'invalid-input', reasonCode: 'invalid-source-binding', path: 'context' };
  const config = configuredReceiver(value['receiverConfig'], intake.value.context);
  if (!config) return { status: 'invalid-input', reasonCode: 'invalid-receiver-config', path: 'receiverConfig' };
  const parsed = validateOutcome(value['outcome'], intake.value.invocation, intake.value.context);
  if (!parsed.ok) return { status: 'invalid-input', reasonCode: 'invalid-source-outcome', path: 'outcome' };
  const result = validateTaskData(value['suppliedBugTask']);
  if (result.status !== 'accepted' && result.status !== 'needs-info') return result;
  const supplied = value['suppliedBugTask'];
  const taskBindings = isInputRecord(supplied) ? supplied : {};
  const bindings = [
    ['taskId', intake.value.invocation.taskId],
    ['repositoryId', intake.value.context.repositoryId],
    ['configId', intake.value.context.configId],
    ['configVersion', intake.value.context.configVersion],
  ] as const;
  for (const [path, expected] of bindings) {
    const candidate = taskBindings[path];
    if (typeof candidate === 'string' && candidate.trim() && candidate.trim() !== expected) {
      return { status: 'conflict', reasonCode: 'task-binding-mismatch', path };
    }
  }
  const revision = taskBindings['initialRevisionDigest'];
  if (typeof revision === 'string' && revision.trim()) {
    const digest = /^(?:sha256:)?([a-f0-9]{64})$/u.exec(revision.trim())?.[1];
    if (!digest) return { status: 'invalid-input', reasonCode: 'invalid-revision-digest', path: 'initialRevisionDigest' };
    if (digest !== intake.value.context.repositorySnapshotDigest) return { status: 'conflict', reasonCode: 'task-binding-mismatch', path: 'initialRevisionDigest' };
  }
  const outcome = parsed.value;
  if (outcome.status === 'needs-info') return { status: 'needs-info', fields: result.status === 'needs-info' ? result.fields : [], questionIds: outcome.assessment.questions.map(question => question.id) };
  if (outcome.status !== 'assessed') return { status: 'not-applicable', reasonCode: 'source-not-assessed', path: 'outcome' };
  const assessment = outcome.assessment;
  if (assessment.destination.value !== config.destinationId || !config.defectClassificationIds.includes(assessment.classification.value)) {
    return { status: 'not-applicable', reasonCode: 'unsupported-route', path: 'outcome' };
  }
  if (result.status !== 'accepted') return result;
  const task = result.task;
  return { status: 'accepted', task, source: {
    contractVersion: RECEIVER_CONTRACT_VERSION, assessmentId: assessment.assessmentId, issueId: assessment.issueId,
    reportDigest: assessment.reportDigest, catalogId: assessment.catalogId, catalogVersion: assessment.catalogVersion, provenance: assessment.provenance,
  } };
}
