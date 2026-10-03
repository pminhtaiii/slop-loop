import { createPreparationFingerprint, type PreparationInputs } from "./config.js";
import type { PreparedImageRecord } from "./types.js";

export function preparationFingerprint(inputs: PreparationInputs): string {
  return createPreparationFingerprint(inputs);
}

export function publishPreparedImage(input: {
  readonly imageId: string;
  readonly fingerprint: string;
  readonly architecture: string;
}): PreparedImageRecord {
  if (!input.imageId.startsWith("sha256:")) throw new Error("Only immutable image IDs may be published");
  return Object.freeze({ ...input, status: "READY" as const });
}
