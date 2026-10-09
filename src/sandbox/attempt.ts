import { createHash } from "node:crypto";
import { WorkspaceBoundary } from "../workspace/boundary.js";
import { verifyWorkspace } from "../workspace/admission.js";
import type { SelectedWorkspace } from "../workspace/types.js";
import { ToolGateway } from "../tools/gateway.js";
import type { AuditSink, ToolExecutor, ToolGatewayResult } from "../tools/gateway.js";
import type { TaskRunner } from "../orchestration/runner.js";
import { captureSnapshotWithRetries, compareCurrent } from "./snapshot.js";
import { compareWorkspaceCurrent } from "./workspacesnapshot.js";
import { VerificationCoordinator } from "./verification.js";
import { SandboxGateway } from "./gateway.js";
import { DockerSandboxBackend } from "./docker.js";
import { LocalDockerPort } from "./localdocker.js";
import {
  createPreparationFingerprint,
  mapVerificationTarget,
  validateSandboxConfiguration,
  ORDINARY_TEST_PATHS,
} from "./config.js";
import type { PreparationInputs } from "./config.js";
import type {
  PreparedImageRecord,
  SandboxBackend,
  SandboxLimits,
  VerificationEvidence,
  VerificationSnapshot,
} from "./types.js";
import { truncateUtf8 } from "./dockerprocess.js";

export interface VerificationAttemptOptions {
  readonly runner: TaskRunner;
  readonly workspace: SelectedWorkspace;
  /** Trusted developer-provisioned immutable record; preparation is outside this module. */
  readonly image: PreparedImageRecord;
  readonly inputs: PreparationInputs;
  readonly audit: AuditSink;
  readonly limits: SandboxLimits;
  /** Existing SandboxBackend seam for tests/platform construction; production defaults to local Docker. */
  readonly backend?: SandboxBackend;
}
const reference = {
  run_tests: "ordinary",
  run_linter: "lint",
  run_typecheck: "typecheck",
  run_build: "build",
} as const;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** One task/attempt, one captured snapshot, four fresh audited containers. No preparation or host fallback. */
export class VerificationAttempt {
  private readonly gateway: ToolGateway;
  private readonly options: VerificationAttemptOptions;
  private readonly limits: SandboxLimits;
  private readonly taskId: string;
  private readonly attemptId: string;
  private readonly deadlineAt: number;
  private readonly profileSetId: string;
  private readonly nativeIdentity: string;
  private snapshot?: VerificationSnapshot;
  private coordinator?: VerificationCoordinator;
  private readonly committed = new Set<string>();
  private readonly checks = new Set<string>();
  private pending?: VerificationEvidence;
  private dispatching = false;
  private pendingEvidence(): VerificationEvidence | undefined {
    return this.pending;
  }
  private blocker?: "IMAGE_STALE";

