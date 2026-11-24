/**
 * T054 recovery discovery and routing helper (real-tier contract §(h), MERGER-001).
 *
 * Discovers isolated campaign/case stores or legacy base store matching a resume reference,
 * enforcing safe IDs, no escaping/symlinked storage roots, no ambiguous duplicates, and
 * delegating continuation decisions to the original owner's recoveryGate.
 */
import fs, { type Dirent, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { isSafeStorageId } from '../../../src/persistence/store.ts';
import { JOURNAL_OPERATION_PREFIX } from '../../../src/persistence/adapters/state-port-v02-operation-lookup.ts';
import { BASELINE_OPERATION_PREFIX } from '../../../src/persistence/adapters/baseline-evidence-store.ts';
import type { RecoveryDecision } from '../../../src/runtime/real-tier-recovery.ts';
import type { RealTierAssembly, RealTierResolution } from '../../../src/runtime/real-tier-assembly.ts';
import type { CampaignOptions } from './uc03-success-real-run.ts';
import { SAFE_ID } from './uc03-success-real-record.ts';

const OPERATION_HASH = /^[0-9a-f]{64}$/;

export interface ResolveRecoveryOptions {
  readonly options: CampaignOptions;
  readonly resolved: RealTierAssembly;
  readonly assembleRoot: (stateRoot: string) => RealTierResolution;
}

/** Check every child before reading it; checking the store alone does not exclude nested links. */
function unlinkedChildExists(root: string, path: string): boolean {
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    if (!part || part === '..') throw new Error('Invalid recovery child');
    current = join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) return false;
    if (stat.isSymbolicLink()) throw new Error('Linked recovery child');
  }
  return true;
}

function checkRecordPresence(root: string, resumeRef: string): 'present' | 'absent' | 'corrupt' {
  const storeDir = join(root, 'store');
  if (resumeRef.startsWith(JOURNAL_OPERATION_PREFIX)) {
    const operationId = resumeRef.slice(JOURNAL_OPERATION_PREFIX.length);
    const claimsDir = join(storeDir, 'claims');
    if (!unlinkedChildExists(root, claimsDir) || !fs.lstatSync(claimsDir).isDirectory()) return 'absent';
    let taskEntries: string[];
    try {
      taskEntries = readdirSync(claimsDir);
    } catch {
      return 'corrupt';
    }
    for (const taskId of taskEntries) {
      if (!isSafeStorageId(taskId)) continue;
      const claimPath = join(claimsDir, taskId, `${operationId}.json`);
      const opPath = join(claimsDir, taskId, 'v02', `operation-${operationId}.json`);
      for (const candidatePath of [claimPath, opPath]) {
        if (!unlinkedChildExists(root, candidatePath)) continue;
        try {
          const raw = readFileSync(candidatePath, 'utf8');
          const parsed: unknown = JSON.parse(raw);
          if (parsed === null || typeof parsed !== 'object') return 'corrupt';
          return 'present';
        } catch {
          return 'corrupt';
        }
      }
    }
    return 'absent';
  }

  if (resumeRef.startsWith(BASELINE_OPERATION_PREFIX)) {
    const baselineDir = join(storeDir, 'baseline-evidence');
    if (!unlinkedChildExists(root, baselineDir) || !fs.lstatSync(baselineDir).isDirectory()) return 'absent';
    let entries: string[];
    try {
      entries = readdirSync(baselineDir);
    } catch {
      return 'corrupt';
    }
    let matched = false;
    for (const keyHash of entries) {
      const recordPath = join(baselineDir, keyHash, 'record.json');
      const pendingPath = join(baselineDir, keyHash, 'record.pending');
      for (const candidatePath of [recordPath, pendingPath]) {
        if (!unlinkedChildExists(root, candidatePath)) continue;
        try {
          const raw = readFileSync(candidatePath, 'utf8');
          const parsed: unknown = JSON.parse(raw);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'corrupt';
          const rec = parsed as { operationRef?: unknown };
          if (typeof rec.operationRef !== 'string') return 'corrupt';
          if (!rec.operationRef.startsWith(BASELINE_OPERATION_PREFIX) || !OPERATION_HASH.test(rec.operationRef.slice(BASELINE_OPERATION_PREFIX.length))) {
            return 'corrupt';
          }
          if (rec.operationRef === resumeRef) matched = true;
        } catch {
          return 'corrupt';
        }
      }
    }
    return matched ? 'present' : 'absent';
  }

  return 'absent';
}

