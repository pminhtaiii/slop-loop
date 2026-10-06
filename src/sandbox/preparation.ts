import { createHash } from "node:crypto";
import { z } from "zod";
import { createPreparationFingerprint, type PreparationInputs } from "./config.js";
import type { PreparedImageRecord } from "./types.js";

export { createPreparationFingerprint };
export type { PreparationInputs, PreparedImageRecord };

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
