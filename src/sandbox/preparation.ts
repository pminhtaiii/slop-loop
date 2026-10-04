import { createHash } from "node:crypto";
import { createPreparationFingerprint, type PreparationInputs } from "./config.js";
import type { PreparedImageRecord } from "./types.js";

export { createPreparationFingerprint };
export type { PreparationInputs };

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

export function validatePreparedImage(input: {
  readonly imageId: string;
  readonly fingerprint: string;
  readonly architecture: string;
}): PreparedImageRecord {
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.imageId)) {
    throw new TypeError("Prepared image ID must be an immutable image digest");
  }
  if (input.fingerprint.trim().length === 0 || input.architecture.trim().length === 0) {
    throw new TypeError("Prepared image metadata is incomplete");
  }
  return Object.freeze({ ...input, status: "READY" as const });
}

export function publishPreparedImage(input: {
  readonly imageId: string;
  readonly fingerprint: string;
  readonly architecture: string;
}): PreparedImageRecord {
  return validatePreparedImage(input);
}

export interface DeveloperPreparationBinding {
  readonly confirmedBy: "developer";
  readonly workspaceId: string;
  readonly inputFingerprint: string;
  readonly recipeHash: string;
}

export function bindDeveloperPreparation(input: {
  readonly confirmedBy: string;
  readonly workspaceId: string;
  readonly inputFingerprint: string;
  readonly recipeHash: string;
}): DeveloperPreparationBinding {
  if (input.confirmedBy !== "developer") {
    throw new Error("Developer confirmation is required");
  }
  if (input.workspaceId.trim().length === 0) {
    throw new Error("Current workspace identity is required");
  }
  if (input.inputFingerprint.trim().length === 0) {
    throw new Error("Preparation fingerprint is required");
  }
  if (input.recipeHash.trim().length === 0) {
    throw new Error("Preparation recipe binding is required");
  }
  return Object.freeze({ ...input, confirmedBy: "developer" as const });
}
