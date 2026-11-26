/**
 * UC-04 Durable Review Evidence Store supplement (ReviewEvidencePortV1).
 *
 * Implements persistent disk storage for UC-06 review observations, supporting
 * atomic record commits, candidate discovery indexes, and recovery across process restarts.
 * Owned by UC-04 (Thanh Tan).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  ReviewAuthorityV1,
  ReviewEvidencePortV1,
  PersistReviewObservationRequestV1,
  PersistReviewObservationResultV1,
  LoadReviewObservationRequestV1,
  LoadReviewObservationResultV1,
  RecoverReviewObservationRequestV1,
  RecoverReviewObservationResultV1,
  ReviewEvidenceAckV1,
  ReviewEvidenceFoundV1,
  ReviewObservationV1,
} from '../../contracts/review.ts';
import { validatePersistReviewObservationRequest, validateLoadReviewObservationRequest, validateRecoverReviewObservationRequest } from '../../uc06/validation.ts';

const ROOT_DIR = 'review-evidence';
const RECORD_DIR = 'records';
const DISCOVERY_DIR = 'discovery';
const KEYS_DIR = 'idempotency-keys';

interface StoredObservationRecord {
  readonly recordVersion: number;
  readonly observation: PersistReviewObservationRequestV1['observation'];
  readonly ack: ReviewEvidenceAckV1;
}

interface DiscoveryIndexRecord {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly headRevisionDigest: string;
  readonly diffDigest: string;
  readonly observationDigest: string;
  readonly providerRequestId: string | null;
  readonly timestamp: number;
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function candidateKey(taskId: string, workspaceId: string, repositoryId: string, headRevisionDigest: string, diffDigest: string): string {
  return createHash('sha256').update(JSON.stringify({ taskId, workspaceId, repositoryId, headRevisionDigest, diffDigest })).digest('hex');
}

function writeAtomic(targetPath: string, content: string): void {
  const pendingFile = `${targetPath}.${process.pid}.pending`;
  writeFileSync(pendingFile, content, 'utf8');
  renameSync(pendingFile, targetPath);
}

function hasMatchingAuthority(actual: ReviewObservationV1['authority'], expected: ReviewAuthorityV1): boolean {
  return (
    actual.taskStateVersion === expected.taskStateVersion &&
    actual.controlVersion === expected.controlVersion &&
    actual.epoch === expected.epoch &&
    actual.decisionAuthorityGeneration === expected.decisionAuthorityGeneration &&
    actual.planDecisionRef === expected.planDecisionRef &&
    actual.planBindingDigest === expected.planBindingDigest
  );
}

export class DurableReviewEvidenceStore implements ReviewEvidencePortV1 {
  readonly reviewEvidenceApiVersion = 'uc06-review-evidence/1' as const;
  readonly provenance = 'real' as const;
  readonly baseDir: string;
  private recordCounter = 0;

  constructor(baseDir: string) {
    this.baseDir = join(baseDir, ROOT_DIR);
    this.ensureDirs();
    this.initCounter();
  }

  private ensureDirs(): void {
    const records = join(this.baseDir, RECORD_DIR);
    const discovery = join(this.baseDir, DISCOVERY_DIR);
    const keys = join(this.baseDir, KEYS_DIR);
    if (!existsSync(records)) mkdirSync(records, { recursive: true });
    if (!existsSync(discovery)) mkdirSync(discovery, { recursive: true });
    if (!existsSync(keys)) mkdirSync(keys, { recursive: true });
  }

  private initCounter(): void {
    const recordsDir = join(this.baseDir, RECORD_DIR);
    if (!existsSync(recordsDir)) return;
    const files = readdirSync(recordsDir);
    this.recordCounter = files.filter(f => f.endsWith('.json')).length;
  }

  async persistObservation(request: PersistReviewObservationRequestV1): Promise<PersistReviewObservationResultV1> {
    const valid = validatePersistReviewObservationRequest(request);
    if (!valid.ok) {
      return { outcome: 'denied', reasonCode: 'MODEL_OUTPUT_INVALID' };
    }

    const { observation, observationDigest, idempotencyKey } = request;
    const b = observation.binding;

    const keyFile = join(this.baseDir, KEYS_DIR, `${safeId(idempotencyKey)}.json`);
    if (existsSync(keyFile)) {
      const priorDigest = readFileSync(keyFile, 'utf8').trim();
      if (priorDigest !== observationDigest) {
        return { outcome: 'conflict', reasonCode: 'MODEL_OUTPUT_INVALID' };
      }
      const existingFile = join(this.baseDir, RECORD_DIR, `${safeId(observationDigest)}.json`);
      if (existsSync(existingFile)) {
        const stored = JSON.parse(readFileSync(existingFile, 'utf8')) as StoredObservationRecord;
        return { outcome: 'acknowledged', ack: stored.ack };
      }
    }

    this.recordCounter += 1;
    const storeRecordVersion = this.recordCounter;
    const receiptId = `review-receipt-${storeRecordVersion}`;

    const ack: ReviewEvidenceAckV1 = {
      schemaVersion: 'uc06-review-evidence/1',
      receiptId,
      taskId: b.taskId,
      runId: b.runId,
      repositoryId: b.repositoryId,
      workspaceId: b.workspaceId,
      headRevisionDigest: b.headRevisionDigest,
      diffDigest: b.diffDigest,
      contextDigest: observation.contextDigest,
      providerRequestId: observation.providerRequestId,
      observationDigest,
      storeRecordVersion,
      committed: true,
    };

    const record: StoredObservationRecord = {
      recordVersion: storeRecordVersion,
      observation,
      ack,
    };

    const recordFile = join(this.baseDir, RECORD_DIR, `${safeId(observationDigest)}.json`);
    writeAtomic(recordFile, JSON.stringify(record, null, 2));

    const cKey = candidateKey(b.taskId, b.workspaceId, b.repositoryId, b.headRevisionDigest, b.diffDigest);
    const discoveryRecord: DiscoveryIndexRecord = {
      taskId: b.taskId,
      workspaceId: b.workspaceId,
      repositoryId: b.repositoryId,
      headRevisionDigest: b.headRevisionDigest,
      diffDigest: b.diffDigest,
      observationDigest,
      providerRequestId: observation.providerRequestId,
      timestamp: Date.now(),
    };
    const discoveryFile = join(this.baseDir, DISCOVERY_DIR, `${cKey}.json`);
    writeAtomic(discoveryFile, JSON.stringify(discoveryRecord, null, 2));

    writeAtomic(keyFile, observationDigest);

    return { outcome: 'acknowledged', ack };
  }

  async loadObservation(request: LoadReviewObservationRequestV1): Promise<LoadReviewObservationResultV1> {
    const valid = validateLoadReviewObservationRequest(request);
    if (!valid.ok) {
      return { outcome: 'denied', reasonCode: 'BINDING_STALE' };
    }

    const recordFile = join(this.baseDir, RECORD_DIR, `${safeId(request.observationDigest)}.json`);
    if (!existsSync(recordFile)) {
      return { outcome: 'missing' };
    }

    const record = JSON.parse(readFileSync(recordFile, 'utf8')) as StoredObservationRecord;
    const { ack, observation } = record;

    if (
      ack.taskId !== request.taskId ||
      ack.runId !== request.runId ||
      ack.providerRequestId !== request.providerRequestId ||
      ack.contextDigest !== request.contextDigest ||
      !hasMatchingAuthority(observation.authority, request.expectedAuthority)
    ) {
      return { outcome: 'denied', reasonCode: 'BINDING_STALE' };
    }

    const found: ReviewEvidenceFoundV1 = {
      outcome: 'found',
      observation,
      ack,
    };
    return found;
  }

  async recoverObservation(request: RecoverReviewObservationRequestV1): Promise<RecoverReviewObservationResultV1> {
    const valid = validateRecoverReviewObservationRequest(request);
    if (!valid.ok) {
      return { outcome: 'denied', reasonCode: 'BINDING_STALE' };
    }

    const cKey = candidateKey(request.taskId, request.workspaceId, request.repositoryId, request.headRevisionDigest, request.diffDigest);
    const discoveryFile = join(this.baseDir, DISCOVERY_DIR, `${cKey}.json`);
    if (!existsSync(discoveryFile)) {
      return { outcome: 'missing' };
    }

    const discovery = JSON.parse(readFileSync(discoveryFile, 'utf8')) as DiscoveryIndexRecord;
    const recordFile = join(this.baseDir, RECORD_DIR, `${safeId(discovery.observationDigest)}.json`);
    if (!existsSync(recordFile)) {
      return { outcome: 'missing' };
    }

    const record = JSON.parse(readFileSync(recordFile, 'utf8')) as StoredObservationRecord;
    if (!hasMatchingAuthority(record.observation.authority, request.expectedAuthority)) {
      return { outcome: 'denied', reasonCode: 'BINDING_STALE' };
    }

    const found: ReviewEvidenceFoundV1 = {
      outcome: 'found',
      observation: record.observation,
      ack: record.ack,
    };
    return found;
  }
}

export function createDurableReviewEvidenceStore(baseDir: string): ReviewEvidencePortV1 {
  return new DurableReviewEvidenceStore(baseDir);
}
