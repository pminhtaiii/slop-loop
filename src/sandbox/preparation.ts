import { createHash, randomUUID } from "node:crypto";
import { WorkspaceBoundary } from "../workspace/boundary.js";
import { verifyWorkspace } from "../workspace/admission.js";
import type { SelectedWorkspace } from "../workspace/types.js";
import { z } from "zod";
import { createPreparationFingerprint, type PreparationInputs } from "./config.js";
import type { PreparedImageRecord } from "./types.js";

export { createPreparationFingerprint };
export type { PreparationInputs, PreparedImageRecord };

export type PreparationPolicy = Omit<PreparationInputs, "manifestHash" | "lockfileHash">;
const policySchema = z.strictObject({
  managerConfigHash: z.string().regex(/^[a-f0-9]{64}$/u),
  scriptPolicyId: z.string().regex(/^[a-f0-9]{64}$/u),
  nodeVersion: z.literal("24.14.0"),
  pnpmVersion: z.literal("12.5.1"),
  architecture: z.literal("linux-x64"),
  baseImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  recipeHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
const issuedActions = new WeakSet<object>();
export function isPreparationAction(
  value: unknown,
): value is ReturnType<typeof createPreparationAction> {
  return typeof value === "object" && value !== null && issuedActions.has(value);
}

/** Construction and confirmation belong only to the trusted developer helper, never a tool. */
export function createPreparationAction(workspace: SelectedWorkspace, policy: PreparationPolicy) {
  const frozenPolicy = Object.freeze(policySchema.parse(policy));
  const boundary = new WorkspaceBoundary();
  const readInputs = () => {
    if (!verifyWorkspace(workspace)) throw new Error("Preparation workspace unavailable");
    const read = (name: string) => {
      const opened = boundary.openSnapshotRead(workspace.workspaceId, name);
      if (opened.kind !== "OPENED") throw new Error("Preparation path authority unavailable");
      try {
        if (opened.target.canonicalPath !== name) throw new Error("Preparation input alias denied");
        const metadata = opened.target.metadata?.();
        if (!metadata || metadata.size > 16 * 1024 * 1024)
          throw new Error("Preparation input limit exceeded");
        const bytes = opened.target.read(metadata.size);
        if (bytes.length !== metadata.size) throw new Error("Preparation inputs changed");
        return bytes;
      } finally {
        opened.target.close();
      }
    };
    const manifest = read("package.json");
    const lockfile = read("pnpm-lock.yaml");
    if (!verifyWorkspace(workspace)) throw new Error("Preparation workspace unavailable");
    const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    const inputs = Object.freeze({
      ...frozenPolicy,
      manifestHash: hash(manifest),
      lockfileHash: hash(lockfile),
    });
    return { inputs, manifest, lockfile, fingerprint: createPreparationFingerprint(inputs) };
  };
  const initial = readInputs();
  const deadlineAt = Date.now() + 15 * 60_000;
  const challenge = `prepare ${workspace.workspaceId} ${initial.fingerprint} ${randomUUID()}`;
  const receipts = new WeakSet<object>();
  let confirmed = false;
  const current = () => {
    if (Date.now() >= deadlineAt) throw new Error("Preparation confirmation expired");
    const observed = readInputs();
    if (observed.fingerprint !== initial.fingerprint) throw new Error("Preparation inputs changed");
    return observed;
  };
  const action = Object.freeze({
    challenge,
    deadlineAt,
    workspaceId: workspace.workspaceId,
    fingerprint: initial.fingerprint,
    confirm(answer: string): object {
      current();
      if (confirmed || answer !== challenge)
        throw new Error("Preparation confirmation unavailable");
      confirmed = true;
      const receipt = Object.freeze({});
      receipts.add(receipt);
      return receipt;
    },
    consume(receipt: unknown) {
      if (receipt === null || typeof receipt !== "object" || !receipts.delete(receipt))
        throw new Error("Preparation confirmation unavailable");
      return current();
    },
    revalidate: current,
  });
  issuedActions.add(action);
  return action;
}

export function preparationFingerprint(inputs: PreparationInputs): string {
  return createPreparationFingerprint(inputs);
}

export function createScriptPolicyIdentity(entries: readonly string[]): string {
  if (entries.some((entry) => entry.length === 0 || entry.length > 256)) {
    throw new TypeError("Invalid script policy entry");
  }
  const canonical = JSON.stringify([...new Set(entries)].sort());
  return createHash("sha256").update(`script-policy-v1:${canonical}`).digest("hex");
}

const preparedImageInputSchema = z.strictObject({
  imageId: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u, "Prepared image ID must be an immutable image digest"),
  fingerprint: z
    .string()
    .refine((val) => val.trim().length > 0, "Prepared image metadata is incomplete"),
  architecture: z
    .string()
    .refine((val) => val.trim().length > 0, "Prepared image metadata is incomplete"),
});

function freezePreparedImage(input: unknown): PreparedImageRecord {
  const parsed = preparedImageInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new TypeError(parsed.error.issues[0]?.message ?? "Invalid prepared image metadata");
  }
  return Object.freeze({
    imageId: parsed.data.imageId,
    fingerprint: parsed.data.fingerprint,
    architecture: parsed.data.architecture,
    status: "READY" as const,
  });
}

export function validatePreparedImage(input: {
  readonly imageId: string;
  readonly fingerprint: string;
  readonly architecture: string;
}): PreparedImageRecord {
  return freezePreparedImage(input);
}

export function publishPreparedImage(input: {
  readonly imageId: string;
  readonly fingerprint: string;
  readonly architecture: string;
}): PreparedImageRecord {
  return freezePreparedImage(input);
}

export interface DeveloperPreparationBinding {
  readonly confirmedBy: "developer";
  readonly workspaceId: string;
  readonly inputFingerprint: string;
  readonly recipeHash: string;
}

const developerPreparationInputSchema = z.strictObject({
  confirmedBy: z.literal("developer", "Developer confirmation is required"),
  workspaceId: z
    .string()
    .refine((val) => val.trim().length > 0, "Current workspace identity is required"),
  inputFingerprint: z
    .string()
    .refine((val) => val.trim().length > 0, "Preparation fingerprint is required"),
  recipeHash: z
    .string()
    .refine((val) => val.trim().length > 0, "Preparation recipe binding is required"),
});

export function bindDeveloperPreparation(input: {
  readonly confirmedBy: string;
  readonly workspaceId: string;
  readonly inputFingerprint: string;
  readonly recipeHash: string;
}): DeveloperPreparationBinding {
  const parsed = developerPreparationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid developer preparation binding");
  }
  return Object.freeze({
    confirmedBy: parsed.data.confirmedBy,
    workspaceId: parsed.data.workspaceId,
    inputFingerprint: parsed.data.inputFingerprint,
    recipeHash: parsed.data.recipeHash,
  });
}
