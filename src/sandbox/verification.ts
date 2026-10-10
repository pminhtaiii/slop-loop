import type {
  Freshness,
  VerificationEvidence,
  VerificationSnapshot,
  VerificationVerdict,
} from "./types.js";
import type { TaskContext } from "../orchestration/task.js";
import { z } from "zod";

const identitySchema = z.string().min(1).max(256);
const completionEvidenceSchema = z.strictObject({
  check: z.enum(["tests", "lint", "typecheck", "build"]),
  snapshotId: identitySchema,
  imageId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  status: z.enum(["PASS", "FAIL"]),
  cleanup: z.enum(["CONFIRMED", "UNCERTAIN"]),
  output: z
    .string()
    .refine((value) => Buffer.byteLength(value, "utf8") <= 1024 * 1024)
    .optional(),
  exitCode: z.number().int(),
  truncated: z.boolean(),
  terminationReason: z.enum(["EXITED", "OUTPUT_LIMIT", "TIMEOUT", "CANCELLED"]),
  nativePrelude: z.enum(["PASS", "FAIL", "NOT_REQUIRED"]),
  preparationFingerprint: identitySchema,
  profileSetId: identitySchema,
  targetId: identitySchema,
  taskId: identitySchema,
  attemptId: identitySchema,
  nativeIdentity: identitySchema,
});

export interface TrustedVerificationCompletion {
  readonly verdict: VerificationVerdict;
}
const completions = new WeakMap<
  object,
  {
    readonly task: TaskContext;
    readonly current: () => Freshness;
  }
>();
const consumedAttempts = new WeakMap<object, Set<string>>();
const acceptedFreshness = new WeakMap<object, Map<string, () => Freshness>>();

export function verificationIsCurrent(task: TaskContext): boolean {
  if (!task.capabilityCeiling || !task.verificationAttemptId) return false;
  try {
    return (
      acceptedFreshness.get(task.capabilityCeiling)?.get(task.verificationAttemptId)?.() ===
      "CURRENT"
    );
  } catch {
    return false;
  }
}

/** In-memory authority only: serialized/model results cannot manufacture a receipt. */
export function consumeVerificationCompletion(
  evidence: unknown,
  task: TaskContext,
): "PASS" | "FAIL" | undefined {
  if (typeof evidence !== "object" || evidence === null) return undefined;
  const binding = completions.get(evidence);
  if (
    !binding ||
    binding.task.capabilityCeiling !== task.capabilityCeiling ||
    binding.task.taskId !== task.taskId ||
    !task.verificationAttemptId ||
    binding.task.verificationAttemptId !== task.verificationAttemptId
  )
    return undefined;
  completions.delete(evidence);
  const ceiling = task.capabilityCeiling;
  if (!ceiling) return undefined;
  const consumed = consumedAttempts.get(ceiling) ?? new Set<string>();
  if (consumed.has(task.verificationAttemptId)) return undefined;
  consumed.add(task.verificationAttemptId);
  consumedAttempts.set(ceiling, consumed);
  try {
    if (binding.current() !== "CURRENT") return undefined;
  } catch {
    return undefined;
  }
  if ((evidence as TrustedVerificationCompletion).verdict.status === "PASS") {
    const accepted = acceptedFreshness.get(ceiling) ?? new Map<string, () => Freshness>();
    accepted.set(task.verificationAttemptId, binding.current);
    acceptedFreshness.set(ceiling, accepted);
  }
  return (evidence as TrustedVerificationCompletion).verdict.status === "PASS" ? "PASS" : "FAIL";
}

const observationKey = Symbol("verification observation constructor");

/** Immutable input facts; freshness callbacks and receipt mutation never run in reducers. */
class VerificationObservation {
  readonly #task: TaskContext;
  readonly #now: number;
  readonly #purpose: "RESULT" | "COMPLETE";
  readonly #receipt: unknown;
  readonly #status: "PASS" | "FAIL";

  constructor(
    key: symbol,
    task: TaskContext,
    now: number,
    purpose: "RESULT" | "COMPLETE",
    status: "PASS" | "FAIL",
    receipt?: unknown,
  ) {
    if (key !== observationKey) throw new Error("Untrusted verification observation");
    this.#task = task;
    this.#now = now;
    this.#purpose = purpose;
    this.#status = status;
    this.#receipt = receipt;
    Object.freeze(this);
  }