  constructor(options: VerificationAttemptOptions) {
    const task = options.runner.task;
    if (
      !options.audit ||
      task.state !== "VERIFYING" ||
      !task.verificationAttemptId ||
      task.capabilityCeiling?.workspaceId !== options.workspace.workspaceId ||
      !verifyWorkspace(options.workspace)
    )
      throw new Error("Invalid verification attempt authority");
    this.options = Object.freeze({
      ...options,
      image: Object.freeze({ ...options.image }),
      inputs: Object.freeze({ ...options.inputs }),
    });
    this.limits = validateSandboxConfiguration(options.limits);
    this.taskId = task.taskId;
    this.attemptId = task.verificationAttemptId;
    this.deadlineAt =
      Date.now() + Math.max(0, task.budget!.maxActiveWorkSeconds * 1000 - task.usage.activeWorkMs);
    this.profileSetId = digest(
      JSON.stringify({
        reference,
        ordinary: ORDINARY_TEST_PATHS,
        limits: this.limits,
        native: "node-gyp-rebuild-offline-v1",
      }),
    );
    this.nativeIdentity = digest(
      `native-v1:${options.inputs.nodeVersion}:${options.inputs.recipeHash}`,
    );
    const backend =
      options.backend ?? new DockerSandboxBackend(new LocalDockerPort(this.options.inputs));
    const sandbox = new SandboxGateway(backend, this.limits);
    const executors: Record<string, ToolExecutor> = {};
    for (const [tool, profile] of Object.entries(reference)) {
      executors[tool] = {
        execute: async (_call, authority) => {
          const captureAck = authority.cleanup?.hold(`capture:${this.attemptId}:${tool}`);
          const mapping = mapVerificationTarget(tool, profile);
          try {
            if (!this.snapshot) {
              const signal = AbortSignal.any([
                authority.signal,
                AbortSignal.timeout(Math.max(1, this.deadlineAt - Date.now())),
              ]);
              this.snapshot = await captureSnapshotWithRetries(
                options.workspace,
                { ...this.limits, exclusionPolicyId: "reference-v1" },
                3,
                signal,
              );
              const manifest = this.snapshot.entries.find((entry) => entry.path === "package.json");
              const lock = this.snapshot.entries.find((entry) => entry.path === "pnpm-lock.yaml");
              const hasOtherManifests = this.snapshot.entries.some((entry) =>
                entry.path.endsWith("/package.json"),
              );
              if (
                !manifest ||
                !lock ||
                hasOtherManifests ||
                createPreparationFingerprint({
                  ...this.options.inputs,
                  manifestHash: digest(manifest.content),
                  lockfileHash: digest(lock.content),
                }) !== this.options.image.fingerprint
              ) {
                this.blocker = "IMAGE_STALE";
                return { status: "BLOCKED", reason: this.blocker };
              }
              this.coordinator = new VerificationCoordinator(
                ["tests", "lint", "typecheck", "build"],
                this.snapshot,
                () =>
                  compareWorkspaceCurrent(
                    this.snapshot!,
                    options.workspace,
                    { ...this.limits, exclusionPolicyId: "reference-v1" },
                    this.deadlineAt,
                  ),
                {
                  preparationFingerprint: this.options.image.fingerprint,
                  profileSetId: this.profileSetId,
                  taskId: this.taskId,
                  attemptId: this.attemptId,
                  nativeIdentity: this.nativeIdentity,
                },
              );
            }
          } finally {
            captureAck?.("CONFIRMED");
          }
          if (!this.coordinator || this.blocker) return { status: "BLOCKED", reason: this.blocker };
          if (
            (await compareCurrent(
              this.snapshot,
              options.workspace,
              { ...this.limits, exclusionPolicyId: "reference-v1" },
              AbortSignal.any([
                authority.signal,
                AbortSignal.timeout(Math.max(1, this.deadlineAt - Date.now())),
              ]),
            )) !== "CURRENT"
          )
            throw new Error("Verification snapshot changed");
          const evidence = await backend.executeCheck({
            snapshot: this.snapshot,
            image: this.options.image,
            target: {
              check: mapping.check,
              argv: mapping.argv,
              profileSetId: this.profileSetId,
              targetId: `${mapping.check}:${profile}`,
              taskId: this.taskId,
              attemptId: this.attemptId,
              nativeIdentity: this.nativeIdentity,
            },
            limits: this.limits,
            runtime: {
              signal: authority.signal,
              deadlineAt: Math.min(this.deadlineAt, Date.now() + this.limits.timeoutSeconds * 1000),
              cleanup: authority.cleanup,
            },
          });
          this.pending = Object.freeze({ ...evidence });
          return {
            ...evidence,
            output: truncateUtf8(Buffer.from(evidence.output ?? ""), 8000),
            retainedOutputTruncated: Buffer.byteLength(evidence.output ?? "") > 8000,
            evidenceDigest: digest(JSON.stringify(evidence)),
          };
        },
      };
    }
    this.gateway = new ToolGateway({
      workspace: new WorkspaceBoundary(),
      grants: { grantFor: () => undefined },
      audit: {
        appendIfAbsent: async (event) => {
          const evidence = this.pendingEvidence();
          const matching =
            event.kind === "RESULT" &&
            event.decision === "EXECUTED" &&
            evidence &&
            event.taskId === this.taskId &&
            event.tool in reference &&
            mapVerificationTarget(event.tool, reference[event.tool as keyof typeof reference])
              .check === evidence.check;
          const verificationEvidenceDigest = matching
            ? digest(JSON.stringify(evidence))
            : undefined;
          const canonical = verificationEvidenceDigest
            ? Object.freeze({ ...event, verificationEvidenceDigest })
            : event;
          const result = await options.audit.appendIfAbsent(canonical);
          if (
            result.status === "COMMITTED" &&
            result.eventId === canonical.eventId &&
            verificationEvidenceDigest
          )
            this.committed.add(verificationEvidenceDigest);
          return result;
        },
      },
      execution: {
        factsFor: async (call, ceiling) => {
          if (
            !verifyWorkspace(options.workspace) ||
            ceiling !== options.runner.task.capabilityCeiling
          )
            throw new Error("Verification authority unavailable");
          const profile = reference[call.name as keyof typeof reference];
          if (!profile) return undefined;
          const check = mapVerificationTarget(call.name, profile).check;
          const targeted =
            call.name === "run_tests" &&
            "target" in call.arguments &&
            call.arguments.target !== undefined;
          const facts = await sandbox.factsFor(call, ceiling, this.options.image);
          return (
            facts && {
              ...facts,
              approvedProfiles: this.checks.has(check) || targeted ? [] : [profile],
            }
          );
        },
      },
      executors,
    });
  }
  async dispatch(proposal: unknown, now: number): Promise<readonly ToolGatewayResult[]> {
    const runner = this.options.runner;
    if (
      runner.task.state !== "VERIFYING" ||
      runner.task.taskId !== this.taskId ||
      runner.task.verificationAttemptId !== this.attemptId
    )
      throw new Error("Inactive verification attempt");
    if (this.dispatching) throw new Error("Verification dispatch already active");
    this.dispatching = true;
    try {
      this.pending = undefined;
      const results = await runner.dispatchProposals(this.gateway, [proposal], now);
      if (this.blocker && runner.task.state === "VERIFYING")
        runner.process({ kind: this.blocker }, now);
      const pending = this.pendingEvidence();
      if (
        pending &&
        this.committed.has(digest(JSON.stringify(pending))) &&
        results[0]?.kind === "EXECUTED" &&
        runner.task.state === "VERIFYING"
      ) {
        this.coordinator!.record(pending);
        this.checks.add(pending.check);
        if (this.checks.size === 4) {
          const freshness = await compareCurrent(
            this.snapshot!,
            this.options.workspace,
            { ...this.limits, exclusionPolicyId: "reference-v1" },
            AbortSignal.timeout(Math.max(1, this.deadlineAt - Date.now())),
          );
          if (freshness !== "CURRENT") runner.process({ kind: "RUNTIME_UNAVAILABLE" }, now);
          else {
            const receipt = this.coordinator!.issueCompletion(runner.task, (item) =>
              this.committed.has(digest(JSON.stringify(item))),
            );
            runner.process({ kind: "VERIFICATION_RESULT", evidence: receipt }, now);
          }
        }
      }
      return results;
    } finally {
      this.dispatching = false;
    }
  }
}