export async function resolveCampaignRecoveryDecision(opts: ResolveRecoveryOptions): Promise<RecoveryDecision> {
  const { options, resolved, assembleRoot } = opts;
  const resumeRef = options.resumeRef;
  if (typeof resumeRef !== 'string') return 'blocked';

  const isJournal = resumeRef.startsWith(JOURNAL_OPERATION_PREFIX);
  const isBaseline = resumeRef.startsWith(BASELINE_OPERATION_PREFIX);
  if (!isJournal && !isBaseline) return 'blocked';

  if (isJournal) {
    const opId = resumeRef.slice(JOURNAL_OPERATION_PREFIX.length);
    if (!isSafeStorageId(opId)) return 'blocked';
  } else {
    const hash = resumeRef.slice(BASELINE_OPERATION_PREFIX.length);
    if (!OPERATION_HASH.test(hash)) return 'blocked';
  }

  const baseStateRoot = options.stateRoot ?? resolved.profile?.stateRoot;
  if (baseStateRoot === undefined || !existsSync(baseStateRoot)) {
    return resolved.owners.recoveryGate.decide(resumeRef);
  }

  try {
    if (fs.lstatSync(baseStateRoot).isSymbolicLink()) return 'blocked';
  } catch {
    return 'blocked';
  }

  let realBase: string;
  try {
    realBase = realpathSync(baseStateRoot);
  } catch {
    return 'blocked';
  }

  const isContained = (dir: string): boolean => {
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) return false;
      const real = realpathSync(dir);
      return real === realBase || real.startsWith(realBase + sep);
    } catch {
      return false;
    }
  };

  const candidateRoots: string[] = [];
  const legacyStore = join(baseStateRoot, 'store');
  let legacyStat: ReturnType<typeof fs.lstatSync>;
  try {
    legacyStat = fs.lstatSync(legacyStore, { throwIfNoEntry: false });
  } catch {
    return 'blocked';
  }
  if (legacyStat?.isSymbolicLink()) return 'blocked';
  if (legacyStat?.isDirectory()) {
    if (!isContained(legacyStore)) return 'blocked';
    candidateRoots.push(baseStateRoot);
  }

  let campaignEntries: Dirent[];
  try {
    campaignEntries = readdirSync(baseStateRoot, { withFileTypes: true });
  } catch {
    return 'blocked';
  }

  for (const cEntry of campaignEntries) {
    if (cEntry.name === 'store' || cEntry.name === 'evidence' || cEntry.name.startsWith('.')) continue;
    const cPath = join(baseStateRoot, cEntry.name);
    if (!isContained(cPath)) return 'blocked';
    if (!cEntry.isDirectory() || !SAFE_ID.test(cEntry.name)) continue;

    let caseEntries: Dirent[];
    try {
      caseEntries = readdirSync(cPath, { withFileTypes: true });
    } catch {
      return 'blocked';
    }

    for (const caseEntry of caseEntries) {
      if (caseEntry.name.startsWith('.')) continue;
      const casePath = join(cPath, caseEntry.name);
      if (!isContained(casePath)) return 'blocked';
      if (!caseEntry.isDirectory() || !SAFE_ID.test(caseEntry.name)) continue;

      const storePath = join(casePath, 'store');
      let storeStat: ReturnType<typeof fs.lstatSync>;
      try {
        storeStat = fs.lstatSync(storePath, { throwIfNoEntry: false });
      } catch {
        return 'blocked';
      }
      if (storeStat?.isSymbolicLink()) return 'blocked';
      if (storeStat?.isDirectory()) {
        if (!isContained(storePath)) return 'blocked';
        candidateRoots.push(casePath);
      }
    }
  }

  const matchingRoots: string[] = [];
  for (const root of candidateRoots) {
    let status: ReturnType<typeof checkRecordPresence>;
    try {
      status = checkRecordPresence(root, resumeRef);
    } catch {
      // Translate inaccessible or linked owner storage to a refusal without exposing record content.
      return 'blocked';
    }
    if (status === 'corrupt') return 'blocked';
    if (status === 'present') matchingRoots.push(root);
  }

  if (matchingRoots.length > 1) return 'blocked';
  const [targetRoot] = matchingRoots;
  if (targetRoot !== undefined) {
    if (targetRoot === baseStateRoot) {
      return resolved.owners.recoveryGate.decide(resumeRef);
    }
    const targetAssembly = assembleRoot(targetRoot);
    if (targetAssembly.status !== 'assembly-ready') return 'blocked';
    return targetAssembly.owners.recoveryGate.decide(resumeRef);
  }

  return resolved.owners.recoveryGate.decide(resumeRef);
}