  static status(
    value: unknown,
    task: TaskContext,
    now: number,
    purpose: "RESULT" | "COMPLETE",
    receipt?: unknown,
  ): "PASS" | "FAIL" | undefined {
    if (typeof value !== "object" || value === null || !(#task in value)) return undefined;
    if (
      value.#task !== task ||
      value.#now !== now ||
      value.#purpose !== purpose ||
      value.#receipt !== receipt
    )
      return undefined;
    return value.#status;
  }
}

export type TrustedVerificationObservation = VerificationObservation;

/** Runtime ingress only: validates and consumes a receipt once before transition. */
export function observeVerificationCompletion(
  evidence: unknown,
  task: TaskContext,
  now: number,
): TrustedVerificationObservation | undefined {
  const status = consumeVerificationCompletion(evidence, task);
  return status === undefined
    ? undefined
    : new VerificationObservation(observationKey, task, now, "RESULT", status, evidence);
}

/** Runtime ingress only: takes a fresh observation for each completion proposal. */
export function observeVerificationFreshness(
  task: TaskContext,
  now: number,
): TrustedVerificationObservation | undefined {
  return verificationIsCurrent(task)
    ? new VerificationObservation(observationKey, task, now, "COMPLETE", "PASS")
    : undefined;
}

/** Pure authentication of immutable observations, bound to the exact reducer input. */
export function verificationObservationStatus(
  value: unknown,
  task: TaskContext,
  now: number,
  purpose: "RESULT" | "COMPLETE",
  receipt?: unknown,
): "PASS" | "FAIL" | undefined {
  return VerificationObservation.status(value, task, now, purpose, receipt);
}

export class VerificationCoordinator {
  private readonly evidence = new Map<string, VerificationEvidence>();
  private readonly identity?: {
    readonly preparationFingerprint: string;
    readonly profileSetId: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly nativeIdentity: string;
  };
  constructor(
    private readonly requiredChecks: readonly string[],
    private readonly sealedSnapshot?: VerificationSnapshot,
    private readonly freshnessProvider?: () => Freshness,
    identity?: {
      readonly preparationFingerprint: string;
      readonly profileSetId: string;
      readonly taskId: string;
      readonly attemptId: string;
      readonly nativeIdentity: string;
    },
  ) {
    if (requiredChecks.length === 0 || new Set(requiredChecks).size !== requiredChecks.length)
      throw new Error("Verification checks must be unique and non-empty");
    this.identity = identity;
  }
  record(evidence: VerificationEvidence): void {
    if (!this.requiredChecks.includes(evidence.check))
      throw new Error("Unexpected verification check");
    if (this.evidence.has(evidence.check)) throw new Error("Duplicate verification check");
    if (
      this.identity &&
      (evidence.preparationFingerprint !== this.identity.preparationFingerprint ||
        evidence.profileSetId !== this.identity.profileSetId ||
        evidence.taskId !== this.identity.taskId ||
        evidence.attemptId !== this.identity.attemptId ||
        evidence.nativeIdentity !== this.identity.nativeIdentity)
    )
      throw new Error("evidence identity mismatch");
    if (this.evidence.size > 0) {
      const first = this.evidence.values().next().value as VerificationEvidence;
      if (first.snapshotId !== evidence.snapshotId || first.imageId !== evidence.imageId)
        throw new Error("Mixed verification identity");
    }
    this.evidence.set(evidence.check, Object.freeze({ ...evidence }));
  }
  private aggregate(): VerificationVerdict {
    const freshness = this.freshnessProvider?.() ?? "UNCONFIRMED";
    const evidence = Object.freeze([...this.evidence.values()]);
    const sealedSnapshotId = this.sealedSnapshot?.snapshotId;
    const complete =
      evidence.length === this.requiredChecks.length &&
      sealedSnapshotId !== undefined &&
      evidence.every((item) => item.snapshotId === sealedSnapshotId);
    const passed =
      complete &&
      evidence.every(
        (item) =>
          item.status === "PASS" &&
          item.cleanup === "CONFIRMED" &&
          item.truncated === false &&
          item.exitCode === 0 &&
          item.terminationReason === "EXITED" &&
          (item.nativePrelude === "PASS" || item.nativePrelude === "NOT_REQUIRED") &&
          item.preparationFingerprint.length > 0 &&
          item.profileSetId.length > 0 &&
          item.targetId.length > 0 &&
          item.taskId.length > 0 &&
          item.attemptId.length > 0 &&
          item.nativeIdentity.length > 0,
      );
    return Object.freeze({
      status: passed ? "PASS" : complete ? "FAIL" : "INCOMPLETE",
      freshness,
      evidence,
    });
  }
  verdict(): Promise<VerificationVerdict> {
    return Promise.resolve(this.aggregate());
  }

  /** Called only by the trusted coordinator after canonical RESULT evidence commits. */
  issueCompletion(
    task: TaskContext,
    canonicalResultCommitted: (evidence: VerificationEvidence) => boolean,
  ): TrustedVerificationCompletion {
    if (
      ![...this.evidence.values()].every((item) => completionEvidenceSchema.safeParse(item).success)
    ) {
      throw new Error("Incomplete or untrusted verification completion");
    }
    const verdict = this.aggregate();
    const checks = ["tests", "lint", "typecheck", "build"];
    if (
      task.state !== "VERIFYING" ||
      !task.capabilityCeiling ||
      !task.verificationAttemptId ||
      this.sealedSnapshot?.workspaceId !== task.capabilityCeiling.workspaceId ||
      verdict.status === "INCOMPLETE" ||
      verdict.freshness !== "CURRENT" ||
      this.requiredChecks.length !== checks.length ||
      !checks.every((check) => this.requiredChecks.includes(check)) ||
      !verdict.evidence.every(
        (item) =>
          item.taskId === task.taskId &&
          item.attemptId === task.verificationAttemptId &&
          item.cleanup === "CONFIRMED" &&
          Number.isInteger(item.exitCode) &&
          typeof item.truncated === "boolean" &&
          item.terminationReason !== undefined &&
          item.nativePrelude !== undefined &&
          item.targetId ===
            (
              {
                tests: "tests:ordinary",
                lint: "lint:lint",
                typecheck: "typecheck:typecheck",
                build: "build:build",
              } as Record<string, string>
            )[item.check] &&
          item.preparationFingerprint === verdict.evidence[0]?.preparationFingerprint &&
          item.profileSetId === verdict.evidence[0]?.profileSetId &&
          item.nativeIdentity === verdict.evidence[0]?.nativeIdentity &&
          canonicalResultCommitted(item) === true,
      )
    ) {
      throw new Error("Incomplete or untrusted verification completion");
    }
    const completion = Object.freeze({ verdict });
    completions.set(completion, { task, current: this.freshnessProvider ?? (() => "UNCONFIRMED") });
    return completion;
  }
  snapshotFor(): VerificationSnapshot | undefined {
    return this.sealedSnapshot;
  }
}
