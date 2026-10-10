import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isPreparationAction } from "./preparation.js";
import { parseLockedGraph, type LockedGraph } from "./downloads.js";
import { verifyPackageTarball } from "./packagecontent.js";
import type { ValidatedDependencyTree } from "./dependencytree.js";
import { normalizePnpmOutput } from "./normalization.js";
import {
  freezeAndSeal,
  type FrozenArchive,
  type PreparationProducer,
  type ProducerTransferPort,
} from "./frozentransfer.js";
import {
  offlineScriptPolicyIdentity,
  planOfflineScripts,
  type ExactScriptApproval,
  type OfflineScriptInstruction,
} from "./offlinescripts.js";
import {
  PreparationAdmissionUncertain,
  type PreparationStorageLease,
} from "./preparationstorage.js";
import type { PreparedImageRecord } from "./types.js";

/** External stage seam. Production composition must supply concrete owned Docker operations. */
export interface PreparationRuntime extends ProducerTransferPort {
  fetch(
    actionId: string,
    graph: LockedGraph,
    storage: PreparationStorageLease,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, Buffer>>;
  materialize(
    actionId: string,
    graph: LockedGraph,
    signal: AbortSignal,
  ): Promise<PreparationProducer>;
  importWithoutCAS(
    actionId: string,
    archive: FrozenArchive,
    tree: ValidatedDependencyTree,
    signal: AbortSignal,
    normalizedTar: Buffer,
  ): Promise<PreparationProducer>;
  runScripts(
    producer: PreparationProducer,
    instructions: readonly OfflineScriptInstruction[],
    signal: AbortSignal,
  ): Promise<void>;
  buildCandidate(
    archive: FrozenArchive,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  cleanup(actionId: string): Promise<"CONFIRMED" | "UNCERTAIN">;
}
const configurations = new WeakSet<object>();
export class PreparationConfiguration {
  constructor(
    readonly admission: (workspaceId: string) => Promise<PreparationStorageLease>,
    readonly runtime: PreparationRuntime,
    readonly scriptPolicy: readonly ExactScriptApproval[],
    readonly commitRecord: (record: PreparedImageRecord) => Promise<() => Promise<void>>,
    readonly privateRelayRoot?: string,
    readonly onCommitFailure?: (record: PreparedImageRecord) => Promise<"CONFIRMED" | "UNCERTAIN">,
  ) {
    this.scriptPolicy = Object.freeze(
      structuredClone(scriptPolicy).map((entry) => Object.freeze(entry)),
    );
    configurations.add(this);
    Object.freeze(this);
  }
}
export type PreparationResult =
  | { readonly status: "READY"; readonly image: PreparedImageRecord }
  | {
      readonly status: "BLOCKED" | "FAILED" | "CANCELLED";
      readonly reason: string;
      readonly cleanup: "CONFIRMED" | "UNCERTAIN";
    };

const candidateSchema = z.strictObject({
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  architecture: z.literal("linux-x64"),
  baseImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  recipeHash: z.string().regex(/^[a-f0-9]{64}$/u),
  prerequisiteOutput: z.literal("slop-loop-prerequisites:PASS"),
});

/** Single developer-only journey; no model tool registration or host execution fallback. */
export async function prepareVerification(
  confirmedDeveloperAction: unknown,
  trustedConfiguration: unknown,
  abortSignal: AbortSignal,
): Promise<PreparationResult> {
  if (
    typeof confirmedDeveloperAction !== "object" ||
    confirmedDeveloperAction === null ||
    !("action" in confirmedDeveloperAction) ||
    !("receipt" in confirmedDeveloperAction) ||
    !isPreparationAction(confirmedDeveloperAction.action) ||
    typeof trustedConfiguration !== "object" ||
    trustedConfiguration === null ||
    !configurations.has(trustedConfiguration)
  )
    return {
      status: "BLOCKED",
      reason: "Trusted preparation authority unavailable",
      cleanup: "CONFIRMED",
    };
  const configuration = trustedConfiguration as PreparationConfiguration;
  const action = confirmedDeveloperAction.action;
  const actionId = randomUUID();
  const signal = AbortSignal.any([
    abortSignal,
    AbortSignal.timeout(Math.max(1, Math.min(15 * 60_000, action.deadlineAt - Date.now()))),
  ]);
  let lease: PreparationStorageLease | undefined;
  const archives: FrozenArchive[] = [];
  let effectsStarted = false;
  let result: PreparationResult;
  let pending: PreparedImageRecord | undefined;
  try {
    signal.throwIfAborted();
    const inputs = action.consume(confirmedDeveloperAction.receipt);
    if (inputs.inputs.scriptPolicyId !== offlineScriptPolicyIdentity(configuration.scriptPolicy))
      throw new Error("Confirmed script policy changed");
    const graph = parseLockedGraph(
      inputs.lockfile.toString("utf8"),
      inputs.manifest.toString("utf8"),
    );
    lease = await configuration.admission(action.workspaceId);
    signal.throwIfAborted();
    action.revalidate();
    await lease.revalidate();
    effectsStarted = true;
    const downloaded = await configuration.runtime.fetch(actionId, graph, lease, signal);
    if (downloaded.size !== graph.artifacts.length)
      throw new Error("Observed artifact graph mismatch");
    const packages = [];
    let compressedBytes = 0;
    for (const artifact of graph.artifacts) {
      signal.throwIfAborted();
      const bytes = downloaded.get(`${artifact.name}@${artifact.version}`);
      if (!bytes) throw new Error("Observed artifact graph mismatch");
      compressedBytes += bytes.length;
      if (compressedBytes > 2 * 1024 ** 3) throw new Error("Preparation download limit exceeded");
      lease.account("download", bytes.length);
      packages.push(await verifyPackageTarball(artifact, bytes));
    }
    const scripts = planOfflineScripts(graph, packages, configuration.scriptPolicy);
    await lease.revalidate();
    action.revalidate();
    const producer = await configuration.runtime.materialize(actionId, graph, signal);
    if (producer.actionId !== actionId) throw new Error("Preparation producer mismatch");
    const initial = await freezeAndSeal(
      producer,
      configuration.runtime,
      signal,
      configuration.privateRelayRoot,
    );
    archives.push(initial);
    lease.account("transfer", initial.bytes);
    const normalized = await normalizePnpmOutput(graph, packages, initial.open());
    if (normalized.sourceContentId !== initial.contentId)
      throw new Error("Frozen archive content changed");
    await lease.revalidate();
    signal.throwIfAborted();
    const recipient = await configuration.runtime.importWithoutCAS(
      actionId,
      initial,
      normalized.tree,
      signal,
      normalized.tar,
    );
    if (recipient.actionId !== actionId || recipient.resourceId === producer.resourceId)
      throw new Error("CAS-free recipient identity unavailable");
    await configuration.runtime.runScripts(recipient, scripts, signal);
    signal.throwIfAborted();
    const output = await freezeAndSeal(
      recipient,
      configuration.runtime,
      signal,
      configuration.privateRelayRoot,
    );
    archives.push(output);
    lease.account("transfer", output.bytes);
    await lease.revalidate();
    action.revalidate();
    const candidate = candidateSchema.parse(
      await configuration.runtime.buildCandidate(output, inputs.fingerprint, signal),
    );
    if (
      candidate.fingerprint !== inputs.fingerprint ||
      candidate.baseImageDigest !== inputs.inputs.baseImageDigest ||
      candidate.recipeHash !== inputs.inputs.recipeHash
    )
      throw new Error("Prepared image binding mismatch");
    pending = Object.freeze({
      imageId: candidate.imageId,
      fingerprint: candidate.fingerprint,
      architecture: candidate.architecture,
      status: "READY",
    });
    result = { status: "BLOCKED", reason: "Preparation settlement pending", cleanup: "UNCERTAIN" };
  } catch (error) {
    result = {
      status: signal.aborted ? "CANCELLED" : effectsStarted ? "FAILED" : "BLOCKED",
      reason: "Preparation did not establish complete trusted evidence",
      cleanup: error instanceof PreparationAdmissionUncertain ? "UNCERTAIN" : "CONFIRMED",
    };
  }
  let cleanup: "CONFIRMED" | "UNCERTAIN" = "CONFIRMED";
  if (result.cleanup === "UNCERTAIN" && !pending) cleanup = "UNCERTAIN";
  if (effectsStarted) {
    try {
      cleanup = await configuration.runtime.cleanup(actionId);
    } catch {
      cleanup = "UNCERTAIN";
    }
  }
  for (const archive of archives) {
    try {
      archive.dispose();
    } catch {
      cleanup = "UNCERTAIN";
    }
  }
  if (cleanup === "UNCERTAIN")
    return { status: "BLOCKED", reason: "Preparation cleanup unconfirmed", cleanup };
  if (pending && !signal.aborted) {
    let rollback: (() => Promise<void>) | undefined;
    try {
      action.revalidate();
      await lease?.revalidate();
      signal.throwIfAborted();
      rollback = await configuration.commitRecord(pending);
      signal.throwIfAborted();
      lease?.settle("CONFIRMED");
      return { status: "READY", image: pending };
    } catch {
      if (rollback) {
        try {
          await rollback();
        } catch {
          return {
            status: "BLOCKED",
            reason: "Prepared record rollback unconfirmed",
            cleanup: "UNCERTAIN",
          };
        }
      }
      result = { status: "FAILED", reason: "Prepared image publication failed", cleanup };
    }
  }
  if (pending) {
    try {
      cleanup = (await configuration.onCommitFailure?.(pending)) ?? "UNCERTAIN";
    } catch {
      cleanup = "UNCERTAIN";
    }
    if (cleanup !== "CONFIRMED")
      return { status: "BLOCKED", reason: "Unpublished image cleanup unconfirmed", cleanup };
    if (signal.aborted)
      result = { status: "CANCELLED", reason: "Preparation cancelled before publication", cleanup };
  }
  try {
    lease?.settle("CONFIRMED");
  } catch {
    return {
      status: "BLOCKED",
      reason: "Preparation reservation ownership unconfirmed",
      cleanup: "UNCERTAIN",
    };
  }
  return { ...result, cleanup };
}
