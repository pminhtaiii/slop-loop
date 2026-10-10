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

/** Application-owned ordinary suite; the host Docker harness is never selected inside verification. */
export const ORDINARY_TEST_PATHS = Object.freeze([
  "tests/ci.test.ts",
  "tests/config.test.ts",
  "tests/logging.test.ts",
  "tests/smoke.test.ts",
  "tests/orchestration",
  "tests/policy",
  "tests/tools",
  "tests/workspace",
  "tests/sandbox/archive.test.ts",
  "tests/sandbox/attempt.test.ts",
  "tests/sandbox/broker.test.ts",
  "tests/sandbox/cleanup.test.ts",
  "tests/sandbox/config.test.ts",
  "tests/sandbox/connectbroker.test.ts",
  "tests/sandbox/contracts.test.ts",
  "tests/sandbox/docker.test.ts",
  "tests/sandbox/dockerprocess.test.ts",
  "tests/sandbox/downloads.test.ts",
  "tests/sandbox/dependencytree.test.ts",
  "tests/sandbox/identity.test.ts",
  "tests/sandbox/lifecycle.test.ts",
  "tests/sandbox/local-docker.test.ts",
  "tests/sandbox/lockedgraph.test.ts",
  "tests/sandbox/packagecontent.test.ts",
  "tests/sandbox/preparation-action.test.ts",
  "tests/sandbox/normalization.test.ts",
  "tests/sandbox/normalizedtree.test.ts",
  "tests/sandbox/frozentransfer.test.ts",
  "tests/sandbox/preparationstorage.test.ts",
  "tests/sandbox/preparationnetwork.test.ts",
  "tests/sandbox/preparationruntime.test.ts",
  "tests/sandbox/preparationjourney.test.ts",
  "tests/sandbox/preparationcomposition.test.ts",
  "tests/sandbox/preparationworker.test.ts",
  "tests/sandbox/preparationpublication.test.ts",
  "tests/sandbox/preparationio.test.ts",
  "tests/sandbox/preparationcli.test.ts",
  "tests/sandbox/produceradapter.test.ts",
  "tests/sandbox/safeimport.test.ts",
  "tests/sandbox/preparation.test.ts",
  "tests/sandbox/profiles.test.ts",
  "tests/sandbox/reconciliation.test.ts",
  "tests/sandbox/review-regressions.test.ts",
  "tests/sandbox/snapshot.test.ts",
  "tests/sandbox/spec-regressions.test.ts",
  "tests/sandbox/verification.test.ts",
  "tests/sandbox/workspace-snapshot.test.ts",
]);

export const NODE_GYP_PRELUDE = Object.freeze(["node-gyp", "rebuild"] as const);

const PROFILES = Object.freeze({
  ordinary: Object.freeze({ argv: ["pnpm", "test"] as const, check: "tests" }),
  lint: Object.freeze({ argv: ["pnpm", "lint"] as const, check: "lint" }),
  typecheck: Object.freeze({ argv: ["pnpm", "typecheck"] as const, check: "typecheck" }),
  build: Object.freeze({ argv: ["pnpm", "build"] as const, check: "build" }),
  native: Object.freeze({
    argv: ["pnpm", "build"] as const,
    check: "build",
    nativePrelude: NODE_GYP_PRELUDE,
  }),
});

export interface VerificationTargetMapping {
  readonly argv: readonly string[];
  readonly check: string;
  readonly nativePrelude?: readonly string[];
}

export type VerificationProfile = keyof typeof PROFILES;
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

const APPROVED_REGISTRY = "https://registry.npmjs.org";
const limitsSchema = z.strictObject({
  maxEntries: z.number().int().positive().max(DEFAULT_SANDBOX_LIMITS.maxEntries),
  maxBytes: z.number().int().positive().max(DEFAULT_SANDBOX_LIMITS.maxBytes),
  maxFileBytes: z.number().int().positive().max(DEFAULT_SANDBOX_LIMITS.maxFileBytes),
  maxOutputBytes: z.number().int().positive().max(DEFAULT_SANDBOX_LIMITS.maxOutputBytes),
  timeoutSeconds: z.number().int().positive().max(DEFAULT_SANDBOX_LIMITS.timeoutSeconds),
  maxPids: z.number().int().positive().max(DEFAULT_SANDBOX_LIMITS.maxPids),
  cpus: z.number().int().positive().max(DEFAULT_SANDBOX_LIMITS.cpus),
  memoryBytes: z.number().int().positive().max(DEFAULT_SANDBOX_LIMITS.memoryBytes),
});
const profileSchema = z.strictObject({
  argv: z.array(z.string().min(1)).min(1).max(8),
});
const trustedConfigurationSchema = z.strictObject({
  limits: limitsSchema,
  engine: z.strictObject({ kind: z.literal("local") }),
  approvedRegistries: z.array(z.literal(APPROVED_REGISTRY)).min(1).max(4),
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
  const configuredProfiles = parsed.data.profiles;
  if (configuredProfiles !== undefined) {
    for (const [profileName, profile] of Object.entries(configuredProfiles)) {
      if (profile.argv.some(containsShellMetacharacter)) {
        throw new TypeError("Shell metacharacters are not allowed in profile argv");
      }
      if (profile.argv[0] !== "pnpm") {
        throw new TypeError("Only approved pnpm profile commands are allowed");
      }
      if (
        /docker|sandbox:test/i.test(profileName) ||
        profile.argv.some((arg) => /docker|sandbox:test/i.test(arg))
      ) {
        throw new TypeError("Unapproved recursive-Docker profile suites are rejected");
      }
    }
  }
  return Object.freeze({
    ...parsed.data,
    limits: Object.freeze(parsed.data.limits),
    approvedRegistries: Object.freeze([...parsed.data.approvedRegistries]),
    ...(configuredProfiles === undefined
      ? {}
      : { profiles: Object.freeze({ ...configuredProfiles }) }),
  });
}

export function mapVerificationTarget(tool: string, profile: string): VerificationTargetMapping {
  if (/docker|sandbox:test/i.test(tool) || /docker|sandbox:test/i.test(profile)) {
    throw new Error("Unapproved recursive-Docker verification suite");
  }
  if (tool === "run_tests" && profile === "ordinary") return PROFILES.ordinary;
  if (tool === "run_linter" && profile === "lint") return PROFILES.lint;
  if (tool === "run_typecheck" && profile === "typecheck") return PROFILES.typecheck;
  if (tool === "run_build" && profile === "build") return PROFILES.build;
  if (
    (tool === "run_build" || tool === "native_build") &&
    (profile === "native" || profile === "native_build")
  ) {
    return PROFILES.native;
  }
  throw new Error("Unapproved verification target");
}

export function mapNativePrelude(tool: string, profile: string): readonly string[] | undefined {
  if (
    (tool === "run_build" || tool === "native_build") &&
    (profile === "native" || profile === "native_build")
  ) {
    return NODE_GYP_PRELUDE;
  }
  return undefined;
}

/** Profile authority comes from the same fixed configuration as target mapping. */
export function approvedProfilesForTool(tool: string): readonly string[] {
  return Object.freeze(
    Object.keys(PROFILES).filter((profile) => {
      try {
        mapVerificationTarget(tool, profile);
        return true;
      } catch {
        return false;
      }
    }),
  );
}
