/**
 * T023 — consumes an accepted UC-04 baseline evidence delivery (host-composition §3, "Baseline evidence").
 *
 * This adapter implements no storage. Every durable fact it returns comes from the injected owner
 * delivery: it validates the canonical candidate and its digest, forwards the request unchanged, and
 * validates the owner's reply. It never mints an evidence ID, invents an acknowledgement, or keeps
 * content it could serve in place of the owner.
 */
import { computeCanonicalSha256, computeCheckSetDigest, isCanonicalRelativePath, isProtectedPath, validateBaselineAdmission, validateCheckDefinition } from '../contracts/foundation/uc03.ts';
import { baselineEvidenceAcknowledgementMatches } from '../uc03/investigation-snapshot.ts';
import type { Baseline, CheckDefinition, PortProvenance } from '../contracts/foundation/uc03.ts';
import type { BaselineEvidenceAcknowledgement, BaselineEvidenceCandidate, BaselineEvidenceWriteRequest } from '../uc03/investigation-types.ts';
import type { UC03ProductionBaselinePort } from '../uc03/graph-types-v02.ts';

/** Owner-supplied write outcome. Only `durable` may become a returned acknowledgement. */
export type OwnerBaselineWriteOutcome =
  { readonly outcome: 'durable'; readonly acknowledgement: unknown } | { readonly outcome: 'uncertain'; readonly operationRef: string } | { readonly outcome: 'denied'; readonly reason: string };

export interface OwnerBaselineLookupRequest {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly evidenceId: string;
}

/** Owner-supplied lookup outcome. `missing` is the only way this adapter reports absence. */
export type OwnerBaselineLoadOutcome =
  { readonly outcome: 'found'; readonly content: unknown; readonly acknowledgement: unknown } | { readonly outcome: 'missing' } | { readonly outcome: 'uncertain'; readonly reason: string };

/** The accepted UC-04 public delivery this adapter consumes. It is the storage authority. */
export interface OwnerBaselineEvidenceDelivery {
  readonly provenance: PortProvenance;
  persist(request: BaselineEvidenceWriteRequest): Promise<OwnerBaselineWriteOutcome> | OwnerBaselineWriteOutcome;
  /** Production continuation requires lookup; when omitted, every load refuses instead of guessing. */
  load?(request: OwnerBaselineLookupRequest): Promise<OwnerBaselineLoadOutcome> | OwnerBaselineLoadOutcome;
}

const CANDIDATE_KEYS = [
  'taskId',
  'workspaceId',
  'repositoryId',
  'acceptanceCriteria',
  'criteriaDigest',
  'requiredChecks',
  'expectedPassingCheckIds',
  'reproductionCheckId',
  'expectedTestFiles',
  'repositorySnapshotDigest',
  'checkSetDigest',
  'reproductionFailureSignature',
  'checkResults',
  'testProtectionDigest',
].sort();

type CandidateValidation = { readonly ok: true; readonly content: BaselineEvidenceCandidate; readonly contentDigest: string } | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function blocked(code: string, detail: string): Error {
  return new Error(`${code}: ${detail}`);
}

/**
 * Canonical candidate validation. State-bound cross-checks stay with the consumer
 * (`validateBaselineEvidenceCandidate`); this checks the candidate against itself so a forged or
 * partial payload never reaches the owner.
 */
