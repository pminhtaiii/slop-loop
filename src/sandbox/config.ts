import { createHash } from "node:crypto";
import type { SandboxLimits } from "./types.js";

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = Object.freeze({
  maxEntries: 50_000,
  maxBytes: 256 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
  timeoutSeconds: 300,
  maxPids: 256,
  cpus: 2,
  memoryBytes: 4 * 1024 * 1024 * 1024,
});

const profiles = Object.freeze({
  ordinary: Object.freeze({ argv: ["pnpm", "test"] as const, check: "tests" }),
  lint: Object.freeze({ argv: ["pnpm", "lint"] as const, check: "lint" }),
  typecheck: Object.freeze({ argv: ["pnpm", "typecheck"] as const, check: "typecheck" }),
  build: Object.freeze({ argv: ["pnpm", "build"] as const, check: "build" }),
});

export type VerificationProfile = keyof typeof profiles;
export type PreparationInputs = {
  readonly manifestHash: string;
  readonly lockfileHash: string;
  readonly managerConfigHash: string;
  readonly scriptPolicyId: string;
  readonly nodeVersion: string;
  readonly pnpmVersion: string;
  readonly architecture: string;
  readonly baseImageDigest: string;
  readonly recipeHash: string;
};

function canonical(value: PreparationInputs): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key as keyof PreparationInputs]]),
  );
}

export function createPreparationFingerprint(inputs: PreparationInputs): string {
  return createHash("sha256").update(`preparation-v1:${canonical(inputs)}`).digest("hex");
}

export function validateSandboxConfiguration(value: unknown): SandboxLimits {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Sandbox configuration must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set(Object.keys(DEFAULT_SANDBOX_LIMITS));
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new TypeError("Unknown sandbox field");
  const merged = { ...DEFAULT_SANDBOX_LIMITS, ...record };
  for (const [key, item] of Object.entries(merged)) {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0)
      throw new RangeError(`Invalid sandbox limit: ${key}`);
  }
  return Object.freeze(merged);
}

export function mapVerificationTarget(tool: string, profile: string): { readonly argv: readonly string[]; readonly check: string } {
  if (tool === "run_tests" && profile === "ordinary") return profiles.ordinary;
  if (tool === "run_linter" && profile === "lint") return profiles.lint;
  if (tool === "run_typecheck" && profile === "typecheck") return profiles.typecheck;
  if (tool === "run_build" && profile === "build") return profiles.build;
  throw new Error("Unapproved verification target");
}
