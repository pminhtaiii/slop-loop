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
  const outcome = parsed.value;
  if (outcome.status === 'needs-info') return { status: 'needs-info', fields: [], questionIds: outcome.assessment.questions.map(question => question.id) };
  if (outcome.status !== 'assessed') return { status: 'not-applicable', reasonCode: 'source-not-assessed', path: 'outcome' };
  const assessment = outcome.assessment;
  if (assessment.destination.value !== config.destinationId || !config.defectClassificationIds.includes(assessment.classification.value)) {
    return { status: 'not-applicable', reasonCode: 'unsupported-route', path: 'outcome' };
  }
  const result = validateTaskData(value['suppliedBugTask']);
  if (result.status !== 'accepted') return result;
  const task = result.task;
  const bindings = [
    ['taskId', task.taskId, intake.value.invocation.taskId],
    ['repositoryId', task.repositoryId, intake.value.context.repositoryId],
    ['configId', task.configId, intake.value.context.configId],
    ['configVersion', task.configVersion, intake.value.context.configVersion],
  ] as const;
  for (const [path, candidate, expected] of bindings) {
    if (candidate !== expected) return { status: 'conflict', reasonCode: 'task-binding-mismatch', path };
  }
  const digest = /^(?:sha256:)?([a-f0-9]{64})$/u.exec(task.initialRevisionDigest)?.[1];
  if (!digest) return { status: 'invalid-input', reasonCode: 'invalid-revision-digest', path: 'initialRevisionDigest' };
  if (digest !== assessment.repositorySnapshotDigest) return { status: 'conflict', reasonCode: 'task-binding-mismatch', path: 'initialRevisionDigest' };
  return { status: 'accepted', task, source: {
    contractVersion: RECEIVER_CONTRACT_VERSION, assessmentId: assessment.assessmentId, issueId: assessment.issueId,
    reportDigest: assessment.reportDigest, catalogId: assessment.catalogId, catalogVersion: assessment.catalogVersion, provenance: assessment.provenance,
  } };
}