function validateCandidate(input: unknown): CandidateValidation {
  if (!isRecord(input)) return { ok: false, reason: 'Baseline evidence candidate must be an object' };
  const keys = Reflect.ownKeys(input).map(String).sort();
  if (keys.length !== CANDIDATE_KEYS.length || keys.some((key, index) => key !== CANDIDATE_KEYS[index])) {
    return { ok: false, reason: 'Baseline evidence candidate fields are incomplete or unexpected' };
  }
  const content = input as unknown as BaselineEvidenceCandidate;

  for (const field of ['taskId', 'workspaceId', 'repositoryId', 'criteriaDigest', 'repositorySnapshotDigest', 'checkSetDigest', 'reproductionFailureSignature', 'testProtectionDigest'] as const) {
    const value: unknown = content[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return { ok: false, reason: `Baseline evidence candidate ${field} must be a non-empty string` };
    }
  }

  const criteria = content.acceptanceCriteria;
  if (!Array.isArray(criteria) || criteria.length === 0 || criteria.some(item => typeof item !== 'string' || item.trim().length === 0)) {
    return { ok: false, reason: 'Baseline evidence candidate acceptanceCriteria must be a non-empty string array' };
  }
  if (content.criteriaDigest !== computeCanonicalSha256(criteria)) {
    return { ok: false, reason: 'Baseline evidence candidate criteriaDigest does not match its acceptance criteria' };
  }

  const rawChecks = content.requiredChecks;
  if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
    return { ok: false, reason: 'Baseline evidence candidate requiredChecks must be a non-empty array' };
  }
  const checks: CheckDefinition[] = [];
  const checkIds = new Set<string>();
  for (let index = 0; index < rawChecks.length; index++) {
    const errors: { readonly path: string; readonly message: string; readonly code: string }[] = [];
    const check = validateCheckDefinition(rawChecks[index], `requiredChecks[${index}]`, errors);
    if (!check) return { ok: false, reason: `Baseline evidence candidate requiredChecks[${index}] is invalid` };
    if (checkIds.has(check.checkId)) return { ok: false, reason: `Baseline evidence candidate has a duplicate check ID '${check.checkId}'` };
    checkIds.add(check.checkId);
    checks.push(check);
  }
  if (content.checkSetDigest !== computeCheckSetDigest(checks)) {
    return { ok: false, reason: 'Baseline evidence candidate checkSetDigest does not match its required checks' };
  }

  const reproductionChecks = checks.filter(check => check.purpose === 'reproduction');
  const reproduction = reproductionChecks[0];
  if (reproductionChecks.length !== 1 || !reproduction || content.reproductionCheckId !== reproduction.checkId) {
    return { ok: false, reason: 'Baseline evidence candidate must name exactly one reproduction check' };
  }

  const expectedPassingCheckIds = checks.filter(check => check.checkId !== reproduction.checkId).map(check => check.checkId);
  if (!isStringArray(content.expectedPassingCheckIds) || computeCanonicalSha256(content.expectedPassingCheckIds) !== computeCanonicalSha256(expectedPassingCheckIds)) {
    return { ok: false, reason: 'Baseline evidence candidate expectedPassingCheckIds does not match the required check set' };
  }

  const testFiles = content.expectedTestFiles;
  if (!isStringArray(testFiles) || testFiles.length === 0) {
    return { ok: false, reason: 'Baseline evidence candidate expectedTestFiles must be a non-empty string array' };
  }
  const seenPaths = new Set<string>();
  for (const filePath of testFiles) {
    if (!isCanonicalRelativePath(filePath) || isProtectedPath(filePath)) {
      return { ok: false, reason: `Baseline evidence candidate has an invalid test path '${filePath}'` };
    }
    const lower = filePath.toLowerCase();
    if (seenPaths.has(lower)) return { ok: false, reason: `Baseline evidence candidate has a duplicate test path '${filePath}'` };
    seenPaths.add(lower);
  }

  const results = content.checkResults;
  if (!Array.isArray(results) || results.length !== checks.length) {
    return { ok: false, reason: 'Baseline evidence candidate checkResults do not match the required check set' };
  }
  for (let index = 0; index < checks.length; index++) {
    const result: unknown = results[index];
    if (!isRecord(result) || result['checkId'] !== checks[index]?.checkId) {
      return { ok: false, reason: 'Baseline evidence candidate checkResults do not match the required check set' };
    }
  }

  const provisional: Baseline = {
    evidenceId: 'pending-baseline-evidence',
    repositorySnapshotDigest: content.repositorySnapshotDigest,
    checkSetDigest: content.checkSetDigest,
    reproductionFailureSignature: content.reproductionFailureSignature,
    checkResults: content.checkResults,
    testProtectionDigest: content.testProtectionDigest,
  };
  const admission = validateBaselineAdmission(provisional, {
    expectedEvidenceId: 'pending-baseline-evidence',
    expectedRepositorySnapshotDigest: content.repositorySnapshotDigest,
    expectedCheckSetDigest: content.checkSetDigest,
    expectedTestProtectionDigest: content.testProtectionDigest,
    expectedReproductionCheckId: content.reproductionCheckId,
    expectedPassingCheckIds: content.expectedPassingCheckIds,
  });
  if (!admission.ok) {
    return { ok: false, reason: `Baseline admission failed: ${admission.errors.map(error => error.message).join(', ')}` };
  }

  return { ok: true, content, contentDigest: computeCanonicalSha256(content) };
}

/**
 * Wraps an accepted UC-04 delivery as the production baseline port.
 *
 * The identity→contentDigest map is a refusal guard, not storage: it can never serve evidence, and
 * the owner remains the cross-process authority for duplicate IDs. Within one adapter it blocks a
 * same-ID/different-content write or lookup.
 */
