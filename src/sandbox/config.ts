import { createHash } from "node:crypto";
import { z } from "zod";
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

const approvedRegistry = "https://registry.npmjs.org";
const limitMaximums: Record<keyof SandboxLimits, number> = {
  maxEntries: 50_000,
  maxBytes: 256 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
  timeoutSeconds: 300,
  maxPids: 256,
  cpus: 2,
  memoryBytes: 4 * 1024 * 1024 * 1024,
};
const limitsSchema = z.strictObject({
  maxEntries: z.number().int().positive().max(limitMaximums.maxEntries),
  maxBytes: z.number().int().positive().max(limitMaximums.maxBytes),
  maxFileBytes: z.number().int().positive().max(limitMaximums.maxFileBytes),
  maxOutputBytes: z.number().int().positive().max(limitMaximums.maxOutputBytes),
  timeoutSeconds: z.number().int().positive().max(limitMaximums.timeoutSeconds),
  maxPids: z.number().int().positive().max(limitMaximums.maxPids),
  cpus: z.number().int().positive().max(limitMaximums.cpus),
  memoryBytes: z.number().int().positive().max(limitMaximums.memoryBytes),
});
const profileSchema = z.strictObject({
  argv: z.array(z.string().min(1)).min(1).max(8),
});
const trustedConfigurationSchema = z.strictObject({
  limits: limitsSchema,
  engine: z.strictObject({ kind: z.literal("local") }),
  approvedRegistries: z.array(z.literal(approvedRegistry)).min(1).max(4),
  profiles: z.record(z.string().min(1).max(32), profileSchema).optional(),
});

export interface TrustedSandboxConfiguration {
  readonly limits: SandboxLimits;
  readonly engine: { readonly kind: "local" };
  readonly approvedRegistries: readonly string[];
  readonly profiles?: Readonly<Record<string, { readonly argv: readonly string[] }>>;
}

function canonical(value: PreparationInputs): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key as keyof PreparationInputs]]),
  );
}

export function createPreparationFingerprint(inputs: PreparationInputs): string {
  return createHash("sha256")
    .update(`preparation-v1:${canonical(inputs)}`)
    .digest("hex");
}

export function validateSandboxConfiguration(value: unknown): SandboxLimits {
  const parsed = limitsSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid sandbox configuration");
  return Object.freeze(parsed.data);
}

function containsShellMetacharacter(value: string): boolean {
  return /[;&|$`()<>]/u.test(value);
}

export function validateTrustedConfiguration(value: unknown): TrustedSandboxConfiguration {
  const parsed = trustedConfigurationSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid trusted sandbox configuration");
  const profiles = parsed.data.profiles;
  if (profiles !== undefined) {
    for (const profile of Object.values(profiles)) {
      if (profile.argv.some(containsShellMetacharacter)) {
        throw new TypeError("Shell metacharacters are not allowed in profile argv");
      }
      if (profile.argv[0] !== "pnpm") {
        throw new TypeError("Only approved pnpm profile commands are allowed");
      }
    }
  }
  return Object.freeze({
    ...parsed.data,
    limits: Object.freeze(parsed.data.limits),
    approvedRegistries: Object.freeze([...parsed.data.approvedRegistries]),
    ...(profiles === undefined ? {} : { profiles: Object.freeze({ ...profiles }) }),
  });
}

export function mapVerificationTarget(
  tool: string,
  profile: string,
): { readonly argv: readonly string[]; readonly check: string } {
  if (tool === "run_tests" && profile === "ordinary") return profiles.ordinary;
  if (tool === "run_linter" && profile === "lint") return profiles.lint;
  if (tool === "run_typecheck" && profile === "typecheck") return profiles.typecheck;
  if (tool === "run_build" && profile === "build") return profiles.build;
  throw new Error("Unapproved verification target");
}

/** Profile authority comes from the same fixed configuration as target mapping. */
export function approvedProfilesForTool(tool: string): readonly string[] {
  return Object.freeze(
    Object.keys(profiles).filter((profile) => {
      try {
        mapVerificationTarget(tool, profile);
        return true;
      } catch {
        return false;
      }
    }),
  );
}