export function createBaselineEvidenceAdapter(delivery: OwnerBaselineEvidenceDelivery): UC03ProductionBaselinePort {
  const boundEvidence = new Map<string, string>();

  return {
    provenance: delivery.provenance,

    async persistBaselineEvidence(request: BaselineEvidenceWriteRequest): Promise<BaselineEvidenceAcknowledgement> {
      const validation = validateCandidate(request.content);
      if (!validation.ok) throw blocked('BASELINE_EVIDENCE_INVALID_CANDIDATE', validation.reason);
      if (request.contentDigest !== validation.contentDigest) {
        throw blocked('BASELINE_EVIDENCE_DIGEST_MISMATCH', `request contentDigest does not match the canonical candidate digest ${validation.contentDigest}`);
      }

      const outcome: unknown = await delivery.persist(request);
      if (!isRecord(outcome)) throw blocked('BASELINE_EVIDENCE_WRITE_OUTCOME_INVALID', 'owner write outcome is not a typed object');
      const kind = outcome['outcome'];
      if (kind === 'uncertain') {
        const operationRef = outcome['operationRef'];
        throw blocked('BASELINE_EVIDENCE_WRITE_UNCERTAIN', `owner durability is unknown${typeof operationRef === 'string' ? ` (operation ${operationRef})` : ''}`);
      }
      if (kind === 'denied') {
        const reason = outcome['reason'];
        throw blocked('BASELINE_EVIDENCE_WRITE_DENIED', typeof reason === 'string' ? reason : 'owner denied the write');
      }
      if (kind !== 'durable') throw blocked('BASELINE_EVIDENCE_WRITE_OUTCOME_INVALID', 'owner write outcome is not durable, uncertain, or denied');

      const acknowledgement = outcome['acknowledgement'];
      if (!baselineEvidenceAcknowledgementMatches(acknowledgement, request)) {
        throw blocked('BASELINE_EVIDENCE_ACKNOWLEDGEMENT_MISMATCH', 'owner acknowledgement does not match the written candidate');
      }
      const prior = boundEvidence.get(acknowledgement.evidenceId);
      if (prior !== undefined && prior !== acknowledgement.contentDigest) {
        throw blocked('BASELINE_EVIDENCE_CONFLICT', `evidence ID '${acknowledgement.evidenceId}' is already bound to different content`);
      }
      boundEvidence.set(acknowledgement.evidenceId, acknowledgement.contentDigest);
      return acknowledgement;
    },

    async loadBaselineEvidence(
      taskId: string,
      workspaceId: string,
      repositoryId: string,
      evidenceId: string,
    ): Promise<{ readonly content: BaselineEvidenceCandidate; readonly acknowledgement: BaselineEvidenceAcknowledgement } | null> {
      if (typeof delivery.load !== 'function') throw blocked('BASELINE_EVIDENCE_LOOKUP_UNAVAILABLE', 'the accepted owner delivery provides no baseline lookup');

      const outcome: unknown = await delivery.load({ taskId, workspaceId, repositoryId, evidenceId });
      if (!isRecord(outcome)) throw blocked('BASELINE_EVIDENCE_LOOKUP_INVALID', 'owner lookup outcome is not a typed object');
      const kind = outcome['outcome'];
      if (kind === 'missing') return null;
      if (kind === 'uncertain') {
        const reason = outcome['reason'];
        throw blocked('BASELINE_EVIDENCE_LOOKUP_UNCERTAIN', typeof reason === 'string' ? reason : 'owner lookup is uncertain');
      }
      if (kind !== 'found') throw blocked('BASELINE_EVIDENCE_LOOKUP_INVALID', 'owner lookup outcome is not found, missing, or uncertain');

      const validation = validateCandidate(outcome['content']);
      if (!validation.ok) throw blocked('BASELINE_EVIDENCE_LOOKUP_INVALID', validation.reason);
      const content = validation.content;
      if (content.taskId !== taskId || content.workspaceId !== workspaceId || content.repositoryId !== repositoryId) {
        throw blocked('BASELINE_EVIDENCE_LOOKUP_MISMATCH', 'owner lookup returned content for a different task, workspace, or repository');
      }

      const request: BaselineEvidenceWriteRequest = { content, contentDigest: validation.contentDigest };
      const acknowledgement = outcome['acknowledgement'];
      if (!baselineEvidenceAcknowledgementMatches(acknowledgement, request)) {
        throw blocked('BASELINE_EVIDENCE_ACKNOWLEDGEMENT_MISMATCH', 'owner lookup acknowledgement does not match the returned content');
      }
      if (acknowledgement.evidenceId !== evidenceId) {
        throw blocked('BASELINE_EVIDENCE_ACKNOWLEDGEMENT_MISMATCH', `owner lookup returned evidence '${acknowledgement.evidenceId}' for requested '${evidenceId}'`);
      }
      const prior = boundEvidence.get(evidenceId);
      if (prior !== undefined && prior !== acknowledgement.contentDigest) {
        throw blocked('BASELINE_EVIDENCE_CONFLICT', `evidence ID '${evidenceId}' is already bound to different content`);
      }
      boundEvidence.set(evidenceId, acknowledgement.contentDigest);
      return { content, acknowledgement };
    },
  };
}
